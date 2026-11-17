# pi-sub-agent

A Pi package extension that adds a `subagent` tool for delegating work to a Pi subprocess with an isolated context window.

## Highlights

- Runs each delegated task in a separate `pi --mode json -p --no-session` subprocess.
- Supports **single**, **parallel**, and **chain** modes.
- Bundles one general-purpose `subagent` agent. The parent writes the role, scope, and output format into the task text, so one profile covers discovery, implementation, review, and verification.
- Makes `agent` optional. A call can be only `{ "task": "..." }`.
- Discovers optional user agents from `~/.pi/agent/agents/*.md` and project agents from `.pi/agents/*.md`.
- Provides `/sub-agent-settings` to set the model and thinking effort for the subagent in one place.
- Gives the subagent the read-only search tools `grep`, `find`, and `ls` even when the parent session has them disabled.
- Adds `readOnly` to keep a review or audit task from changing files, and `projectContext` to opt into project `AGENTS.md` files. Project context is off by default, because a large `AGENTS.md` dominates the cost of every turn.
- Skips skills in child runs by default. Set `skills: true` only when the task must follow a named skill.
- Stops a run after 60 turns so one task cannot become a long, expensive session.
- Streams progress, usage, tool-call summaries, final Markdown output, failure diagnostics, and structured result details.
- Sends delegated task prompts to child Pi processes over stdin instead of exposing prompt text in process arguments.
- Truncates each included LLM-facing subagent output to Pi's default tool limits (2,000 lines / 50KB), writes full truncated text to a private temp file, and preserves structured details for rendering.
- Prevents recursive subagent fan-out by removing the `subagent` tool from child allowlists and blocking nested subagent invocations.
- Requires confirmation before running project-local agents; non-interactive runs must explicitly set `confirmProjectAgents: false`.
- Registers the `/sub-agent-settings` slash command, but does not bundle prompt templates.

## Requirements

- Pi coding agent 0.74 or newer.
- The `pi` executable available to the parent process (normal when the package runs inside Pi).
- Credentials for the active parent Pi model, plus any model explicitly selected by a custom agent.

## Installation

After publication:

```bash
pi install npm:pi-sub-agent
```

From a local checkout:

```bash
npm install
npm run check
pi install ./ -l
```

For one-off testing without installing:

```bash
pi -e ./extensions/index.ts
```

## Usage

Delegate a task to the default subagent:

```text
Use a subagent to review the search endpoint. Review only, do not modify files.
```

A task alone is a valid call. The default agent is `subagent`:

```json
{ "task": "Review src/search.ts for error handling. Review only, do not modify files." }
```

The tool accepts exactly one mode:

```json
{ "agent": "subagent", "task": "Find all authentication code" }
```

```json
{
  "tasks": [
    { "task": "Review database models" },
    { "task": "Review CLI entry points" }
  ]
}
```

```json
{
  "chain": [
    { "task": "Find code relevant to OAuth" },
    { "task": "Plan OAuth support using this context:\n{previous}" },
    { "task": "Implement the plan:\n{previous}" }
  ]
}
```

Parallel mode is limited to 8 tasks total, with up to 4 running at once. Chain mode is limited to 8 sequential steps.

### Delegation best practices

- Write the role into the task text: say what to do, where, the constraints, and the output format. Say "review only, do not modify files" when the task must not change code.
- Keep each delegated task self-contained, but keep it short. Put a long brief in a file and pass the path. Very long inline tasks cost more tokens and can break tool-call JSON.
- Tell the subagent to batch independent tool calls in one turn and to combine related shell commands into one `bash` call. This is the largest cost control for subagent runs.
- Prefer one well-scoped call over many small calls. Each call pays its own prompt and start-up cost.
- Use parallel mode for independent research tasks; use chain mode only when each step needs the previous step's output.
- Keep chain handoffs concise. The full subagent details remain available in the tool result, but the next subagent only receives the previous final text through `{previous}`.
- Name an agent only for an optional user agent in `~/.pi/agent/agents` or a project agent in `.pi/agents`. Review project-local agents before enabling `agentScope: "project"` or `"both"`, especially in repositories you did not create.

### Tool parameters

| Field | Applies to | Description |
| --- | --- | --- |
| `agent` | Single, parallel, chain | Optional agent name. Omit it to use the default `subagent` agent. |
| `task` | Single | Task text passed to the selected agent. Use with `agent`, or alone. |
| `tasks` | Parallel | Array of `{ task, agent?, cwd? }` items. |
| `chain` | Chain | Array of `{ task, agent?, cwd? }` steps, maximum 8. `{previous}` is replaced with the prior step's final output. |
| `agentScope` | All | `"user"` (default), `"project"`, or `"both"`. The bundled agent is always available. |
| `readOnly` | All | Defaults to `false`. When `true`, the subagent gets only `read`, `grep`, `find`, and `ls`, so it cannot change files or run commands. |
| `projectContext` | All | Defaults to `false`. When `true`, the subagent loads project `AGENTS.md` and `CLAUDE.md` files. Keep it `false` for self-contained tasks and put the needed rules in the task text. |
| `skills` | All | Defaults to `false`. When `true`, the subagent loads discovered and configured skills. Most tasks do not need them; a loaded skill set adds roughly 2.5k tokens to every turn. |
| `confirmProjectAgents` | All | Defaults to `true`; asks before running project-local agents when UI support exists. In non-interactive runs, project-local agents are blocked unless this is explicitly set to `false`. |
| `cwd` | All | Default working directory override for every subprocess in the call; per-task or per-step `cwd` overrides it. |

`cwd` overrides on single calls, top-level parallel/chain calls, or individual parallel/chain tasks are resolved relative to the parent Pi working directory. A leading `@` is accepted and stripped, matching Pi file-reference conventions.

Each run stops after 60 assistant turns. A run at that limit fails with `stopReason: "turn_limit"` and a message that asks the parent to split the task. This limit protects you from the long 100-plus-turn runs that cost the most.

## Agent files

Agents are Markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
# Optional: model: provider/model-id
# Optional: thinking: off|minimal|low|medium|high|xhigh
---

System prompt for the agent goes here.
```

Discovery order is bundled extension agents first, then user agents, then project agents. Later sources override earlier agents with the same `name`.

`tools` may be a comma-separated string or a YAML list. Tool lists narrow the parent Pi session's active tool allowlist; omitted `tools` inherit the parent active tools. A subagent never enables a write, edit, or shell tool that is disabled in the parent session, and the `subagent` tool itself is always removed from child allowlists to avoid recursive delegation. The read-only tools `read`, `grep`, `find`, and `ls` are the exception: a subagent may use them even when the parent session has them disabled, because they cannot change the repository. Because the bundled `subagent` agent lists its tools explicitly, its child runs do not receive MCP or extension tools from the parent. Define a user agent without a `tools` field if you need those. `model` and `thinking` are optional and inherit independently: an agent with a custom `model` but no `thinking` still uses the parent session's thinking level. Set `thinking: off` to explicitly disable inherited reasoning effort for that subagent. Legacy `model: provider/model-id:high` entries are parsed as `model: provider/model-id` plus `thinking: high`.

Unreadable agent files, missing required `name`/`description` metadata, invalid metadata types, and malformed YAML frontmatter are skipped so one bad agent file does not break discovery.

Subagents run with `--no-context-files` and `--no-skills` by default. Set `projectContext: true` on a call to load the project `AGENTS.md` and `CLAUDE.md` files, and `skills: true` to load skills. A large `AGENTS.md` is re-read on every turn, so it is the largest single cost in a subagent run. Put only the rules that the task needs into the task text when you leave it off.

## Bundled agent

| Agent | Purpose | Tools |
| --- | --- | --- |
| `subagent` | General-purpose work in an isolated context. The task text selects the role: discover, implement, review, or verify. | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |

`subagent` is the default when a call omits `agent`. It does not pin a model or a thinking level, so the parent session and `/sub-agent-settings` decide both. Its system prompt asks it to batch 2 to 4 independent tool calls per turn, to combine related shell commands into one `bash` call, and to avoid commentary-only turns.

| Scope | Loaded agents |
| --- | --- |
| `user` (default) | bundled + `~/.pi/agent/agents/*.md` |
| `project` | bundled + nearest `.pi/agents/*.md` |
| `both` | bundled + user + nearest project agents |

A project agent with the same name as the default still follows the confirmation rule: when a call omits `agent` and scope includes project agents, the default name is checked against the project directory before it runs.

## Slash commands

### `/sub-agent-settings`

Opens an interactive settings window listing the bundled and user-defined sub-agents visible in the default `user` scope. With the default configuration this window has one row. In print/JSON modes where no interactive UI is available, the command exits with a warning instead of opening the settings window. The row shows the current model and thinking effort, for example:

```text
subagent  openai/gpt-5.5 • high
```

Set either field to `inherit` to use the parent Pi session's active model or thinking level. Edits to user agents update their markdown frontmatter. Edits to bundled agents create or update a same-named user override in `~/.pi/agent/agents/`, so package files are not modified.

## Security model

Project-local agents are repository-controlled prompts. They can request write, edit, and shell tools only within the parent session's active tool allowlist. They can always request the read-only `read`, `grep`, `find`, and `ls` tools. Keep `agentScope` at the default `"user"` unless you trust the repository. With the default `confirmProjectAgents: true`, the extension confirms before running project-local agents when UI is available and blocks them in non-interactive runs, including when a call omits `agent` and a project agent overrides the default name. Set `confirmProjectAgents: false` only when you have already reviewed and trust the project agents.

Each subagent is a normal child `pi` invocation in the selected `cwd`, so Pi packages and extensions enabled for that working directory still follow Pi's standard package security model. Install only trusted Pi packages and avoid `cwd` overrides into repositories whose Pi configuration you have not reviewed.

Recursive delegation is intentionally blocked. Child Pi processes receive `PI_SUB_AGENT_DEPTH=1`; if a child session somehow invokes `subagent` again, the extension returns a clear error before spawning another process.

Delegated task text is written to the child Pi process over stdin instead of being appended to command-line arguments, reducing process-list exposure and avoiding OS argument-length limits during large chain handoffs.

## Output limits

The text returned to the main model is truncated from the tail per included subagent output at Pi's default tool-output limits: 2,000 lines or 50KB, whichever is hit first. Parallel mode returns one bounded section per subagent rather than a shared 50KB budget, so every parallel task remains visible to the parent agent. When truncation occurs, the affected section includes a `Full output saved to:` temp-file path with `0600` permissions so the main agent can inspect the complete text if needed. Full subagent messages also remain in structured `details` so interactive rendering can show complete expanded output without flooding the model context.

## Error handling

- Invalid requests return clear guidance and keep structured result details available to the main agent; partial or mixed mode arguments are rejected before spawning child Pi processes.
- An unknown agent name returns the available names and, when a close match exists, a "Did you mean" suggestion. Omit `agent` to use the default `subagent` agent.
- Invalid `cwd` overrides are rejected before spawning child Pi processes and include the resolved path in diagnostics.
- Non-zero subprocess exits, `stopReason: "error"`, `stopReason: "aborted"`, `stopReason: "length"`, and `stopReason: "turn_limit"` are treated as failed subagent runs.
- A run that reaches 60 assistant turns is stopped with a `turn_limit` failure and a message to split the task.
- Subprocess launch failures, such as a missing `pi` executable, include the attempted command and OS error in the LLM-facing failure output.
- Malformed child stdout in JSON mode is captured as a diagnostic; if no JSON messages are produced, the run is treated as a failed subagent invocation instead of silently returning `(no output)`.
- Failed subagent runs and pre-spawn failures (invalid arguments, nested calls, project-agent confirmation blocks, or task-limit violations) are marked as Pi tool errors without dropping streamed output, subprocess diagnostics, or per-agent details.
- Project-local agents are blocked in non-interactive runs unless `confirmProjectAgents: false` is set.
- Nested `subagent` calls are blocked before spawning another Pi process.
- Chain mode is capped at 8 steps and stops at the first failed step with diagnostic output; parallel mode reports per-task success and failure counts with failure diagnostics.
- Aborts propagate to child processes with `SIGTERM` and escalate to `SIGKILL` after 5 seconds if the subprocess does not exit.
- Child Pi processes terminated by an external signal are treated as failed runs and include the signal name in diagnostics.

## Troubleshooting

If a subagent fails with `Failed to start subagent process (pi): ...`, make sure the `pi` executable is available to the parent Pi process. This is normally automatic when running through the installed Pi CLI. For custom wrappers or local development, either launch Pi through its normal executable or ensure `pi` is on `PATH` before invoking the extension.

## Development

```bash
npm test
npm run typecheck
npm run lint
npm run check
```

`npm publish` runs `npm run check` automatically through `prepublishOnly`.

## Public release readiness

This package follows Pi package conventions for public distribution:

- `package.json` declares an explicit `pi.extensions` entry (`./extensions/index.ts`) so Pi loads only the public extension entry point, not helper modules.
- Runtime Pi imports (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`) are declared as peer dependencies, matching Pi package guidance.
- The published npm tarball is limited to `extensions/`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `package.json` via the `files` list.
- The package intentionally does not publish `prompts/`, `skills/`, or `themes/`; it only registers the `subagent` tool and `/sub-agent-settings` command.
- Before publishing, run `npm run check` and `npm pack --dry-run` to verify tests, linting, type checking, and packaged files.

### Release verification checklist

Run these from the repository root immediately before publishing:

```bash
npm test
npm run typecheck
npm run lint
npm run check
npm audit --omit=dev
npm pack --dry-run
```

Confirm that `npm audit --omit=dev` reports no production dependency vulnerabilities and that `npm pack --dry-run` includes only the public runtime files: `extensions/`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `package.json`. Do not publish local `.pi/`, `tests/`, generated coverage, or development-only files.

After installing the packed package in a scratch project, run a short interactive smoke test before publishing publicly:

1. Start Pi with the installed package enabled and confirm the startup header lists `pi-sub-agent`.
2. Run `/sub-agent-settings` and verify bundled agents are listed; exit without saving if no changes are needed.
3. Ask for a simple subagent delegation in a disposable repository and confirm the child process streams progress and returns structured output.
4. If testing project-local agents, review the `.pi/agents/*.md` files first and leave `confirmProjectAgents` enabled unless the repository is trusted.

Key files:

- `extensions/index.ts` — Pi extension and `subagent` tool implementation.
- `extensions/agents.ts` — agent discovery and frontmatter loading.
- `extensions/agents/*.md` — bundled default agents.
- `tests/subagent.test.ts` — regression tests for discovery, Pi tool conventions, and package metadata.
