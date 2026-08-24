const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/voicePillPresentation.js");

test("streaming transcript rewrites do not request native-window layout changes", async () => {
  const { resolveLiveTranscriptLayout } = await load();
  const provisional = resolveLiveTranscriptLayout({
    phase: "live",
    text: "I will be talking and then the recognizer may change these words",
  });

  assert.deepEqual(provisional, {
    measurementText: "",
    measurementRevision: null,
  });
});

test("the final transcript requests one measured readable layout", async () => {
  const { resolveLiveTranscriptLayout } = await load();
  const finalText = "The finished transcript stays visible and readable.";

  assert.deepEqual(resolveLiveTranscriptLayout({ phase: "final", text: finalText }), {
    measurementText: finalText,
    measurementRevision: finalText,
  });
});

test("a long provisional transcript becomes a bounded rolling caption", async () => {
  const { resolveLiveTranscriptVisibleText } = await load();
  const text =
    "This opening context is already settled, while the newest words remain useful to someone watching the live caption as they speak.";
  const visible = resolveLiveTranscriptVisibleText({ phase: "live", text, maxCharacters: 72 });

  assert.ok(visible.startsWith("…"));
  assert.ok(visible.length <= 72);
  assert.ok(text.endsWith(visible.slice(1)));
  assert.equal(resolveLiveTranscriptVisibleText({ phase: "final", text }), text);
});

test("live words hug the active edge while final text remains readable", async () => {
  const { resolveLiveTranscriptTextAlignment } = await load();

  assert.equal(resolveLiveTranscriptTextAlignment("listening"), "right");
  assert.equal(resolveLiveTranscriptTextAlignment("live"), "right");
  assert.equal(resolveLiveTranscriptTextAlignment("cleanup"), "right");
  assert.equal(resolveLiveTranscriptTextAlignment("final"), "left");
});
