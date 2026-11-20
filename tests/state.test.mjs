import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  ensureStateDir,
  getSessionLink,
  loadState,
  pruneLinkFiles,
  readSessionLink,
  resolveJobFile,
  resolveLinkDir,
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

test("an abandoned lock file next to the state does not block link writes", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  fs.writeFileSync(`${resolveStateFile(workspace)}.lock`, "");

  const started = Date.now();
  setSessionLink(workspace, "sess-a", "thr_1");

  assert.ok(Date.now() - started < 2000, "link write waited for a lock");
  assert.equal(getSessionLink(workspace, "sess-a").threadId, "thr_1");
});

test("links in the old state file are ignored", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  fs.writeFileSync(
    resolveStateFile(workspace),
    JSON.stringify({ version: 1, config: {}, jobs: [], links: { "sess-a": { threadId: "thr_legacy", updatedAt: new Date().toISOString() } } })
  );

  assert.equal(getSessionLink(workspace, "sess-a"), null);
  assert.equal(loadState(workspace).links, undefined);
});

const DAY_MS = 24 * 60 * 60 * 1000;

function writeVersionDirectly(workspace, key, threadId, atMs) {
  const dir = resolveLinkDir(workspace, key);
  fs.mkdirSync(dir, { recursive: true });
  const rev = Math.random().toString(16).slice(2, 10).padEnd(16, "0");
  const name = `${String(atMs).padStart(15, "0")}-${rev}.json`;
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ key, threadId, updatedAt: new Date(atMs).toISOString(), rev }));
  return path.join(dir, name);
}

function versionsOf(workspace, key) {
  try {
    return fs.readdirSync(resolveLinkDir(workspace, key)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

test("the newest version of a link wins and older versions are pruned", () => {
  const workspace = makeTempDir();
  const now = Date.now();
  writeVersionDirectly(workspace, "sess-a", "thr_1", now - 3000);
  writeVersionDirectly(workspace, "sess-a", "thr_3", now - 1000);
  writeVersionDirectly(workspace, "sess-a", "thr_2", now - 2000);

  assert.equal(getSessionLink(workspace, "sess-a").threadId, "thr_3");
  pruneLinkFiles(workspace);
  assert.equal(versionsOf(workspace, "sess-a").length, 1);
  assert.equal(getSessionLink(workspace, "sess-a").threadId, "thr_3");
});

test("a write never gets an older name than the newest existing version", () => {
  const workspace = makeTempDir();
  writeVersionDirectly(workspace, "sess-a", "thr_future", Date.now() + 60000);

  setSessionLink(workspace, "sess-a", "thr_now");

  assert.equal(getSessionLink(workspace, "sess-a").threadId, "thr_now");
});

test("setSessionLink drops links older than 90 days and keeps at most 200 keys", () => {
  const workspace = makeTempDir();
  writeVersionDirectly(workspace, "sess-stale", "thr_stale", Date.now() - 91 * DAY_MS);

  for (let index = 0; index < 201; index += 1) {
    setSessionLink(workspace, `sess-${index}`, `thr_${index}`);
  }

  assert.equal(getSessionLink(workspace, "sess-stale"), null);
  assert.equal(getSessionLink(workspace, "sess-0"), null);
  assert.equal(getSessionLink(workspace, "sess-200").threadId, "thr_200");
  const keyDirs = fs.readdirSync(path.dirname(resolveLinkDir(workspace, "x")));
  assert.equal(keyDirs.length, 200);
});

test("an expired link rewritten while pruning ran keeps its new version", () => {
  const workspace = makeTempDir();
  writeVersionDirectly(workspace, "sess-x", "thr_old", Date.now() - 91 * DAY_MS);

  pruneLinkFiles(workspace, {
    afterList: () => writeVersionDirectly(workspace, "sess-x", "thr_refreshed", Date.now())
  });

  assert.equal(getSessionLink(workspace, "sess-x")?.threadId, "thr_refreshed");
});

test("an evicted link rewritten while pruning ran keeps its new version", () => {
  const workspace = makeTempDir();
  const now = Date.now();
  for (let index = 0; index < 201; index += 1) {
    writeVersionDirectly(workspace, `sess-${index}`, `thr_${index}`, now - index * 1000);
  }

  pruneLinkFiles(workspace, {
    afterList: () => writeVersionDirectly(workspace, "sess-200", "thr_200_refreshed", now + 1000)
  });

  assert.equal(getSessionLink(workspace, "sess-200")?.threadId, "thr_200_refreshed");
});

test("pruning tolerates another pruner deleting the same files", () => {
  const workspace = makeTempDir();
  const now = Date.now();
  writeVersionDirectly(workspace, "sess-a", "thr_old", now - 2000);
  writeVersionDirectly(workspace, "sess-a", "thr_new", now - 1000);
  const stale = writeVersionDirectly(workspace, "sess-stale", "thr_stale", now - 91 * DAY_MS);

  assert.doesNotThrow(() =>
    pruneLinkFiles(workspace, {
      afterList: () => {
        for (const name of versionsOf(workspace, "sess-a").sort().slice(0, 1)) {
          fs.rmSync(path.join(resolveLinkDir(workspace, "sess-a"), name));
        }
        fs.rmSync(stale);
      }
    })
  );
  assert.equal(getSessionLink(workspace, "sess-a").threadId, "thr_new");
});

test("pruning removes temp files of writers that died, but not fresh ones", () => {
  const workspace = makeTempDir();
  setSessionLink(workspace, "sess-a", "thr_1");
  const dir = resolveLinkDir(workspace, "sess-a");
  const oldTemp = path.join(dir, ".000000000000001-aaaaaaaaaaaaaaaa.json.tmp");
  const freshTemp = path.join(dir, ".000000000000002-bbbbbbbbbbbbbbbb.json.tmp");
  fs.writeFileSync(oldTemp, "{}");
  fs.writeFileSync(freshTemp, "{}");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(oldTemp, old, old);

  pruneLinkFiles(workspace);

  assert.ok(!fs.existsSync(oldTemp));
  assert.ok(fs.existsSync(freshTemp));
  assert.equal(getSessionLink(workspace, "sess-a").threadId, "thr_1");
});

test("a reader whose listed versions were pruned meanwhile finds the newer version", () => {
  const workspace = makeTempDir();
  const first = writeVersionDirectly(workspace, "sess-a", "thr_a", Date.now() - 1000);

  const link = readSessionLink(workspace, "sess-a", {
    afterList: (attempt) => {
      if (attempt === 0) {
        writeVersionDirectly(workspace, "sess-a", "thr_b", Date.now());
        fs.rmSync(first);
      }
    }
  });

  assert.equal(link?.threadId, "thr_b");
});

test("a read error never makes pruning delete a link", () => {
  const workspace = makeTempDir();
  const file = writeVersionDirectly(workspace, "sess-a", "thr_a", Date.now());

  pruneLinkFiles(workspace, {
    read: (filePath) => {
      if (filePath === file) {
        throw Object.assign(new Error("injected"), { code: "EIO" });
      }
      return fs.readFileSync(filePath, "utf8");
    }
  });

  assert.ok(fs.existsSync(file));
  assert.equal(getSessionLink(workspace, "sess-a").threadId, "thr_a");
});

test("a reader reports a read error instead of returning no link", () => {
  const workspace = makeTempDir();
  writeVersionDirectly(workspace, "sess-a", "thr_a", Date.now());

  assert.throws(
    () =>
      readSessionLink(workspace, "sess-a", {
        read: () => {
          throw Object.assign(new Error("injected"), { code: "EIO" });
        }
      }),
    /link/
  );
});

test("a write retries when a pruner removed the empty key directory", () => {
  const workspace = makeTempDir();
  let removed = false;

  setSessionLink(workspace, "sess-a", "thr_a", {
    afterMkdir: (dir) => {
      if (!removed) {
        removed = true;
        fs.rmdirSync(dir);
      }
    }
  });

  assert.ok(removed);
  assert.equal(getSessionLink(workspace, "sess-a").threadId, "thr_a");
});

test("a reader retries when a version newer than the one it found vanished", () => {
  const workspace = makeTempDir();
  writeVersionDirectly(workspace, "sess-a", "thr_expired", Date.now() - 91 * DAY_MS);
  const fresh = writeVersionDirectly(workspace, "sess-a", "thr_b", Date.now() - 1000);

  const link = readSessionLink(workspace, "sess-a", {
    afterList: (attempt) => {
      if (attempt === 0) {
        writeVersionDirectly(workspace, "sess-a", "thr_c", Date.now());
        fs.rmSync(fresh);
      }
    }
  });

  assert.equal(link?.threadId, "thr_c");
});

test("a reader that never gets a stable listing reports an error, not a missing link", () => {
  const workspace = makeTempDir();
  writeVersionDirectly(workspace, "sess-a", "thr_0", Date.now() - 1000);
  let counter = 0;

  assert.throws(
    () =>
      readSessionLink(workspace, "sess-a", {
        afterList: () => {
          const dir = resolveLinkDir(workspace, "sess-a");
          for (const name of fs.readdirSync(dir)) {
            fs.rmSync(path.join(dir, name));
          }
          counter += 1;
          writeVersionDirectly(workspace, "sess-a", `thr_${counter}`, Date.now() + counter);
        }
      }),
    /link/
  );
});

test("pruning syncs a key's directory before it deletes older versions", () => {
  const workspace = makeTempDir();
  const now = Date.now();
  const older = writeVersionDirectly(workspace, "sess-a", "thr_old", now - 2000);
  writeVersionDirectly(workspace, "sess-a", "thr_new", now - 1000);
  const events = [];

  pruneLinkFiles(workspace, {
    syncDir: (dir) => events.push(["sync", dir]),
    unlink: (filePath) => {
      events.push(["unlink", filePath]);
      fs.rmSync(filePath, { force: true });
    }
  });

  const keyDir = resolveLinkDir(workspace, "sess-a");
  const unlinkIndex = events.findIndex(([kind, target]) => kind === "unlink" && target === older);
  assert.ok(unlinkIndex > 0, JSON.stringify(events));
  const synced = events.slice(0, unlinkIndex).filter(([kind]) => kind === "sync").map(([, dir]) => dir);
  assert.ok(synced.includes(keyDir) && synced.includes(path.dirname(keyDir)), JSON.stringify(events));
});

test("a write completes even when the file system accepts only a few bytes per call", () => {
  const workspace = makeTempDir();

  setSessionLink(workspace, "sess-a", "thr_" + "x".repeat(200), {
    writeChunk: (fd, buffer, offset) => fs.writeSync(fd, buffer, offset, Math.min(5, buffer.length - offset))
  });

  assert.equal(getSessionLink(workspace, "sess-a").threadId, "thr_" + "x".repeat(200));
});

test("pruning skips a key whose directory another pruner removed meanwhile", () => {
  const workspace = makeTempDir();
  const now = Date.now();
  writeVersionDirectly(workspace, "sess-a", "thr_old", now - 2000);
  writeVersionDirectly(workspace, "sess-a", "thr_new", now - 1000);

  assert.doesNotThrow(() =>
    pruneLinkFiles(workspace, {
      afterList: () => fs.rmSync(resolveLinkDir(workspace, "sess-a"), { recursive: true, force: true })
    })
  );
});

test("a published link is not reported as failed when pruning fails afterwards", () => {
  const workspace = makeTempDir();

  assert.doesNotThrow(() =>
    setSessionLink(workspace, "sess-a", "thr_a", {
      prune: {
        afterList: () => {
          throw Object.assign(new Error("injected"), { code: "EIO" });
        }
      }
    })
  );
  assert.equal(getSessionLink(workspace, "sess-a").threadId, "thr_a");
});
