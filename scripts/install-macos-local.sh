#!/bin/zsh
set -euo pipefail

readonly installed_app="${OPENWHISPR_LOCAL_INSTALL_PATH:-/Applications/OpenWhispr Local.app}"
readonly built_app="${OPENWHISPR_LOCAL_BUILD_PATH:-$HOME/Library/Caches/OpenWhispr Local/build/mac-arm64/OpenWhispr.app}"
readonly expected_bundle_id="com.kylecooper.openwhispr.local"
readonly expected_root_certificate_hash="fe9441e0b69e6b0721bed7673c841583b8bfcb8f"
readonly failed_root="${OPENWHISPR_LOCAL_FAILED_DIR:-$HOME/Library/Caches/OpenWhispr Local/failed}"

validate_bundle() {
  local app_path="$1"
  local label="$2"
  local bundle_id
  local requirement

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
  if ! requirement=$(/usr/bin/codesign -d -r- "$app_path" 2>&1); then
    print -u2 "Could not inspect $label bundle requirement."
    return 1
  fi
  requirement=${requirement:l}
  if [[ "$requirement" != *"identifier \"$expected_bundle_id\""* || "$requirement" != *"certificate root = h\"$expected_root_certificate_hash\""* ]]; then
    print -u2 "Refusing $label bundle with an unexpected signing requirement."
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
readonly previous_app="$install_tmp/OpenWhispr Local.previous.bundle"
previous_moved=false
candidate_installed=false
launch_succeeded=false
failed_candidate=""
recovery_previous=""

preserve_failed_candidate() {
  [[ -d "$installed_app" ]] || return 0
  if [[ -z "$failed_candidate" ]]; then
    failed_candidate="$failed_root/OpenWhispr Local.failed.$(/bin/date +%Y%m%d-%H%M%S).$$.bundle"
  fi
  if ! /bin/mkdir -p "$failed_root"; then
    return 1
  fi
  if ! /bin/mv "$installed_app" "$failed_candidate"; then
    return 1
  fi
  print -u2 "Failed candidate preserved at: $failed_candidate"
}

preserve_previous_recovery() {
  [[ -d "$previous_app" ]] || return 0
  if [[ -z "$recovery_previous" ]]; then
    recovery_previous="$failed_root/recovery/OpenWhispr Local.previous.$(/bin/date +%Y%m%d-%H%M%S).$$.bundle"
  fi
  if ! /bin/mkdir -p "${recovery_previous:h}"; then
    return 1
  fi
  if ! /bin/mv "$previous_app" "$recovery_previous"; then
    return 1
  fi
  print -u2 "Previous app preserved for recovery at: $recovery_previous"
}

rollback() {
  local exit_status=$?
  local rollback_complete=true
  if [[ "$launch_succeeded" != true && "$previous_moved" == true ]]; then
    if [[ "$candidate_installed" == true && -d "$installed_app" ]]; then
      if ! preserve_failed_candidate; then
        print -u2 "Could not preserve failed candidate: $installed_app"
        rollback_complete=false
      fi
    fi
    if [[ -d "$previous_app" && ! -d "$installed_app" ]]; then
      if /bin/mv "$previous_app" "$installed_app"; then
        /usr/bin/open "$installed_app" || true
      else
        print -u2 "Could not restore previous app: $previous_app"
        rollback_complete=false
      fi
    elif [[ -d "$previous_app" ]]; then
      rollback_complete=false
    fi
  fi
  if [[ "$launch_succeeded" == true || "$rollback_complete" == true ]]; then
    /bin/rm -rf "$install_tmp"
  elif preserve_previous_recovery; then
    /bin/rm -rf "$install_tmp"
  else
    print -u2 "Rollback incomplete; durable recovery failed, preserved previous app at: $previous_app"
  fi
  return "$exit_status"
}
trap rollback EXIT

existing_pids=$(/usr/bin/pgrep -f "^${installed_app}/Contents/MacOS/OpenWhispr(\$| )" || true)
if [[ -n "$existing_pids" ]]; then
  for existing_pid in ${(f)existing_pids}; do
    /bin/kill -TERM "$existing_pid" || true
  done
  remaining_pids="$existing_pids"
  for _ in {1..50}; do
    remaining_pids=$(/usr/bin/pgrep -f "^${installed_app}/Contents/MacOS/OpenWhispr(\$| )" || true)
    [[ -z "$remaining_pids" ]] && break
    /bin/sleep 0.1
  done
  if [[ -n "$remaining_pids" ]]; then
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
  if /usr/bin/pgrep -f "^${installed_app}/Contents/MacOS/OpenWhispr(\$| )" >/dev/null; then
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
