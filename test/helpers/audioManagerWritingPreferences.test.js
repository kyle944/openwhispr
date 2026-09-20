const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

async function loadRoute(t) {
  const settingsKey = "__writingPreferenceRouteSettings";
  const { vite } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-writing-route-test-",
    settingsKey,
    settings: {},
    mockModules: {
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.${settingsKey};
        export const useSettingsStore = { getState: () => globalThis.${settingsKey} };
        export const getEffectiveCleanupModel = () => "local-cleanup";
        export const selectResolvedLLMConfig = () => ({
          mode: globalThis.${settingsKey}.cleanupMode || "local",
          model: "local-cleanup",
          provider: "local",
        });
        export const isCloudCleanupMode = () =>
          globalThis.${settingsKey}.cleanupMode !== "local";
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/dictationAgentInference": `
        export const resolveDictationAgentInference = () => ({
          reachable: false,
          model: "",
          displayProvider: "none",
          config: {},
        });
        export const resolveDictationAgentVisionInference = () => ({
          active: false,
          model: "",
          config: {},
        });
      `,
      "/dictationTranslationInference": `
        export const resolveDictationTranslationInference = () => ({
          reachable: true,
          model: "local-translation",
          displayProvider: "local",
          config: { provider: "local" },
        });
      `,
    },
  });
  return (await vite.ssrLoadModule("/helpers/audioManager.js")).resolveReasoningRoute;
}

function settings(cleanupIntensity) {
  return {
    cleanupIntensity,
    useCleanupModel: true,
    cleanupMode: "local",
    cleanupDisableThinking: true,
    cleanupOutputMode: "dictation",
    cleanupTone: "default",
    backgroundCleanupEnabled: true,
    perAppWritingStyles: [],
    customPrompts: {},
    customDictionary: [],
    snippets: [],
    dictationAgentMode: "local",
    translationTargetLanguage: "es",
    preferredLanguage: "auto",
    uiLanguage: "en",
  };
}

test("no-cleanup skips ordinary dictation without disabling agent or translation", async (t) => {
  const resolveReasoningRoute = await loadRoute(t);
  const noCleanup = settings("none");

  assert.equal(
    resolveReasoningRoute("ordinary dictation", noCleanup, null, false, false, null).kind,
    "skip"
  );
  assert.equal(
    resolveReasoningRoute("translate this", noCleanup, null, false, true, null).kind,
    "translation"
  );
  assert.equal(
    resolveReasoningRoute("voice command", noCleanup, null, true, false, null).kind,
    "agent"
  );
  assert.equal(
    resolveReasoningRoute("ordinary dictation", settings("light"), null, false, false, null).kind,
    "cleanup"
  );
});

test("local per-app preferences share one explicit prompt and formatting identity", async (t) => {
  const resolveReasoningRoute = await loadRoute(t);
  const configured = {
    ...settings("light"),
    perAppWritingStyles: [
      {
        bundleId: "com.example.mail",
        appName: "Mail",
        cleanupOutputMode: "email",
        cleanupTone: "formal",
      },
    ],
  };

  const route = resolveReasoningRoute(
    "draft this",
    configured,
    null,
    false,
    false,
    null,
    undefined,
    { bundleId: "com.example.mail", appName: "Mail" }
  );

  assert.equal(route.kind, "cleanup");
  assert.match(route.config.systemPrompt, /Format the dictated content as an email/);
  assert.match(route.config.systemPrompt, /Use a formal tone/);
  assert.match(route.config.speculativeCleanupCacheKey, /cleanupOutputMode=email/);
  assert.match(route.config.speculativeCleanupCacheKey, /cleanupTone=formal/);
});

test("hosted cleanup keeps its existing prompt path without per-app metadata", async (t) => {
  const resolveReasoningRoute = await loadRoute(t);
  const configured = {
    ...settings("light"),
    cleanupMode: "openwhispr",
    perAppWritingStyles: [
      {
        bundleId: "com.example.mail",
        appName: "Mail",
        cleanupOutputMode: "email",
        cleanupTone: "formal",
      },
    ],
  };

  const route = resolveReasoningRoute(
    "draft this",
    configured,
    null,
    false,
    false,
    null,
    undefined,
    { bundleId: "com.example.mail", appName: "Mail" }
  );

  assert.equal(route.kind, "cleanup");
  assert.equal("systemPrompt" in route.config, false);
  assert.equal("speculativeCleanupCacheKey" in route.config, false);
});
