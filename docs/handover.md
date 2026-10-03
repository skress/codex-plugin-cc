# Handover: `/codex:ask` — a read-only GPT consult for Claude Code, built on a fork of `openai/codex-plugin-cc`

This is the brief for implementing it in Claude Code. Read it fully before touching code. Section 0 is mandatory and comes before any implementation.

## 0. Verify before implementing (mandatory)

Record findings with dates and links in `docs/verification.md` on the fork's integration branch. Don't rely on memory or on this document for names and paths — upstream's last push was July 2026 and Codex CLI moves monthly.

1. **Plugin install from a GitHub fork.** Confirm against the current Claude Code plugin docs: `/plugin marketplace add <owner>/<repo>` for a GitHub repo; whether a non-default branch or a tag can be selected (ref syntax, or only the default branch); how a marketplace is named (`name` in `.claude-plugin/marketplace.json`); what happens when two marketplaces each contain a plugin named `codex`; the non-interactive CLI equivalents (`claude plugin marketplace add …`, `claude plugin install … --scope user`, `claude plugin update …`) for Ansible; whether the `version` field must be semver and whether Claude Code compares versions or just follows the marketplace ref on update; whether plugin Node dependencies are installed automatically on cache (the hooks docs say eligible Node packages are) and whether the companion script has any.
2. **Plugin vs current Codex CLI.** With the fork installed (§4) at the upstream commit, run `/codex:setup`, `/codex:review --wait` on a small diff, and `node "<plugin root>/scripts/codex-companion.mjs" task "What does this repo do?"`. If anything fails against `codex --version`, fix it first on its own branch (likely app-server method or schema drift in `lib/codex.mjs`); that is its own upstream PR.
3. **Session id plumbing.** In `lib/tracked-jobs.mjs` find `SESSION_ID_ENV`, and in `hooks/` how the `SessionStart` hook sets it (expected: via `CLAUDE_ENV_FILE`, so it reaches Bash subprocesses). Confirm it is set after `claude --resume` (same id) and after `/clear` (new id). Confirm `task-resume-candidate --json` reports the right thread after a resume.
4. **Job store.** In `lib/state.mjs`: where jobs live on disk, the job record fields (`id`, `jobClass`, `threadId`, `sessionId`, `title`, `summary`, `status`, …), and how persistent threads are named (`buildPersistentTaskThreadName`, `findLatestTaskThread` in `lib/codex.mjs`). The new flag hangs off these.
5. **Read-only sandbox.** With a `task` run (no `--write`), confirm Codex can `git diff`, `git log`, `rg`, read any file under the repo, and that a write attempt fails. Confirm Codex's own API traffic is unaffected by `read-only` (the sandbox governs commands Codex runs).
6. **Claude Code sandbox.** If my Claude Code settings enable the Bash sandbox, the companion runs inside it. Find out what the plugin needs allowed (network to OpenAI's auth/API hosts, write access to `~/.codex` and the job store) and document the `settings.json` entries.
7. **`task --json` output and exit codes**: payload fields (`status`, `threadId`, `rawOutput`, `touchedFiles`, `reasoningSummary`) and behavior on failure, rate limit, and auth error, so `ask.md` can tell Claude what to do in each case.

If a finding contradicts §5–§8, update this document first, then implement. (Done 2026-10-03: §1, §2, §3, §4, §6–§9 revised after §0.)

## 1. Problem

I run Claude Code as my primary coding agent in isolated VMs (macOS and Linux guests, plus Docker images). In two situations I want GPT in the loop:

1. **Discussion.** During a multi-day PRD/architecture session in Claude Code, I want to ask GPT for input on the current question and have the answer land in Claude's turn so Claude engages with it. Today I ask Claude to write a prompt and copy it into Codex by hand.
2. **Review.** After Claude implements a BMAD story, GPT does a full adversarial review; the review ends up in the story file; Claude works through it and checks items off.

OpenAI's official plugin (`openai/codex-plugin-cc`, Apache-2.0) covers most of this. Its runtime `plugins/codex/scripts/codex-companion.mjs` wraps the Codex app server with the local Codex CLI login. Its `task` subcommand runs a Codex thread in the repo, **read-only unless `--write` is passed**, takes the prompt positionally, from stdin or `--prompt-file`, persists the thread, records the Claude session id on every job, and `--resume-last` resumes the latest task thread **of the current Claude session**.

*Updated 2026-10-03 after §0 (see `docs/verification.md`):* that continuity breaks on `claude --resume`. The plugin's `SessionEnd` hook deletes all job records of the ending session, so after a resume `--resume-last` finds nothing. Missing therefore: (1) a durable link between a Claude session and its Codex thread, and (2) a command that exposes the thread as a consult rather than a delegation.

**Model: one Claude session ↔ one Codex thread.** Both use cases are served by a 1:1 link:

1. *Discussion.* Ask GPT during a Claude session; quit; `claude --resume` later → `/codex:ask` continues the same Codex thread.
2. *Story review.* Claude implements a story; Codex reviews in rounds, each round resuming the same thread, until no material findings remain. One story per Claude session, so the link is per story for free.

Wanting a clean Codex context mid-session is a "start over": `--fresh` starts a new thread, which becomes the session's linked thread; a later `claude --resume` reconnects to that newest one. The Codex app server has no "clear" (only `thread/start`, `thread/resume`, `thread/list`, `thread/name/set`); old threads stay reachable with `codex resume <id>`.

## 2. Decisions already made (do not relitigate)

- **Fork, don't build.** No separate MCP server, no SDK wrapper. Threads live in Codex; the plugin only stores the session→thread link.
- **Fork only, no upstream PRs** (decided 2026-10-03; upstream is dormant with hundreds of open issues/PRs). The plugin's internals may change where that serves this workflow. `upstream-main` stays as a mirror for occasional syncs.
- **Install from the fork from day one.** Upstream is never installed separately.
- **Backend = Codex via the plugin's existing app-server runtime.** Auth is the Codex CLI's ChatGPT login (Business on company VMs, Plus/Max on personal). No API keys.
- **`ask` is read-only.** It never passes `--write`. Claude Code and Codex must not write to the same checkout concurrently; writes by Codex go through `/codex:rescue --wait` or a dispatched worker, never through `ask`.
- **The prompt carries instructions and pointers, never pre-digested content.** Codex reads the repository itself.
- **No LLM decisions in the runtime.** The companion executes rules; `ask.md` tells Claude what to do with the answer. Round counting for reviews lives in my BMAD skill, not in the plugin.
- **Focused changes.** Change what the 1:1 model needs, with tests and README; no unrelated refactors or renames.

## 3. Non-goals

- OpenCode or other providers.
- Changing `/codex:review` or the stop review gate. (`/codex:rescue` changes: it continues the linked thread by default, §6. `/codex:adversarial-review` stays; the story review loop is settled in §8.)
- A background/async mode for `ask` (`task --background` exists if ever needed).
- Writing to the repository from `ask`.
- Retries on rate limits.

## 4. Fork, branches, versions

### Branches

| Branch | Purpose | Rule |
|---|---|---|
| `upstream-main` | exact mirror of `openai/codex-plugin-cc@main` | never commit here; `git fetch upstream && git push origin upstream/main:upstream-main` |
| `main` | **integration branch = what the VMs install**; the fork's default branch | upstream + fork commits; updated by merging feature branches and, occasionally, `upstream-main` |
| `feat/<topic>` | fork features (`feat/session-link`, `feat/ask`, …) | branched from `main`, merged back into `main` |
| `fix/<topic>` | compatibility fixes (none needed per §0.2) | branched from `main` |

§0.1 confirmed refs are supported (`owner/repo#tag`); the marketplace is pinned to a tag.

Upstream sync (if upstream ever moves): `git fetch upstream`, update `upstream-main`, `git switch main && git merge upstream-main`, resolve, run tests, retag.

### Versions

The `version` fields in `.claude-plugin/marketplace.json` and `plugins/codex/.claude-plugin/plugin.json` on `main` are **semver prerelease on top of the upstream version**: upstream `1.0.6` → fork `1.0.6-fork.1`, next fork change `1.0.6-fork.2`, after merging upstream `1.0.7` → `1.0.7-fork.1`. Four-part versions (`1.0.6.1`) are not semver and may be rejected by the plugin loader (§0.1 confirms). Within the fork's own marketplace, prerelease versions order correctly against each other. Every version on `main` gets a git tag `v1.0.6-fork.1`; the Ansible role pins to tags.

### Marketplace manifest on `main`

- `.claude-plugin/marketplace.json` `name`: a fork-specific name (e.g. `skress-codex`) so it never collides with `openai-codex`.
- Plugin `name` stays `codex` so commands remain `/codex:*` and `${CLAUDE_PLUGIN_ROOT}` paths in existing commands keep working. Only one plugin named `codex` can be installed at a time; the install command selects the marketplace.
- `version` as above. This commit is the one fork-only change that never goes upstream; keep it in its own commit on `main` so upstream merges stay clean.

### Setup

```
gh repo fork openai/codex-plugin-cc --clone --remote      # origin = fork, upstream = openai
cd codex-plugin-cc
git switch -c upstream-main upstream/main && git push -u origin upstream-main
git switch main                                           # fork default branch
# commit: marketplace rename + version 1.0.6-fork.0, tag v1.0.6-fork.0
git switch -c feat/session-link main
```

## 5. Install from the fork (every VM, Docker images)

Interactive, first time:

```
/plugin marketplace add <you>/codex-plugin-cc      # GitHub owner/repo of the fork (ref syntax per §0.1)
/plugin install codex@skress-codex                  # marketplace name from §4
/reload-plugins
/codex:setup
!codex login                                         # if setup reports not logged in
```

Ansible role (tasks only; I wire it into my playbook):

- ensure `codex` CLI (brew on macOS; npm or release tarball on Linux), `node` ≥ 18.18, `jq`
- `claude plugin marketplace add <you>/codex-plugin-cc` pinned to the tag if refs are supported (§0.1), idempotent
- `claude plugin install codex@skress-codex --scope user`
- `codex login` stays manual per VM (device-code flow); the role asserts auth (`codex login status` or equivalent) and fails loudly if missing
- if the Claude Code sandbox is enabled on that VM, apply the `settings.json` allowances from §0.6

Docker images: same steps in the Dockerfile (`npm i -g @openai/codex`, marketplace add, plugin install at a tag), with a pre-authenticated `~/.codex` injected at launch, never baked into the image.

Updating VMs: bump the version on `main`, tag, then `claude plugin update codex@skress-codex` (or reinstall at the new tag) via the role.

## 6. Change 1: session→thread link (`feat/session-link`)

Purpose: one Claude session ↔ one Codex thread, surviving `claude --resume` (§1). Replaces the earlier `--thread <name>` design (dropped 2026-10-03: with a 1:1 link, names are unnecessary).

State (`lib/state.mjs`):

- `state.json` gains `links: { <claudeSessionId>: { threadId, updatedAt } }`. `saveState` persists it; `SessionEnd` cleanup leaves it alone (jobs are still cleaned up exactly as before).
- Pruning on save: drop links older than 90 days, cap at 200 (newest kept).

Runtime (`codex-companion.mjs`):

- **Write the link** when a `task` run returns a thread id (foreground and background), when a session id is present. A failed turn on a valid thread still links it. (Writing at "thread ready" instead was dropped: a concurrent resume is refused while a run is active anyway.)
- **`--resume-last` / `--resume`** resolve the session's link. If a task job of this session is queued/running → error as today (a thread runs one turn at a time). **If there is no link → start a fresh thread instead of erroring.** Without a session id (script run outside Claude Code): upstream fallback (`findLatestTaskThread`), then fresh.
- `task` without `--resume-last` stays a fresh run (explicit).
- `--no-link`: the run doesn't update the link. The stop-gate hook passes it, so gate runs never move the link.
- `task-resume-candidate --json` reports the linked thread (`available`, `threadId`).
- `--json` payload gains `errorMessage` (the failure message the runtime already computes; `null` on success) and `resumed` (boolean). Thrown errors stay on stderr with exit 1 and no stdout JSON.

`/codex:rescue` (`commands/rescue.md`, `agents/codex-rescue.md`): continue the linked thread by default — drop the "continue or new?" question, forward `--resume-last` unless `--fresh`. `--fresh` starts a new thread, which becomes the link.

Tests (`node --test`, fake Codex fixture): link written on fresh run; resume after `SessionEnd` + same session id continues the thread; `--fresh` moves the link; no link → fresh, no error; other session's link ignored; `--no-link` neither reads nor writes; running job → error; pruning; payload `errorMessage` on a failed turn; stop gate doesn't move the link.

## 7. Change 2: `commands/ask.md` (`feat/ask`)

```md
---
description: Ask GPT (via Codex, read-only) for input on the current question and engage with the answer
argument-hint: "[--fresh] [--model <model|spark>] [--effort <level>] <question>"
allowed-tools: Bash(node:*)
---
```

Body — instructions to Claude, in this order:

1. **Compose the prompt yourself.** It contains: (a) a two-to-four sentence summary of the current decision point and what you currently favor and why; (b) the user's question verbatim; (c) pointers to relevant files (paths, refs, line ranges) — never pasted contents; (d) the fixed closing line: "You have read-only access to this repository; read what you need, cite paths and lines, answer the question directly, and say where you disagree. Do not propose patches unless asked."
2. **Run** `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --resume-last --json <<'CODEX_ASK_PROMPT' … CODEX_ASK_PROMPT` with `timeout: 600000`. The prompt goes on stdin as a quoted heredoc (changed 2026-10-03 from `mktemp` + `--prompt-file`: no temp file, no cleanup, no Bash permission beyond `Bash(node:*)`). Omit `--resume-last` when `--fresh` was given. Pass `--model` / `--effort` through only if the user gave them. Never add `--write`. Never `--background`.
3. **Read the result.** Non-zero exit with no JSON → report the stderr message in one line and stop. `status` ≠ 0 → report `errorMessage` in one line (auth → "run `!codex login`"; rate limit → say so; still running → say a Codex task of this session is still running) and stop. No retries.
4. **Engage, don't relay.** Quote GPT's position briefly, say where you agree and where you disagree with reasons, and what you now recommend. Don't paste the raw output; don't ask whether to continue the thread (it continues automatically).

Plus a `/codex:ask` section in `README.md` in the style of the others, and `docs/` if commands are listed there.

## 8. Story review loop (lives in my skills, not in the fork)

Decided 2026-10-03: review rounds run **in the session's linked thread**, so round 2 resumes round 1 with its findings in context. That rules out `/codex:adversarial-review` as-is (ephemeral thread, pre-digested diff).

- `node … task --resume-last --json --prompt-file <brief>` — read-only, full repo, no pre-digestion. The brief includes base ref, story path, acceptance criteria, severity rules, and asks for a closing JSON block `{ status: clean|findings, findings: [...] }` the skill parses.
- Open: whether to expose `--output-schema` on `task` (the runtime already passes `outputSchema` to `turn/start` for adversarial review) to get a schema-enforced verdict instead of parsing a closing block. Decide after one real story.

The skill: runs the review in the foreground; writes the result under `## Codex review (round N)` in the story file (Claude is the single writer; Codex stays read-only); Claude checks items off as it addresses them; the skill enforces `max_rounds` (default 3) and treats a runtime failure as terminal, never as clean.

## 9. Order of work

1. ✅ §4 setup, install at `v1.0.6-fork.0`, §0 verification (`docs/verification.md`).
2. ✅ `feat/session-link` (§6); tests green; merge into `main`, tag `-fork.1`, update the local install. Manual check: `/codex:rescue --wait` → quit → `claude --resume` → `/codex:rescue --wait continue` → same thread (`codex resume <id>` shows both turns); `--fresh` moves the link.
3. ✅ `feat/ask` (§7); merge, tag `-fork.2`, update. Manual check: `/codex:ask`, quit, `claude --resume`, `/codex:ask` again → one Codex thread; `/codex:ask` after a `--write` rescue in the same session → resumes read-only (write attempt fails).
4. Story review loop skill (§8) on one real story.
5. Ansible tasks; install from the tag on one Linux and one macOS VM; verify §0.6 on a VM with the Claude Code sandbox enabled.

## 10. Constraints on how you work on this

- Use the existing `codex login` on this machine; never create or paste API keys.
- Don't modify upstream behavior you don't need to; a compatibility fix in `lib/codex.mjs` gets its own branch, commit and PR.
- No `AGENTS.md`/`CLAUDE.md` generation; I maintain those by hand.
- Commits small; messages state the decision, not the diff.
