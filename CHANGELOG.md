# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

## v0.1.5

### Fixed

- Expanded parallel subagent LLM-facing results from 120-character previews to one independently truncated output section per subagent, so parent agents can use parallel delegation without rerunning tasks serially.

## v0.1.4

### Fixed

- Limited the `/sub-agent-settings` model selector to models with configured auth, matching Pi's available-model behavior.

## v0.1.3

### Changed

- Allowed top-level `cwd` defaults for parallel and chain sub-agent calls, with per-task or per-step `cwd` still taking precedence.
- Clarified model-facing `subagent` argument guidance for single, parallel, and chain modes, including shared `cwd` behavior.

## v0.1.2

### Changed

- Listed bundled sub-agent names directly in the model-facing `subagent` tool description and `agent` parameter descriptions so agents can select canonical names without guessing.
- Added model-facing routing guidance for choosing bundled sub-agents by task type.

## v0.1.1

### Chores

- Reissued the initial package release under a new npm version because `pi-sub-agent@0.1.0` was previously unpublished from npm and cannot be reused.
- Updated package metadata to `0.1.1` for npm publication.

## v0.1.0

### Added

- Created the initial `pi-sub-agent` package with MIT license, README, `package.json`, `package-lock.json`, TypeScript configuration, ESLint configuration, and npm verification scripts.
- Added the Pi extension entry point and registered a `subagent` tool for delegating work to isolated `pi` subprocesses.
- Added support for single-agent, parallel, and chained subagent modes, including `{previous}` handoff support for chains.
- Added streaming progress updates, structured result details, usage tracking, abort handling, subprocess error handling, and temporary prompt-file cleanup.
- Added agent discovery for bundled extension agents, user agents from `~/.pi/agent/agents`, and optional project agents from `.pi/agents`.
- Added safety confirmation for project-local agents when running with UI support.
- Bundled default agents: `scout`, `planner`, `worker`, `reviewer`, `debugger`, `verifier`, `security-auditor`, `docs-writer`, and `refactorer`.
- Added extension documentation covering usage, security model, output display, agent definitions, error handling, and limitations.
- Added the `/sub-agent-settings` slash command for viewing and editing sub-agent model and thinking-effort settings.
- Added optional `thinking` frontmatter support for sub-agent definitions, with `inherit` behavior for parent-session model and thinking settings.

### Fixed

- Corrected the package author metadata and MIT license copyright holder to `Maz Li`.
- Preserved all text parts from final subagent assistant messages instead of dropping earlier text blocks.
- Cleared chained `{previous}` handoffs when a prior subagent step returns empty output, including final empty assistant messages after earlier progress text, instead of reusing stale output.
- Treated `stopReason: "error"` and `stopReason: "aborted"` as failed results in parallel summaries and in parallel/chain renderers, matching single-agent error handling.
- Marked failed subagent runs as Pi tool errors through the `tool_result` hook while preserving structured result details.
- Added an explicit `confirmProjectAgents: true` schema default so model-facing tool metadata matches the documented security behavior.
- Sent delegated task prompts to child Pi processes over stdin instead of process arguments to reduce prompt exposure and avoid argument-length failures in large handoffs.
- Blocked project-local agents in non-interactive runs unless `confirmProjectAgents: false` is explicitly set.
- Truncated LLM-facing subagent output with Pi's default tool limits, saved complete truncated output to private temp files, and preserved full structured result details for rendering and follow-up analysis.
- Resolved subagent `cwd` overrides relative to the parent Pi working directory and accepted leading `@` path prefixes.
- Fixed abort escalation for subagent subprocesses that ignore `SIGTERM` by tracking process close state before sending `SIGKILL`.
- Replaced hard-coded expand shortcut text in subagent renderers with Pi keybinding-aware hints.
- Prevented subagents from bypassing parent Pi tool restrictions by inheriting the parent active tool allowlist and intersecting it with agent-level `tools` settings.
- Loaded agent frontmatter defensively, including YAML-list `tools`, while skipping malformed agent definitions instead of throwing.
- Removed provider-specific model pins from bundled agents so subagents inherit the active parent Pi model and thinking level unless a custom agent explicitly sets `model`.
- Parsed legacy `model: provider/model-id:thinking` agent frontmatter into separate model and thinking settings for backwards compatibility.
- Preserved explicit `thinking: off` sub-agent settings when launching child Pi processes so agents can disable inherited reasoning effort.
- Reduced the bundled `scout` agent to read-only search tools by removing `bash` from its default allowlist.
- Tightened bundled `reviewer` and `security-auditor` to read-only search tools, while `debugger` and `verifier` retain `bash` for diagnostics and verification commands.
- Surfaced single-agent failure details by combining assistant output, subprocess `stderr`, model error messages, stop reasons, exit codes, and unknown-agent guidance in LLM-facing tool output instead of returning a generic failure message.
- Reported subprocess launch failures with the attempted command and OS error so missing `pi` executables or wrapper misconfiguration are actionable.
- Surfaced subprocess stderr/error diagnostics in compact and expanded interactive subagent renderers when failed runs produce no assistant output.
- Kept single-agent failure diagnostic sections distinct even when their text overlaps with assistant output.
- Surfaced full chain-step failure diagnostics, including stop reasons without assistant output, instead of returning a generic `(no output)` summary.
- Skipped agent files with malformed YAML frontmatter so one bad user or project agent definition cannot break subagent discovery.
- Prevented recursive subagent fan-out by removing the `subagent` tool from child allowlists, passing depth state to child Pi processes, and blocking nested subagent invocations before spawning another process.
- Surfaced stop-reason and subprocess diagnostics in LLM-facing parallel summaries when a subagent task fails without assistant output.
- Made `/sub-agent-settings` follow Pi non-interactive mode conventions by warning and exiting when no interactive UI is available.
- Treated child Pi processes that emit only malformed non-JSON stdout as failed subagent runs and surfaced the stdout diagnostic instead of silently returning `(no output)`.
- Preserved parent-session thinking effort when an agent sets a custom `model` but leaves `thinking` unset.
- Trimmed quoted string frontmatter values for agent `name`, `description`, and `model` fields before registration.
- Marked pre-spawn subagent failures, including invalid mode arguments, nested invocations, project-agent confirmation blocks, and task-limit violations, as Pi tool errors while preserving structured details.
- Avoided duplicating identical model error messages in LLM-facing failure diagnostics when the same text is already present in child process stderr or stdout.
- Treated child Pi subprocesses terminated by an external signal as failed subagent runs and surfaced the signal name in diagnostics instead of reporting a successful empty result.
- Treated child assistant `stopReason: "length"` responses as failed incomplete subagent runs so truncated model outputs do not pass as successful handoffs.
- Rejected partial or mixed subagent mode arguments before spawning child Pi processes, including top-level `cwd` on parallel or chain requests.
- Fixed compact path rendering so paths that merely share the home-directory prefix, such as `/home/user-other`, are not incorrectly abbreviated as `~` paths.
- Rejected invalid subagent `cwd` overrides before spawning child Pi processes and surfaced the resolved path in diagnostics so missing directories are not confused with missing `pi` executables.

### Chores

- Added ignore rules for generated and local-only files, including `node_modules/`, `dist/`, `coverage/`, logs, environment files, and `.pi/`.
- Added an automated `npm test` suite for agent discovery precedence, Pi tool registration conventions, package release metadata, and streaming update state.
- Expanded TypeScript checking to cover the test suite.
- Added custom `subagent` prompt snippets, prompt guidelines, and interactive tool renderers for compact/expanded subagent output.
- Fixed streaming update snapshots so active subprocesses stay marked as running until their final exit code is known.
- Fixed parallel streaming update snapshots so previously emitted progress details cannot be mutated by later subprocess completions.
- Switched `agentScope` to a Google-compatible `StringEnum` schema and declared Pi runtime imports as peer dependencies.
- Included `CHANGELOG.md` in the published package files and documented release-ready installation, usage, security, and development commands.
- Declared the explicit extension entrypoint in the Pi package manifest so Pi can discover the public extension without treating helper modules as extensions.
- Removed bundled workflow prompt templates so the package does not create slash commands.
- Cleaned up agent loader formatting while keeping discovery behavior unchanged.
- Added regression coverage for abort escalation, keybinding-aware renderer hints, YAML-list agent tools, trimmed agent frontmatter strings, bundled specialist-agent coverage/tool policy, parent-model/tool inheritance, recursive-subagent blocking, invalid `cwd` diagnostics, absence of bundled slash-command resources, final assistant text aggregation, empty/final-empty chain handoffs, single-agent/parallel/chain failure output, subprocess launch diagnostics, private full-output temp files for truncated content, and explicit package entrypoint metadata.
- Isolated parent-model inheritance, single-agent failure-output, and unknown-agent tests from developer-local Pi agent directories.
- Tightened the `subagent` tool schema with non-empty string constraints, parallel task item limits, and an 8-step chain limit for clearer model-facing metadata and bounded subprocess usage.
- Expanded public and extension documentation with requirements, parameter references, rendering behavior, abort semantics, agent model/thinking inheritance, parent tool allowlist inheritance, YAML-list tool frontmatter, stdin prompt delivery, non-interactive project-agent confirmation behavior, and `/sub-agent-settings` usage.
- Added public and extension documentation for subagent delegation best practices, including task scoping, mode selection, chained handoff guidance, and project-agent trust boundaries.
- Documented malformed-agent skipping, recursive-subagent blocking, parent-tool allowlist behavior for Pi's read-only search tools, independent model/thinking inheritance, and clarified that child subagent processes still follow Pi's standard package/extension security model for their selected working directory.
- Added public npm metadata for repository, issue tracker, homepage, and the Pi-aligned Node.js engine requirement.
- Added a `prepublishOnly` guard that runs the full verification suite before `npm publish`.
- Documented public-release readiness checks, explicit Pi package manifest behavior, peer dependency conventions, and expected npm tarball contents.
- Added an explicit release verification checklist to the public README covering tests, linting, type checking, the aggregate check script, production dependency audit, and npm tarball dry-run review.
- Added public and extension documentation for installed-package smoke testing before publishing, including settings UI, delegated scout runs, and project-agent trust checks.
- Documented that invalid partial or mixed subagent mode arguments are rejected before child Pi processes are spawned.
- Performed a public-release readiness review against Pi extension/package conventions and verified the documented test, lint, typecheck, production audit, and npm tarball dry-run checks.
