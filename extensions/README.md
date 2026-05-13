# Subagent Extension

This directory contains the Pi extension entry point and bundled agents for `pi-sub-agent`.

## What the extension registers

- A `subagent` tool for delegating work to isolated Pi subprocesses.
- Bundled default agents from `extensions/agents/`.
- A `/sub-agent-settings` slash command for configuring sub-agent model and thinking effort.
- No prompt templates.

## Tool modes

| Mode | Parameters | Behavior |
| --- | --- | --- |
| Single | `{ agent, task }` | Runs one agent for one task. |
| Parallel | `{ tasks: [...] }` | Runs up to 8 tasks, with 4 subprocesses at a time. |
| Chain | `{ chain: [...] }` | Runs up to 8 steps sequentially; `{previous}` is replaced with prior output. |

Each subagent runs `pi --mode json -p --no-session` with the selected agent's system prompt, working directory, and either the agent's explicit `model` or the active parent Pi model plus thinking level. Tool access is capped by the parent Pi session's active tool allowlist; agent-level `tools` entries can narrow that list but cannot re-enable disabled parent tools. The `subagent` tool itself is removed from child allowlists, and child processes receive depth tracking so nested subagent calls are blocked before spawning again. The delegated task prompt is sent over stdin instead of being exposed in child process arguments.

### Parameter reference

| Field | Applies to | Notes |
| --- | --- | --- |
| `agent` + `task` | Single | Run one named agent with one task. |
| `tasks` | Parallel | Array of `{ agent, task, cwd? }`; maximum 8 tasks and 4 concurrent subprocesses. |
| `chain` | Chain | Array of `{ agent, task, cwd? }`, maximum 8; `{previous}` is replaced with prior output. |
| `agentScope` | All | `"user"` by default; use `"project"` or `"both"` only for trusted repositories. |
| `confirmProjectAgents` | All | Defaults to `true`; prompts when UI is available and blocks project-local agents in non-interactive runs unless explicitly set to `false`. |
| `cwd` | Single | Default working directory override for the subprocess. |

`cwd` overrides are resolved relative to the parent Pi working directory. A leading `@` is stripped so file-reference-style paths such as `@packages/app` work as expected.

## Agent discovery

Bundled agents are always available. `agentScope` controls additional locations:

| `agentScope` | Loaded sources |
| --- | --- |
| `user` (default) | bundled agents + `~/.pi/agent/agents/*.md` |
| `project` | bundled agents + nearest `.pi/agents/*.md` |
| `both` | bundled agents + user agents + nearest project agents |

When two agents share the same `name`, later sources override earlier ones: bundled < user < project.

## Agent definition format

```markdown
---
name: reviewer
description: Code review specialist for quality and security analysis
tools: read, grep, find, ls, bash
# Optional: model: provider/model-id
# Optional: thinking: off|minimal|low|medium|high|xhigh
---

System prompt for the agent goes here.
```

- `name` and `description` are required.
- `tools` is optional and can be a comma-separated string or YAML list. Omit it to inherit the parent Pi session's active tools; specify it to narrow those tools for that agent. The `subagent` tool is always removed from the child allowlist to avoid recursive delegation.
- `model` and `thinking` are optional; omit them to inherit the active parent Pi model and thinking level. Legacy `model: provider/model-id:high` values are parsed as a model plus thinking setting.
- Agent files with unreadable content, missing required metadata, invalid metadata types, or malformed YAML frontmatter are skipped.

## Bundled agents

| Agent | Purpose | Tools |
| --- | --- | --- |
| `scout` | Fast codebase reconnaissance and compressed context handoff. | `read`, `grep`, `find`, `ls` |
| `planner` | Read-only implementation planning. | `read`, `grep`, `find`, `ls` |
| `reviewer` | Read-only code quality and security review. | `read`, `grep`, `find`, `ls`, `bash` |
| `worker` | General-purpose implementation in an isolated context. | Parent active tools |

## Slash command

Use `/sub-agent-settings` to open an interactive settings window for bundled and user-defined sub-agents in the default `user` scope. The list displays each agent as `name  model • thinking`; `inherit` means the sub-agent uses the parent Pi session value. Changing a bundled agent writes a same-named user override under `~/.pi/agent/agents/` instead of editing package files.

## Output and rendering

The tool streams partial progress with structured `details` for each subagent result. In interactive mode it renders compact status by default and an expanded view with task text, formatted tool calls, Markdown output, subprocess failure diagnostics, model, token usage, cost, and per-step totals.

Collapsed views use Pi's configured `app.tools.expand` keybinding hint (Ctrl+O by default) instead of hard-coding a shortcut.

LLM-facing tool content is truncated from the tail at Pi's default limits (2,000 lines / 50KB) to protect the parent context. Full subagent messages remain in `details` for expanded rendering and follow-up analysis.

## Security notes

Project-local agents are repository-controlled prompts. Only use `agentScope: "project"` or `"both"` in repositories you trust. Agent tool lists are still capped by the parent session's active tools, but enabled tools can still read, run commands, or edit files under the agent prompt's direction. With the default `confirmProjectAgents: true`, the extension asks for confirmation before running project-local agents when UI is available and cancels in non-interactive runs. Set `confirmProjectAgents: false` only after reviewing and trusting the project agents.

Subagents run as normal child `pi` invocations in the selected `cwd`, so Pi packages/extensions enabled for that working directory still use Pi's standard package security model. Install only trusted Pi packages and avoid `cwd` overrides into repositories whose Pi configuration you have not reviewed.

Recursive delegation is intentionally blocked. The parent process sets `PI_SUB_AGENT_DEPTH=1` for child Pi invocations; if a child session somehow invokes `subagent`, the extension returns an error before spawning another process.

Delegated task text is passed to the child Pi process over stdin rather than as an argv value, reducing process-list exposure and avoiding OS argument-length failures for large chained handoffs.

## Error handling

- Invalid tool arguments return a clear error message.
- Unknown agents include the available agent list.
- Non-zero subprocess exits, `stopReason: "error"`, and `stopReason: "aborted"` are treated as failed subagent runs.
- Subprocess launch failures include the attempted command and OS error so missing `pi` executables or wrapper misconfiguration are actionable.
- Failed subagent runs are marked as Pi tool errors via the `tool_result` hook while preserving structured `details` and stderr/error diagnostics for rendering and follow-up analysis.
- Project-local agents are blocked without UI confirmation unless `confirmProjectAgents: false` is explicitly set.
- Nested `subagent` calls are blocked before spawning another Pi process.
- Chains are capped at 8 steps, stop at the first failed step, and return diagnostic output plus completed step details.
- Aborts propagate to the active subprocess and escalate from `SIGTERM` to `SIGKILL` after 5 seconds.
