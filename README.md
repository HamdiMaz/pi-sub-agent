# pi-sub-agent

A Pi package extension that adds a **subagent** tool for delegating work to specialized agents.

## What it does

- Discovers agents from:
  - the extension-local `extensions/agents/*.md` files bundled with this repo (defaults)
  - `~/.pi/agent/agents/*.md` (`agentScope: "user"`)
  - project agents from `./.pi/agents/*.md` (`agentScope: "project"` or `"both"`)
- Supports single task, parallel, and chain execution modes.
- Streams progress while subagents run.
- Returns structured tool details for Pi results.

## Files

- `extensions/index.ts` — tool implementation
- `extensions/agents.ts` — agent discovery and loading
- `extensions/agents/*.md` — bundled default agents (`scout`, `planner`, `reviewer`, `worker`)
- `extensions/prompts/*.md` — command prompts (`/implement`, `/scout-and-plan`, `/implement-and-review`)

## Scripts

- `npm run typecheck` — TypeScript check
- `npm run lint` — ESLint check
- `npm run check` — both of the above

## Local use

Install dependencies:

```bash
npm install
npm run check
```

Load this extension while testing:

```bash
pi -e ./extensions/index.ts
```

Install as a local package:

```bash
pi install ./ -l
```

## Example usage

Single task:

```text
Use scout to locate all authentication code in this repo
```

Chain workflow:

```json
{ "chain": [
  { "agent": "scout", "task": "Find all auth-related files" },
  { "agent": "planner", "task": "Propose an implementation plan for OAuth support" },
  { "agent": "worker", "task": "Apply requested auth changes" }
] }
```

Parallel workflow:

```json
{ "tasks": [
  { "agent": "scout", "task": "Review database models" },
  { "agent": "planner", "task": "Review CLI entry points" }
] }
```
