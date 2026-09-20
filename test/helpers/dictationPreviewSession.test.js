const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

test("a late preview chunk cannot append to or unlock the replacement session", async (t) => {
  const originalLoad = Module._load;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const handles = new Map();
  const listeners = new Map();
  const intervalCallbacks = [];
  let warmedPayload = null;
  let preparedPayload = null;
  const electronStub = {
    app: {
      getPath: () => "/tmp",
      getName: () => "test",
      getVersion: () => "0.0.0",
      isPackaged: false,
      on: () => {},
      requestSingleInstanceLock: () => true,
    },
    ipcMain: {
      handle: (channel, fn) => handles.set(channel, fn),
      on: (channel, fn) => listeners.set(channel, fn),
      removeHandler: () => {},
    },
    net: { fetch: async () => ({ ok: true, json: async () => ({}) }) },
    BrowserWindow: class BrowserWindow {
      static getAllWindows() {
        return [];
      }
      static fromWebContents() {
        return null;
      }
    },
    shell: {},
    dialog: {},
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
    systemPreferences: { getMediaAccessStatus: () => "granted" },
    session: { fromPartition: () => ({}) },
    clipboard: {},
    nativeImage: {},
    globalShortcut: {},
    utilityProcess: {},
    MessageChannelMain: class {},
  };

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") return electronStub;
    if (parent?.filename === handlersModulePath && request === "./modelManagerBridge") {
      return {
        default: {
          promptWarmPayload: null,
          prewarmPrompt: async (payload) => {
            warmedPayload = payload;
            return true;
          },
          prewarmLatestPrompt: async () => true,
        },
      };
    }
    if (parent?.filename === handlersModulePath && request === "../services/localReasoningBridge") {
      return {
        default: {
          createSpeculativeCleanupRequest: (_text, payload) => {
            preparedPayload = payload;
            return null;
          },
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  global.setInterval = (callback) => {
    intervalCallbacks.push(callback);
    return intervalCallbacks.length;
  };
  global.clearInterval = () => {};

  t.after(() => {
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    delete require.cache[handlersModulePath];
  });

  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  const requests = [];
  const appended = [];
  const target = {
    parakeetManager: {
      supportsOnlineStreaming: () => false,
      transcribeLocalParakeet: () => {
        const request = deferred();
        requests.push(request);
        return request.promise;
      },
    },
    windowManager: {
      showTranscriptionPreview: () => {},
      appendTranscriptionPreview: (text) => appended.push(text),
      hideTranscriptionPreview: () => {},
    },
    _resolveWhisperVadOptions: () => ({}),
  };
  const fakeThis = new Proxy(target, {
    get: (object, property) => (property in object ? object[property] : anything()),
  });
  Ctor.prototype.setupHandlers.call(fakeThis);

  const start = handles.get("start-dictation-preview");
  const send = listeners.get("dictation-preview-audio");
  assert.ok(start && send);

  const pcm = Buffer.alloc(3200);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(1000, offset);

  const sessionWarmPayload = {
    modelId: "cleanup-model",
    systemPrompt: "session app prompt",
    userPrompt: "<transcript>\n\n</transcript>",
    disableThinking: true,
    cacheKey: "app=com.example.mail;cleanupTone=formal",
  };
  await start(
    {},
    {
      provider: "nvidia",
      model: "model-a",
      display: true,
      speculativeCleanup: true,
      speculativeCleanupPayload: sessionWarmPayload,
    }
  );
  assert.deepEqual(warmedPayload, sessionWarmPayload);
  send({}, pcm);
  const sessionA = intervalCallbacks.at(-1)();
  assert.equal(requests.length, 1);

  await start({}, { provider: "nvidia", model: "model-b", display: true });
  send({}, pcm);
  const sessionB = intervalCallbacks.at(-1)();
  assert.equal(requests.length, 2);

  requests[0].resolve({ success: true, text: "late session A" });
  await sessionA;
  assert.deepEqual(appended, []);
  assert.equal(preparedPayload, null, "stale session text never reaches speculation");

  // A's finally must not clear B's ownership token and admit another B job.
  send({}, pcm);
  await intervalCallbacks.at(-1)();
  assert.equal(requests.length, 2);

  requests[1].resolve({ success: true, text: "current session B" });
  await sessionB;
  assert.deepEqual(appended, ["current session B"]);

  const { speculativeCleanup } = require("../../src/helpers/speculativeCleanup");
  const originalCancel = speculativeCleanup.cancel;
  let cancellations = 0;
  speculativeCleanup.cancel = () => {
    cancellations += 1;
  };
  t.after(() => {
    speculativeCleanup.cancel = originalCancel;
  });
  await handles.get("hide-dictation-preview")();
  const beforeInactiveCompletion = cancellations;
  await handles.get("complete-dictation-preview")({}, { text: "final headless text" });
  assert.equal(cancellations, beforeInactiveCompletion + 1);
});
