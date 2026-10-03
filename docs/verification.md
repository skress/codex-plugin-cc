# Fork verification notes

Findings for §0 of the handover, recorded on the integration branch (`main`).
Environment unless noted: macOS (Darwin 27.0), Claude Code 2.1.288, codex-cli 0.160.0, Node 24.21.0,
plugin at upstream `db52e28` (upstream last push 2026-07-07) + fork manifest commit, tag `v1.0.6-fork.0`.

## 0.1 Plugin install from a GitHub fork — 2026-10-03

Docs: <https://code.claude.com/docs/en/plugins/cli-reference.md>, <https://code.claude.com/docs/en/plugins/marketplace-reference.md>,
<https://code.claude.com/docs/en/plugins/manifest-reference.md>, <https://code.claude.com/docs/en/plugins/loading.md>

- **Ref selection works.** `owner/repo#ref` (also `owner/repo@ref`), ref = branch or tag. Verified:
  `claude plugin marketplace add 'skress/codex-plugin-cc#v1.0.6-fork.0'` → `known_marketplaces.json` stores
  `{"source":"github","repo":"skress/codex-plugin-cc","ref":"v1.0.6-fork.0"}`. `--help` does not mention the ref syntax; the docs do.
- **Marketplace name** = `name` in `.claude-plugin/marketplace.json` (letters, digits, `.`, `_`, `-`; reserved names exist).
  The fork uses `skress-codex`.
- **Two marketplaces with a plugin named `codex`:** both installable, disambiguated by `codex@<marketplace>`; only one
  plugin of a given name loads per session. Never install `codex@openai-codex` next to the fork.
- **CLI equivalents** (for Ansible): `claude plugin marketplace add <source> [--scope user|project|local] [--json]`,
  `claude plugin install codex@skress-codex --scope user [--json]`, `claude plugin marketplace update [name]`,
  `claude plugin update codex@skress-codex [--scope …]` (restart required). `--json` prints one machine-readable result line.
- **Version:** "A version string, not checked against semver" — `1.0.6-fork.0` accepted. Claude Code does not compare
  versions; it follows the marketplace ref. The cache is keyed by the version string
  (`~/.claude/plugins/cache/skress-codex/codex/1.0.6-fork.0`, `installed_plugins.json` also records `gitCommitSha`).
  ⇒ always bump the version when `main` changes, or the cache entry is reused.
- **Tag pin + update:** with the marketplace pinned to a tag, moving to a new tag means changing the marketplace source
  ref (re-add). TODO: verify the exact re-pin flow when `v1.0.6-fork.1` exists.
- **Node deps:** installed automatically on cache only when the plugin root has `package.json` **and** a lockfile.
  `plugins/codex/` has neither; the companion uses only Node built-ins. Nothing to install.

## 0.2 Plugin vs Codex CLI 0.160.0 — 2026-10-03

All pass, no compatibility fix needed:
- `codex-companion.mjs setup --json` → `ready: true`, auth `chatgpt`, verified, "advanced runtime available".
- `review --wait --json` on a one-line working-tree diff → status 0, native review text.
- `task --json "What does this repo do?"` → status 0, correct answer, ~26 s.

## 0.3 Session id plumbing — 2026-10-03

- `SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID"` (`lib/tracked-jobs.mjs`, duplicated in `session-lifecycle-hook.mjs`).
  The `SessionStart` hook appends `export CODEX_COMPANION_SESSION_ID=…`, `CODEX_COMPANION_TRANSCRIPT_PATH`, and
  `CLAUDE_PLUGIN_DATA` to `CLAUDE_ENV_FILE`. Verified in a headless session: Bash sees the session id and
  `CLAUDE_PLUGIN_DATA=~/.claude/plugins/data/codex-skress-codex`.
- `claude --resume <id>` → same session id in Bash (verified). `/clear` → new id (docs; not yet verified interactively).
- **⚠ Contradicts the handover (§1, §9.3):** the `SessionEnd` hook (`cleanupSessionJobs`) removes **all** jobs of the
  ending session from `state.json`, plus their job files and logs — deliberately, covered by an upstream test
  (`tests/runtime.test.mjs` ~L1790). Verified: session 1 ran a task (`task-resume-candidate` → `available: true`);
  after exit the state had no jobs; `claude --resume` with the same id → `task-resume-candidate` → `available: false`.
  So `--resume-last` does **not** survive `claude --resume` today, and an `ask` built only on job records would
  silently start a fresh thread after every resume. The Codex threads themselves persist (`ephemeral: false`).

## 0.4 Job store — 2026-10-03

- Location: `$CLAUDE_PLUGIN_DATA/state/<repo-basename>-<sha256(realpath)[:16]>/` (fallback `$TMPDIR/codex-companion/…`
  when `CLAUDE_PLUGIN_DATA` is unset, e.g. running the script outside Claude Code). `state.json` = `{version, config, jobs[]}`;
  per-job `jobs/<id>.json` and `jobs/<id>.log`. Index capped at 50 jobs (`MAX_JOBS`), pruned by `updatedAt`.
- Index record fields: `id, kind, kindLabel, title, workspaceRoot, jobClass, summary, write, createdAt, sessionId,
  status, startedAt, phase, pid, logFile, threadId, turnId, completedAt, updatedAt, errorMessage`.
  Job file adds `result` (the `--json` payload) and `rendered`.
- Thread naming: `buildPersistentTaskThreadName(prompt)` → `"Codex Companion Task: <first 56 chars>"`, set via
  `thread/name/set` on fresh threads only. `findLatestTaskThread` (`thread/list`, `searchTerm` = prefix, limit 20) is
  only used when **no** session id is set.
- `resolveLatestTrackedTaskThread` throws if **any** task of the session is queued/running — a background
  `/codex:rescue` would block `ask` unless the `--thread` filter also applies to that check.

## 0.5 Read-only sandbox — 2026-10-03

`task` without `--write`, in a scratch clone with a dirty working tree:
`git diff --stat` ✓, `git log -1` ✓, `rg -l handleTask` ✓, `head` on repo files ✓;
`touch new-file` → "Operation not permitted", `echo >> README.md` → "operation not permitted"; nothing written.
Reads **outside** the repo also work (`~/.codex/config.toml`) — read-only is not repo-confined.
Network from Codex-run commands is blocked (`curl` → "Could not resolve host"); Codex's own API traffic is unaffected.

## 0.6 Claude Code Bash sandbox — 2026-10-03

Not enabled on this machine (`~/.claude/settings.json` has no `sandbox` key), so not verified empirically.
Per <https://code.claude.com/docs/en/settings-reference.md>: `sandbox.network.allowedDomains`,
`sandbox.filesystem.allowWrite`; hooks run sandboxed too when `sandbox.enabled: true`.
Expected needs (to verify on a VM with the sandbox on): network to `chatgpt.com`, `auth.openai.com`, `api.openai.com`;
write to `~/.codex` and `~/.claude/plugins/data/codex-skress-codex`; the app-server broker's Unix socket under `$TMPDIR`.

## 0.7 `task --json` output and exit codes — 2026-10-03

- Payload: `{status, threadId, rawOutput, touchedFiles, reasoningSummary}`. Exit code = `status` (0 ok, 1 failed turn).
- **⚠ Failed turn:** e.g. unsupported model → exit 1, `status: 1`, `rawOutput: ""`, and **no error text in the payload**.
  The message (`{"type":"error","status":400,…"not supported when using Codex with a ChatGPT account."}`) only lands in
  the job's `summary`/`rendered`. `ask.md` cannot report the reason from `--json` alone.
- **Thrown errors** (missing prompt file, "Task … is still running", Codex not installed): exit 1, **no JSON on stdout**,
  message on stderr.
- Auth error: not reproducible here (an empty `CODEX_HOME` still authenticated — the app-server reached the existing
  login). Rate limit: not reproducible. Both are expected to surface as a failed turn (status 1) with the server message.

## Side findings — 2026-10-03

- **Test suite leaks broker processes.** Each `npm test` run leaves ~30–40 `app-server-broker.mjs` processes (plus their
  fake `codex app-server` children) running; tests that start a shared broker never shut it down. Clean up with
  `ps -eo pid,command | grep "[a]pp-server-broker.mjs serve" | grep codex-plugin-test- | awk '{print $1}' | xargs kill`.
- **Running the companion outside Claude Code leaves a broker registered for that cwd** (no `SessionEnd` tears it down).
  In the repo root this flips the `setup` tests to `sessionRuntime: shared` and fails them. Don't smoke-test from the
  checkout root; use a scratch clone.
- Codex 0.160.0 runs its own managed app-server daemon (`~/.codex/packages/app-server-daemon`), which likely explains
  why an empty `CODEX_HOME` still authenticated in §0.7.
