import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { run } from "./helpers.mjs";

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const AFFECTED = [
  ["runtime.test.mjs", "status shows phases, hints, and the latest finished job"],
  ["runtime.test.mjs", "status preserves adversarial review kind labels"],
  ["runtime.test.mjs", "result returns the stored output for the latest finished job by default"],
  ["state.test.mjs", "resolveStateDir uses a temp-backed per-workspace directory"]
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Like a real one, the plugin data directory must lie outside the temp directory,
// or the state-directory test cannot tell it apart from a temp-backed one. (If the
// home directory itself lies in the temp directory, that one case goes unchecked;
// the three job tests still catch an inherited session id.)
function makePluginDataDir() {
  const inTmp = (dir) => !path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(dir)).startsWith("..");
  const base = inTmp(path.join(TESTS, "..")) ? os.homedir() : path.join(TESTS, "..");
  return fs.mkdtempSync(path.join(base, ".ambient-plugin-data-"));
}

// A Claude Code shell exports the plugin's session variables (SessionStart hook,
// CLAUDE_ENV_FILE). The suite must not depend on them: these tests used to fail
// when run from such a shell.
test("tests that use state and jobs pass when the shell carries the plugin's session variables", () => {
  const pluginData = makePluginDataDir();
  try {
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginData,
      CODEX_COMPANION_SESSION_ID: "ambient-session",
      CODEX_COMPANION_TRANSCRIPT_PATH: "/nonexistent/transcript.jsonl"
    };
    delete env.NODE_TEST_CONTEXT; // run the nested test runner as a top-level run
    const pattern = AFFECTED.map(([, name]) => escapeRegExp(name)).join("|");
    const files = [...new Set(AFFECTED.map(([file]) => path.join(TESTS, file)))];
    const result = run(
      process.execPath,
      ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-name-pattern", pattern, ...files],
      { env }
    );

    const output = `${result.stdout}\n${result.stderr}`;
    for (const [, name] of AFFECTED) {
      assert.match(output, new RegExp(`✔ ${escapeRegExp(name)}`), `not run or not passed: ${name}`);
    }
    assert.equal(result.status, 0, output.split("\n").filter((line) => line.includes("✖")).join("\n"));
  } finally {
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});
