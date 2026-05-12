# pi-sub-agent

A Pi package extension that adds a `subagent` tool for delegating work to specialized Pi subprocesses with isolated context windows.

## Highlights

- Runs each delegated task in a separate `pi --mode json -p --no-session` subprocess.
- Supports **single**, **parallel**, and **chain** workflows.
- Bundles default `scout`, `planner`, `reviewer`, and `worker` agents.
- Discovers user agents from `~/.pi/agent/agents/*.md` and optional project agents from `.pi/agents/*.md`.
- Streams progress, usage, tool-call summaries, final Markdown output, and structured result details.
- Truncates LLM-facing tool output to Pi's default tool limits (2,000 lines / 50KB) while preserving full structured details for rendering.
- Prompts before running project-local agents in interactive/RPC UI sessions.
- Includes prompt templates: `/implement`, `/scout-and-plan`, and `/implement-and-review`.

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

Parallel mode is limited to 8 tasks total, with up to 4 running at once.

`cwd` overrides on single, parallel, or chain tasks are resolved relative to the parent Pi working directory. A leading `@` is accepted and stripped, matching Pi file-reference conventions.

## Agent files

Agents are Markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

Discovery order is bundled extension agents first, then user agents, then project agents. Later sources override earlier agents with the same `name`.

| Scope | Loaded agents |
| --- | --- |
| `user` (default) | bundled + `~/.pi/agent/agents/*.md` |
| `project` | bundled + nearest `.pi/agents/*.md` |
| `both` | bundled + user + nearest project agents |

## Security model

Project-local agents are repository-controlled prompts. They can choose tools and can instruct a subagent to read files, run shell commands, or edit code. Keep `agentScope` at the default `"user"` unless you trust the repository. When UI is available, the extension confirms before running project-local agents unless `confirmProjectAgents: false` is set.

## Output limits

The text returned to the main model is truncated from the tail at Pi's default tool-output limits: 2,000 lines or 50KB, whichever is hit first. Full subagent messages remain in structured `details` so interactive rendering can still show complete expanded output without flooding the model context.

## Error handling

- Invalid requests return clear guidance and keep structured result details available to the main agent.
- Non-zero subprocess exits, `stopReason: "error"`, and `stopReason: "aborted"` are treated as failed subagent runs.
- Failed subagent runs are marked as Pi tool errors without dropping streamed output or per-agent details.
- Chain mode stops at the first failed step; parallel mode reports per-task success and failure counts.

## Development

```bash
npm test
npm run typecheck
npm run lint
npm run check
```

Key files:

- `extensions/index.ts` — Pi extension and `subagent` tool implementation.
- `extensions/agents.ts` — agent discovery and frontmatter loading.
- `extensions/agents/*.md` — bundled default agents.
- `extensions/prompts/*.md` — workflow prompt templates.
- `tests/subagent.test.ts` — regression tests for discovery, Pi tool conventions, and package metadata.
