/**
 * Extracts transcription corrections by diffing original text against
 * the edited field value. Returns corrected words to add to the custom dictionary.
 */

const MAX_CHARACTER_ALIGNMENT_CELLS = 1_000_000;

/**
 * Levenshtein edit distance between two strings. Equal edges are trimmed and
 * the remaining matrix uses rolling rows; broadly changed giant tokens fail
 * closed instead of blocking Electron's main thread.
 */
function editDistance(a, b) {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  let left = a.slice(prefix, a.length - suffix);
  let right = b.slice(prefix, b.length - suffix);
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  if (left.length * right.length > MAX_CHARACTER_ALIGNMENT_CELLS) return Infinity;

  if (right.length > left.length) [left, right] = [right, left];
  const m = left.length;
  const n = right.length;
  let previous = Array.from({ length: n + 1 }, (_, index) => index);

  for (let i = 1; i <= m; i++) {
    const current = Array(n + 1).fill(0);
    current[0] = i;
    for (let j = 1; j <= n; j++) {
      if (left[i - 1] === right[j - 1]) {
        current[j] = previous[j - 1];
      } else {
        current[j] = 1 + Math.min(previous[j], current[j - 1], previous[j - 1]);
      }
    }
    previous = current;
  }
  return previous[n];
}

/** Tokenize text into words, stripping punctuation from edges */
function tokenize(text) {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, ""))
    .filter((w) => w.length > 0);
}

const MAX_ALIGNMENT_CELLS = 250_000;

function trimUnchangedWordEdges(originalWords, editedWords) {
  let prefix = 0;
  while (
    prefix < originalWords.length &&
    prefix < editedWords.length &&
    originalWords[prefix].toLowerCase() === editedWords[prefix].toLowerCase()
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < originalWords.length - prefix &&
    suffix < editedWords.length - prefix &&
    originalWords[originalWords.length - 1 - suffix].toLowerCase() ===
      editedWords[editedWords.length - 1 - suffix].toLowerCase()
  ) {
    suffix += 1;
  }

  return {
    prefix,
    original: originalWords.slice(prefix, originalWords.length - suffix),
    edited: editedWords.slice(prefix, editedWords.length - suffix),
  };
}

/**
 * Find the region in fieldValue that corresponds to the pasted originalText.
 * If the field only contains the pasted text, returns fieldValue as-is.
 */
function findEditedRegion(originalText, fieldValue) {
  if (fieldValue.length <= originalText.length * 1.5) {
    return fieldValue;
  }

  const idx = fieldValue.indexOf(originalText);
  if (idx !== -1) {
    return originalText;
  }

  // Sliding window: find the region with highest word overlap
  const origWords = tokenize(originalText);
  const fieldWords = tokenize(fieldValue);
  const windowSize = origWords.length;

  if (fieldWords.length <= windowSize) {
    return fieldValue;
  }

  let bestStart = 0;
  let bestScore = -1;

  for (let i = 0; i <= fieldWords.length - windowSize; i++) {
    let matches = 0;
    for (let j = 0; j < windowSize; j++) {
      if (fieldWords[i + j].toLowerCase() === origWords[j].toLowerCase()) {
        matches++;
      }
    }
    if (matches > bestScore) {
      bestScore = matches;
      bestStart = i;
    }
  }

  // Require at least 30% word overlap to consider it a match
  if (bestScore < windowSize * 0.3) {
    return fieldValue;
  }

  return fieldWords.slice(bestStart, bestStart + windowSize).join(" ");
}

/**
 * Isolate the span pasted by OpenWhispr using the field value captured after
 * paste. Learning fails closed when the paste cannot be located uniquely or
 * when text outside its surrounding anchors changed.
 */
function findTrackedEditedRegion(originalText, initialFieldValue, fieldValue) {
  if (typeof initialFieldValue !== "string") return null;

  const start = initialFieldValue.indexOf(originalText);
  if (start === -1 || initialFieldValue.indexOf(originalText, start + 1) !== -1) return null;

  const prefix = initialFieldValue.slice(0, start);
  const suffix = initialFieldValue.slice(start + originalText.length);
  if (!fieldValue.startsWith(prefix) || (suffix && !fieldValue.endsWith(suffix))) return null;

  const end = suffix ? fieldValue.length - suffix.length : fieldValue.length;
  if (end < prefix.length) return null;
  const editedRegion = fieldValue.slice(prefix.length, end);

  // A reusable example is capped at 240 characters downstream. Very large
  // growth cannot be a local correction and must not reach quadratic token
  // alignment on Electron's main thread.
  if (editedRegion.length > Math.max(originalText.length * 2, originalText.length + 1024)) {
    return null;
  }

  const originalWords = tokenize(originalText);
  const editedWords = tokenize(editedRegion);
  if (hasBoundaryWordInsertion(originalWords, editedWords)) return null;

  return editedRegion;
}

/**
 * Reject lexical insertions before or after the tracked transcript while
 * preserving edits inside it, including one-word splits. Token-level
 * Levenshtein alignment treats a changed boundary word as a substitution, so
 * repeated words do not turn an ordinary correction into a false append.
 */
function hasBoundaryWordInsertion(originalWords, editedWords) {
  const totalOriginalWords = originalWords.length;
  const trimmed = trimUnchangedWordEdges(originalWords, editedWords);
  const { original, edited, prefix } = trimmed;
  const m = original.length;
  const n = edited.length;
  if (m === 0) {
    // With no changed source token, a lexical insertion is indistinguishable
    // from adjacent prose. A real split retains the source token in this
    // changed window and is handled by the alignment below.
    return n > 0;
  }
  if (n === 0) return false;
  if (m * n > MAX_ALIGNMENT_CELLS) return true;

  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  const boundaryInsertion = Array.from({ length: m + 1 }, () => Array(n + 1).fill(false));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 1; j <= n; j++) {
    dp[0][j] = j;
    boundaryInsertion[0][j] = prefix === 0;
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const substitutionCost =
        original[i - 1].toLowerCase() === edited[j - 1].toLowerCase() ? 0 : 1;
      const deletion = dp[i - 1][j] + 1;
      const insertion = dp[i][j - 1] + 1;
      const substitution = dp[i - 1][j - 1] + substitutionCost;
      const best = Math.min(deletion, insertion, substitution);
      dp[i][j] = best;

      let hasBoundaryInsertion = false;
      if (deletion === best) hasBoundaryInsertion ||= boundaryInsertion[i - 1][j];
      if (substitution === best) hasBoundaryInsertion ||= boundaryInsertion[i - 1][j - 1];
      if (insertion === best) {
        const insertionAt = prefix + i;
        hasBoundaryInsertion ||=
          boundaryInsertion[i][j - 1] || insertionAt === 0 || insertionAt === totalOriginalWords;
      }
      boundaryInsertion[i][j] = hasBoundaryInsertion;
    }
  }
  return boundaryInsertion[m][n];
}

function resolveEditedRegion(originalText, fieldValue, initialFieldValue) {
  return typeof initialFieldValue === "string"
    ? findTrackedEditedRegion(originalText, initialFieldValue, fieldValue)
    : findEditedRegion(originalText, fieldValue);
}

/** Word-level LCS to find [originalWord, editedWord] substitution pairs. */
function findSubstitutions(origWords, editedWords) {
  const trimmed = trimUnchangedWordEdges(origWords, editedWords);
  const original = trimmed.original;
  const edited = trimmed.edited;
  const m = original.length;
  const n = edited.length;
  if (m === 0 || n === 0 || m * n > MAX_ALIGNMENT_CELLS) return [];

  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (original[i - 1].toLowerCase() === edited[j - 1].toLowerCase()) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const aligned = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && original[i - 1].toLowerCase() === edited[j - 1].toLowerCase()) {
      aligned.unshift([original[i - 1], edited[j - 1]]);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      aligned.unshift([null, edited[j - 1]]);
      j--;
    } else {
      aligned.unshift([original[i - 1], null]);
      i--;
    }
  }

  // Consecutive [origWord, null] + [null, editedWord] = substitution
  const subs = [];
  for (let k = 0; k < aligned.length - 1; k++) {
    const [origW, editW] = aligned[k];
    const [nextOrigW, nextEditW] = aligned[k + 1];

    if (origW !== null && editW === null && nextOrigW === null && nextEditW !== null) {
      subs.push([origW, nextEditW]);
    }
  }

  return subs;
}

function sharedWordRatio(originalText, editedText) {
  const original = tokenize(originalText).map((word) => word.toLowerCase());
  const edited = tokenize(editedText).map((word) => word.toLowerCase());
  if (original.length === 0 || edited.length === 0) return 0;

  const counts = new Map();
  for (const word of original) counts.set(word, (counts.get(word) || 0) + 1);
  let shared = 0;
  for (const word of edited) {
    const remaining = counts.get(word) || 0;
    if (remaining > 0) {
      shared += 1;
      counts.set(word, remaining - 1);
    }
  }
  return shared / Math.max(original.length, edited.length);
}

function sharedCharacterRatio(originalText, editedText) {
  const original = originalText.toLocaleLowerCase().replace(/\s+/g, " ");
  const edited = editedText.toLocaleLowerCase().replace(/\s+/g, " ");
  const maxLength = Math.max(original.length, edited.length);
  if (maxLength === 0) return 0;
  return 1 - editDistance(original, edited) / maxLength;
}

function cropCorrectionPair(originalText, editedText, maxLength = 240) {
  if (originalText.length <= maxLength && editedText.length <= maxLength) {
    return { before: originalText, after: editedText };
  }

  let prefix = 0;
  while (
    prefix < originalText.length &&
    prefix < editedText.length &&
    originalText[prefix] === editedText[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < originalText.length - prefix &&
    suffix < editedText.length - prefix &&
    originalText[originalText.length - 1 - suffix] === editedText[editedText.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const context = 72;
  const originalStart = Math.max(0, prefix - context);
  const editedStart = Math.max(0, prefix - context);
  const originalEnd = Math.min(originalText.length, originalText.length - suffix + context);
  const editedEnd = Math.min(editedText.length, editedText.length - suffix + context);

  return {
    before: originalText.slice(originalStart, originalEnd).trim().slice(0, maxLength),
    after: editedText.slice(editedStart, editedEnd).trim().slice(0, maxLength),
  };
}

/**
 * Capture one bounded before/after example that a cleanup model can reason
 * from later. The example keeps wording, punctuation, casing and layout, while
 * rejecting wholesale rewrites and trivial whitespace-only changes.
 */
function extractCorrectionExample(originalText, fieldValue, initialFieldValue) {
  if (typeof originalText !== "string" || typeof fieldValue !== "string") return null;
  const original = originalText.trim();
  const editedRegion = resolveEditedRegion(originalText, fieldValue, initialFieldValue);
  if (editedRegion === null) return null;
  const edited = editedRegion.trim();
  if (!original || !edited || original === edited) return null;
  if (original.replace(/\s+/g, " ") === edited.replace(/\s+/g, " ")) return null;
  const characterRatio = sharedCharacterRatio(original, edited);
  if (!Number.isFinite(characterRatio)) return null;
  if (sharedWordRatio(original, edited) < 0.55 && characterRatio < 0.7) {
    return null;
  }

  const pair = cropCorrectionPair(original, edited);
  if (!pair.before || !pair.after || pair.before === pair.after) return null;
  return pair;
}

/**
 * Extract corrected words from a user's edits to pasted transcription text.
 *
 * @param {string} originalText - The text that was originally pasted (from transcription)
 * @param {string} fieldValue - The current value of the text field (after user edits)
 * @param {string[]} existingDictionary - Words already in the custom dictionary
 * @returns {string[]} Array of corrected words to add to the dictionary
 */
function extractCorrections(originalText, fieldValue, existingDictionary, initialFieldValue) {
  if (!originalText || !fieldValue) return [];
  if (originalText === fieldValue) return [];

  const editedRegion = resolveEditedRegion(originalText, fieldValue, initialFieldValue);
  if (editedRegion === null) return [];
  if (editedRegion === originalText) return [];

  const origWords = tokenize(originalText);
  const editedWords = tokenize(editedRegion);

  if (origWords.length === 0 || editedWords.length === 0) return [];

  // If more than 50% of words changed, this is a rewrite, not corrections
  const subs = findSubstitutions(origWords, editedWords);
  if (subs.length > origWords.length * 0.5) return [];

  const safeDict = Array.isArray(existingDictionary) ? existingDictionary : [];
  const dictSet = new Set(safeDict.map((w) => w.toLowerCase()));
  const seenCorrections = new Set();
  const results = [];

  for (const [origWord, correctedWord] of subs) {
    const normalizedCorrected = correctedWord.toLowerCase();

    if (dictSet.has(normalizedCorrected)) continue;
    if (seenCorrections.has(normalizedCorrected)) continue;
    if (origWord.toLowerCase() === normalizedCorrected) continue;
    if (correctedWord.length < 3) continue;

    // 0.65 threshold allows phonetic corrections like "Shunade" → "Sinead" (dist 4/7 = 0.57)
    // while filtering out unrelated word replacements.
    const dist = editDistance(origWord.toLowerCase(), correctedWord.toLowerCase());
    const maxLen = Math.max(origWord.length, correctedWord.length);
    if (dist / maxLen > 0.65) continue;

    results.push(correctedWord);
    seenCorrections.add(normalizedCorrected);
  }

  return results;
}

module.exports = { extractCorrectionExample, extractCorrections };
