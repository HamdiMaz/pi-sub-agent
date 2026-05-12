# pi-sub-agent

A Pi package extension that adds a `subagent` tool for delegating work to specialized Pi subprocesses with isolated context windows.

## Highlights

- Runs each delegated task in a separate `pi --mode json -p --no-session` subprocess.
- Supports **single**, **parallel**, and **chain** workflows.
- Bundles default `scout`, `planner`, `reviewer`, and `worker` agents.
- Discovers user agents from `~/.pi/agent/agents/*.md` and optional project agents from `.pi/agents/*.md`.
- Streams progress, usage, tool-call summaries, final Markdown output, failure diagnostics, and structured result details.
- Sends delegated task prompts to child Pi processes over stdin instead of exposing prompt text in process arguments.
- Truncates LLM-facing tool output to Pi's default tool limits (2,000 lines / 50KB) while preserving full structured details for rendering.
- Prevents recursive subagent fan-out by removing the `subagent` tool from child allowlists and blocking nested subagent invocations.
- Requires confirmation before running project-local agents; non-interactive runs must explicitly set `confirmProjectAgents: false`.
- Includes prompt templates: `/implement`, `/scout-and-plan`, and `/implement-and-review`.

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

Ask Pi to delegate to a bundled or user-defined agent:

```text
Use the scout subagent to locate the authentication entry points.
```

The tool accepts exactly one mode:

```json
{ "agent": "scout", "task": "Find all authentication code" }
```

```json
{
  "tasks": [
    { "agent": "scout", "task": "Review database models" },
    { "agent": "planner", "task": "Review CLI entry points" }
  ]
}
```

```json
{
  "chain": [
    { "agent": "scout", "task": "Find code relevant to OAuth" },
    { "agent": "planner", "task": "Plan OAuth support using this context:\n{previous}" },
    { "agent": "worker", "task": "Implement the plan:\n{previous}" }
  ]
}
```

Parallel mode is limited to 8 tasks total, with up to 4 running at once. Chain mode is limited to 8 sequential steps.

### Tool parameters

| Field | Applies to | Description |
| --- | --- | --- |
| `agent` | Single | Agent name to run. Use with `task`. |
| `task` | Single | Task text passed to the selected agent. Use with `agent`. |
| `tasks` | Parallel | Array of `{ agent, task, cwd? }` items. |
| `chain` | Chain | Array of `{ agent, task, cwd? }` steps, maximum 8. `{previous}` is replaced with the prior step's final output. |
| `agentScope` | All | `"user"` (default), `"project"`, or `"both"`. Bundled agents are always available. |
| `confirmProjectAgents` | All | Defaults to `true`; asks before running project-local agents when UI support exists. In non-interactive runs, project-local agents are blocked unless this is explicitly set to `false`. |
| `cwd` | Single | Working directory override for the single-agent subprocess. |

`cwd` overrides on single, parallel, or chain tasks are resolved relative to the parent Pi working directory. A leading `@` is accepted and stripped, matching Pi file-reference conventions.

## Agent files

Agents are Markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
# Optional: model: provider/model-id
---

System prompt for the agent goes here.
```

Discovery order is bundled extension agents first, then user agents, then project agents. Later sources override earlier agents with the same `name`.

`tools` may be a comma-separated string or a YAML list. Tool lists narrow the parent Pi session's active tool allowlist; omitted `tools` inherit the parent active tools. A subagent never enables a tool that is disabled in the parent session, and the `subagent` tool itself is always removed from child allowlists to avoid recursive delegation. `model` is optional; when omitted, the subagent is launched with the active parent Pi model and thinking level.

Unreadable agent files, missing required `name`/`description` metadata, invalid metadata types, and malformed YAML frontmatter are skipped so one bad agent file does not break discovery.

| Scope | Loaded agents |
| --- | --- |
| `user` (default) | bundled + `~/.pi/agent/agents/*.md` |
| `project` | bundled + nearest `.pi/agents/*.md` |
| `both` | bundled + user + nearest project agents |

## Security model

Project-local agents are repository-controlled prompts. They can request tools within the parent session's active tool allowlist and can instruct a subagent to read files, run shell commands, or edit code when those tools remain enabled. Keep `agentScope` at the default `"user"` unless you trust the repository. With the default `confirmProjectAgents: true`, the extension confirms before running project-local agents when UI is available and blocks them in non-interactive runs. Set `confirmProjectAgents: false` only when you have already reviewed and trust the project agents.

Each subagent is a normal child `pi` invocation in the selected `cwd`, so Pi packages and extensions enabled for that working directory still follow Pi's standard package security model. Install only trusted Pi packages and avoid `cwd` overrides into repositories whose Pi configuration you have not reviewed.

Recursive delegation is intentionally blocked. Child Pi processes receive `PI_SUB_AGENT_DEPTH=1`; if a child session somehow invokes `subagent` again, the extension returns a clear error before spawning another process.

Delegated task text is written to the child Pi process over stdin instead of being appended to command-line arguments, reducing process-list exposure and avoiding OS argument-length limits during large chain handoffs.

## Output limits

The text returned to the main model is truncated from the tail at Pi's default tool-output limits: 2,000 lines or 50KB, whichever is hit first. Full subagent messages remain in structured `details` so interactive rendering can still show complete expanded output without flooding the model context.

## Error handling

- Invalid requests return clear guidance and keep structured result details available to the main agent.
- Non-zero subprocess exits, `stopReason: "error"`, and `stopReason: "aborted"` are treated as failed subagent runs.
- Subprocess launch failures, such as a missing `pi` executable, include the attempted command and OS error in the LLM-facing failure output.
- Failed subagent runs are marked as Pi tool errors without dropping streamed output, subprocess diagnostics, or per-agent details.
- Project-local agents are blocked in non-interactive runs unless `confirmProjectAgents: false` is set.
- Nested `subagent` calls are blocked before spawning another Pi process.
- Chain mode is capped at 8 steps and stops at the first failed step with diagnostic output; parallel mode reports per-task success and failure counts.
- Aborts propagate to child processes with `SIGTERM` and escalate to `SIGKILL` after 5 seconds if the subprocess does not exit.

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

Key files:

- `extensions/index.ts` — Pi extension and `subagent` tool implementation.
- `extensions/agents.ts` — agent discovery and frontmatter loading.
- `extensions/agents/*.md` — bundled default agents.
- `extensions/prompts/*.md` — workflow prompt templates.
- `tests/subagent.test.ts` — regression tests for discovery, Pi tool conventions, and package metadata.
