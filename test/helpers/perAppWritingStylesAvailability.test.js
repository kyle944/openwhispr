const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const MANAGED_MODEL = "anthropic.claude-sonnet-4-20250514-v1:0";

const enterpriseOnlyPolicy = {
  version: 1,
  transcription: {
    allowedModes: ["local"],
    allowedByokProviders: [],
  },
  llm: {
    allowedModes: ["enterprise"],
    allowedByokProviders: [],
    allowedEnterpriseProviders: ["bedrock"],
  },
  features: { agentEnabled: true, webSearchEnabled: true },
  sharing: { externalLinkSharing: "allowed" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: true,
  },
  minAppVersion: null,
};

function managedBedrockConfig() {
  return {
    workspaceId: "workspace-a",
    version: 1,
    generation: 1,
    identity: {
      issuer: "https://api.example.com/enterprise-identity",
      jwksUri: "https://api.example.com/enterprise-identity/jwks.json",
      subject: "workspace:workspace-a",
      audiences: { bedrock: "sts.amazonaws.com", azure: "api://AzureADTokenExchange" },
    },
    providers: [
      {
        provider: "bedrock",
        mode: "managed_required",
        allowManualSetup: false,
        config: {
          roleArn: "arn:aws:iam::123456789012:role/OpenWhispr",
          region: "us-east-1",
          allowedModels: [MANAGED_MODEL],
          scopeDefaults: { dictationCleanup: MANAGED_MODEL },
        },
        version: 1,
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    ],
  };
}

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

test("mounted per-app availability reacts to policy and managed-identity transitions", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {
    initialStorage: {
      enterpriseSetupMode: "auto",
      cleanupMode: "local",
      cleanupProvider: "local",
      cleanupModel: "local-model",
    },
    window: { electronAPI: { getPlatform: () => "darwin" } },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-per-app-style-availability-test-",
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { usePerAppWritingStylesSurface } = await vite.ssrLoadModule(
    "/hooks/usePerAppWritingStylesSurface.ts"
  );

  let surface;
  function Harness() {
    surface = usePerAppWritingStylesSurface();
    return null;
  }

  await React.act(async () => {
    root = createRoot(container);
    root.render(React.createElement(Harness));
  });
  assert.equal(surface, "available");

  await React.act(async () => {
    usePolicyStore.setState({
      status: "managed",
      managed: true,
      policy: enterpriseOnlyPolicy,
      appVersion: "1.8.1",
    });
  });
  assert.equal(surface, "unavailable");

  await React.act(async () => {
    usePolicyStore.setState({
      status: "unmanaged",
      managed: false,
      policy: null,
      appVersion: "1.8.1",
    });
  });
  assert.equal(surface, "available", "policy removal restores the stored local preference");

  await React.act(async () => {
    useEnterpriseIdentityStore.setState({
      status: "ready",
      config: managedBedrockConfig(),
      error: null,
      failClosed: false,
    });
  });
  assert.equal(surface, "unavailable");

  await React.act(async () => {
    useEnterpriseIdentityStore.setState({ status: "idle", config: null });
  });
  assert.equal(surface, "available", "managed identity removal restores local availability");
});

test("per-app styles are hidden outside macOS", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-per-app-style-platform-test-",
  });
  const { resolvePerAppWritingStylesSurface } = await vite.ssrLoadModule(
    "/utils/perAppWritingStyles.ts"
  );

  assert.equal(resolvePerAppWritingStylesSurface("win32", "local"), "hidden");
  assert.equal(resolvePerAppWritingStylesSurface("linux", "local"), "hidden");
  assert.equal(resolvePerAppWritingStylesSurface("darwin", "local"), "available");
});
