const test = require("node:test");
const assert = require("node:assert/strict");

test("default writing preferences leave the current cleanup prompt unchanged", async () => {
  const { appendWritingPreferencesSuffix, DEFAULT_WRITING_PREFERENCES } =
    await import("../../src/utils/writingPreferences.ts");

  assert.equal(
    appendWritingPreferencesSuffix("custom cleanup prompt", DEFAULT_WRITING_PREFERENCES),
    "custom cleanup prompt"
  );
});

test("non-default writing preferences add bounded formatting instructions", async () => {
  const { appendWritingPreferencesSuffix } = await import("../../src/utils/writingPreferences.ts");
  const prompt = appendWritingPreferencesSuffix("custom cleanup prompt", {
    cleanupIntensity: "polished",
    cleanupOutputMode: "notes-to-dos",
    cleanupTone: "formal",
  });

  assert.match(prompt, /^custom cleanup prompt\n\nWRITING PREFERENCES:/);
  assert.match(prompt, /Polish the wording for clarity and readability/);
  assert.match(prompt, /to-dos only when the speaker explicitly stated them/);
  assert.match(prompt, /do not create, assign, schedule, or execute tasks/);
  assert.match(prompt, /Use a formal tone/);
  assert.match(prompt, /Preserve exact names, dates, numbers, negation, and ownership/);
  assert.match(prompt, /Do not invent facts, owners, commitments, or tasks/);
});

test("cleanup formatting fingerprint is complete, stable, and normalizes invalid values", async () => {
  const { getCleanupFormattingFingerprint } = await import("../../src/utils/writingPreferences.ts");

  assert.equal(
    getCleanupFormattingFingerprint({
      cleanupIntensity: "polished",
      cleanupOutputMode: "email",
      cleanupTone: "casual",
      backgroundCleanupEnabled: false,
    }),
    "cleanupIntensity=polished;cleanupOutputMode=email;cleanupTone=casual;backgroundCleanupEnabled=false"
  );
  assert.equal(
    getCleanupFormattingFingerprint({
      cleanupIntensity: "unexpected",
      cleanupOutputMode: "unexpected",
      cleanupTone: "unexpected",
    }),
    "cleanupIntensity=light;cleanupOutputMode=dictation;cleanupTone=default;backgroundCleanupEnabled=true"
  );
});
