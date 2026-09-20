export type HistoryDateFilter = "all" | "today" | "last7Days" | "last30Days";

function toDbTimestamp(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

/** Build half-open local-date ranges for SQLite's UTC timestamp strings. */
export function getHistoryDateBounds(filter: HistoryDateFilter, now = new Date()) {
  if (filter === "all") return {};

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(startOfToday);
  end.setDate(end.getDate() + 1);
  if (filter === "today") return { start: toDbTimestamp(startOfToday), end: toDbTimestamp(end) };

  // setDate follows local calendar days, including 23- and 25-hour DST days.
  const days = filter === "last7Days" ? 7 : 30;
  const start = new Date(startOfToday);
  start.setDate(start.getDate() - (days - 1));
  return { start: toDbTimestamp(start), end: toDbTimestamp(end) };
}

export function countHistoryWords(text: string | null | undefined): number {
  return text?.match(/[^\s]+/gu)?.length ?? 0;
}
