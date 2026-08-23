const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const { createUploadCancelRegistry } = require("../../src/helpers/uploadCancelRegistry");
const originalLoad = Module._load;

// Captures every ipcMain.handle registration and every net.fetch request so the
// registered handler closures can be invoked directly against a fake `this`.
const handlers = new Map();
const fetches = [];
const databaseWrites = [];
const broadcasts = [];
let fetchResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ text: "transcribed" }),
  text: async () => JSON.stringify({ text: "transcribed" }),
});

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
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  net: {
    fetch: async (url, init) => {
      fetches.push({ url: String(url), init });
      return fetchResponse(String(url), init);
    },
  },
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

const cortiCalls = [];
const tinfoilCalls = [];
const admissionDispatches = [];
let cortiBehavior = async () => ({ text: "corti text" });
let tokenState = { token: null, generation: 0 };
let enterpriseConfigResult = null;
let enterpriseConfigBehavior = async () => enterpriseConfigResult;

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const useManagedAdmissionConfig = async () => {
  tokenState = { token: "managed-token", generation: 7 };
  enterpriseConfigResult = {
    success: true,
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: {
      workspaceId: "workspace-a",
      generation: 11,
      localModels: {
        transcription: [{ provider: "whisper", modelId: "small" }],
        reasoning: [],
      },
    },
  };
  const mainSender = { id: 1 };
  fakeThis.windowManager.mainWindow = { webContents: mainSender };
  await handlers.get("get-managed-enterprise-config")(
    { sender: mainSender },
    "account-a",
    "workspace-a",
    7
  );
};

const managedContext = (provider, model, managed = false) => ({
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 7,
  configGeneration: 11,
  managed,
  provider,
  model,
});

// Kept installed for the whole file: the corti client is require()d lazily at
// handler invocation time, not at module load.
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./tokenStore") {
      return {
        get: () => tokenState.token,
        getState: () => ({ ...tokenState }),
      };
    }
    if (request === "./enterpriseIdentityManager") {
      return {
        createEnterpriseIdentityManager: () => ({
          clear() {},
          getConfig: (request) => enterpriseConfigBehavior(request),
          resolveProvider: async () => ({ managed: false }),
        }),
      };
    }
    if (request === "./meetingTranscriptionLifecycle") {
      return () => ({
        abortSession: async () => ({ success: true }),
        startSession: async () => {
          admissionDispatches.push("meeting-start");
          return { success: true };
        },
        stopSession: async () => ({ success: true }),
      });
    }
    if (request === "./cortiTranscription") {
      return {
        transcribeAudio: async (opts) => {
          cortiCalls.push(opts);
          return cortiBehavior(opts);
        },
      };
    }
    if (request === "./tinfoilTranscription") {
      return {
        transcribeWithTinfoil: async (opts) => {
          tinfoilCalls.push(opts);
          return { text: "tinfoil text", model: "tinfoil-model" };
        },
        getTinfoilChatModels: () => [],
      };
    }
    if (request === "./windowBroadcast") {
      return { broadcastToWindows: (...args) => broadcasts.push(args) };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

// A permissive `this` for setupHandlers: registration only stores closures, so
// any manager not exercised by the retry handler can be an inert stub.
function anything() {
  return new Proxy(function () {}, {
    get: (t, prop) => {
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "";
      if (prop === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function buildFakeThis() {
  const dbRows = new Map([[7, { id: 7, audio_duration_ms: 1200, route_kind: "translation" }]]);
  const target = {
    sessionId: "test-session",
    _uploadCancelRegistry: createUploadCancelRegistry(),
    _cloudTranscriptionRequests: {
      begin: () => ({ signal: { aborted: false } }),
      cancelSender() {},
      complete() {},
    },
    audioStorageManager: { getAudioBuffer: (id) => (id === 7 ? Buffer.from([1, 2, 3]) : null) },
    databaseManager: {
      updateTranscriptionText: (...args) => databaseWrites.push(["text", ...args]),
      updateTranscriptionStatus: (...args) => databaseWrites.push(["status", ...args]),
      updateTranscriptionAudio: (...args) => databaseWrites.push(["audio", ...args]),
      getTranscriptionById: (id) => dbRows.get(id),
    },
    environmentManager: {
      getOpenAIKey: () => "sk-openai",
      getGroqKey: () => "gk-groq",
      getMistralKey: () => "mk-mistral",
      getXaiKey: () => "xk-xai",
      getTinfoilKey: () => "tk-tinfoil",
      getCustomTranscriptionKey: () => "ck-custom",
      getCortiClientId: () => "corti-id",
      getCortiClientSecret: () => "corti-secret",
    },
    whisperManager: {
      serverManager: { isAvailable: () => true },
      transcribeLocalWhisper: async () => {
        admissionDispatches.push("whisper");
        return { success: true, text: "local text" };
      },
    },
    parakeetManager: {
      supportsOnlineStreaming: () => false,
      transcribeLocalParakeet: async () => {
        admissionDispatches.push("parakeet");
        return { success: true, text: "local text" };
      },
    },
    windowManager: {
      showTranscriptionPreview: () => admissionDispatches.push("preview"),
      hideTranscriptionPreview() {},
    },
  };
  return new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop] : anything()),
  });
}

let retryHandler;
let fakeThis;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  fakeThis = buildFakeThis();
  Ctor.prototype.setupHandlers.call(fakeThis);
  retryHandler = handlers.get("retry-transcription");
  assert.ok(retryHandler, "retry-transcription must be registered");
});

test.after(() => {
  Module._load = originalLoad;
});

test.beforeEach(() => {
  fakeThis._clearActiveEnterpriseIdentity?.();
  delete fakeThis.windowManager.mainWindow;
  fetches.length = 0;
  databaseWrites.length = 0;
  broadcasts.length = 0;
  cortiCalls.length = 0;
  tinfoilCalls.length = 0;
  admissionDispatches.length = 0;
  tokenState = { token: null, generation: 0 };
  enterpriseConfigResult = null;
  enterpriseConfigBehavior = async () => enterpriseConfigResult;
});

const invoke = (settings, id = 7, requestId) =>
  retryHandler({ sender: {} }, id, settings, requestId);

test("managed admission rejects each start family before provider dispatch", async (t) => {
  await useManagedAdmissionConfig();
  const sender = { id: 22, once() {}, removeListener() {}, send() {}, isDestroyed: () => false };
  const cases = [
    {
      name: "dictation batch",
      channel: "cloud-transcribe",
      args: [new ArrayBuffer(4), {}, managedContext("openwhispr", null)],
    },
    {
      name: "preview",
      channel: "start-dictation-preview",
      args: [
        { provider: "nvidia", model: "parakeet-tdt-0.6b-v3", display: false },
        managedContext("nvidia", "parakeet-tdt-0.6b-v3"),
      ],
    },
    {
      name: "realtime",
      channel: "dictation-realtime-start",
      args: [
        { provider: "openai-realtime", model: "gpt-4o-mini-transcribe" },
        managedContext("openai-realtime", "gpt-4o-mini-transcribe"),
      ],
    },
    {
      name: "upload",
      channel: "transcribe-audio-file-byok",
      args: [
        {
          filePath: "/tmp/not-read.webm",
          provider: "openai",
          model: "gpt-4o-mini-transcribe",
          transcriptionMode: "providers",
        },
        managedContext("openai", "gpt-4o-mini-transcribe"),
      ],
    },
    {
      name: "history",
      channel: "retry-transcription",
      args: [
        7,
        {
          useLocalWhisper: false,
          cloudTranscriptionMode: "openwhispr",
          transcriptionMode: "providers",
        },
        "managed-history-bypass",
        managedContext("openwhispr", null),
      ],
    },
    {
      name: "meeting prepare",
      channel: "meeting-transcription-prepare",
      args: [
        {
          provider: "local",
          localProvider: "nvidia",
          localModel: "parakeet-tdt-0.6b-v3",
        },
        managedContext("nvidia", "parakeet-tdt-0.6b-v3"),
      ],
    },
    {
      name: "meeting start",
      channel: "meeting-transcription-start",
      args: [
        {
          provider: "local",
          localProvider: "nvidia",
          localModel: "parakeet-tdt-0.6b-v3",
          sessionId: "managed-meeting-bypass",
        },
        managedContext("nvidia", "parakeet-tdt-0.6b-v3"),
      ],
    },
    {
      name: "direct local decode",
      channel: "transcribe-local-parakeet",
      args: [
        new ArrayBuffer(4),
        { model: "parakeet-tdt-0.6b-v3" },
        managedContext("nvidia", "parakeet-tdt-0.6b-v3"),
      ],
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await useManagedAdmissionConfig();
      admissionDispatches.length = 0;
      fetches.length = 0;
      if (testCase.name === "realtime") {
        fakeThis._dictationStreaming = {
          get isConnected() {
            admissionDispatches.push("realtime");
            return true;
          },
        };
      }
      const result = await handlers.get(testCase.channel)({ sender }, ...testCase.args);
      assert.equal(result.success, false);
      assert.equal(result.code, "MANAGED_MODEL_REQUIRED");
      assert.deepEqual(admissionDispatches, []);
      assert.deepEqual(fetches, []);
    });
  }
});

test("managed local history retry admits its exact configured route", async () => {
  await useManagedAdmissionConfig();

  const result = await retryHandler(
    { sender: {} },
    7,
    {
      useLocalWhisper: true,
      localTranscriptionProvider: "whisper",
      whisperModel: "small",
      preferredLanguage: "auto",
    },
    undefined,
    managedContext("whisper", "small", true)
  );

  assert.equal(result.success, true);
  assert.deepEqual(admissionDispatches, ["whisper"]);
  assert.deepEqual(fetches, []);
});

test("a late accessible workspace cannot replace the main window's newer active identity", async () => {
  tokenState = { token: "managed-token", generation: 7 };
  const mainSender = { id: 1 };
  fakeThis.windowManager.mainWindow = { webContents: mainSender };
  const workspaceA = createDeferred();
  const workspaceB = createDeferred();
  const configs = {
    "workspace-a": {
      success: true,
      accountId: "account-a",
      workspaceId: "workspace-a",
      authGeneration: 7,
      config: {
        workspaceId: "workspace-a",
        generation: 11,
        localModels: { transcription: [], reasoning: [] },
      },
    },
    "workspace-b": {
      success: true,
      accountId: "account-a",
      workspaceId: "workspace-b",
      authGeneration: 7,
      config: {
        workspaceId: "workspace-b",
        generation: 22,
        localModels: {
          transcription: [{ provider: "whisper", modelId: "small" }],
          reasoning: [],
        },
      },
    },
  };
  enterpriseConfigBehavior = ({ workspaceId }) =>
    workspaceId === "workspace-a" ? workspaceA.promise : workspaceB.promise;

  const getConfig = handlers.get("get-managed-enterprise-config");
  const pendingA = getConfig({ sender: mainSender }, "account-a", "workspace-a", 7);
  const pendingB = getConfig({ sender: mainSender }, "account-a", "workspace-b", 7);
  workspaceB.resolve(configs["workspace-b"]);
  await pendingB;
  workspaceA.resolve(configs["workspace-a"]);
  await pendingA;

  enterpriseConfigBehavior = async ({ workspaceId }) => configs[workspaceId];
  admissionDispatches.length = 0;
  const staleResult = await handlers.get("transcribe-local-whisper")(
    { sender: { id: 2 } },
    new ArrayBuffer(4),
    { model: "base" },
    {
      accountId: "account-a",
      workspaceId: "workspace-a",
      authGeneration: 7,
      configGeneration: 11,
      managed: false,
      provider: "whisper",
      model: "base",
    }
  );

  assert.equal(staleResult.success, false);
  assert.equal(staleResult.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  assert.deepEqual(admissionDispatches, []);

  const currentResult = await handlers.get("transcribe-local-whisper")(
    { sender: { id: 2 } },
    new ArrayBuffer(4),
    { model: "small" },
    {
      accountId: "account-a",
      workspaceId: "workspace-b",
      authGeneration: 7,
      configGeneration: 22,
      managed: true,
      provider: "whisper",
      model: "small",
    }
  );

  assert.equal(currentResult.success, true);
  assert.deepEqual(admissionDispatches, ["whisper"]);
});

test("a start cannot dispatch after its main-owned identity changes while config awaits", async () => {
  await useManagedAdmissionConfig();
  const mainSender = fakeThis.windowManager.mainWindow.webContents;
  const startLookupEntered = createDeferred();
  const startConfig = createDeferred();
  const workspaceBConfig = {
    success: true,
    accountId: "account-a",
    workspaceId: "workspace-b",
    authGeneration: 7,
    config: {
      workspaceId: "workspace-b",
      generation: 22,
      localModels: {
        transcription: [{ provider: "whisper", modelId: "small" }],
        reasoning: [],
      },
    },
  };
  enterpriseConfigBehavior = ({ workspaceId }) => {
    if (workspaceId === "workspace-a") {
      startLookupEntered.resolve();
      return startConfig.promise;
    }
    return Promise.resolve(workspaceBConfig);
  };
  admissionDispatches.length = 0;

  const pendingStart = handlers.get("transcribe-local-whisper")(
    { sender: { id: 2 } },
    new ArrayBuffer(4),
    { model: "small" },
    managedContext("whisper", "small", true)
  );
  await startLookupEntered.promise;
  await handlers.get("get-managed-enterprise-config")(
    { sender: mainSender },
    "account-a",
    "workspace-b",
    7
  );
  startConfig.resolve(enterpriseConfigResult);

  const result = await pendingStart;
  assert.equal(result.success, false);
  assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  assert.deepEqual(admissionDispatches, []);
});

test("main-owned identity invalidation prevents a later transcription dispatch", async (t) => {
  const cases = [
    {
      name: "main-window clear",
      invalidate: async (mainSender) => {
        await handlers.get("clear-managed-enterprise-identity")({ sender: mainSender });
      },
    },
    {
      name: "token changes while a binding request awaits",
      invalidate: async (mainSender) => {
        const configResponse = createDeferred();
        enterpriseConfigBehavior = () => configResponse.promise;
        const pendingRefresh = handlers.get("get-managed-enterprise-config")(
          { sender: mainSender },
          "account-a",
          "workspace-a",
          7
        );
        tokenState = { token: "replacement-token", generation: 7 };
        configResponse.resolve(enterpriseConfigResult);
        await pendingRefresh;
      },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await useManagedAdmissionConfig();
      await testCase.invalidate(fakeThis.windowManager.mainWindow.webContents);
      admissionDispatches.length = 0;

      const result = await handlers.get("transcribe-local-whisper")(
        { sender: { id: 2 } },
        new ArrayBuffer(4),
        { model: "small" },
        managedContext("whisper", "small", true)
      );

      assert.equal(result.success, false);
      assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
      assert.deepEqual(admissionDispatches, []);
    });
  }
});

test("retry: cancelling request ownership prevents late database commit and broadcast", async () => {
  databaseWrites.length = 0;
  broadcasts.length = 0;
  let resolveCorti;
  cortiBehavior = () =>
    new Promise((resolve) => {
      resolveCorti = resolve;
    });
  try {
    const callCount = cortiCalls.length;
    const retry = invoke(
      {
        cloudTranscriptionProvider: "corti",
        cloudTranscriptionMode: "byok",
        transcriptionMode: "providers",
        cortiEnvironment: "us",
        cortiTenant: "base",
        preferredLanguage: "auto",
      },
      7,
      "history-retry-1"
    );
    while (cortiCalls.length === callCount) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const cancelled = await handlers.get("cancel-upload-transcription")(
      { sender: {} },
      "history-retry-1"
    );
    resolveCorti({ text: "late corti result" });
    const result = await retry;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(cancelled.success, true);
    assert.equal(result.success, false);
    assert.equal(result.code, "UPLOAD_CANCELLED");
    assert.deepEqual(databaseWrites, []);
    assert.deepEqual(broadcasts, []);
  } finally {
    cortiBehavior = async () => ({ text: "corti text" });
  }
});

test("retry: request-owned results stay uncommitted until the renderer authorizes commit", async () => {
  databaseWrites.length = 0;
  broadcasts.length = 0;
  const result = await invoke(
    {
      cloudTranscriptionProvider: "corti",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cortiEnvironment: "us",
      cortiTenant: "base",
      preferredLanguage: "auto",
    },
    7,
    "history-retry-2"
  );

  assert.equal(result.success, true);
  assert.equal(result.pendingCommit, true);
  assert.equal(result.transcription.text, "corti text");
  assert.equal(result.transcription.route_kind, "translation");
  assert.deepEqual(databaseWrites, []);
  assert.deepEqual(broadcasts, []);

  const committed = await handlers.get("commit-retry-transcription")(
    { sender: {} },
    7,
    "history-retry-2",
    "clean final text",
    "corti text"
  );
  assert.equal(committed.success, true);
  assert.deepEqual(databaseWrites[0], ["text", 7, "clean final text", "corti text"]);
  assert.equal(databaseWrites.length, 3);
  assert.equal(broadcasts.length, 1);
});

test("retry: cancelling a pending result prevents its later commit", async () => {
  const result = await invoke(
    {
      cloudTranscriptionProvider: "corti",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cortiEnvironment: "us",
      cortiTenant: "base",
      preferredLanguage: "auto",
    },
    7,
    "history-retry-3"
  );
  assert.equal(result.pendingCommit, true);

  const cancelled = await handlers.get("cancel-upload-transcription")(
    { sender: {} },
    "history-retry-3"
  );
  const committed = await handlers.get("commit-retry-transcription")(
    { sender: {} },
    7,
    "history-retry-3",
    "late final text",
    "corti text"
  );

  assert.equal(cancelled.success, true);
  assert.equal(committed.success, false);
  assert.deepEqual(databaseWrites, []);
  assert.deepEqual(broadcasts, []);
});

test("retry: only the renderer that owns a pending result can cancel or commit it", async () => {
  const ownerEvent = { sender: { id: 11 } };
  const otherEvent = { sender: { id: 12 } };
  const result = await retryHandler(
    ownerEvent,
    7,
    {
      cloudTranscriptionProvider: "corti",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cortiEnvironment: "us",
      cortiTenant: "base",
      preferredLanguage: "auto",
    },
    "history-retry-owner"
  );
  assert.equal(result.pendingCommit, true);

  const otherCancel = await handlers.get("cancel-upload-transcription")(
    otherEvent,
    "history-retry-owner"
  );
  const otherCommit = await handlers.get("commit-retry-transcription")(
    otherEvent,
    7,
    "history-retry-owner",
    "wrong owner",
    "corti text"
  );
  const ownerCancel = await handlers.get("cancel-upload-transcription")(
    ownerEvent,
    "history-retry-owner"
  );

  assert.equal(otherCancel.success, false);
  assert.equal(otherCommit.success, false);
  assert.equal(ownerCancel.success, true);
  assert.deepEqual(databaseWrites, []);
  assert.deepEqual(broadcasts, []);
});

test("retry: corti routes to the corti client, never OpenAI", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "corti",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cortiEnvironment: "eu",
    cortiTenant: "acme",
    preferredLanguage: "auto",
  });
  assert.equal(result.success, true);
  assert.equal(cortiCalls.length, 1);
  assert.equal(cortiCalls[0].environment, "eu");
  assert.equal(cortiCalls[0].tenant, "acme");
  assert.equal(cortiCalls[0].language, "en");
  assert.equal(fetches.length, 0, "corti retry must not touch HTTP endpoints");
});

test("retry: custom misconfiguration fails closed with a coded error", async () => {
  fetches.length = 0;
  for (const cloudTranscriptionBaseUrl of ["", "https://api.openai.com/v1", "not a url"]) {
    const result = await invoke({
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cloudTranscriptionBaseUrl,
    });
    assert.equal(result.success, false, cloudTranscriptionBaseUrl);
    assert.equal(result.code, "CUSTOM_ENDPOINT_INVALID", cloudTranscriptionBaseUrl);
  }
  assert.equal(fetches.length, 0);
});

test("retry: openwhispr cloud masks a leftover BYOK misconfiguration", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "openwhispr",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "",
  });
  // BrowserWindow.fromWebContents is stubbed to null, so the cloud branch
  // produces no result — but the route error must NOT surface.
  assert.equal(result.success, false);
  assert.notEqual(result.code, "CUSTOM_ENDPOINT_INVALID");
  assert.match(result.error, /No transcription engine available/);
  assert.equal(fetches.length, 0);
});

test("retry: Azure custom endpoints get deployment URLs and api-key auth", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://myres.openai.azure.com",
    cloudTranscriptionModel: "my-deployment",
  });
  assert.equal(result.success, true);
  assert.equal(fetches.length, 1);
  assert.match(fetches[0].url, /myres\.openai\.azure\.com\/openai\/deployments\/my-deployment/);
  assert.equal(fetches[0].init.headers["api-key"], "ck-custom");
  assert.equal(fetches[0].init.headers.Authorization, undefined);
});

test("retry: plain custom endpoints use Bearer auth at the configured URL", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://stt.parasail.example.com/v1",
    cloudTranscriptionModel: "parasail-model",
  });
  assert.equal(result.success, true);
  assert.equal(fetches[0].url, "https://stt.parasail.example.com/v1/audio/transcriptions");
  assert.equal(fetches[0].init.headers.Authorization, "Bearer ck-custom");
});

test("retry: a custom URL on Tinfoil's host is refused in the main process", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://inference.tinfoil.sh/v1",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /attested main-process proxy/);
  assert.equal(fetches.length, 0);
  assert.equal(tinfoilCalls.length, 0);
});

test("retry: mistral goes to Mistral with x-api-key", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "mistral",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.match(fetches[0].url, /api\.mistral\.ai/);
  assert.equal(fetches[0].init.headers["x-api-key"], "mk-mistral");
});

test("proxy transcription handlers resolve to structured errors instead of rejecting", async () => {
  fetchResponse = () => ({
    ok: false,
    status: 401,
    text: async () => "unauthorized",
    json: async () => ({}),
  });
  cortiBehavior = async () => {
    const err = new Error("Corti API Error: 401");
    err.code = "INVALID_KEY";
    throw err;
  };
  try {
    for (const channel of [
      "proxy-mistral-transcription",
      "proxy-xai-transcription",
      "proxy-corti-transcription",
    ]) {
      const fn = handlers.get(channel);
      assert.ok(fn, `${channel} must be registered`);
      const result = await fn({ sender: {} }, { audioBuffer: new ArrayBuffer(4) });
      assert.equal(typeof result.error, "string", channel);
    }
  } finally {
    cortiBehavior = async () => ({ text: "corti text" });
    fetchResponse = () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: "transcribed" }),
      text: async () => JSON.stringify({ text: "transcribed" }),
    });
  }
});

const fsNode = require("node:fs");
const osNode = require("node:os");
const pathNode = require("node:path");

const uploadTempFile = pathNode.join(osNode.tmpdir(), "openwhispr-upload-handler-test.webm");

const invokeUpload = (payload) => {
  const uploadHandler = handlers.get("transcribe-audio-file-byok");
  assert.ok(uploadHandler, "transcribe-audio-file-byok must be registered");
  fsNode.writeFileSync(uploadTempFile, Buffer.from([1, 2, 3, 4]));
  return uploadHandler({ sender: {} }, { filePath: uploadTempFile, ...payload });
};

test("upload: mistral sends x-api-key with a provider-validated model and no language on auto", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "mk-mistral",
    baseUrl: "https://api.mistral.ai/v1",
    model: "gpt-4o-mini-transcribe", // stale from an openai era — must degrade
    provider: "mistral",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.match(fetches[0].url, /api\.mistral\.ai/);
  assert.equal(fetches[0].init.headers["x-api-key"], "mk-mistral");
  assert.equal(fetches[0].init.headers.Authorization, undefined);
  const body = fetches[0].init.body.toString();
  assert.match(body, /voxtral-mini-latest/);
  assert.doesNotMatch(body, /name="language"/);
});

test("upload: openai diarization fields ride the route, Bearer auth", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "sk-openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe",
    provider: "openai",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.equal(fetches[0].init.headers.Authorization, "Bearer sk-openai");
  const body = fetches[0].init.body.toString();
  assert.match(body, /gpt-4o-transcribe-diarize/);
  assert.match(body, /diarized_json/);
});

test("upload: sentinel custom URL fails closed before any request", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    provider: "custom",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "CUSTOM_ENDPOINT_INVALID");
  assert.equal(fetches.length, 0);
});

test("upload: a custom URL on Tinfoil's host is refused in the main process", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://inference.tinfoil.sh/v1",
    model: "whisper-1",
    provider: "custom",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /attested main-process proxy/);
  assert.equal(fetches.length, 0);
});

// An uploaded file is frequently not in the dictation language, and a wrong hint
// silently mistranscribes it — so BYOK cloud uploads auto-detect even when the
// user has pinned a preferred language for dictation.
test("upload: a preferred language never constrains a BYOK cloud upload", async () => {
  for (const provider of ["openai", "groq", "custom"]) {
    fetches.length = 0;
    const result = await invokeUpload({
      apiKey: "sk-key",
      baseUrl: provider === "custom" ? "https://gateway.example.com/v1" : "",
      model: "whisper-1",
      provider,
      language: "de",
      transcriptionMode: "providers",
    });
    assert.equal(result.success, true, provider);
    assert.doesNotMatch(fetches[0].init.body.toString(), /name="language"/, provider);
  }
});

// Providers that require a concrete language still receive one.
test("upload: corti and xai still get their language", async () => {
  fetches.length = 0;
  const xai = await invokeUpload({
    apiKey: "xk-key",
    baseUrl: "",
    model: "grok-stt",
    provider: "xai",
    language: "de",
    transcriptionMode: "providers",
  });
  assert.equal(xai.success, true);
  assert.match(fetches[0].url, /api\.x\.ai/);
  const xaiBody = fetches[0].init.body.toString();
  assert.match(xaiBody, /name="language"[\s\S]*?de/);
  assert.doesNotMatch(xaiBody, /name="model"/);

  const corti = await invokeUpload({
    apiKey: "",
    baseUrl: "",
    model: "corti-transcribe",
    provider: "corti",
    language: "",
    environment: "eu",
    tenant: " acme ",
    transcriptionMode: "providers",
  });
  assert.equal(corti.success, true);
  assert.equal(cortiCalls.at(-1).language, "en", "corti needs a concrete primaryLanguage");
  assert.equal(cortiCalls.at(-1).environment, "eu");
  assert.equal(cortiCalls.at(-1).tenant, "acme");
});

// #1459 made cloudTranscriptionBaseUrl Custom-only, so provider id alone can no
// longer tell whether a Custom endpoint fronts a diarization-capable API.
test("upload: a Custom endpoint fronting OpenAI or Mistral keeps diarization", async () => {
  fetches.length = 0;
  const openaiFronted = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.openai.com/v1/audio/transcriptions",
    model: "whisper-1",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(openaiFronted.success, true);
  assert.match(fetches[0].init.body.toString(), /gpt-4o-transcribe-diarize/);

  fetches.length = 0;
  const mistralFronted = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.mistral.ai/v1/audio/transcriptions",
    model: "voxtral-mini-latest",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(mistralFronted.success, true);
  assert.match(fetches[0].init.body.toString(), /name="diarize"/);

  fetches.length = 0;
  const unknownGateway = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://gateway.example.com/v1",
    model: "whisper-1",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(unknownGateway.success, true, "an unknown gateway degrades, never fails");
  assert.doesNotMatch(fetches[0].init.body.toString(), /diarized_json/);
});

test("upload: a self-hosted Azure endpoint keeps its deployment URL", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "",
    baseUrl: "",
    model: "",
    provider: "custom",
    language: "",
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://myorg.openai.azure.com",
    remoteTranscriptionModel: "my-deployment",
  });
  assert.equal(result.success, true);
  assert.equal(
    fetches[0].url,
    "https://myorg.openai.azure.com/openai/deployments/my-deployment/audio/transcriptions?api-version=2025-03-01-preview"
  );
});
