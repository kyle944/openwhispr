export interface SpokenEnterContext {
  enabled: boolean;
  routeKind?: string | null;
  assistantConversation?: boolean;
  selectionEdit?: boolean;
  cancelled?: boolean;
  translationRequested?: boolean;
  voiceAgentRequested?: boolean;
}

export interface SpokenEnterDecision {
  text: string;
  submit: boolean;
}

const TERMINAL_TRIGGER = /(?:^|\s)press\s+enter\s*[.!?]*\s*$/i;
// This applies only after raw STT has already authorized submission. It is
// intentionally lexical: cleanup may quote or otherwise re-punctuate the
// directive, but it must never leave those command words to be pasted.
const AUTHORIZED_TERMINAL_TRIGGER = /(?:^|[\s,;:]+)["“‘']?press\s+enter["”’']?\s*[.!?]*\s*$/i;

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function isWordApostrophe(text: string, index: number): boolean {
  const before = text[index - 1];
  // Covers contractions and possessives such as Bob's and James'. A quote
  // already open still closes first, so ‘say 'press Enter'’ remains quoted.
  return !!before && /[\p{L}\p{N}]/u.test(before);
}

/** True when an index occurs in an unclosed straight or typographic quotation. */
function isInsideQuote(text: string, index: number): boolean {
  let quote: '"' | "'" | "curly-double" | "curly-single" | null = null;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const character = text[cursor];
    if (character === '"' && !isEscaped(text, cursor)) {
      quote = quote === character ? null : (quote ?? character);
    } else if (character === "'" && !isEscaped(text, cursor)) {
      if (quote === "'") quote = null;
      else if (!isWordApostrophe(text, cursor)) quote = quote ?? "'";
    } else if (character === "“") {
      quote = quote ?? "curly-double";
    } else if (character === "”" && quote === "curly-double") {
      quote = null;
    } else if (character === "‘" && !isWordApostrophe(text, cursor)) {
      quote = quote ?? "curly-single";
    } else if (character === "’") {
      if (quote === "curly-single") quote = null;
      else if (!isWordApostrophe(text, cursor)) quote = quote ?? "curly-single";
    }
  }
  return quote !== null;
}

/**
 * Removes only a final, unquoted “press Enter” directive. A directive on its
 * own remains dictated text: there is nothing to paste and therefore nothing
 * safe to submit.
 */
export function extractTerminalSpokenEnter(text: string): SpokenEnterDecision {
  const match = TERMINAL_TRIGGER.exec(text);
  if (!match || match.index === undefined || isInsideQuote(text, match.index)) {
    return { text, submit: false };
  }

  const beforeDirective = text
    .slice(0, match.index)
    .replace(/[,:;\s]+$/, "")
    .trimEnd();
  if (!beforeDirective.trim()) return { text, submit: false };

  return { text: beforeDirective, submit: true };
}

/**
 * Submission is deliberately fail-closed. Only ordinary final dictation can
 * request the native macOS submit seam; agent, translation, selection, and
 * cancelled paths always paste their text without Return.
 */
export function decideSpokenEnter(text: string, context: SpokenEnterContext): SpokenEnterDecision {
  if (
    !context.enabled ||
    context.cancelled ||
    context.assistantConversation ||
    context.selectionEdit ||
    context.translationRequested ||
    context.voiceAgentRequested ||
    (context.routeKind !== "cleanup" && context.routeKind !== "skip")
  ) {
    return { text, submit: false };
  }
  return extractTerminalSpokenEnter(text);
}

/**
 * The final transcript may have been cleaned up or expanded with snippets.
 * Only raw STT can authorize a submit; processed output is stripped solely
 * when that raw directive was accepted.
 */
export function applySpokenEnterDirective(
  rawText: string,
  processedText: string,
  context: SpokenEnterContext
): SpokenEnterDecision {
  const directive = decideSpokenEnter(rawText, context);
  if (!directive.submit) return { text: processedText, submit: false };

  const match = AUTHORIZED_TERMINAL_TRIGGER.exec(processedText);
  const text = match
    ? processedText
        .slice(0, match.index)
        .replace(/[,:;\s]+$/, "")
        .trimEnd()
    : processedText;
  return {
    text,
    submit: !!text.trim(),
  };
}
