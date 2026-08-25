import { Check, ChevronDown, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  resolveLiveTranscriptTextAlignment,
  resolveLiveTranscriptVisibleText,
} from "../../helpers/voicePillPresentation";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { useStickToBottom } from "../../hooks/useStickToBottom";

export type LiveTranscriptPhase = "listening" | "live" | "cleanup" | "final";

interface LiveTranscriptPanelProps {
  text: string;
  measurementText: string;
  phase: LiveTranscriptPhase;
  processing: boolean;
  controlsVisible: boolean;
  contentVisible: boolean;
  onCollapse: () => void;
  onHoldChange?: (held: boolean) => void;
}

const COPIED_RESET_MS = 1600;

export function LiveTranscriptPanel({
  text,
  measurementText,
  phase,
  processing,
  controlsVisible,
  contentVisible,
  onCollapse,
  onHoldChange,
}: LiveTranscriptPanelProps) {
  const { t } = useTranslation();
  const visibleText = resolveLiveTranscriptVisibleText({ text });
  const textAlignment = resolveLiveTranscriptTextAlignment(phase);
  const { scrollRef, handleScroll } = useStickToBottom<HTMLDivElement>(visibleText, {
    resetToTop: !visibleText,
  });
  const { copied, copy: handleCopy } = useCopyFeedback(text, { resetMs: COPIED_RESET_MS });
  const isBusy = Boolean(text) && (phase === "live" || phase === "cleanup" || processing);
  const isPolishing = phase === "cleanup" || processing;
  const isReady = phase === "final" && !processing;
  const statusText = isPolishing
    ? t("transcriptionPreview.polishing")
    : isReady
      ? t("transcriptionPreview.ready")
      : t("transcriptionPreview.listening");
  const statusDotClass = isReady
    ? "bg-emerald-500/80"
    : isPolishing
      ? "bg-violet-500/75"
      : "bg-sky-500/80";

  return (
    <>
      <main
        ref={scrollRef}
        onScroll={handleScroll}
        onMouseEnter={() => onHoldChange?.(true)}
        onMouseLeave={() => onHoldChange?.(false)}
        data-panel-scroll-region
        className={`agent-chat-scroll min-h-20 flex-auto overflow-y-auto overscroll-contain px-5 pb-2 pt-4 transition-opacity duration-160 ease-out ${
          contentVisible ? "opacity-100 delay-0" : "pointer-events-none opacity-0 delay-0"
        }`}
        aria-label={t("transcriptionPreview.label")}
        aria-busy={isBusy}
        aria-hidden={!contentVisible}
        aria-live="polite"
        data-live-transcript-phase={phase}
      >
        <div className={textAlignment === "right" ? "text-right" : "text-left"}>
          {visibleText ? (
            <p className="select-text whitespace-pre-wrap break-words text-base leading-relaxed text-foreground">
              {visibleText}
            </p>
          ) : (
            <p className="text-base leading-relaxed text-muted-foreground/55">
              {t("transcriptionPreview.waitingForInput")}
            </p>
          )}
        </div>
      </main>

      <footer
        className="flex h-12 shrink-0 items-center justify-between gap-3 px-4"
        onMouseEnter={() => onHoldChange?.(true)}
        onMouseLeave={() => onHoldChange?.(false)}
      >
        <div
          className={`flex min-w-0 items-center gap-2 transition-opacity duration-150 ease-out ${
            controlsVisible ? "opacity-100" : "opacity-0"
          }`}
          aria-hidden={!controlsVisible}
        >
          <span className={`size-1.5 shrink-0 rounded-full ${statusDotClass}`} aria-hidden="true" />
          <p className="truncate text-xs font-medium text-muted-foreground">{statusText}</p>
        </div>
        <div
          className={`flex items-center gap-2 transition-[opacity,transform] duration-200 ease-out ${
            controlsVisible
              ? "translate-x-0 opacity-100"
              : "pointer-events-none translate-x-2 opacity-0"
          }`}
          aria-hidden={!controlsVisible}
        >
          {isReady && (
            <button
              type="button"
              onClick={() => void handleCopy()}
              disabled={!controlsVisible || !text.trim()}
              tabIndex={controlsVisible ? 0 : -1}
              className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
              aria-label={
                copied ? t("transcriptionPreview.copied") : t("transcriptionPreview.copy")
              }
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </button>
          )}
          <button
            type="button"
            onClick={onCollapse}
            disabled={!controlsVisible}
            tabIndex={controlsVisible ? 0 : -1}
            className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none"
            aria-label={t("transcriptionPreview.collapse", { defaultValue: "Collapse transcript" })}
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
      </footer>

      <div
        data-panel-size-source
        className="pointer-events-none absolute inset-x-5 top-0 invisible pb-2 pt-4"
        aria-hidden="true"
      >
        <p className="whitespace-pre-wrap break-words text-base leading-relaxed">
          {measurementText || t("transcriptionPreview.waitingForInput")}
        </p>
      </div>
    </>
  );
}
