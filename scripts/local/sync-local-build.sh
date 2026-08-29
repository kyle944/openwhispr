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

ln -sfn "$REPO/resources/bin" resources/bin
if command -v bun >/dev/null; then bun install --silent || fail "dependency install failed"
else npm ci --silent || fail "dependency install failed"; fi

# Fetch any binary dependency upstream newly requires. These steps skip
# whatever is already downloaded, so after the first run they are cheap.
npm run prebuild:mac:arm64 || fail "could not fetch the binaries the new upstream needs"

npm run typecheck  || fail "typecheck failed against the new upstream"
npm test           || fail "tests failed against the new upstream"
npm run build:mac:local || fail "the build did not produce an app"
[[ -d "$BUILD_OUT" ]] || fail "the build output is missing"

# Everything is green — swap the installed app.
/usr/bin/pkill -f "^$APP/Contents/MacOS/OpenWhispr" 2>/dev/null || true
sleep 2
rm -rf "$APP.previous"
[[ -d "$APP" ]] && mv "$APP" "$APP.previous"
/usr/bin/ditto "$BUILD_OUT" "$APP" || { [[ -d "$APP.previous" ]] && mv "$APP.previous" "$APP"; fail "install failed; rolled back"; }

cd "$REPO"
git branch -f "$BRANCH" "$rebased"
git push --force-with-lease fork "$BRANCH" --quiet 2>/dev/null || echo "note: could not push $BRANCH to the fork"

# Keep the scheduled copy of this script in step with the repository copy.
installed="$HOME/Library/Application Support/OpenWhispr Local/sync-local-build.sh"
if [[ -f "$WORKTREE/scripts/local/sync-local-build.sh" ]]; then
  /bin/cp "$WORKTREE/scripts/local/sync-local-build.sh" "$installed" 2>/dev/null || true
  chmod +x "$installed" 2>/dev/null || true
fi

/usr/bin/open "$APP"
version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist" 2>/dev/null || echo "?")
echo "installed $version and relaunched"
notify "Updated to $version" "Upstream changes merged, your customizations kept."
