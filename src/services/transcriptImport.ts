export const MAX_TRANSCRIPT_IMPORT_BYTES = 10 * 1024 * 1024;

export type TranscriptImportFormat = "txt" | "md" | "srt" | "vtt" | "json";

export interface ImportedTranscriptSegment {
  text: string;
  /** Seconds from the beginning of the imported transcript. */
  timestamp: number;
  /** A label explicitly present in the source file. */
  speakerName?: string;
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

function splitSpeakerLabel(text: string): Pick<ImportedTranscriptSegment, "text" | "speakerName"> {
  const [firstLine, ...followingLines] = text.split("\n");
  const match = firstLine.match(/^([^:\n]{1,80}):\s+(.+)$/);
  if (!match) return { text: text.trim() };
  return {
    text: [match[2], ...followingLines].join("\n").trim(),
    speakerName: match[1].trim(),
  };
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

function parseTimedCues(input: string, format: "srt" | "vtt"): ImportedTranscriptSegment[] {
  let body = requireText(input);
  if (format === "vtt") {
    if (!/^WEBVTT(?:\s|$)/i.test(body)) {
      throw new TranscriptImportError("malformed", "A VTT transcript must begin with WEBVTT.");
    }
    body = body.replace(/^WEBVTT[^\n]*(?:\n|$)/i, "").trim();
  }

  const segments: ImportedTranscriptSegment[] = [];
  for (const rawBlock of body.split(/\n{2,}/)) {
    const lines = rawBlock.split("\n").map((line) => line.trimEnd());
    if (format === "vtt" && /^NOTE(?:\s|$)/i.test(lines[0] ?? "")) continue;
    if (/^\d+$/.test(lines[0] ?? "")) lines.shift();
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
    if (timestamp == null || end == null || end < timestamp || !cueText) {
      throw new TranscriptImportError("malformed", "A transcript cue has invalid timing or text.");
    }
    segments.push({ timestamp, ...splitSpeakerLabel(cueText) });
  }
  if (!segments.length) throw new TranscriptImportError("empty", "The transcript has no cues.");
  return requireAscendingTimestamps(segments);
}

function parseMarkdown(input: string): Pick<ParsedTranscriptImport, "title" | "text" | "segments"> {
  const text = requireText(input);
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || undefined;
  const headerPattern = /^\*\*([^*\n]+)\*\*\s+`([^`]+)`\s*$/gm;
  const headers = [...text.matchAll(headerPattern)];
  if (!headers.length) return { title, text, segments: [{ text, timestamp: 0 }] };

  const segments: ImportedTranscriptSegment[] = [];
  headers.forEach((header, index) => {
    const timestamp = parseClock(header[2]);
    const start = (header.index ?? 0) + header[0].length;
    const end = index + 1 < headers.length ? headers[index + 1].index : text.length;
    const segmentText = text.slice(start, end).replace(/^\s+|\s+$/g, "");
    if (timestamp == null || !segmentText || segmentText === "---") {
      throw new TranscriptImportError("malformed", "A Markdown transcript segment is incomplete.");
    }
    segments.push({ text: segmentText, timestamp, speakerName: header[1].trim() });
  });
  return {
    title,
    text: segments.map((segment) => segment.text).join("\n\n"),
    segments: requireAscendingTimestamps(segments),
  };
}

function parseJson(input: string): Pick<ParsedTranscriptImport, "title" | "text" | "segments"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requireText(input));
  } catch {
    throw new TranscriptImportError("malformed", "The JSON transcript could not be read.");
  }
  const container = Array.isArray(parsed)
    ? null
    : parsed && typeof parsed === "object"
      ? parsed
      : null;
  const records = Array.isArray(parsed)
    ? parsed
    : Array.isArray((container as { segments?: unknown[] } | null)?.segments)
      ? (container as { segments: unknown[] }).segments
      : null;
  if (!records) {
    throw new TranscriptImportError("malformed", "The JSON transcript needs a segments array.");
  }
  if (!records.length) {
    throw new TranscriptImportError("empty", "The JSON transcript has no segments.");
  }

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

  // OpenWhispr's existing note transcript is epoch-millisecond based, while
  // its exported JSON uses relative seconds. Accept both exact structures and
  // normalize the stored form to relative seconds before re-anchoring on save.
  const looksEpochBased = rawSegments.every((segment) => segment.timestamp > 1e9);
  const epochStart = looksEpochBased
    ? Math.min(...rawSegments.map((segment) => segment.timestamp))
    : 0;
  const segments = rawSegments.map((segment) => ({
    ...segment,
    timestamp: looksEpochBased ? (segment.timestamp - epochStart) / 1000 : segment.timestamp,
  }));
  const metadata = container as { metadata?: { title?: unknown }; title?: unknown } | null;
  const titleSource = metadata?.metadata?.title ?? metadata?.title;
  const title =
    typeof titleSource === "string" && titleSource.trim() ? titleSource.trim() : undefined;
  return {
    title,
    text: segments.map((segment) => segment.text).join("\n\n"),
    segments: requireAscendingTimestamps(segments),
  };
}

/**
 * Pure, local parser for portable transcript files. TXT is treated as one
 * unlabelled segment; Markdown accepts the app's transcript-export headings;
 * JSON accepts only an array of { text, timestamp, speakerName? } records or
 * the app's { metadata?, segments } export shape. No speaker labels are made
 * up when a source does not supply one.
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
  if (format === "md") {
    const parsed = parseMarkdown(text);
    return { format, ...parsed };
  }
  if (format === "json") {
    const parsed = parseJson(text);
    return { format, ...parsed };
  }
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
