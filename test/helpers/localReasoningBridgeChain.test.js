const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const modelRegistryData = require("../../src/models/modelRegistryData.json");

// Drives the primary local LLM path end to end — the IPC bridge
// (localReasoningBridge) → modelManagerBridge.runInference →
// llamaServer.inference — against an HTTP stub standing in for llama-server,
// so the request body that actually reaches the wire is what gets asserted.
// Electron is stubbed the same way modelManagerBridgeDownloadStatus.test.js
// does; the fake model file and the pre-"started" server keep runInference on
// its happy path without spawning anything.

const originalLoad = Module._load;
const CHAIN_MODULES = [
  "../../src/services/localReasoningBridge.js",
  "../../src/helpers/modelManagerBridge.js",
  "../../src/helpers/modelDirUtils.js",
  "../../src/helpers/llamaServer.js",
].map((relative) => require.resolve(relative));
let electronHome = os.tmpdir();

function loadChain() {
  for (const modulePath of CHAIN_MODULES) delete require.cache[modulePath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          isReady: () => true,
          getAppPath: () => process.cwd(),
          getPath: (name) => (name === "home" ? electronHome : path.join(electronHome, name)),
        },
        net: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    require("../../src/helpers/modelDirUtils.js");
    const bridge = require("../../src/services/localReasoningBridge.js").default;
    const modelManager = require("../../src/helpers/modelManagerBridge.js").default;
    return { bridge, modelManager };
  } finally {
    Module._load = originalLoad;
  }
}

const OVER_MIN_FILE_SIZE = Buffer.alloc(1_000_001, 1);

// Stands up the stub server plus a bridge whose model manager already
// believes llama-server is running that model on the stub's port.
async function setupChain(t, respond) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-local-chain-"));
  electronHome = home;
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const request = JSON.parse(raw);
      requests.push(request);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(await respond(request)));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { bridge, modelManager } = loadChain();
  const model = modelRegistryData.localProviders[0].models[0];
  modelManager.ensureInitialized();
  await fs.mkdir(modelManager.modelsDir, { recursive: true });
  await fs.writeFile(path.join(modelManager.modelsDir, model.fileName), OVER_MIN_FILE_SIZE);

  const serverManager = modelManager.serverManager;
  serverManager.cachedServerBinaryPaths = { default: "/stub/llama-server" };
  serverManager.ready = true;
  serverManager.process = { pid: 1234 };
  serverManager.port = server.address().port;
  modelManager.currentServerModelId = model.id;
  t.after(() => serverManager.clearIdleTimer());

  return { bridge, modelManager, modelId: model.id, requests };
}

const completion = (finishReason, content) => ({
  choices: [{ finish_reason: finishReason, message: { content } }],
});

test("requireCompleteOutput rejects a truncated reply through the whole local chain", async (t) => {
  const { bridge, modelId } = await setupChain(t, () => completion("length", "partial edi"));

  await assert.rejects(
    () => bridge.processText("edit this", modelId, { requireCompleteOutput: true }),
    /truncated/
  );
});

test("a truncated reply still resolves when the caller did not require complete output", async (t) => {
  const { bridge, modelId } = await setupChain(t, () => completion("length", "partial"));

  assert.equal(await bridge.processText("clean this", modelId, {}), "partial");
});

test("an explicit temperature of 0 reaches llama-server instead of the 0.7 default", async (t) => {
  const { bridge, modelId, requests } = await setupChain(t, () => completion("stop", "ok"));

  await bridge.processText("clean this", modelId, { temperature: 0 });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].temperature, 0);
});

test("speculative wrapping preserves dollar replacement sequences exactly", async (t) => {
  const { bridge, modelId } = await setupChain(t, () => completion("stop", "unused"));
  const text = "Keep $& and $` and $' literal";
  const payload = {
    modelId,
    systemPrompt: "exact cleanup prompt",
    userPrompt: "<transcript>\n\n</transcript>\n\nOutput only the cleaned transcript.",
    disableThinking: true,
    cacheKey: "prefs-a",
  };
  const descriptor = bridge.createSpeculativeCleanupRequest(text, payload);
  const wrapped = `<transcript>\n${text}\n</transcript>\n\nOutput only the cleaned transcript.`;
  const config = bridge.buildInferenceConfig(wrapped, {
    systemPrompt: payload.systemPrompt,
    temperature: 0,
    disableThinking: true,
  });

  assert.equal(descriptor.key, bridge.createRequestKey(wrapped, modelId, config, payload.cacheKey));
});

test("cleanup prompt prewarm coalesces and invalidates when llama-server restarts", async (t) => {
  const { modelManager, modelId, requests } = await setupChain(t, () =>
    completion("length", "warm")
  );
  const payload = {
    modelId,
    systemPrompt: "exact cleanup prompt with dictionary: crazy",
    userPrompt: "<transcript>\n\n</transcript>\n\nOutput only the cleaned transcript.",
    disableThinking: true,
  };

  await Promise.all([modelManager.prewarmPrompt(payload), modelManager.prewarmPrompt(payload)]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].temperature, 0);
  assert.equal(requests[0].max_tokens, 1);
  assert.equal(requests[0].messages[0].content, payload.systemPrompt);
  assert.equal(requests[0].messages[1].content, payload.userPrompt);

  await modelManager.prewarmPrompt(payload);
  assert.equal(requests.length, 1, "same prompt and server process stay warm");

  modelManager.serverManager.process.pid = 5678;
  await modelManager.prewarmPrompt(payload);
  assert.equal(requests.length, 2, "a restarted server loses its prompt cache");
});

test("recording-start prewarm skips a warm cleanup prefix until other reasoning dirties it", async (t) => {
  const { modelManager, modelId, requests } = await setupChain(t, () => completion("stop", "ok"));
  const payload = {
    modelId,
    systemPrompt: "exact cleanup prompt",
    userPrompt: "<transcript>\n\n</transcript>",
    disableThinking: true,
  };

  await modelManager.prewarmPrompt(payload);
  await modelManager.prewarmLatestPrompt();
  assert.equal(requests.length, 1, "a warm prefix is not redundantly prefetched");

  await modelManager.runInference(modelId, "normal dictation", {
    systemPrompt: payload.systemPrompt,
  });
  await modelManager.prewarmLatestPrompt();
  assert.equal(requests.length, 2, "normal cleanup keeps the prefix warm");

  await modelManager.runInference(modelId, "chat request", {
    systemPrompt: "different agent prompt",
  });
  await modelManager.prewarmLatestPrompt();
  assert.equal(requests.length, 4, "different reasoning invalidates and restores the prefix");
});

test("changed cleanup prompts warm serially with the newest prompt last", async (t) => {
  const releases = [];
  const { modelManager, modelId, requests } = await setupChain(
    t,
    () =>
      new Promise((resolve) => {
        releases.push(() => resolve(completion("length", "warm")));
      })
  );
  const first = {
    modelId,
    systemPrompt: "dictionary: cracy",
    userPrompt: "<transcript>\n\n</transcript>",
  };
  const latest = { ...first, systemPrompt: "dictionary: crazy" };

  const firstWarm = modelManager.prewarmPrompt(first);
  while (requests.length < 1) await new Promise((resolve) => setImmediate(resolve));
  const latestWarm = modelManager.prewarmPrompt(latest);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1, "a changed prompt waits for the active warmup");

  releases.shift()();
  while (requests.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests[1].messages[0].content, latest.systemPrompt);
  releases.shift()();
  await Promise.all([firstWarm, latestWarm]);

  await modelManager.prewarmPrompt(latest);
  assert.equal(requests.length, 2, "the newest completed prompt owns the cache marker");
});

test("formatting changes invalidate an otherwise identical warm prompt", async (t) => {
  const { modelManager, modelId, requests } = await setupChain(t, () =>
    completion("length", "warm")
  );
  const payload = {
    modelId,
    systemPrompt: "exact cleanup prompt",
    userPrompt: "<transcript>\n\n</transcript>",
    cacheKey: "cleanupIntensity=light;cleanupOutputMode=dictation",
  };

  await modelManager.prewarmPrompt(payload);
  await modelManager.prewarmPrompt({
    ...payload,
    cacheKey: "cleanupIntensity=polished;cleanupOutputMode=dictation",
  });

  assert.equal(
    requests.length,
    2,
    "a preference change must not reuse an incompatible cache marker"
  );
});

test("an aborted foreground request keeps its AbortError through modelManager", async (t) => {
  const { modelManager, modelId } = await setupChain(t, () => completion("stop", "unused"));
  const controller = new AbortController();
  const originalInference = modelManager.serverManager.inference;
  modelManager.serverManager.inference = async (_messages, options) => {
    assert.equal(options.signal, controller.signal);
    const error = new Error("llama-server request aborted");
    error.name = "AbortError";
    throw error;
  };
  t.after(() => {
    modelManager.serverManager.inference = originalInference;
  });

  await assert.rejects(
    modelManager.runInference(modelId, "cleanup", { signal: controller.signal }),
    (error) => error.name === "AbortError" && error.message === "llama-server request aborted"
  );
});

test("an aborted request queued behind a warmup rejects before it can send HTTP", async (t) => {
  const releases = [];
  const { modelManager, modelId, requests } = await setupChain(
    t,
    () =>
      new Promise((resolve) => {
        releases.push(() => resolve(completion("stop", "warm")));
      })
  );
  const payload = {
    modelId,
    systemPrompt: "exact cleanup prompt",
    userPrompt: "<transcript>\n\n</transcript>",
  };

  const warmup = modelManager.prewarmPrompt(payload);
  while (requests.length < 1) await new Promise((resolve) => setImmediate(resolve));

  const controller = new AbortController();
  const queued = modelManager.runInference(modelId, "speculative cleanup", {
    systemPrompt: payload.systemPrompt,
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(queued, { name: "AbortError" });
  assert.equal(requests.length, 1, "the aborted queue entry never reaches llama-server");

  releases.shift()();
  await warmup;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1, "the aborted entry remains a no-op when its turn arrives");
});

test("a foreground request admitted first owns the server through the warm-marker commit", async (t) => {
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const { modelManager, modelId, requests } = await setupChain(
    t,
    () =>
      new Promise((resolve) => {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        setImmediate(() => {
          activeRequests -= 1;
          resolve(completion("stop", "ok"));
        });
      })
  );
  const originalCheckModelValid = modelManager.checkModelValid;
  let releaseValidation;
  const validationReleased = new Promise((resolve) => {
    releaseValidation = resolve;
  });
  let validationEntered;
  const validationStarted = new Promise((resolve) => {
    validationEntered = resolve;
  });
  let deferFirstValidation = true;
  modelManager.checkModelValid = async (modelPath) => {
    if (deferFirstValidation) {
      deferFirstValidation = false;
      validationEntered();
      await validationReleased;
    }
    return originalCheckModelValid.call(modelManager, modelPath);
  };
  t.after(() => {
    modelManager.checkModelValid = originalCheckModelValid;
  });

  const foreground = modelManager.runInference(modelId, "foreground", {
    systemPrompt: "foreground prefix",
  });
  await validationStarted;
  const payload = {
    modelId,
    systemPrompt: "cleanup prefix",
    userPrompt: "<transcript>\n\n</transcript>",
  };
  const warmup = modelManager.prewarmPrompt(payload);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 0, "the later warmup stays behind validation and startup");

  releaseValidation();
  while (requests.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests[0].messages[0].content, "foreground prefix");
  assert.equal(requests[1].messages[0].content, payload.systemPrompt);
  assert.equal(maxActiveRequests, 1, "only one request uses the mutable server at a time");

  await Promise.all([foreground, warmup]);
  await modelManager.prewarmPrompt(payload);
  assert.equal(requests.length, 2, "the final committed warm marker is a true cache hit");
});

test("same-tick prewarm restores a prefix dirtied by an admitted foreground request", async (t) => {
  const { modelManager, modelId, requests } = await setupChain(t, () => completion("stop", "ok"));
  const payload = {
    modelId,
    systemPrompt: "cleanup prefix",
    userPrompt: "<transcript>\n\n</transcript>",
  };
  await modelManager.prewarmPrompt(payload);
  assert.equal(requests.length, 1);

  const foreground = modelManager.runInference(modelId, "agent request", {
    systemPrompt: "agent prefix",
  });
  const restore = modelManager.prewarmLatestPrompt();
  await Promise.all([foreground, restore]);

  assert.equal(
    requests.length,
    3,
    "foreground runs first and the prewarm restores the evicted prefix"
  );
  assert.equal(requests[1].messages[0].content, "agent prefix");
  assert.equal(requests[2].messages[0].content, payload.systemPrompt);

  await modelManager.prewarmLatestPrompt();
  assert.equal(requests.length, 3, "the restored marker is now the actual cache hit");
});

test("user-visible local inference waits for prompt warmup instead of competing", async (t) => {
  const releases = [];
  const { modelManager, modelId, requests } = await setupChain(
    t,
    () =>
      new Promise((resolve) => {
        releases.push(() => resolve(completion("stop", "ok")));
      })
  );
  const payload = {
    modelId,
    systemPrompt: "exact cleanup prompt",
    userPrompt: "<transcript>\n\n</transcript>",
  };

  const warm = modelManager.prewarmPrompt(payload);
  while (requests.length < 1) await new Promise((resolve) => setImmediate(resolve));
  const real = modelManager.runInference(modelId, "You cracy", {
    systemPrompt: payload.systemPrompt,
    temperature: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1, "real inference stays behind the warmup");

  releases.shift()();
  while (requests.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests[1].messages[1].content, "You cracy");
  releases.shift()();
  await Promise.all([warm, real]);
});
