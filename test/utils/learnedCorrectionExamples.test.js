const test = require("node:test");
const assert = require("node:assert/strict");

test("learned correction examples are deduplicated, bounded and appended to cleanup", async () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    const learned = await import("../../src/utils/learnedCorrectionExamples.ts");
    learned.rememberLearnedCorrectionExample({ before: "hello kyle", after: "Hello Kyle." });
    learned.rememberLearnedCorrectionExample({ before: "hello kyle", after: "Hello Kyle." });

    assert.deepEqual(learned.readLearnedCorrectionExamples(), [
      { before: "hello kyle", after: "Hello Kyle." },
    ]);
    assert.match(learned.appendLearnedCorrectionExamples("Base prompt"), /Infer the recurring/);
    assert.match(learned.appendLearnedCorrectionExamples("Base prompt"), /Hello Kyle/);
  } finally {
    delete globalThis.localStorage;
  }
});
