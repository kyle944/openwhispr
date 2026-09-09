const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

function installAudioGlobals(t) {
  const originalAudioContext = globalThis.AudioContext;
  const originalAudioWorkletNode = globalThis.AudioWorkletNode;
  const originalMediaRecorder = globalThis.MediaRecorder;
  const originalSetInterval = globalThis.setInterval;
  const contexts = [];

  class FakeAudioContext {
    constructor(options) {
      this.options = options;
      this.state = "running";
      this.resumeCalls = 0;
      this.audioWorklet = { addModule: async () => {} };
      contexts.push(this);
    }
    createAnalyser() {
      return {
        fftSize: 0,
        connect() {},
        disconnect() {},
        getByteTimeDomainData() {},
      };
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    async resume() {
      this.resumeCalls += 1;
      this.state = "running";
    }
  }

  class FakeAudioWorkletNode {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
    }
    connect() {}
    disconnect() {}
  }

  class FakeMediaRecorder {
    constructor(stream) {
      this.stream = stream;
      this.state = "inactive";
      this.mimeType = "audio/webm";
    }
    start() {
      this.state = "recording";
    }
  }

  globalThis.AudioContext = FakeAudioContext;
  globalThis.AudioWorkletNode = FakeAudioWorkletNode;
  globalThis.MediaRecorder = FakeMediaRecorder;
  globalThis.setInterval = () => 1;
  t.after(() => {
    if (originalAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = originalAudioContext;
    if (originalAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode = originalAudioWorkletNode;
    if (originalMediaRecorder === undefined) delete globalThis.MediaRecorder;
    else globalThis.MediaRecorder = originalMediaRecorder;
    globalThis.setInterval = originalSetInterval;
  });
  return contexts;
}

function fakeMicStream() {
  const track = {
    label: "Test microphone",
    muted: false,
    readyState: "live",
    getSettings: () => ({ sampleRate: 48000, channelCount: 1 }),
    stop() {},
  };
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
}

function createBatchManager(createManager, stream) {
  return createManager({
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    _streamingStopPromise: null,
    mediaRecorder: null,
    preparedMicCapture: { take: async () => null },
    isRecordingAllowedByPolicy: () => true,
    getAudioConstraints: async () => ({ audio: true }),
    _acquireCaptureStream: async () => stream,
    beginMicRecovery: async () => {},
    onStateChange() {},
    shouldUseStreaming: () => false,
  });
}

test("batch recording and preview analysis use silent AudioContext sinks", async (t) => {
  const contexts = installAudioGlobals(t);
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "audio-manager-silent-batch-",
    settingsKey: "__audioManagerSilentBatchSettings",
    settings: {
      useLocalWhisper: true,
      showTranscriptionPreview: true,
      localTranscriptionProvider: "whisper",
      preferredLanguage: "en",
      whisperModel: "base",
    },
  });
  const manager = createBatchManager(createManager, fakeMicStream());
  manager.getWorkletBlobUrl = () => "blob:test-worklet";

  assert.equal(await manager.startRecording(), true);
  assert.deepEqual(contexts.map((context) => context.options), [
    { sinkId: { type: "none" } },
    { sampleRate: 16000, sinkId: { type: "none" } },
  ]);
  assert.equal(manager.mediaRecorder.state, "recording");
  assert.equal(manager._previewAudioContext, contexts[1]);
  assert.ok(manager._previewProcessor);
  assert.equal(manager.isRecording, true);
});

test("persistent streaming context keeps silent sink, caching, resume, and closed recreation", async (t) => {
  const contexts = installAudioGlobals(t);
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "audio-manager-silent-persistent-",
    settingsKey: "__audioManagerSilentPersistentSettings",
  });
  const manager = createManager({ persistentAudioContext: null, workletModuleLoaded: true });

  const first = await manager.getOrCreateAudioContext();
  assert.deepEqual(first.options, { sampleRate: 16000, sinkId: { type: "none" } });
  assert.equal(manager.workletModuleLoaded, false);

  first.state = "suspended";
  assert.equal(await manager.getOrCreateAudioContext(), first);
  assert.equal(first.resumeCalls, 1);
  assert.equal(contexts.length, 1);

  first.state = "closed";
  manager.workletModuleLoaded = true;
  const replacement = await manager.getOrCreateAudioContext();
  assert.notEqual(replacement, first);
  assert.deepEqual(replacement.options, { sampleRate: 16000, sinkId: { type: "none" } });
  assert.equal(manager.workletModuleLoaded, false);
  assert.equal(contexts.length, 2);
});
