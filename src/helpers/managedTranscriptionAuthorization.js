const AUTHORIZATION_BOUNDARY_CHANGED = "AUTHORIZATION_BOUNDARY_CHANGED";
const MANAGED_CONFIG_UNAVAILABLE = "MANAGED_CONFIG_UNAVAILABLE";
const MANAGED_MODEL_REQUIRED = "MANAGED_MODEL_REQUIRED";
const MANAGED_WORKSPACE_REQUIRED = "MANAGED_WORKSPACE_REQUIRED";

function authorizationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeModel(model) {
  return typeof model === "string" && model.length > 0 ? model : null;
}

function createBinding(context, route, managed) {
  return Object.freeze({
    accountId: context?.accountId ?? null,
    workspaceId: context?.workspaceId ?? null,
    authGeneration: context?.authGeneration ?? null,
    configGeneration: context?.configGeneration ?? null,
    managed,
    provider: route.provider,
    model: normalizeModel(route.model),
  });
}

function assertExactRoute(context, route) {
  if (
    !context ||
    context.provider !== route.provider ||
    normalizeModel(context.model) !== normalizeModel(route.model)
  ) {
    throw authorizationError(
      AUTHORIZATION_BOUNDARY_CHANGED,
      "Transcription authorization changed. Retry the request."
    );
  }
}

function assertExactIdentity(context, result) {
  if (
    result.accountId !== context.accountId ||
    result.workspaceId !== context.workspaceId ||
    result.authGeneration !== context.authGeneration
  ) {
    throw authorizationError(
      AUTHORIZATION_BOUNDARY_CHANGED,
      "Transcription authorization changed. Retry the request."
    );
  }
}

async function authorizeManagedTranscriptionStart({ context, route, enterpriseIdentityManager }) {
  const authState = enterpriseIdentityManager.getAuthState();
  if (!authState.authenticated) {
    if (
      context &&
      (context.accountId !== null ||
        context.workspaceId !== null ||
        context.authGeneration !== null ||
        context.configGeneration !== null ||
        context.managed !== false)
    ) {
      throw authorizationError(
        AUTHORIZATION_BOUNDARY_CHANGED,
        "Transcription authorization changed. Retry the request."
      );
    }
    if (context) assertExactRoute(context, route);
    return { managed: false, binding: createBinding(context, route, false) };
  }

  if (context?.accountId && !context.workspaceId) {
    throw authorizationError(
      MANAGED_WORKSPACE_REQUIRED,
      "An active workspace is required for managed transcription."
    );
  }
  if (
    !context ||
    typeof context.accountId !== "string" ||
    typeof context.workspaceId !== "string" ||
    !Number.isSafeInteger(context.authGeneration) ||
    context.authGeneration !== authState.authGeneration
  ) {
    throw authorizationError(
      AUTHORIZATION_BOUNDARY_CHANGED,
      "Transcription authorization changed. Retry the request."
    );
  }
  assertExactRoute(context, route);

  const activeIdentity = enterpriseIdentityManager.getActiveIdentity?.() ?? null;
  if (
    !activeIdentity ||
    typeof activeIdentity.accountId !== "string" ||
    typeof activeIdentity.workspaceId !== "string" ||
    !Number.isSafeInteger(activeIdentity.authGeneration) ||
    activeIdentity.accountId !== context.accountId ||
    activeIdentity.workspaceId !== context.workspaceId ||
    activeIdentity.authGeneration !== context.authGeneration
  ) {
    throw authorizationError(
      AUTHORIZATION_BOUNDARY_CHANGED,
      "Transcription authorization changed. Retry the request."
    );
  }

  let result;
  let configUnavailable = false;
  try {
    result = await enterpriseIdentityManager.getConfig(activeIdentity);
  } catch {
    configUnavailable = true;
  }
  if (enterpriseIdentityManager.getActiveIdentity?.() !== activeIdentity) {
    throw authorizationError(
      AUTHORIZATION_BOUNDARY_CHANGED,
      "Transcription authorization changed. Retry the request."
    );
  }
  if (configUnavailable) {
    throw authorizationError(
      MANAGED_CONFIG_UNAVAILABLE,
      "Managed transcription configuration is unavailable."
    );
  }
  if (!result || typeof result !== "object") {
    throw authorizationError(
      MANAGED_CONFIG_UNAVAILABLE,
      "Managed transcription configuration is unavailable."
    );
  }
  assertExactIdentity(activeIdentity, result);

  if (!result.success) {
    if (
      result.enforcementRequired === false &&
      context.configGeneration === null &&
      context.managed === false
    ) {
      return { managed: false, binding: createBinding(context, route, false) };
    }
    throw authorizationError(
      MANAGED_CONFIG_UNAVAILABLE,
      "Managed transcription configuration is unavailable."
    );
  }

  if (
    result.config?.workspaceId !== activeIdentity.workspaceId ||
    result.config?.generation !== context.configGeneration
  ) {
    throw authorizationError(
      AUTHORIZATION_BOUNDARY_CHANGED,
      "Transcription authorization changed. Retry the request."
    );
  }

  const approved = result.config.localModels?.transcription ?? [];
  if (approved.length === 0) {
    if (context.managed !== false) {
      throw authorizationError(
        AUTHORIZATION_BOUNDARY_CHANGED,
        "Transcription authorization changed. Retry the request."
      );
    }
    return { managed: false, binding: createBinding(context, route, false) };
  }

  const routeApproved = approved.some(
    (selection) =>
      selection.provider === route.provider && selection.modelId === normalizeModel(route.model)
  );
  if (context.managed !== true || !routeApproved) {
    throw authorizationError(
      MANAGED_MODEL_REQUIRED,
      "A workspace-managed local transcription model is required."
    );
  }
  return { managed: true, binding: createBinding(context, route, true) };
}

module.exports = {
  AUTHORIZATION_BOUNDARY_CHANGED,
  MANAGED_CONFIG_UNAVAILABLE,
  MANAGED_MODEL_REQUIRED,
  MANAGED_WORKSPACE_REQUIRED,
  authorizeManagedTranscriptionStart,
};
