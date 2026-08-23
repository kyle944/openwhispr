const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  authorizeManagedTranscriptionStart,
} = require("../../src/helpers/managedTranscriptionAuthorization");
const { createEnterpriseIdentityManager } = require("../../src/helpers/enterpriseIdentityManager");

const managedContext = {
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 7,
  configGeneration: 11,
  managed: true,
  provider: "whisper",
  model: "small",
};

const managedConfig = {
  success: true,
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 7,
  config: {
    workspaceId: "workspace-a",
    generation: 11,
    localModels: {
      transcription: [{ provider: "whisper", modelId: "small" }],
      reasoning: [],
    },
  },
};

function createManager({
  authenticated = true,
  authGeneration = 7,
  activeIdentity = {
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
  },
  config = managedConfig,
} = {}) {
  return {
    getAuthState: () => ({ authenticated, authGeneration }),
    getActiveIdentity: () => activeIdentity,
    getConfig: async () => config,
  };
}

const authorize = (overrides = {}) =>
  authorizeManagedTranscriptionStart({
    context: managedContext,
    route: { provider: "whisper", model: "small" },
    enterpriseIdentityManager: createManager(),
    ...overrides,
  });

test("guest transcription allows an exact unmanaged route", async () => {
  const context = {
    accountId: null,
    workspaceId: null,
    authGeneration: null,
    configGeneration: null,
    managed: false,
    provider: "self-hosted",
    model: "whisper-large-v3",
  };

  assert.deepEqual(
    await authorize({
      context,
      route: { provider: "self-hosted", model: "whisper-large-v3" },
      enterpriseIdentityManager: createManager({ authenticated: false, authGeneration: null }),
    }),
    { managed: false, binding: context }
  );
});

test("definitively unmanaged signed-in transcription allows an exact personal route", async () => {
  const context = {
    ...managedContext,
    configGeneration: null,
    managed: false,
    provider: "openai",
    model: "gpt-4o-mini-transcribe",
  };

  assert.deepEqual(
    await authorize({
      context,
      route: { provider: "openai", model: "gpt-4o-mini-transcribe" },
      enterpriseIdentityManager: createManager({
        config: {
          success: false,
          accountId: "account-a",
          workspaceId: "workspace-a",
          authGeneration: 7,
          code: "ENTERPRISE_REQUIRED",
          enforcementRequired: false,
        },
      }),
    }),
    { managed: false, binding: context }
  );
});

test("identity and generation freshness claims must match main-owned state", async (t) => {
  const cases = [
    { name: "missing account", context: { ...managedContext, accountId: null } },
    { name: "missing active identity", activeIdentity: null },
    {
      name: "stale active workspace",
      activeIdentity: {
        accountId: "account-a",
        workspaceId: "workspace-b",
        authGeneration: 7,
      },
    },
    { name: "stale account", config: { ...managedConfig, accountId: "account-b" } },
    { name: "stale workspace", config: { ...managedConfig, workspaceId: "workspace-b" } },
    { name: "missing auth generation", context: { ...managedContext, authGeneration: null } },
    { name: "stale auth generation", authGeneration: 8 },
    { name: "missing config generation", context: { ...managedContext, configGeneration: null } },
    {
      name: "stale config generation",
      config: {
        ...managedConfig,
        config: { ...managedConfig.config, generation: 12 },
      },
    },
    { name: "route provider mismatch", route: { provider: "nvidia", model: "small" } },
    { name: "route model mismatch", route: { provider: "whisper", model: "medium" } },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assert.rejects(
        authorize({
          context: testCase.context ?? managedContext,
          route: testCase.route ?? { provider: "whisper", model: "small" },
          enterpriseIdentityManager: createManager({
            authGeneration: testCase.authGeneration ?? 7,
            activeIdentity: testCase.activeIdentity,
            config: testCase.config ?? managedConfig,
          }),
        }),
        { code: "AUTHORIZATION_BOUNDARY_CHANGED" }
      );
    });
  }
});

test("signed-in transcription without an active workspace remains recoverable", async () => {
  await assert.rejects(
    authorize({
      context: {
        ...managedContext,
        workspaceId: null,
        configGeneration: null,
        managed: false,
      },
    }),
    { code: "MANAGED_WORKSPACE_REQUIRED" }
  );
});

test("unknown managed configuration fails closed", async (t) => {
  for (const config of [
    null,
    {
      success: false,
      accountId: "account-a",
      workspaceId: "workspace-a",
      authGeneration: 7,
      code: "MANAGED_CONFIG_UNAVAILABLE",
    },
  ]) {
    await t.test(config === null ? "missing result" : "failed result", async () => {
      await assert.rejects(authorize({ enterpriseIdentityManager: createManager({ config }) }), {
        code: "MANAGED_CONFIG_UNAVAILABLE",
      });
    });
  }
});

test("managed local transcription requires the exact main-approved provider and model", async (t) => {
  const cases = [
    {
      name: "cloud route",
      context: {
        ...managedContext,
        managed: false,
        provider: "openai",
        model: "gpt-4o-mini-transcribe",
      },
      route: { provider: "openai", model: "gpt-4o-mini-transcribe" },
    },
    {
      name: "unapproved local provider",
      context: { ...managedContext, provider: "nvidia", model: "small" },
      route: { provider: "nvidia", model: "small" },
    },
    {
      name: "unapproved local model",
      context: { ...managedContext, model: "medium" },
      route: { provider: "whisper", model: "medium" },
    },
    {
      name: "renderer unmanaged claim",
      context: { ...managedContext, managed: false },
      route: { provider: "whisper", model: "small" },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assert.rejects(authorize({ context: testCase.context, route: testCase.route }), {
        code: "MANAGED_MODEL_REQUIRED",
      });
    });
  }
});

test("managed local transcription accepts the exact main-approved route", async () => {
  assert.deepEqual(await authorize(), { managed: true, binding: managedContext });
});

test("a transient refresh preserves a definitive unmanaged workspace verdict", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-admission-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let requestCount = 0;
  const manager = createEnterpriseIdentityManager({
    cachePath: path.join(tempDir, "config.json"),
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(
          JSON.stringify({
            error: "An Enterprise workspace is required",
            code: "ENTERPRISE_REQUIRED",
          }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error("offline");
    },
    tokenStore: { getState: () => ({ token: "session", generation: 7 }) },
  });
  const request = {
    accountId: "account-a",
    workspaceId: "workspace-a",
    expectedAuthGeneration: 7,
    authHeaders: { Authorization: "Bearer session" },
  };

  const definitive = await manager.getConfig(request);
  const transient = await manager.getConfig({ ...request, forceRefresh: true });

  assert.equal(definitive.enforcementRequired, false);
  assert.equal(transient.enforcementRequired, false);
});
