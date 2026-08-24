import { useEffect } from "react";
import type { TFunction } from "i18next";
import type { ToastContextType } from "../components/ui/useToast";

/**
 * Surfaces main-process notifications (hotkey fallback/failure, GPU fallback,
 * learned dictionary corrections) as toasts in the dictation window.
 */
export function useMainProcessNotifications({
  toast,
  dismiss,
  t,
}: {
  toast: ToastContextType["toast"];
  dismiss: ToastContextType["dismiss"];
  t: TFunction;
}): void {
  useEffect(() => {
    const unsubscribeFallback = window.electronAPI?.onHotkeyFallbackUsed?.((data) => {
      toast({
        title: t("app.toasts.hotkeyChanged.title"),
        description: t("app.toasts.hotkeyChanged.description", {
          original: data.original,
          fallback: data.fallback,
        }),
        duration: 8000,
      });
    });

    const unsubscribeFailed = window.electronAPI?.onHotkeyRegistrationFailed?.((_data) => {
      toast({
        title: t("app.toasts.hotkeyUnavailable.title"),
        description: t("app.toasts.hotkeyUnavailable.description"),
        duration: 10000,
      });
    });

    const showGpuFallbackToast = () => {
      toast({
        title: t("app.toasts.gpuFallback.title"),
        description: t("app.toasts.gpuFallback.description"),
        duration: 10000,
      });
    };
    const unsubscribeCudaFallback =
      window.electronAPI?.onCudaFallbackNotification?.(showGpuFallbackToast);
    const unsubscribeGpuFallback =
      window.electronAPI?.onGpuFallbackNotification?.(showGpuFallbackToast);

    const unsubscribeCorrections = window.electronAPI?.onCorrectionsLearned?.((words) => {
      if (words && words.length > 0) {
        const wordList = words.map((w) => `“${w}”`).join(", ");
        let toastId: string;
        toastId = toast({
          title: t("app.toasts.addedToDict", { words: wordList }),
          presentation: "dictionary-learned",
          duration: 5000,
          action: (
            <button
              onClick={async () => {
                try {
                  const result = await window.electronAPI?.undoLearnedCorrections?.(words);
                  if (result?.success) {
                    dismiss(toastId);
                  }
                } catch {
                  // silently fail — word stays in dictionary
                }
              }}
              className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium
                text-muted-foreground transition-colors duration-150
                hover:bg-surface-2 hover:text-foreground
                focus:outline-none focus-visible:ring-1 focus-visible:ring-border-hover"
            >
              {t("app.toasts.undo")}
            </button>
          ),
        });
      }
    });

    return () => {
      unsubscribeFallback?.();
      unsubscribeFailed?.();
      unsubscribeCudaFallback?.();
      unsubscribeGpuFallback?.();
      unsubscribeCorrections?.();
    };
  }, [toast, dismiss, t]);
}
