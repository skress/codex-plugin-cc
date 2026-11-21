import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env,
      // Bounded: callers run this during teardown, some in an exit handler.
      timeout: options.timeout ?? 5000
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch {
    // No such group (the process leads none, for example a foreground run started
    // from a shell without job control) or no permission: signal the process.
    try {
      killImpl(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw innerError;
    }
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}

// Identity of a running process: a start token (the same pid with a different
// token is a different, reused process) and whether it is a zombie (exited, not
// reaped yet; it still answers kill(pid, 0)). Linux: /proc/<pid>/stat. Elsewhere
// (macOS, BSD): `ps -o stat= -o lstart=`. null when unknown (Windows, ps missing
// or not permitted, process gone).
export function readProcessIdentity(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return null;
  }
  if (platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name (field 2) may contain spaces and parentheses; fields after
      // the last ")" are fixed: state is field 3, starttime field 22.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] ? { token: `linux:${fields[19]}`, zombie: fields[0] === "Z" || fields[0] === "X" } : null;
    } catch {
      return null;
    }
  }
  const result = spawnSync("ps", ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    timeout: 5000,
    windowsHide: true
  });
  const line = String(result.stdout ?? "").trim().replace(/\s+/g, " ");
  const match = /^(\S+) (.+)$/.exec(line);
  if (result.status !== 0 || !match) {
    return null;
  }
  return { token: `ps:${match[2]}`, zombie: match[1].startsWith("Z") };
}

export function readProcessStartToken(pid, options = {}) {
  return readProcessIdentity(pid, options)?.token ?? null;
}

// "alive", "dead", or "unknown" (no permission to signal it, or no pid).
export function probeProcess(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return "unknown";
  }
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") {
      return "dead";
    }
    return error?.code === "EPERM" ? "alive" : "unknown";
  }
}

// A recorded process is gone when its pid no longer exists, is a zombie, or now
// belongs to a process with a different start token (pid reuse). Unknown stays
// "not gone", so a job is never failed on a guess.
export function isRecordedProcessGone(pid, startToken = null, options = {}) {
  const state = probeProcess(pid, options);
  if (state === "dead") {
    return true;
  }
  if (state !== "alive") {
    return false;
  }
  const identity = (options.readIdentity ?? readProcessIdentity)(pid);
  if (identity?.zombie) {
    return true;
  }
  return Boolean(startToken && identity?.token && identity.token !== startToken);
}

// Whether a recorded process may be signalled: it is alive and, when a start
// token was recorded, the current token was read and matches. A pid whose
// identity cannot be checked now is left alone. Without a recorded token (Windows,
// records from older versions) the pid alone decides, as before.
export function shouldSignalRecordedProcess(pid, startToken = null, options = {}) {
  if (probeProcess(pid, options) !== "alive") {
    return false;
  }
  if (!startToken) {
    return true;
  }
  const current = (options.readStartToken ?? readProcessStartToken)(pid);
  return current !== null && current === startToken;
}
