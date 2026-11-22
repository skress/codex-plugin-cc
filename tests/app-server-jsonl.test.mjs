import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

// JSON allows U+2028 and U+2029 unescaped inside strings, and the app-server
// sends them that way. Written as escapes here, never as raw characters.
const SEPARATOR_TEXT = "line one\u2028line two\u2029line three";

function setupRepo(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, env: buildEnv(binDir) };
}

test("a task whose Codex output holds U+2028 and U+2029 finishes with that output", () => {
  const ctx = setupRepo("line-separators");
  const result = spawnSync("node", [SCRIPT, "task", "--json", "print the file"], {
    cwd: ctx.repo,
    env: ctx.env,
    encoding: "utf8",
    timeout: 60000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.rawOutput, `Handled the requested task.\n${SEPARATOR_TEXT}`);
});

test("a direct client receives a reply split inside a multibyte character and ending in CRLF as one message", async () => {
  // The fake never answers thread/resume, so the reply below is the only one.
  const ctx = setupRepo("resume-hangs");
  const client = await CodexAppServerClient.connect(ctx.repo, {
    disableBroker: true,
    env: ctx.env,
    requestTimeoutMs: 5000,
    closeTimeoutMs: 300
  });
  try {
    const id = client.nextId;
    const pending = client.request("thread/resume", { threadId: "thr_1", cwd: ctx.repo });
    // Two reads into the client's stdout stream, cut inside U+2028's UTF-8 bytes
    // (pushed directly, so the cut does not depend on pipe scheduling).
    const bytes = Buffer.from(`${JSON.stringify({ id, result: { text: SEPARATOR_TEXT } })}\r\n`, "utf8");
    const cut = bytes.indexOf(Buffer.from("\u2028", "utf8")) + 1;
    client.proc.stdout.push(bytes.subarray(0, cut));
    await new Promise((resolve) => setImmediate(resolve));
    client.proc.stdout.push(bytes.subarray(cut));
    const response = await pending;
    assert.equal(response.text, SEPARATOR_TEXT);
    assert.equal(client.exitResolved, undefined);
    assert.equal(client.exitError, null);
  } finally {
    await client.close();
  }
});

test("a client through the broker receives a reply with U+2028 and U+2029 as one message", async () => {
  const ctx = setupRepo("line-separators-split-write");
  // The broker reads its app-server with the same client class.
  const client = await CodexAppServerClient.connect(ctx.repo, { env: ctx.env, requestTimeoutMs: 5000, closeTimeoutMs: 300 });
  try {
    assert.equal(client.transport, "broker");
    const response = await client.request("thread/list", {});
    assert.equal(response.text, SEPARATOR_TEXT);
    assert.equal(client.exitResolved, undefined);
  } finally {
    await client.close();
  }
});

test("a large reply in many reads is framed in linear time", async () => {
  // The fake never answers thread/resume, so the reply below is the only one.
  const ctx = setupRepo("resume-hangs");
  const client = await CodexAppServerClient.connect(ctx.repo, {
    disableBroker: true,
    env: ctx.env,
    requestTimeoutMs: 30000,
    closeTimeoutMs: 300
  });
  try {
    const id = client.nextId;
    const pending = client.request("thread/resume", { threadId: "thr_1", cwd: ctx.repo });
    const size = 64 * 1024 * 1024;
    const reply = `{"id":${id},"result":{"blob":"${"x".repeat(size)}"}}\n`;
    const readSize = 64 * 1024;
    const started = performance.now();
    for (let offset = 0; offset < reply.length; offset += readSize) {
      client.handleChunk(reply.slice(offset, offset + readSize));
    }
    const elapsedMs = performance.now() - started;
    assert.equal((await pending).blob.length, size);
    // Searching the whole buffered line for "\n" on every read takes seconds here;
    // searching only the new read takes tens of milliseconds.
    assert.ok(elapsedMs < 1000, `framing took ${Math.round(elapsedMs)} ms`);
  } finally {
    await client.close();
  }
});

test("a direct client still receives a last reply without a line ending before its output ends", async () => {
  const ctx = setupRepo("reply-without-newline-then-close");
  const client = await CodexAppServerClient.connect(ctx.repo, {
    disableBroker: true,
    env: ctx.env,
    requestTimeoutMs: 5000,
    closeTimeoutMs: 300
  });
  try {
    const response = await client.request("thread/list", {});
    assert.deepEqual(response, { data: [], nextCursor: null });
    // The end of output is still noticed: afterwards new requests are refused.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(client.request("thread/list", {}), /closed its output stream/);
  } finally {
    await client.close();
  }
});
