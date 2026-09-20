import {
  normalizeCleanupOutputMode,
  normalizeCleanupTone,
  normalizeWritingPreferences,
  type CleanupOutputMode,
  type CleanupTone,
  type WritingPreferences,
} from "./writingPreferences";

export interface DictationTargetApp {
  bundleId: string;
  appName: string;
}

export interface PerAppWritingStyle extends DictationTargetApp {
  cleanupOutputMode: CleanupOutputMode | null;
  cleanupTone: CleanupTone | null;
}

const MAX_STORED_APPS = 50;
const MAX_BUNDLE_ID_LENGTH = 255;
const MAX_APP_NAME_LENGTH = 120;

function normalizeLabel(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function normalizeOptionalOutputMode(value: unknown): CleanupOutputMode | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = normalizeCleanupOutputMode(value);
  return normalized === value ? normalized : null;
}

function normalizeOptionalTone(value: unknown): CleanupTone | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = normalizeCleanupTone(value);
  return normalized === value ? normalized : null;
}

export function normalizeDictationTargetApp(value: unknown): DictationTargetApp | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DictationTargetApp>;
  const bundleId = normalizeLabel(candidate.bundleId, MAX_BUNDLE_ID_LENGTH);
  if (!bundleId) return null;
  return {
    bundleId,
    appName: normalizeLabel(candidate.appName, MAX_APP_NAME_LENGTH) || bundleId,
  };
}

export function normalizePerAppWritingStyles(value: unknown): PerAppWritingStyle[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: PerAppWritingStyle[] = [];

  for (const raw of value) {
    const target = normalizeDictationTargetApp(raw);
    if (!target || seen.has(target.bundleId)) continue;
    const candidate = raw as Partial<PerAppWritingStyle>;
    seen.add(target.bundleId);
    result.push({
      ...target,
      cleanupOutputMode: normalizeOptionalOutputMode(candidate.cleanupOutputMode),
      cleanupTone: normalizeOptionalTone(candidate.cleanupTone),
    });
    if (result.length >= MAX_STORED_APPS) break;
  }

  return result;
}

/**
 * Remembers only the stable app identity captured at dictation key-down. This
 * intentionally accepts no window title, field text, selection, or AX value.
 */
export function rememberDictationTargetApp(styles: unknown, value: unknown): PerAppWritingStyle[] {
  const current = normalizePerAppWritingStyles(styles);
  const target = normalizeDictationTargetApp(value);
  if (!target) return current;

  const existingIndex = current.findIndex((entry) => entry.bundleId === target.bundleId);
  if (existingIndex >= 0) {
    const existing = current[existingIndex];
    if (existing.appName === target.appName) return current;
    return current.map((entry, index) =>
      index === existingIndex ? { ...entry, appName: target.appName } : entry
    );
  }

  return [
    ...current,
    {
      ...target,
      cleanupOutputMode: null,
      cleanupTone: null,
    },
  ].slice(-MAX_STORED_APPS);
}

export function updatePerAppWritingStyle(
  styles: unknown,
  bundleId: string,
  patch: { cleanupOutputMode?: CleanupOutputMode | null; cleanupTone?: CleanupTone | null }
): PerAppWritingStyle[] {
  const normalizedBundleId = normalizeLabel(bundleId, MAX_BUNDLE_ID_LENGTH);
  if (!normalizedBundleId) return normalizePerAppWritingStyles(styles);

  return normalizePerAppWritingStyles(styles).map((entry) =>
    entry.bundleId === normalizedBundleId
      ? {
          ...entry,
          cleanupOutputMode:
            patch.cleanupOutputMode === undefined
              ? entry.cleanupOutputMode
              : normalizeOptionalOutputMode(patch.cleanupOutputMode),
          cleanupTone:
            patch.cleanupTone === undefined
              ? entry.cleanupTone
              : normalizeOptionalTone(patch.cleanupTone),
        }
      : entry
  );
}

export function removePerAppWritingStyle(styles: unknown, bundleId: string): PerAppWritingStyle[] {
  return normalizePerAppWritingStyles(styles).filter((entry) => entry.bundleId !== bundleId);
}

export function resolvePerAppWritingPreferences(
  globalPreferences: Partial<WritingPreferences>,
  styles: unknown,
  target: unknown
): WritingPreferences {
  const global = normalizeWritingPreferences(globalPreferences);
  const normalizedTarget = normalizeDictationTargetApp(target);
  if (!normalizedTarget) return global;

  const match = normalizePerAppWritingStyles(styles).find(
    (entry) => entry.bundleId === normalizedTarget.bundleId
  );
  if (!match) return global;

  return {
    ...global,
    cleanupOutputMode: match.cleanupOutputMode ?? global.cleanupOutputMode,
    cleanupTone: match.cleanupTone ?? global.cleanupTone,
  };
}
