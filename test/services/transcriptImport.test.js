const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import("../../src/services/transcriptImport.ts");
const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, "../fixtures/transcript-import", name), "utf8");

test("imports TXT as a single unlabelled local transcript", async () => {
  const { parseTranscriptImport } = await load();
  const parsed = parseTranscriptImport("plain.txt", fixture("plain.txt"));

  assert.equal(parsed.format, "txt");
  assert.deepEqual(parsed.segments, [
    { text: "Plain local transcript.\nIt has no supplied speaker labels.", timestamp: 0 },
  ]);
});

test("preserves supplied SRT speakers and normalizes cue timestamps", async () => {
  const { parseTranscriptImport } = await load();
  const parsed = parseTranscriptImport("meeting.srt", fixture("meeting.srt"));

  assert.deepEqual(parsed.segments, [
    { text: "Welcome everyone.", timestamp: 0, speakerName: "Alice" },
    { text: "Thanks, Alice.", timestamp: 2.5, speakerName: "Bob" },
  ]);
});

test("imports VTT cue identifiers and leaves absent speaker labels absent", async () => {
  const { parseTranscriptImport } = await load();
  const parsed = parseTranscriptImport("caption.vtt", fixture("caption.vtt"));

  assert.deepEqual(parsed.segments, [
    { text: "The demo is ready.", timestamp: 1.25, speakerName: "Jordan" },
    { text: "Yes, let's start.", timestamp: 3 },
  ]);
});

test("imports the app's Markdown transcript export without inventing speakers", async () => {
  const { parseTranscriptImport } = await load();
  const parsed = parseTranscriptImport("export.md", fixture("export.md"));

  assert.equal(parsed.title, "Project review");
  assert.deepEqual(parsed.segments, [
    { text: "The release is ready.", timestamp: 2, speakerName: "Morgan" },
    { text: "I will verify the export.", timestamp: 6, speakerName: "Riley" },
  ]);
});

test("imports the documented JSON export shape and preserves speaker labels", async () => {
  const { parseTranscriptImport } = await load();
  const parsed = parseTranscriptImport("export.json", fixture("export.json"));

  assert.equal(parsed.title, "Planning session");
  assert.deepEqual(parsed.segments, [
    { text: "Let's begin.", timestamp: 0, speakerName: "Ari" },
    { text: "The schedule is confirmed.", timestamp: 4.25, speakerName: "Bea" },
  ]);
});

test("rejects malformed, empty, unsupported, and oversized transcript files", async () => {
  const { MAX_TRANSCRIPT_IMPORT_BYTES, TranscriptImportError, parseTranscriptImport } =
    await load();

  assert.throws(
    () => parseTranscriptImport("malformed.srt", fixture("malformed.srt")),
    (error) => error instanceof TranscriptImportError && error.code === "malformed"
  );
  assert.throws(
    () => parseTranscriptImport("empty.txt", " \n "),
    (error) => error instanceof TranscriptImportError && error.code === "empty"
  );
  assert.throws(
    () => parseTranscriptImport("notes.docx", "content"),
    (error) => error instanceof TranscriptImportError && error.code === "unsupported"
  );
  assert.throws(
    () => parseTranscriptImport("missing-segments.json", '{"metadata":{"title":"No segments"}}'),
    (error) => error instanceof TranscriptImportError && error.code === "malformed"
  );
  assert.throws(
    () => parseTranscriptImport("large.txt", "x".repeat(MAX_TRANSCRIPT_IMPORT_BYTES + 1)),
    (error) => error instanceof TranscriptImportError && error.code === "tooLarge"
  );
});

test("the fingerprint is stable across byte-order marks and line endings", async () => {
  const { transcriptImportFingerprint } = await load();

  assert.equal(
    await transcriptImportFingerprint("\uFEFFAlice: hello\r\nBob: hi\r\n"),
    await transcriptImportFingerprint("Alice: hello\nBob: hi\n")
  );
});

test("duplicate matching uses the durable import source metadata", async () => {
  const { findImportedTranscriptNote, transcriptImportSource } = await load();
  const fingerprint = "a".repeat(64);
  const existing = { id: 8, source_file: transcriptImportSource("meeting.srt", fingerprint) };

  assert.equal(
    findImportedTranscriptNote([{ id: 7, source_file: null }, existing], fingerprint),
    existing
  );
  assert.equal(findImportedTranscriptNote([existing], "b".repeat(64)), undefined);
});

test("an imported SRT exports with its original cue starts and speaker labels", async () => {
  const { parseTranscriptImport, serializeImportedTranscript } = await load();
  const { formatSrt } = require("../../src/helpers/transcriptFormatter");
  const parsed = parseTranscriptImport("meeting.srt", fixture("meeting.srt"));
  const stored = JSON.parse(serializeImportedTranscript(parsed.segments, 1_700_000_000_000));

  const srt = formatSrt(stored, {});
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,500\nAlice: Welcome everyone\./);
  assert.match(srt, /\n2\n00:00:02,500 --> 00:00:05,500\nBob: Thanks, Alice\./);
});
