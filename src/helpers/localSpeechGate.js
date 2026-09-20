const SILENCE_RMS_THRESHOLD = 0.002;
// A whisper can sit below the RMS silence floor while still producing repeated
// speech-shaped peaks. Windows are sampled every 100 ms; requiring two adjacent
// windows admits a short word but rejects a one-window click or handling bump.
// These conservative full-scale PCM thresholds still need real-mic calibration;
// they intentionally apply only to Parakeet until device evidence says otherwise.
const QUIET_ACTIVITY_RMS_THRESHOLD = 0.00075;
const QUIET_ACTIVITY_PEAK_THRESHOLD = 0.003;
const MIN_CONSECUTIVE_QUIET_WINDOWS = 2;
const SPEECH_WINDOW_RMS_THRESHOLD = 0.003;
const SPEECH_WINDOW_PEAK_THRESHOLD = 0.02;
const STRONG_SPEECH_RMS_THRESHOLD = 0.006;

export const createLocalSpeechGateState = () => ({
  peakRms: 0,
  peakAmplitude: 0,
  windowCount: 0,
  speechWindowCount: 0,
  consecutiveSpeechWindows: 0,
  maxConsecutiveSpeechWindows: 0,
  consecutiveQuietWindows: 0,
  maxConsecutiveQuietWindows: 0,
});

export const measureFloatSpeechWindow = (samples) => {
  if (!samples?.length) return null;

  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i];
    sum += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  return { rms: Math.sqrt(sum / samples.length), peak };
};

export const recordLocalSpeechWindow = (state, rms, peak) => {
  if (!state) {
    return null;
  }

  state.windowCount += 1;
  state.peakRms = Math.max(state.peakRms, rms);
  state.peakAmplitude = Math.max(state.peakAmplitude, peak);

  const isQuietActivity =
    rms >= QUIET_ACTIVITY_RMS_THRESHOLD && peak >= QUIET_ACTIVITY_PEAK_THRESHOLD;
  state.consecutiveQuietWindows = isQuietActivity ? state.consecutiveQuietWindows + 1 : 0;
  state.maxConsecutiveQuietWindows = Math.max(
    state.maxConsecutiveQuietWindows,
    state.consecutiveQuietWindows
  );

  const isSpeechWindow = rms >= SPEECH_WINDOW_RMS_THRESHOLD && peak >= SPEECH_WINDOW_PEAK_THRESHOLD;
  if (!isSpeechWindow) {
    state.consecutiveSpeechWindows = 0;
    return state;
  }

  state.speechWindowCount += 1;
  state.consecutiveSpeechWindows += 1;
  state.maxConsecutiveSpeechWindows = Math.max(
    state.maxConsecutiveSpeechWindows,
    state.consecutiveSpeechWindows
  );
  return state;
};

export const getLocalSpeechGateDecision = (state, { allowQuietSpeech = false } = {}) => {
  if (!state?.windowCount) {
    return { skip: false, reason: "unavailable" };
  }

  const metrics = {
    peakRms: state.peakRms,
    peakAmplitude: state.peakAmplitude,
    windowCount: state.windowCount,
    speechWindowCount: state.speechWindowCount,
    maxConsecutiveSpeechWindows: state.maxConsecutiveSpeechWindows,
  };

  if (state.peakRms < SILENCE_RMS_THRESHOLD) {
    if (allowQuietSpeech && state.maxConsecutiveQuietWindows >= MIN_CONSECUTIVE_QUIET_WINDOWS) {
      return { skip: false, reason: "quiet_speech_detected", ...metrics };
    }
    return { skip: true, reason: "silence", ...metrics };
  }

  const hasSpeech = state.speechWindowCount >= 1 || state.peakRms >= STRONG_SPEECH_RMS_THRESHOLD;

  if (
    !hasSpeech &&
    allowQuietSpeech &&
    state.maxConsecutiveQuietWindows >= MIN_CONSECUTIVE_QUIET_WINDOWS
  ) {
    return { skip: false, reason: "quiet_speech_detected", ...metrics };
  }

  if (!hasSpeech) {
    return { skip: true, reason: "insufficient_speech", ...metrics };
  }

  return { skip: false, reason: "speech_detected", ...metrics };
};
