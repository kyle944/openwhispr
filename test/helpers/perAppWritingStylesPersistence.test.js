const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("per-app styles persist locally and normalize cross-window updates", async (t) => {
  let storageListener;
  let dictionary = ["OpenWhispr"];
  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      customDictionary: JSON.stringify(dictionary),
      perAppWritingStyles: JSON.stringify([
        {
          bundleId: "com.apple.TextEdit",
          appName: "TextEdit",
          cleanupOutputMode: "invalid",
          cleanupTone: "formal",
        },
      ]),
    },
    window: {
      electronAPI: {
        getDictionary: async () => dictionary,
        setDictionary: async (words) => {
          dictionary = [...words];
          return { success: true };
        },
      },
      addEventListener(type, listener) {
        if (type === "storage") storageListener = listener;
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-per-app-writing-store-test-",
  });
  const { initializeSettings, useSettingsStore } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  await initializeSettings();

  assert.deepEqual(useSettingsStore.getState().perAppWritingStyles, [
    {
      bundleId: "com.apple.TextEdit",
      appName: "TextEdit",
      cleanupOutputMode: null,
      cleanupTone: "formal",
    },
  ]);

  useSettingsStore.getState().rememberDictationTargetApp({
    bundleId: "com.apple.Mail",
    appName: "Mail",
  });
  useSettingsStore.getState().setPerAppWritingStyle("com.apple.Mail", {
    cleanupOutputMode: "email",
    cleanupTone: "casual",
  });
  const persisted = JSON.parse(storage.getItem("perAppWritingStyles"));
  assert.equal(persisted[1].bundleId, "com.apple.Mail");
  assert.equal(persisted[1].cleanupOutputMode, "email");
  assert.equal(persisted[1].cleanupTone, "casual");

  assert.ok(storageListener);
  const incoming = JSON.stringify([
    {
      bundleId: "com.apple.Notes",
      appName: "Notes",
      cleanupOutputMode: "notes-to-dos",
      cleanupTone: "invalid",
      title: "must not persist",
    },
  ]);
  storage.setItem("perAppWritingStyles", incoming);
  storageListener({ key: "perAppWritingStyles", newValue: incoming, storageArea: storage });
  assert.deepEqual(useSettingsStore.getState().perAppWritingStyles, [
    {
      bundleId: "com.apple.Notes",
      appName: "Notes",
      cleanupOutputMode: "notes-to-dos",
      cleanupTone: null,
    },
  ]);
});
