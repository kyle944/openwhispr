function createMeetingTranscriptionLifecycle({
  start,
  stop,
  abort = stop,
  onAbortRequested = () => {},
  onError = () => {},
}) {
  const authorizationChangedResult = () => ({
    success: false,
    reason: "authorization-changed",
    code: "AUTHORIZATION_BOUNDARY_CHANGED",
  });
  let operationTail = Promise.resolve();
  const sessions = new Map();

  const enqueue = (operation) => {
    const pending = operationTail.then(operation, operation);
    operationTail = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  };

  const detachOwnerListeners = (session) => {
    if (!session.ownerLossHandler) return;

    session.ownerWebContents?.removeListener?.("destroyed", session.ownerLossHandler);
    session.ownerWebContents?.removeListener?.("render-process-gone", session.ownerLossHandler);
    session.ownerLossHandler = null;
  };

  const removeSession = (session) => {
    detachOwnerListeners(session);
    if (sessions.get(session.sessionId) === session) {
      sessions.delete(session.sessionId);
    }
  };

  const resolveSession = (expectedSessionId) => {
    if (expectedSessionId != null) return sessions.get(expectedSessionId) ?? null;
    return sessions.values().next().value ?? null;
  };

  const stopSession = (expectedSessionId) => {
    const session = resolveSession(expectedSessionId);
    if (!session) {
      return Promise.resolve({ success: false, reason: "stale-session" });
    }
    if (session.abortPromise) return session.abortPromise;
    if (session.stopPromise) return session.stopPromise;

    session.stopRequested = true;
    session.state = "stopping";
    const gracefulStop = enqueue(async () => {
      try {
        if (!session.startSucceeded) {
          return session.abortRequested ? authorizationChangedResult() : { success: true };
        }
        const result = await stop(session.sessionId, session.abortController.signal);
        return session.abortRequested ? authorizationChangedResult() : result;
      } finally {
        removeSession(session);
      }
    });
    session.stopPromise = Promise.race([gracefulStop, session.authorizationChanged]);
    return session.stopPromise;
  };

  const abortSession = (expectedSessionId) => {
    const session = resolveSession(expectedSessionId);
    if (!session) {
      return Promise.resolve({ success: false, reason: "stale-session" });
    }
    if (session.abortPromise) return session.abortPromise;

    session.abortRequested = true;
    session.state = "aborting";
    session.abortController.abort();
    onAbortRequested(session.sessionId);
    session.resolveAuthorizationChanged(authorizationChangedResult());
    if (session.stopPromise) {
      session.abortPromise = Promise.resolve()
        .then(() => abort(session.sessionId))
        .finally(() => removeSession(session));
      return session.abortPromise;
    }
    session.abortPromise = enqueue(async () => {
      try {
        return await abort(session.sessionId);
      } finally {
        removeSession(session);
      }
    });
    return session.abortPromise;
  };

  const startSession = ({ sessionId, ownerWebContents, options }) => {
    const operationInProgress = [...sessions.values()].some(
      (session) => session.state !== "stopping"
    );
    if (operationInProgress || sessions.has(sessionId)) {
      return Promise.resolve({ success: false, error: "Operation in progress" });
    }

    let resolveAuthorizationChanged;
    const authorizationChanged = new Promise((resolve) => {
      resolveAuthorizationChanged = resolve;
    });
    const session = {
      sessionId,
      ownerWebContents,
      state: "queued",
      startSucceeded: false,
      stopRequested: false,
      abortRequested: false,
      abortController: new AbortController(),
      authorizationChanged,
      resolveAuthorizationChanged,
      stopPromise: null,
      abortPromise: null,
      ownerLossHandler: null,
    };
    sessions.set(sessionId, session);

    const startPromise = enqueue(async () => {
      if (session.stopRequested) {
        removeSession(session);
        return { success: false, error: "Start canceled", reason: "canceled", sessionId };
      }

      session.state = "starting";
      try {
        const result = await start({ sessionId, ownerWebContents, options });
        session.startSucceeded = result?.success === true;
        if (!session.startSucceeded) {
          removeSession(session);
        } else if (!session.stopRequested && !session.abortRequested) {
          session.state = "active";
        }
        return result;
      } catch (error) {
        removeSession(session);
        throw error;
      }
    });

    const handleOwnerLoss = () => {
      void stopSession(sessionId).catch((error) => {
        onError(error, sessionId);
      });
    };
    session.ownerLossHandler = handleOwnerLoss;
    ownerWebContents?.once?.("destroyed", handleOwnerLoss);
    ownerWebContents?.once?.("render-process-gone", handleOwnerLoss);

    if (ownerWebContents?.isDestroyed?.()) {
      handleOwnerLoss();
    }

    return startPromise;
  };

  return { abortSession, startSession, stopSession };
}

module.exports = createMeetingTranscriptionLifecycle;
