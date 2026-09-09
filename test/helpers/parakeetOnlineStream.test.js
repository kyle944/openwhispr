const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

const { WebSocketServer } = require("ws");

const ParakeetManager = require("../../src/helpers/parakeet");
const ParakeetServerManager = require("../../src/helpers/parakeetServer");
const ParakeetWsServer = require("../../src/helpers/parakeetWsServer");
const { pcm16ToFloat32 } = require("../../src/utils/audioUtils");

// Mock sherpa online WS protocol: float32 binary frames in, JSON results out, "Done"/"Done!" handshake.
async function startMockOnlineServer({ onBinary, finalSegment = 0, onDone } = {}) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");

  let ignoringDone = false;
  wss.on("connection", (socket) => {
    let binaryFrames = 0;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        binaryFrames += 1;
        onBinary?.(socket, data, binaryFrames);
        return;
      }
      if (data.toString() === "Done" && !ignoringDone) {
        if (onDone) {
          onDone(socket, binaryFrames);
        } else {
          socket.send(
            JSON.stringify({
              text: `final after ${binaryFrames} frames`,
              segment: finalSegment,
              is_final: true,
            })
          );
          socket.send("Done!");
        }
      }
    });
  });

  return {
    port: wss.address().port,
    ignoreDone: () => {
      ignoringDone = true;
    },
    close: () => new Promise((resolve) => wss.close(resolve)),
  };
}

async function startMockOfflineServer(result) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");

  wss.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.send(result);
      } else if (data.toString() === "Done") {
        socket.close();
      }
    });
  });

  return {
    port: wss.address().port,
    close: () => new Promise((resolve) => wss.close(resolve)),
  };
}

function onlineWsServerAt(port) {
  const server = new ParakeetWsServer();
  server.ready = true;
  server.process = { pid: 1 };
  server.port = port;
  server.modelName = "nemotron-speech-streaming-en-0.6b";
  server.modelDir = "/tmp/mock-parakeet-model";
  server.modelRuntime = "online";
  return server;
}

function audibleWav() {
  const sampleRate = 16000;
  const dataSize = sampleRate * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  for (let offset = 44; offset < wav.length; offset += 2) {
    wav.writeInt16LE(offset % 4 === 0 ? 8000 : -8000, offset);
  }
  return wav;
}

test("online stream emits live updates and finish resolves with the final text", async () => {
  const mock = await startMockOnlineServer({
    onBinary: (socket, _data, frameCount) => {
      socket.send(JSON.stringify({ text: `partial ${frameCount}`, segment: 0, is_final: false }));
    },
  });

  try {
    const updates = [];
    const stream = onlineWsServerAt(mock.port).createOnlineStream({
      onUpdate: (text) => updates.push(text),
    });

    // Chunks sent before the socket opens must be queued, not dropped.
    stream.sendPcm16(Buffer.alloc(3200));
    stream.sendFloat32(pcm16ToFloat32(Buffer.alloc(3200)));

    const { text } = await stream.finish();

    assert.equal(text, "final after 2 frames");
    assert.ok(updates.includes("partial 1"));
    assert.ok(updates.includes("partial 2"));
  } finally {
    await mock.close();
  }
});

test("finalized segments accumulate across endpoints in live updates", async () => {
  let segment = 0;
  const mock = await startMockOnlineServer({
    finalSegment: 2,
    onBinary: (socket, _data, frameCount) => {
      // Simulate endpointing: every frame finalizes a segment.
      socket.send(
        JSON.stringify({ text: `segment ${frameCount}`, segment: segment++, is_final: true })
      );
    },
  });

  try {
    let lastUpdate = "";
    const stream = onlineWsServerAt(mock.port).createOnlineStream({
      onUpdate: (text) => {
        lastUpdate = text;
      },
    });

    stream.sendPcm16(Buffer.alloc(3200));
    stream.sendPcm16(Buffer.alloc(3200));

    const { text } = await stream.finish();

    assert.equal(text, "segment 1 segment 2 final after 2 frames");
    assert.equal(lastUpdate, text);
  } finally {
    await mock.close();
  }
});

test("createOnlineStream rejects offline-runtime sessions and dead servers", () => {
  const offline = onlineWsServerAt(1);
  offline.modelRuntime = "offline";
  assert.throws(() => offline.createOnlineStream(), /online-runtime/);

  const dead = onlineWsServerAt(1);
  dead.ready = false;
  assert.throws(() => dead.createOnlineStream(), /not running/);
});

test("abort closes the stream without waiting for the server", async () => {
  const mock = await startMockOnlineServer({});
  try {
    const stream = onlineWsServerAt(mock.port).createOnlineStream({});
    stream.sendPcm16(Buffer.alloc(3200));
    stream.abort();
    const { text, truncated } = await stream.finish();
    assert.equal(text, "");
    assert.equal(truncated, false);
  } finally {
    await mock.close();
  }
});

test("finish flags truncation when the server never acknowledges Done", async () => {
  // Server sends a partial but ignores "Done" entirely.
  const mock = await startMockOnlineServer({
    onBinary: (socket) => {
      socket.send(JSON.stringify({ text: "partial", segment: 0, is_final: false }));
    },
  });
  mock.ignoreDone();

  try {
    const stream = onlineWsServerAt(mock.port).createOnlineStream({});
    stream.sendPcm16(Buffer.alloc(3200));
    const { text, truncated } = await stream.finish({ idleTimeoutMs: 200 });
    assert.equal(text, "partial");
    assert.equal(truncated, true);
  } finally {
    await mock.close();
  }
});

test("unexpected close before Done! reports an error and truncation", async () => {
  const mock = await startMockOnlineServer({
    onBinary: (socket) => {
      socket.send(JSON.stringify({ text: "cut off", segment: 0, is_final: false }));
      socket.close();
    },
  });

  try {
    const errors = [];
    const stream = onlineWsServerAt(mock.port).createOnlineStream({
      onError: (err) => errors.push(err),
    });
    stream.sendPcm16(Buffer.alloc(3200));
    const { text, truncated } = await stream.finish({ idleTimeoutMs: 1000 });
    assert.equal(text, "cut off");
    assert.equal(truncated, true);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /closed before/);
  } finally {
    await mock.close();
  }
});

test("a clean finish reports no truncation", async () => {
  const mock = await startMockOnlineServer({});
  try {
    const stream = onlineWsServerAt(mock.port).createOnlineStream({});
    stream.sendPcm16(Buffer.alloc(3200));
    const { text, truncated } = await stream.finish();
    assert.equal(truncated, false);
    assert.equal(text, "final after 1 frames");
  } finally {
    await mock.close();
  }
});

test("a send error during the queued flush flags truncation", async () => {
  const mock = await startMockOnlineServer({});
  const WebSocket = require("ws");
  const realSend = WebSocket.prototype.send;
  // Only client audio frames are binary; the mock server sends strings, so gate on type.
  WebSocket.prototype.send = function (data, cb) {
    if (typeof data !== "string") {
      if (typeof cb === "function") cb(new Error("forced send failure"));
      return;
    }
    return realSend.call(this, data, cb);
  };
  try {
    const stream = onlineWsServerAt(mock.port).createOnlineStream({});
    stream.sendPcm16(Buffer.alloc(3200));
    const { truncated } = await stream.finish({ idleTimeoutMs: 1000 });
    assert.equal(truncated, true);
  } finally {
    WebSocket.prototype.send = realSend;
    await mock.close();
  }
});

test("a chunk arriving after finish flags truncation", async () => {
  const mock = await startMockOnlineServer({});
  try {
    const stream = onlineWsServerAt(mock.port).createOnlineStream({});
    stream.sendPcm16(Buffer.alloc(3200));
    const finishPromise = stream.finish({ idleTimeoutMs: 1000 });
    // Renderer flushed a chunk after we already told the server we were done.
    stream.sendPcm16(Buffer.alloc(3200));
    const { truncated } = await finishPromise;
    assert.equal(truncated, true);
  } finally {
    await mock.close();
  }
});

test("finish is idempotent and returns the same result", async () => {
  const mock = await startMockOnlineServer({});
  try {
    const stream = onlineWsServerAt(mock.port).createOnlineStream({});
    stream.sendPcm16(Buffer.alloc(3200));
    const [first, second] = await Promise.all([stream.finish(), stream.finish()]);
    assert.deepEqual(first, second);
  } finally {
    await mock.close();
  }
});

test("wake probe verifies the live protocol and leaves a healthy idle server running", async () => {
  const mock = await startMockOnlineServer({
    onDone: (socket) => {
      socket.send(JSON.stringify({ text: "", segment: 0, is_final: true }));
      socket.send("Done!");
    },
  });
  try {
    const server = onlineWsServerAt(mock.port);
    server.stop = async () => assert.fail("healthy wake probe must not stop the server");

    const result = await server.onWakeFromSleep({ timeoutMs: 500 });

    assert.equal(result.status, "healthy");
    assert.equal(server.activeRequestCount, 0);
  } finally {
    await mock.close();
  }
});

for (const { name, onDone } of [
  {
    name: "Done! without an inference result",
    onDone: (socket) => socket.send("Done!"),
  },
  {
    name: "a malformed inference result",
    onDone: (socket) => {
      socket.send("not-json");
      socket.send("Done!");
    },
  },
  {
    name: "an error inference result",
    onDone: (socket) => {
      socket.send(JSON.stringify({ error: "decode failed", text: "" }));
      socket.send("Done!");
    },
  },
]) {
  test(`wake probe recycles an idle online server after ${name}`, async () => {
    const mock = await startMockOnlineServer({ onDone });
    try {
      const server = onlineWsServerAt(mock.port);
      let stopCalls = 0;
      server.stop = async () => {
        stopCalls += 1;
        server.ready = false;
      };

      const result = await server.onWakeFromSleep({ timeoutMs: 500 });

      assert.equal(result.status, "stopped");
      assert.equal(stopCalls, 1);
    } finally {
      await mock.close();
    }
  });
}

test("wake probe accepts a valid empty offline inference result", async () => {
  const mock = await startMockOfflineServer(JSON.stringify({ text: "" }));
  try {
    const server = onlineWsServerAt(mock.port);
    server.modelRuntime = "offline";
    server.stop = async () => assert.fail("valid empty result must not stop the server");

    const result = await server.onWakeFromSleep({ timeoutMs: 500 });

    assert.equal(result.status, "healthy");
  } finally {
    await mock.close();
  }
});

for (const { name, resultMessage } of [
  { name: "malformed JSON", resultMessage: "not-json" },
  {
    name: "an error result",
    resultMessage: JSON.stringify({ error: "decode failed", text: "" }),
  },
]) {
  test(`wake probe recycles an idle offline server after ${name}`, async () => {
    const mock = await startMockOfflineServer(resultMessage);
    try {
      const server = onlineWsServerAt(mock.port);
      server.modelRuntime = "offline";
      let stopCalls = 0;
      server.stop = async () => {
        stopCalls += 1;
        server.ready = false;
      };

      const result = await server.onWakeFromSleep({ timeoutMs: 500 });

      assert.equal(result.status, "stopped");
      assert.equal(stopCalls, 1);
    } finally {
      await mock.close();
    }
  });
}

test("wake probe recycles an idle server that cannot complete the protocol", async () => {
  const mock = await startMockOnlineServer({});
  mock.ignoreDone();
  try {
    const server = onlineWsServerAt(mock.port);
    let stopCalls = 0;
    server.stop = async () => {
      stopCalls += 1;
      server.ready = false;
    };

    const result = await server.onWakeFromSleep({ timeoutMs: 30 });

    assert.equal(result.status, "stopped");
    assert.equal(stopCalls, 1);
  } finally {
    await mock.close();
  }
});

test("wake recovery skips a server with an active transcription stream", async () => {
  const mock = await startMockOnlineServer({});
  try {
    const server = onlineWsServerAt(mock.port);
    let stopCalls = 0;
    server.stop = async () => {
      stopCalls += 1;
    };
    const stream = server.createOnlineStream({});

    assert.equal(server.activeRequestCount, 1);
    const result = await server.onWakeFromSleep({ timeoutMs: 30 });

    assert.equal(result.status, "busy");
    assert.equal(stopCalls, 0);
    stream.abort();
    assert.equal(server.activeRequestCount, 0);
  } finally {
    await mock.close();
  }
});

test("starting user work cancels a background wake probe", async () => {
  const mock = await startMockOnlineServer({});
  try {
    const server = onlineWsServerAt(mock.port);
    let abortCalls = 0;
    server.wakeProbeController = {
      abort() {
        abortCalls += 1;
      },
    };

    const stream = server.createOnlineStream({});

    assert.equal(abortCalls, 1);
    stream.abort();
  } finally {
    await mock.close();
  }
});

test("wake recovery does not recycle after user activity overlaps a failing probe", async () => {
  const mock = await startMockOnlineServer({});
  try {
    const server = onlineWsServerAt(mock.port);
    let rejectProbe;
    server._probeFunctionalHealth = () =>
      new Promise((_, reject) => {
        rejectProbe = reject;
      });
    let stopCalls = 0;
    server.stop = async () => {
      stopCalls += 1;
    };

    const recovery = server.onWakeFromSleep({ timeoutMs: 30 });
    const stream = server.createOnlineStream({});
    stream.abort();
    rejectProbe(new Error("stalled"));

    const result = await recovery;
    assert.equal(result.status, "busy");
    assert.equal(stopCalls, 0);
  } finally {
    await mock.close();
  }
});

test("wake recovery does not stop a replacement process after the probe fails", async () => {
  const server = onlineWsServerAt(1);
  let rejectProbe;
  server._probeFunctionalHealth = () =>
    new Promise((_, reject) => {
      rejectProbe = reject;
    });
  let stopCalls = 0;
  server.stop = async () => {
    stopCalls += 1;
  };

  const recovery = server.onWakeFromSleep({ timeoutMs: 30 });
  server.process = { pid: 2 };
  rejectProbe(new Error("old process stalled"));

  const result = await recovery;
  assert.equal(result.status, "busy");
  assert.equal(stopCalls, 0);
});

test("manager streaming admission spans awaited startup and hands off to the live stream", async () => {
  const mock = await startMockOnlineServer({});
  try {
    const manager = new ParakeetManager();
    const server = onlineWsServerAt(mock.port);
    manager.serverManager.wsServer = server;
    manager.serverManager.isModelDownloaded = () => true;
    server.isAvailable = () => true;

    let rejectProbe;
    server._probeFunctionalHealth = () =>
      new Promise((_, reject) => {
        rejectProbe = reject;
      });
    let stopCalls = 0;
    server.stop = async () => {
      stopCalls += 1;
      server.ready = false;
    };

    const recovery = manager.onWakeFromSleep({ timeoutMs: 500 });
    const userStream = manager.createOnlineStream(server.modelName);
    rejectProbe(new Error("stalled"));

    const recoveryResult = await recovery;
    const stream = await userStream;

    assert.equal(recoveryResult.status, "busy");
    assert.equal(stopCalls, 0);
    assert.equal(server.activeRequestCount, 1, "the live stream owns admission after startup");
    stream.abort();
    assert.equal(server.activeRequestCount, 0);
  } finally {
    await mock.close();
  }
});

test("batch admission spans normalization, startup, and transcription", async () => {
  const mock = await startMockOnlineServer({});
  try {
    const manager = new ParakeetServerManager();
    const server = onlineWsServerAt(mock.port);
    manager.wsServer = server;
    manager.isModelDownloaded = () => true;

    let rejectProbe;
    server._probeFunctionalHealth = () =>
      new Promise((_, reject) => {
        rejectProbe = reject;
      });
    let stopCalls = 0;
    server.stop = async () => {
      stopCalls += 1;
      server.ready = false;
    };

    const recovery = manager.onWakeFromSleep({ timeoutMs: 500 });
    const transcription = manager.transcribe(audibleWav(), { modelName: server.modelName });
    rejectProbe(new Error("stalled"));

    const recoveryResult = await recovery;
    const result = await transcription;

    assert.equal(recoveryResult.status, "busy");
    assert.equal(stopCalls, 0);
    assert.equal(result.text, "final after 2 frames");
    assert.equal(server.activeRequestCount, 0, "batch reservation releases after decode");
  } finally {
    await mock.close();
  }
});

test("offline transcription rejects with AbortError when cancelled mid-flight", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  const controller = new AbortController();
  // The server holds the request open; only the abort can settle it.
  wss.on("connection", () => controller.abort());

  try {
    const server = onlineWsServerAt(wss.address().port);
    server.modelRuntime = "offline";
    await assert.rejects(
      () => server.transcribe(Buffer.alloc(3200), 16000, { signal: controller.signal }),
      (err) => {
        assert.equal(err.name, "AbortError");
        return true;
      }
    );
  } finally {
    await new Promise((resolve) => wss.close(resolve));
  }
});

test("offline transcription rejects immediately on a pre-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();

  const server = onlineWsServerAt(1);
  server.modelRuntime = "offline";
  await assert.rejects(
    () => server.transcribe(Buffer.alloc(3200), 16000, { signal: controller.signal }),
    (err) => {
      assert.equal(err.name, "AbortError");
      return true;
    }
  );
});

test("online transcription rejects with AbortError when cancelled mid-flight", async () => {
  // The server never acknowledges Done, so only the abort settles the stream.
  const mock = await startMockOnlineServer({});
  mock.ignoreDone();

  try {
    const server = onlineWsServerAt(mock.port);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
      () => server.transcribe(Buffer.alloc(3200), 16000, { signal: controller.signal }),
      (err) => {
        assert.equal(err.name, "AbortError");
        return true;
      }
    );
  } finally {
    await mock.close();
  }
});

test("offline transcription rejects when the connection closes without a result", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  wss.on("connection", (socket) => socket.close());

  try {
    const server = onlineWsServerAt(wss.address().port);
    server.modelRuntime = "offline";
    await assert.rejects(
      () => server.transcribe(Buffer.alloc(3200), 16000),
      /closed before transcription completed/
    );
  } finally {
    await new Promise((resolve) => wss.close(resolve));
  }
});

test("pcm16ToFloat32 converts int16 samples to normalized float32", () => {
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(0, 0);
  pcm.writeInt16LE(16384, 2);
  pcm.writeInt16LE(-16384, 4);
  pcm.writeInt16LE(-32768, 6);

  const floats = pcm16ToFloat32(pcm);

  assert.ok(floats instanceof Float32Array);
  assert.deepEqual(Array.from(floats), [0, 0.5, -0.5, -1]);
});
