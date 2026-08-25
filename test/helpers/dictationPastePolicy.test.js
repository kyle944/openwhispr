const test = require("node:test");
const assert = require("node:assert/strict");

const { shouldRestoreClipboardAfterDictation } = require("../../src/helpers/dictationPastePolicy");

test("macOS keeps the transcript when no external paste target was verified", () => {
  assert.equal(
    shouldRestoreClipboardAfterDictation({
      platform: "darwin",
      targetActivated: false,
      requestedRestore: true,
    }),
    false
  );
});

test("a verified macOS target keeps the user's requested restore behavior", () => {
  assert.equal(
    shouldRestoreClipboardAfterDictation({
      platform: "darwin",
      targetActivated: true,
      requestedRestore: true,
    }),
    true
  );
  assert.equal(
    shouldRestoreClipboardAfterDictation({
      platform: "darwin",
      targetActivated: true,
      requestedRestore: false,
    }),
    false
  );
});

test("other platforms preserve the existing restore policy", () => {
  assert.equal(
    shouldRestoreClipboardAfterDictation({
      platform: "win32",
      targetActivated: false,
      requestedRestore: true,
    }),
    true
  );
});
