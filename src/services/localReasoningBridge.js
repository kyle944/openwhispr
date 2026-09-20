const crypto = require("crypto");
const modelManager = require("../helpers/modelManagerBridge").default;
const debugLogger = require("../helpers/debugLogger");
const { speculativeCleanup } = require("../helpers/speculativeCleanup");

const EMPTY_TRANSCRIPT_MARKER = "<transcript>\n\n</transcript>";

class LocalReasoningService {
  constructor() {
    this.isProcessing = false;
  }

  async isAvailable() {
    try {
      await modelManager.ensureLlamaCpp();
      const models = await modelManager.getAllModels();
      return models.some((model) => model.isDownloaded);
    } catch {
      return false;
    }
  }

  async processText(text, modelId, config = {}) {
    debugLogger.logReasoning("LOCAL_BRIDGE_START", {
      modelId,
      textLength: text.length,
      hasConfig: Object.keys(config).length > 0,
      speculativeEligible: config.speculativeCleanup?.eligible === true,
    });

    const inferenceConfig = this.buildInferenceConfig(text, config);
    const runForeground = () => this.runForeground(text, modelId, inferenceConfig);
    const speculativeMeta = config.speculativeCleanup;

    if (speculativeMeta?.eligible === true) {
      const key = this.createRequestKey(text, modelId, inferenceConfig, speculativeMeta.cacheKey);
      return speculativeCleanup.finalize({ key, run: runForeground });
    }

    // Agent, translation, and other local requests take precedence over an
    // opportunistic cleanup that can no longer be reused.
    await speculativeCleanup.interrupt("non-cleanup-foreground-request");
    return runForeground();
  }

  createSpeculativeCleanupRequest(text, warmPayload) {
    if (
      typeof text !== "string" ||
      !warmPayload?.modelId ||
      !warmPayload?.systemPrompt ||
      typeof warmPayload.userPrompt !== "string"
    ) {
      return null;
    }

    const markerIndex = warmPayload.userPrompt.indexOf(EMPTY_TRANSCRIPT_MARKER);
    if (
      markerIndex < 0 ||
      warmPayload.userPrompt.indexOf(EMPTY_TRANSCRIPT_MARKER, markerIndex + 1) >= 0
    ) {
      return null;
    }

    // Use a callback so dictated JavaScript/shell replacement tokens such as
    // $&, $`, and $' remain literal transcript content.
    const wrappedText = warmPayload.userPrompt.replace(
      EMPTY_TRANSCRIPT_MARKER,
      () => `<transcript>\n${text}\n</transcript>`
    );
    const inferenceConfig = this.buildInferenceConfig(wrappedText, {
      systemPrompt: warmPayload.systemPrompt,
      temperature: 0,
      disableThinking: warmPayload.disableThinking,
    });
    const key = this.createRequestKey(
      wrappedText,
      warmPayload.modelId,
      inferenceConfig,
      warmPayload.cacheKey
    );

    return {
      key,
      run: (signal) => {
        if (this.isProcessing) {
          const error = new Error("Foreground local reasoning has priority");
          error.name = "AbortError";
          throw error;
        }
        return this.executeInference(wrappedText, warmPayload.modelId, {
          ...inferenceConfig,
          signal,
        });
      },
    };
  }

  buildInferenceConfig(text, config = {}) {
    return {
      maxTokens: config.maxTokens ?? this.calculateMaxTokens(text.length),
      temperature: config.temperature ?? 0.7,
      topK: config.topK ?? 40,
      topP: config.topP ?? 0.9,
      repeatPenalty: config.repeatPenalty ?? 1.1,
      systemPrompt: config.systemPrompt || "",
      disableThinking: config.disableThinking !== false,
      requireCompleteOutput: config.requireCompleteOutput,
      signal: config.signal,
    };
  }

  createRequestKey(text, modelId, inferenceConfig, cacheKey = "") {
    const identity = {
      text,
      modelId,
      cacheKey: cacheKey || "",
      maxTokens: inferenceConfig.maxTokens,
      temperature: inferenceConfig.temperature,
      topK: inferenceConfig.topK,
      topP: inferenceConfig.topP,
      repeatPenalty: inferenceConfig.repeatPenalty,
      systemPrompt: inferenceConfig.systemPrompt,
      disableThinking: inferenceConfig.disableThinking,
      requireCompleteOutput: inferenceConfig.requireCompleteOutput === true,
    };
    return crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  }

  async runForeground(text, modelId, inferenceConfig) {
    if (this.isProcessing) {
      throw new Error("Already processing a request");
    }

    this.isProcessing = true;
    try {
      return await this.executeInference(text, modelId, inferenceConfig);
    } finally {
      this.isProcessing = false;
    }
  }

  async executeInference(text, modelId, inferenceConfig) {
    const startTime = Date.now();
    try {
      debugLogger.logReasoning("LOCAL_BRIDGE_INFERENCE", {
        modelId,
        config: {
          ...inferenceConfig,
          systemPrompt: inferenceConfig.systemPrompt ? "[set]" : "[not set]",
          signal: inferenceConfig.signal ? "[set]" : "[not set]",
        },
      });

      const result = await modelManager.runInference(modelId, text, inferenceConfig);
      const stripThinking = inferenceConfig.disableThinking !== false;
      const cleanResult = stripThinking
        ? (await import("../helpers/stripThinking.js")).stripThinkingTags(result)
        : result.trim();

      debugLogger.logReasoning("LOCAL_BRIDGE_SUCCESS", {
        modelId,
        processingTimeMs: Date.now() - startTime,
        resultLength: cleanResult.length,
      });
      return cleanResult;
    } catch (error) {
      debugLogger.logReasoning("LOCAL_BRIDGE_ERROR", {
        modelId,
        processingTimeMs: Date.now() - startTime,
        error: error.message,
        aborted: error.name === "AbortError",
      });
      throw error;
    }
  }

  calculateMaxTokens(textLength, minTokens = 512, maxTokens = 2048, multiplier = 2) {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }
}

module.exports = {
  default: new LocalReasoningService(),
};
