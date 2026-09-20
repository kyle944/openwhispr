export const MAX_TRANSCRIPT_IMPORT_BYTES = 10 * 1024 * 1024;

export type TranscriptImportFormat = "txt" | "md" | "srt" | "vtt" | "json";

export interface ImportedTranscriptSegment {
  text: string;
  /** Seconds from the beginning of the imported transcript. */
  timestamp: number;
  /** A label explicitly present in the source file. */
  speakerName?: string;
  /** Exact subtitle cue bounds, retained for lossless SRT export. */
  cueStart?: number;
  cueEnd?: number;
  importedCue?: true;
}

export interface ParsedTranscriptImport {
  format: TranscriptImportFormat;
  title?: string;
  text: string;
  segments: ImportedTranscriptSegment[];
}

export class TranscriptImportError extends Error {
  constructor(
    public readonly code: "unsupported" | "tooLarge" | "malformed" | "empty",
    message: string
  ) {
    super(message);
    this.name = "TranscriptImportError";
  }
}

export const TRANSCRIPT_IMPORT_SOURCE_PREFIX = "transcript-import:v1:";

type JsonTimestampUnit = "seconds" | "epoch_seconds" | "epoch_milliseconds";

function normalizedText(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function supportedFormat(fileName: string): TranscriptImportFormat {
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension === "txt" || extension === "md" || extension === "srt" || extension === "vtt") {
    return extension;
  }
  if (extension === "json") return "json";
  throw new TranscriptImportError(
    "unsupported",
    "Choose a TXT, Markdown, SRT, VTT, or JSON transcript."
  );
}

function requireText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TranscriptImportError("empty", "The transcript file is empty.");
  return trimmed;
}

function parseClock(value: string): number | null {
  const match = value.trim().match(/^(?:(\d{1,}):)?(\d{2}):(\d{2})(?:[,.](\d{1,3}))?$/);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number((match[4] ?? "").padEnd(3, "0") || 0);
  if (minutes > 59 || seconds > 59 || milliseconds > 999) return null;
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function requireAscendingTimestamps(
  segments: ImportedTranscriptSegment[]
): ImportedTranscriptSegment[] {
  for (let index = 1; index < segments.length; index++) {
    if (segments[index].timestamp < segments[index - 1].timestamp) {
      throw new TranscriptImportError(
        "malformed",
        "Transcript timestamps must be in chronological order."
      );
    }
  }
  return segments;
}

function vttVoice(text: string): Pick<ImportedTranscriptSegment, "text" | "speakerName"> {
  // WebVTT's <v Name> tag is the only inline speaker syntax we recognize.
  // Text such as "Note:" is content, not a guessed identity.
  const match = text.match(/^<v(?:\.[^\s>]+)*\s+([^>\n]+)>([\s\S]*?)(?:<\/v>)?$/i);
  if (!match || !match[1].trim() || !match[2].trim()) return { text: text.trim() };
  return { text: match[2].trim(), speakerName: match[1].trim() };
}

function isVttHeaderMetadata(lines: string[]): boolean {
  return lines.length > 0 && lines.every((line) => /^[A-Za-z-]+:\s+\S/.test(line));
}

function parseTimedCues(input: string, format: "srt" | "vtt"): ImportedTranscriptSegment[] {
  let body = requireText(input);
  if (format === "vtt") {
    if (!/^WEBVTT(?:\s|$)/i.test(body)) {
      throw new TranscriptImportError("malformed", "A VTT transcript must begin with WEBVTT.");
    }
    body = body.replace(/^WEBVTT[^\n]*(?:\n|$)/i, "").trim();
  }

  const segments: ImportedTranscriptSegment[] = [];
  let sawCue = false;
  for (const rawBlock of body.split(/\n{2,}/)) {
    const lines = rawBlock.split("\n").map((line) => line.trimEnd());
    const first = lines[0]?.trim() ?? "";
    if (
      format === "vtt" &&
      (/^(?:NOTE|STYLE|REGION)(?:\s|$)/i.test(first) || (!sawCue && isVttHeaderMetadata(lines)))
    ) {
      continue;
    }
    if (/^\d+$/.test(first)) lines.shift();
    let timing = lines.shift()?.trim();
    // VTT permits a non-numeric cue identifier before its timing line.
    if (format === "vtt" && timing && !timing.includes("-->")) timing = lines.shift()?.trim();
    const timingMatch = timing?.match(/^(.+?)\s+-->\s+([^\s]+)(?:\s+.*)?$/);
    if (!timingMatch) {
      throw new TranscriptImportError(
        "malformed",
        "A transcript cue is missing a valid time range."
      );
    }
    const timestamp = parseClock(timingMatch[1]);
    const end = parseClock(timingMatch[2]);
    const cueText = lines.join("\n").trim();
    if (timestamp == null || end == null || end <= timestamp || !cueText) {
      throw new TranscriptImportError("malformed", "A transcript cue has invalid timing or text.");
    }
    segments.push({
      timestamp,
      cueStart: timestamp,
      cueEnd: end,
      importedCue: true,
      ...(format === "vtt" ? vttVoice(cueText) : { text: cueText }),
    });
    sawCue = true;
  }
  if (!segments.length) throw new TranscriptImportError("empty", "The transcript has no cues.");
  return requireAscendingTimestamps(segments);
}

const MARKDOWN_EXPORT_SEGMENT_HEADER = /^\*\*([^*\n]+)\*\*\s+`(\d{2,}:\d{2}:\d{2})`\s*$/;

function parseMarkdown(input: string): Pick<ParsedTranscriptImport, "title" | "text" | "segments"> {
  const text = requireText(input);
  const generic = {
    title: text.match(/^#\s+(.+)$/m)?.[1]?.trim() || undefined,
    text,
    segments: [{ text, timestamp: 0 }],
  };
  const lines = text.split("\n");
  if (
    lines.length < 7 ||
    !/^#\s+\S/.test(lines[0]) ||
    lines[1] !== "" ||
    !/^\*\*Date:\*\*\s+\S/.test(lines[2])
  ) {
    return generic;
  }

  let index = 3;
  if (/^\*\*[^*\n]+:\*\*\s+\S/.test(lines[index] ?? "")) index++;
  if (lines[index] !== "" || lines[index + 1] !== "---" || lines[index + 2] !== "") return generic;
  index += 3;

  const segments: ImportedTranscriptSegment[] = [];
  while (index < lines.length) {
    const header = lines[index]?.match(MARKDOWN_EXPORT_SEGMENT_HEADER);
    if (!header) return generic;
    const timestamp = parseClock(header[2]);
    if (timestamp == null) return generic;
    index++;
    const body: string[] = [];
    while (index < lines.length && !MARKDOWN_EXPORT_SEGMENT_HEADER.test(lines[index])) {
      body.push(lines[index]);
      index++;
    }
    while (body.length && body[body.length - 1] === "") body.pop();
    const segmentText = body.join("\n").trim();
    if (!segmentText) return generic;
    segments.push({ text: segmentText, timestamp, speakerName: header[1].trim() });
  }
  if (!segments.length) return generic;
  return {
    title: lines[0].replace(/^#\s+/, "").trim(),
    text: segments.map((segment) => segment.text).join("\n\n"),
    segments: requireAscendingTimestamps(segments),
  };
}

function declaredJsonTimestampUnit(
  container: Record<string, unknown> | null,
  isArray: boolean,
  timestamps: number[]
): JsonTimestampUnit {
  if (isArray) {
    // A top-level array is portable relative-seconds JSON when every value is
    // small, or OpenWhispr's stored epoch-millisecond shape when every value
    // is at millisecond epoch scale. The intervening epoch-second band is
    // ambiguous without an object-level timestamp_unit declaration.
    if (timestamps.every((timestamp) => timestamp < 1e9)) return "seconds";
    if (timestamps.every((timestamp) => timestamp >= 1e12)) return "epoch_milliseconds";
    throw new TranscriptImportError(
      "malformed",
      "A JSON segment array has mixed or ambiguous timestamp units."
    );
  }
  const metadata = container?.metadata;
  const rawUnits = [
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).timestamp_unit
      : undefined,
    container?.timestamp_unit,
  ].filter((value) => value != null);
  if (!rawUnits.length) {
    if (timestamps.some((timestamp) => timestamp >= 1e9)) {
      throw new TranscriptImportError(
        "malformed",
        "JSON timestamps at epoch scale must declare timestamp_unit."
      );
    }
    return "seconds";
  }
  const units = rawUnits.map((rawUnit): JsonTimestampUnit => {
    switch (rawUnit) {
      case "seconds":
      case "relative_seconds":
        return "seconds";
      case "epoch_seconds":
      case "epoch_milliseconds":
        return rawUnit;
      default:
        throw new TranscriptImportError(
          "malformed",
          "timestamp_unit must be seconds, epoch_seconds, or epoch_milliseconds."
        );
    }
  });
  const unit = units[0];
  if (units.some((declared) => declared !== unit)) {
    throw new TranscriptImportError("malformed", "JSON timestamp unit declarations conflict.");
  }
  const invalidScale = timestamps.some((timestamp) =>
    unit === "seconds"
      ? timestamp >= 1e9
      : unit === "epoch_seconds"
        ? timestamp < 1e9 || timestamp >= 1e12
        : timestamp < 1e12
  );
  if (invalidScale) {
    throw new TranscriptImportError("malformed", "JSON timestamps use mixed or invalid units.");
  }
  return unit;
}

function parseJson(input: string): Pick<ParsedTranscriptImport, "title" | "text" | "segments"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requireText(input));
  } catch {
    throw new TranscriptImportError("malformed", "The JSON transcript could not be read.");
  }
  const isArray = Array.isArray(parsed);
  const container =
    !isArray && parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const records = Array.isArray(parsed)
    ? parsed
    : Array.isArray(container?.segments)
      ? container.segments
      : null;
  if (!records)
    throw new TranscriptImportError("malformed", "The JSON transcript needs a segments array.");
  if (!records.length)
    throw new TranscriptImportError("empty", "The JSON transcript has no segments.");

  const rawSegments = records.map((record) => {
    if (!record || typeof record !== "object") {
      throw new TranscriptImportError(
        "malformed",
        "Each JSON transcript segment must be an object."
      );
    }
    const entry = record as Record<string, unknown>;
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    const rawTimestamp = entry.timestamp ?? entry.start;
    const timestamp = typeof rawTimestamp === "number" ? rawTimestamp : NaN;
    const rawSpeaker = entry.speakerName ?? entry.speaker;
    if (!text || !Number.isFinite(timestamp) || timestamp < 0) {
      throw new TranscriptImportError(
        "malformed",
        "Each JSON transcript segment needs non-empty text and a non-negative numeric timestamp."
      );
    }
    return {
      text,
      timestamp,
      ...(typeof rawSpeaker === "string" && rawSpeaker.trim()
        ? { speakerName: rawSpeaker.trim() }
        : {}),
    };
  });
  const unit = declaredJsonTimestampUnit(
    container,
    isArray,
    rawSegments.map((segment) => segment.timestamp)
  );
  const epochStart =
    unit === "seconds" ? 0 : Math.min(...rawSegments.map((segment) => segment.timestamp));
  const divisor = unit === "epoch_milliseconds" ? 1000 : 1;
  const segments = rawSegments.map((segment) => ({
    ...segment,
    timestamp: (segment.timestamp - epochStart) / divisor,
  }));
  const metadata = container?.metadata;
  const metadataTitle =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).title
      : undefined;
  const titleSource = metadataTitle ?? container?.title;
  const title =
    typeof titleSource === "string" && titleSource.trim() ? titleSource.trim() : undefined;
  return {
    title,
    text: segments.map((segment) => segment.text).join("\n\n"),
    segments: requireAscendingTimestamps(segments),
  };
}

/**
 * Pure, local parser for portable transcript files. SRT never infers speakers
 * from punctuation; VTT accepts only explicit <v Name> tags. JSON accepts the
 * documented exported object shape (relative seconds by default, or a declared
 * timestamp_unit) and the existing stored epoch-millisecond segment array.
 */
export function parseTranscriptImport(fileName: string, source: string): ParsedTranscriptImport {
  const format = supportedFormat(fileName);
  const text = normalizedText(source);
  if (textByteLength(text) > MAX_TRANSCRIPT_IMPORT_BYTES) {
    throw new TranscriptImportError("tooLarge", "Transcript files must be 10 MB or smaller.");
  }

  if (format === "srt" || format === "vtt") {
    const segments = parseTimedCues(text, format);
    return { format, text: segments.map((segment) => segment.text).join("\n\n"), segments };
  }
  if (format === "md") return { format, ...parseMarkdown(text) };
  if (format === "json") return { format, ...parseJson(text) };
  const plainText = requireText(text);
  return { format, text: plainText, segments: [{ text: plainText, timestamp: 0 }] };
}

/** Convert relative imported times to the timestamp JSON shape used by notes. */
export function serializeImportedTranscript(
  segments: ImportedTranscriptSegment[],
  anchorMs: number = Date.now()
): string {
  return JSON.stringify(
    segments.map((segment) => ({
      text: segment.text,
      timestamp: anchorMs + Math.round(segment.timestamp * 1000),
      ...(segment.speakerName ? { speakerName: segment.speakerName } : {}),
      ...(segment.importedCue
        ? { cueStart: segment.cueStart, cueEnd: segment.cueEnd, importedCue: true }
        : {}),
    }))
  );
}

export async function transcriptImportFingerprint(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizedText(source));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    ""
  );
}

export function transcriptImportSource(fileName: string, fingerprint: string): string {
  return `${TRANSCRIPT_IMPORT_SOURCE_PREFIX}${fingerprint}:${encodeURIComponent(fileName || "transcript")}`;
}

export function findImportedTranscriptNote<T extends { source_file?: string | null }>(
  notes: T[],
  fingerprint: string
): T | undefined {
  const prefix = `${TRANSCRIPT_IMPORT_SOURCE_PREFIX}${fingerprint}:`;
  return notes.find((note) => note.source_file?.startsWith(prefix));
}
