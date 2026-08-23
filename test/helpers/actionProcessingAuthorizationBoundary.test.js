const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for background action");
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function loadActionStore(t, processText, onTagOwners) {
  installBrowserGlobals(t);
  globalThis.__actionProcessText = processText;
  globalThis.__actionAuthorizationCallbacks = new Set();
  globalThis.__actionTagOwners = onTagOwners;
  t.after(() => {
    delete globalThis.__actionProcessText;
    delete globalThis.__actionAuthorizationCallbacks;
    delete globalThis.__actionTagOwners;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-action-authorization-test-",
    mockModules: {
      "/services/ReasoningService": `
        export default { processText: (...args) => globalThis.__actionProcessText(...args) };
      `,
      "/stores/settingsStore": `
        export const getSettings = () => ({
          uiLanguage: 'en', customDictionary: '', noteFormattingDisableThinking: false,
          autoGenerateNoteTitle: true,
        });
        export const selectResolvedNoteFormatting = () => ({ mode: 'providers' });
      `,
      "/config/prompts": "export const appendDictionarySuffix = (prompt) => prompt;",
      "/helpers/noteFormattingOverrides": "export const buildNoteFormattingOverrides = () => ({});",
      "/utils/mentionMarkdown": `
        export const tagActionItemOwners = (content) => {
          globalThis.__actionTagOwners?.();
          return content;
        };
      `,
      "/helpers/runtimeAuthorizationBoundary": `
        export const isRuntimeAuthorizationError = (error) =>
          error?.name === 'AbortError' || error?.code === 'AUTHORIZATION_BOUNDARY_CHANGED';
        export const captureRuntimeAuthorizationLease = (_domain, onChanged) => {
          let current = true;
          const callback = () => {
            if (!current) return;
            current = false;
            onChanged();
          };
          globalThis.__actionAuthorizationCallbacks.add(callback);
          return {
            isCurrent: () => current,
            assertCurrent() {
              if (!current) throw Object.assign(new Error('Authorization changed'), {
                name: 'AbortError', code: 'AUTHORIZATION_BOUNDARY_CHANGED',
              });
            },
            dispose() { globalThis.__actionAuthorizationCallbacks.delete(callback); },
          };
        };
      `,
    },
  });
  return vite.ssrLoadModule("/stores/actionProcessingStore.ts");
}

function invalidateAuthorization() {
  for (const callback of [...globalThis.__actionAuthorizationCallbacks]) callback();
}

function runAction(runBackgroundAction, options = {}) {
  runBackgroundAction(
    1,
    "raw note",
    "note-hash",
    { name: "Enhance", prompt: "Summarize this note" },
    { isCloudMode: true, modelId: "model", allowTitleGeneration: true, ...options },
    { noModel: "No model", noEndpoint: "No endpoint", actionFailed: "Action failed" }
  );
}

test("authorization changes after enhancement prevent title generation and persistence", async (t) => {
  const calls = [];
  const updates = [];
  const { runBackgroundAction } = await loadActionStore(t, async (...args) => {
    calls.push(args);
    invalidateAuthorization();
    return "enhanced note";
  });
  globalThis.window.electronAPI.updateNote = async (...args) => updates.push(args);

  runAction(runBackgroundAction);
  await settle();

  assert.equal(calls.length, 1);
  assert.deepEqual(updates, []);
});

test("authorization changes immediately before updateNote prevent persistence", async (t) => {
  const calls = [];
  const updates = [];
  const { runBackgroundAction } = await loadActionStore(
    t,
    async (...args) => {
      calls.push(args);
      return calls.length === 1 ? "enhanced note" : "Generated title";
    },
    invalidateAuthorization
  );
  globalThis.window.electronAPI.updateNote = async (...args) => updates.push(args);

  runAction(runBackgroundAction, { knownPeople: [{ id: 1, name: "Ada" }] });
  await settle();

  assert.equal(calls.length, 2);
  assert.deepEqual(updates, []);
});

test("an authorization abort from title generation prevents persistence", async (t) => {
  const calls = [];
  const updates = [];
  const { runBackgroundAction } = await loadActionStore(t, async (...args) => {
    calls.push(args);
    if (calls.length === 1) return "enhanced note";
    throw Object.assign(new Error("Authorization changed"), {
      name: "AbortError",
      code: "AUTHORIZATION_BOUNDARY_CHANGED",
    });
  });
  globalThis.window.electronAPI.updateNote = async (...args) => updates.push(args);

  runAction(runBackgroundAction);
  await settle();

  assert.equal(calls.length, 2);
  assert.deepEqual(updates, []);
});

test("an ordinary title failure preserves the enhanced note", async (t) => {
  const calls = [];
  const updates = [];
  const { runBackgroundAction } = await loadActionStore(t, async (...args) => {
    calls.push(args);
    if (calls.length === 1) return "enhanced note";
    throw new Error("Title provider unavailable");
  });
  globalThis.window.electronAPI.updateNote = async (...args) => updates.push(args);

  runAction(runBackgroundAction);
  await waitFor(() => updates.length === 1);

  assert.deepEqual(updates, [
    [
      1,
      {
        enhanced_content: "enhanced note",
        enhancement_prompt: "Summarize this note",
        enhanced_at_content_hash: "note-hash",
      },
    ],
  ]);
});

test("an old operation settling cannot clear or error its replacement", async (t) => {
  const calls = [];
  const updates = [];
  let resolveFirst;
  let resolveSecond;
  const { cancelAction, runBackgroundAction, selectNoteActionState, useActionProcessingStore } =
    await loadActionStore(t, () => {
      calls.push([]);
      return new Promise((resolve) => {
        if (calls.length === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    });
  globalThis.window.electronAPI.updateNote = async (...args) => updates.push(args);

  runAction(runBackgroundAction, { allowTitleGeneration: false });
  await waitFor(() => calls.length === 1);
  cancelAction(1);
  runAction(runBackgroundAction, { allowTitleGeneration: false });
  await waitFor(() => calls.length === 2);

  resolveFirst("first enhancement");
  await settle();
  assert.deepEqual(selectNoteActionState(useActionProcessingStore.getState(), 1), {
    status: "processing",
    actionName: "Enhance",
  });
  assert.deepEqual(useActionProcessingStore.getState().errorEvents, []);

  resolveSecond("second enhancement");
  await waitFor(() => updates.length === 1);
  assert.equal(updates[0][1].enhanced_content, "second enhancement");
});
