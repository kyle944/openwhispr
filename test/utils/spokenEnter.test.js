const test = require("node:test");
const assert = require("node:assert/strict");

const { decideSpokenEnter, extractTerminalSpokenEnter } = require("../../src/utils/spokenEnter.ts");

test("terminal spoken Enter strips only the final directive from ordinary dictation", () => {
  assert.deepEqual(extractTerminalSpokenEnter("Draft is ready, press Enter."), {
    text: "Draft is ready",
    submit: true,
  });
  assert.deepEqual(extractTerminalSpokenEnter("First line\npress Enter"), {
    text: "First line",
    submit: true,
  });
});

test("spoken Enter remains text inside quotes, before the end, or without pasteable content", () => {
  for (const text of [
    'Write "press Enter"',
    "Say ‘press Enter’",
    "Mention press Enter in the instructions",
    "press Enter",
  ]) {
    assert.deepEqual(extractTerminalSpokenEnter(text), { text, submit: false });
  }
});

test("submission fails closed for agent, translation, selection, and cancelled final results", () => {
  const text = "Send this, press Enter";
  const ordinary = { enabled: true, routeKind: "skip" };
  assert.deepEqual(decideSpokenEnter(text, ordinary), { text: "Send this", submit: true });

  for (const context of [
    { ...ordinary, routeKind: "agent" },
    { ...ordinary, routeKind: "translation" },
    { ...ordinary, routeKind: "unknown" },
    { ...ordinary, selectionEdit: true },
    { ...ordinary, assistantConversation: true },
    { ...ordinary, cancelled: true },
  ]) {
    assert.deepEqual(decideSpokenEnter(text, context), { text, submit: false });
  }
});
