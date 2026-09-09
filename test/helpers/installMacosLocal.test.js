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
    if [[ "$*" == *"-r-"* ]]; then
      if [[ "\${MOCK_BAD_REQUIREMENT:-0}" == 1 ]]; then
        print -u2 'designated => identifier "com.kylecooper.openwhispr.local" and certificate root = H"0000000000000000000000000000000000000000"'
      else
        print -u2 'designated => identifier "com.kylecooper.openwhispr.local" and certificate root = H"fe9441e0b69e6b0721bed7673c841583b8bfcb8f"'
      fi
    fi ;;
  mktemp) /usr/bin/mktemp -d "$MOCK_TMP_ROOT/install.XXXXXX" ;;
  pgrep)
    if [[ "\${MOCK_MODE:-}" == shutdown-failure ]]; then print 999; exit 0; fi
    if [[ "\${MOCK_MODE:-}" == multiple-old-pids && -f "$MOCK_STATE/old-pids" ]]; then /bin/cat "$MOCK_STATE/old-pids"; exit 0; fi
    [[ -f "$MOCK_STATE/launched" ]] && { print 999; exit 0; }
    exit 1 ;;
  kill)
    print -r -- "$*" >> "$MOCK_STATE/kill-log"
    if [[ "\${MOCK_MODE:-}" == shutdown-failure ]]; then exit 0; fi
    if [[ "\${MOCK_MODE:-}" == multiple-old-pids && "$1" == -TERM ]]; then /bin/rm -f "$MOCK_STATE/old-pids"; fi
    exit 1 ;;
  sleep) : ;;
  ditto)
    if [[ "\${MOCK_MODE:-}" == copy-failure ]]; then /bin/mkdir -p "$2"; exit 1; fi
    /bin/cp -R "$1" "$2" ;;
  open)
    if [[ "\${MOCK_MODE:-}" != launch-failure ]]; then /usr/bin/touch "$MOCK_STATE/launched"; fi ;;
  mv)
    if [[ "\${MOCK_PRESERVE_MOVE_FAILURE:-0}" == 1 && "$2" == *"/failed/"* ]]; then exit 1; fi
    if [[ "\${MOCK_RESTORE_MOVE_FAILURE:-0}" == 1 && "$1" == *".previous.bundle" ]]; then exit 1; fi
    /bin/mv "$@" ;;
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
    if (mode === "multiple-old-pids") fs.writeFileSync(path.join(state, "old-pids"), "101\n102\n");
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

function preservedPrevious(root) {
  const installDir = fs.readdirSync(root).find((entry) => entry.startsWith("install."));
  return installDir && path.join(root, installDir, "OpenWhispr Local.previous.bundle");
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

test("installer rejects a candidate without the pinned signing root before swap", () => {
  const fixture = runInstall("", { MOCK_BAD_REQUIREMENT: "1" });
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

test("installer retains the previous bundle when failed-candidate preservation fails", () => {
  const fixture = runInstall("launch-failure", { MOCK_PRESERVE_MOVE_FAILURE: "1" });
  try {
    assert.equal(fixture.result.ok, false);
    assert.equal(marker(fixture.app), "candidate", fixture.result.stderr);
    assert.equal(marker(preservedPrevious(fixture.root)), "original");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("installer retains the previous bundle when restoration move fails", () => {
  const fixture = runInstall("launch-failure", { MOCK_RESTORE_MOVE_FAILURE: "1" });
  try {
    assert.equal(fixture.result.ok, false);
    assert.equal(fs.existsSync(fixture.app), false);
    assert.equal(marker(preservedPrevious(fixture.root)), "original");
    assert.equal(fs.readdirSync(fixture.failed).length, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("installer terminates every old PID before accepting a new launch", () => {
  const fixture = runInstall("multiple-old-pids");
  try {
    assert.equal(fixture.result.ok, true, fixture.result.stderr);
    const killed = fs.readFileSync(path.join(fixture.root, "state", "kill-log"), "utf8");
    assert.match(killed, /-TERM 101/);
    assert.match(killed, /-TERM 102/);
    assert.equal(marker(fixture.app), "candidate");
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
