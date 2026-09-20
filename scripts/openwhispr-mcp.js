#!/usr/bin/env node
"use strict";

// A deliberately small stdio adapter for the desktop app's authenticated local
// CLI bridge. It never opens a listener and every tool request re-reads the
// bridge credential so an OpenWhispr restart rotates the token safely.

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-06-18"]);
const SUPPORTED_PROTOCOL_VERSIONS = [MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS];
const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT_MIN = 8200;
const BRIDGE_PORT_MAX = 8219;
const BRIDGE_TIMEOUT_MS = 5_000;
const MAX_BRIDGE_RESPONSE_BYTES = 1 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_OUTBOUND_MESSAGE_BYTES = 64 * 1024;
const MAX_CONCURRENT_BRIDGE_REQUESTS = 4;
const MAX_QUEUED_BRIDGE_REQUESTS = 16;
const MAX_REQUEST_ID_BYTES = 4 * 1024;
const MAX_SEARCH_QUERY_LENGTH = 512;
const MAX_SEARCH_RESULTS = 10;
const MAX_NOTE_CONTENT_BYTES = 32 * 1024;
const MAX_NOTE_TRANSCRIPT_BYTES = 32 * 1024;
const MAX_SEARCH_EXCERPT_BYTES = 1_600;
const MAX_TITLE_BYTES = 512;

class McpUserError extends Error {}

function createRequestLimiter(maxConcurrent, maxQueued) {
  let activeRequests = 0;
  const queuedRequests = [];

  return function schedule(operation) {
    return new Promise((resolve, reject) => {
      const run = () => {
        activeRequests += 1;
        Promise.resolve()
          .then(operation)
          .then(resolve, reject)
          .finally(() => {
            activeRequests -= 1;
            queuedRequests.shift()?.();
          });
      };
      if (activeRequests < maxConcurrent) run();
      else if (queuedRequests.length < maxQueued) queuedRequests.push(run);
      else reject(new McpUserError("OpenWhispr local bridge is busy. Retry shortly."));
    });
  };
}

const scheduleBridgeRequest = createRequestLimiter(
  MAX_CONCURRENT_BRIDGE_REQUESTS,
  MAX_QUEUED_BRIDGE_REQUESTS
);

function getBridgeFilePath(home = os.homedir()) {
  return path.join(home, ".openwhispr", "cli-bridge.json");
}

function readBridgeCredentials({
  bridgeFilePath = getBridgeFilePath(),
  fsModule = fs,
  platform = process.platform,
  getuid = typeof process.getuid === "function" ? process.getuid.bind(process) : null,
} = {}) {
  let descriptor;
  let stat;
  let raw;
  try {
    const noFollow = fsModule.constants?.O_NOFOLLOW;
    if (platform !== "win32" && typeof noFollow !== "number") {
      throw new McpUserError("OpenWhispr local bridge credentials cannot be opened safely.");
    }
    descriptor = fsModule.openSync(
      bridgeFilePath,
      fsModule.constants.O_RDONLY | (platform === "win32" ? 0 : noFollow)
    );
    // Inspect and read the same opened file descriptor. This closes the
    // symlink/time-of-check-time-of-use window around the bearer credential.
    stat = fsModule.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new McpUserError("OpenWhispr local bridge credentials are invalid.");
    }
    // Windows uses ACLs rather than POSIX modes. On Unix, refuse a credential
    // file readable by group or other users before its bearer token is read.
    if (platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
      throw new McpUserError("OpenWhispr local bridge credentials must have mode 0600.");
    }
    if (platform !== "win32" && getuid && stat.uid !== getuid()) {
      throw new McpUserError("OpenWhispr local bridge credentials must be owned by this user.");
    }
    raw = fsModule.readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error instanceof McpUserError) throw error;
    if (error.code === "ENOENT") {
      throw new McpUserError("OpenWhispr desktop app is not running. Start it and retry.");
    }
    throw new McpUserError("OpenWhispr local bridge credentials cannot be read.");
  } finally {
    if (descriptor !== undefined) {
      try {
        fsModule.closeSync(descriptor);
      } catch {
        // The read completed or failed already; no credential is exposed.
      }
    }
  }

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new McpUserError("OpenWhispr local bridge credentials are invalid.");
  }

  if (
    credentials?.version !== 1 ||
    !Number.isInteger(credentials.port) ||
    credentials.port < BRIDGE_PORT_MIN ||
    credentials.port > BRIDGE_PORT_MAX ||
    typeof credentials.token !== "string" ||
    !/^[a-f0-9]{64}$/i.test(credentials.token)
  ) {
    throw new McpUserError("OpenWhispr local bridge credentials are invalid.");
  }

  return credentials;
}

function bridgeGet(
  pathname,
  {
    readCredentials = readBridgeCredentials,
    requestFactory = http.request,
    timeoutMs = BRIDGE_TIMEOUT_MS,
  } = {}
) {
  return scheduleBridgeRequest(() =>
    bridgeGetOnce(pathname, { readCredentials, requestFactory, timeoutMs })
  );
}

function bridgeGetOnce(
  pathname,
  { readCredentials, requestFactory = http.request, timeoutMs = BRIDGE_TIMEOUT_MS }
) {
  const credentials = readCredentials();

  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      callback(value);
    };
    const rejectBridgeError = (error) => finish(reject, normalizeBridgeError(error));
    const timeoutError = () => {
      const error = new Error("OpenWhispr local bridge request timed out.");
      error.code = "ETIMEDOUT";
      return error;
    };
    const request = requestFactory(
      {
        hostname: BRIDGE_HOST,
        port: credentials.port,
        path: pathname,
        method: "GET",
        agent: false,
        timeout: timeoutMs,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credentials.token}`,
        },
      },
      (response) => {
        let bytes = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_BRIDGE_RESPONSE_BYTES) {
            response.destroy(new McpUserError("OpenWhispr returned an oversized local response."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", rejectBridgeError);
        response.on("end", () => {
          if (response.statusCode === 401 || response.statusCode === 403) {
            finish(
              reject,
              new McpUserError(
                "OpenWhispr local bridge authorization expired. Restart the desktop app and retry."
              )
            );
            return;
          }
          if (response.statusCode === 404) {
            finish(reject, new McpUserError("The requested OpenWhispr record was not found."));
            return;
          }
          if (!response.statusCode || response.statusCode >= 400) {
            finish(
              reject,
              new McpUserError(
                "OpenWhispr local bridge request failed. Restart the desktop app and retry."
              )
            );
            return;
          }
          try {
            finish(resolve, JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            finish(
              reject,
              new McpUserError("OpenWhispr local bridge returned an invalid response.")
            );
          }
        });
      }
    );
    request.on("timeout", () => {
      request.destroy(timeoutError());
    });
    request.on("error", rejectBridgeError);
    deadline = setTimeout(() => request.destroy(timeoutError()), timeoutMs);
    request.end();
  });
}

function normalizeBridgeError(error) {
  if (error instanceof McpUserError) return error;
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH"].includes(error?.code)) {
    return new McpUserError("OpenWhispr desktop app is not running. Start it and retry.");
  }
  return new McpUserError(
    "OpenWhispr local bridge request failed. Restart the desktop app and retry."
  );
}

function truncateUtf8(value, maxBytes) {
  const text = typeof value === "string" ? value : "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };

  const suffix = "\n[truncated by OpenWhispr MCP]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maxBytes <= suffixBytes) {
    let output = "";
    for (const character of suffix) {
      if (Buffer.byteLength(output + character, "utf8") > maxBytes) break;
      output += character;
    }
    return { text: output, truncated: true };
  }
  const budget = maxBytes - suffixBytes;
  let bytes = 0;
  let output = "";
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > budget) break;
    output += character;
    bytes += characterBytes;
  }
  return { text: output + suffix, truncated: true };
}

function sourceReference(kind, id, title, uri = `openwhispr://${kind}/${id}`) {
  return {
    kind,
    id,
    uri,
    title: truncateUtf8(title || `${kind} ${id}`, MAX_TITLE_BYTES).text,
    backend: "local-cli-bridge",
  };
}

function noteRecord(note, maxContentBytes, includeTranscript = false) {
  const content = truncateUtf8(note?.content, maxContentBytes);
  const record = {
    id: note?.id,
    title: truncateUtf8(note?.title || "Untitled Note", MAX_TITLE_BYTES).text,
    noteType: note?.note_type || null,
    content: content.text,
    contentTruncated: content.truncated,
    createdAt: note?.created_at || null,
    updatedAt: note?.updated_at || null,
    source: sourceReference("notes", note?.id, note?.title),
  };
  if (includeTranscript && typeof note?.transcript === "string" && note.transcript) {
    const transcript = truncateUtf8(note.transcript, MAX_NOTE_TRANSCRIPT_BYTES);
    record.transcript = transcript.text;
    record.transcriptTruncated = transcript.truncated;
    record.transcriptSource = sourceReference(
      "note-transcript",
      note.id,
      `Meeting transcript for ${note.title || `note ${note.id}`}`,
      `openwhispr://notes/${note.id}#transcript`
    );
  }
  return record;
}

function isRequestId(id) {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: isRequestId(id) ? id : null, error };
}

function toolDefinitions() {
  return [
    {
      name: "openwhispr_search_notes",
      title: "Search OpenWhispr notes",
      description:
        "Searches local OpenWhispr notes by a required text query. Returns at most 10 bounded excerpts and source references; it never lists the full note history.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1, maxLength: MAX_SEARCH_QUERY_LENGTH },
          limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS, default: 5 },
        },
        required: ["query"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "openwhispr_get_note",
      title: "Get an OpenWhispr note",
      description:
        "Gets one local OpenWhispr note by its numeric ID. Content is bounded and includes a source reference.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "integer", minimum: 1 } },
        required: ["id"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ];
}

function requireObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpUserError(message);
  return value;
}

function requireOnlyKeys(value, keys) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new McpUserError(`Unsupported argument '${key}'.`);
  }
}

function requirePositiveId(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new McpUserError("'id' must be a positive integer.");
  }
  return value;
}

function modernMetadata(params) {
  const meta = requireObject(params?._meta, "Modern MCP requests require protocol metadata.");
  const version = meta["io.modelcontextprotocol/protocolVersion"];
  if (version !== MODERN_PROTOCOL_VERSION) {
    const error = new McpUserError("Unsupported protocol version");
    error.code = -32022;
    error.data = { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: version || null };
    throw error;
  }
  const clientInfo = meta["io.modelcontextprotocol/clientInfo"];
  if (clientInfo !== undefined) {
    requireObject(clientInfo, "Modern MCP client information is invalid.");
    if (typeof clientInfo.name !== "string" || typeof clientInfo.version !== "string") {
      throw new McpUserError("Modern MCP client information is invalid.");
    }
  }
  requireObject(
    meta["io.modelcontextprotocol/clientCapabilities"],
    "Modern MCP requests require client capabilities."
  );
}

function legacyInitializeResult(version) {
  return {
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: { name: "openwhispr-local-notes", version: "1.0.0" },
    instructions:
      "This is a read-only adapter for a running local OpenWhispr desktop app. Search before fetching a full record.",
  };
}

function modernDiscoverResult() {
  return {
    resultType: "complete",
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    capabilities: { tools: {} },
    _meta: {
      "io.modelcontextprotocol/serverInfo": {
        name: "openwhispr-local-notes",
        version: "1.0.0",
      },
    },
    instructions:
      "This is a read-only adapter for a running local OpenWhispr desktop app. Search before fetching a full record.",
    ttlMs: 300_000,
    cacheScope: "private",
  };
}

function withResultType(result, era) {
  if (era !== "modern") return result;
  return {
    resultType: "complete",
    ...result,
    _meta: {
      "io.modelcontextprotocol/serverInfo": {
        name: "openwhispr-local-notes",
        version: "1.0.0",
      },
      ...(result._meta || {}),
    },
  };
}

function toolErrorResult(message, era) {
  return withResultType({ content: [{ type: "text", text: message }], isError: true }, era);
}

function serializedResponseBytes(id, result) {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id, result }), "utf8");
}

function addStructuredTextContent(result) {
  result.content = [
    {
      type: "text",
      text: JSON.stringify(result.structuredContent),
    },
  ];
}

function truncateResultToFit(result, era, id) {
  const payload = result?.structuredContent;
  if (!payload || typeof payload !== "object") return result;

  while (true) {
    addStructuredTextContent(result);
    if (serializedResponseBytes(id, result) <= MAX_OUTBOUND_MESSAGE_BYTES) return result;
    const candidates = [];
    const visit = (value, parent = null, key = null) => {
      if (typeof value === "string") {
        candidates.push({ parent, key, bytes: Buffer.byteLength(JSON.stringify(value), "utf8") });
      } else if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else if (value && typeof value === "object") {
        for (const [childKey, child] of Object.entries(value)) visit(child, value, childKey);
      }
    };
    visit(payload);
    candidates.sort((a, b) => b.bytes - a.bytes);
    const candidate = candidates[0];
    if (!candidate || candidate.bytes <= 2) {
      return toolErrorResult("OpenWhispr local result exceeds the MCP output limit.", era);
    }
    const current = candidate.parent[candidate.key];
    const nextBudget = Math.max(0, Math.floor(Buffer.byteLength(current, "utf8") / 2));
    const truncated = truncateUtf8(current, nextBudget);
    candidate.parent[candidate.key] = truncated.text;
    if (candidate.key === "content") candidate.parent.contentTruncated = true;
    if (candidate.key === "transcript") candidate.parent.transcriptTruncated = true;
  }
}

class McpProtocol {
  constructor({ get = bridgeGet } = {}) {
    this.get = get;
    this.era = null;
    this.legacyInitialized = false;
    this.legacyReady = false;
  }

  async handle(message) {
    if (
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      message.jsonrpc !== "2.0"
    ) {
      return rpcError(null, -32600, "Invalid Request");
    }
    if (typeof message.method !== "string") return rpcError(message.id, -32600, "Invalid Request");
    const isNotification = !Object.prototype.hasOwnProperty.call(message, "id");
    if (!isNotification && !isRequestId(message.id)) {
      return rpcError(null, -32600, "Invalid Request");
    }
    if (
      !isNotification &&
      Buffer.byteLength(JSON.stringify(message.id), "utf8") > MAX_REQUEST_ID_BYTES
    ) {
      return rpcError(null, -32600, `MCP request id exceeds ${MAX_REQUEST_ID_BYTES} bytes.`);
    }

    if (message.method === "initialize") return this._initialize(message, isNotification);
    if (message.method === "notifications/initialized") {
      if (this.era === "legacy" && this.legacyInitialized) this.legacyReady = true;
      return null;
    }

    try {
      this._selectEra(message);
    } catch (error) {
      return rpcError(message.id, error.code || -32602, error.message, error.data);
    }

    if (isNotification) return null;
    if (message.method === "ping") return rpcResult(message.id, withResultType({}, this.era));
    if (this.era === "legacy" && !this.legacyReady) {
      return rpcError(
        message.id,
        -32002,
        "Client must send notifications/initialized before using tools."
      );
    }
    if (message.method === "server/discover") {
      if (this.era !== "modern") return rpcError(message.id, -32601, "Method not found");
      return rpcResult(message.id, modernDiscoverResult());
    }
    if (message.method === "tools/list") {
      try {
        return rpcResult(message.id, this._listTools(message));
      } catch (error) {
        return rpcError(message.id, -32602, error.message);
      }
    }
    if (message.method === "tools/call")
      return rpcResult(message.id, await this._callTool(message));
    return rpcError(message.id, -32601, "Method not found");
  }

  _initialize(message, isNotification) {
    if (isNotification) return null;
    if (this.era === "modern") {
      return rpcError(message.id, -32601, "Method not found");
    }
    const params = message.params;
    if (
      !params ||
      typeof params !== "object" ||
      Array.isArray(params) ||
      typeof params.protocolVersion !== "string"
    ) {
      return rpcError(message.id, -32602, "Invalid initialize request");
    }
    if (
      !params.capabilities ||
      typeof params.capabilities !== "object" ||
      Array.isArray(params.capabilities) ||
      !params.clientInfo ||
      typeof params.clientInfo !== "object" ||
      Array.isArray(params.clientInfo) ||
      typeof params.clientInfo.name !== "string" ||
      typeof params.clientInfo.version !== "string"
    ) {
      return rpcError(message.id, -32602, "Invalid initialize request");
    }
    if (!LEGACY_PROTOCOL_VERSIONS.has(params.protocolVersion)) {
      // Legacy lifecycle negotiation returns a supported version in a normal
      // initialize result; clients disconnect if they cannot speak it.
      this.era = "legacy";
      this.legacyInitialized = true;
      return rpcResult(message.id, legacyInitializeResult("2025-11-25"));
    }
    this.era = "legacy";
    this.legacyInitialized = true;
    return rpcResult(message.id, legacyInitializeResult(params.protocolVersion));
  }

  _selectEra(message) {
    const params = message.params || {};
    if (this.era === "legacy") {
      // Legacy progress uses params._meta.progressToken. Only modern metadata
      // selects the other era; other legacy _meta fields remain valid.
      if (params?._meta?.["io.modelcontextprotocol/protocolVersion"] !== undefined) {
        throw new McpUserError("This stdio connection is using the legacy MCP lifecycle.");
      }
      return;
    }
    if (this.era === "modern" || params?._meta) {
      modernMetadata(params);
      this.era = "modern";
      return;
    }
    throw new McpUserError("Initialize is required before using this legacy MCP server.");
  }

  _listTools(message) {
    const cursor = message.params?.cursor;
    if (cursor !== undefined) throw new McpUserError("This server does not paginate tools.");
    const result = { tools: toolDefinitions() };
    if (this.era === "modern") Object.assign(result, { ttlMs: 300_000, cacheScope: "private" });
    return withResultType(result, this.era);
  }

  async _callTool(message) {
    const params = message.params;
    if (
      !params ||
      typeof params !== "object" ||
      Array.isArray(params) ||
      typeof params.name !== "string"
    ) {
      return toolErrorResult("Invalid tools/call request.", this.era);
    }
    try {
      const structuredContent = await this._invokeTool(params.name, params.arguments || {});
      return truncateResultToFit(
        withResultType(
          {
            structuredContent,
            isError: false,
          },
          this.era
        ),
        this.era,
        message.id
      );
    } catch (error) {
      return toolErrorResult(
        error instanceof McpUserError ? error.message : "OpenWhispr local request failed.",
        this.era
      );
    }
  }

  async _invokeTool(name, args) {
    const argumentsObject = requireObject(args, "Tool arguments must be an object.");
    if (name === "openwhispr_search_notes") {
      requireOnlyKeys(argumentsObject, new Set(["query", "limit"]));
      const query = argumentsObject.query;
      if (typeof query !== "string" || !query.trim() || query.length > MAX_SEARCH_QUERY_LENGTH) {
        throw new McpUserError(
          `'query' must be a non-empty string up to ${MAX_SEARCH_QUERY_LENGTH} characters.`
        );
      }
      const limit = argumentsObject.limit === undefined ? 5 : argumentsObject.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
        throw new McpUserError(`'limit' must be an integer from 1 to ${MAX_SEARCH_RESULTS}.`);
      }
      const response = await this.get(
        `/v1/notes/search?q=${encodeURIComponent(query.trim())}&limit=${limit}`
      );
      if (!Array.isArray(response?.data))
        throw new McpUserError("OpenWhispr local bridge returned an invalid response.");
      const notes = response.data
        .slice(0, limit)
        .map((note) => noteRecord(note, MAX_SEARCH_EXCERPT_BYTES));
      return {
        notes,
        sourceReferences: notes.map((note) => note.source),
        limits: {
          resultCount: notes.length,
          maximumResults: MAX_SEARCH_RESULTS,
          excerptBytes: MAX_SEARCH_EXCERPT_BYTES,
        },
      };
    }

    if (name === "openwhispr_get_note") {
      requireOnlyKeys(argumentsObject, new Set(["id"]));
      const id = requirePositiveId(argumentsObject.id);
      const response = await this.get(`/v1/notes/${id}`);
      if (!response?.data || typeof response.data !== "object") {
        throw new McpUserError("OpenWhispr local bridge returned an invalid response.");
      }
      const note = noteRecord(response.data, MAX_NOTE_CONTENT_BYTES, true);
      const sourceReferences = [note.source];
      if (note.transcriptSource) sourceReferences.push(note.transcriptSource);
      return {
        note,
        sourceReferences,
        limits: {
          contentBytes: MAX_NOTE_CONTENT_BYTES,
          transcriptBytes: MAX_NOTE_TRANSCRIPT_BYTES,
        },
      };
    }

    throw new McpUserError(`Unknown tool '${name}'.`);
  }
}

function startStdioServer({
  input = process.stdin,
  output = process.stdout,
  protocol = new McpProtocol(),
} = {}) {
  let buffer = "";
  let bufferBytes = 0;
  let stopped = false;

  const send = (response) => {
    if (!response) return;
    let encoded = JSON.stringify(response);
    if (Buffer.byteLength(encoded, "utf8") > MAX_OUTBOUND_MESSAGE_BYTES) {
      const responseId =
        isRequestId(response.id) &&
        Buffer.byteLength(JSON.stringify(response.id), "utf8") <= MAX_REQUEST_ID_BYTES
          ? response.id
          : null;
      // Keep bounded request IDs so clients can correlate this failure.
      encoded = JSON.stringify(
        rpcError(responseId, -32603, "MCP response exceeds the output size limit.")
      );
    }
    output.write(`${encoded}\n`);
  };

  const rejectOversizedFrame = () => {
    if (stopped) return;
    stopped = true;
    send(rpcError(null, -32600, `MCP message exceeds ${MAX_MESSAGE_BYTES} bytes.`));
    input.pause();
  };

  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    if (stopped) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.slice(offset, end);
      const segmentBytes = Buffer.byteLength(segment, "utf8");
      if (segmentBytes > MAX_MESSAGE_BYTES - bufferBytes) {
        rejectOversizedFrame();
        return;
      }
      // Retain only one bounded frame. A stream chunk may hold many valid
      // frames, so it is deliberately split before anything is accumulated.
      buffer += segment;
      bufferBytes += segmentBytes;
      if (newline === -1) return;

      const line = buffer;
      buffer = "";
      bufferBytes = 0;
      offset = newline + 1;
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        send(rpcError(null, -32700, "Parse error"));
        continue;
      }
      Promise.resolve(protocol.handle(message))
        .then(send)
        .catch(() => send(rpcError(message?.id, -32603, "Internal error")));
    }
  });
}

if (require.main === module) startStdioServer();

module.exports = {
  BRIDGE_PORT_MAX,
  BRIDGE_PORT_MIN,
  MAX_MESSAGE_BYTES,
  MAX_OUTBOUND_MESSAGE_BYTES,
  MAX_REQUEST_ID_BYTES,
  MAX_CONCURRENT_BRIDGE_REQUESTS,
  McpProtocol,
  McpUserError,
  bridgeGet,
  bridgeGetOnce,
  createRequestLimiter,
  getBridgeFilePath,
  readBridgeCredentials,
  startStdioServer,
  toolDefinitions,
  truncateUtf8,
};
