const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("local cleanup uses zero temperature without changing agent requests", async (t) => {
  const originalWindow = globalThis.window;
  const requests = [];
  globalThis.window = {
    electronAPI: {
      processLocalReasoning: async (text, model, agentName, config) => {
        requests.push({ text, model, agentName, config });
        return { success: true, text: "result" };
      },
    },
  };

  const { createServer } = await import("vite");
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-local-cleanup-test-"));
  const vite = await createServer({
    root: path.resolve(__dirname, "../../src"),
    cacheDir,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true },
    plugins: [
      {
        name: "local-cleanup-dependencies",
        enforce: "pre",
        resolveId(source) {
          if (source.endsWith("/config/prompts")) return "\0local-cleanup-prompts";
          if (source.endsWith("/utils/logger")) return "\0local-cleanup-logger";
          return null;
        },
        load(id) {
          if (id === "\0local-cleanup-prompts") {
            return `export function wrapCleanupTranscript(text) { return \`<transcript>\\n\${text}\\n</transcript>\`; }`;
          }
          if (id === "\0local-cleanup-logger") {
            return "export default { logReasoning() {} };";
          }
          return null;
        },
      },
    ],
    server: { middlewareMode: true },
  });

  t.after(async () => {
    await vite.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  const { localProvider } = await vite.ssrLoadModule("/services/ai/inferenceProviders/local.ts");
  const context = {
    getSystemPrompt: () => "cleanup prompt",
  };

  await localProvider.call({
    text: "You cracy",
    model: "qwen",
    agentName: null,
    config: {},
    ctx: context,
  });
  await localProvider.call({
    text: "Do the task",
    model: "qwen",
    agentName: "Assistant",
    config: { systemPrompt: "agent prompt" },
    ctx: context,
  });
  await localProvider.call({
    text: "Keep my override",
    model: "qwen",
    agentName: null,
    config: { temperature: 0.2 },
    ctx: context,
  });

  assert.equal(requests[0].config.temperature, 0);
  assert.equal(requests[0].config.systemPrompt, "cleanup prompt");
  assert.match(requests[0].text, /<transcript>\nYou cracy\n<\/transcript>/);
  assert.equal("temperature" in requests[1].config, false);
  assert.equal(requests[1].config.systemPrompt, "agent prompt");
  assert.equal(requests[1].text, "Do the task");
  assert.equal(requests[2].config.temperature, 0.2);
});
