const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const LlamaServerManager = require("../../src/helpers/llamaServer.js");

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

function readyManager(port) {
  const manager = new LlamaServerManager();
  manager.ready = true;
  manager.process = { pid: 1 };
  manager.port = port;
  manager.clearIdleTimer = () => {};
  manager.resetIdleTimer = () => {};
  return manager;
}

test("an already-aborted signal does not start a llama-server request", async (t) => {
  let requestCount = 0;
  const server = http.createServer((_req, res) => {
    requestCount += 1;
    res.end();
  });
  const manager = readyManager(await listen(server));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    manager.inference([{ role: "user", content: "warm" }], { signal: controller.signal }),
    (error) => error.name === "AbortError" && error.message === "llama-server request aborted"
  );
  assert.equal(requestCount, 0);
});

test("an in-flight abort rejects promptly and closes the llama-server request", async (t) => {
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  let requestClosed;
  const closed = new Promise((resolve) => {
    requestClosed = resolve;
  });
  const server = http.createServer((req) => {
    requestStarted();
    req.on("close", requestClosed);
  });
  const manager = readyManager(await listen(server));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const controller = new AbortController();
  const inference = manager.inference([{ role: "user", content: "warm" }], {
    signal: controller.signal,
  });
  await started;
  controller.abort();

  await assert.rejects(inference, (error) => error.name === "AbortError");
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("request was not closed")), 1000)),
  ]);
});
