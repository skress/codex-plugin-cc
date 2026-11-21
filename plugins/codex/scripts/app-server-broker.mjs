#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import {
  BROKER_BUSY_RPC_CODE,
  BROKER_UPSTREAM_TIMEOUT_RPC_CODE,
  CodexAppServerClient,
  DEFAULT_RPC_TIMEOUT_MS,
  RPC_TIMEOUT_ENV,
  isRequestTimeoutError,
  resolveTimeoutMs
} from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
// Killing a wedged app-server should not take long; the client waits for the
// broker's answer, which comes after the restart.
const UPSTREAM_CLOSE_TIMEOUT_MS = 2000;
const SHUTDOWN_STEP_TIMEOUT_MS = 2000;
// The client waits 30 s longer than the broker's request limit; answer well before.
const RESTART_REPLY_LIMIT_MS = 15000;

function withLimit(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  // Every app-server this broker started and has not seen exit, including one
  // still initializing; none may outlive the broker.
  const upstreamProcesses = new Set();
  process.on("exit", () => {
    for (const child of upstreamProcesses) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
  let appClient = await connectUpstream();
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  let activeStreamTurn = null;
  // Set when the app-server must be replaced (a request timed out, or it exited).
  // While set, new requests are answered busy; the restart runs once no client
  // owns the broker, so it never kills another client's running turn.
  let restartReason = null;
  let restarting = null;
  // A turn whose client went away keeps the broker owned (by the closed socket,
  // which receives nothing) until the turn ends; it is interrupted, and if it does
  // not end within the request limit the app-server is replaced.
  let orphanTimer = null;
  const orphanLimitMs = resolveTimeoutMs(RPC_TIMEOUT_ENV, DEFAULT_RPC_TIMEOUT_MS);
  // Turns that completed while their start request was still being answered: the
  // completion can arrive in the same read as the reply, before the request
  // handler runs again, and must not leave a stream owned by a finished turn.
  const completedBeforeStart = new Set();
  let shuttingDown = false;
  const sockets = new Set();

  async function connectUpstream() {
    const client = await CodexAppServerClient.connect(cwd, {
      disableBroker: true,
      closeTimeoutMs: UPSTREAM_CLOSE_TIMEOUT_MS,
      onSpawn(child) {
        upstreamProcesses.add(child);
        child.once("exit", () => upstreamProcesses.delete(child));
      }
    });
    client.setNotificationHandler((message) => routeNotification(message));
    client.exitPromise.then(() => {
      if (appClient === client && !client.closed) {
        // The app-server died on its own: clients waiting on it get disconnected,
        // and the next request starts a new one.
        restartReason = restartReason ?? "exited";
        for (const socket of [activeRequestSocket, activeStreamSocket]) {
          socket?.destroy();
        }
        releaseStream();
        activeRequestSocket = null;
      }
    });
    return client;
  }

  function isOwned() {
    return Boolean(activeRequestSocket || activeStreamSocket);
  }

  async function restartUpstreamIfIdle() {
    if (!restartReason || isOwned() || shuttingDown) {
      return;
    }
    if (!restarting) {
      restarting = (async () => {
        const previous = appClient;
        await previous.close().catch(() => {});
        try {
          const replacement = await connectUpstream();
          if (shuttingDown) {
            // Shutdown began meanwhile: never leave a replacement running.
            await replacement.close().catch(() => {});
            return;
          }
          appClient = replacement;
          restartReason = null;
        } catch (error) {
          process.stderr.write(`Failed to restart the Codex app-server: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      })().finally(() => {
        restarting = null;
      });
    }
    await restarting;
  }

  function releaseStream() {
    clearTimeout(orphanTimer);
    orphanTimer = null;
    activeStreamSocket = null;
    activeStreamThreadIds = null;
    activeStreamTurn = null;
  }

  function replaceUpstream(reason) {
    restartReason = restartReason ?? reason;
    activeRequestSocket = null;
    releaseStream();
    void restartUpstreamIfIdle();
  }

  // The client of a running turn went away: stop the turn instead of leaving it
  // running for nobody and routing its events to the next client.
  function abandonOrphanTurn() {
    if (!activeStreamTurn || orphanTimer) {
      return;
    }
    const orphan = activeStreamTurn;
    const { threadId, turnId } = orphan;
    const upstream = appClient;
    // Acts only while this very turn still owns the broker on this app-server.
    const stillOrphaned = () => appClient === upstream && activeStreamTurn === orphan && activeStreamSocket?.destroyed;
    orphanTimer = setTimeout(() => {
      if (stillOrphaned()) {
        replaceUpstream("orphaned turn did not end");
      }
    }, orphanLimitMs);
    orphanTimer.unref?.();
    upstream.request("turn/interrupt", { threadId, turnId }).catch(() => {
      if (stillOrphaned()) {
        replaceUpstream("orphaned turn could not be interrupted");
      }
    });
  }

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      // Its request is still running upstream; ownership is released when the
      // request settles (see the request handler), never before.
      return;
    }
    if (activeStreamSocket === socket) {
      if (activeStreamTurn && !restartReason) {
        abandonOrphanTurn();
        return;
      }
      releaseStream();
    }
    void restartUpstreamIfIdle();
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeRequestSocket === target && activeStreamSocket !== target) {
      const turnId = message.params?.turn?.id ?? null;
      if (turnId) {
        completedBeforeStart.add(turnId);
      }
    }
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      const turnId = message.params?.turn?.id ?? null;
      // A completion of another turn on the same thread (for example a late one)
      // does not end the current stream.
      const otherTurn = Boolean(turnId && activeStreamTurn?.turnId && turnId !== activeStreamTurn.turnId && activeStreamThreadIds?.has(threadId));
      if (!otherTurn && (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId))) {
        // A request of the same client that is still running keeps its own
        // ownership; the request handler releases it when it settles.
        releaseStream();
        void restartUpstreamIfIdle();
      }
    }
  }

  async function shutdown(server) {
    shuttingDown = true;
    if (restarting) {
      await withLimit(restarting, SHUTDOWN_STEP_TIMEOUT_MS * 3);
    }
    for (const socket of sockets) {
      socket.end();
      // A peer that keeps its half open must not stall the shutdown.
      setTimeout(() => socket.destroy(), SHUTDOWN_STEP_TIMEOUT_MS).unref?.();
    }
    await withLimit(appClient.close().catch(() => {}), SHUTDOWN_STEP_TIMEOUT_MS * 3);
    await withLimit(new Promise((resolve) => server.close(resolve)), SHUTDOWN_STEP_TIMEOUT_MS);
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (!isOwned() && restartReason) {
          await restartUpstreamIfIdle();
        }
        if (socket.destroyed || shuttingDown) {
          // The client left (or the broker is stopping) while this request waited
          // for a restart: never start work nobody will read.
          return;
        }

        if (
          (((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
            !allowInterruptDuringActiveStream) ||
          restarting ||
          (restartReason && !(activeStreamSocket === socket || activeRequestSocket === socket))
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            if (isRequestTimeoutError(error)) {
              // Replace the app-server once the running turn released the broker.
              restartReason = restartReason ?? "timeout";
            }
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;
        const upstream = appClient;

        try {
          const result = await upstream.request(message.method, message.params ?? {});
          if (upstream !== appClient) {
            // Answered by an app-server that was replaced meanwhile.
            continue;
          }
          send(socket, { id: message.id, result });
          const startedTurnId = result?.turn?.id ?? null;
          const finishedAlready =
            (startedTurnId && completedBeforeStart.has(startedTurnId)) ||
            (result?.turn?.status && result.turn.status !== "inProgress");
          completedBeforeStart.clear();
          if (isStreaming && !finishedAlready) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
            // A detached review runs its turn on the review thread.
            const threadId = result?.reviewThreadId ?? message.params?.threadId ?? null;
            activeStreamTurn = startedTurnId && threadId ? { threadId, turnId: startedTurnId } : null;
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (socket.destroyed) {
            // The client left while the request ran: nobody reads the reply. A
            // turn it started is interrupted; otherwise ownership is released.
            if (activeStreamSocket === socket && activeStreamTurn) {
              abandonOrphanTurn();
            } else {
              clearSocketOwnership(socket);
            }
            return;
          }
        } catch (error) {
          if (isRequestTimeoutError(error) && upstream === appClient) {
            // The app-server did not answer in time: it may be wedged (for example
            // in a thread/resume that never returns, holding the thread). Replace
            // it, then tell the client, so its retry reaches the new app-server.
            restartReason = restartReason ?? "timeout";
            if (activeRequestSocket === socket) {
              activeRequestSocket = null;
            }
            if (activeStreamSocket === socket) {
              releaseStream();
            }
            // Bounded, so the client still gets this answer within its own limit.
            await withLimit(restartUpstreamIfIdle(), RESTART_REPLY_LIMIT_MS);
            const upstreamRestarted = !restartReason && appClient !== upstream;
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(
                BROKER_UPSTREAM_TIMEOUT_RPC_CODE,
                `${error.message}${upstreamRestarted ? " The shared broker restarted it." : " The shared broker will restart it once it is idle."}`,
                { upstreamRestarted }
              )
            });
            continue;
          }
          completedBeforeStart.clear();
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          // A failed request (for example a refused turn/interrupt) does not end
          // the client's running turn: the stream stays owned until turn/completed
          // or the client leaves (then the orphan handling takes over).
          if (socket.destroyed) {
            clearSocketOwnership(socket);
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
