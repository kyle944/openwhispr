const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractCorrectionExample,
  extractCorrections,
} = require("../../src/utils/correctionLearner.js");

test("null or empty inputs yield no corrections", () => {
  assert.deepEqual(extractCorrections(null, "hello", []), []);
  assert.deepEqual(extractCorrections("hello", null, []), []);
  assert.deepEqual(extractCorrections("", "hello", []), []);
  assert.deepEqual(extractCorrections("hello", "", []), []);
});

test("identical texts yield no corrections", () => {
  assert.deepEqual(extractCorrections("hello world", "hello world", []), []);
});

test("a phonetic mishearing fixed by the user is learned", () => {
  // "Shunade" is a plausible transcription mishearing of "Sinead"
  const result = extractCorrections("Hey Shunade how are you", "Hey Sinead how are you", []);
  assert.ok(result.includes("Sinead"));
});

test("corrections already in the dictionary are not re-learned, case-insensitively", () => {
  const original = "Hey Shunade how are you";
  const edited = "Hey Sinead how are you";

  assert.ok(!extractCorrections(original, edited, ["Sinead"]).includes("Sinead"));
  assert.ok(!extractCorrections(original, edited, ["sinead"]).includes("Sinead"));
});

test("a wholesale rewrite is not mistaken for corrections", () => {
  const result = extractCorrections("the cat sat on the mat", "a dog stood under a rug", []);
  assert.deepEqual(result, []);
});

test("very short replacements are ignored — two-letter words are edits, not vocabulary", () => {
  const result = extractCorrections("I went to see XX today", "I went to see Al today", []);
  assert.ok(!result.includes("Al"));
});

test("unrelated word swaps are filtered by edit distance — cat to elephant is a rewrite, not a mishearing", () => {
  const result = extractCorrections("I saw a cat yesterday", "I saw a elephant yesterday", []);
  assert.ok(!result.includes("elephant"));
});

test("a non-array dictionary is tolerated", () => {
  const result = extractCorrections("Hey Shunade", "Hey Sinead", null);
  assert.ok(result.includes("Sinead"));
});

test("the same correction appearing twice is only learned once", () => {
  const result = extractCorrections("Shunade said hi to Shunade", "Sinead said hi to Sinead", []);
  const sinead = result.filter((w) => w.toLowerCase() === "sinead");
  assert.ok(sinead.length <= 1);
});

test("a punctuation or style edit becomes a bounded reusable example", () => {
  assert.deepEqual(
    extractCorrectionExample(
      "Can you send this to Kyle please?",
      "Can you send this to Kyle, please?"
    ),
    {
      before: "Can you send this to Kyle please?",
      after: "Can you send this to Kyle, please?",
    }
  );
});

test("whitespace-only edits and wholesale rewrites do not become preferences", () => {
  assert.equal(extractCorrectionExample("Keep this sentence.", "  Keep this sentence.  "), null);
  assert.equal(
    extractCorrectionExample("The cat sat on the mat.", "A dog sprinted through the park."),
    null
  );
});

test("a word edit is learned only from the tracked pasted span", () => {
  const original = "Please ask Shunade about the launch tomorrow.";
  const initial = `Existing draft. ${original} `;
  const edited = "Existing draft. Please ask Sinead about the launch tomorrow. ";

  assert.deepEqual(extractCorrections(original, edited, [], initial), ["Sinead"]);
  assert.deepEqual(extractCorrectionExample(original, edited, initial), {
    before: original,
    after: "Please ask Sinead about the launch tomorrow.",
  });
});

test("typing adjacent prose after a paste is not learned", () => {
  const original = "Please review the launch timing and list the major improvements you can find.";
  const initial = `Existing draft. ${original} `;
  const appended = `${initial}Also inspect the unrelated follow-up`;

  assert.deepEqual(extractCorrections(original, appended, [], initial), []);
  assert.equal(extractCorrectionExample(original, appended, initial), null);
});

test("a word edit mixed with appended prose fails closed", () => {
  const original = "Please ask Open whisper about the launch tomorrow.";
  const initial = `${original} `;
  const editedAndAppended = "Please ask OpenWhispr about the launch tomorrow. Add a new task";

  assert.deepEqual(extractCorrections(original, editedAndAppended, [], initial), []);
  assert.equal(extractCorrectionExample(original, editedAndAppended, initial), null);
});

test("an internal word split remains a learnable correction example", () => {
  const original = "Meet Newyork tomorrow.";
  const initial = `${original} `;
  const edited = "Meet New York tomorrow. ";

  assert.deepEqual(extractCorrectionExample(original, edited, initial), {
    before: original,
    after: "Meet New York tomorrow.",
  });
});

test("a repeated final word can be corrected without looking like an append", () => {
  const original = "Call John and thank John.";
  const initial = `${original} `;
  const edited = "Call John and thank Jon. ";

  assert.deepEqual(extractCorrections(original, edited, [], initial), ["Jon"]);
  assert.deepEqual(extractCorrectionExample(original, edited, initial), {
    before: original,
    after: "Call John and thank Jon.",
  });
});
