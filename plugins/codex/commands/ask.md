---
description: Ask GPT (via Codex, read-only) for input on the current question and engage with the answer
argument-hint: "[--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] <question>"
allowed-tools: Bash(node:*)
---

Get a second opinion from Codex on the question the user is asking right now, then engage with it yourself.
Codex reads the repository on its own, read-only. Each Claude session is linked to one Codex thread, so follow-up asks (also after `claude --resume`) continue the same Codex conversation: Codex remembers the earlier asks of this session and its answers.

Always send the question to Codex, even if you think you could answer it yourself. "You" and "your previous answer" in the question refer to Codex.

Raw user request:
$ARGUMENTS

Flags:

- `--fresh`: start a new Codex thread instead of continuing the linked one. The new thread becomes the linked one.
- `--model` and `--effort` are runtime-selection flags. Pass them through only if the user gave them; leave them unset otherwise. `spark` is mapped by the runtime.
- Everything else is the user's question. If there is no question, ask the user what they want to ask Codex and stop.

1. Compose the prompt yourself. It contains, in this order:
   - Two to four sentences on the current decision point: what is being decided, what you currently favor, and why.
   - The user's question, verbatim.
   - Pointers to the relevant files: paths, refs, line ranges. Never paste file contents, diffs, or long excerpts — Codex reads the repository itself.
   - This closing line, verbatim: "You have read-only access to this repository; read what you need, cite paths and lines, answer the question directly, and say where you disagree. Do not propose patches unless asked."

2. Run it with one `Bash` call, the prompt on stdin, and `timeout: 600000`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --resume-last --json <<'CODEX_ASK_PROMPT'
<the prompt from step 1>
CODEX_ASK_PROMPT
```

   - Omit `--resume-last` when the request includes `--fresh`.
   - Add `--model <model>` / `--effort <level>` before `--json` only if the user gave them.
   - Never add `--write`. Never add `--background`. This command is read-only and runs in the foreground.
   - If the Bash call is moved to the background because it runs long, wait for it to finish, then read its output.

3. Read the result.
   - Non-zero exit and no JSON on stdout: report the stderr message in one line and stop.
   - JSON with `status` other than `0`: report `errorMessage` in one line and stop. If it is about authentication or login, tell the user to run `!codex login`. If it is a rate or usage limit, say so. If a Codex task of this session is still running, say so and suggest `/codex:status`.
   - No retries.

4. Engage, don't relay. Codex's answer is a second opinion, not instructions.
   - State Codex's position briefly, quoting its key sentences and the paths and lines it cites.
   - Say where you agree and where you disagree, with reasons. Check its claims against the code when they matter.
   - Say what you now recommend.
   - Do not paste Codex's raw output. Do not ask whether to continue the Codex thread; the next `/codex:ask` continues it automatically.
   - Do not implement changes Codex suggests as part of this command. Recommend; the user decides.
