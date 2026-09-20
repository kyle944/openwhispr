const test = require("node:test");
const assert = require("node:assert/strict");

test("fails open when no windows were recorded", async () => {
  const { createLocalSpeechGateState, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  assert.deepEqual(getLocalSpeechGateDecision(createLocalSpeechGateState()), {
    skip: false,
    reason: "unavailable",
  });
  assert.deepEqual(getLocalSpeechGateDecision(null), { skip: false, reason: "unavailable" });
});

test("treats near silence as skippable", async () => {
  const { createLocalSpeechGateState, recordLocalSpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createLocalSpeechGateState();
  recordLocalSpeechWindow(state, 0.0012, 0.01);
  recordLocalSpeechWindow(state, 0.0016, 0.015);
  recordLocalSpeechWindow(state, 0.0014, 0.012);

  assert.deepEqual(getLocalSpeechGateDecision(state), {
    skip: true,
    reason: "silence",
    peakRms: 0.0016,
    peakAmplitude: 0.015,
    windowCount: 3,
    speechWindowCount: 0,
    maxConsecutiveSpeechWindows: 0,
  });
});

test("allows a quiet single word spanning two analyzer windows for Parakeet", async () => {
  const { createLocalSpeechGateState, recordLocalSpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createLocalSpeechGateState();
  recordLocalSpeechWindow(state, 0.0011, 0.018);
  recordLocalSpeechWindow(state, 0.0013, 0.021);

  assert.equal(getLocalSpeechGateDecision(state).reason, "silence");
  assert.deepEqual(getLocalSpeechGateDecision(state, { allowQuietSpeech: true }), {
    skip: false,
    reason: "quiet_speech_detected",
    peakRms: 0.0013,
    peakAmplitude: 0.021,
    windowCount: 2,
    speechWindowCount: 0,
    maxConsecutiveSpeechWindows: 0,
  });
});

test("float PCM resolves a low-amplitude speech-like waveform below byte quantization", async () => {
  const {
    createLocalSpeechGateState,
    getLocalSpeechGateDecision,
    measureFloatSpeechWindow,
    recordLocalSpeechWindow,
  } = await import("../../src/helpers/localSpeechGate.js");

  const waveform = Float32Array.from({ length: 2048 }, (_, index) => {
    const phase = (index / 2048) * Math.PI * 36;
    // A quiet voiced component plus sparse higher-crest consonant energy.
    return 0.0012 * Math.sin(phase) + 0.0022 * Math.sin(phase * 2.17) ** 7;
  });
  const metrics = measureFloatSpeechWindow(waveform);
  assert.ok(metrics.rms > 0.00075 && metrics.rms < 0.003);
  assert.ok(metrics.peak > 0.003 && metrics.peak < 1 / 256);

  const floatState = createLocalSpeechGateState();
  recordLocalSpeechWindow(floatState, metrics.rms, metrics.peak);
  recordLocalSpeechWindow(floatState, metrics.rms, metrics.peak);

  assert.equal(
    getLocalSpeechGateDecision(floatState, { allowQuietSpeech: true }).reason,
    "quiet_speech_detected"
  );

  const byteQuantizedWaveform = Float32Array.from(
    waveform,
    (sample) => (Math.min(255, Math.max(0, Math.floor(128 * (1 + sample)))) - 128) / 128
  );
  const byteMetrics = measureFloatSpeechWindow(byteQuantizedWaveform);
  assert.ok(
    byteMetrics.rms > metrics.rms * 3,
    "byte-domain floor quantization should distort the sub-quantum waveform"
  );
  assert.equal(byteMetrics.peak, 1 / 128);
});

test("does not mistake one quiet noise spike for a whispered word", async () => {
  const { createLocalSpeechGateState, recordLocalSpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createLocalSpeechGateState();
  recordLocalSpeechWindow(state, 0.0009, 0.024);
  recordLocalSpeechWindow(state, 0.0004, 0.006);

  assert.equal(getLocalSpeechGateDecision(state, { allowQuietSpeech: true }).reason, "silence");
});

test("keeps quiet Parakeet evidence when a later non-speech bump raises peak RMS", async () => {
  const { createLocalSpeechGateState, recordLocalSpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createLocalSpeechGateState();
  recordLocalSpeechWindow(state, 0.0011, 0.018);
  recordLocalSpeechWindow(state, 0.0013, 0.021);
  recordLocalSpeechWindow(state, 0.0026, 0.012);

  assert.deepEqual(getLocalSpeechGateDecision(state, { allowQuietSpeech: true }), {
    skip: false,
    reason: "quiet_speech_detected",
    peakRms: 0.0026,
    peakAmplitude: 0.021,
    windowCount: 3,
    speechWindowCount: 0,
    maxConsecutiveSpeechWindows: 0,
  });
});

test("rejects isolated noise bursts without sustained speech", async () => {
  const { createLocalSpeechGateState, recordLocalSpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createLocalSpeechGateState();
  // All windows have energy above silence but below speech thresholds
  recordLocalSpeechWindow(state, 0.0025, 0.015);
  recordLocalSpeechWindow(state, 0.0028, 0.018);
  recordLocalSpeechWindow(state, 0.0022, 0.014);

  const decision = getLocalSpeechGateDecision(state);

  assert.equal(decision.skip, true);
  assert.equal(decision.reason, "insufficient_speech");
  assert.equal(decision.peakRms, 0.0028);
  assert.equal(decision.peakAmplitude, 0.018);
  assert.equal(decision.windowCount, 3);
  assert.equal(decision.speechWindowCount, 0);
  assert.equal(decision.maxConsecutiveSpeechWindows, 0);
});

test("allows sustained speech-like energy through", async () => {
  const { createLocalSpeechGateState, recordLocalSpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createLocalSpeechGateState();
  recordLocalSpeechWindow(state, 0.003, 0.025);
  recordLocalSpeechWindow(state, 0.0056, 0.06);
  recordLocalSpeechWindow(state, 0.0061, 0.065);

  assert.deepEqual(getLocalSpeechGateDecision(state), {
    skip: false,
    reason: "speech_detected",
    peakRms: 0.0061,
    peakAmplitude: 0.065,
    windowCount: 3,
    speechWindowCount: 3,
    maxConsecutiveSpeechWindows: 3,
  });
});
