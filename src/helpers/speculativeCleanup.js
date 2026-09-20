const debugLogger = require("./debugLogger");

const DEFAULT_DEBOUNCE_MS = 350;
const DEFAULT_FINAL_WAIT_MS = 180;
const DEFAULT_MIN_CHARACTERS = 8;
const DEFAULT_MIN_WORDS = 2;

const cancellationError = () => {
  const error = new Error("Speculative cleanup session was cancelled");
  error.name = "AbortError";
  return error;
};

const settledWithin = (promise, timeoutMs) =>
  Promise.race([
    promise.then((value) => ({ settled: true, value })),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
      timer.unref?.();
    }),
  ]);

class SpeculativeCleanupScheduler {
  constructor(options = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.finalWaitMs = options.finalWaitMs ?? DEFAULT_FINAL_WAIT_MS;
    this.minCharacters = options.minCharacters ?? DEFAULT_MIN_CHARACTERS;
    this.minWords = options.minWords ?? DEFAULT_MIN_WORDS;
    this.logger = options.logger || debugLogger;
    this.sessionId = 0;
    this.enabled = false;
    this.prepare = null;
    this.revision = 0;
    this.timer = null;
    this.pending = null;
    this.active = null;
    this.completed = null;
    this.launchAfterActive = false;
  }

  startSession({ enabled, prepare } = {}) {
    this.cancel("session-replaced");
    this.enabled = enabled === true && typeof prepare === "function";
    this.prepare = this.enabled ? prepare : null;
    this.logger.debug("Speculative cleanup session started", {
      sessionId: this.sessionId,
      enabled: this.enabled,
    });
    return this.sessionId;
  }

  update(text) {
    if (!this.enabled || typeof text !== "string") return false;

    const snapshot = text.trim();
    const wordCount = snapshot ? snapshot.split(/\s+/u).length : 0;

    if (snapshot.length < this.minCharacters || wordCount < this.minWords) {
      this.revision += 1;
      this._clearTimer();
      this.pending = null;
      this.completed = null;
      this._abortActive("snapshot-too-short");
      return false;
    }

    let descriptor;
    try {
      descriptor = this.prepare(snapshot);
    } catch (error) {
      this.logger.debug("Speculative cleanup snapshot preparation failed", {
        sessionId: this.sessionId,
        revision: this.revision,
        error: error.message,
      });
      this.revision += 1;
      this._clearTimer();
      this.pending = null;
      this.completed = null;
      this._abortActive("prepare-failed");
      return false;
    }
    if (!descriptor?.key || typeof descriptor.run !== "function") {
      this.revision += 1;
      this._clearTimer();
      this.pending = null;
      this.completed = null;
      this._abortActive("ineligible-snapshot");
      return false;
    }

    if (this.completed?.key === descriptor.key && this.completed.sessionId === this.sessionId) {
      this._clearTimer();
      this.pending = null;
      return true;
    }
    if (
      this.active?.key === descriptor.key &&
      this.active.sessionId === this.sessionId &&
      !this.active.controller.signal.aborted
    ) {
      this._clearTimer();
      this.pending = null;
      return true;
    }
    if (this.pending?.key === descriptor.key && this.pending.sessionId === this.sessionId) {
      return true;
    }

    this.revision += 1;
    const revision = this.revision;
    this._clearTimer();
    // A previous pending snapshot may already have reached its debounce while
    // an older request was draining. This new revision owns a fresh debounce;
    // do not let the older timer's launch flag start it early.
    this.launchAfterActive = false;
    this.completed = null;

    this.pending = { ...descriptor, revision, sessionId: this.sessionId };
    if (this.active && this.active.key !== descriptor.key) {
      this._abortActive("newer-snapshot");
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this._launchPending(revision);
    }, this.debounceMs);
    this.timer.unref?.();
    return true;
  }

  async finalize({ key, run }) {
    if (!key || typeof run !== "function") {
      this.cancel("invalid-final-request");
      return run();
    }

    const sessionId = this.sessionId;
    this._clearTimer();
    this.pending = null;

    if (this.enabled && this.completed?.key === key && this.completed.sessionId === sessionId) {
      const value = this.completed.value;
      this._finishSession("cache-hit");
      return value;
    }

    if (this.enabled && this.active?.key === key && this.active.sessionId === sessionId) {
      const active = this.active;
      const activePromise = active.promise;
      const quick = await settledWithin(activePromise, this.finalWaitMs);
      if (!quick.settled) {
        this.logger.debug("Speculative cleanup promoted to foreground", {
          sessionId,
          revision: active.revision,
          boundedWaitMs: this.finalWaitMs,
        });
      }
      const outcome = quick.settled ? quick.value : await activePromise;
      if (this.sessionId !== sessionId || !this.enabled) throw cancellationError();
      if (outcome.ok) {
        this._finishSession("matched-active", sessionId);
        return outcome.value;
      }
      // Speculation is opportunistic. A failed background request must not
      // replace the normal foreground attempt and its existing raw fallback.
    } else {
      await this._abortActive("final-request-mismatch");
      if (this.sessionId !== sessionId) throw cancellationError();
    }

    this._finishSession("foreground", sessionId);
    return run();
  }

  cancel(reason = "cancelled") {
    const cancelledSessionId = this.sessionId;
    this.sessionId += 1;
    this._clearTimer();
    if (this.active) this.active.controller.abort();
    this.enabled = false;
    this.prepare = null;
    this.pending = null;
    this.completed = null;
    this.launchAfterActive = false;
    this.revision += 1;
    this.logger.debug("Speculative cleanup session cancelled", {
      sessionId: cancelledSessionId,
      reason,
    });
  }

  async interrupt(reason = "foreground-request") {
    const activePromise = this.active?.promise || null;
    this.cancel(reason);
    if (activePromise) await activePromise;
  }

  _launchPending(expectedRevision) {
    if (!this.enabled || !this.pending || this.pending.revision !== expectedRevision) return;
    if (this.active) {
      this.launchAfterActive = true;
      return;
    }

    const job = this.pending;
    this.pending = null;
    const controller = new AbortController();
    const active = {
      key: job.key,
      revision: job.revision,
      sessionId: job.sessionId,
      controller,
      promise: null,
    };
    this.active = active;
    this.logger.debug("Speculative cleanup started", {
      sessionId: job.sessionId,
      revision: job.revision,
    });

    active.promise = Promise.resolve()
      .then(() => job.run(controller.signal))
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error })
      )
      .then((outcome) => {
        if (
          outcome.ok &&
          this.enabled &&
          this.sessionId === job.sessionId &&
          this.revision === job.revision &&
          !controller.signal.aborted
        ) {
          this.completed = {
            key: job.key,
            value: outcome.value,
            revision: job.revision,
            sessionId: job.sessionId,
          };
        }
        return outcome;
      })
      .finally(() => {
        if (this.active === active) this.active = null;
        const shouldLaunch = this.launchAfterActive;
        this.launchAfterActive = false;
        if (shouldLaunch && this.pending) this._launchPending(this.pending.revision);
      });
  }

  async _abortActive(reason) {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    this.logger.debug("Speculative cleanup aborted", {
      sessionId: active.sessionId,
      revision: active.revision,
      reason,
    });
    await active.promise;
  }

  _clearTimer() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  _finishSession(reason, expectedSessionId = this.sessionId) {
    if (this.sessionId !== expectedSessionId) return false;
    this._clearTimer();
    this.enabled = false;
    this.prepare = null;
    this.pending = null;
    this.completed = null;
    this.launchAfterActive = false;
    this.logger.debug("Speculative cleanup session finished", {
      sessionId: this.sessionId,
      reason,
    });
    return true;
  }
}

module.exports = {
  SpeculativeCleanupScheduler,
  speculativeCleanup: new SpeculativeCleanupScheduler(),
};
