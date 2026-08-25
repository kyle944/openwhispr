#!/bin/zsh
set -euo pipefail

readonly installed_app="/Applications/OpenWhispr Local.app"
readonly built_app="$HOME/Library/Caches/OpenWhispr Local/build/mac-arm64/OpenWhispr.app"
readonly expected_bundle_id="com.kylecooper.openwhispr.local"
readonly expected_signer="OpenWhispr Local Code Signing"

if [[ ! -d "$built_app" ]]; then
  print -u2 "Local build not found: $built_app"
  print -u2 "Run npm run build:mac:local first."
  exit 1
fi

bundle_id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$built_app/Contents/Info.plist")
if [[ "$bundle_id" != "$expected_bundle_id" ]]; then
  print -u2 "Refusing to install unexpected bundle ID: $bundle_id"
  exit 1
fi

signature=$(/usr/bin/codesign -dv --verbose=4 "$built_app" 2>&1)
if [[ "$signature" != *"Authority=$expected_signer"* ]]; then
  print -u2 "Refusing to install a build not signed by $expected_signer"
  exit 1
fi
/usr/bin/codesign --verify --deep --strict "$built_app"

install_tmp=$(/usr/bin/mktemp -d /private/tmp/openwhispr-local-install.XXXXXX)
readonly install_tmp
readonly previous_app="$install_tmp/OpenWhispr Local.previous.app"
readonly failed_app="$install_tmp/OpenWhispr Local.failed.app"
installed=false

rollback() {
  if [[ "$installed" != true ]]; then
    [[ -d "$installed_app" ]] && /bin/mv "$installed_app" "$failed_app"
    if [[ -d "$previous_app" ]]; then
      /bin/mv "$previous_app" "$installed_app"
      /usr/bin/open "$installed_app" || true
    fi
  fi
  /bin/rm -rf "$install_tmp"
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
fi
/usr/bin/ditto "$built_app" "$installed_app"
/usr/bin/codesign --verify --deep --strict "$installed_app"

installed_bundle_id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$installed_app/Contents/Info.plist")
if [[ "$installed_bundle_id" != "$expected_bundle_id" ]]; then
  print -u2 "Installed bundle ID verification failed."
  exit 1
fi

/usr/bin/open "$installed_app"
for _ in {1..100}; do
  if /usr/bin/pgrep -f '^/Applications/OpenWhispr Local\.app/Contents/MacOS/OpenWhispr($| )' >/dev/null; then
    installed=true
    break
  fi
  /bin/sleep 0.1
done

if [[ "$installed" != true ]]; then
  print -u2 "Installed app did not launch; restoring the previous version."
  exit 1
fi

print "INSTALLED $installed_bundle_id"
