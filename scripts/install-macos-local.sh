#!/bin/zsh
set -euo pipefail

readonly installed_app="${OPENWHISPR_LOCAL_INSTALL_PATH:-/Applications/OpenWhispr Local.app}"
readonly built_app="${OPENWHISPR_LOCAL_BUILD_PATH:-$HOME/Library/Caches/OpenWhispr Local/build/mac-arm64/OpenWhispr.app}"
readonly expected_bundle_id="com.kylecooper.openwhispr.local"
readonly expected_signer="OpenWhispr Local Code Signing"
readonly failed_root="${OPENWHISPR_LOCAL_FAILED_DIR:-$HOME/Library/Caches/OpenWhispr Local/failed}"

validate_bundle() {
  local app_path="$1"
  local label="$2"
  local bundle_id
  local signature

  if [[ ! -d "$app_path" ]]; then
    print -u2 "$label bundle not found: $app_path"
    return 1
  fi
  if ! bundle_id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$app_path/Contents/Info.plist"); then
    print -u2 "Could not read $label bundle ID."
    return 1
  fi
  if [[ "$bundle_id" != "$expected_bundle_id" ]]; then
    print -u2 "Refusing $label bundle with unexpected ID: $bundle_id"
    return 1
  fi
  if ! signature=$(/usr/bin/codesign -dv --verbose=4 "$app_path" 2>&1); then
    print -u2 "Could not inspect $label bundle signature."
    return 1
  fi
  if [[ "$signature" != *"Authority=$expected_signer"* ]]; then
    print -u2 "Refusing $label bundle not signed by $expected_signer"
    return 1
  fi
  if ! /usr/bin/codesign --verify --deep --strict "$app_path"; then
    print -u2 "$label bundle signature verification failed."
    return 1
  fi
}

validate_bundle "$built_app" "build"

install_tmp=$(/usr/bin/mktemp -d /private/tmp/openwhispr-local-install.XXXXXX)
readonly install_tmp
readonly previous_app="$install_tmp/OpenWhispr Local.previous.app"
previous_moved=false
candidate_installed=false
launch_succeeded=false
failed_candidate=""

preserve_failed_candidate() {
  [[ -d "$installed_app" ]] || return 0
  if [[ -z "$failed_candidate" ]]; then
    failed_candidate="$failed_root/OpenWhispr Local.failed.$(/bin/date +%Y%m%d-%H%M%S).$$.app"
  fi
  /bin/mkdir -p "$failed_root"
  /bin/mv "$installed_app" "$failed_candidate"
  print -u2 "Failed candidate preserved at: $failed_candidate"
}

rollback() {
  local exit_status=$?
  if [[ "$launch_succeeded" != true && "$previous_moved" == true ]]; then
    if [[ "$candidate_installed" == true && -d "$installed_app" ]]; then
      preserve_failed_candidate || print -u2 "Could not preserve failed candidate: $installed_app"
    fi
    if [[ -d "$previous_app" && ! -d "$installed_app" ]]; then
      /bin/mv "$previous_app" "$installed_app"
      /usr/bin/open "$installed_app" || true
    fi
  fi
  /bin/rm -rf "$install_tmp"
  return "$exit_status"
}
trap rollback EXIT

existing_pid=$(/usr/bin/pgrep -f '^/Applications/OpenWhispr Local\.app/Contents/MacOS/OpenWhispr($| )' | /usr/bin/head -1 || true)
if [[ -n "$existing_pid" ]]; then
  /bin/kill -TERM "$existing_pid"
  for _ in {1..50}; do
    /bin/kill -0 "$existing_pid" 2>/dev/null || break
    /bin/sleep 0.1
  done
  if /bin/kill -0 "$existing_pid" 2>/dev/null; then
    print -u2 "OpenWhispr Local did not quit cleanly; installation cancelled."
    exit 1
  fi
fi

if [[ -d "$installed_app" ]]; then
  /bin/mv "$installed_app" "$previous_app"
  previous_moved=true
fi
candidate_installed=true
/usr/bin/ditto "$built_app" "$installed_app"
if ! validate_bundle "$installed_app" "installed"; then
  exit 1
fi

/usr/bin/open "$installed_app"
for _ in {1..100}; do
  if /usr/bin/pgrep -f '^/Applications/OpenWhispr Local\.app/Contents/MacOS/OpenWhispr($| )' >/dev/null; then
    launch_succeeded=true
    break
  fi
  /bin/sleep 0.1
done

if [[ "$launch_succeeded" != true ]]; then
  print -u2 "Installed app did not launch; restoring the previous version."
  exit 1
fi

if [[ "${OPENWHISPR_LOCAL_REMOVE_BUILD_ON_SUCCESS:-0}" == "1" ]]; then
  /bin/rm -rf "$built_app"
fi

print "INSTALLED $expected_bundle_id"
