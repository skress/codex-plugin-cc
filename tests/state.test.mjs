import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  getSessionLink,
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  setSessionLink
} from "../plugins/codex/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("setSessionLink records the thread for a Claude session", () => {
  const workspace = makeTempDir();

  setSessionLink(workspace, "sess-a", "thr_1");
  setSessionLink(workspace, "sess-b", "thr_2");
  setSessionLink(workspace, "sess-a", "thr_3");

  assert.equal(getSessionLink(workspace, "sess-a").threadId, "thr_3");
  assert.equal(getSessionLink(workspace, "sess-b").threadId, "thr_2");
  assert.equal(getSessionLink(workspace, "sess-missing"), null);
});

test("saveState keeps session links when the session's jobs are removed", () => {
  const workspace = makeTempDir();
  setSessionLink(workspace, "sess-a", "thr_1");

  const state = loadState(workspace);
  saveState(workspace, { ...state, jobs: [] });

  assert.equal(getSessionLink(workspace, "sess-a").threadId, "thr_1");
});

test("saveState drops session links older than 90 days and keeps at most 200", () => {
  const workspace = makeTempDir();
  const now = Date.now();
  const daysAgo = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const links = {
    "sess-stale": { threadId: "thr_stale", updatedAt: daysAgo(91) }
  };
  for (let index = 0; index < 201; index += 1) {
    links[`sess-${index}`] = { threadId: `thr_${index}`, updatedAt: new Date(now - index * 1000).toISOString() };
  }

  saveState(workspace, { ...loadState(workspace), links });

  const saved = loadState(workspace).links;
  assert.equal(Object.keys(saved).length, 200);
  assert.equal(saved["sess-stale"], undefined);
  assert.equal(saved["sess-200"], undefined);
  assert.equal(saved["sess-0"].threadId, "thr_0");
  assert.equal(saved["sess-199"].threadId, "thr_199");
});
