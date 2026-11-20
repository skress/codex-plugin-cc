import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { getSessionLink, listJobs, setSessionLink, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

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
    envFor: (sessionId) => ({ ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: sessionId })
  };
}

function task(ctx, sessionId, args) {
  return run("node", [SCRIPT, "task", ...args], { cwd: ctx.repo, env: ctx.envFor(sessionId) });
}

function endSession(ctx, sessionId) {
  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: ctx.repo,
    env: ctx.envFor(sessionId),
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId, cwd: ctx.repo })
  });
  assert.equal(result.status, 0, result.stderr);
}

test("a task run links its thread to the Claude session", () => {
  const ctx = setupRepo();

  const result = task(ctx, "sess-a", ["initial task"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(getSessionLink(ctx.repo, "sess-a").threadId, "thr_1");
});

test("task --resume-last continues the linked thread after the Claude session ended and was resumed", () => {
  const ctx = setupRepo();
  assert.equal(task(ctx, "sess-a", ["initial task"]).status, 0);
  endSession(ctx, "sess-a");

  const result = task(ctx, "sess-a", ["--resume-last", "--json", "follow up"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.resumed, true);
  assert.equal(ctx.fakeState().lastTurnStart.threadId, "thr_1");
});

test("task --resume-last starts a fresh thread when the session has no linked thread", () => {
  const ctx = setupRepo();
  assert.equal(task(ctx, "sess-other", ["other session task"]).status, 0);

  const result = task(ctx, "sess-a", ["--resume-last", "--json", "first question"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.resumed, false);
  assert.equal(payload.threadId, "thr_2");
  assert.equal(ctx.fakeState().lastTurnStart.prompt, "first question");
  assert.equal(getSessionLink(ctx.repo, "sess-a").threadId, "thr_2");
});

test("a fresh task run moves the session link to the new thread", () => {
  const ctx = setupRepo();
  assert.equal(task(ctx, "sess-a", ["initial task"]).status, 0);
  assert.equal(task(ctx, "sess-a", ["--fresh", "start over"]).status, 0);

  const result = task(ctx, "sess-a", ["--resume-last", "--json", "follow up"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).threadId, "thr_2");
});

test("task --no-link leaves the session link unchanged", () => {
  const ctx = setupRepo();
  assert.equal(task(ctx, "sess-a", ["initial task"]).status, 0);

  const result = task(ctx, "sess-a", ["--no-link", "side question"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(ctx.fakeState().lastTurnStart.threadId, "thr_2");
  assert.equal(getSessionLink(ctx.repo, "sess-a").threadId, "thr_1");
});

test("task --resume-last refuses while a task of the same session is running", () => {
  const ctx = setupRepo("slow-task");
  setSessionLink(ctx.repo, "sess-a", "thr_linked");
  const background = task(ctx, "sess-a", ["--background", "--json", "long task"]);
  assert.equal(background.status, 0, background.stderr);

  const result = task(ctx, "sess-a", ["--resume-last", "follow up"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is still running/);
});

test("task-resume-candidate reports the linked thread after the Claude session ended", () => {
  const ctx = setupRepo();
  assert.equal(task(ctx, "sess-a", ["initial task"]).status, 0);
  endSession(ctx, "sess-a");

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: ctx.repo,
    env: ctx.envFor("sess-a")
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-a");
  assert.equal(payload.candidate.threadId, "thr_1");
});

test("task --json reports the failure message of a failed turn", () => {
  const ctx = setupRepo("turn-fails");

  const result = task(ctx, "sess-a", ["--json", "hi"]);

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 1);
  assert.match(payload.errorMessage, /model is not supported/);
});

test("task --json reports a null errorMessage on success", () => {
  const ctx = setupRepo();

  const result = task(ctx, "sess-a", ["--json", "hi"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).errorMessage, null);
});

test("the stop-time review gate does not move the session link", () => {
  const ctx = setupRepo();
  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: ctx.repo,
    env: ctx.envFor("sess-a")
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(task(ctx, "sess-a", ["initial task"]).status, 0);

  const stop = run("node", [STOP_HOOK], {
    cwd: ctx.repo,
    env: buildEnv(ctx.binDir),
    input: JSON.stringify({ cwd: ctx.repo, session_id: "sess-a", last_assistant_message: "Done." })
  });

  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(ctx.fakeState().lastTurnStart.threadId, "thr_2");
  assert.equal(getSessionLink(ctx.repo, "sess-a").threadId, "thr_1");
});

test("task --link-key keeps its own thread and leaves the session link untouched", () => {
  const ctx = setupRepo();
  assert.equal(task(ctx, "sess-a", ["initial task"]).status, 0);

  const first = task(ctx, "sess-a", ["--link-key", "m1-task-1-impl", "--resume-last", "--json", "keyed question"]);
  const second = task(ctx, "sess-a", ["--link-key", "m1-task-1-impl", "--resume-last", "--json", "keyed follow up"]);
  const plain = task(ctx, "sess-a", ["--resume-last", "--json", "session follow up"]);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).resumed, false);
  assert.equal(JSON.parse(first.stdout).threadId, "thr_2");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).resumed, true);
  assert.equal(JSON.parse(second.stdout).threadId, "thr_2");
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(JSON.parse(plain.stdout).threadId, "thr_1");
  assert.equal(getSessionLink(ctx.repo, "sess-a").threadId, "thr_1");
});

test("two link keys of one session keep separate threads", () => {
  const ctx = setupRepo();
  assert.equal(task(ctx, "sess-a", ["--link-key", "impl", "--resume-last", "first"]).status, 0);
  const review = task(ctx, "sess-a", ["--link-key", "review", "--resume-last", "--json", "second"]);
  assert.equal(review.status, 0, review.stderr);
  assert.equal(JSON.parse(review.stdout).threadId, "thr_2");

  const result = task(ctx, "sess-a", ["--link-key", "impl", "--resume-last", "--json", "back to impl"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).threadId, "thr_1");
});

test("the same link key in another Claude session does not share the thread", () => {
  const ctx = setupRepo();
  assert.equal(task(ctx, "sess-a", ["--link-key", "impl", "--resume-last", "first"]).status, 0);
  assert.equal(task(ctx, "sess-b", ["sess-b default thread"]).status, 0);

  const result = task(ctx, "sess-b", ["--link-key", "impl", "--resume-last", "--json", "other session"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).resumed, false);
  assert.equal(JSON.parse(result.stdout).threadId, "thr_3");
  assert.equal(getSessionLink(ctx.repo, "sess-b").threadId, "thr_2");
});

test("task --link-key --fresh moves only that key's link", () => {
  const ctx = setupRepo();
  assert.equal(task(ctx, "sess-a", ["initial task"]).status, 0);
  assert.equal(task(ctx, "sess-a", ["--link-key", "impl", "--resume-last", "keyed"]).status, 0);
  assert.equal(task(ctx, "sess-a", ["--link-key", "impl", "--fresh", "keyed restart"]).status, 0);

  const keyed = task(ctx, "sess-a", ["--link-key", "impl", "--resume-last", "--json", "keyed follow up"]);

  assert.equal(keyed.status, 0, keyed.stderr);
  assert.equal(JSON.parse(keyed.stdout).threadId, "thr_3");
  assert.equal(getSessionLink(ctx.repo, "sess-a").threadId, "thr_1");
});

test("task --link-key --resume-last without a session id never falls back to the latest thread", () => {
  const ctx = setupRepo();
  const env = buildEnv(ctx.binDir);
  delete env.CODEX_COMPANION_SESSION_ID;
  assert.equal(run("node", [SCRIPT, "task", "unlinked task"], { cwd: ctx.repo, env }).status, 0);

  const first = run("node", [SCRIPT, "task", "--link-key", "impl", "--resume-last", "--json", "keyed"], { cwd: ctx.repo, env });
  const second = run("node", [SCRIPT, "task", "--link-key", "impl", "--resume-last", "--json", "keyed again"], { cwd: ctx.repo, env });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).resumed, false);
  assert.equal(JSON.parse(first.stdout).threadId, "thr_2");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).threadId, "thr_2");
});

test("jobs run with --link-key stay owned by the Claude session", () => {
  const ctx = setupRepo();
  assert.equal(task(ctx, "sess-a", ["--link-key", "impl", "--resume-last", "keyed"]).status, 0);

  const jobs = listJobs(ctx.repo);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sessionId, "sess-a");
  assert.equal(jobs[0].linkKey, "impl");

  endSession(ctx, "sess-a");
  assert.equal(listJobs(ctx.repo).length, 0);
});

test("task --link-key with --no-link is refused", () => {
  const ctx = setupRepo();

  const result = task(ctx, "sess-a", ["--link-key", "impl", "--no-link", "question"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--link-key.*--no-link|--no-link.*--link-key/);
});

test("task refuses a malformed link key", () => {
  const ctx = setupRepo();
  for (const key of ["", "has space", "a/b", "a#b", "-leading-dash", "x".repeat(129)]) {
    const result = task(ctx, "sess-a", ["--link-key", key, "question"]);
    assert.equal(result.status, 1, `key ${JSON.stringify(key)} was accepted`);
    assert.match(result.stderr, /--link-key/);
  }
});

function recordRunningTask(ctx, sessionId, linkKey) {
  upsertJob(ctx.repo, {
    id: `task-running-${linkKey ?? "default"}-${sessionId ?? "none"}`,
    kind: "task",
    jobClass: "task",
    status: "running",
    ...(sessionId ? { sessionId } : {}),
    ...(linkKey ? { linkKey } : {})
  });
}

test("a running task blocks --resume-last only for the same link key", () => {
  const ctx = setupRepo();
  recordRunningTask(ctx, "sess-a", "impl");

  const sameKey = task(ctx, "sess-a", ["--link-key", "impl", "--resume-last", "follow up"]);
  const otherKey = task(ctx, "sess-a", ["--link-key", "review", "--resume-last", "--json", "review question"]);
  const unkeyed = task(ctx, "sess-a", ["--resume-last", "--json", "session question"]);

  assert.equal(sameKey.status, 1);
  assert.match(sameKey.stderr, /is still running/);
  assert.equal(otherKey.status, 0, otherKey.stderr);
  assert.equal(unkeyed.status, 0, unkeyed.stderr);
});

test("a running unkeyed task does not block a keyed --resume-last", () => {
  const ctx = setupRepo();
  recordRunningTask(ctx, "sess-a", null);

  const keyed = task(ctx, "sess-a", ["--link-key", "impl", "--resume-last", "--json", "keyed question"]);
  const unkeyed = task(ctx, "sess-a", ["--resume-last", "session question"]);

  assert.equal(keyed.status, 0, keyed.stderr);
  assert.equal(unkeyed.status, 1);
  assert.match(unkeyed.stderr, /is still running/);
});

test("without a session id a keyed run is not blocked by another session's task with the same key", () => {
  const ctx = setupRepo();
  recordRunningTask(ctx, "sess-a", "impl");
  const env = buildEnv(ctx.binDir);
  delete env.CODEX_COMPANION_SESSION_ID;

  const result = run("node", [SCRIPT, "task", "--link-key", "impl", "--resume-last", "--json", "keyed"], { cwd: ctx.repo, env });

  assert.equal(result.status, 0, result.stderr);
});

test("without a session id an unkeyed --resume-last never continues a keyed thread", () => {
  const ctx = setupRepo();
  const env = buildEnv(ctx.binDir);
  delete env.CODEX_COMPANION_SESSION_ID;
  assert.equal(run("node", [SCRIPT, "task", "--link-key", "impl", "--resume-last", "keyed"], { cwd: ctx.repo, env }).status, 0);

  const result = run("node", [SCRIPT, "task", "--resume-last", "--json", "unkeyed"], { cwd: ctx.repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(JSON.parse(result.stdout).threadId, "thr_1");
});

test("a background task with --link-key links its thread under that key", async () => {
  const ctx = setupRepo();
  const background = task(ctx, "sess-a", ["--link-key", "impl", "--background", "--json", "background task"]);
  assert.equal(background.status, 0, background.stderr);
  const jobId = JSON.parse(background.stdout).jobId;
  assert.ok(jobId, background.stdout);

  const deadline = Date.now() + 10000;
  let job = null;
  while (Date.now() < deadline) {
    job = listJobs(ctx.repo).find((candidate) => candidate.id === jobId);
    if (job && job.status !== "queued" && job.status !== "running") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(job?.status, "completed");
  assert.equal(job.linkKey, "impl");

  const result = task(ctx, "sess-a", ["--link-key", "impl", "--resume-last", "--json", "follow up"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).resumed, true);
  assert.equal(JSON.parse(result.stdout).threadId, job.threadId);
  assert.equal(getSessionLink(ctx.repo, "sess-a"), null);
});

test("task refuses a link key with a second '=' and a key that swallows the next flag", () => {
  const ctx = setupRepo();

  const inline = task(ctx, "sess-a", ["--link-key=impl=bad", "question"]);
  const swallowed = task(ctx, "sess-a", ["--link-key", "--resume-last", "question"]);

  assert.equal(inline.status, 1);
  assert.match(inline.stderr, /--link-key/);
  assert.equal(swallowed.status, 1);
  assert.match(swallowed.stderr, /--link-key/);
});

test("concurrent link writes of one workspace are not lost", async () => {
  const ctx = setupRepo();
  const stateModule = path.join(PLUGIN_ROOT, "scripts", "lib", "state.mjs");
  const writers = 8;
  const perWriter = 15;
  const script = `
    const { setSessionLink } = await import(${JSON.stringify(stateModule)});
    const [writer, count] = process.argv.slice(1);
    for (let i = 0; i < Number(count); i += 1) {
      setSessionLink(process.cwd(), "sess#w" + writer + "-" + i, "thr_" + writer + "_" + i);
    }
  `;
  await Promise.all(
    Array.from({ length: writers }, (_, writer) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, String(writer), String(perWriter)], {
          cwd: ctx.repo,
          env: ctx.envFor("sess"),
          stdio: ["ignore", "ignore", "pipe"]
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
      })
    )
  );
  for (let writer = 0; writer < writers; writer += 1) {
    for (let i = 0; i < perWriter; i += 1) {
      assert.equal(getSessionLink(ctx.repo, `sess#w${writer}-${i}`)?.threadId, `thr_${writer}_${i}`);
    }
  }
});

test("a boolean option with a malformed inline value is refused", () => {
  const ctx = setupRepo();

  const result = task(ctx, "sess-a", ["--json=false=extra", "question"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--json/);
});
