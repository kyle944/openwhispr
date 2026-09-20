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

test("preserves SRT cue bounds and does not infer colon-prefixed speakers", async () => {
  const { parseTranscriptImport } = await load();
  const parsed = parseTranscriptImport("meeting.srt", fixture("meeting.srt"));

  assert.deepEqual(parsed.segments, [
    {
      text: "Note: Welcome everyone.",
      timestamp: 12.25,
      cueStart: 12.25,
      cueEnd: 14.75,
      importedCue: true,
    },
    {
      text: "Bob: Thanks, Alice.",
      timestamp: 18.5,
      cueStart: 18.5,
      cueEnd: 22.125,
      importedCue: true,
    },
  ]);
});

test("accepts legal VTT headers and recognizes explicit voice tags with classes or no end tag", async () => {
  const { parseTranscriptImport } = await load();
  const parsed = parseTranscriptImport("caption.vtt", fixture("caption.vtt"));

  assert.deepEqual(parsed.segments, [
    {
      text: "The demo is ready.",
      timestamp: 1.25,
      cueStart: 1.25,
      cueEnd: 3,
      importedCue: true,
      speakerName: "Jordan",
    },
    {
      text: "Note: Yes, let's start.",
      timestamp: 3,
      cueStart: 3,
      cueEnd: 5.5,
      importedCue: true,
    },
  ]);
});

test("imports only a complete app Markdown export as labelled cues", async () => {
  const { parseTranscriptImport } = await load();
  const parsed = parseTranscriptImport("export.md", fixture("export.md"));

  assert.equal(parsed.title, "Project review");
  assert.deepEqual(parsed.segments, [
    { text: "The release is ready.", timestamp: 2, speakerName: "Morgan" },
    { text: "I will verify the export.", timestamp: 6, speakerName: "Riley" },
  ]);
});

test("keeps generic Markdown whole when a partial export-like line appears", async () => {
  const { parseTranscriptImport } = await load();
  const source = "Meeting notes\n\n**Ari** `00:00:01`\nA draft cue, not an export.";
  const parsed = parseTranscriptImport("notes.md", source);

  assert.deepEqual(parsed.segments, [{ text: source, timestamp: 0 }]);
  assert.equal(parsed.text, source);
});

test("imports documented JSON units and preserves explicit speaker labels", async () => {
  const { parseTranscriptImport } = await load();
  const parsed = parseTranscriptImport("export.json", fixture("export.json"));
  assert.equal(parsed.title, "Planning session");
  assert.deepEqual(parsed.segments, [
    { text: "Let's begin.", timestamp: 0, speakerName: "Ari" },
    { text: "The schedule is confirmed.", timestamp: 4.25, speakerName: "Bea" },
  ]);

  const epochSeconds = parseTranscriptImport(
    "epoch-seconds.json",
    JSON.stringify({
      metadata: { timestamp_unit: "epoch_seconds" },
      segments: [
        { timestamp: 1_730_000_000, text: "One" },
        { timestamp: 1_730_000_002.5, text: "Two" },
      ],
    })
  );
  assert.deepEqual(
    epochSeconds.segments.map((segment) => segment.timestamp),
    [0, 2.5]
  );

  const epochMilliseconds = parseTranscriptImport(
    "epoch-milliseconds.json",
    JSON.stringify({
      timestamp_unit: "epoch_milliseconds",
      segments: [
        { timestamp: 1_730_000_000_000, text: "One" },
        { timestamp: 1_730_000_002_500, text: "Two" },
      ],
    })
  );
  assert.deepEqual(
    epochMilliseconds.segments.map((segment) => segment.timestamp),
    [0, 2.5]
  );

  const relativeArray = parseTranscriptImport(
    "relative-array.json",
    JSON.stringify([
      { timestamp: 0, text: "One" },
      { timestamp: 4.25, text: "Two" },
    ])
  );
  assert.deepEqual(
    relativeArray.segments.map((segment) => segment.timestamp),
    [0, 4.25]
  );

  const storedEpochMilliseconds = parseTranscriptImport(
    "stored.json",
    JSON.stringify([
      { timestamp: 1_730_000_000_000, text: "One" },
      { timestamp: 1_730_000_002_500, text: "Two" },
    ])
  );
  assert.deepEqual(
    storedEpochMilliseconds.segments.map((segment) => segment.timestamp),
    [0, 2.5]
  );

  const relative = parseTranscriptImport(
    "relative.json",
    JSON.stringify({
      segments: [
        { timestamp: 12.25, text: "One" },
        { timestamp: 16, text: "Two" },
      ],
    })
  );
  assert.deepEqual(
    relative.segments.map((segment) => segment.timestamp),
    [12.25, 16]
  );
});

test("rejects ambiguous or mixed-scale JSON timestamps", async () => {
  const { TranscriptImportError, parseTranscriptImport } = await load();
  for (const source of [
    JSON.stringify({ segments: [{ timestamp: 1_730_000_000, text: "ambiguous" }] }),
    JSON.stringify({
      metadata: { timestamp_unit: "epoch_seconds" },
      segments: [
        { timestamp: 10, text: "relative" },
        { timestamp: 1_730_000_000, text: "epoch" },
      ],
    }),
    JSON.stringify([{ timestamp: 1_730_000_000, text: "ambiguous array" }]),
  ]) {
    assert.throws(
      () => parseTranscriptImport("ambiguous.json", source),
      (error) => error instanceof TranscriptImportError && error.code === "malformed"
    );
  }
});

test("rejects malformed, empty, unsupported, and oversized transcript files", async () => {
  const { MAX_TRANSCRIPT_IMPORT_BYTES, TranscriptImportError, parseTranscriptImport } =
    await load();
  assert.throws(
    () => parseTranscriptImport("malformed.srt", fixture("malformed.srt")),
    (error) => error instanceof TranscriptImportError && error.code === "malformed"
  );
  assert.throws(
    () =>
      parseTranscriptImport("zero.srt", "1\n00:00:01,000 --> 00:00:01,000\nA zero-duration cue."),
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

test("an imported SRT exports its exact starts, ends, gaps, and source text", async () => {
  const { parseTranscriptImport, serializeImportedTranscript } = await load();
  const { formatSrt } = require("../../src/helpers/transcriptFormatter");
  const parsed = parseTranscriptImport("meeting.srt", fixture("meeting.srt"));
  const stored = JSON.parse(serializeImportedTranscript(parsed.segments, 1_700_000_000_000));

  assert.equal(
    formatSrt(stored, {}),
    "1\n00:00:12,250 --> 00:00:14,750\nNote: Welcome everyone.\n\n2\n00:00:18,500 --> 00:00:22,125\nBob: Thanks, Alice.\n"
  );
});

test("non-export Markdown clocks preserve all prose", async () => {
  const { parseTranscriptImport } = await load();
  for (const clock of ["01:23", "00:01:23.500"]) {
    const source =
      "# Meeting notes\n\n**Date:** September 20, 2026\n\n---\n\n**Budget** `" +
      clock +
      "`\nOrdinary prose.";
    assert.equal(parseTranscriptImport("notes.md", source).text, source);
  }
});

test("JSON rejects contradictory declarations and wrong timestamp scales", async () => {
  const { parseTranscriptImport } = await load();
  const cases = [
    { timestamp_unit: "epoch_seconds", segments: [{ timestamp: 1730000000000, text: "One" }] },
    {
      timestamp_unit: "seconds",
      segments: [
        { timestamp: 1, text: "One" },
        { timestamp: 1730000000, text: "Two" },
      ],
    },
    {
      timestamp_unit: "seconds",
      metadata: { timestamp_unit: "epoch_seconds" },
      segments: [{ timestamp: 1730000000, text: "One" }],
    },
    { timestamp_unit: "toString", segments: [{ timestamp: 1, text: "One" }] },
  ];
  for (const source of cases) {
    assert.throws(() => parseTranscriptImport("notes.json", JSON.stringify(source)));
  }
  const valid = {
    timestamp_unit: "seconds",
    metadata: { timestamp_unit: "relative_seconds" },
    segments: [{ timestamp: 1, text: "One" }],
  };
  assert.equal(parseTranscriptImport("notes.json", JSON.stringify(valid)).segments[0].timestamp, 1);
});
