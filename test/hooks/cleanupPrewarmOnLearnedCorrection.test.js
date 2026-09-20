const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const STORE_MOCK = `
  const respond = (key) =>
    typeof key === "string" && (key.startsWith("set") || key.startsWith("update") || key.startsWith("apply"))
      ? () => {}
      : undefined;
  const proxy = new Proxy(globalThis.__prewarmSettings, {
    get: (target, key) => (key in target ? target[key] : respond(key)),
  });
  export const useSettingsStore = Object.assign(() => proxy, { getState: () => proxy });
  export const getSettings = () => proxy;
  export const initializeSettings = async () => {};
`;

const POLICY_MOCK = `
  const state = { policy: null };
  export const usePolicyStore = Object.assign(
    (selector) => (typeof selector === "function" ? selector(state) : state),
    { getState: () => state }
  );
`;

function installHookDom(t) {
  const originalDocument = globalThis.document;
  const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const noop = () => {};

  class Element {}
  class HTMLElement extends Element {}
  class HTMLIFrameElement extends HTMLElement {}

  const document = {
    nodeType: 9,
    activeElement: null,
    addEventListener: noop,
    removeEventListener: noop,
  };
  const container = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener: noop,
    removeEventListener: noop,
    appendChild: noop,
    removeChild: noop,
    insertBefore: noop,
  };
  Object.assign(globalThis.window, {
    Element,
    HTMLElement,
    HTMLIFrameElement,
    document,
    getSelection: () => null,
  });
  document.defaultView = globalThis.window;
  document.documentElement = container;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = noop;

  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  return container;
}

async function mountProvider(t, cachePrefix, settings = {}) {
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
    cleanupIntensity: "light",
    cleanupOutputMode: "dictation",
    cleanupTone: "default",
    backgroundCleanupEnabled: true,
    ...settings,
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

test("learning a correction re-warms the exact cleanup prompt", async (t) => {
  const { prewarms, learn } = await mountProvider(t, "openwhispr-prewarm-learned-test-");
  assert.equal(prewarms.length, 1, "the cleanup prompt warms at startup");
  const startupPrompt = prewarms[0].systemPrompt;

  await React.act(async () => {
    learn({ before: "Open whisper", after: "OpenWhispr" });
  });

  assert.equal(prewarms.length, 2, "a learned correction re-warms its changed prompt");
  assert.notEqual(prewarms[1].systemPrompt, startupPrompt);
  assert.match(prewarms[1].systemPrompt, /LEARNED CORRECTIONS/);
});

test("duplicate or rejected corrections do not re-warm an unchanged prompt", async (t) => {
  const { prewarms, learn } = await mountProvider(t, "openwhispr-prewarm-learned-dupe-test-");

  await React.act(async () => {
    learn({ before: "Open whisper", after: "OpenWhispr" });
  });
  assert.equal(prewarms.length, 2);

  await React.act(async () => {
    learn({ before: "Open whisper", after: "OpenWhispr" });
    learn({ before: "missing", after: "" });
  });
  assert.equal(prewarms.length, 2, "only a real prompt change spends a warmup");
});

test("disabled background cleanup or no-cleanup mode does not consume a prompt prewarm", async (t) => {
  const disabledBackground = await mountProvider(t, "openwhispr-prewarm-disabled-background-", {
    backgroundCleanupEnabled: false,
  });
  assert.equal(disabledBackground.prewarms.length, 0);

  const noCleanup = await mountProvider(t, "openwhispr-prewarm-disabled-cleanup-", {
    cleanupIntensity: "none",
  });
  assert.equal(noCleanup.prewarms.length, 0);
});
