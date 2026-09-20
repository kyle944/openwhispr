const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

async function createManager(t) {
  const settingsKey = "__perAppTargetSettings";
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-per-app-target-test-",
    settingsKey,
    settings: {},
    mockModules: {
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.${settingsKey};
        export const getEffectiveCleanupModel = () => null;
        export const selectResolvedLLMConfig = () => ({ model: null, provider: null });
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
        export const useSettingsStore = { subscribe: () => () => {} };
      `,
    },
  });
  return createManager({ dictationTargetApp: null });
}

test("target app remains the press-time snapshot when focus later drifts", async (t) => {
  const manager = await createManager(t);
  manager.setDictationTargetApp({ bundleId: "com.apple.TextEdit", appName: "TextEdit" });

  // Focus moving elsewhere is deliberately not an input to the manager. The
  // target snapshot captured before ASR remains stable through cleanup.
  const laterFrontmostApp = { bundleId: "com.apple.Mail", appName: "Mail" };
  assert.notDeepEqual(manager.dictationTargetApp, laterFrontmostApp);
  assert.deepEqual(manager.dictationTargetApp, {
    bundleId: "com.apple.TextEdit",
    appName: "TextEdit",
  });
});

test("each new session replaces the old target, including an absent capture", async (t) => {
  const manager = await createManager(t);
  manager.setDictationTargetApp({ bundleId: "com.apple.TextEdit", appName: "TextEdit" });
  manager.setDictationTargetApp({ bundleId: "com.apple.Mail", appName: "Mail" });
  assert.deepEqual(manager.dictationTargetApp, {
    bundleId: "com.apple.Mail",
    appName: "Mail",
  });

  manager.setDictationTargetApp(null);
  assert.equal(manager.dictationTargetApp, null);
});
