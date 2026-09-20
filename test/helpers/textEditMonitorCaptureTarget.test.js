const test = require("node:test");
const assert = require("node:assert/strict");

const TextEditMonitor = require("../../src/helpers/textEditMonitor");

const darwinOnly = { skip: process.platform !== "darwin" };

function app(pid, bundleId = "com.apple.TextEdit", appName = "TextEdit") {
  return { pid, bundleId, appName };
}

function stubFrontmostApp(monitor, target) {
  let invocations = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = () => resolve(target);
  });
  monitor._readFrontmostApp = () => {
    invocations += 1;
    return gate;
  };
  return { release, count: () => invocations };
}

test("concurrent captures share one frontmost lookup", darwinOnly, async () => {
  const m = new TextEditMonitor();
  const lookup = stubFrontmostApp(m, app(4242));

  const first = m.captureTargetApp();
  const second = m.captureTargetPid();
  lookup.release();

  assert.deepEqual(await Promise.all([first, second]), [app(4242), 4242]);
  assert.equal(lookup.count(), 1);
  assert.equal(m.lastTargetPid, 4242);
  assert.deepEqual(m.lastTargetApp, app(4242));
});

test("a just-completed capture is reused instead of respawning osascript", darwinOnly, async () => {
  const m = new TextEditMonitor();
  const lookup = stubFrontmostApp(m, app(4242));

  const first = m.captureTargetPid();
  lookup.release();
  await first;

  assert.equal(await m.captureTargetPid(), 4242);
  assert.equal(lookup.count(), 1);
});

test("a failed capture is retried, not reused", darwinOnly, async () => {
  const m = new TextEditMonitor();
  let invocations = 0;
  m._readFrontmostApp = () => {
    invocations += 1;
    return Promise.resolve(invocations === 1 ? null : app(4242));
  };

  assert.equal(await m.captureTargetPid(), null);
  assert.equal(await m.captureTargetPid(), 4242);
  assert.equal(invocations, 2);
});

test("captures refresh once the reuse window has passed", darwinOnly, async () => {
  const m = new TextEditMonitor();
  let invocations = 0;
  m._readFrontmostApp = () => {
    invocations += 1;
    return Promise.resolve(invocations === 1 ? app(1111) : app(2222, "com.apple.Mail", "Mail"));
  };

  assert.equal(await m.captureTargetPid(), 1111);
  m._lastCaptureAt = Date.now() - 10_000;
  assert.equal(await m.captureTargetPid(), 2222);
  assert.equal(m.lastTargetPid, 2222);
  assert.deepEqual(m.lastTargetApp, app(2222, "com.apple.Mail", "Mail"));
});

test("the OpenWhispr process is never captured as its own paste target", darwinOnly, async () => {
  const m = new TextEditMonitor();
  m._readFrontmostApp = () => Promise.resolve(app(process.pid, "com.openwhispr.app", "OpenWhispr"));

  assert.equal(await m.captureTargetPid(), null);
  assert.equal(m.lastTargetPid, null);
  assert.equal(m.lastTargetApp, null);
});

test("capture exposes app identity without window or field content", darwinOnly, async () => {
  const m = new TextEditMonitor();
  m._readFrontmostApp = () => Promise.resolve(app(4242));

  assert.deepEqual(await m.captureTargetApp(), app(4242));
  assert.deepEqual(Object.keys(m.lastTargetApp).sort(), ["appName", "bundleId", "pid"]);
});
