# Codex plugin (fork) — cheat sheet

Fork of `openai/codex-plugin-cc`, published as marketplace `skress-codex`. Commands stay `/codex:*`.
Fork additions: `/codex:ask`, and **one Codex thread per Claude session** that survives `claude --resume`.

## Install

Prerequisites: Claude Code, Node.js ≥ 18.18, Codex CLI logged in.

```bash
brew install codex            # or: npm install -g @openai/codex
codex login                   # ChatGPT login; --device-auth on headless machines
```

Add the marketplace pinned to a release tag, then install the plugin:

```bash
claude plugin marketplace add 'skress/codex-plugin-cc#v1.0.6-fork.3'
claude plugin install codex@skress-codex --scope user
```

Restart Claude Code, then check readiness with `/codex:setup`.

Don't install `codex@openai-codex` as well: only one plugin named `codex` loads per session.

### Update to a newer tag

The tag is also recorded in `~/.claude/settings.json`, so a plain `plugin update` won't move it:

1. In `~/.claude/settings.json`, set `extraKnownMarketplaces["skress-codex"].source.ref` to the new tag.
2. `claude plugin marketplace add 'skress/codex-plugin-cc#<new tag>'`
3. `claude plugin update codex@skress-codex --scope user`, then restart Claude Code.

## The session ↔ thread link

Each Claude session is linked to one Codex thread. `/codex:ask` and `/codex:rescue` continue it, also after you quit and `claude --resume`. `--fresh` starts a new thread, which becomes the linked one. `/clear` starts a new Claude session and therefore a new thread. Old threads stay available via `codex resume <id>`.

## Commands

Flags shared by `ask` and `rescue`:
- `--model <model|spark>`: model override; `spark` = `gpt-5.3-codex-spark`. Default: Codex's own.
- `--effort <none|minimal|low|medium|high|xhigh>`: reasoning effort. Default: Codex's own.

### `/codex:ask [--fresh] [--model …] [--effort …] <question>` — second opinion

Claude writes the prompt (decision point, your question verbatim, file pointers) and Codex answers **read-only** in the linked thread. Claude then says where it agrees and disagrees with Codex and what it recommends. Runs in the foreground.

```text
/codex:ask should retries live in the client or in the job runner? see docs/decision.md
/codex:ask --effort high what is the PRD in docs/prd.md missing for replay?
/codex:ask --fresh review the module boundaries in src/billing from scratch
```

Put `/codex:ask` at the **start** of your message; mid-sentence it isn't run as a command.

### `/codex:rescue [--background|--wait] [--fresh] [--model …] [--effort …] <task>` — delegate work

Hands a task to Codex. Codex **can write** to the repo unless you ask for read-only. Continues the linked thread; `--fresh` starts over. Runs in the foreground by default; `--background` for long tasks, then use `/codex:status` and `/codex:result`.

```text
/codex:rescue investigate why the integration tests are flaky
/codex:rescue apply the top fix from your last answer
/codex:rescue --background --effort high refactor the retry logic in src/client.js
```

Avoid editing the same files with Claude while a write-capable rescue runs.

### `/codex:review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]` — code review

Codex's built-in reviewer, read-only, no custom focus text.
- Scope `auto` (default): the working tree if it's dirty, otherwise the branch diff against the default branch.
- `--base <ref>`: review the branch diff against `<ref>`.
- Without `--wait`/`--background`, Claude asks, based on the diff size.

```text
/codex:review --wait
/codex:review --base main --background
```

### `/codex:adversarial-review [--wait|--background] [--base <ref>] [--scope …] [focus …]` — challenge review

Like `review`, but questions the design and approach, and takes focus text. Read-only.

```text
/codex:adversarial-review --base main challenge the caching and retry design
```

### `/codex:status [job-id] [--wait] [--timeout-ms <ms>] [--all]` — jobs

Running and recent Codex jobs of this session. `--wait` (needs a job id) blocks until that job finishes. `--all` lists every job of the session instead of only the latest ones.

### `/codex:result [job-id]` — output of a finished job

Includes the Codex thread id for `codex resume <id>`. Without an id: the latest finished job.

### `/codex:cancel [job-id]` — stop a background job

Without an id: the active job of this session.

### `/codex:transfer [--source <claude-jsonl>]` — move the session to Codex

Imports the current Claude conversation into a new Codex thread and prints `codex resume <id>` to continue it in the Codex CLI or app.

### `/codex:setup [--enable-review-gate|--disable-review-gate]` — readiness and review gate

Checks Codex install and login. The **review gate** (off by default) runs a Codex review whenever Claude stops and blocks the stop if it finds issues. It can loop and use up limits quickly, so only enable it when you're watching. Gate runs never move the session link.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "not logged in" / auth error | `!codex login` in Claude Code, then `/codex:setup` |
| "Task … is still running" on ask/rescue | a background job of this session is busy; `/codex:status`, wait or `/codex:cancel` |
| rate or usage limit | wait; the commands don't retry |
| resume fails with an unknown thread | the linked Codex thread is gone; use `--fresh` |
| `/codex:ask` missing after install/update | restart Claude Code |
