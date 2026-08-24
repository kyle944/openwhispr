const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/voicePillPresentation.js");

test("streaming transcript can grow through a bounded measurement caption", async () => {
  const { resolveLiveTranscriptLayout } = await load();
  const provisional = resolveLiveTranscriptLayout({
    phase: "live",
    text: "I will be talking and then the recognizer may change these words",
  });

  assert.deepEqual(provisional, {
    measurementText: "I will be talking and then the recognizer may change these words",
    measurementRevision: null,
  });
});

test("streaming measurement stays bounded while preserving the newest words", async () => {
  const { resolveLiveTranscriptLayout } = await load();
  const text = Array.from({ length: 80 }, (_, index) => `word${index}`).join(" ");
  const provisional = resolveLiveTranscriptLayout({ phase: "live", text });

  assert.ok(provisional.measurementText.startsWith("…"));
  assert.ok(provisional.measurementText.length <= 260);
  assert.ok(text.endsWith(provisional.measurementText.slice(1)));
  assert.equal(provisional.measurementRevision, null);
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

test("live and final words keep one calm reading edge", async () => {
  const { resolveLiveTranscriptTextAlignment } = await load();

  assert.equal(resolveLiveTranscriptTextAlignment("listening"), "left");
  assert.equal(resolveLiveTranscriptTextAlignment("live"), "left");
  assert.equal(resolveLiveTranscriptTextAlignment("cleanup"), "left");
  assert.equal(resolveLiveTranscriptTextAlignment("final"), "left");
});
