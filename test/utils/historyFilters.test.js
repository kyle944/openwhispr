const test = require("node:test");
const assert = require("node:assert/strict");

// Date construction must use a non-UTC zone to exercise local calendar and DST behavior.
process.env.TZ = "America/Chicago";

test("history date filters use local calendar midnights and word counts ignore extra whitespace", async () => {
  const { countHistoryWords, getHistoryDateBounds } =
    await import("../../src/utils/historyFilters.ts");
  const now = new Date("2026-01-15T18:30:00.000Z");

  assert.deepEqual(getHistoryDateBounds("all", now), {});
  assert.deepEqual(getHistoryDateBounds("today", now), {
    start: "2026-01-15 06:00:00",
    end: "2026-01-16 06:00:00",
  });
  assert.deepEqual(getHistoryDateBounds("last7Days", now), {
    start: "2026-01-09 06:00:00",
    end: "2026-01-16 06:00:00",
  });
  assert.deepEqual(getHistoryDateBounds("last30Days", now), {
    start: "2025-12-17 06:00:00",
    end: "2026-01-16 06:00:00",
  });
  const afterSpringForward = new Date("2026-03-09T12:00:00-05:00");
  assert.deepEqual(getHistoryDateBounds("last7Days", afterSpringForward), {
    start: "2026-03-03 06:00:00",
    end: "2026-03-10 05:00:00",
  });
  assert.equal(countHistoryWords("  one\n two\tthree  "), 3);
  assert.equal(countHistoryWords(""), 0);
});
