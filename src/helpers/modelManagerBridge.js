const path = require("path");
const fs = require("fs");
const { promises: fsPromises } = require("fs");
const crypto = require("crypto");
const { app } = require("electron");
const {
  downloadFile: sharedDownloadFile,
  createDownloadSignal,
  cleanupStaleDownloads,
  checkDiskSpace,
} = require("./downloadUtils");

const modelRegistryData = require("../models/modelRegistryData.json");
const LlamaServerManager = require("./llamaServer");
const debugLogger = require("./debugLogger");
const { createAbortError } = require("./abortError");

const MIN_FILE_SIZE = 1_000_000; // 1MB minimum for valid model files

// Bounds the KV cache — registry contextLength is the full trained context
// (128K+), which can exceed total RAM (#1203). Uniform for all start paths:
// start() won't restart a ready server when only options change.
const SERVER_CONTEXT_SIZE = 16384;
const EXTERNAL_INFERENCE_LEASE_TIMEOUT_MS = 6 * 60 * 1000;

function getLocalProviders() {
  return modelRegistryData.localProviders || [];
}

class ModelError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "ModelError";
    this.code = code;
    this.details = details;
  }
}

class ModelNotFoundError extends ModelError {
  constructor(modelId) {
    super(`Model ${modelId} not found`, "MODEL_NOT_FOUND", { modelId });
  }
}

class ModelManager {
  constructor() {
    this.modelsDir = null;
    this.downloadProgress = new Map();
    this.activeDownloads = new Map();
    this.activeRequests = new Map(); // Track HTTP requests for cancellation
    this.downloadLifecycleVersion = 0;
    this.serverManager = new LlamaServerManager();
    this.currentServerModelId = null;
    this.promptWarmState = null;
    this.promptWarmTail = Promise.resolve();
    this.promptWarmLatestKey = null;
    this.promptWarmPending = 0;
    this.promptWarmPayload = null;
    // llama-server owns one mutable model/server/cache. Every request reserves
    // this queue before validation or startup so a later warmup cannot race a
    // foreground request into the same server.
    this.inferenceTail = Promise.resolve();
    this.externalInferenceLeases = new Map();
    this._initialized = false;

    // IMPORTANT: Do NOT call app.getPath() here!
    // It can hang or fail before app.whenReady() in Electron 36+.
    // Initialization will happen on first use via ensureInitialized().
  }

  /**
   * Ensures the manager is initialized. Safe to call multiple times.
   * This must be called before any operation that requires modelsDir.
   */
  ensureInitialized() {
    if (this._initialized) return;

    // Check if app is ready before accessing app.getPath()
    if (!app.isReady()) {
      throw new Error(
        "ModelManager cannot be initialized before app.whenReady(). " +
          "This is a programming error - ensure ModelManager methods are only called after app is ready."
      );
    }

    this.modelsDir = this.getModelsDir();
    this._initialized = true;
    // Don't await - let this run in background
    this.ensureModelsDirExists();
    cleanupStaleDownloads(this.modelsDir);
  }

  getModelsDir() {
    const { getCacheRoot } = require("./modelDirUtils");
    return path.join(getCacheRoot(), "models");
  }

  async ensureModelsDirExists() {
    try {
      if (!this.modelsDir) {
        this.ensureInitialized();
      }
      await fsPromises.mkdir(this.modelsDir, { recursive: true });
    } catch (error) {
      console.error("Failed to create models directory:", error);
    }
  }

  async ensureLlamaCpp() {
    if (!this.serverManager.isAvailable()) {
      throw new ModelError(
        "llama-server binary not found. Please ensure the app is installed correctly.",
        "LLAMASERVER_NOT_FOUND"
      );
    }
    return true;
  }

  async getAllModels() {
    this.ensureInitialized();
    try {
      const modelEntries = [];

      for (const provider of getLocalProviders()) {
        for (const model of provider.models) {
          const modelPath = path.join(this.modelsDir, model.fileName);
          modelEntries.push({ model, provider, modelPath });
        }
      }

      let downloadedStates = [];

      // A download can finish between checking the final file and reading the
      // in-memory active state. Retry when that lifecycle changes so callers
      // never receive the impossible "not downloaded and not downloading" gap.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const lifecycleVersion = this.downloadLifecycleVersion;
        downloadedStates = await Promise.all(
          modelEntries.map(({ modelPath }) => this.checkModelValid(modelPath))
        );
        if (lifecycleVersion === this.downloadLifecycleVersion) break;
      }

      // Read volatile download state only after all asynchronous filesystem checks
      // finish so every model belongs to the same main-process snapshot.
      return modelEntries.map(({ model, provider, modelPath }, index) => {
        const progress = this.downloadProgress.get(model.id);
        const isDownloaded = downloadedStates[index];

        return {
          ...model,
          providerId: provider.id,
          providerName: provider.name,
          isDownloaded,
          isDownloading: this.activeDownloads.has(model.id),
          downloadProgress: progress?.progress || 0,
          downloadedSize: progress?.downloadedSize || 0,
          totalSize: progress?.totalSize || 0,
          path: isDownloaded ? modelPath : null,
        };
      });
    } catch (error) {
      console.error("[ModelManager] Error getting all models:", error);
      throw error;
    }
  }

  async getModelsWithStatus() {
    return this.getAllModels();
  }

  async isModelDownloaded(modelId) {
    this.ensureInitialized();
    const modelInfo = this.findModelById(modelId);
    if (!modelInfo) return false;

    const modelPath = path.join(this.modelsDir, modelInfo.model.fileName);
    return this.checkModelValid(modelPath);
  }

  async checkFileExists(filePath) {
    try {
      await fsPromises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async checkModelValid(filePath) {
    try {
      const stats = await fsPromises.stat(filePath);
      return stats.size > MIN_FILE_SIZE;
    } catch {
      return false;
    }
  }

  findModelById(modelId) {
    for (const provider of getLocalProviders()) {
      const model = provider.models.find((m) => m.id === modelId);
      if (model) {
        return { model, provider };
      }
    }
    return null;
  }

  serverOptions(modelInfo) {
    return {
      contextSize: Math.min(
        SERVER_CONTEXT_SIZE,
        modelInfo.model.contextLength || SERVER_CONTEXT_SIZE
      ),
      threads: 4,
      gpuLayers: 99,
    };
  }

  async serverStartOptions(modelInfo) {
    const options = this.serverOptions(modelInfo);
    const draftPath = await this.resolveDraftPath(modelInfo.model);
    if (draftPath) options.draftModelPath = draftPath;
    return options;
  }

  async downloadModel(modelId, onProgress) {
    this.ensureInitialized();
    const modelInfo = this.findModelById(modelId);
    if (!modelInfo) {
      throw new ModelNotFoundError(modelId);
    }

    const { model, provider } = modelInfo;
    const modelPath = path.join(this.modelsDir, model.fileName);

    if (await this.checkModelValid(modelPath)) {
      return modelPath;
    }

    if (this.activeDownloads.size > 0) {
      const activeModelId = this.activeDownloads.keys().next().value;
      throw new ModelError("A model is already being downloaded", "DOWNLOAD_IN_PROGRESS", {
        modelId,
        activeModelId,
      });
    }

    this.activeDownloads.set(modelId, true);
    this.downloadLifecycleVersion += 1;
    const { signal, abort } = createDownloadSignal();
    this.activeRequests.set(modelId, { abort });

    try {
      await this.ensureModelsDirExists();

      const hasDrafter = this.modelHasDrafter(model);

      let requiredBytes = model.sizeBytes || model.sizeMb * 1_000_000 || 0;
      if (requiredBytes > 0 && hasDrafter) {
        requiredBytes += model.draftSizeBytes;
      }
      if (requiredBytes > 0) {
        const spaceCheck = await checkDiskSpace(this.modelsDir, requiredBytes * 1.2);
        if (!spaceCheck.ok) {
          throw new ModelError(
            `Not enough disk space. Need ~${Math.round((requiredBytes * 1.2) / 1_000_000)}MB, ` +
              `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`,
            "INSUFFICIENT_DISK_SPACE",
            { required: requiredBytes, available: spaceCheck.availableBytes }
          );
        }
      }

      const downloadUrl = this.getDownloadUrl(provider, model);

      // With a drafter, weight progress across both files by declared bytes and
      // clamp it so the bar never regresses across the phase boundary. Without a
      // drafter, keep today's single-file progress exactly.
      const combinedTotal = hasDrafter ? (model.sizeBytes || 0) + model.draftSizeBytes : 0;
      let lastCombined = 0;
      const emitCombined = (rawCombined) => {
        let combined = Math.min(rawCombined, combinedTotal);
        if (combined < lastCombined) combined = lastCombined;
        else lastCombined = combined;
        const progress = combinedTotal > 0 ? (combined / combinedTotal) * 100 : 0;
        this.downloadProgress.set(modelId, {
          modelId,
          progress,
          downloadedSize: combined,
          totalSize: combinedTotal,
        });
        if (onProgress) onProgress(progress, combined, combinedTotal);
      };

      await sharedDownloadFile(downloadUrl, modelPath, {
        signal,
        onProgress: hasDrafter
          ? (downloadedBytes) => emitCombined(downloadedBytes)
          : (downloadedBytes, totalBytes) => {
              const progress = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;
              this.downloadProgress.set(modelId, {
                modelId,
                progress,
                downloadedSize: downloadedBytes,
                totalSize: totalBytes,
              });
              if (onProgress) {
                onProgress(progress, downloadedBytes, totalBytes);
              }
            },
      });

      const stats = await fsPromises.stat(modelPath);
      if (stats.size < MIN_FILE_SIZE) {
        await fsPromises.unlink(modelPath).catch(() => {});
        throw new ModelError(
          "Downloaded file appears to be corrupted or incomplete",
          "DOWNLOAD_CORRUPTED",
          { size: stats.size, minSize: MIN_FILE_SIZE }
        );
      }

      // Drafter is opportunistic: a failure or cancel here leaves the main model
      // fully usable, so never fail the download or delete the main file.
      if (hasDrafter) {
        const draftPath = path.join(this.modelsDir, model.draftFileName);
        try {
          await sharedDownloadFile(this.getDraftDownloadUrl(provider, model), draftPath, {
            signal,
            onProgress: (downloadedBytes) => emitCombined(stats.size + downloadedBytes),
          });
          const draftStats = await fsPromises.stat(draftPath);
          if (draftStats.size < MIN_FILE_SIZE) {
            await fsPromises.unlink(draftPath).catch(() => {});
            debugLogger.warn("MTP drafter file too small, keeping model without it", { modelId });
          }
        } catch (draftError) {
          await fsPromises.unlink(draftPath).catch(() => {});
          debugLogger.warn("MTP drafter download failed, keeping model without it", {
            modelId,
            error: draftError.message,
          });
        }
      }

      return modelPath;
    } catch (error) {
      if (error.isAbort) {
        throw new ModelError("Download cancelled by user", "DOWNLOAD_CANCELLED", { modelId });
      }
      if (error.isHttpError) {
        throw new ModelError(`Download failed with status ${error.statusCode}`, "DOWNLOAD_FAILED", {
          statusCode: error.statusCode,
        });
      }
      if (!(error instanceof ModelError)) {
        throw new ModelError(`Network error: ${error.message}`, "NETWORK_ERROR", {
          error: error.message,
        });
      }
      throw error;
    } finally {
      if (this.activeDownloads.delete(modelId)) {
        this.downloadLifecycleVersion += 1;
      }
      this.activeRequests.delete(modelId);
      this.downloadProgress.delete(modelId);
    }
  }

  getDownloadUrl(provider, model) {
    const baseUrl = provider.baseUrl || "https://huggingface.co";
    return `${baseUrl}/${model.hfRepo}/resolve/main/${model.fileName}`;
  }

  getDraftDownloadUrl(provider, model) {
    const baseUrl = provider.baseUrl || "https://huggingface.co";
    return `${baseUrl}/${model.draftHfRepo}/resolve/main/${model.draftFileName}`;
  }

  modelHasDrafter(model) {
    return Boolean(model && model.draftHfRepo && model.draftFileName && model.draftSizeBytes);
  }

  // Opportunistic MTP drafter path: only when declared and the file passes the
  // same >1MB validity gate as models. Returns null otherwise (start without MTP).
  async resolveDraftPath(model) {
    if (!this.modelHasDrafter(model)) return null;
    const draftPath = path.join(this.modelsDir, model.draftFileName);
    if (await this.checkModelValid(draftPath)) return draftPath;
    return null;
  }

  cancelDownload(modelId) {
    const entry = this.activeRequests.get(modelId);
    if (entry) {
      // Keep the guard and status visible until downloadModel's finally block
      // has finished cleaning up the writer and its temporary file.
      entry.abort();
      return true;
    }
    return false;
  }

  async deleteModel(modelId) {
    this.ensureInitialized();
    const modelInfo = this.findModelById(modelId);
    if (!modelInfo) {
      throw new ModelNotFoundError(modelId);
    }

    const modelPath = path.join(this.modelsDir, modelInfo.model.fileName);

    if (await this.checkFileExists(modelPath)) {
      await fsPromises.unlink(modelPath);
    }

    // Remove the drafter too when present, best effort (ignore ENOENT).
    if (modelInfo.model.draftFileName) {
      const draftPath = path.join(this.modelsDir, modelInfo.model.draftFileName);
      await fsPromises.unlink(draftPath).catch(() => {});
    }
  }

  async deleteAllModels() {
    this.ensureInitialized();
    try {
      if (fsPromises.rm) {
        await fsPromises.rm(this.modelsDir, { recursive: true, force: true });
      } else {
        const entries = await fsPromises
          .readdir(this.modelsDir, { withFileTypes: true })
          .catch(() => []);
        for (const entry of entries) {
          const fullPath = path.join(this.modelsDir, entry.name);
          if (entry.isDirectory()) {
            await fsPromises.rmdir(fullPath, { recursive: true }).catch(() => {});
          } else {
            await fsPromises.unlink(fullPath).catch(() => {});
          }
        }
      }
    } catch (error) {
      throw new ModelError(
        `Failed to delete models directory: ${error.message}`,
        "DELETE_ALL_ERROR",
        { error: error.message }
      );
    } finally {
      await this.ensureModelsDirExists();
    }
  }

  _waitForQueue(operation, signal) {
    if (!signal) return operation;
    if (signal.aborted) return Promise.reject(createAbortError("llama-server request aborted"));

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(createAbortError("llama-server request aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  _enqueueInference(operation, signal) {
    const previous = this.inferenceTail;
    const queued = previous
      .catch(() => {})
      .then(async () => {
        if (signal?.aborted) throw createAbortError("llama-server request aborted");
        return operation();
      });
    this.inferenceTail = queued.catch(() => {});
    return this._waitForQueue(queued, signal);
  }

  runInference(modelId, prompt, options = {}) {
    const queuedAt = Date.now();
    return this._enqueueInference(() => {
      const queueWaitMs = Date.now() - queuedAt;
      if (queueWaitMs > 0) {
        debugLogger.logReasoning("INFERENCE_WAITED_FOR_SERVER_QUEUE", {
          modelId,
          queueWaitMs,
        });
      }
      return this._runInference(modelId, prompt, options);
    }, options.signal);
  }

  async _runInference(modelId, prompt, options = {}) {
    if (!options.isPromptWarmup) {
      // A chat/agent/translation request uses a different prefix and can evict
      // the cleanup prompt from llama.cpp's active cache. Mark it dirty when
      // that work begins. Normal cleanup inference uses the same system
      // prompt and keeps the warm marker, avoiding a redundant prefill at the
      // start of every recording.
      if (
        this.promptWarmPayload &&
        (modelId !== this.promptWarmPayload.modelId ||
          (options.systemPrompt || "") !== this.promptWarmPayload.systemPrompt)
      ) {
        this.promptWarmState = null;
      }
    }

    this.ensureInitialized();
    const startTime = Date.now();
    debugLogger.logReasoning("INFERENCE_START", {
      modelId,
      promptLength: prompt.length,
      options: {
        ...options,
        systemPrompt: options.systemPrompt ? "[set]" : "[not set]",
        signal: options.signal ? "[set]" : "[not set]",
      },
    });

    // Ensure server is available
    if (!this.serverManager.isAvailable()) {
      debugLogger.logReasoning("INFERENCE_SERVER_NOT_AVAILABLE", {});
      throw new ModelError(
        "llama-server binary not found. Please ensure the app is installed correctly.",
        "LLAMASERVER_NOT_FOUND"
      );
    }

    const modelInfo = this.findModelById(modelId);
    if (!modelInfo) {
      debugLogger.logReasoning("INFERENCE_MODEL_NOT_FOUND", { modelId });
      throw new ModelNotFoundError(modelId);
    }

    const modelPath = path.join(this.modelsDir, modelInfo.model.fileName);
    debugLogger.logReasoning("INFERENCE_MODEL_PATH", {
      modelPath,
      modelName: modelInfo.model.name,
      providerId: modelInfo.provider.id,
    });

    if (!(await this.checkModelValid(modelPath))) {
      debugLogger.logReasoning("INFERENCE_MODEL_INVALID", { modelId, modelPath });
      throw new ModelError(
        `Model ${modelId} is not downloaded or is corrupted`,
        "MODEL_NOT_DOWNLOADED",
        { modelId }
      );
    }

    // Start/restart server if needed or if model changed
    if (!this.serverManager.ready || this.currentServerModelId !== modelId) {
      debugLogger.logReasoning("INFERENCE_STARTING_SERVER", {
        currentModel: this.currentServerModelId,
        requestedModel: modelId,
        serverReady: this.serverManager.ready,
      });

      await this.serverManager.start(modelPath, await this.serverStartOptions(modelInfo));
      this.currentServerModelId = modelId;

      debugLogger.logReasoning("INFERENCE_SERVER_STARTED", {
        port: this.serverManager.port,
        model: modelId,
      });
    }

    // Build messages for chat completion
    const messages = [
      { role: "system", content: options.systemPrompt || "" },
      { role: "user", content: prompt },
    ];

    debugLogger.logReasoning("INFERENCE_SENDING_REQUEST", {
      messageCount: messages.length,
      systemPromptLength: (options.systemPrompt || "").length,
      userPromptLength: prompt.length,
    });

    try {
      const result = await this.serverManager.inference(messages, {
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 512,
        disableThinking: options.disableThinking,
        requireCompleteOutput: options.requireCompleteOutput,
        signal: options.signal,
      });

      const totalTime = Date.now() - startTime;
      debugLogger.logReasoning("INFERENCE_SUCCESS", {
        totalTimeMs: totalTime,
        resultLength: result.length,
      });

      return result;
    } catch (error) {
      const totalTime = Date.now() - startTime;
      debugLogger.logReasoning("INFERENCE_FAILED", {
        totalTimeMs: totalTime,
        error: error.message,
      });
      if (error.name === "AbortError") throw error;
      throw new ModelError(`Inference failed: ${error.message}`, "INFERENCE_FAILED", {
        error: error.message,
      });
    }
  }

  async _startServerForModel(modelId) {
    this.ensureInitialized();
    if (!this.serverManager.isAvailable()) {
      throw new ModelError(
        "llama-server binary not found. Please ensure the app is installed correctly.",
        "LLAMASERVER_NOT_FOUND"
      );
    }

    const modelInfo = this.findModelById(modelId);
    if (!modelInfo) throw new ModelNotFoundError(modelId);

    const modelPath = path.join(this.modelsDir, modelInfo.model.fileName);
    if (!(await this.checkModelValid(modelPath))) {
      throw new ModelError(
        `Model ${modelId} is not downloaded or is corrupted`,
        "MODEL_NOT_DOWNLOADED",
        { modelId }
      );
    }

    await this.serverManager.start(modelPath, await this.serverStartOptions(modelInfo));
    this.currentServerModelId = modelId;
    const port = this.serverManager.port;
    if (!Number.isInteger(port) || port <= 0) {
      await this.serverManager.stop();
      this.currentServerModelId = null;
      throw new ModelError("llama-server started without a valid port", "LLAMASERVER_INVALID_PORT");
    }
    return port;
  }

  startServer(modelId) {
    return this._enqueueInference(() => this._startServerForModel(modelId));
  }

  beginExternalInferenceLease(
    modelId,
    ownerId,
    { timeoutMs = EXTERNAL_INFERENCE_LEASE_TIMEOUT_MS } = {}
  ) {
    if (ownerId === undefined || ownerId === null) {
      return Promise.reject(new Error("An external inference lease requires an owner"));
    }

    const token = crypto.randomUUID();
    let resolveReady;
    let rejectReady;
    let resolveRelease;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const released = new Promise((resolve) => {
      resolveRelease = resolve;
    });
    const record = {
      token,
      ownerId,
      modelId,
      state: "queued",
      timer: null,
      resolveRelease,
      releasePromise: null,
      completion: null,
    };
    this.externalInferenceLeases.set(token, record);

    record.completion = this._enqueueInference(async () => {
      if (record.state === "released") {
        throw createAbortError("External llama-server lease was cancelled before startup");
      }

      const port = await this._startServerForModel(modelId);
      if (record.state === "released") {
        throw createAbortError("External llama-server lease was cancelled during startup");
      }

      // Renderer-owned HTTP requests bypass _runInference, so conservatively
      // invalidate the cleanup prefix before the renderer can touch the cache.
      this.promptWarmState = null;
      record.state = "active";
      record.timer = setTimeout(
        () => {
          void this.releaseExternalInferenceLease(token, ownerId, "timeout");
        },
        Math.max(1, timeoutMs)
      );
      record.timer.unref?.();
      resolveReady({ port, leaseToken: token });

      await released;
    })
      .catch((error) => {
        rejectReady(error);
        throw error;
      })
      .finally(() => {
        if (record.timer) clearTimeout(record.timer);
        if (this.externalInferenceLeases.get(token) === record) {
          this.externalInferenceLeases.delete(token);
        }
      });
    // The queue owns completion; callers await `ready`, then explicitly release.
    record.completion.catch(() => {});
    return ready;
  }

  async releaseExternalInferenceLease(token, ownerId, reason = "renderer-release") {
    const record = this.externalInferenceLeases.get(token);
    if (!record || record.ownerId !== ownerId) return false;
    if (!record.releasePromise) {
      record.releasePromise = (async () => {
        const wasActive = record.state === "active";
        record.state = "releasing";
        if (wasActive && reason !== "renderer-release") {
          // A renderer-owned HTTP request can outlive its IPC owner. Kill that
          // request before opening the queue or a restart could overlap it.
          await this.serverManager.stop().catch((error) => {
            debugLogger.warn("Failed to stop llama-server while recovering external lease", {
              modelId: record.modelId,
              reason,
              error: error.message,
            });
          });
          this.currentServerModelId = null;
          this.promptWarmState = null;
        }
        record.state = "released";
        record.resolveRelease(reason);
        await record.completion.catch(() => {});
        return true;
      })();
    }
    return record.releasePromise;
  }

  async releaseExternalInferenceLeasesForOwner(ownerId, reason = "owner-gone") {
    const owned = [...this.externalInferenceLeases.values()].filter(
      (record) => record.ownerId === ownerId
    );
    await Promise.all(
      owned.map((record) => this.releaseExternalInferenceLease(record.token, ownerId, reason))
    );
    return owned.length;
  }

  _restartServer({ resetGpuDetection = false } = {}) {
    const previousModelId = this.currentServerModelId;
    if (resetGpuDetection) this.serverManager.resetGpuDetection();
    return this._stopServer().then(async () => {
      if (previousModelId) await this._prewarmServer(previousModelId);
      return true;
    });
  }

  restartServer() {
    return this._enqueueInference(() => this._restartServer());
  }

  resetGpuAndRestart() {
    return this._enqueueInference(async () => {
      return this._restartServer({ resetGpuDetection: true });
    });
  }

  stopServer() {
    return this._enqueueInference(() => this._stopServer());
  }

  async _stopServer() {
    await this.serverManager.stop();
    this.currentServerModelId = null;
  }

  getServerStatus() {
    return this.serverManager.getStatus();
  }

  prewarmServer(modelId) {
    return this._enqueueInference(() => this._prewarmServer(modelId));
  }

  async _prewarmServer(modelId) {
    if (!modelId) return false;
    this.ensureInitialized();

    const modelInfo = this.findModelById(modelId);
    if (!modelInfo) return false;

    const modelPath = path.join(this.modelsDir, modelInfo.model.fileName);
    if (!(await this.checkModelValid(modelPath))) return false;

    if (!this.serverManager.isAvailable()) return false;

    try {
      await this.serverManager.start(modelPath, await this.serverStartOptions(modelInfo));
      this.currentServerModelId = modelId;
      debugLogger.info("llama-server pre-warmed", { modelId });
      return true;
    } catch (error) {
      debugLogger.warn("Failed to pre-warm llama-server", { error: error.message });
      return false;
    }
  }

  async prewarmPrompt(
    { modelId, systemPrompt, userPrompt, disableThinking = true, cacheKey = "" },
    { force = false } = {}
  ) {
    if (!modelId || !systemPrompt || !userPrompt) return false;

    const payload = { modelId, systemPrompt, userPrompt, disableThinking, cacheKey };
    this.promptWarmPayload = payload;
    const key = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    // Identical callers share the newest queued warmup. Each non-identical
    // warmup reserves the single inference queue immediately, so a foreground
    // request admitted later cannot pass validation/startup while it runs.
    if (this.promptWarmPending > 0 && this.promptWarmLatestKey === key) {
      return this.promptWarmTail;
    }

    this.promptWarmPending += 1;
    this.promptWarmLatestKey = key;
    debugLogger.logReasoning("PROMPT_WARMUP_QUEUED", {
      modelId,
      promptKey: key.slice(0, 12),
      systemPromptLength: systemPrompt.length,
      userPromptLength: userPrompt.length,
      pendingWarmups: this.promptWarmPending,
    });
    const warmup = this._enqueueInference(async () => {
      // Re-check only after this prewarm reaches the server queue. A foreground
      // request can be admitted in the same tick and evict the prefix before
      // this work begins, so checking at call time would leave a false marker.
      const currentPid = this.serverManager.process?.pid ?? null;
      if (
        !force &&
        currentPid !== null &&
        this.currentServerModelId === modelId &&
        this.promptWarmState?.key === key &&
        this.promptWarmState?.pid === currentPid
      ) {
        debugLogger.logReasoning("PROMPT_WARMUP_CACHE_HIT", {
          modelId,
          promptKey: key.slice(0, 12),
          systemPromptLength: systemPrompt.length,
          userPromptLength: userPrompt.length,
        });
        return true;
      }

      await this._runInference(modelId, userPrompt, {
        systemPrompt,
        temperature: 0,
        maxTokens: 1,
        disableThinking,
        isPromptWarmup: true,
      });

      const pid = this.serverManager.process?.pid ?? null;
      if (pid !== null && this.currentServerModelId === modelId) {
        this.promptWarmState = { key, pid };
      }
      debugLogger.info("llama-server cleanup prompt pre-warmed", {
        modelId,
        promptKey: key.slice(0, 12),
        systemPromptLength: systemPrompt.length,
        userPromptLength: userPrompt.length,
      });
      return true;
    }).finally(() => {
      this.promptWarmPending -= 1;
      if (this.promptWarmPending === 0) this.promptWarmLatestKey = null;
    });

    this.promptWarmTail = warmup;
    return warmup;
  }

  async prewarmLatestPrompt() {
    if (!this.promptWarmPayload) return false;
    return this.prewarmPrompt(this.promptWarmPayload);
  }

  async waitForPromptWarmup() {
    let pendingWarmups = this.promptWarmTail;
    while (this.promptWarmPending > 0) {
      await pendingWarmups.catch(() => {});
      if (pendingWarmups === this.promptWarmTail) break;
      pendingWarmups = this.promptWarmTail;
    }
  }
}

module.exports = {
  default: new ModelManager(),
  ModelError,
  ModelNotFoundError,
};
