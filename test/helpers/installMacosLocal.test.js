const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../..");
const installerSource = path.join(repoRoot, "scripts/install-macos-local.sh");

function makeBundle(bundlePath, marker) {
  fs.mkdirSync(path.join(bundlePath, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(
    path.join(bundlePath, "Contents", "Info.plist"),
    "<plist><dict><key>CFBundleIdentifier</key><string>com.kylecooper.openwhispr.local</string></dict></plist>"
  );
  fs.writeFileSync(path.join(bundlePath, "Contents", "MacOS", "OpenWhispr"), marker);
}

function makeMockCommands(root) {
  fs.mkdirSync(root, { recursive: true });
  const mockPath = path.join(root, "mock-command");
  fs.writeFileSync(
    mockPath,
    `#!/bin/zsh
set -eu
name="\${0:t}"
case "$name" in
  PlistBuddy) print "com.kylecooper.openwhispr.local" ;;
  codesign)
    if [[ "\${MOCK_BAD_INSTALLED:-0}" == 1 && "$*" == *"$MOCK_INSTALLED_APP"* ]]; then exit 1; fi
    if [[ "$*" == *"-dv"* ]]; then print -u2 "Authority=OpenWhispr Local Code Signing"; fi ;;
  mktemp) /usr/bin/mktemp -d "$MOCK_TMP_ROOT/install.XXXXXX" ;;
  pgrep)
    if [[ "\${MOCK_MODE:-}" == shutdown-failure ]]; then print 999; exit 0; fi
    [[ -f "$MOCK_STATE/launched" ]] && { print 999; exit 0; }
    exit 1 ;;
  kill) [[ "\${MOCK_MODE:-}" == shutdown-failure ]] && exit 0; exit 1 ;;
  sleep) : ;;
  ditto)
    if [[ "\${MOCK_MODE:-}" == copy-failure ]]; then /bin/mkdir -p "$2"; exit 1; fi
    /bin/cp -R "$1" "$2" ;;
  open)
    if [[ "\${MOCK_MODE:-}" != launch-failure ]]; then /usr/bin/touch "$MOCK_STATE/launched"; fi ;;
  *) /bin/"$name" "$@" ;;
esac
`
  );
  fs.chmodSync(mockPath, 0o755);
  const commands = ["PlistBuddy", "codesign", "mktemp", "pgrep", "kill", "sleep", "ditto", "open", "mv", "mkdir", "rm", "date"];
  for (const command of commands) {
    fs.symlinkSync(mockPath, path.join(root, command));
  }
  return Object.fromEntries(commands.map((command) => [command, path.join(root, command)]));
}

function transformedInstaller(root, commands) {
  let source = fs.readFileSync(installerSource, "utf8");
  const replacements = {
    "/usr/libexec/PlistBuddy": commands.PlistBuddy,
    "/usr/bin/codesign": commands.codesign,
    "/usr/bin/mktemp": commands.mktemp,
    "/usr/bin/pgrep": commands.pgrep,
    "/bin/kill": commands.kill,
    "/bin/sleep": commands.sleep,
    "/usr/bin/ditto": commands.ditto,
    "/usr/bin/open": commands.open,
    "/bin/mv": commands.mv,
    "/bin/mkdir": commands.mkdir,
    "/bin/rm": commands.rm,
    "/bin/date": commands.date,
    "/private/tmp/openwhispr-local-install.XXXXXX": `${root}/install.XXXXXX`,
    "/Applications/OpenWhispr Local.app": `${root}/Applications/OpenWhispr Local.app`,
  };
  for (const [from, to] of Object.entries(replacements)) source = source.split(from).join(to);
  source = source.replaceAll("{1..50}", "{1..2}").replaceAll("{1..100}", "{1..2}");
  const script = path.join(root, "install-under-test.zsh");
  fs.writeFileSync(script, source);
  fs.chmodSync(script, 0o755);
  return script;
}

function runInstall(mode = "", extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-installer-test-"));
  try {
    const app = path.join(root, "Applications", "OpenWhispr Local.app");
    const build = path.join(root, "build", "OpenWhispr.app");
    const state = path.join(root, "state");
    const failed = path.join(root, "failed");
    fs.mkdirSync(state, { recursive: true });
    makeBundle(app, "original");
    makeBundle(build, "candidate");
    const commands = makeMockCommands(path.join(root, "commands"));
    const script = transformedInstaller(root, commands);
    let result;
    try {
      execFileSync("/bin/zsh", [script], {
        env: {
          ...process.env,
          OPENWHISPR_LOCAL_BUILD_PATH: build,
          OPENWHISPR_LOCAL_FAILED_DIR: failed,
          MOCK_INSTALLED_APP: app,
          MOCK_MODE: mode,
          MOCK_STATE: state,
          MOCK_TMP_ROOT: root,
          ...extraEnv,
        },
        stdio: "pipe",
      });
      result = { ok: true };
    } catch (error) {
      result = { ok: false, stderr: error.stderr?.toString() || "" };
    }
    return { root, app, build, failed, result };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function marker(app) {
  return fs.readFileSync(path.join(app, "Contents", "MacOS", "OpenWhispr"), "utf8");
}

test("installer leaves the original app in place when shutdown fails before swap", () => {
  const fixture = runInstall("shutdown-failure");
  try {
    assert.equal(fixture.result.ok, false);
    assert.equal(marker(fixture.app), "original", fixture.result.stderr);
    assert.equal(fs.existsSync(fixture.failed), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("installer restores original and preserves a partial candidate after copy failure", () => {
  const fixture = runInstall("copy-failure");
  try {
    assert.equal(fixture.result.ok, false);
    assert.equal(marker(fixture.app), "original", fixture.result.stderr);
    assert.equal(fs.readdirSync(fixture.failed).length, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("installer restores original and preserves an invalid copied candidate", () => {
  const fixture = runInstall("", { MOCK_BAD_INSTALLED: "1" });
  try {
    assert.equal(fixture.result.ok, false);
    assert.equal(marker(fixture.app), "original", fixture.result.stderr);
    assert.equal(fs.readdirSync(fixture.failed).length, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("installer restores original and preserves candidate when launch confirmation fails", () => {
  const fixture = runInstall("launch-failure");
  try {
    assert.equal(fixture.result.ok, false);
    assert.equal(marker(fixture.app), "original", fixture.result.stderr);
    assert.equal(fs.readdirSync(fixture.failed).length, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("installer keeps the validated candidate only after launch confirmation", () => {
  const fixture = runInstall("", { OPENWHISPR_LOCAL_REMOVE_BUILD_ON_SUCCESS: "1" });
  try {
    assert.equal(fixture.result.ok, true);
    assert.equal(marker(fixture.app), "candidate");
    assert.equal(fs.existsSync(fixture.failed), false);
    assert.equal(fs.existsSync(fixture.build), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
