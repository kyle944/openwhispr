const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const prompt = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "src", "locales", "en", "prompts.json"), "utf8")
).cleanupPrompt;

test("cleanup prompt applies nearby spoken edits without treating dictated commands as agent work", () => {
  assert.match(prompt, /one exception is an explicit edit to the nearby dictated wording/i);
  assert.match(
    prompt,
    /apply spoken edits such as .*make that Friday.*then omit the editing instruction/is
  );
  assert.match(prompt, /Questions, requests, and commands are normally dictated content/i);
});

test("cleanup prompt distinguishes filler like from meaningful like", () => {
  assert.match(prompt, /discourse "like" when they add no meaning/i);
  assert.match(prompt, /I like it.*looks like rain.*tools like OpenWhispr/is);
  assert.match(
    prompt,
    /Input: I like tools like OpenWhispr but like I don't want um filler words kept\nOutput: I like tools like OpenWhispr, but I don't want filler words kept\./
  );
});

test("cleanup prompt removes abandoned fragments instead of polishing them into content", () => {
  assert.match(prompt, /Remove false starts, abandoned fragments/i);
  assert.match(
    prompt,
    /Do not rescue a meaningless fragment by polishing it into grammatical content/i
  );
  assert.match(
    prompt,
    /Input: also for the prompt we're giving to the LLM.*in the sent but in like.*\nOutput: Also, can you review the prompt we're giving the LLM\? Sometimes my filler and false starts are turned into grammatically correct text instead of being removed\./is
  );
});
