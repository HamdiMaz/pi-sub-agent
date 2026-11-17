# Subagent Extension

This directory contains the Pi extension entry point and bundled agents for `pi-sub-agent`.

## What the extension registers

- A `subagent` tool for delegating work to isolated Pi subprocesses.
- One bundled general-purpose agent from `extensions/agents/`.
- A `/sub-agent-settings` slash command for configuring the subagent model and thinking effort.
- No prompt templates, skills, or themes.

The npm package uses an explicit `package.json` Pi manifest (`pi.extensions: ["./extensions/index.ts"]`) so Pi loads this entry point only. Helper modules such as `agents.ts` are imported by the entry point and are not treated as standalone extensions.

## Tool modes

| Mode | Parameters | Behavior |
| --- | --- | --- |
| Single | `{ task, agent? }` | Runs one agent for one task. `agent` defaults to `subagent`. |
| Parallel | `{ tasks: [...] }` | Runs up to 8 tasks, with 4 subprocesses at a time. |
| Chain | `{ chain: [...] }` | Runs up to 8 steps sequentially; `{previous}` is replaced with prior output. |

Each subagent runs `pi --mode json -p --no-session` with the selected agent's system prompt, working directory, and either the agent's explicit `model` or the active parent Pi model plus thinking level. Tool access is capped by the parent Pi session's active tool allowlist; agent-level `tools` entries can narrow that list and cannot re-enable disabled write, edit, or shell tools. The read-only tools `read`, `grep`, `find`, and `ls` are the exception: a subagent may use them even when the parent session has them disabled. The `subagent` tool itself is removed from child allowlists, and child processes receive depth tracking so nested subagent calls are blocked before spawning again. The delegated task prompt is sent over stdin instead of being exposed in child process arguments.

### Parameter reference

| Field | Applies to | Notes |
| --- | --- | --- |
| `agent` + `task` | Single | Run one named agent with one task. `agent` is optional. |
| `tasks` | Parallel | Array of `{ task, agent?, cwd? }`; maximum 8 tasks and 4 concurrent subprocesses. |
| `chain` | Chain | Array of `{ task, agent?, cwd? }`, maximum 8; `{previous}` is replaced with prior output. |
| `agentScope` | All | `"user"` by default; use `"project"` or `"both"` only for trusted repositories. |
| `readOnly` | All | Defaults to `false`. `true` gives the child only `read`, `grep`, `find`, and `ls`. |
| `projectContext` | All | Defaults to `false`. `true` loads project `AGENTS.md` and `CLAUDE.md` files into the child. |
| `skills` | All | Defaults to `false`. `true` loads discovered and configured skills into the child. |
| `confirmProjectAgents` | All | Defaults to `true`; prompts when UI is available and blocks project-local agents in non-interactive runs unless explicitly set to `false`. |
| `cwd` | All | Default working directory override for every subprocess in the call; per-task or per-step `cwd` overrides it. |

`cwd` overrides on single calls, top-level parallel/chain calls, or individual parallel/chain tasks are resolved relative to the parent Pi working directory. A leading `@` is stripped so file-reference-style paths such as `@packages/app` work as expected.

Child runs use `--no-context-files` and `--no-skills` unless the call sets `projectContext: true` or `skills: true`. Each run stops after 60 assistant turns and returns `stopReason: "turn_limit"`, so one task cannot become a very long and expensive run.

## Delegation best practices

- Write the role into the task text: the goal, constraints, expected output, and known file paths. Add "review only, do not modify files" when the task must not change code.
- Keep task text short. Put a long brief in a file and pass the path.
- Tell the subagent to batch independent tool calls per turn and to combine related shell commands into one `bash` call.
- Use parallel mode only for independent tasks; use chain mode only when a later step genuinely needs `{previous}` from the prior step.
- Keep chained outputs compact because only the prior final text is inserted into the next task. Full messages remain in structured `details` for rendering and follow-up analysis.
- Keep `agentScope` at `"user"` unless you have reviewed and trust project-local agents.

## Agent discovery

Bundled agents are always available; by default the bundle contains only `subagent`. `agentScope` controls additional locations:

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
- `tools` is optional and can be a comma-separated string or YAML list. Omit it to inherit the parent Pi session's active tools; specify it to narrow those tools for that agent. The `subagent` tool is always removed from the child allowlist to avoid recursive delegation. Agent tool lists cannot enable disabled write, edit, or shell tools, but the read-only tools `read`, `grep`, `find`, and `ls` are always allowed. A call with `readOnly: true` overrides the list with those four tools.
- Project context files are skipped by default. Set `projectContext: true` on the call to load them.
- Skills are skipped by default. Set `skills: true` on the call to load them.
- `model` and `thinking` are optional and inherit independently. An agent with a custom `model` but no `thinking` still uses the parent Pi session's thinking level. Set `thinking: off` to explicitly disable inherited reasoning effort for that sub-agent. Legacy `model: provider/model-id:high` values are parsed as a model plus thinking setting.
- Agent files with unreadable content, missing required metadata, invalid metadata types, or malformed YAML frontmatter are skipped.

## Bundled agent

| Agent | Purpose | Tools |
| --- | --- | --- |
| `subagent` | General-purpose work in an isolated context. The task text selects the role: discover, implement, review, or verify. | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |

`subagent` is the default when a call omits `agent`. It pins no model and no thinking level, so the parent session and `/sub-agent-settings` decide both. Its prompt asks for 2 to 4 independent tool calls per turn, combined shell commands, and no commentary-only turns.

## Slash command

Use `/sub-agent-settings` to open an interactive settings window for the bundled and user-defined sub-agents in the default `user` scope. With the default configuration the window has one row. The command requires UI support; in print/JSON modes it shows a warning and does not attempt to open the settings window. The list displays each agent as `name  model • thinking`; `inherit` means the sub-agent uses the parent Pi session value. Changing a bundled agent writes a same-named user override under `~/.pi/agent/agents/` instead of editing package files.

## Output and rendering

The tool streams partial progress with structured `details` for each subagent result. In interactive mode it renders compact status by default and an expanded view with task text, formatted tool calls, Markdown output, subprocess failure diagnostics, model, token usage, cost, and per-step totals.

Collapsed views use Pi's configured `app.tools.expand` keybinding hint (Ctrl+O by default) instead of hard-coding a shortcut.

LLM-facing tool content is truncated from the tail per included subagent output at Pi's default limits (2,000 lines / 50KB). Parallel mode returns one bounded section per subagent rather than a shared 50KB budget, so every parallel task remains visible to the parent agent. When truncation occurs, the affected section includes a `Full output saved to:` temp-file path with `0600` permissions so the main agent can inspect the complete text if needed. Full subagent messages remain in `details` for expanded rendering and follow-up analysis.

## Security notes

Project-local agents are repository-controlled prompts. Only use `agentScope: "project"` or `"both"` in repositories you trust. Agent tool lists are still capped by the parent session's active tools, except for the read-only `read`, `grep`, `find`, and `ls` tools. Enabled tools can still read, run commands, or edit files under the agent prompt's direction. With the default `confirmProjectAgents: true`, the extension asks for confirmation before running project-local agents when UI is available and cancels in non-interactive runs, including when a call omits `agent` and a project agent overrides the default name. Set `confirmProjectAgents: false` only after reviewing and trusting the project agents.

Subagents run as normal child `pi` invocations in the selected `cwd`, so Pi packages/extensions enabled for that working directory still use Pi's standard package security model. Install only trusted Pi packages and avoid `cwd` overrides into repositories whose Pi configuration you have not reviewed.

Recursive delegation is intentionally blocked. The parent process sets `PI_SUB_AGENT_DEPTH=1` for child Pi invocations; if a child session somehow invokes `subagent`, the extension returns an error before spawning another process.

Delegated task text is passed to the child Pi process over stdin rather than as an argv value, reducing process-list exposure and avoiding OS argument-length failures for large chained handoffs.

## Release smoke test

Before publishing, install the packed package in a scratch project and verify the runtime path, not just the checkout:

1. Confirm Pi startup lists the installed `pi-sub-agent` extension.
2. Open `/sub-agent-settings` and verify the bundled agent renders in the settings UI.
3. Delegate a small read-only task to `subagent` in a disposable repository and confirm progress, final Markdown output, and structured details render correctly.
4. Keep project-local agents disabled unless their `.pi/agents/*.md` prompts have been reviewed and the confirmation flow is intentionally accepted.

## Error handling

- Invalid tool arguments return a clear error message; partial or mixed mode arguments and invalid `cwd` overrides are rejected before spawning child Pi processes.
- Invalid `cwd` diagnostics include the resolved path so missing directories are not confused with missing `pi` executables.
- Unknown agents include the available agent list and a "Did you mean" suggestion when a close name exists.
- Non-zero subprocess exits, `stopReason: "error"`, `stopReason: "aborted"`, `stopReason: "length"`, and `stopReason: "turn_limit"` are treated as failed subagent runs.
- A run that reaches 60 assistant turns stops with a `turn_limit` failure and a message to split the task.
- Subprocess launch failures include the attempted command and OS error so missing `pi` executables or wrapper misconfiguration are actionable.
- Malformed child stdout in JSON mode is captured in structured diagnostics; if the child produces no JSON messages, the run fails instead of silently returning `(no output)`.
- Failed subagent runs and pre-spawn failures (invalid arguments, nested calls, project-agent confirmation blocks, or task-limit violations) are marked as Pi tool errors via the `tool_result` hook while preserving structured `details` and stderr/stdout/error diagnostics for rendering and follow-up analysis.
- Project-local agents are blocked without UI confirmation unless `confirmProjectAgents: false` is explicitly set.
- Nested `subagent` calls are blocked before spawning another Pi process.
- Chains are capped at 8 steps, stop at the first failed step, and return diagnostic output plus completed step details.
- Parallel runs return per-task success/failure counts and include failure diagnostics for tasks that exit non-zero or stop with model errors.
- Aborts propagate to the active subprocess and escalate from `SIGTERM` to `SIGKILL` after 5 seconds.
- Child Pi processes terminated by an external signal are treated as failed runs and include the signal name in diagnostics.
