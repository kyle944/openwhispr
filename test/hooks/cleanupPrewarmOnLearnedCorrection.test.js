const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The cleanup system prompt ends with the LEARNED CORRECTIONS block, which lives in
// localStorage rather than the settings store. Learning one therefore rewrites the tail
// of the prompt llama.cpp has cached, and the edit that teaches a correction is exactly
// the thing that would otherwise make the next dictation the slow one.

const STORE_MOCK = `
  const respond = (key) =>
    typeof key === "string" && (key.startsWith("set") || key.startsWith("update") || key.startsWith("apply"))
      ? () => {}
      : undefined;
  const proxy = new Proxy(globalThis.__prewarmSettings, {
    get: (target, key) => (key in target ? target[key] : respond(key)),
  });
  export const useSettingsStore = Object.assign(() => proxy, { getState: () => proxy });
  export const initializeSettings = async () => {};
`;

const POLICY_MOCK = `
  const state = { policy: null };
  export const usePolicyStore = Object.assign(
    (selector) => (typeof selector === "function" ? selector(state) : state),
    { getState: () => state }
  );
`;

async function mountProvider(t, { cachePrefix }) {
  // Registered before installBrowserGlobals so the unmount runs while window still
  // exists — react-dom reads it on the way down.
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  let learnedListener = null;
  const prewarms = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        prewarmLocalCleanup: async (payload) => {
          prewarms.push(payload);
          return { success: true };
        },
        onCorrectionExampleLearned: (listener) => {
          learnedListener = listener;
          return () => {
            learnedListener = null;
          };
        },
      },
    },
  });
  globalThis.__prewarmSettings = {
    useCleanupModel: true,
    cleanupMode: "local",
    cleanupModel: "qwen3.5-4b-q4_k_m",
    cleanupDisableThinking: true,
    customDictionary: ["OpenWhispr"],
    snippets: [],
    preferredLanguage: "en",
    uiLanguage: "en",
    customPrompts: {},
  };
  t.after(() => {
    delete globalThis.__prewarmSettings;
  });

  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix,
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
      "/stores/settingsStore": STORE_MOCK,
      "/stores/policyStore": POLICY_MOCK,
    },
  });
  const { SettingsProvider } = await vite.ssrLoadModule("/hooks/useSettings.ts");

  await React.act(async () => {
    root = createRoot(container);
    root.render(React.createElement(SettingsProvider, null, null));
  });

  return { prewarms, learn: (example) => learnedListener?.(example) };
}

test("learning a correction re-warms the cleanup prompt it just changed", async (t) => {
  const { prewarms, learn } = await mountProvider(t, {
    cachePrefix: "openwhispr-prewarm-learned-test-",
  });

  assert.equal(prewarms.length, 1, "the prompt is warmed once at startup");
  const startupPrompt = prewarms[0].systemPrompt;

  await React.act(async () => {
    learn({ before: "Open whisper", after: "OpenWhispr" });
  });

  assert.equal(prewarms.length, 2, "a learned correction must re-warm the prompt");
  assert.notEqual(
    prewarms[1].systemPrompt,
    startupPrompt,
    "the prompt really did change, so the cached prefix really was stale"
  );
  assert.match(prewarms[1].systemPrompt, /LEARNED CORRECTIONS/);
});

test("a correction that changes nothing does not spend a re-warm", async (t) => {
  const { prewarms, learn } = await mountProvider(t, {
    cachePrefix: "openwhispr-prewarm-learned-dupe-test-",
  });
  assert.equal(prewarms.length, 1);

  await React.act(async () => {
    learn({ before: "Open whisper", after: "OpenWhispr" });
  });
  assert.equal(prewarms.length, 2);

  await React.act(async () => {
    learn({ before: "Open whisper", after: "OpenWhispr" });
  });
  assert.equal(prewarms.length, 2, "the same correction leaves the prompt alone");

  await React.act(async () => {
    learn({ before: "no after", after: "" });
  });
  assert.equal(prewarms.length, 2, "a rejected example leaves the prompt alone");
});
