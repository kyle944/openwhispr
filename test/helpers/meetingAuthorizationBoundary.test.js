const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const blockedPolicy = {
  version: 1,
  transcription: { allowedModes: [], allowedByokProviders: [] },
  llm: { allowedModes: [], allowedByokProviders: [], allowedEnterpriseProviders: [] },
  features: { agentEnabled: false, webSearchEnabled: false },
  sharing: { externalLinkSharing: "disabled" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: false,
  },
  minAppVersion: null,
};

test("an authorization change aborts an in-flight prepare and prevents stale reuse", async (t) => {
  const preparation = createDeferred();
  const prepareCalls = [];
  const abortCalls = [];
  let cancelCalls = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        meetingTranscriptionPrepare: async (options) => {
          prepareCalls.push(options);
          if (prepareCalls.length === 1) return preparation.promise;
          return { success: true };
        },
        meetingTranscriptionAbort: async (sessionId) => {
          abortCalls.push(sessionId);
          return { success: true };
        },
        meetingTranscriptionCancel: async () => {
          cancelCalls += 1;
          return { success: true };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-authorization-boundary-test-",
  });
  const meeting = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.4", policy: null });

  const firstPrepare = meeting.prepareTranscription();
  while (prepareCalls.length === 0) await Promise.resolve();
  usePolicyStore.setState({
    status: "managed",
    appVersion: "1.8.4",
    policy: blockedPolicy,
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(cancelCalls, 1);
  assert.deepEqual(abortCalls, []);
  preparation.resolve({ success: true });
  await firstPrepare;

  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.4", policy: null });
  await Promise.resolve();
  abortCalls.length = 0;
  await meeting.prepareTranscription();
  assert.equal(prepareCalls.length, 2, "the stale prepared connection must not be reused");
});

const nativeSystemAudioAccess = {
  granted: true,
  status: "granted",
  mode: "native",
  strategy: "native",
  supportsNativeCapture: true,
};

function installUnavailableMicrophone(t) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices: async () => [],
        getUserMedia: async () => {
          throw new Error("No microphone in renderer test");
        },
      },
    },
  });
  t.after(() => {
    if (originalDescriptor) Object.defineProperty(globalThis, "navigator", originalDescriptor);
    else delete globalThis.navigator;
  });
}

test("authorization abort overtakes graceful meeting stop before transcript persistence", async (t) => {
  const stopping = createDeferred();
  const stopCalls = [];
  const abortCalls = [];
  const noteUpdates = [];
  installUnavailableMicrophone(t);
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        checkSystemAudioAccess: async () => nativeSystemAudioAccess,
        meetingTranscriptionStart: async ({ sessionId }) => ({
          success: true,
          sessionId,
          systemAudioMode: "native",
          systemAudioStrategy: "native",
        }),
        meetingTranscriptionStop: async (sessionId) => {
          stopCalls.push(sessionId);
          return stopping.promise;
        },
        meetingTranscriptionAbort: async (sessionId) => {
          abortCalls.push(sessionId);
          return { success: true };
        },
        updateNote: async (...args) => {
          noteUpdates.push(args);
          return { success: true };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-stop-authorization-boundary-test-",
  });
  const meeting = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.4", policy: null });

  assert.equal(
    await meeting.startRecording({
      noteId: 41,
      noteTitle: "Boundary meeting",
      folderId: null,
      seedSegments: [{ id: "segment-1", text: "stale segment", source: "system" }],
      autoEndEligible: false,
    }),
    true
  );

  const stopPromise = meeting.stopRecording();
  while (stopCalls.length === 0) await Promise.resolve();
  usePolicyStore.setState({
    status: "managed",
    appVersion: "1.8.4",
    policy: blockedPolicy,
  });
  while (abortCalls.length === 0) await Promise.resolve();
  stopping.resolve({
    success: false,
    reason: "authorization-changed",
    code: "AUTHORIZATION_BOUNDARY_CHANGED",
  });

  assert.deepEqual(await stopPromise, { diarizationSessionId: null });
  assert.deepEqual(noteUpdates, []);
});

test("an ordinary meeting stop still persists the captured transcript", async (t) => {
  const noteUpdates = [];
  installUnavailableMicrophone(t);
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        checkSystemAudioAccess: async () => nativeSystemAudioAccess,
        meetingTranscriptionStart: async ({ sessionId }) => ({
          success: true,
          sessionId,
          systemAudioMode: "native",
          systemAudioStrategy: "native",
        }),
        meetingTranscriptionStop: async () => ({ success: true, transcript: "main transcript" }),
        updateNote: async (...args) => {
          noteUpdates.push(args);
          return { success: true };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-stop-persistence-test-",
  });
  const meeting = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.4", policy: null });

  await meeting.startRecording({
    noteId: 42,
    noteTitle: "Ordinary meeting",
    folderId: null,
    seedSegments: [{ id: "segment-1", text: "kept segment", source: "system" }],
    autoEndEligible: false,
  });
  await meeting.stopRecording();

  assert.equal(noteUpdates.length, 1);
  assert.equal(noteUpdates[0][0], 42);
  assert.deepEqual(JSON.parse(noteUpdates[0][1].transcript), [
    { text: "kept segment", source: "system" },
  ]);
});
