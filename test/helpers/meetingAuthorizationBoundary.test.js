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

async function createDiarizationHarness(t, overrides = {}) {
  const noteUpdates = [];
  const embeddingWrites = [];
  let completionCallback;
  let stopIndex = 0;
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
        meetingTranscriptionStop: async () => {
          const result = {
            success: true,
            transcript: "main transcript",
            diarizationSessionId: (overrides.sessionIds ?? ["diar-a"])[stopIndex++],
          };
          await overrides.beforeStopResult?.(result, completionCallback);
          return result;
        },
        meetingTranscriptionCancel: async () => ({ success: true }),
        meetingTranscriptionAbort: async () => ({ success: true }),
        getNote:
          overrides.getNote ??
          (async (noteId) => ({
            id: noteId,
            transcript: JSON.stringify([{ text: "base", source: "system" }]),
          })),
        updateNote: async (...args) => {
          noteUpdates.push(args);
          await overrides.onUpdateNote?.(...args);
          return { success: true };
        },
        saveNoteSpeakerEmbeddings: async (...args) => {
          embeddingWrites.push(args);
          await overrides.onSaveEmbeddings?.(...args);
          return { success: true };
        },
        onMeetingDiarizationComplete: (callback) => {
          completionCallback = callback;
          return () => {};
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: `openwhispr-meeting-diarization-boundary-${Math.random()}-`,
  });
  const meeting = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.4", policy: null });
  assert.equal(typeof completionCallback, "function");
  return {
    meeting,
    usePolicyStore,
    noteUpdates,
    embeddingWrites,
    completeDiarization: (data) => completionCallback(data),
  };
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

test("delayed meeting diarization persists while its stop authorization is unchanged", async (t) => {
  const harness = await createDiarizationHarness(t, {
    beforeStopResult: (_result, completeDiarization) => {
      completeDiarization({
        sessionId: "diar-a",
        noteId: 43,
        segments: [{ id: "diarized-1", text: "base", source: "system", speaker: "SPEAKER_00" }],
        speakerEmbeddings: { SPEAKER_00: [0.1, 0.2] },
      });
    },
  });
  await harness.meeting.startRecording({
    noteId: 43,
    noteTitle: "Authorized diarization",
    folderId: null,
    seedSegments: [{ id: "segment-1", text: "base", source: "system" }],
    autoEndEligible: false,
  });
  await harness.meeting.stopRecording();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.noteUpdates.length, 2);
  assert.equal(harness.noteUpdates[1][0], 43);
  assert.deepEqual(harness.embeddingWrites, [[43, { SPEAKER_00: [0.1, 0.2] }]]);
});

test("authorization changing during delayed diarization lookup prevents every persistence", async (t) => {
  const noteLookup = createDeferred();
  let getNoteCalls = 0;
  const harness = await createDiarizationHarness(t, {
    getNote: async () => {
      getNoteCalls += 1;
      return noteLookup.promise;
    },
  });
  await harness.meeting.startRecording({
    noteId: 44,
    noteTitle: "Revoked diarization",
    folderId: null,
    seedSegments: [{ id: "segment-1", text: "base", source: "system" }],
    autoEndEligible: false,
  });
  await harness.meeting.stopRecording();
  harness.noteUpdates.length = 0;

  harness.completeDiarization({
    sessionId: "diar-a",
    noteId: 44,
    segments: [{ id: "diarized-1", text: "base", source: "system", speaker: "SPEAKER_00" }],
    speakerEmbeddings: { SPEAKER_00: [0.1, 0.2] },
  });
  while (getNoteCalls === 0) await Promise.resolve();
  harness.usePolicyStore.setState({
    status: "managed",
    appVersion: "1.8.4",
    policy: blockedPolicy,
  });
  noteLookup.resolve({
    id: 44,
    transcript: JSON.stringify([{ text: "base", source: "system" }]),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.noteUpdates, []);
  assert.deepEqual(harness.embeddingWrites, []);
});

test("meeting A diarization still targets A after meeting B starts under the same authorization", async (t) => {
  const completionFinished = createDeferred();
  let waitingForCompletion = false;
  const harness = await createDiarizationHarness(t, {
    onUpdateNote: (noteId) => {
      if (waitingForCompletion && noteId === 45) completionFinished.resolve();
    },
  });
  await harness.meeting.startRecording({
    noteId: 45,
    noteTitle: "Meeting A",
    folderId: null,
    seedSegments: [{ id: "segment-a", text: "meeting A", source: "system" }],
    autoEndEligible: false,
  });
  await harness.meeting.stopRecording();
  harness.noteUpdates.length = 0;
  waitingForCompletion = true;
  await harness.meeting.startRecording({
    noteId: 46,
    noteTitle: "Meeting B",
    folderId: null,
    seedSegments: [{ id: "segment-b", text: "meeting B", source: "system" }],
    autoEndEligible: false,
  });

  harness.completeDiarization({
    sessionId: "diar-a",
    noteId: 45,
    segments: [{ id: "diarized-a", text: "meeting A", source: "system", speaker: "SPEAKER_00" }],
  });
  await completionFinished.promise;

  assert.equal(harness.noteUpdates.length, 1);
  assert.equal(harness.noteUpdates[0][0], 45);
});
