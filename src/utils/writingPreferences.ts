export const CLEANUP_INTENSITIES = ["none", "light", "polished"] as const;
export type CleanupIntensity = (typeof CLEANUP_INTENSITIES)[number];

export const CLEANUP_OUTPUT_MODES = ["dictation", "notes-to-dos", "email"] as const;
export type CleanupOutputMode = (typeof CLEANUP_OUTPUT_MODES)[number];

export const CLEANUP_TONES = ["default", "formal", "casual"] as const;
export type CleanupTone = (typeof CLEANUP_TONES)[number];

export interface WritingPreferences {
  cleanupIntensity: CleanupIntensity;
  cleanupOutputMode: CleanupOutputMode;
  cleanupTone: CleanupTone;
  backgroundCleanupEnabled: boolean;
}

export const DEFAULT_WRITING_PREFERENCES: Readonly<WritingPreferences> = {
  cleanupIntensity: "light",
  cleanupOutputMode: "dictation",
  cleanupTone: "default",
  backgroundCleanupEnabled: true,
};

function includes<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function normalizeCleanupIntensity(value: unknown): CleanupIntensity {
  return includes(CLEANUP_INTENSITIES, value)
    ? value
    : DEFAULT_WRITING_PREFERENCES.cleanupIntensity;
}

export function normalizeCleanupOutputMode(value: unknown): CleanupOutputMode {
  return includes(CLEANUP_OUTPUT_MODES, value)
    ? value
    : DEFAULT_WRITING_PREFERENCES.cleanupOutputMode;
}

export function normalizeCleanupTone(value: unknown): CleanupTone {
  return includes(CLEANUP_TONES, value) ? value : DEFAULT_WRITING_PREFERENCES.cleanupTone;
}

export function normalizeWritingPreferences(
  preferences: Partial<WritingPreferences>
): WritingPreferences {
  return {
    cleanupIntensity: normalizeCleanupIntensity(preferences.cleanupIntensity),
    cleanupOutputMode: normalizeCleanupOutputMode(preferences.cleanupOutputMode),
    cleanupTone: normalizeCleanupTone(preferences.cleanupTone),
    backgroundCleanupEnabled:
      typeof preferences.backgroundCleanupEnabled === "boolean"
        ? preferences.backgroundCleanupEnabled
        : DEFAULT_WRITING_PREFERENCES.backgroundCleanupEnabled,
  };
}

/**
 * A stable cache-key fragment for all settings that can change cleanup output.
 * Callers combine this with the base prompt, language, dictionary, and model identity.
 */
export function getCleanupFormattingFingerprint(preferences: Partial<WritingPreferences>): string {
  const normalized = normalizeWritingPreferences(preferences);
  return [
    `cleanupIntensity=${normalized.cleanupIntensity}`,
    `cleanupOutputMode=${normalized.cleanupOutputMode}`,
    `cleanupTone=${normalized.cleanupTone}`,
    `backgroundCleanupEnabled=${normalized.backgroundCleanupEnabled}`,
  ].join(";");
}

/**
 * Adds a compact instruction only when a user has moved away from the existing
 * cleanup defaults. It applies to both stock and custom cleanup prompts.
 */
export function appendWritingPreferencesSuffix(
  prompt: string,
  preferences: Partial<WritingPreferences>
): string {
  const normalized = normalizeWritingPreferences(preferences);
  const instructions: string[] = [];

  if (normalized.cleanupIntensity === "polished") {
    instructions.push(
      "Polish the wording for clarity and readability while preserving the speaker's meaning."
    );
  }
  if (normalized.cleanupOutputMode === "notes-to-dos") {
    instructions.push(
      "Format the dictated content as notes with to-dos only when the speaker explicitly stated them; do not create, assign, schedule, or execute tasks."
    );
  }
  if (normalized.cleanupOutputMode === "email") {
    instructions.push(
      "Format the dictated content as an email. Do not send it or invent recipients, commitments, or other content."
    );
  }
  if (normalized.cleanupTone === "formal") {
    instructions.push("Use a formal tone while retaining the speaker's intended wording.");
  }
  if (normalized.cleanupTone === "casual") {
    instructions.push("Use a casual tone while retaining the speaker's intended wording.");
  }

  if (instructions.length === 0) return prompt;

  return [
    prompt,
    "",
    "WRITING PREFERENCES:",
    ...instructions.map((instruction) => `- ${instruction}`),
    "- Preserve exact names, dates, numbers, negation, and ownership. Do not invent facts, owners, commitments, or tasks.",
  ].join("\n");
}
