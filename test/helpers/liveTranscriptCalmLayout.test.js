const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/voicePillPresentation.js");

test("streaming transcript grows through the complete accumulated text", async () => {
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

test("streaming measurement keeps earlier words until the screen-height cap scrolls them", async () => {
  const { resolveLiveTranscriptLayout } = await load();
  const text = Array.from({ length: 80 }, (_, index) => `word${index}`).join(" ");
  const provisional = resolveLiveTranscriptLayout({ phase: "live", text });

  assert.equal(provisional.measurementText, text);
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

test("a long provisional transcript keeps its full visible history", async () => {
  const { resolveLiveTranscriptVisibleText } = await load();
  const text =
    "This opening context is already settled, while the newest words remain useful to someone watching the live caption as they speak.";
  const visible = resolveLiveTranscriptVisibleText({ text });

  assert.equal(visible, text);
  assert.equal(resolveLiveTranscriptVisibleText({ text }), text);
});

test("live and final words keep one calm reading edge", async () => {
  const { resolveLiveTranscriptTextAlignment } = await load();

  assert.equal(resolveLiveTranscriptTextAlignment("listening"), "left");
  assert.equal(resolveLiveTranscriptTextAlignment("live"), "left");
  assert.equal(resolveLiveTranscriptTextAlignment("cleanup"), "left");
  assert.equal(resolveLiveTranscriptTextAlignment("final"), "left");
});
