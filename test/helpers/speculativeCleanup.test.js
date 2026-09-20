const test = require("node:test");
const assert = require("node:assert/strict");
const { SpeculativeCleanupScheduler } = require("../../src/helpers/speculativeCleanup");

const wait = (ms = 8) => new Promise((resolve) => setTimeout(resolve, ms));
const quietLogger = { debug() {} };

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function abortableResult(value, counters, delayMs = 2) {
  return (signal) =>
    new Promise((resolve, reject) => {
      counters.active += 1;
      counters.maxActive = Math.max(counters.maxActive, counters.active);
      const finish = () => {
        counters.active -= 1;
        resolve(value);
      };
      const timer = setTimeout(finish, delayMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          counters.active -= 1;
          counters.aborted += 1;
          reject(abortError());
        },
        { once: true }
      );
    });
}

function createScheduler(options = {}) {
  return new SpeculativeCleanupScheduler({
    debounceMs: 1,
    finalWaitMs: 1,
    minCharacters: 2,
    minWords: 2,
    logger: quietLogger,
    ...options,
  });
}

test("keeps one in-flight job and runs only the latest pending full snapshot", async () => {
  const scheduler = createScheduler();
  const counters = { active: 0, maxActive: 0, aborted: 0 };
  const started = [];
  scheduler.startSession({
    enabled: true,
    prepare: (text) => ({
      key: text,
      run: (signal) => {
        started.push(text);
        return abortableResult(`clean:${text}`, counters, 20)(signal);
      },
    }),
  });

  scheduler.update("first complete snapshot");
  await wait();
  scheduler.update("latest complete snapshot");
  await wait();

  assert.equal(
    await scheduler.finalize({
      key: "latest complete snapshot",
      run: () => "foreground should not run",
    }),
    "clean:latest complete snapshot"
  );
  assert.equal(counters.maxActive, 1);
  assert.equal(counters.aborted, 1);
  assert.deepEqual(started, ["first complete snapshot", "latest complete snapshot"]);
});

test("a newer snapshot gets its own full debounce after an older timer was blocked", async () => {
  const scheduler = createScheduler({ debounceMs: 20, finalWaitMs: 1 });
  let resolveFirst;
  const started = [];
  scheduler.startSession({
    enabled: true,
    prepare: (text) => ({
      key: text,
      run: () => {
        started.push(text);
        if (text === "first active snapshot") {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(`clean:${text}`);
      },
    }),
  });

  scheduler.update("first active snapshot");
  await wait(25);
  scheduler.update("second blocked snapshot");
  await wait(25);
  scheduler.update("third newly debounced snapshot");
  resolveFirst("stale first result");
  await wait(5);

  assert.deepEqual(started, ["first active snapshot"]);
  await wait(20);
  assert.equal(
    await scheduler.finalize({
      key: "third newly debounced snapshot",
      run: () => "foreground should not run",
    }),
    "clean:third newly debounced snapshot"
  );
  assert.deepEqual(started, ["first active snapshot", "third newly debounced snapshot"]);
});

test("does not cache a stale result that completes after a late correction", async () => {
  const scheduler = createScheduler();
  let resolveOld;
  const started = [];
  scheduler.startSession({
    enabled: true,
    prepare: (text) => ({
      key: text,
      run: () => {
        started.push(text);
        if (text.startsWith("Send it Tuesday")) {
          return new Promise((resolve) => {
            resolveOld = resolve;
          });
        }
        return Promise.resolve(`clean:${text}`);
      },
    }),
  });

  scheduler.update("Send it Tuesday morning");
  await wait();
  scheduler.update("Send it Thursday morning");
  await wait();
  resolveOld("stale Tuesday result");
  await wait();

  assert.equal(
    await scheduler.finalize({
      key: "Send it Thursday morning",
      run: () => "foreground should not run",
    }),
    "clean:Send it Thursday morning"
  );
  assert.deepEqual(started, ["Send it Tuesday morning", "Send it Thursday morning"]);
});

test("a speculative failure retries through the canonical foreground path", async () => {
  const scheduler = createScheduler();
  let foregroundCalls = 0;
  scheduler.startSession({
    enabled: true,
    prepare: (text) => ({
      key: text,
      run: async () => {
        throw new Error("background failed");
      },
    }),
  });
  scheduler.update("this is enough text");
  await wait();

  assert.equal(
    await scheduler.finalize({
      key: "this is enough text",
      run: () => {
        foregroundCalls += 1;
        return "canonical result";
      },
    }),
    "canonical result"
  );
  assert.equal(foregroundCalls, 1);
});

test("a model or formatting key switch invalidates a completed result", async () => {
  const scheduler = createScheduler();
  let foregroundCalls = 0;
  scheduler.startSession({
    enabled: true,
    prepare: (text) => ({ key: `model-a|prefs-a|${text}`, run: async () => "old config" }),
  });
  scheduler.update("same final transcript");
  await wait();

  assert.equal(
    await scheduler.finalize({
      key: "model-b|prefs-b|same final transcript",
      run: () => {
        foregroundCalls += 1;
        return "new config";
      },
    }),
    "new config"
  );
  assert.equal(foregroundCalls, 1);
});

test("the stop-time repeat of an unchanged final snapshot reuses the completed job", async () => {
  const scheduler = createScheduler();
  let backgroundCalls = 0;
  scheduler.startSession({
    enabled: true,
    prepare: (text) => ({
      key: text,
      run: async () => {
        backgroundCalls += 1;
        return `clean:${text}`;
      },
    }),
  });
  scheduler.update("unchanged final snapshot");
  await wait();
  scheduler.update("unchanged final snapshot");

  assert.equal(
    await scheduler.finalize({
      key: "unchanged final snapshot",
      run: () => "foreground should not run",
    }),
    "clean:unchanged final snapshot"
  );
  assert.equal(backgroundCalls, 1);
});

test("cancelling a session aborts its in-flight request", async () => {
  const scheduler = createScheduler();
  const counters = { active: 0, maxActive: 0, aborted: 0 };
  scheduler.startSession({
    enabled: true,
    prepare: (text) => ({ key: text, run: abortableResult("unused", counters, 50) }),
  });
  scheduler.update("cancel this request");
  await wait();
  scheduler.cancel("dictation-cancelled");
  await wait();

  assert.equal(counters.aborted, 1);
  assert.equal(counters.active, 0);
});

test("a cancelled old final cannot clear or return output into a replacement session", async () => {
  const scheduler = createScheduler();
  let resolveOld;
  let active = 0;
  let maxActive = 0;
  scheduler.startSession({
    enabled: true,
    prepare: (text) => ({
      key: `old|${text}`,
      run: () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise((resolve) => {
          resolveOld = (value) => {
            active -= 1;
            resolve(value);
          };
        });
      },
    }),
  });
  scheduler.update("old session transcript");
  await wait();
  const oldFinal = scheduler.finalize({
    key: "old|old session transcript",
    run: () => "old foreground",
  });

  scheduler.startSession({
    enabled: true,
    prepare: (text) => ({
      key: `new|${text}`,
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
        return `new:${text}`;
      },
    }),
  });
  scheduler.update("new session transcript");
  await wait();
  resolveOld("cancelled old output");
  await assert.rejects(oldFinal, (error) => error.name === "AbortError");
  await wait();

  assert.equal(
    await scheduler.finalize({
      key: "new|new session transcript",
      run: () => "new foreground should not run",
    }),
    "new:new session transcript"
  );
  assert.equal(maxActive, 1);
});

test("late corrections clean only the latest full snapshot", async () => {
  const scheduler = createScheduler();
  const inputs = [];
  scheduler.startSession({
    enabled: true,
    prepare: (text) => ({
      key: text,
      run: async () => {
        inputs.push(text);
        return text.replace("Tuesday", "Thursday");
      },
    }),
  });
  scheduler.update("Book it Tuesday at nine");
  scheduler.update("Book it Thursday at nine");
  await wait();

  assert.equal(
    await scheduler.finalize({
      key: "Book it Thursday at nine",
      run: () => "foreground should not run",
    }),
    "Book it Thursday at nine"
  );
  assert.deepEqual(inputs, ["Book it Thursday at nine"]);
});

test("a one-word dictation skips background work but still runs canonical cleanup", async () => {
  const scheduler = createScheduler({ minCharacters: 8, minWords: 2 });
  let backgroundCalls = 0;
  let foregroundCalls = 0;
  scheduler.startSession({
    enabled: true,
    prepare: (text) => ({
      key: text,
      run: async () => {
        backgroundCalls += 1;
        return text;
      },
    }),
  });
  scheduler.update("Hello");
  await wait();

  assert.equal(
    await scheduler.finalize({
      key: "Hello",
      run: () => {
        foregroundCalls += 1;
        return "Hello";
      },
    }),
    "Hello"
  );
  assert.equal(backgroundCalls, 0);
  assert.equal(foregroundCalls, 1);
});

test("an exact in-flight match is reused without duplicate model work", async () => {
  const scheduler = createScheduler();
  let resolveBackground;
  let backgroundCalls = 0;
  let foregroundCalls = 0;
  scheduler.startSession({
    enabled: true,
    prepare: (text) => ({
      key: text,
      run: () => {
        backgroundCalls += 1;
        return new Promise((resolve) => {
          resolveBackground = resolve;
        });
      },
    }),
  });
  scheduler.update("wait for this exact cleanup");
  await wait();

  const final = scheduler.finalize({
    key: "wait for this exact cleanup",
    run: () => {
      foregroundCalls += 1;
      return "duplicate";
    },
  });
  await wait();
  resolveBackground("shared result");

  assert.equal(await final, "shared result");
  assert.equal(backgroundCalls, 1);
  assert.equal(foregroundCalls, 0);
});
