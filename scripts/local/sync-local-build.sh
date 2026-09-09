#!/bin/zsh
# Keep Kyle's customized OpenWhispr build current with upstream.
#
# Rebases the local-build branch onto the newest upstream release, runs the
# checks, and only then rebuilds and installs /Applications/OpenWhispr Local.app.
# If anything fails the installed app is left exactly as it was, so a bad
# upstream release can never take the working app away.

set -euo pipefail

REPO="${OPENWHISPR_REPO:-$HOME/Claude/Projects/openwhispr}"
WORKTREE="${OPENWHISPR_SYNC_WORKTREE:-$HOME/Claude/Projects/openwhispr--autosync}"
BRANCH="${OPENWHISPR_LOCAL_BRANCH:-local-build}"
APP="/Applications/OpenWhispr Local.app"
BUILD_OUT="$HOME/Library/Caches/OpenWhispr Local/build/mac-arm64/OpenWhispr.app"
LOG_DIR="$HOME/Library/Logs/OpenWhispr Local"
LOG="$LOG_DIR/sync.log"

mkdir -p "$LOG_DIR"
exec >>"$LOG" 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') sync start ==="

notify() { /usr/bin/osascript -e "display notification \"$2\" with title \"OpenWhispr Local\" subtitle \"$1\"" >/dev/null 2>&1 || true; }
fail()   { echo "FAILED: $1"; notify "Update skipped" "$1 — your current app is untouched."; exit 1; }

cd "$REPO"
original_local_sha=$(git rev-parse "$BRANCH") || fail "could not resolve $BRANCH"
git fetch origin --prune --quiet || fail "could not reach upstream"

behind=$(git rev-list --count "$BRANCH..origin/main" 2>/dev/null || echo 0)
if [[ "$behind" == "0" ]]; then
  echo "already current with upstream; nothing to do"
  exit 0
fi
echo "upstream is $behind commits ahead; rebasing $BRANCH"

# Fresh scratch worktree every run, so a half-finished rebase never lingers.
git worktree remove --force "$WORKTREE" 2>/dev/null || true
git worktree add --detach "$WORKTREE" "$BRANCH" --quiet || fail "could not create the build worktree"
trap 'cd "$REPO"; git worktree remove --force "$WORKTREE" 2>/dev/null || true' EXIT

cd "$WORKTREE"
if ! git rebase origin/main; then
  git rebase --abort || true
  fail "your changes conflict with upstream and need a human"
fi
rebased=$(git rev-parse HEAD)

# Give the worktree its own resources/bin. A symlink here is not equivalent:
# the Swift module cache lives inside this directory, and reaching it by two
# paths makes swiftc report Darwin as defined twice and crash. The copy is an
# APFS clone, so it costs no space and returns immediately.
rm -rf resources/bin
cp -Rc "$REPO/resources/bin" resources/bin 2>/dev/null || /usr/bin/ditto "$REPO/resources/bin" resources/bin
rm -rf resources/bin/.swift-module-cache
if command -v bun >/dev/null; then bun install --silent || fail "dependency install failed"
else npm ci --silent || fail "dependency install failed"; fi

# Fetch any binary dependency upstream newly requires. These steps skip
# whatever is already downloaded, so after the first run they are cheap.
npm run prebuild:mac:arm64 || fail "could not fetch the binaries the new upstream needs"

npm run typecheck  || fail "typecheck failed against the new upstream"
npm test           || fail "tests failed against the new upstream"
npm run build:mac:local || fail "the build did not produce an app"
[[ -d "$BUILD_OUT" ]] || fail "the build output is missing"

# Keep whatever binaries this upstream newly required, so the next run does not
# download them again. Never overwrite what the repository already has.
/usr/bin/rsync -a --ignore-existing --exclude ".swift-module-cache" \
  resources/bin/ "$REPO/resources/bin/" 2>/dev/null || true

# Rehearsal mode: everything that can realistically break has now run, so stop
# here rather than swapping the app the user is currently dictating into.
if [[ "${OPENWHISPR_SYNC_DRY_INSTALL:-0}" == "1" ]]; then
  # Leaving the build behind would put a second bundle with the installed app's
  # id back on disk, which is the trap this whole script exists to avoid.
  rm -rf "$BUILD_OUT"
  echo "dry install: rebase, checks, and build all passed; installed app untouched"
  exit 0
fi

# Everything is green — the installer owns the validated swap, rollback, and
# launch confirmation. Passing the build explicitly keeps scheduled installs
# on this worktree's artifact without duplicating a second unsafe swap path.
OPENWHISPR_LOCAL_BUILD_PATH="$BUILD_OUT" \
  OPENWHISPR_LOCAL_INSTALL_PATH="$APP" \
  OPENWHISPR_LOCAL_REMOVE_BUILD_ON_SUCCESS=1 \
  "$WORKTREE/scripts/install-macos-local.sh" || fail "install failed; previous app restored"

cd "$REPO"
if git update-ref "refs/heads/$BRANCH" "$rebased" "$original_local_sha"; then
  git push fork "$BRANCH" --quiet 2>/dev/null || echo "note: could not push $BRANCH to the fork"
else
  echo "note: $BRANCH changed during sync; left its newer local history untouched"
fi

# Keep the scheduled copy of this script in step with the repository copy.
installed="$HOME/Library/Application Support/OpenWhispr Local/sync-local-build.sh"
if [[ -f "$WORKTREE/scripts/local/sync-local-build.sh" ]]; then
  /bin/cp "$WORKTREE/scripts/local/sync-local-build.sh" "$installed" 2>/dev/null || true
  chmod +x "$installed" 2>/dev/null || true
fi

version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist" 2>/dev/null || echo "?")
echo "installed $version and relaunched"
notify "Updated to $version" "Upstream changes merged, your customizations kept."
