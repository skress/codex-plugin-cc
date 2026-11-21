import fs from "node:fs";
import os from "node:os";
import process from "node:process";

import { isRecordedProcessGone, readProcessStartToken } from "./process.mjs";
import { listJobs, loadState, readJobFile, resolveJobFile, resolveJobLogFile, saveState, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function isActiveStatus(status) {
  return status === "queued" || status === "running";
}

// Marks a job failed only while it is still active (and, with expectedPid, still
// owned by that process), in both the state index and the job file. A job that
// finished, was cancelled or was removed meanwhile is left alone. Returns whether
// the index entry changed.
//
// The job store has no lock (see docs/handover.md), so this narrows rather than
// closes the races: the state is re-read right before each write, nothing is
// written when the job is no longer active, and the job file is written before
// the index, so a crash in between leaves the index active and a later
// reconciliation finishes the job file and the index together.
export function failActiveJob(workspaceRoot, jobId, errorMessage, options = {}) {
  const isOurs = (job) =>
    job && isActiveStatus(job.status) && (options.expectedPid === undefined || job.pid === options.expectedPid);
  const indexed = listJobs(workspaceRoot).find((job) => job.id === jobId);
  if (!isOurs(indexed)) {
    return false;
  }
  const completedAt = nowIso();
  let logFile = indexed.logFile ?? null;
  // What the index gets: failed, unless the job file already holds the run's own
  // outcome (the process died between writing the job file and the index).
  let indexPatch = { status: "failed", phase: "failed", pid: null, errorMessage, completedAt };
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  let stored = null;
  try {
    stored = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
  } catch {
    stored = null;
  }
  if (stored && stored.status && !isActiveStatus(stored.status)) {
    indexPatch = {
      status: stored.status,
      phase: stored.phase ?? (stored.status === "completed" ? "done" : stored.status),
      pid: null,
      threadId: stored.threadId ?? indexed.threadId ?? null,
      turnId: stored.turnId ?? indexed.turnId ?? null,
      errorMessage: stored.errorMessage ?? null,
      completedAt: stored.completedAt ?? completedAt
    };
  } else {
    // An active, missing or unreadable job file is replaced by a failed record, so
    // the index and the job file agree.
    writeJobFile(workspaceRoot, jobId, { ...(stored ?? indexed), status: "failed", phase: "failed", pid: null, errorMessage, completedAt });
    logFile = logFile ?? stored?.logFile ?? null;
  }
  const state = loadState(workspaceRoot);
  const current = state.jobs.find((job) => job.id === jobId);
  if (!isOurs(current)) {
    return false;
  }
  Object.assign(current, indexPatch, { updatedAt: completedAt });
  saveState(workspaceRoot, state);
  try {
    appendLogLine(logFile, errorMessage);
  } catch {
    // The log is informational.
  }
  return true;
}

// A queued or running job whose recorded process is gone (exited, killed, or its
// pid now belongs to another process) can never finish: mark it failed so it no
// longer blocks its link key or shows as running. Jobs without a recorded pid are
// left alone.
export function reconcileDeadJobs(workspaceRoot, options = {}) {
  const isGone = options.isGone ?? ((job) => isRecordedProcessGone(job.pid, job.pidStartToken ?? null));
  const reconciled = [];
  for (const job of listJobs(workspaceRoot)) {
    if (!isActiveStatus(job.status) || !Number.isInteger(job.pid) || job.pid <= 0 || !isGone(job)) {
      continue;
    }
    const message = `The Codex companion process (pid ${job.pid}) exited before the job finished.`;
    if (failActiveJob(workspaceRoot, job.id, message, { expectedPid: job.pid })) {
      reconciled.push(job.id);
    }
  }
  return reconciled;
}

// The final write of a run happens only while the job still belongs to this run:
// active and owned by this process in the index, or, when a concurrent write lost
// the index entry, in its job file. A job that was cancelled, or removed by
// SessionEnd (which also deletes its job file), stays as it is.
function ownedByThisRun(job) {
  return Boolean(job) && isActiveStatus(job.status) && job.pid === process.pid;
}

function publishRunOutcome(workspaceRoot, jobId, fileRecord, indexPatch) {
  const indexed = listJobs(workspaceRoot).find((job) => job.id === jobId);
  if (indexed ? !ownedByThisRun(indexed) : !ownedByThisRun(readStoredJobOrNull(workspaceRoot, jobId))) {
    return false;
  }
  writeJobFile(workspaceRoot, jobId, fileRecord);
  const state = loadState(workspaceRoot);
  const current = state.jobs.find((job) => job.id === jobId);
  if (current && !ownedByThisRun(current)) {
    return false;
  }
  const timestamp = nowIso();
  if (current) {
    Object.assign(current, indexPatch, { updatedAt: timestamp });
  } else {
    state.jobs.unshift({ ...fileRecord, ...indexPatch, createdAt: fileRecord.createdAt ?? timestamp, updatedAt: timestamp });
    delete state.jobs[0].result;
    delete state.jobs[0].rendered;
    delete state.jobs[0].request;
  }
  saveState(workspaceRoot, state);
  return true;
}

const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

// While a job runs in this process, a termination signal marks it failed before
// the process exits (SIGKILL cannot be caught; reconcileDeadJobs covers that).
function installSignalHandlers(workspaceRoot, jobId) {
  if (process.platform === "win32") {
    return () => {};
  }
  const handlers = TERMINATION_SIGNALS.map((signal) => {
    const handler = () => {
      try {
        failActiveJob(workspaceRoot, jobId, `Interrupted by ${signal}.`, { expectedPid: process.pid });
      } finally {
        process.exit(128 + (os.constants.signals[signal] ?? 0));
      }
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    pidStartToken: readProcessStartToken(process.pid),
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);
  const removeSignalHandlers = installSignalHandlers(job.workspaceRoot, job.id);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    publishRunOutcome(
      job.workspaceRoot,
      job.id,
      {
        ...runningRecord,
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        pid: null,
        phase: completionStatus === "completed" ? "done" : "failed",
        completedAt,
        result: execution.payload,
        rendered: execution.rendered
      },
      {
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        summary: execution.summary,
        phase: completionStatus === "completed" ? "done" : "failed",
        pid: null,
        completedAt
      }
    );
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    publishRunOutcome(
      job.workspaceRoot,
      job.id,
      {
        ...existing,
        status: "failed",
        phase: "failed",
        errorMessage,
        pid: null,
        completedAt,
        logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
      },
      {
        status: "failed",
        phase: "failed",
        pid: null,
        errorMessage,
        completedAt
      }
    );
    throw error;
  } finally {
    removeSignalHandlers();
  }
}
