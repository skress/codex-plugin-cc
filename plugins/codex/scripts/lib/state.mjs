import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const MAX_SESSION_LINKS = 200;
const SESSION_LINK_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    // `links` from older versions is dropped: links live in link files now.
    const { links: _legacyLinks, ...parsed } = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  // Write and rename, so a concurrent loadState never reads a torn file (which it
  // would treat as empty state). Files of dropped jobs go only after the new index
  // is in place, so the index never points at deleted files.
  const stateFile = resolveStateFile(cwd);
  const tempFile = `${stateFile}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, stateFile);

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

// Session links map a Claude session id (or "<session id>#<link key>") to its Codex
// thread. They outlive the session's jobs, so `--resume-last` still finds the
// thread after `claude --resume`. Links kept in state.json by older versions are
// not read.
//
// Each key has a directory under links/ holding immutable version files named
// "<15-digit ms>-<16 hex rev>.json". A write adds a new version (temp file, then
// rename) and never touches existing files; readers take the newest valid version.
// Pruning deletes only files it listed: older versions of a key, or every listed
// version of an expired or evicted key. A version written meanwhile is not on that
// list and survives, so concurrent writers and pruners never lose a newer link,
// and nothing needs a lock.
const LINK_VERSION_PATTERN = /^(\d{15})-([0-9a-f]{16})\.json$/;
const ABANDONED_TEMP_MS = 60 * 60 * 1000;

function resolveLinksDir(cwd) {
  return path.join(resolveStateDir(cwd), "links");
}

export function resolveLinkDir(cwd, key) {
  const hash = createHash("sha256").update(String(key)).digest("hex").slice(0, 40);
  return path.join(resolveLinksDir(cwd), hash);
}

function isFreshLink(link) {
  return Boolean(link?.threadId) && Date.parse(link.updatedAt ?? "") >= Date.now() - SESSION_LINK_MAX_AGE_MS;
}

function readDirNames(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return [];
    }
    throw error;
  }
}

// Version file names of a key, newest first.
function listVersions(dir) {
  return readDirNames(dir)
    .filter((name) => LINK_VERSION_PATTERN.test(name))
    .sort()
    .reverse();
}

const defaultRead = (filePath) => fs.readFileSync(filePath, "utf8");

// { link }, { gone: true } (ENOENT), { corrupt: true } (not JSON), or { error } for
// any other read failure, which callers must never treat as "no link".
function readLinkStrict(filePath, read = defaultRead) {
  let text;
  try {
    text = read(filePath);
  } catch (error) {
    return error?.code === "ENOENT" ? { gone: true } : { error };
  }
  try {
    return { link: JSON.parse(text) };
  } catch {
    return { corrupt: true };
  }
}

// The newest version among `names` (newest first) whose content belongs to `key`.
// Returns { name, link }, { error } if a newer version could not be read,
// { gone: true } if a newer listed version vanished meanwhile (the listing is
// stale: take it again), else null.
function newestValid(dir, names, key, read) {
  let gone = false;
  for (const name of names) {
    const result = readLinkStrict(path.join(dir, name), read);
    if (result.error) {
      return { error: result.error };
    }
    if (result.gone) {
      gone = true;
      continue;
    }
    if (result.link?.threadId && (key === undefined || result.link.key === key)) {
      return gone ? { gone: true } : { name, link: result.link };
    }
  }
  return gone ? { gone: true } : null;
}

function removeIfPresent(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function removeDirIfEmpty(dir) {
  try {
    fs.rmdirSync(dir);
  } catch {
    // not empty (a writer added a version) or already gone
  }
}

function randomRev() {
  return createHash("sha256").update(`${process.pid}.${Date.now()}.${Math.random()}`).digest("hex").slice(0, 16);
}

export function pruneLinkFiles(cwd, hooks = {}) {
  const linksDir = resolveLinksDir(cwd);
  const unlink = hooks.unlink ?? removeIfPresent;
  const sync = hooks.syncDir ?? syncDir;
  const plans = [];
  for (const entry of readDirNames(linksDir)) {
    const dir = path.join(linksDir, entry);
    const names = readDirNames(dir);
    for (const name of names) {
      if (name.startsWith(".") && name.endsWith(".tmp")) {
        try {
          if (Date.now() - fs.statSync(path.join(dir, name)).mtimeMs > ABANDONED_TEMP_MS) {
            removeIfPresent(path.join(dir, name)); // a writer died before its rename
          }
        } catch {
          // gone already
        }
      }
    }
    const versions = names.filter((name) => LINK_VERSION_PATTERN.test(name)).sort().reverse();
    const newest = newestValid(dir, versions, undefined, hooks.read);
    if (newest?.error || newest?.gone) {
      continue; // unreadable or changing under us: leave this key for a later prune
    }
    plans.push({ dir, versions, newest });
  }
  hooks.afterList?.();

  const live = [];
  for (const plan of plans) {
    if (!plan.newest || !isFreshLink(plan.newest.link)) {
      plan.versions.forEach((name) => unlink(path.join(plan.dir, name)));
      removeDirIfEmpty(plan.dir);
      continue;
    }
    // older than the newest valid version: superseded for good, once the newest
    // version's entry is durable (its writer may not have synced it yet)
    const superseded = plan.versions.filter((name) => name < plan.newest.name);
    if (superseded.length > 0) {
      try {
        sync(plan.dir);
        sync(linksDir);
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue; // another pruner removed the whole key meanwhile
        }
        throw error;
      }
      superseded.forEach((name) => unlink(path.join(plan.dir, name)));
    }
    live.push(plan);
  }
  live
    .sort((left, right) => right.newest.name.localeCompare(left.newest.name))
    .slice(MAX_SESSION_LINKS)
    .forEach((plan) => {
      plan.versions.forEach((name) => unlink(path.join(plan.dir, name)));
      removeDirIfEmpty(plan.dir);
    });
}

const LINK_READ_ATTEMPTS = 5;

// A listed version can vanish only because a newer one was written and pruning
// removed the older (or the key expired); then the listing is taken again.
export function readSessionLink(cwd, sessionId, hooks = {}) {
  if (!sessionId) {
    return null;
  }
  const dir = resolveLinkDir(cwd, sessionId);
  for (let attempt = 0; attempt < LINK_READ_ATTEMPTS; attempt += 1) {
    const names = listVersions(dir);
    hooks.afterList?.(attempt);
    const newest = newestValid(dir, names, sessionId, hooks.read);
    if (newest?.error) {
      throw new Error(`Cannot read the Codex thread link in ${dir}: ${newest.error.code ?? newest.error.message}.`);
    }
    if (newest?.gone) {
      continue;
    }
    return newest && isFreshLink(newest.link) ? { threadId: newest.link.threadId, updatedAt: newest.link.updatedAt } : null;
  }
  throw new Error(`The Codex thread link in ${dir} kept changing while it was read; try again.`);
}

export function getSessionLink(cwd, sessionId) {
  return readSessionLink(cwd, sessionId);
}

const defaultWriteChunk = (fd, buffer, offset) => fs.writeSync(fd, buffer, offset, buffer.length - offset);

function writeFileDurably(filePath, text, writeChunk = defaultWriteChunk) {
  const buffer = Buffer.from(text, "utf8");
  const fd = fs.openSync(filePath, "w", 0o600);
  try {
    for (let offset = 0; offset < buffer.length; ) {
      const written = writeChunk(fd, buffer, offset);
      if (!(written > 0)) {
        throw new Error(`Short write to ${filePath}.`);
      }
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function syncDir(dir) {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function setSessionLink(cwd, sessionId, threadId, hooks = {}) {
  if (!sessionId || !threadId) {
    return;
  }
  const dir = resolveLinkDir(cwd, sessionId);
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      hooks.afterMkdir?.(dir);
      // never older than an existing version, even if the clock went back
      const latest = listVersions(dir)[0];
      const latestMs = latest ? Number(LINK_VERSION_PATTERN.exec(latest)[1]) : 0;
      const atMs = Math.max(Date.now(), latestMs + 1);
      const rev = randomRev();
      const name = `${String(atMs).padStart(15, "0")}-${rev}.json`;
      const record = { key: sessionId, threadId, updatedAt: new Date(atMs).toISOString(), rev };
      const tempFile = path.join(dir, `.${name}.tmp`);
      writeFileDurably(tempFile, `${JSON.stringify(record)}\n`, hooks.writeChunk);
      fs.renameSync(tempFile, path.join(dir, name));
      // the version and, for a new key, the directory entries above it become durable
      syncDir(dir);
      syncDir(path.dirname(dir));
      syncDir(path.dirname(path.dirname(dir)));
      break;
    } catch (error) {
      // a pruner removed the empty key directory between mkdir and the write
      if (error?.code !== "ENOENT" || attempt >= 2) {
        throw error;
      }
    }
  }
  try {
    pruneLinkFiles(cwd, hooks.prune);
  } catch {
    // best effort: the link is published; a later write prunes again
  }
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
