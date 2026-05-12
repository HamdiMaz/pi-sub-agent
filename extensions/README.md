# Subagent Extension

This directory contains the Pi extension entry point, bundled agents, and workflow prompt templates for `pi-sub-agent`.

## What the extension registers

- A `subagent` tool for delegating work to isolated Pi subprocesses.
- Prompt templates from `extensions/prompts/` through the `resources_discover` event.
- Bundled default agents from `extensions/agents/`.

## Tool modes

| Mode | Parameters | Behavior |
| --- | --- | --- |
| Single | `{ agent, task }` | Runs one agent for one task. |
| Parallel | `{ tasks: [...] }` | Runs up to 8 tasks, with 4 subprocesses at a time. |
| Chain | `{ chain: [...] }` | Runs steps sequentially; `{previous}` is replaced with prior output. |

Each subagent runs `pi --mode json -p --no-session` with the selected agent's system prompt, model, tool allowlist, and working directory.

### Parameter reference

| Field | Applies to | Notes |
| --- | --- | --- |
| `agent` + `task` | Single | Run one named agent with one task. |
| `tasks` | Parallel | Array of `{ agent, task, cwd? }`; maximum 8 tasks and 4 concurrent subprocesses. |
| `chain` | Chain | Array of `{ agent, task, cwd? }`; `{previous}` is replaced with prior output. |
| `agentScope` | All | `"user"` by default; use `"project"` or `"both"` only for trusted repositories. |
| `confirmProjectAgents` | All | Defaults to `true` and prompts when project-local agents are selected and UI is available. |
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
model: claude-sonnet-4-5
---

System prompt for the agent goes here.
```

- `name` and `description` are required.
- `tools` is optional; omit it to use Pi's default active tools.
- `model` is optional; omit it to use the current/default Pi model.

## Bundled agents

| Agent | Purpose | Tools |
| --- | --- | --- |
| `scout` | Fast codebase reconnaissance and compressed context handoff. | `read`, `grep`, `find`, `ls`, `bash` |
| `planner` | Read-only implementation planning. | `read`, `grep`, `find`, `ls` |
| `reviewer` | Read-only code quality and security review. | `read`, `grep`, `find`, `ls`, `bash` |
| `worker` | General-purpose implementation in an isolated context. | Pi defaults |

## Workflow prompt templates

| Prompt | Flow |
| --- | --- |
| `/implement <request>` | `scout` → `planner` → `worker` |
| `/scout-and-plan <request>` | `scout` → `planner` |
| `/implement-and-review <request>` | `worker` → `reviewer` → `worker` |

## Output and rendering

The tool streams partial progress with structured `details` for each subagent result. In interactive mode it renders compact status by default and an expanded view with task text, formatted tool calls, Markdown output, model, token usage, cost, and per-step totals.

Collapsed views use Pi's configured `app.tools.expand` keybinding hint (Ctrl+O by default) instead of hard-coding a shortcut.

LLM-facing tool content is truncated from the tail at Pi's default limits (2,000 lines / 50KB) to protect the parent context. Full subagent messages remain in `details` for expanded rendering and follow-up analysis.

## Security notes

Project-local agents are repository-controlled prompts. Only use `agentScope: "project"` or `"both"` in repositories you trust. When UI is available, the extension asks for confirmation before running project-local agents unless `confirmProjectAgents: false` is set.

## Error handling

- Invalid tool arguments return a clear error message.
- Unknown agents include the available agent list.
- Non-zero subprocess exits, `stopReason: "error"`, and `stopReason: "aborted"` are treated as failed subagent runs.
- Failed subagent runs are marked as Pi tool errors via the `tool_result` hook while preserving structured `details` for rendering and follow-up analysis.
- Chains stop at the first failed step and return completed step details.
- Aborts propagate to the active subprocess and escalate from `SIGTERM` to `SIGKILL` after 5 seconds.
