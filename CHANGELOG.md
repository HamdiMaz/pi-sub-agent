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

- Corrected the package author metadata to `Maz Li`.

### Chores

- Added ignore rules for generated and local-only files, including `node_modules/`, `dist/`, `coverage/`, logs, environment files, and `.pi/`.
- Added an automated `npm test` suite for agent discovery precedence, Pi tool registration conventions, package release metadata, and streaming update state.
- Expanded TypeScript checking to cover the test suite.
- Added custom `subagent` prompt snippets, prompt guidelines, and interactive tool renderers for compact/expanded subagent output.
- Fixed streaming update snapshots so active subprocesses stay marked as running until their final exit code is known.
- Switched `agentScope` to a Google-compatible `StringEnum` schema and declared Pi runtime imports as peer dependencies.
- Included `CHANGELOG.md` in the published package files and documented release-ready installation, usage, security, and development workflows.
