const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("chat prompt reports local runtime without inventing GPT-4 hosting", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-runtime-prompt-test-",
  });
  const { getAgentSystemPrompt } = await vite.ssrLoadModule("/config/prompts.ts");

  const prompt = getAgentSystemPrompt(undefined, undefined, {
    mode: "local",
    provider: "qwen",
    model: "qwen3.5-4b-q4_k_m",
  });

  assert.match(prompt, /running locally on this device/i);
  assert.match(prompt, /qwen3\.5-4b-q4_k_m/i);
  assert.match(prompt, /Do not claim to be GPT-4 or hosted by OpenAI/i);
});
