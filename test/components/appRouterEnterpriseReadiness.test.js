const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { findElement, installInteractiveDom } = require("../lib/interactiveDom");

const emptyComponent = `
  import React from "react";
  export default function Empty() { return null; }
`;

function appRouterMocks() {
  return {
    "/App.jsx": emptyComponent,
    "/AuthenticationStep.tsx": emptyComponent,
    "/MeetingNotificationOverlay.tsx": emptyComponent,
    "/UpdateNotificationOverlay.tsx": emptyComponent,
    "/WindowControls.tsx": emptyComponent,
    "/onboarding/BackgroundModelDownloadTray.tsx": emptyComponent,
    "/onboarding/ManagedEnterpriseModelCoordinator.tsx": emptyComponent,
    "/ControlPanel.tsx": `
      import React from "react";
      export default function ControlPanel() {
        return React.createElement("div", { "data-testid": "control-panel" });
      }
    `,
    "/OnboardingFlow.tsx": emptyComponent,
    "/ui/card.tsx": `
      import React from "react";
      export function Card({ children }) { return React.createElement("div", null, children); }
      export function CardContent({ children }) { return React.createElement("div", null, children); }
    `,
    "/onboarding/flow": `
      export const LEGACY_ONBOARDING_STEP_KEY = "onboardingStep";
      export const ONBOARDING_SESSION_KEY = "onboardingSession";
    `,
    "/hooks/useAuth": `export function useAuth() { return globalThis.__routerAuth; }`,
    "/hooks/useTheme": `export function useTheme() {}`,
    "/stores/policyStore": `
      export function usePolicyStore(selector) { return selector(globalThis.__routerPolicy); }
    `,
    "/stores/enterpriseIdentityStore": `
      export function useEnterpriseIdentityStore(selector) {
        return selector(globalThis.__routerEnterprise);
      }
    `,
    "react-i18next": `export function useTranslation() { return { t(key) { return key; } }; }`,
  };
}

async function renderRouter(root, AppRouter) {
  await React.act(async () => {
    root.render(React.createElement(AppRouter));
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

test("AppRouter keeps workspace recovery renderable while enterprise readiness controls the onboarding gate", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__routerAuth;
    delete globalThis.__routerPolicy;
    delete globalThis.__routerEnterprise;
  });
  const onboardingActiveCalls = [];
  installBrowserGlobals(t, {
    initialStorage: { onboardingCompleted: "true" },
    window: {
      location: { search: "?panel=true" },
      electronAPI: { setOnboardingActive: async (active) => onboardingActiveCalls.push(active) },
    },
  });
  const container = installInteractiveDom(t);
  globalThis.__routerAuth = { isSignedIn: true, isGracePeriodOnly: false, isLoaded: true };
  globalThis.__routerPolicy = { status: "unmanaged" };
  globalThis.__routerEnterprise = { status: "idle", failClosed: false };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-app-router-enterprise-readiness-",
    noExternal: ["react-i18next"],
    mockModules: appRouterMocks(),
  });
  const { default: AppRouter } = await vite.ssrLoadModule("/AppRouter.jsx");
  root = createRoot(container);

  await renderRouter(root, AppRouter);
  await renderRouter(root, AppRouter);
  assert.ok(findElement(container, (element) => element.getAttribute("data-testid") === "control-panel"));
  assert.equal(onboardingActiveCalls.at(-1), true);

  globalThis.__routerEnterprise = { status: "error", failClosed: false };
  await renderRouter(root, AppRouter);
  assert.equal(onboardingActiveCalls.at(-1), false);

  globalThis.__routerEnterprise = { status: "loading", failClosed: true };
  await renderRouter(root, AppRouter);
  assert.equal(onboardingActiveCalls.at(-1), true);
});
