import process from "node:process";

// A Claude Code shell exports the plugin's own session variables (the
// SessionStart hook writes them to CLAUDE_ENV_FILE), and a developer shell may
// carry a broker endpoint. Tests must not inherit them: they would redirect state
// to the real plugin data directory, filter jobs by a real session id, or talk to
// a real app-server broker. Every test file imports it, directly or
// through helpers.mjs, so child processes built from process.env are clean too
// (ESM evaluates this module before any plugin module that helpers.mjs imports).
for (const name of [
  "CLAUDE_PLUGIN_DATA",
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CODEX_COMPANION_APP_SERVER_ENDPOINT",
  "CODEX_COMPANION_APP_SERVER_PID_FILE",
  "CODEX_COMPANION_APP_SERVER_LOG_FILE"
]) {
  delete process.env[name];
}
