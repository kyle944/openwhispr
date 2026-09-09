export interface LearnedCorrectionExample {
  before: string;
  after: string;
}

export const LEARNED_CORRECTION_EXAMPLES_KEY = "learnedCorrectionExamples";
export const MAX_LEARNED_CORRECTION_EXAMPLES = 12;
const MAX_PROMPT_EXAMPLES = 8;

function normalizeExample(value: unknown): LearnedCorrectionExample | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const before = typeof candidate.before === "string" ? candidate.before.trim() : "";
  const after = typeof candidate.after === "string" ? candidate.after.trim() : "";
  if (!before || !after || before === after) return null;
  const unchangedAt = after.toLocaleLowerCase().indexOf(before.toLocaleLowerCase());
  if (unchangedAt !== -1) {
    const surrounding = `${after.slice(0, unchangedAt)}${after.slice(unchangedAt + before.length)}`;
    // Discard old examples where the transcript itself was unchanged and the
    // user merely typed adjacent prose. Keep punctuation-only wrapping edits.
    if (/[\p{L}\p{N}_]/u.test(surrounding)) return null;
  }
  return { before: before.slice(0, 240), after: after.slice(0, 240) };
}

export function readLearnedCorrectionExamples(): LearnedCorrectionExample[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(LEARNED_CORRECTION_EXAMPLES_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeExample).filter(Boolean) as LearnedCorrectionExample[];
  } catch {
    return [];
  }
}

export function rememberLearnedCorrectionExample(value: unknown): LearnedCorrectionExample[] {
  const example = normalizeExample(value);
  const current = readLearnedCorrectionExamples();
  if (!example || typeof localStorage === "undefined") return current;

  const key = `${example.before.toLocaleLowerCase()}\u0000${example.after.toLocaleLowerCase()}`;
  const deduped = current.filter(
    (item) => `${item.before.toLocaleLowerCase()}\u0000${item.after.toLocaleLowerCase()}` !== key
  );
  const next = [...deduped, example].slice(-MAX_LEARNED_CORRECTION_EXAMPLES);
  localStorage.setItem(LEARNED_CORRECTION_EXAMPLES_KEY, JSON.stringify(next));
  return next;
}

export function hasLearnedCorrectionExamples(): boolean {
  if (
    typeof localStorage !== "undefined" &&
    localStorage.getItem("autoLearnCorrections") === "false"
  ) {
    return false;
  }
  return readLearnedCorrectionExamples().length > 0;
}

export function appendLearnedCorrectionExamples(prompt: string): string {
  if (!hasLearnedCorrectionExamples()) return prompt;
  const examples = readLearnedCorrectionExamples().slice(-MAX_PROMPT_EXAMPLES);
  if (examples.length === 0) return prompt;

  const rendered = examples
    .map(
      (example, index) =>
        `${index + 1}. Pasted: ${JSON.stringify(example.before)}\n` +
        `   User changed it to: ${JSON.stringify(example.after)}`
    )
    .join("\n");

  return `${prompt}\n\nLEARNED CORRECTIONS:\nThese are edits the user made after OpenWhispr pasted prior transcripts. Infer the recurring preference behind each edit, such as spelling, punctuation, capitalization, wording, or formatting. Apply a preference only when the same intent recurs; do not blindly replace unrelated text. More recent examples should win when examples conflict.\n${rendered}`;
}
