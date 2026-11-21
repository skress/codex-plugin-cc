import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { readProcessStartToken } from "../plugins/codex/scripts/lib/process.mjs";
import { listJobs, readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

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

test("a running job whose pid now belongs to another process is treated as dead", () => {
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

test("a job records the start token of its process", () => {
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
  const ctx = setupRepo("resume-hangs-once");
  linkThread(ctx, "impl");
  const client = await CodexAppServerClient.connect(ctx.repo, {
    disableBroker: true,
    env: ctx.env(),
    requestTimeoutMs: 500
  });
  try {
    await assert.rejects(
      client.request("thread/resume", { threadId: "thr_1", cwd: ctx.repo }),
      (error) => error.code === "RPC_TIMEOUT" && /thread\/resume/.test(error.message)
    );
    assert.equal(client.pending.size, 0);
    const response = await client.request("thread/resume", { threadId: "thr_1", cwd: ctx.repo });
    assert.equal(response.thread.id, "thr_1");
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

