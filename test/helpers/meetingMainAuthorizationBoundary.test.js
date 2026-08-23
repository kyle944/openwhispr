const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
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

test("meeting prepare invalidates authorization while system-audio capability is pending", async (t) => {
  const handlers = new Map();
  const capability = createDeferred();
  let streamingClientLookups = 0;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

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
      handle: (channel, handler) => handlers.set(channel, handler),
      on: () => {},
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
    if (parent?.filename === handlersModulePath && request === "./tokenStore") {
      return {
        get: () => null,
        getState: () => ({ token: null, generation: 0 }),
      };
    }
    if (parent?.filename === handlersModulePath && request === "./meetingStreamingProviders") {
      return {
        ALLOWED_MEETING_PROVIDERS: new Set(["local", "deepgram-realtime"]),
        getMeetingConnectionKey: (options) => JSON.stringify(options),
        getMeetingStreamingClient: () => {
          streamingClientLookups += 1;
          return class {};
        },
        disconnectMeetingStreamingClient: async () => ({ text: "" }),
      };
    }
    if (parent?.filename === handlersModulePath && request === "./windowBroadcast") {
      return { broadcastToWindows: () => {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  t.after(() => {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", originalPlatform);
    delete require.cache[handlersModulePath];
  });

  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const target = {
    _meetingMicStreaming: null,
    _meetingSystemStreaming: null,
    activeMeetingSpeakerConfig: null,
    audioTapManager: { isSupported: () => false, stop: async () => {} },
    linuxPortalAudioManager: {
      getCapability: () => capability.promise,
      stop: async () => {},
    },
    windowsLoopbackAudioManager: { stop: async () => {} },
    meetingAecManager: null,
    meetingDetectionEngine: {
      endRecordingSession: () => true,
      setUserRecording: () => {},
    },
  };
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (object, property) => (property in object ? object[property] : anything()),
    })
  );

  const prepare = handlers.get("meeting-transcription-prepare");
  const abort = handlers.get("meeting-transcription-abort");
  assert.ok(prepare);
  assert.ok(abort);

  const pendingPrepare = prepare(
    { sender: {} },
    { provider: "deepgram-realtime", model: "nova-3", mode: "byok" }
  );
  await Promise.resolve();
  await abort({}, undefined);
  capability.resolve({
    available: true,
    supportsSystemAudio: true,
    supportsNativeCapture: true,
  });

  await assert.rejects(pendingPrepare, { code: "AUTHORIZATION_BOUNDARY_CHANGED" });
  assert.equal(streamingClientLookups, 0, "stale prepare must not create a streaming client");
});

test("meeting cancel invalidates deferred prepares without letting stale warmth or cleanup win", async (t) => {
  const handlers = new Map();
  const connectOperations = [];
  const disconnectOperations = [];
  let deferredToken = null;
  let tokenRequestCount = 0;
  t.after(() => {
    for (const { deferred } of connectOperations) deferred.resolve();
  });

  class DeferredStreamingClient {
    constructor() {
      this.isConnected = false;
    }

    connect() {
      const deferred = createDeferred();
      const operation = { deferred, streaming: this };
      connectOperations.push(operation);
      return deferred.promise.then(() => {
        this.isConnected = true;
      });
    }
  }

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
      handle: (channel, handler) => handlers.set(channel, handler),
      on: () => {},
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
    if (parent?.filename === handlersModulePath && request === "./tokenStore") {
      return {
        get: () => null,
        getState: () => ({ token: null, generation: 0 }),
      };
    }
    if (parent?.filename === handlersModulePath && request === "./meetingStreamingProviders") {
      return {
        ALLOWED_MEETING_PROVIDERS: new Set(["local", "deepgram-realtime"]),
        getMeetingConnectionKey: (options) => JSON.stringify(options),
        getMeetingStreamingClient: () => DeferredStreamingClient,
        disconnectMeetingStreamingClient: async (streaming, _provider, commit) => {
          if (!streaming) return { text: "" };
          disconnectOperations.push({ streaming, commit });
          streaming.isConnected = false;
          return { text: "" };
        },
      };
    }
    if (parent?.filename === handlersModulePath && request === "./realtimeTokenProviders") {
      return {
        fetchRealtimeTokenForProvider: async () => {
          tokenRequestCount += 1;
          return deferredToken ? deferredToken.promise : "deepgram-key";
        },
      };
    }
    if (parent?.filename === handlersModulePath && request === "./windowBroadcast") {
      return { broadcastToWindows: () => {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => {
    Module._load = originalLoad;
    delete require.cache[handlersModulePath];
  });

  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const target = {
    _meetingMicStreaming: null,
    _meetingSystemStreaming: null,
    activeMeetingSpeakerConfig: null,
    audioTapManager: { isSupported: () => false, stop: async () => {} },
    environmentManager: { getDeepgramKey: () => "deepgram-key" },
    linuxPortalAudioManager: { stop: async () => {} },
    windowsLoopbackAudioManager: { stop: async () => {} },
    meetingAecManager: null,
    meetingDetectionEngine: {
      beginRecordingSession: async () => true,
      endRecordingSession: () => true,
      setUserRecording: () => {},
    },
  };
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (object, property) => (property in object ? object[property] : anything()),
    })
  );

  const prepare = handlers.get("meeting-transcription-prepare");
  const cancel = handlers.get("meeting-transcription-cancel");
  assert.ok(prepare);
  assert.ok(cancel);
  const event = { sender: {} };
  const options = { provider: "deepgram-realtime", model: "nova-3", mode: "byok" };

  deferredToken = createDeferred();
  const tokenPendingPrepare = prepare(event, options);
  while (tokenRequestCount < 1) await Promise.resolve();
  assert.deepEqual(await cancel(), { success: true });
  deferredToken.resolve("deepgram-key");
  deferredToken = null;
  const tokenPendingResult = await tokenPendingPrepare;
  assert.equal(tokenPendingResult.success, false);
  assert.equal(tokenPendingResult.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  assert.equal(connectOperations.length, 0, "a stale token must not materialize a stream");

  const staleWarmPrepare = prepare(event, options);
  while (connectOperations.length < 1) await Promise.resolve();
  const staleWarmStream = connectOperations[0].streaming;
  assert.deepEqual(await cancel(), { success: true });
  assert.ok(
    disconnectOperations.some(
      ({ streaming, commit }) => streaming === staleWarmStream && commit === false
    ),
    "cancel must disconnect the pending stream without finalizing it"
  );
  connectOperations[0].deferred.resolve();
  const staleWarmResult = await staleWarmPrepare;
  assert.equal(staleWarmResult.success, false);
  assert.equal(staleWarmResult.code, "AUTHORIZATION_BOUNDARY_CHANGED");

  const firstNewPrepare = prepare(event, options);
  while (connectOperations.length < 2) await Promise.resolve();
  assert.notEqual(connectOperations[1].streaming, staleWarmStream);
  assert.deepEqual(await cancel(), { success: true });

  const currentPrepare = prepare(event, options);
  while (connectOperations.length < 3) await Promise.resolve();
  connectOperations[1].deferred.resolve();
  const supersededResult = await firstNewPrepare;
  assert.equal(supersededResult.success, false);
  assert.equal(supersededResult.code, "AUTHORIZATION_BOUNDARY_CHANGED");

  assert.deepEqual(await prepare(event, options), {
    success: false,
    error: "Operation in progress",
  });
  connectOperations[2].deferred.resolve();
  assert.deepEqual(await currentPrepare, { success: true });

  assert.deepEqual(await cancel(), { success: true });
  assert.ok(
    disconnectOperations.some(
      ({ streaming, commit }) => streaming === connectOperations[2].streaming && commit === false
    ),
    "a warm prepared stream is cancellable and is not a concrete recording session"
  );

  const start = handlers.get("meeting-transcription-start");
  const stop = handlers.get("meeting-transcription-stop");
  const localSessionId = "completed-local-session";
  const localStart = await start(event, {
    provider: "local",
    localProvider: "whisper",
    localModel: "base",
    sessionId: localSessionId,
    autoEndEligible: false,
  });
  assert.equal(localStart.success, true);
  assert.equal((await stop({}, localSessionId)).success, true);

  const afterLocalStopPrepare = prepare(event, options);
  while (connectOperations.length < 4) await Promise.resolve();
  connectOperations[3].deferred.resolve();
  assert.deepEqual(await afterLocalStopPrepare, { success: true });
  assert.deepEqual(
    await cancel(),
    { success: true },
    "a completed local session must not make the next warm transport look recording-active"
  );
});
