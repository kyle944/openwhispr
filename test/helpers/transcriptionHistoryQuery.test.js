const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db.js");

function setTimestamp(db, id, timestamp) {
  db.db.prepare("UPDATE transcriptions SET timestamp = ? WHERE id = ?").run(timestamp, id);
}

test("history query searches all retained text, paginates, and reports full local totals", (t) => {
  const db = createDb(t);
  if (!db) return;

  const first = db.saveTranscription("Visible needle", "raw one");
  const second = db.saveTranscription("Plain output", "Needle in raw text");
  const discarded = db.saveTranscription("Discarded needle", null, { status: "discarded" });
  setTimestamp(db, first.id, "2026-01-03 12:00:00");
  setTimestamp(db, second.id, "2026-01-02 12:00:00");
  setTimestamp(db, discarded.id, "2026-01-04 12:00:00");

  const page = db.getTranscriptionHistoryPage({ query: "needle", limit: 1, offset: 0 });
  assert.equal(page.totalEntries, 2);
  assert.equal(page.totalWords, 4);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, first.id);

  const next = db.getTranscriptionHistoryPage({ query: "needle", limit: 1, offset: 1 });
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0].id, second.id);

  const exported = db.getTranscriptionHistoryForExport({ query: "needle" });
  assert.deepEqual(
    exported.map((entry) => entry.id),
    [first.id, second.id]
  );

  const earlierTie = db.saveTranscription("Tie needle one");
  const laterTie = db.saveTranscription("Tie needle two");
  setTimestamp(db, earlierTie.id, "2026-01-05 12:00:00");
  setTimestamp(db, laterTie.id, "2026-01-05 12:00:00");
  const ties = db.getTranscriptionHistoryPage({ query: "tie needle" });
  assert.deepEqual(
    ties.items.map((entry) => entry.id),
    [laterTie.id, earlierTie.id]
  );
});

test("history query treats LIKE wildcards literally and applies half-open date filters", (t) => {
  const db = createDb(t);
  if (!db) return;

  const percent = db.saveTranscription("100% approved");
  const wildcard = db.saveTranscription("100x approved");
  const januarySecond = db.saveTranscription("Date match");
  setTimestamp(db, percent.id, "2026-01-01 12:00:00");
  setTimestamp(db, wildcard.id, "2026-01-01 12:00:01");
  setTimestamp(db, januarySecond.id, "2026-01-02 12:00:00");

  const literal = db.getTranscriptionHistoryPage({ query: "100%" });
  assert.deepEqual(
    literal.items.map((entry) => entry.id),
    [percent.id]
  );

  const dateFiltered = db.getTranscriptionHistoryPage({
    start: "2026-01-02 00:00:00",
    end: "2026-01-03 00:00:00",
  });
  assert.deepEqual(
    dateFiltered.items.map((entry) => entry.id),
    [januarySecond.id]
  );
});
