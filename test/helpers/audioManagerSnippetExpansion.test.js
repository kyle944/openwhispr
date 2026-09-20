const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

async function loadSnippetManager(t, snippets) {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-audio-snippet-expansion-test-",
    settingsKey: "__audioSnippetExpansionSettings",
    settings: { snippets },
  });
  return createManager({
    voiceAgentRequested: false,
    translationRequested: false,
    finalizeChineseScript: async (text) => text,
  });
}

test("ordinary dictation expands snippets after cleanup finalization", async (t) => {
  const manager = await loadSnippetManager(t, [
    { trigger: "my signoff", replacement: "Best regards,\nKyle" },
  ]);
  manager.processTranscriptionCore = async (_text, _source, _wasCancelled, onRouteResolved) => {
    onRouteResolved("cleanup");
    return "Clean draft. my signoff";
  };

  assert.equal(
    await manager.processTranscription("raw transcript", "test"),
    "Clean draft. Best regards,\nKyle"
  );
});

test("agent and selection-edit routes preserve exact model text", async (t) => {
  const manager = await loadSnippetManager(t, [
    { trigger: "my signoff", replacement: "Best regards,\nKyle" },
  ]);
  manager.processTranscriptionCore = async (_text, _source, _wasCancelled, onRouteResolved) => {
    onRouteResolved("agent");
    return "Replace the selection with my signoff";
  };

  assert.equal(
    await manager.processTranscription("edit command", "test"),
    "Replace the selection with my signoff"
  );
});

test("explicit assistant dictation preserves snippet triggers even if routing falls back", async (t) => {
  const manager = await loadSnippetManager(t, [
    { trigger: "my signoff", replacement: "Best regards,\nKyle" },
  ]);
  manager.voiceAgentRequested = true;
  manager.processTranscriptionCore = async (_text, _source, _wasCancelled, onRouteResolved) => {
    onRouteResolved("skip");
    return "Use my signoff in a poem";
  };

  assert.equal(
    await manager.processTranscription("assistant command", "test"),
    "Use my signoff in a poem"
  );
});

test("audio finalization performs one non-recursive snippet pass", async (t) => {
  const manager = await loadSnippetManager(t, [
    { trigger: "first", replacement: "second" },
    { trigger: "second", replacement: "expanded twice" },
  ]);
  manager.processTranscriptionCore = async (_text, _source, _wasCancelled, onRouteResolved) => {
    onRouteResolved("skip");
    return "first";
  };

  assert.equal(await manager.processTranscription("first", "test"), "second");
});
