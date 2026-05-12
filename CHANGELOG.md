# Changelog

All notable changes to this project will be documented in this file.

## v0.1.0

### Added

- Created the initial `pi-sub-agent` package with MIT license, README, `package.json`, `package-lock.json`, TypeScript configuration, ESLint configuration, and npm verification scripts.
- Added the Pi extension entry point and registered a `subagent` tool for delegating work to isolated `pi` subprocesses.
- Added support for single-agent, parallel, and chained subagent workflows, including `{previous}` handoff support for chains.
- Added streaming progress updates, structured result details, usage tracking, abort handling, subprocess error handling, and temporary prompt-file cleanup.
- Added agent discovery for bundled extension agents, user agents from `~/.pi/agent/agents`, and optional project agents from `.pi/agents`.
- Added safety confirmation for project-local agents when running with UI support.
- Bundled default agents: `scout`, `planner`, `reviewer`, and `worker`.
- Added workflow prompt templates: `/implement`, `/scout-and-plan`, and `/implement-and-review`.
- Added extension documentation covering usage, security model, output display, agent definitions, workflow prompts, error handling, and limitations.

### Fixed

- Corrected the package author metadata and MIT license copyright holder to `Maz Li`.
- Preserved all text parts from final subagent assistant messages instead of dropping earlier text blocks.
- Cleared chained `{previous}` handoffs when a prior subagent step returns empty output, including final empty assistant messages after earlier progress text, instead of reusing stale output.
- Treated `stopReason: "error"` and `stopReason: "aborted"` as failed results in parallel summaries and in parallel/chain renderers, matching single-agent error handling.
- Marked failed subagent runs as Pi tool errors through the `tool_result` hook while preserving structured result details.
- Added an explicit `confirmProjectAgents: true` schema default so model-facing tool metadata matches the documented security behavior.
- Sent delegated task prompts to child Pi processes over stdin instead of process arguments to reduce prompt exposure and avoid argument-length failures in large handoffs.
- Blocked project-local agents in non-interactive runs unless `confirmProjectAgents: false` is explicitly set.
- Truncated LLM-facing subagent output with Pi's default tool limits while preserving full structured result details for rendering and follow-up analysis.
- Resolved subagent `cwd` overrides relative to the parent Pi working directory and accepted leading `@` path prefixes.
- Fixed abort escalation for subagent subprocesses that ignore `SIGTERM` by tracking process close state before sending `SIGKILL`.
- Replaced hard-coded expand shortcut text in subagent renderers with Pi keybinding-aware hints.
- Loaded agent frontmatter defensively, including YAML-list `tools`, while skipping malformed agent definitions instead of throwing.
- Removed provider-specific model pins from bundled agents so subagents inherit the active parent Pi model and thinking level unless a custom agent explicitly sets `model`.
- Reduced the bundled `scout` agent to read-only search tools by removing `bash` from its default allowlist.
- Surfaced single-agent failure details by combining assistant output, subprocess `stderr`, model error messages, stop reasons, exit codes, and unknown-agent guidance in LLM-facing tool output instead of returning a generic failure message.
- Kept single-agent failure diagnostic sections distinct even when their text overlaps with assistant output.

### Chores

- Added ignore rules for generated and local-only files, including `node_modules/`, `dist/`, `coverage/`, logs, environment files, and `.pi/`.
- Added an automated `npm test` suite for agent discovery precedence, Pi tool registration conventions, package release metadata, and streaming update state.
- Expanded TypeScript checking to cover the test suite.
- Added custom `subagent` prompt snippets, prompt guidelines, and interactive tool renderers for compact/expanded subagent output.
- Fixed streaming update snapshots so active subprocesses stay marked as running until their final exit code is known.
- Switched `agentScope` to a Google-compatible `StringEnum` schema and declared Pi runtime imports as peer dependencies.
- Included `CHANGELOG.md` in the published package files and documented release-ready installation, usage, security, and development workflows.
- Declared the explicit extension entrypoint and bundled workflow prompts in the Pi package manifest so Pi can discover package resources without treating helper modules as extensions.
- Added `argument-hint` metadata to bundled workflow prompt templates for clearer slash-command autocomplete.
- Cleaned up agent loader formatting while keeping discovery behavior unchanged.
- Added regression coverage for abort escalation, keybinding-aware renderer hints, YAML-list agent tools, parent-model inheritance, prompt autocomplete metadata, final assistant text aggregation, empty/final-empty chain handoffs, single-agent failure output, and explicit package entrypoint metadata.
- Isolated parent-model inheritance, single-agent failure-output, and unknown-agent tests from developer-local Pi agent directories.
- Tightened the `subagent` tool schema with non-empty string constraints and parallel task item limits for clearer model-facing metadata.
- Expanded public and extension documentation with requirements, parameter references, rendering behavior, abort semantics, agent model/thinking inheritance, YAML-list tool frontmatter, prompt autocomplete behavior, stdin prompt delivery, and non-interactive project-agent confirmation behavior.
- Added public npm metadata for repository, issue tracker, homepage, and the Pi-aligned Node.js engine requirement.
