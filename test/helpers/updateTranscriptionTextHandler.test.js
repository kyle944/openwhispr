const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

test("final transcription text updates broadcast the persisted row after it is read", async (t) => {
  const originalLoad = Module._load;
  const handlers = new Map();
  const broadcasts = [];
  const lifecycle = [];
  const updatedRow = { id: 91, text: "Final cleaned text", raw_text: "raw transcript" };
  const electronStub = {
    app: {
      getPath: () => "/tmp",
      getName: () => "test",
      getVersion: () => "0.0.0",
      isPackaged: false,
      on: () => {},
      requestSingleInstanceLock: () => true,
    },
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: () => {},
      removeHandler: () => {},
    },
    net: { fetch: async () => ({ ok: true, json: async () => ({}) }) },
    BrowserWindow: class BrowserWindow {
      static getAllWindows() {
        return [];
      }
      static fromWebContents() {
        return null;
      }
    },
    shell: {},
    dialog: {},
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
    systemPreferences: { getMediaAccessStatus: () => "granted" },
    session: { fromPartition: () => ({}) },
    clipboard: {},
    nativeImage: {},
    globalShortcut: {},
    utilityProcess: {},
    MessageChannelMain: class {},
  };

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") return electronStub;
    if (parent?.filename === handlersModulePath && request === "./windowBroadcast") {
      return {
        broadcastToWindows: (channel, payload) => {
          lifecycle.push("broadcast");
          broadcasts.push({ channel, payload });
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => {
    Module._load = originalLoad;
    delete require.cache[handlersModulePath];
  });

  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  const target = {
    databaseManager: {
      updateTranscriptionText: (id, text, rawText) => {
        lifecycle.push("persist");
        assert.equal(id, updatedRow.id);
        assert.equal(text, updatedRow.text);
        assert.equal(rawText, updatedRow.raw_text);
      },
      getTranscriptionById: (id) => {
        lifecycle.push("read");
        assert.equal(id, updatedRow.id);
        return updatedRow;
      },
    },
  };
  const fakeThis = new Proxy(target, {
    get: (object, property) => (property in object ? object[property] : anything()),
  });
  Ctor.prototype.setupHandlers.call(fakeThis);

  const update = handlers.get("update-transcription-text");
  assert.ok(update, "update-transcription-text must be registered");
  const result = await update({}, updatedRow.id, updatedRow.text, updatedRow.raw_text);

  assert.deepEqual(result, { success: true, transcription: updatedRow });
  assert.deepEqual(lifecycle, ["persist", "read", "broadcast"]);
  assert.deepEqual(broadcasts, [{ channel: "transcription-updated", payload: updatedRow }]);
});
