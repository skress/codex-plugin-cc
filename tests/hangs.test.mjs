import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { ensureBrokerSession, sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { readProcessStartToken } from "../plugins/codex/scripts/lib/process.mjs";
import { listJobs, readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

// Process start tokens are not available on Windows.
const TOKENS = process.platform === "win32" ? { skip: "no process start tokens on Windows" } : {};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

// Short limits so a withheld reply fails within seconds instead of minutes.
const FAST_TIMEOUTS = {
  CODEX_COMPANION_RPC_TIMEOUT_MS: "1500",
  CODEX_COMPANION_TURN_IDLE_TIMEOUT_MS: "1500",
  CODEX_COMPANION_CLOSE_TIMEOUT_MS: "1000"
};

function setupRepo(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return {
    repo,
    binDir,
    fakeState: () => JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8")),
    env: (sessionId = "sess-a", extra = {}) => ({
      ...buildEnv(binDir),
      ...FAST_TIMEOUTS,
      CODEX_COMPANION_SESSION_ID: sessionId,
      ...extra
    })
  };
}

function task(ctx, args, options = {}) {
  return spawnSync("node", [SCRIPT, "task", ...args], {
    cwd: ctx.repo,
    env: options.env ?? ctx.env(),
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60000
  });
}

// A thread linked under the key, so --resume-last resumes it.
function linkThread(ctx, key, threadId = "thr_1") {
  assert.equal(task(ctx, ["--link-key", key, "--json", "first round"]).status, 0);
  if (threadId) {
    assert.equal(listJobs(ctx.repo).find((job) => job.linkKey === key)?.threadId, threadId);
  }
}

function jobsForKey(ctx, key) {
  return listJobs(ctx.repo).filter((job) => job.linkKey === key);
}

function deadPid() {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

test("resume asks Codex for thread metadata only (excludeTurns)", () => {
  const ctx = setupRepo();
  linkThread(ctx, "impl");

  const result = task(ctx, ["--link-key", "impl", "--resume-last", "--json", "second round"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).resumed, true);
  assert.equal(ctx.fakeState().lastResumeParams.excludeTurns, true);
});

test("resume falls back to a full resume when the app-server rejects excludeTurns", () => {
  const ctx = setupRepo("resume-rejects-exclude-turns");
  linkThread(ctx, "impl");

  const result = task(ctx, ["--link-key", "impl", "--resume-last", "--json", "second round"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).threadId, "thr_1");
  assert.equal("excludeTurns" in ctx.fakeState().lastResumeParams, false);
});

test("a large resume reply reaches the companion through the broker", () => {
  const ctx = setupRepo("resume-large-reply");
  linkThread(ctx, "impl");
  const env = ctx.env("sess-a");

  // Without excludeTurns support the fake sends ~3 MB of history in many chunks.
  const result = spawnSync("node", ["-e", `
    import(${JSON.stringify(path.join(ROOT, "plugins", "codex", "scripts", "lib", "app-server.mjs"))}).then(async ({ CodexAppServerClient }) => {
      const client = await CodexAppServerClient.connect(process.argv[1]);
      const response = await client.request("thread/resume", { threadId: "thr_1", cwd: process.argv[1] });
      process.stdout.write(String(JSON.stringify(response).length) + " " + client.transport);
      await client.close();
    });
  `, ctx.repo], { cwd: ctx.repo, env, encoding: "utf8", timeout: 30000 });

  assert.equal(result.status, 0, result.stderr);
  const [length, transport] = result.stdout.split(" ");
  assert.equal(transport, "broker");
  assert.ok(Number(length) > 3 * 1024 * 1024, `reply was ${length} bytes`);
});

test("a resume that never returns fails the job with a clear message instead of hanging", () => {
  const ctx = setupRepo("resume-hangs");
  linkThread(ctx, "impl");

  const started = Date.now();
  const result = task(ctx, ["--link-key", "impl", "--resume-last", "--json", "second round"], { timeoutMs: 30000 });

  assert.notEqual(result.error?.code, "ETIMEDOUT", "the companion hung");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /thread\/resume/);
  assert.match(result.stderr, /did not answer/);
  assert.ok(Date.now() - started < 25000);
  const failed = jobsForKey(ctx, "impl").find((job) => job.status !== "completed");
  assert.equal(failed.status, "failed");
  assert.match(failed.errorMessage, /thread\/resume/);
  assert.equal(failed.pid, null);
  // No turn was started on the thread whose resume never returned.
  assert.equal(ctx.fakeState().turnStartRequests, 1);
});

test("after a resume timeout the shared broker restarts Codex and the resume is retried once", () => {
  const ctx = setupRepo("resume-hangs-once");
  linkThread(ctx, "impl");
  const startsBefore = ctx.fakeState().appServerStarts;

  const result = task(ctx, ["--link-key", "impl", "--resume-last", "--json", "second round"], { timeoutMs: 30000 });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.resumed, true);
  assert.ok(ctx.fakeState().appServerStarts > startsBefore, "the broker did not restart its Codex app-server");
  assert.equal(ctx.fakeState().resumeRequests, 2);
  assert.equal(ctx.fakeState().turnStartRequests, 2);
});

test("a broker keeps serving other clients after an upstream request timed out", () => {
  const ctx = setupRepo("resume-hangs");
  linkThread(ctx, "impl");
  assert.equal(task(ctx, ["--link-key", "impl", "--resume-last", "--json", "second round"], { timeoutMs: 30000 }).status, 1);

  const fresh = task(ctx, ["--link-key", "review", "--json", "new thread"]);

  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(JSON.parse(fresh.stdout).resumed, false);
});

test("a turn/start that is never acknowledged fails without replaying the turn", () => {
  const ctx = setupRepo("turn-start-hangs");

  const result = task(ctx, ["--link-key", "impl", "--json", "first round"], { timeoutMs: 30000 });

  assert.notEqual(result.error?.code, "ETIMEDOUT", "the companion hung");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /turn\/start/);
  assert.match(result.stderr, /may still be running/);
  assert.equal(ctx.fakeState().turnStartRequests, 1);
  assert.equal(jobsForKey(ctx, "impl")[0].status, "failed");
});

test("a turn that goes quiet is interrupted after the idle limit and the job fails", () => {
  const ctx = setupRepo("turn-never-completes");

  const result = task(ctx, ["--link-key", "impl", "--json", "first round"], { timeoutMs: 30000 });

  assert.notEqual(result.error?.code, "ETIMEDOUT", "the companion hung");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No activity from Codex/);
  assert.equal(ctx.fakeState().lastInterrupt.threadId, "thr_1");
  const [job] = jobsForKey(ctx, "impl");
  assert.equal(job.status, "failed");
  assert.match(job.errorMessage, /No activity from Codex/);
});

test("a running job whose process is gone no longer blocks its link key and shows as failed", () => {
  const ctx = setupRepo();
  linkThread(ctx, "impl");
  upsertJob(ctx.repo, {
    id: "task-dead",
    kind: "task",
    jobClass: "task",
    status: "running",
    phase: "starting",
    sessionId: "sess-a",
    linkKey: "impl",
    pid: deadPid()
  });
  writeJobFile(ctx.repo, "task-dead", { id: "task-dead", status: "running", phase: "starting", linkKey: "impl" });

  const status = run("node", [SCRIPT, "status", "--json"], { cwd: ctx.repo, env: ctx.env() });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const result = task(ctx, ["--link-key", "impl", "--resume-last", "--json", "second round"]);
  assert.equal(result.status, 0, result.stderr);

  const dead = listJobs(ctx.repo).find((job) => job.id === "task-dead");
  assert.equal(dead.status, "failed");
  assert.match(dead.errorMessage, /exited before the job finished/);
  const stored = readJobFile(resolveJobFile(ctx.repo, "task-dead"));
  assert.equal(stored.status, "failed");
  assert.match(stored.errorMessage, /exited before the job finished/);
});

test("a running job whose pid now belongs to another process is treated as dead", TOKENS, () => {
  const ctx = setupRepo();
  upsertJob(ctx.repo, {
    id: "task-reused",
    kind: "task",
    jobClass: "task",
    status: "running",
    sessionId: "sess-a",
    linkKey: "impl",
    pid: process.pid,
    pidStartToken: "not-the-start-of-this-process"
  });

  const result = task(ctx, ["--link-key", "impl", "--resume-last", "--json", "question"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(listJobs(ctx.repo).find((job) => job.id === "task-reused").status, "failed");
});

test("a running job whose process is alive still blocks its link key", () => {
  const ctx = setupRepo();
  upsertJob(ctx.repo, {
    id: "task-alive",
    kind: "task",
    jobClass: "task",
    status: "running",
    sessionId: "sess-a",
    linkKey: "impl",
    pid: process.pid,
    pidStartToken: readProcessStartToken(process.pid)
  });

  const result = task(ctx, ["--link-key", "impl", "--resume-last", "--json", "question"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is still running/);
  assert.equal(listJobs(ctx.repo).find((job) => job.id === "task-alive").status, "running");
});

test("a job records the start token of its process", TOKENS, () => {
  const ctx = setupRepo("turn-never-completes");
  const child = spawn("node", [SCRIPT, "task", "--link-key", "impl", "--json", "first round"], {
    cwd: ctx.repo,
    env: ctx.env("sess-a", { CODEX_COMPANION_TURN_IDLE_TIMEOUT_MS: "60000" }),
    stdio: "ignore"
  });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const poll = () => {
      const job = jobsForKey(ctx, "impl")[0];
      if (job?.status === "running" && job.pid === child.pid && job.pidStartToken) {
        try {
          assert.equal(job.pidStartToken, readProcessStartToken(child.pid));
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          child.kill("SIGKILL");
        }
        return;
      }
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        reject(new Error(`no running job with a start token: ${JSON.stringify(job)}`));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
});

test("a foreground task stopped by SIGTERM marks its job failed", async () => {
  const ctx = setupRepo("turn-never-completes");
  const child = spawn("node", [SCRIPT, "task", "--link-key", "impl", "--json", "first round"], {
    cwd: ctx.repo,
    env: ctx.env("sess-a", { CODEX_COMPANION_TURN_IDLE_TIMEOUT_MS: "60000" }),
    stdio: "ignore"
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

  const deadline = Date.now() + 15000;
  while (!(jobsForKey(ctx, "impl")[0]?.threadId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGTERM");
  const { code } = await exited;

  assert.notEqual(code, 0);
  const [job] = jobsForKey(ctx, "impl");
  assert.equal(job.status, "failed");
  assert.match(job.errorMessage, /SIGTERM/);
  assert.equal(job.pid, null);
});

test("a late reply after a client-side timeout is ignored and the client keeps working", async () => {
  const ctx = setupRepo("resume-slow-once");
  linkThread(ctx, "impl");
  const client = await CodexAppServerClient.connect(ctx.repo, {
    disableBroker: true,
    env: ctx.env(),
    requestTimeoutMs: 300
  });
  try {
    await assert.rejects(
      client.request("thread/resume", { threadId: "thr_1", cwd: ctx.repo }),
      (error) => error.code === "RPC_TIMEOUT" && /thread\/resume/.test(error.message)
    );
    assert.equal(client.pending.size, 0);
    // The fake answers the first resume after 800 ms; that reply must be dropped.
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(ctx.fakeState().resumeDelayConsumed, true);
    const response = await client.request("thread/resume", { threadId: "thr_1", cwd: ctx.repo }, { timeoutMs: 5000 });
    assert.equal(response.thread.id, "thr_1");
    assert.equal(client.pending.size, 0);
  } finally {
    await client.close();
  }
});

test("closing a client whose app-server ignores stdin end and SIGTERM still finishes", async () => {
  const ctx = setupRepo("ignores-shutdown");
  const client = await CodexAppServerClient.connect(ctx.repo, {
    disableBroker: true,
    env: ctx.env(),
    closeTimeoutMs: 300
  });
  const started = Date.now();
  await client.close();
  assert.ok(Date.now() - started < 5000, `close took ${Date.now() - started} ms`);
  assert.notEqual(client.proc.exitCode === null && client.proc.signalCode === null, true);
});


function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("an app-server that never answers initialize is killed and connect fails", async () => {
  const ctx = setupRepo("initialize-hangs");
  const started = Date.now();
  await assert.rejects(
    CodexAppServerClient.connect(ctx.repo, { disableBroker: true, env: ctx.env(), requestTimeoutMs: 300, closeTimeoutMs: 300 }),
    /initialize/
  );
  assert.ok(Date.now() - started < 5000);
  const [pid] = ctx.fakeState().appServerPids;
  assert.ok(await waitUntil(() => !isAlive(pid)), `app-server ${pid} still running`);
});

test("a direct app-server that closes its output fails pending requests at once", async () => {
  const ctx = setupRepo("closes-stdout");
  const client = await CodexAppServerClient.connect(ctx.repo, {
    disableBroker: true,
    env: ctx.env(),
    requestTimeoutMs: 30000,
    closeTimeoutMs: 300
  });
  const started = Date.now();
  try {
    await assert.rejects(client.request("thread/start", { cwd: ctx.repo }), /closed|exited/);
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  } finally {
    await client.close();
  }
});

test("events of other threads do not keep a quiet turn alive", () => {
  const ctx = setupRepo("turn-quiet-with-noise");

  const result = task(ctx, ["--link-key", "impl", "--json", "first round"], { timeoutMs: 20000 });

  assert.notEqual(result.error?.code, "ETIMEDOUT", "the idle limit never fired");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No activity from Codex/);
});

function brokerSocket(endpoint) {
  const socket = net.createConnection({ path: parseBrokerEndpoint(endpoint).path });
  socket.setEncoding("utf8");
  const messages = [];
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) {
        messages.push(JSON.parse(line));
      }
    }
  });
  socket.on("error", () => {});
  let nextId = 1;
  return {
    socket,
    messages,
    connected: new Promise((resolve) => socket.on("connect", resolve)),
    send(method, params = {}) {
      const id = nextId++;
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
      return id;
    },
    async reply(id, timeoutMs = 5000) {
      assert.ok(await waitUntil(() => messages.some((message) => message.id === id), timeoutMs), `no reply to ${id}`);
      return messages.find((message) => message.id === id);
    }
  };
}

async function startBroker(ctx) {
  const env = ctx.env();
  const session = await ensureBrokerSession(ctx.repo, { env });
  assert.ok(session?.endpoint, "broker did not start");
  return session.endpoint;
}

for (const when of ["before turn/start is acknowledged", "while its turn runs"]) {
  test(`a client that disconnects ${when} gets its turn interrupted and leaks no events`, async () => {
    const ctx = setupRepo(when.startsWith("before") ? "turn-start-slow-ack" : "turn-never-completes");
    const endpoint = await startBroker(ctx);

    const a = brokerSocket(endpoint);
    await a.connected;
    const started = await a.reply(a.send("thread/start", { cwd: ctx.repo }));
    const threadA = started.result.thread.id;
    const turnRequest = a.send("turn/start", { threadId: threadA, input: [{ type: "text", text: "go", text_elements: [] }] });
    if (!when.startsWith("before")) {
      await a.reply(turnRequest);
    }
    a.socket.destroy();

    // Another client may only proceed once the orphaned turn is over.
    const b = brokerSocket(endpoint);
    await b.connected;
    let answer;
    const deadline = Date.now() + 8000;
    do {
      answer = await b.reply(b.send("thread/list", {}));
      if (answer.error?.code !== BROKER_BUSY_RPC_CODE) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);

    assert.equal(answer.error, undefined, JSON.stringify(answer.error));
    assert.equal(ctx.fakeState().lastInterrupt?.threadId, threadA);
    const leaked = b.messages.filter((message) => message.method && message.params?.threadId === threadA);
    assert.deepEqual(leaked, []);
    b.socket.destroy();
    await sendBrokerShutdown(endpoint);
  });
}

test("a broker shutdown request to a silent endpoint returns within its limit", async () => {
  const dir = makeTempDir();
  const socketPath = path.join(dir, "silent.sock");
  const held = [];
  const server = net.createServer((socket) => held.push(socket));
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const started = Date.now();
    await sendBrokerShutdown(`unix:${socketPath}`, { timeoutMs: 300 });
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  } finally {
    for (const socket of held) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

function recordForeignRunningJob(ctx, pid, extra = {}) {
  upsertJob(ctx.repo, {
    id: "task-foreign",
    kind: "task",
    jobClass: "task",
    status: "running",
    sessionId: "sess-a",
    pid,
    pidStartToken: "not-the-start-of-this-process",
    ...extra
  });
}

function spawnSleeper() {
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  sleeper.unref();
  return sleeper;
}

test("cancel does not signal a process that reused a job's pid", TOKENS, async (t) => {
  const ctx = setupRepo();
  const sleeper = spawnSleeper();
  t.after(() => sleeper.kill("SIGKILL"));
  recordForeignRunningJob(ctx, sleeper.pid);

  const result = run("node", [SCRIPT, "cancel", "task-foreign", "--json"], { cwd: ctx.repo, env: ctx.env() });

  assert.equal(result.status, 0, result.stderr);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(isAlive(sleeper.pid), true, "cancel killed an unrelated process");
  assert.equal(listJobs(ctx.repo).find((job) => job.id === "task-foreign").status, "cancelled");
});

test("SessionEnd does not signal a process that reused a job's pid", TOKENS, async (t) => {
  const ctx = setupRepo();
  const sleeper = spawnSleeper();
  t.after(() => sleeper.kill("SIGKILL"));
  recordForeignRunningJob(ctx, sleeper.pid);

  const result = run("node", [path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs"), "SessionEnd"], {
    cwd: ctx.repo,
    env: ctx.env(),
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-a", cwd: ctx.repo })
  });

  assert.equal(result.status, 0, result.stderr);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(isAlive(sleeper.pid), true, "SessionEnd killed an unrelated process");
  assert.equal(listJobs(ctx.repo).some((job) => job.id === "task-foreign"), false);
});
