import type { InferenceProvider } from "./types";
import { wrapCleanupTranscript } from "../../../config/prompts";
import logger from "../../../utils/logger";

export const localProvider: InferenceProvider = {
  id: "local",
  async call({ text, model, agentName, config, ctx }) {
    if (typeof window === "undefined" || !window.electronAPI) {
      throw new Error("Local reasoning is not available in this environment");
    }

    logger.logReasoning("LOCAL_START", { model, agentName, environment: "browser" });
    const startTime = Date.now();

    logger.logReasoning("LOCAL_IPC_CALL", { model, textLength: text.length });

    // A session-specific cleanup prompt (for example, an app writing style)
    // is still cleanup even though it is supplied explicitly. Keep the legacy
    // no-prompt path for callers that predate inference scopes.
    const isCleanup = config.inferenceScope === "dictationCleanup" || !config.systemPrompt;
    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
    const userContent = isCleanup ? wrapCleanupTranscript(text) : text;
    const speculativeCleanup =
      isCleanup && config.inferenceScope === "dictationCleanup"
        ? {
            eligible: true,
            cacheKey: config.speculativeCleanupCacheKey || "",
          }
        : undefined;
    const result = await window.electronAPI.processLocalReasoning(userContent, model, agentName, {
      ...config,
      systemPrompt,
      // Cleanup is a deterministic text transform. The local bridge otherwise
      // defaults to 0.7, which makes short misspellings vary between runs.
      ...(isCleanup && config.temperature === undefined ? { temperature: 0 } : {}),
      ...(speculativeCleanup ? { speculativeCleanup } : {}),
    });

    const processingTimeMs = Date.now() - startTime;

    if (!result.success) {
      logger.logReasoning("LOCAL_ERROR", { model, processingTimeMs, error: result.error });
      throw new Error(result.error);
    }

    logger.logReasoning("LOCAL_SUCCESS", {
      model,
      processingTimeMs,
      resultLength: result.text.length,
    });
    return result.text;
  },
};
