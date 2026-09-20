const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("writing preferences normalize startup values, persist selections, and accept storage updates", async (t) => {
  let storageListener;
  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      cleanupIntensity: "unexpected",
      cleanupOutputMode: "unexpected",
      cleanupTone: "unexpected",
    },
    window: {
      electronAPI: {
        getDictionary: async () => [],
        setDictionary: async () => ({ success: true }),
      },
      addEventListener(type, listener) {
        if (type === "storage") storageListener = listener;
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-writing-preferences-store-test-",
  });
  const { initializeSettings, useSettingsStore } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  await initializeSettings();
  const state = useSettingsStore.getState();

  assert.equal(state.cleanupIntensity, "light");
  assert.equal(state.cleanupOutputMode, "dictation");
  assert.equal(state.cleanupTone, "default");
  assert.equal(state.backgroundCleanupEnabled, true);

  state.setCleanupIntensity("polished");
  state.setCleanupOutputMode("email");
  state.setCleanupTone("formal");
  state.setBackgroundCleanupEnabled(false);

  assert.equal(storage.getItem("cleanupIntensity"), "polished");
  assert.equal(storage.getItem("cleanupOutputMode"), "email");
  assert.equal(storage.getItem("cleanupTone"), "formal");
  assert.equal(storage.getItem("backgroundCleanupEnabled"), "false");

  assert.ok(
    storageListener,
    "settings initialization registers a receiving-window storage listener"
  );
  const receiveStorageUpdate = (key, newValue) => {
    storage.setItem(key, newValue);
    storageListener({ key, newValue, storageArea: storage });
  };

  receiveStorageUpdate("cleanupIntensity", "invalid");
  receiveStorageUpdate("cleanupOutputMode", "notes-to-dos");
  receiveStorageUpdate("cleanupTone", "invalid");
  receiveStorageUpdate("backgroundCleanupEnabled", "true");

  assert.deepEqual(
    {
      cleanupIntensity: useSettingsStore.getState().cleanupIntensity,
      cleanupOutputMode: useSettingsStore.getState().cleanupOutputMode,
      cleanupTone: useSettingsStore.getState().cleanupTone,
      backgroundCleanupEnabled: useSettingsStore.getState().backgroundCleanupEnabled,
    },
    {
      cleanupIntensity: "light",
      cleanupOutputMode: "notes-to-dos",
      cleanupTone: "default",
      backgroundCleanupEnabled: true,
    }
  );
});

test("spoken Enter defaults off and normalizes a receiving-window update", async (t) => {
  let storageListener;
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { spokenEnterEnabled: "unexpected" },
    window: {
      electronAPI: {
        getDictionary: async () => [],
        setDictionary: async () => ({ success: true }),
      },
      addEventListener(type, listener) {
        if (type === "storage") storageListener = listener;
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-spoken-enter-store-test-",
  });
  const { initializeSettings, useSettingsStore } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  await initializeSettings();

  assert.equal(useSettingsStore.getState().spokenEnterEnabled, false);
  useSettingsStore.getState().setSpokenEnterEnabled(true);
  assert.equal(storage.getItem("spokenEnterEnabled"), "true");

  storage.setItem("spokenEnterEnabled", "false");
  storageListener({
    key: "spokenEnterEnabled",
    newValue: "false",
    storageArea: storage,
  });
  assert.equal(useSettingsStore.getState().spokenEnterEnabled, false);
});
