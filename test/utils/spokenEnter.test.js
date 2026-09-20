const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applySpokenEnterDirective,
  decideSpokenEnter,
  extractTerminalSpokenEnter,
} = require("../../src/utils/spokenEnter.ts");

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
  assert.deepEqual(extractTerminalSpokenEnter("Send Bob's update, press Enter"), {
    text: "Send Bob's update",
    submit: true,
  });
  assert.deepEqual(extractTerminalSpokenEnter("Send James' update, press Enter"), {
    text: "Send James' update",
    submit: true,
  });
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

test("unreachable translation intent still fails closed when routing falls back to skip", () => {
  const text = "Translate this, press Enter";
  assert.deepEqual(
    decideSpokenEnter(text, {
      enabled: true,
      routeKind: "skip",
      translationRequested: true,
    }),
    { text, submit: false }
  );
});

test("only raw STT authorizes submission; cleanup or snippets cannot invent it", () => {
  const ordinary = { enabled: true, routeKind: "cleanup" };

  assert.deepEqual(
    applySpokenEnterDirective("Draft is ready", "Draft is ready, press Enter", ordinary),
    { text: "Draft is ready, press Enter", submit: false },
    "a cleanup model cannot invent an Enter command"
  );
  assert.deepEqual(
    applySpokenEnterDirective("Use my signoff", "Best regards, press Enter", ordinary),
    { text: "Best regards, press Enter", submit: false },
    "a snippet expansion cannot invent an Enter command"
  );
  assert.deepEqual(
    applySpokenEnterDirective(
      "Draft is ready, press Enter",
      "Draft is ready, press Enter",
      ordinary
    ),
    { text: "Draft is ready", submit: true }
  );
  assert.deepEqual(
    applySpokenEnterDirective(
      "Draft is ready, press Enter",
      'Draft is ready "press Enter"',
      ordinary
    ),
    { text: "Draft is ready", submit: true },
    "quoted cleanup output cannot leave command words in the paste"
  );
  assert.deepEqual(
    applySpokenEnterDirective("Draft is ready, press Enter", "press Enter", ordinary),
    { text: "", submit: false },
    "a cleanup result containing only the directive cannot submit"
  );
});

test("disabled auto-paste path retains the final directive", () => {
  const text = "Draft is ready, press Enter";
  assert.deepEqual(applySpokenEnterDirective(text, text, { enabled: false, routeKind: "skip" }), {
    text,
    submit: false,
  });
});
