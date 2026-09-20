const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const os = require("node:os");
const path = require("node:path");

const modelRegistryData = require("../../src/models/modelRegistryData.json");
const { bindInferenceLeaseOwner } = require("../../src/helpers/inferenceLeaseOwner");
const modelManagerModulePath = require.resolve("../../src/helpers/modelManagerBridge.js");
const originalLoad = Module._load;

function loadModelManager() {
  delete require.cache[modelManagerModulePath];
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          isReady: () => true,
          getAppPath: () => process.cwd(),
          getPath: () => os.tmpdir(),
        },
        net: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../../src/helpers/modelManagerBridge.js").default;
  } finally {
    Module._load = originalLoad;
  }
}

function setupModelManager(t) {
  const modelManager = loadModelManager();
  const models = modelRegistryData.localProviders.flatMap((provider) => provider.models);
  const [firstModel, secondModel] = models;
  const events = [];
  let nextPid = 100;

  modelManager.ensureInitialized();
  modelManager.checkModelValid = async () => true;
  modelManager.serverStartOptions = async () => ({});
  modelManager.serverManager.isAvailable = () => true;
  modelManager.serverManager.start = async (modelPath) => {
    events.push(`start:${path.basename(modelPath)}`);
    modelManager.serverManager.ready = true;
    modelManager.serverManager.process = { pid: nextPid++ };
    modelManager.serverManager.port = 8200 + nextPid;
  };
  modelManager.serverManager.stop = async () => {
    events.push("stop");
    modelManager.serverManager.ready = false;
    modelManager.serverManager.process = null;
  };
  modelManager.serverManager.resetGpuDetection = () => events.push("gpu-reset");

  t.after(async () => {
    await Promise.all(
      [...modelManager.externalInferenceLeases.values()].map((record) =>
        modelManager.releaseExternalInferenceLease(record.token, record.ownerId, "test-cleanup")
      )
    );
  });

  return { modelManager, firstModel, secondModel, events };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("external inference lease blocks background work and invalidates cleanup cache", async (t) => {
  const { modelManager, firstModel, events } = setupModelManager(t);
  modelManager.promptWarmState = { key: "warm", pid: 99 };

  const lease = await modelManager.beginExternalInferenceLease(firstModel.id, 11);
  assert.equal(modelManager.promptWarmState, null);

  let backgroundFinished = false;
  const background = modelManager.prewarmServer(firstModel.id).then(() => {
    backgroundFinished = true;
  });
  await nextTurn();
  assert.equal(backgroundFinished, false);
  assert.equal(events.length, 1);

  assert.equal(await modelManager.releaseExternalInferenceLease(lease.leaseToken, 11), true);
  await background;
  assert.equal(events.length, 2);
});

test("lease ownership and tokens cannot release another or newer lease", async (t) => {
  const { modelManager, firstModel } = setupModelManager(t);
  const first = await modelManager.beginExternalInferenceLease(firstModel.id, 21);

  assert.equal(
    await modelManager.releaseExternalInferenceLease(first.leaseToken, 22),
    false,
    "a different renderer cannot release the lease"
  );
  await modelManager.releaseExternalInferenceLease(first.leaseToken, 21);

  const second = await modelManager.beginExternalInferenceLease(firstModel.id, 21);
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.equal(
    await modelManager.releaseExternalInferenceLease(first.leaseToken, 21),
    false,
    "a stale token cannot release a newer lease"
  );
  await modelManager.releaseExternalInferenceLease(second.leaseToken, 21);
});

test("owner loss cancels a queued begin before it can start the server", async (t) => {
  const { modelManager, firstModel, events } = setupModelManager(t);
  let openQueue;
  const blocker = modelManager._enqueueInference(
    () => new Promise((resolve) => (openQueue = resolve))
  );
  const pendingLease = modelManager.beginExternalInferenceLease(firstModel.id, 31);
  await nextTurn();
  const releaseOwner = modelManager.releaseExternalInferenceLeasesForOwner(31, "owner-gone");

  openQueue();
  await blocker;
  await assert.rejects(pendingLease, { name: "AbortError" });
  await releaseOwner;
  assert.deepEqual(events, []);
});

test("lease timeout stops the active server before a model switch enters the queue", async (t) => {
  const { modelManager, firstModel, secondModel, events } = setupModelManager(t);
  const lease = await modelManager.beginExternalInferenceLease(firstModel.id, 41, {
    timeoutMs: 5,
  });
  const switchedPort = modelManager.startServer(secondModel.id);

  await switchedPort;
  assert.deepEqual(events, [
    `start:${firstModel.fileName}`,
    "stop",
    `start:${secondModel.fileName}`,
  ]);
  assert.equal(modelManager.currentServerModelId, secondModel.id);
  assert.equal(
    await modelManager.releaseExternalInferenceLease(lease.leaseToken, 41),
    false,
    "a late timeout-era release cannot affect the replacement model"
  );
});

test("renderer crash stops its active server before a queued model switch", async (t) => {
  const { modelManager, firstModel, secondModel, events } = setupModelManager(t);
  const sender = new EventEmitter();
  sender.id = 61;
  bindInferenceLeaseOwner(sender, (ownerId, reason) =>
    modelManager.releaseExternalInferenceLeasesForOwner(ownerId, reason)
  );
  await modelManager.beginExternalInferenceLease(firstModel.id, 61);
  const switchedPort = modelManager.startServer(secondModel.id);
  sender.id = 999;

  sender.emit("render-process-gone");
  await switchedPort;
  assert.deepEqual(events, [
    `start:${firstModel.fileName}`,
    "stop",
    `start:${secondModel.fileName}`,
  ]);
  assert.equal(modelManager.currentServerModelId, secondModel.id);
});

test("GPU reset and restart remain behind an active external lease", async (t) => {
  const { modelManager, firstModel, events } = setupModelManager(t);
  const lease = await modelManager.beginExternalInferenceLease(firstModel.id, 51);
  const reset = modelManager.resetGpuAndRestart();
  await nextTurn();
  assert.deepEqual(events, [`start:${firstModel.fileName}`]);

  await modelManager.releaseExternalInferenceLease(lease.leaseToken, 51);
  await reset;
  assert.deepEqual(events, [
    `start:${firstModel.fileName}`,
    "gpu-reset",
    "stop",
    `start:${firstModel.fileName}`,
  ]);
});
