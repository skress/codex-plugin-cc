import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { getSessionLink, setSessionLink } from "../plugins/codex/scripts/lib/state.mjs";

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
