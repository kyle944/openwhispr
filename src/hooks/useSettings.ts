import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useSettingsStore, initializeSettings } from "../stores/settingsStore";
import logger from "../utils/logger";
import { useLocalStorage } from "./useLocalStorage";
import type {
  ChineseScriptPreference,
  LocalTranscriptionProvider,
  InferenceMode,
  SelfHostedType,
} from "../types/electron";
import type { Snippet } from "../utils/snippets";
import { effectiveAudioRetentionDays } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import { getCleanupSystemPrompt, wrapCleanupTranscript } from "../config/prompts";
import { resolveCleanupLanguage } from "../utils/chineseScript";
import { getDictionaryHintWords } from "../utils/snippets";
import {
  readLearnedCorrectionExamples,
  rememberLearnedCorrectionExample,
} from "../utils/learnedCorrectionExamples";

export interface TranscriptionSettings {
  uiLanguage: string;
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  parakeetModel: string;
  allowOpenAIFallback: boolean;
  allowLocalFallback: boolean;
  fallbackWhisperModel: string;
  preferredLanguage: string;
  /** When transcription language is Auto, force Chinese output script. See #975. */
  chineseScriptPreference: ChineseScriptPreference;
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
  cloudTranscriptionBaseUrl?: string;
  cloudTranscriptionMode: string;
  transcriptionMode: InferenceMode;
  remoteTranscriptionType: SelfHostedType;
  remoteTranscriptionUrl: string;
  remoteTranscriptionModel: string;
  customDictionary: string[];
  snippets: Snippet[];
  assemblyAiStreaming: boolean;
  showTranscriptionPreview: boolean;
}

export interface CleanupSettings {
  autoGenerateNoteTitle: boolean;
  useCleanupModel: boolean;
  useDictationAgent: boolean;
  cleanupModel: string;
  cleanupProvider: string;
  cleanupCloudBaseUrl?: string;
  cleanupCloudMode: string;
  cleanupMode: InferenceMode;
  cleanupRemoteUrl: string;
}

export interface HotkeySettings {
  dictationKey: string;
  /** Hotkeys actually registered by the main process (may be a subset of
   * dictationKey, e.g. primary-only on GNOME/KDE/Hyprland). Display-only. */
  activeDictationKey: string | null;
  meetingKey: string;
  voiceAgentKey: string;
  meetingHotkeyLayoutMode: "side-panel" | "full-width";
  activationMode: "tap" | "push";
}

export interface OnboardingSettings {
  onboardingUseCases: string[];
  onboardingUseCaseNote: string;
  spokenLanguages: string[];
}

export interface MicrophoneSettings {
  microphoneSelectionMode: "system" | "built-in" | "specific";
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
  selectedMicDeviceLabel: string;
  micWarmHoldSeconds: number;
}

export interface ApiKeySettings {
  openaiApiKey: string;
  anthropicApiKey: string;
  geminiApiKey: string;
  groqApiKey: string;
  xaiApiKey: string;
  mistralApiKey: string;
  openrouterApiKey: string;
  cortiClientId: string;
  cortiClientSecret: string;
  cortiApiKey: string;
  tinfoilApiKey: string;
  customTranscriptionApiKey: string;
  cleanupCustomApiKey: string;
}

export interface PrivacySettings {
  cloudBackupEnabled: boolean;
  telemetryEnabled: boolean;
  audioRetentionDays: number;
  transcriptRetentionDays: number;
  dataRetentionEnabled: boolean;
  saveDiscardedTranscriptions: boolean;
}

export interface ThemeSettings {
  theme: "light" | "dark" | "auto";
}

export interface ChatAgentSettings {
  chatAgentModel: string;
  chatAgentProvider: string;
  chatAgentCloudMode: string;
  chatAgentMode: InferenceMode;
  chatAgentCloudBaseUrl: string;
  chatAgentRemoteUrl: string;
  chatAgentCustomApiKey: string;
}

function useSettingsInternal() {
  const store = useSettingsStore();
  const { applyCustomDictionaryFromExternal, applySnippetsFromExternal } = store;

  // One-time initialization: sync API keys, dictation key, activation mode,
  // UI language, and dictionary from the main process / SQLite.
  const initializationRef = useRef<Promise<void> | null>(null);
  // The cleanup system prompt ends with the LEARNED CORRECTIONS block, which lives in
  // localStorage rather than the settings store. Learning one therefore changes the
  // prompt without touching any dependency below, so the prefix llama.cpp has cached
  // goes stale and the next dictation re-evaluates the whole prompt. Bump this so the
  // pre-warm below re-runs, and note that the edit that teaches a correction is the
  // very act that would otherwise make the next dictation the slow one.
  const [learnedCorrectionsRevision, setLearnedCorrectionsRevision] = useState(0);
  useEffect(() => {
    if (initializationRef.current) return;
    initializationRef.current = initializeSettings();
    initializationRef.current.catch((err) => {
      logger.warn(
        "Failed to initialize settings store",
        { error: (err as Error).message },
        "settings"
      );
    });
  }, []);

  // Main-process startup loads Qwen's weights, but llama.cpp still has to
  // evaluate the full cleanup prompt on the first dictation. Prefill the exact
  // hydrated prompt (dictionary, snippets, language, and custom prompt) once in
  // the background so that work is finished before the user stops speaking.
  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.prewarmLocalCleanup) return;

    let cancelled = false;
    const prewarm = async () => {
      await (initializationRef.current || initializeSettings());
      if (cancelled) return;

      const current = useSettingsStore.getState();
      if (!current.useCleanupModel || current.cleanupMode !== "local" || !current.cleanupModel)
        return;

      const agentName = localStorage.getItem("agentName") || null;
      const systemPrompt = getCleanupSystemPrompt(
        agentName,
        getDictionaryHintWords(current),
        resolveCleanupLanguage(current.preferredLanguage),
        current.uiLanguage
      );

      await window.electronAPI.prewarmLocalCleanup({
        modelId: current.cleanupModel,
        systemPrompt,
        userPrompt: wrapCleanupTranscript(""),
        disableThinking: current.cleanupDisableThinking,
      });
    };

    void prewarm().catch((err) => {
      logger.debug("Local cleanup prompt pre-warm failed", {
        error: (err as Error).message,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [
    store.useCleanupModel,
    store.cleanupMode,
    store.cleanupModel,
    store.cleanupDisableThinking,
    store.customDictionary,
    store.snippets,
    store.preferredLanguage,
    store.uiLanguage,
    store.customPrompts.cleanup,
    learnedCorrectionsRevision,
  ]);

  // Refresh the in-memory store from main-process broadcasts (auto-learn, sync
  // pulls) without re-triggering a sync — that would loop, since pulls emit the
  // broadcast. Writes that must sync go through setCustomDictionary instead.
  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.onDictionaryUpdated) return;
    const unsubscribe = window.electronAPI.onDictionaryUpdated((words: string[]) => {
      if (Array.isArray(words)) {
        applyCustomDictionaryFromExternal(words);
      }
    });
    return unsubscribe;
  }, [applyCustomDictionaryFromExternal]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.onCorrectionExampleLearned) return;
    return window.electronAPI.onCorrectionExampleLearned((example) => {
      const before = JSON.stringify(readLearnedCorrectionExamples());
      const after = JSON.stringify(rememberLearnedCorrectionExample(example));
      // A duplicate or rejected example leaves the prompt untouched, so re-warming
      // it would only spend GPU time to arrive at the cache we already hold.
      if (after !== before) setLearnedCorrectionsRevision((n) => n + 1);
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.onSnippetsUpdated) return;
    const unsubscribe = window.electronAPI.onSnippetsUpdated((snippets: Snippet[]) => {
      if (Array.isArray(snippets)) {
        applySnippetsFromExternal(snippets);
      }
    });
    return unsubscribe;
  }, [applySnippetsFromExternal]);

  // Auto-learn corrections from user edits in external apps
  const [autoLearnCorrections, setAutoLearnCorrectionsRaw] = useLocalStorage(
    "autoLearnCorrections",
    true,
    {
      serialize: String,
      deserialize: (value: string) => value !== "false",
    }
  );

  const setAutoLearnCorrections = useCallback(
    (enabled: boolean) => {
      setAutoLearnCorrectionsRaw(enabled);
      window.electronAPI?.setAutoLearnEnabled?.(enabled);
    },
    [setAutoLearnCorrectionsRaw]
  );

  // Sync auto-learn state to main process on mount
  useEffect(() => {
    window.electronAPI?.setAutoLearnEnabled?.(autoLearnCorrections);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Retention periods are enforced by the main process cleanup sweep
  const { audioRetentionDays, transcriptRetentionDays } = store;
  const enforcedAudioRetentionDays = usePolicyStore((policyState) =>
    effectiveAudioRetentionDays(policyState, audioRetentionDays)
  );
  useEffect(() => {
    window.electronAPI?.syncRetentionSettings?.({
      audioRetentionDays: enforcedAudioRetentionDays,
      transcriptRetentionDays,
    });
  }, [enforcedAudioRetentionDays, transcriptRetentionDays]);

  // Sync startup pre-warming preferences to main process
  const {
    useLocalWhisper,
    localTranscriptionProvider,
    whisperModel,
    parakeetModel,
    useCleanupModel,
    cleanupMode,
    cleanupModel,
    useDictationAgent,
    dictationAgentMode,
    dictationAgentModel,
  } = store;

  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.syncStartupPreferences) return;

    const model = localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel;
    window.electronAPI
      .syncStartupPreferences({
        useLocalWhisper,
        localTranscriptionProvider,
        model: model || undefined,
        useCleanupModel,
        cleanupMode,
        cleanupModel,
        useDictationAgent,
        dictationAgentMode,
        dictationAgentModel,
      })
      .catch((err) =>
        logger.warn(
          "Failed to sync startup preferences",
          { error: (err as Error).message },
          "settings"
        )
      );
  }, [
    useLocalWhisper,
    localTranscriptionProvider,
    whisperModel,
    parakeetModel,
    useCleanupModel,
    cleanupMode,
    cleanupModel,
    useDictationAgent,
    dictationAgentMode,
    dictationAgentModel,
  ]);

  return {
    useLocalWhisper: store.useLocalWhisper,
    whisperModel: store.whisperModel,
    uiLanguage: store.uiLanguage,
    localTranscriptionProvider: store.localTranscriptionProvider,
    parakeetModel: store.parakeetModel,
    allowOpenAIFallback: store.allowOpenAIFallback,
    allowLocalFallback: store.allowLocalFallback,
    fallbackWhisperModel: store.fallbackWhisperModel,
    preferredLanguage: store.preferredLanguage,
    chineseScriptPreference: store.chineseScriptPreference,
    cloudTranscriptionProvider: store.cloudTranscriptionProvider,
    cloudTranscriptionModel: store.cloudTranscriptionModel,
    cloudTranscriptionBaseUrl: store.cloudTranscriptionBaseUrl,
    cleanupCloudBaseUrl: store.cleanupCloudBaseUrl,
    cloudTranscriptionMode: store.cloudTranscriptionMode,
    cleanupCloudMode: store.cleanupCloudMode,
    transcriptionMode: store.transcriptionMode,
    remoteTranscriptionType: store.remoteTranscriptionType,
    remoteTranscriptionUrl: store.remoteTranscriptionUrl,
    remoteTranscriptionModel: store.remoteTranscriptionModel,
    cleanupMode: store.cleanupMode,
    cleanupRemoteUrl: store.cleanupRemoteUrl,
    customDictionary: store.customDictionary,
    snippets: store.snippets,
    setSnippets: store.setSnippets,
    assemblyAiStreaming: store.assemblyAiStreaming,
    setAssemblyAiStreaming: store.setAssemblyAiStreaming,
    autoGenerateNoteTitle: store.autoGenerateNoteTitle,
    setAutoGenerateNoteTitle: store.setAutoGenerateNoteTitle,
    useCleanupModel: store.useCleanupModel,
    useDictationAgent: store.useDictationAgent,
    cleanupModel: store.cleanupModel,
    cleanupProvider: store.cleanupProvider,
    openaiApiKey: store.openaiApiKey,
    anthropicApiKey: store.anthropicApiKey,
    geminiApiKey: store.geminiApiKey,
    groqApiKey: store.groqApiKey,
    xaiApiKey: store.xaiApiKey,
    mistralApiKey: store.mistralApiKey,
    openrouterApiKey: store.openrouterApiKey,
    tinfoilApiKey: store.tinfoilApiKey,
    dictationKey: store.dictationKey,
    meetingKey: store.meetingKey,
    voiceAgentKey: store.voiceAgentKey,
    meetingHotkeyLayoutMode: store.meetingHotkeyLayoutMode,
    setMeetingHotkeyLayoutMode: store.setMeetingHotkeyLayoutMode,
    theme: store.theme,
    setUseLocalWhisper: store.setUseLocalWhisper,
    setWhisperModel: store.setWhisperModel,
    setUiLanguage: store.setUiLanguage,
    setLocalTranscriptionProvider: store.setLocalTranscriptionProvider,
    setParakeetModel: store.setParakeetModel,
    setAllowOpenAIFallback: store.setAllowOpenAIFallback,
    setAllowLocalFallback: store.setAllowLocalFallback,
    setFallbackWhisperModel: store.setFallbackWhisperModel,
    setPreferredLanguage: store.setPreferredLanguage,
    setChineseScriptPreference: store.setChineseScriptPreference,
    setCloudTranscriptionProvider: store.setCloudTranscriptionProvider,
    setCloudTranscriptionModel: store.setCloudTranscriptionModel,
    setCloudTranscriptionBaseUrl: store.setCloudTranscriptionBaseUrl,
    setCloudTranscriptionMode: store.setCloudTranscriptionMode,
    setCleanupCloudBaseUrl: store.setCleanupCloudBaseUrl,
    setCleanupCloudMode: store.setCleanupCloudMode,
    setTranscriptionMode: store.setTranscriptionMode,
    setRemoteTranscriptionType: store.setRemoteTranscriptionType,
    setRemoteTranscriptionUrl: store.setRemoteTranscriptionUrl,
    setRemoteTranscriptionModel: store.setRemoteTranscriptionModel,
    setCleanupMode: store.setCleanupMode,
    setCleanupRemoteUrl: store.setCleanupRemoteUrl,
    setCustomDictionary: store.setCustomDictionary,
    updateCustomDictionary: store.updateCustomDictionary,
    setUseCleanupModel: store.setUseCleanupModel,
    setUseDictationAgent: store.setUseDictationAgent,
    setCleanupModel: store.setCleanupModel,
    setCleanupProvider: store.setCleanupProvider,
    setOpenaiApiKey: store.setOpenaiApiKey,
    setAnthropicApiKey: store.setAnthropicApiKey,
    setGeminiApiKey: store.setGeminiApiKey,
    setGroqApiKey: store.setGroqApiKey,
    setMistralApiKey: store.setMistralApiKey,
    customTranscriptionApiKey: store.customTranscriptionApiKey,
    setCustomTranscriptionApiKey: store.setCustomTranscriptionApiKey,
    cleanupCustomApiKey: store.cleanupCustomApiKey,
    setCleanupCustomApiKey: store.setCleanupCustomApiKey,
    setDictationKey: store.setDictationKey,
    setMeetingKey: store.setMeetingKey,
    setVoiceAgentKey: store.setVoiceAgentKey,
    onboardingUseCases: store.onboardingUseCases,
    setOnboardingUseCases: store.setOnboardingUseCases,
    onboardingUseCaseNote: store.onboardingUseCaseNote,
    setOnboardingUseCaseNote: store.setOnboardingUseCaseNote,
    spokenLanguages: store.spokenLanguages,
    setSpokenLanguages: store.setSpokenLanguages,
    setTheme: store.setTheme,
    activationMode: store.activationMode,
    setActivationMode: store.setActivationMode,
    notificationsEnabled: store.notificationsEnabled,
    setNotificationsEnabled: store.setNotificationsEnabled,
    notifyMeetingDetection: store.notifyMeetingDetection,
    setNotifyMeetingDetection: store.setNotifyMeetingDetection,
    notifyCalendarReminders: store.notifyCalendarReminders,
    setNotifyCalendarReminders: store.setNotifyCalendarReminders,
    notifyUpdates: store.notifyUpdates,
    setNotifyUpdates: store.setNotifyUpdates,
    audioCuesEnabled: store.audioCuesEnabled,
    setAudioCuesEnabled: store.setAudioCuesEnabled,
    pauseMediaOnDictation: store.pauseMediaOnDictation,
    setPauseMediaOnDictation: store.setPauseMediaOnDictation,
    floatingIconAutoHide: store.floatingIconAutoHide,
    setFloatingIconAutoHide: store.setFloatingIconAutoHide,
    startMinimized: store.startMinimized,
    setStartMinimized: store.setStartMinimized,
    panelStartPosition: store.panelStartPosition,
    setPanelStartPosition: store.setPanelStartPosition,
    microphoneSelectionMode: store.microphoneSelectionMode,
    preferBuiltInMic: store.preferBuiltInMic,
    selectedMicDeviceId: store.selectedMicDeviceId,
    selectedMicDeviceLabel: store.selectedMicDeviceLabel,
    micWarmHoldSeconds: store.micWarmHoldSeconds,
    setMicrophoneSelectionMode: store.setMicrophoneSelectionMode,
    setPreferBuiltInMic: store.setPreferBuiltInMic,
    setSelectedMicDevice: store.setSelectedMicDevice,
    setMicWarmHoldSeconds: store.setMicWarmHoldSeconds,
    autoLearnCorrections,
    setAutoLearnCorrections,
    showTranscriptionPreview: store.showTranscriptionPreview,
    setShowTranscriptionPreview: store.setShowTranscriptionPreview,
    autoPasteEnabled: store.autoPasteEnabled,
    setAutoPasteEnabled: store.setAutoPasteEnabled,
    keepTranscriptionInClipboard: store.keepTranscriptionInClipboard,
    setKeepTranscriptionInClipboard: store.setKeepTranscriptionInClipboard,
    noteFilesEnabled: store.noteFilesEnabled,
    setNoteFilesEnabled: store.setNoteFilesEnabled,
    noteFilesPath: store.noteFilesPath,
    setNoteFilesPath: store.setNoteFilesPath,
    dictationSileroEnabled: store.dictationSileroEnabled,
    setDictationSileroEnabled: store.setDictationSileroEnabled,
    noteRecordingSileroEnabled: store.noteRecordingSileroEnabled,
    setNoteRecordingSileroEnabled: store.setNoteRecordingSileroEnabled,
    meetingSileroEnabled: store.meetingSileroEnabled,
    setMeetingSileroEnabled: store.setMeetingSileroEnabled,
    whisperVadThreshold: store.whisperVadThreshold,
    setWhisperVadThreshold: store.setWhisperVadThreshold,
    whisperVadMinSpeechDurationMs: store.whisperVadMinSpeechDurationMs,
    setWhisperVadMinSpeechDurationMs: store.setWhisperVadMinSpeechDurationMs,
    whisperVadMinSilenceDurationMs: store.whisperVadMinSilenceDurationMs,
    setWhisperVadMinSilenceDurationMs: store.setWhisperVadMinSilenceDurationMs,
    whisperVadMaxSpeechDurationS: store.whisperVadMaxSpeechDurationS,
    setWhisperVadMaxSpeechDurationS: store.setWhisperVadMaxSpeechDurationS,
    whisperVadSpeechPadMs: store.whisperVadSpeechPadMs,
    setWhisperVadSpeechPadMs: store.setWhisperVadSpeechPadMs,
    whisperVadSamplesOverlap: store.whisperVadSamplesOverlap,
    setWhisperVadSamplesOverlap: store.setWhisperVadSamplesOverlap,
    cloudBackupEnabled: store.cloudBackupEnabled,
    setCloudBackupEnabled: store.setCloudBackupEnabled,
    telemetryEnabled: store.telemetryEnabled,
    setTelemetryEnabled: store.setTelemetryEnabled,
    audioRetentionDays: store.audioRetentionDays,
    setAudioRetentionDays: store.setAudioRetentionDays,
    transcriptRetentionDays: store.transcriptRetentionDays,
    setTranscriptRetentionDays: store.setTranscriptRetentionDays,
    dataRetentionEnabled: store.dataRetentionEnabled,
    setDataRetentionEnabled: store.setDataRetentionEnabled,
    saveDiscardedTranscriptions: store.saveDiscardedTranscriptions,
    setSaveDiscardedTranscriptions: store.setSaveDiscardedTranscriptions,
    updateTranscriptionSettings: store.updateTranscriptionSettings,
    updateCleanupSettings: store.updateCleanupSettings,
    updateApiKeys: store.updateApiKeys,
  };
}

export type SettingsValue = ReturnType<typeof useSettingsInternal>;

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const value = useSettingsInternal();
  return React.createElement(SettingsContext.Provider, { value }, children);
}

export function useSettings(): SettingsValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return ctx;
}
