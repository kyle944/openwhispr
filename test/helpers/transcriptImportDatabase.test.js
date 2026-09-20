const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db.js");

const source = "transcript-import:v1:" + "a".repeat(64) + ":meeting.srt";
const input = {
  title: "Imported meeting",
  content: "Note: hello",
  sourceFile: source,
  transcript: JSON.stringify([{ text: "Note: hello", timestamp: 1_700_000_000_000 }]),
};

test("transcript import writes content and transcript atomically and deduplicates repeats", (t) => {
  const db = createDb(t);
  if (!db) return;
  const first = db.saveTranscriptImportNote(input);
  const repeat = db.saveTranscriptImportNote({
    ...input,
    sourceFile: source.replace("meeting.srt", "renamed.srt"),
    content: "different",
    transcript: "[]",
  });

  assert.equal(first.success, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.note.content, input.content);
  assert.equal(first.note.transcript, input.transcript);
  assert.equal(repeat.success, true);
  assert.equal(repeat.duplicate, true);
  assert.equal(repeat.note.id, first.note.id);
  assert.equal(repeat.note.folder_id, first.note.folder_id);
  assert.equal(repeat.note.space_id, first.note.space_id);
  const matchingNotes = db.db
    .prepare("SELECT COUNT(*) AS count FROM notes WHERE source_file LIKE ?")
    .get("transcript-import:v1:" + "a".repeat(64) + ":%");
  assert.equal(matchingNotes.count, 1);
});

test("a database failure rolls back an import without reserving its fingerprint", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.db.exec(`
    CREATE TRIGGER reject_transcript_import
    BEFORE INSERT ON notes
    WHEN NEW.source_file = '${source}'
    BEGIN SELECT RAISE(ABORT, 'forced import failure'); END;
  `);

  assert.throws(() => db.saveTranscriptImportNote(input), /forced import failure/);
  const matchingNotes = db.db
    .prepare("SELECT COUNT(*) AS count FROM notes WHERE source_file LIKE ?")
    .get("transcript-import:v1:" + "a".repeat(64) + ":%");
  assert.equal(matchingNotes.count, 0);
});
