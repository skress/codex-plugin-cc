/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;
// The shared broker answers with this code when its Codex app-server did not
// answer a forwarded request in time; the broker then restarts that app-server.
export const BROKER_UPSTREAM_TIMEOUT_RPC_CODE = -32002;
export const RPC_TIMEOUT_ERROR_CODE = "RPC_TIMEOUT";

export const RPC_TIMEOUT_ENV = "CODEX_COMPANION_RPC_TIMEOUT_MS";
export const TURN_IDLE_TIMEOUT_ENV = "CODEX_COMPANION_TURN_IDLE_TIMEOUT_MS";
export const CLOSE_TIMEOUT_ENV = "CODEX_COMPANION_CLOSE_TIMEOUT_MS";
// A request to the app-server (thread/start, thread/resume, turn/start, ...) only
// sets work up; the turn itself runs after turn/start returned. Two minutes is far
// above what a healthy app-server needs (a resume of a 1.5 MB thread answers in
// about 25 ms) and short enough that a wedged one does not block a caller for long.
export const DEFAULT_RPC_TIMEOUT_MS = 2 * 60 * 1000;
// Waiting for a turn to finish is bounded by inactivity, not by total duration:
// long review turns are legitimate, a turn with no event for 30 minutes is not.
export const DEFAULT_TURN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_CLOSE_TIMEOUT_MS = 10 * 1000;
// Through the broker the companion waits a little longer than the broker waits for
// its app-server, so the broker's answer (and its restart) arrives first.
const BROKER_CLIENT_GRACE_MS = 10 * 1000;

export function resolveTimeoutMs(envName, fallback, env = process.env) {
  const value = Number(env?.[envName]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

function formatSeconds(ms) {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function createTimeoutError(method, timeoutMs) {
  const error = /** @type {ProtocolError & { code?: string, method?: string, timeoutMs?: number }} */ (
    new Error(`Codex app-server did not answer ${method} within ${formatSeconds(timeoutMs)}.`)
  );
  error.code = RPC_TIMEOUT_ERROR_CODE;
  error.method = method;
  error.timeoutMs = timeoutMs;
  return error;
}

export function isRequestTimeoutError(error) {
  return error?.code === RPC_TIMEOUT_ERROR_CODE || error?.rpcCode === BROKER_UPSTREAM_TIMEOUT_RPC_CODE;
}

function waitWithLimit(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";
    const env = options.env ?? process.env;
    this.requestTimeoutMs = options.requestTimeoutMs ?? resolveTimeoutMs(RPC_TIMEOUT_ENV, DEFAULT_RPC_TIMEOUT_MS, env);
    this.closeTimeoutMs = options.closeTimeoutMs ?? resolveTimeoutMs(CLOSE_TIMEOUT_ENV, DEFAULT_CLOSE_TIMEOUT_MS, env);

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params, options = {}) {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;

    return new Promise((resolve, reject) => {
      let timer = null;
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject), method });
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        // On timeout the request is forgotten: a late reply finds no pending entry
        // and is dropped.
        timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(createTimeoutError(method, timeoutMs));
          }
        }, timeoutMs);
        timer.unref?.();
      }
      try {
        this.sendMessage({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AppServerNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    this.proc = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          // On Windows with shell: true, the direct child is cmd.exe.
          // Use terminateProcessTree to kill the entire tree including
          // the grandchild node process.
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer — swallow errors
              // to avoid crashing the host process during shutdown.
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50).unref?.();
    }

    // An app-server that ignores stdin end and SIGTERM is killed, so closing
    // never blocks the caller for longer than the close limit.
    if (await waitWithLimit(this.exitPromise, this.closeTimeoutMs)) {
      return;
    }
    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    if (!(await waitWithLimit(this.exitPromise, this.closeTimeoutMs))) {
      this.handleExit(new Error("codex app-server did not exit after SIGKILL."));
    }
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
    if (options.requestTimeoutMs === undefined) {
      this.requestTimeoutMs += Math.min(BROKER_CLIENT_GRACE_MS, this.requestTimeoutMs);
    }
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    if (!(await waitWithLimit(this.exitPromise, this.closeTimeoutMs))) {
      this.socket?.destroy();
      if (!(await waitWithLimit(this.exitPromise, this.closeTimeoutMs))) {
        this.handleExit(new Error("codex app-server broker connection did not close."));
      }
    }
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    await client.initialize();
    return client;
  }
}
