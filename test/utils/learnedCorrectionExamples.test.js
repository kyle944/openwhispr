const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractCorrectionExample,
  extractCorrections,
} = require("../../src/utils/correctionLearner.js");

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

test("legacy examples containing only added surrounding prose are ignored", async () => {
  const values = new Map([
    [
      "learnedCorrectionExamples",
      JSON.stringify([
        {
          before: "Please review the launch timing.",
          after: "Existing draft. Please review the launch timing. Add a separate task.",
        },
        { before: "hello kyle", after: "Hello Kyle." },
      ]),
    ],
  ]);
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    const learned = await import(
      `../../src/utils/learnedCorrectionExamples.ts?legacy-filter=${Date.now()}`
    );
    assert.deepEqual(learned.readLearnedCorrectionExamples(), [
      { before: "hello kyle", after: "Hello Kyle." },
    ]);
    assert.doesNotMatch(learned.appendLearnedCorrectionExamples("Base prompt"), /separate task/);
  } finally {
    delete globalThis.localStorage;
  }
});

test("a tracked word edit yields both a dictionary candidate and an exact cleanup example", async () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    const learned = await import(
      `../../src/utils/learnedCorrectionExamples.ts?edit-pipeline=${Date.now()}`
    );
    const original = "Please ask Shunade about the launch.";
    const initialFieldValue = `${original} `;
    const newFieldValue = "Please ask Sinead about the launch. ";

    assert.deepEqual(extractCorrections(original, newFieldValue, [], initialFieldValue), [
      "Sinead",
    ]);
    learned.rememberLearnedCorrectionExample(
      extractCorrectionExample(original, newFieldValue, initialFieldValue)
    );

    const prompt = learned.appendLearnedCorrectionExamples("Base cleanup prompt");
    assert.match(prompt, /Pasted: "Please ask Shunade about the launch\."/);
    assert.match(prompt, /User changed it to: "Please ask Sinead about the launch\."/);
  } finally {
    delete globalThis.localStorage;
  }
});
