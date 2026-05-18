import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import setupExtension from "../extensions/index.ts";
import {
	discoverAgents,
	formatModelWithThinking,
	resolveAgentModel,
	updateAgentSettingsContent,
} from "../extensions/agents.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "pi-sub-agent-test-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function withIsolatedPiAgentDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(dir, "config");
	try {
		return await fn();
	} finally {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
	}
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeAgent(dir: string, fileName: string, frontmatter: Record<string, string>, body: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	const header = Object.entries(frontmatter)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n");
	await writeFile(join(dir, fileName), `---\n${header}\n---\n\n${body}\n`, "utf8");
}

test("discovers extension, user, and nearest project agents with documented precedence", async () => {
	await withTempDir(async (dir) => {
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(dir, "config");
		try {
			const extensionAgentsDir = join(dir, "extension-agents");
			const userAgentsDir = join(process.env.PI_CODING_AGENT_DIR, "agents");
			const projectRoot = join(dir, "project");
			const nestedCwd = join(projectRoot, "packages", "app");
			const projectAgentsDir = join(projectRoot, ".pi", "agents");

			await mkdir(nestedCwd, { recursive: true });
			await writeAgent(extensionAgentsDir, "scout.md", {
				name: "scout",
				description: "Bundled scout",
				tools: "read, grep",
			}, "Bundled prompt");
			await writeAgent(extensionAgentsDir, "worker.md", {
				name: "worker",
				description: "Bundled worker",
			}, "Worker prompt");
			await writeAgent(userAgentsDir, "scout.md", {
				name: "scout",
				description: "User scout",
				model: "claude-haiku-4-5",
			}, "User prompt");
			await writeAgent(userAgentsDir, "reviewer.md", {
				name: "reviewer",
				description: "User reviewer",
			}, "Reviewer prompt");
			await writeAgent(projectAgentsDir, "scout.md", {
				name: "scout",
				description: "Project scout",
			}, "Project prompt");
			await writeAgent(projectAgentsDir, "planner.md", {
				name: "planner",
				description: "Project planner",
			}, "Planner prompt");

			const both = discoverAgents(nestedCwd, "both", extensionAgentsDir);
			assert.equal(both.projectAgentsDir, projectAgentsDir);
			assert.deepEqual(
				both.agents.map((agent) => [agent.name, agent.source, agent.description]),
				[
					["scout", "project", "Project scout"],
					["worker", "extension", "Bundled worker"],
					["reviewer", "user", "User reviewer"],
					["planner", "project", "Project planner"],
				],
			);

			const userOnly = discoverAgents(nestedCwd, "user", extensionAgentsDir);
			assert.deepEqual(
				userOnly.agents.map((agent) => [agent.name, agent.source]),
				[
					["scout", "user"],
					["worker", "extension"],
					["reviewer", "user"],
				],
			);

			const projectOnly = discoverAgents(nestedCwd, "project", extensionAgentsDir);
			assert.deepEqual(
				projectOnly.agents.map((agent) => [agent.name, agent.source]),
				[
					["scout", "project"],
					["worker", "extension"],
					["planner", "project"],
				],
			);
		} finally {
			if (originalAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			}
		}
	});
});

test("discovers agent model thinking suffixes and explicit thinking frontmatter", async () => {
	await withTempDir(async (dir) => {
		const extensionAgentsDir = join(dir, "extension-agents");
		await writeAgent(extensionAgentsDir, "legacy.md", {
			name: "legacy",
			description: "Legacy model suffix",
			model: "openai/gpt-5:high",
		}, "Prompt body");
		await writeAgent(extensionAgentsDir, "explicit.md", {
			name: "explicit",
			description: "Explicit thinking wins",
			model: "openai/gpt-5:high",
			thinking: "low",
		}, "Prompt body");

		const discovery = discoverAgents(dir, "project", extensionAgentsDir);
		assert.deepEqual(
			discovery.agents.map((agent) => [agent.name, agent.model, agent.thinking]).sort(([a], [b]) => String(a).localeCompare(String(b))),
			[
				["explicit", "openai/gpt-5", "low"],
				["legacy", "openai/gpt-5", "high"],
			],
		);
	});
});

test("formats and resolves subagent model thinking overrides", () => {
	assert.equal(formatModelWithThinking("openai/gpt-5", "high"), "openai/gpt-5:high");
	assert.equal(formatModelWithThinking("openai/gpt-5", "off"), "openai/gpt-5:off");
	assert.equal(formatModelWithThinking(undefined, "high"), undefined);

	assert.equal(
		resolveAgentModel({ model: "openai/gpt-5", thinking: "low" }, "anthropic/claude-sonnet-4-5:high"),
		"openai/gpt-5:low",
	);
	assert.equal(
		resolveAgentModel({ model: "openai/gpt-5" }, "anthropic/claude-sonnet-4-5:high"),
		"openai/gpt-5:high",
	);
	assert.equal(
		resolveAgentModel({ thinking: "medium" }, "openai/gpt-5:high"),
		"openai/gpt-5:medium",
	);
	assert.equal(
		resolveAgentModel({ thinking: "off" }, "openai/gpt-5:high"),
		"openai/gpt-5:off",
	);
	assert.equal(
		resolveAgentModel({}, "openai/gpt-5:high"),
		"openai/gpt-5:high",
	);
});

test("updates agent settings frontmatter without changing the prompt body", () => {
	const content = `---\nname: reviewer\ndescription: Review code\ntools: read, grep\n---\n\nPrompt body\n`;
	const updated = updateAgentSettingsContent(content, { model: "openai/gpt-5", thinking: "high" });
	assert.match(updated, /^---\n/);
	assert.match(updated, /\nmodel: openai\/gpt-5\n/);
	assert.match(updated, /\nthinking: high\n/);
	assert.match(updated, /\ntools: read, grep\n/);
	assert.match(updated, /\n---\n\nPrompt body\n$/);

	const cleared = updateAgentSettingsContent(updated, { model: null, thinking: null });
	assert.doesNotMatch(cleared, /\nmodel:/);
	assert.doesNotMatch(cleared, /\nthinking:/);
	assert.match(cleared, /\n---\n\nPrompt body\n$/);
});

test("discovers agents with YAML list tools and skips invalid or malformed frontmatter without throwing", async () => {
	await withTempDir(async (dir) => {
		const extensionAgentsDir = join(dir, "extension-agents");
		await mkdir(extensionAgentsDir, { recursive: true });
		await writeFile(
			join(extensionAgentsDir, "list-tools.md"),
			`---\nname: list-tools\ndescription: Uses YAML list tools\ntools:\n  - read\n  - grep\n---\n\nPrompt body\n`,
			"utf8",
		);
		await writeFile(
			join(extensionAgentsDir, "invalid.md"),
			`---\nname: invalid\ndescription:\n  nested: value\ntools:\n  - read\n---\n\nInvalid metadata should be ignored\n`,
			"utf8",
		);
		await writeFile(
			join(extensionAgentsDir, "malformed.md"),
			`---\nname: malformed\ndescription: [unterminated\n---\n\nMalformed YAML should be ignored\n`,
			"utf8",
		);

		const discovery = discoverAgents(dir, "project", extensionAgentsDir);
		assert.deepEqual(
			discovery.agents.map((agent) => [agent.name, agent.description, agent.tools]),
			[["list-tools", "Uses YAML list tools", ["read", "grep"]]],
		);
	});
});

test("trims string frontmatter values before registering agents", async () => {
	await withTempDir(async (dir) => {
		const extensionAgentsDir = join(dir, "extension-agents");
		await mkdir(extensionAgentsDir, { recursive: true });
		await writeFile(
			join(extensionAgentsDir, "trimmed.md"),
			`---\nname: "  trimmed-agent  "\ndescription: "  Description with surrounding whitespace  "\nmodel: "  openai/gpt-5:low  "\nthinking: "  high  "\n---\n\nPrompt body\n`,
			"utf8",
		);

		const discovery = discoverAgents(dir, "project", extensionAgentsDir);
		assert.deepEqual(
			discovery.agents.map((agent) => [agent.name, agent.description, agent.model, agent.thinking]),
			[["trimmed-agent", "Description with surrounding whitespace", "openai/gpt-5", "high"]],
		);
	});
});

test("registers a Pi-conventional subagent tool and settings command without bundled prompt resources", () => {
	type ToolRecord = {
		name?: unknown;
		description?: unknown;
		promptSnippet?: unknown;
		promptGuidelines?: unknown;
		renderCall?: unknown;
		renderResult?: unknown;
		execute?: unknown;
		parameters?: {
			properties?: {
				agent?: {
					description?: unknown;
					minLength?: unknown;
				};
				task?: {
					minLength?: unknown;
				};
				tasks?: {
					minItems?: unknown;
					maxItems?: unknown;
					items?: {
						properties?: {
							agent?: { description?: unknown; minLength?: unknown };
							task?: { minLength?: unknown };
							cwd?: { minLength?: unknown };
						};
					};
				};
				chain?: {
					minItems?: unknown;
					maxItems?: unknown;
					items?: {
						properties?: {
							agent?: { description?: unknown; minLength?: unknown };
							task?: { minLength?: unknown };
							cwd?: { minLength?: unknown };
						};
					};
				};
				agentScope?: {
					type?: unknown;
					enum?: unknown;
					anyOf?: unknown;
				};
				confirmProjectAgents?: {
					default?: unknown;
				};
				cwd?: {
					description?: unknown;
					minLength?: unknown;
				};
			};
		};
	};
	type ResourceHandler = (
		event: { cwd: string; reason: "startup" | "reload" },
		ctx: unknown,
	) => { promptPaths?: string[] } | undefined;

	const tools: ToolRecord[] = [];
	const resourceHandlers: ResourceHandler[] = [];
	const registeredCommands: string[] = [];
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "resources_discover") {
				resourceHandlers.push(handler as ResourceHandler);
			}
		},
		registerTool(tool: ToolRecord) {
			tools.push(tool);
		},
		registerCommand(name: string) {
			registeredCommands.push(name);
		},
	};

	setupExtension(pi as unknown as ExtensionAPI);

	assert.equal(tools.length, 1);
	const tool = tools[0];
	assert.ok(tool);
	assert.equal(tool.name, "subagent");
	assert.match(String(tool.description), /truncated/i);
	const bundledAgents = "scout, planner, worker, reviewer, debugger, verifier, security-auditor, docs-writer, refactorer";
	assert.match(String(tool.description), new RegExp(escapeRegExp(`Bundled agents: ${bundledAgents}`)));
	assert.match(String(tool.description), /Use these exact names/i);
	assert.match(String(tool.description), /Do not invent names/i);
	const promptSnippet = tool.promptSnippet;
	if (typeof promptSnippet !== "string") assert.fail("Expected promptSnippet to be a string");
	assert.match(promptSnippet, /single, parallel, and chain/i);
	const promptGuidelines = tool.promptGuidelines;
	if (!Array.isArray(promptGuidelines)) assert.fail("Expected promptGuidelines to be an array");
	assert.ok(promptGuidelines.some((guideline) => typeof guideline === "string" && guideline.includes("subagent")));
	const guidelineText = promptGuidelines.join("\n");
	for (const expected of [
		"Use scout for codebase recon.",
		"Use planner for implementation plans.",
		"Use worker for general implementation.",
		"Use reviewer for code quality review.",
		"Use debugger for root-cause investigation.",
		"Use verifier for running checks.",
		"Use security-auditor for security review.",
		"Use docs-writer for documentation.",
		"Use refactorer for behavior-preserving cleanup.",
		"single {agent, task, cwd?}",
		"parallel {tasks, cwd?}",
		"chain {chain, cwd?}",
		"Top-level cwd is a default for every subagent run in the call; per-task or per-step cwd overrides it.",
	]) {
		assert.match(guidelineText, new RegExp(escapeRegExp(expected)));
	}
	assert.equal(typeof tool.renderCall, "function");
	assert.equal(typeof tool.renderResult, "function");

	assert.match(String(tool.parameters?.properties?.agent?.description), new RegExp(escapeRegExp(`Bundled agents: ${bundledAgents}`)));
	assert.equal(tool.parameters?.properties?.agent?.minLength, 1);
	assert.equal(tool.parameters?.properties?.task?.minLength, 1);
	assert.match(String(tool.parameters?.properties?.cwd?.description), /single, parallel, and chain/i);
	assert.equal(tool.parameters?.properties?.cwd?.minLength, 1);
	assert.equal(tool.parameters?.properties?.tasks?.minItems, 1);
	assert.equal(tool.parameters?.properties?.tasks?.maxItems, 8);
	assert.match(String(tool.parameters?.properties?.tasks?.items?.properties?.agent?.description), new RegExp(escapeRegExp(`Bundled agents: ${bundledAgents}`)));
	assert.equal(tool.parameters?.properties?.tasks?.items?.properties?.agent?.minLength, 1);
	assert.equal(tool.parameters?.properties?.tasks?.items?.properties?.task?.minLength, 1);
	assert.equal(tool.parameters?.properties?.tasks?.items?.properties?.cwd?.minLength, 1);
	assert.equal(tool.parameters?.properties?.chain?.minItems, 1);
	assert.equal(tool.parameters?.properties?.chain?.maxItems, 8);
	assert.match(String(tool.parameters?.properties?.chain?.items?.properties?.agent?.description), new RegExp(escapeRegExp(`Bundled agents: ${bundledAgents}`)));
	assert.equal(tool.parameters?.properties?.chain?.items?.properties?.agent?.minLength, 1);
	assert.equal(tool.parameters?.properties?.chain?.items?.properties?.task?.minLength, 1);
	assert.equal(tool.parameters?.properties?.chain?.items?.properties?.cwd?.minLength, 1);

	const agentScope = tool.parameters?.properties?.agentScope;
	assert.ok(agentScope);
	assert.equal(agentScope.type, "string");
	assert.deepEqual(agentScope.enum, ["user", "project", "both"]);
	assert.equal(agentScope.anyOf, undefined);
	assert.equal(tool.parameters?.properties?.confirmProjectAgents?.default, true);

	assert.deepEqual(registeredCommands, ["sub-agent-settings"]);
	for (const handler of resourceHandlers) {
		const resources = handler({ cwd: process.cwd(), reason: "startup" }, {});
		assert.equal(resources?.promptPaths?.length ?? 0, 0);
	}
});

test("subagent tool rejects partial or mixed mode arguments before spawning", async () => {
	type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { results: unknown[]; error?: string } };
	type ExecutableTool = {
		execute: (
			toolCallId: string,
			params: { agent?: string; task?: string; tasks?: Array<{ agent: string; task: string }>; chain?: Array<{ agent: string; task: string }>; cwd?: string },
			signal: AbortSignal | undefined,
			onUpdate: undefined,
			ctx: { cwd: string; hasUI: false },
		) => Promise<ToolResult>;
	};

	const tools: Array<{ execute?: unknown }> = [];
	const pi = {
		on() {},
		registerTool(tool: { execute?: unknown }) {
			tools.push(tool);
		},
	};
	setupExtension(pi as unknown as ExtensionAPI);
	const tool = tools[0] as ExecutableTool | undefined;
	assert.ok(tool);

	for (const params of [
		{ agent: "worker" },
		{ task: "do work" },
		{ agent: "worker", task: "do work", tasks: [{ agent: "worker", task: "other work" }] },
		{ agent: "worker", task: "do work", chain: [{ agent: "worker", task: "other work" }] },
	]) {
		const result = await tool.execute("tool-call-1", params, undefined, undefined, { cwd: process.cwd(), hasUI: false });
		assert.match(result.content[0]?.text ?? "", /Invalid subagent arguments/i);
		assert.deepEqual(result.details.results, []);
	}
});

test("parallel subagent calls accept a top-level cwd default with per-task overrides", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = {
			content: Array<{ type: "text"; text: string }>;
			details: { results: Array<{ messages: Array<{ content: Array<{ type: "text"; text: string }> }> }> };
		};
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { tasks: Array<{ agent: string; task: string; cwd?: string }>; cwd?: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const projectDir = join(dir, "project");
		const appDir = join(projectDir, "packages", "app");
		const libDir = join(projectDir, "packages", "lib");
		await mkdir(appDir, { recursive: true });
		await mkdir(libDir, { recursive: true });

		const fakePi = join(dir, "fake-pi-parallel-cwd.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: process.cwd() }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		process.argv[1] = fakePi;
		try {
			const result = await tool.execute(
				"tool-call-1",
				{
					tasks: [
						{ agent: "worker", task: "print default cwd" },
						{ agent: "worker", task: "print override cwd", cwd: "@packages/lib" },
					],
					cwd: "@packages/app",
					agentScope: "user",
				},
				undefined,
				undefined,
				{ cwd: projectDir, hasUI: false },
			);

			assert.match(result.content[0]?.text ?? "", /Parallel tasks: 2\/2 succeeded/);
			assert.equal(result.details.results[0]?.messages[0]?.content[0]?.text, appDir);
			assert.equal(result.details.results[1]?.messages[0]?.content[0]?.text, libDir);
		} finally {
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("chain subagent calls accept a top-level cwd default with per-step overrides", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = {
			content: Array<{ type: "text"; text: string }>;
			details: { results: Array<{ messages: Array<{ content: Array<{ type: "text"; text: string }> }> }> };
		};
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { chain: Array<{ agent: string; task: string; cwd?: string }>; cwd?: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const projectDir = join(dir, "project");
		const appDir = join(projectDir, "packages", "app");
		const libDir = join(projectDir, "packages", "lib");
		await mkdir(appDir, { recursive: true });
		await mkdir(libDir, { recursive: true });

		const fakePi = join(dir, "fake-pi-chain-cwd.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: process.cwd() }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		process.argv[1] = fakePi;
		try {
			const result = await tool.execute(
				"tool-call-1",
				{
					chain: [
						{ agent: "worker", task: "print default cwd" },
						{ agent: "worker", task: "print override cwd", cwd: "@packages/lib" },
					],
					cwd: "@packages/app",
					agentScope: "user",
				},
				undefined,
				undefined,
				{ cwd: projectDir, hasUI: false },
			);

			assert.equal(result.content[0]?.text, libDir);
			assert.equal(result.details.results[0]?.messages[0]?.content[0]?.text, appDir);
			assert.equal(result.details.results[1]?.messages[0]?.content[0]?.text, libDir);
		} finally {
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("subagent path rendering only abbreviates real home-directory paths", () => {
	type ToolRecord = {
		renderCall?: (
			args: { agent: string; task: string },
			theme: { fg: (_color: string, text: string) => string; bold: (text: string) => string },
		) => { text?: string };
		renderResult?: (
			result: {
				content: Array<{ type: "text"; text: string }>;
				details: {
					mode: "single";
					agentScope: "user";
					projectAgentsDir: null;
					results: Array<{
						agent: string;
						agentSource: "extension";
						task: string;
						exitCode: number;
						messages: Array<{
							role: "assistant";
							content: Array<{ type: "toolCall"; name: "read"; arguments: { path: string } }>;
						}>;
						stderr: string;
						usage: {
							input: number;
							output: number;
							cacheRead: number;
							cacheWrite: number;
							cost: number;
							contextTokens: number;
							turns: number;
						};
					}>;
				};
			},
			options: { expanded: false; isPartial: false },
			theme: { fg: (_color: string, text: string) => string; bold: (text: string) => string },
		) => { text?: string };
	};

	const tools: ToolRecord[] = [];
	const pi = {
		on() {},
		registerTool(tool: ToolRecord) {
			tools.push(tool);
		},
	};
	setupExtension(pi as unknown as ExtensionAPI);
	const tool = tools[0];
	assert.ok(tool?.renderResult);

	const siblingPath = `${homedir()}-sibling/project/README.md`;
	const rendered = tool.renderResult(
		{
			content: [{ type: "text", text: "ok" }],
			details: {
				mode: "single",
				agentScope: "user",
				projectAgentsDir: null,
				results: [
					{
						agent: "worker",
						agentSource: "extension",
						task: "read a path",
						exitCode: 0,
						messages: [{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: siblingPath } }] }],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					},
				],
			},
		},
		{ expanded: false, isPartial: false },
		{ fg: (_color, text) => text, bold: (text) => text },
	);

	assert.match(rendered.text ?? "", new RegExp(escapeRegExp(siblingPath)));
	assert.doesNotMatch(rendered.text ?? "", /~-sibling/);
});

test("settings command reports that interactive UI is required in non-interactive modes", async () => {
	type CommandHandler = (
		args: string,
		ctx: {
			cwd: string;
			hasUI: false;
			ui: {
				notify: (message: string, level: "info" | "warning" | "error") => void;
				custom: () => Promise<void>;
			};
		},
	) => Promise<void>;

	let handler: CommandHandler | undefined;
	const pi = {
		on() {},
		registerTool() {},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			if (name === "sub-agent-settings") handler = options.handler;
		},
	};
	setupExtension(pi as unknown as ExtensionAPI);
	assert.ok(handler);

	let customCalled = false;
	const notifications: Array<{ message: string; level: string }> = [];
	await handler("", {
		cwd: process.cwd(),
		hasUI: false,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
			async custom() {
				customCalled = true;
			},
		},
	});

	assert.equal(customCalled, false);
	assert.deepEqual(notifications, [
		{ message: "Sub-agent settings require an interactive UI.", level: "warning" },
	]);
});

test("settings command lists only models with configured auth", async () => {
	type Renderable = {
		render: (width: number) => string[];
		handleInput: (data: string) => void;
		invalidate?: () => void;
	};
	type ModelRecord = { provider: string; id: string; reasoning?: boolean };
	type CommandHandler = (
		args: string,
		ctx: {
			cwd: string;
			hasUI: true;
			modelRegistry: {
				refresh: () => void;
				getError: () => string | undefined;
				getAll: () => ModelRecord[];
				getAvailable: () => ModelRecord[];
			};
			ui: {
				notify: (message: string, level: "info" | "warning" | "error") => void;
				custom: (
					factory: (
						tui: { requestRender: () => void },
						theme: { fg: (_color: string, text: string) => string; bold: (text: string) => string },
						keybindings: unknown,
						done: (value?: unknown) => void,
					) => Renderable,
				) => Promise<void>;
			};
		},
	) => Promise<void>;

	let handler: CommandHandler | undefined;
	const pi = {
		on() {},
		registerTool() {},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			if (name === "sub-agent-settings") handler = options.handler;
		},
	};
	setupExtension(pi as unknown as ExtensionAPI);
	assert.ok(handler);
	const commandHandler = handler;

	initTheme("dark", false);

	await withTempDir(async (dir) => {
		await withIsolatedPiAgentDir(dir, async () => {
			let customComponent: Renderable | undefined;
			let getAllCalls = 0;
			let getAvailableCalls = 0;

			await commandHandler("", {
				cwd: dir,
				hasUI: true,
				modelRegistry: {
					refresh() {},
					getError() {
						return undefined;
					},
					getAll() {
						getAllCalls += 1;
						return [
							{ provider: "anthropic", id: "available-model", reasoning: true },
							{ provider: "openai", id: "unavailable-model", reasoning: false },
						];
					},
					getAvailable() {
						getAvailableCalls += 1;
						return [{ provider: "anthropic", id: "available-model", reasoning: true }];
					},
				},
				ui: {
					notify() {},
					async custom(factory) {
						customComponent = factory(
							{ requestRender() {} },
							{ fg: (_color, text) => text, bold: (text) => text },
							{},
							() => {},
						);
					},
				},
			});

			assert.ok(customComponent);
			customComponent.handleInput("\r");
			customComponent.handleInput("\r");
			const rendered = customComponent.render(120).join("\n");

			assert.match(rendered, /inherit/);
			assert.match(rendered, /available-model/);
			assert.doesNotMatch(rendered, /unavailable-model/);
			assert.equal(getAvailableCalls, 1);
			assert.equal(getAllCalls, 0);
		});
	});
});

test("marks failed subagent tool results as Pi tool errors without dropping details", () => {
	type ToolResultHandler = (
		event: {
			toolName: string;
			details?: {
				mode: "single" | "parallel";
				agentScope: "user";
				projectAgentsDir: null;
				results: Array<{ exitCode: number; stopReason?: string }>;
				error?: string;
			};
		},
		ctx: unknown,
	) => { isError: true } | undefined;

	const toolResultHandlers: ToolResultHandler[] = [];
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "tool_result") {
				toolResultHandlers.push(handler as ToolResultHandler);
			}
		},
		registerTool() {},
	};
	setupExtension(pi as unknown as ExtensionAPI);

	assert.equal(toolResultHandlers.length, 1);
	const handler = toolResultHandlers[0];
	assert.ok(handler);

	assert.deepEqual(
		handler(
			{
				toolName: "subagent",
				details: {
					mode: "parallel",
					agentScope: "user",
					projectAgentsDir: null,
					results: [{ exitCode: 0, stopReason: "error" }],
				},
			},
			{},
		),
		{ isError: true },
	);
	assert.deepEqual(
		handler(
			{
				toolName: "subagent",
				details: {
					mode: "single",
					agentScope: "user",
					projectAgentsDir: null,
					results: [],
					error: "Invalid subagent arguments. Use exactly one mode.",
				},
			},
			{},
		),
		{ isError: true },
	);
	assert.deepEqual(
		handler(
			{
				toolName: "subagent",
				details: {
					mode: "single",
					agentScope: "user",
					projectAgentsDir: null,
					results: [{ exitCode: 0, stopReason: "length" }],
				},
			},
			{},
		),
		{ isError: true },
	);
	assert.equal(
		handler(
			{
				toolName: "subagent",
				details: {
					mode: "parallel",
					agentScope: "user",
					projectAgentsDir: null,
					results: [{ exitCode: 0 }],
				},
			},
			{},
		),
		undefined,
	);
	assert.equal(handler({ toolName: "read" }, {}), undefined);
});

test("subagent updates mark active subprocesses as running until they close", async () => {
	await withTempDir(async (dir) => {
		type ToolUpdate = { details: { results: Array<{ exitCode: number }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: ((partial: ToolUpdate) => void) | undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<{ details: { results: Array<{ exitCode: number }> } }>;
		};

		const fakePi = join(dir, "fake-pi.mjs");
		await writeFile(
			fakePi,
			`const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\n` +
				`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } }, model: "test-model", stopReason: "tool_use" } }));\n` +
				`await delay(50);\n` +
				`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }], usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0 } }, model: "test-model", stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		process.argv[1] = fakePi;
		try {
			const updates: ToolUpdate[] = [];
			const result = await tool.execute(
				"tool-call-1",
				{ agent: "worker", task: "say hi", agentScope: "user" },
				undefined,
				(partial) => updates.push(partial),
				{ cwd: dir, hasUI: false },
			);

			assert.ok(updates.length >= 1);
			assert.equal(updates[0]?.details.results[0]?.exitCode, -1);
			assert.equal(result.details.results[0]?.exitCode, 0);
		} finally {
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("parallel subagent updates are immutable snapshots", async () => {
	await withTempDir(async (dir) => {
		type ToolUpdate = { details: { results: Array<{ exitCode: number }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { tasks: Array<{ agent: string; task: string }>; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: ((partial: ToolUpdate) => void) | undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<{ details: { results: Array<{ exitCode: number }> } }>;
		};

		const fakePi = join(dir, "fake-pi-parallel-updates.mjs");
		await writeFile(
			fakePi,
			`const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\n` +
				`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "tool_use" } }));\n` +
				`await delay(50);\n` +
				`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		process.argv[1] = fakePi;
		try {
			const updates: ToolUpdate[] = [];
			const result = await tool.execute(
				"tool-call-1",
				{ tasks: [{ agent: "worker", task: "stream then finish" }], agentScope: "user" },
				undefined,
				(partial) => updates.push(partial),
				{ cwd: dir, hasUI: false },
			);

			assert.ok(updates.length >= 1);
			assert.equal(result.details.results[0]?.exitCode, 0);
			assert.equal(updates[0]?.details.results[0]?.exitCode, -1);
		} finally {
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("parallel final content includes each task output beyond short previews", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }> };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { tasks: Array<{ agent: string; task: string }>; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-parallel-full-content.mjs");
		await writeFile(
			fakePi,
			`let stdin = "";\n` +
				`for await (const chunk of process.stdin) stdin += chunk;\n` +
				`const label = stdin.includes("alpha") ? "alpha" : "beta";\n` +
				`const output = label + "-start " + label[0].repeat(160) + " " + label + "-tail";\n` +
				`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: output }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		process.argv[1] = fakePi;
		try {
			const result = await tool.execute(
				"tool-call-1",
				{
					tasks: [
						{ agent: "worker", task: "alpha task" },
						{ agent: "worker", task: "beta task" },
					],
					agentScope: "user",
				},
				undefined,
				undefined,
				{ cwd: dir, hasUI: false },
			);

			const text = result.content[0]?.text ?? "";
			assert.match(text, /Parallel tasks: 2\/2 succeeded/);
			assert.match(text, /alpha-tail/);
			assert.match(text, /beta-tail/);
		} finally {
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("parallel final content truncates each task independently", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }> };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { tasks: Array<{ agent: string; task: string }>; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-parallel-independent-truncation.mjs");
		await writeFile(
			fakePi,
			`let stdin = "";\n` +
				`for await (const chunk of process.stdin) stdin += chunk;\n` +
				`const label = stdin.includes("alpha") ? "alpha" : "beta";\n` +
				`const lines = Array.from({ length: 2600 }, (_, index) => label + "-line-" + index + " " + "x".repeat(40));\n` +
				`const output = label + "-head\\n" + lines.join("\\n") + "\\n" + label + "-tail";\n` +
				`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: output }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		process.argv[1] = fakePi;
		try {
			const result = await tool.execute(
				"tool-call-1",
				{
					tasks: [
						{ agent: "worker", task: "alpha task" },
						{ agent: "worker", task: "beta task" },
					],
					agentScope: "user",
				},
				undefined,
				undefined,
				{ cwd: dir, hasUI: false },
			);

			const text = result.content[0]?.text ?? "";
			assert.match(text, /alpha-tail/);
			assert.match(text, /beta-tail/);
			assert.match(text, /Subagent output truncated/i);
			const savedPaths = [...text.matchAll(/Full output saved to: (\S+)/g)].map((match) => match[1]).filter((path): path is string => Boolean(path));
			assert.equal(savedPaths.length, 2);
			try {
				for (const savedPath of savedPaths) {
					const saved = await readFile(savedPath, "utf8");
					assert.match(saved, /(?:alpha|beta)-head/);
				}
			} finally {
				for (const savedPath of savedPaths) {
					await rm(dirname(savedPath), { recursive: true, force: true });
				}
			}
		} finally {
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("aborted subagents escalate to SIGKILL when SIGTERM is ignored", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { details: { results: Array<{ exitCode: number; stopReason?: string }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-ignore-term.mjs");
		await writeFile(
			fakePi,
			`process.on("SIGTERM", () => { console.error("ignored SIGTERM"); });\n` +
				`setTimeout(() => process.exit(42), 1500);\n` +
				`setInterval(() => undefined, 100);\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		const originalSetTimeout = globalThis.setTimeout;
		const shortenedSetTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: Parameters<typeof setTimeout>[1]) =>
			originalSetTimeout(handler, timeout === 5000 ? 20 : timeout)) as unknown as typeof setTimeout;
		process.argv[1] = fakePi;
		globalThis.setTimeout = shortenedSetTimeout;
		try {
			const controller = new AbortController();
			const runPromise = tool.execute(
				"tool-call-1",
				{ agent: "worker", task: "wait until aborted", agentScope: "user" },
				controller.signal,
				undefined,
				{ cwd: dir, hasUI: false },
			);
			await new Promise<void>((resolve) => {
				originalSetTimeout(() => resolve(), 100);
			});
			controller.abort();

			const timeout = new Promise<"timeout">((resolve) => {
				originalSetTimeout(() => resolve("timeout"), 500);
			});
			const completed = await Promise.race([runPromise, timeout]);

			assert.notEqual(completed, "timeout", "subagent did not exit after abort escalation");
			if (completed === "timeout") return;
			assert.equal(completed.details.results[0]?.exitCode, 1);
			assert.equal(completed.details.results[0]?.stopReason, "aborted");
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("collapsed subagent renderers use Pi keybinding hints for expansion", () => {
	type ToolRecord = {
		renderResult?: (
			result: {
				content: Array<{ type: "text"; text: string }>;
				details: {
					mode: "chain";
					agentScope: "user";
					projectAgentsDir: null;
					results: Array<{
						agent: string;
						agentSource: "extension";
						task: string;
						exitCode: number;
						messages: [];
						stderr: string;
						usage: {
							input: number;
							output: number;
							cacheRead: number;
							cacheWrite: number;
							cost: number;
							contextTokens: number;
							turns: number;
						};
						step: number;
					}>;
				};
			},
			options: { expanded: false; isPartial: false },
			theme: { fg: (_color: string, text: string) => string; bold: (text: string) => string },
		) => { text?: string };
	};

	const tools: ToolRecord[] = [];
	const pi = {
		on() {},
		registerTool(tool: ToolRecord) {
			tools.push(tool);
		},
	};
	setupExtension(pi as unknown as ExtensionAPI);
	const tool = tools[0];
	assert.ok(tool?.renderResult);

	const rendered = tool.renderResult(
		{
			content: [{ type: "text", text: "ok" }],
			details: {
				mode: "chain",
				agentScope: "user",
				projectAgentsDir: null,
				results: [
					{
						agent: "worker",
						agentSource: "extension",
						task: "done",
						exitCode: 0,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						step: 1,
					},
				],
			},
		},
		{ expanded: false, isPartial: false },
		{ fg: (_color, text) => text, bold: (text) => text },
	);

	assert.match(rendered.text ?? "", /ctrl\+o[\s\S]*to expand/);
});

test("parallel renderer marks model error stop reasons as failed tasks", () => {
	type ToolRecord = {
		renderResult?: (
			result: {
				content: Array<{ type: "text"; text: string }>;
				details: {
					mode: "parallel";
					agentScope: "user";
					projectAgentsDir: null;
					results: Array<{
						agent: string;
						agentSource: "extension";
						task: string;
						exitCode: number;
						messages: [];
						stderr: string;
						usage: {
							input: number;
							output: number;
							cacheRead: number;
							cacheWrite: number;
							cost: number;
							contextTokens: number;
							turns: number;
						};
						stopReason: "error";
					}>;
				};
			},
			options: { expanded: false; isPartial: false },
			theme: { fg: (_color: string, text: string) => string; bold: (text: string) => string },
		) => { text?: string };
	};

	const tools: ToolRecord[] = [];
	const pi = {
		on() {},
		registerTool(tool: ToolRecord) {
			tools.push(tool);
		},
	};
	setupExtension(pi as unknown as ExtensionAPI);
	const tool = tools[0];
	assert.ok(tool?.renderResult);

	const rendered = tool.renderResult(
		{
			content: [{ type: "text", text: "Parallel tasks: 0/1 succeeded" }],
			details: {
				mode: "parallel",
				agentScope: "user",
				projectAgentsDir: null,
				results: [
					{
						agent: "worker",
						agentSource: "extension",
						task: "fail through model stopReason",
						exitCode: 0,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						stopReason: "error",
					},
				],
			},
		},
		{ expanded: false, isPartial: false },
		{ fg: (_color, text) => text, bold: (text) => text },
	);

	assert.match(rendered.text ?? "", /parallel 0\/1 tasks/);
	assert.match(rendered.text ?? "", /worker ✗/);
});

test("chain renderer marks model error stop reasons as failed steps", () => {
	type ToolRecord = {
		renderResult?: (
			result: {
				content: Array<{ type: "text"; text: string }>;
				details: {
					mode: "chain";
					agentScope: "user";
					projectAgentsDir: null;
					results: Array<{
						agent: string;
						agentSource: "extension";
						task: string;
						exitCode: number;
						messages: [];
						stderr: string;
						usage: {
							input: number;
							output: number;
							cacheRead: number;
							cacheWrite: number;
							cost: number;
							contextTokens: number;
							turns: number;
						};
						stopReason: "error";
						step: number;
					}>;
				};
			},
			options: { expanded: false; isPartial: false },
			theme: { fg: (_color: string, text: string) => string; bold: (text: string) => string },
		) => { text?: string };
	};

	const tools: ToolRecord[] = [];
	const pi = {
		on() {},
		registerTool(tool: ToolRecord) {
			tools.push(tool);
		},
	};
	setupExtension(pi as unknown as ExtensionAPI);
	const tool = tools[0];
	assert.ok(tool?.renderResult);

	const rendered = tool.renderResult(
		{
			content: [{ type: "text", text: "Chain stopped at step 1" }],
			details: {
				mode: "chain",
				agentScope: "user",
				projectAgentsDir: null,
				results: [
					{
						agent: "worker",
						agentSource: "extension",
						task: "fail through model stopReason",
						exitCode: 0,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						stopReason: "error",
						step: 1,
					},
				],
			},
		},
		{ expanded: false, isPartial: false },
		{ fg: (_color, text) => text, bold: (text) => text },
	);

	assert.match(rendered.text ?? "", /chain 0\/1 steps/);
	assert.match(rendered.text ?? "", /worker ✗/);
});

test("subagent renderers surface stderr and stdout diagnostics for failed results without assistant output", () => {
	type Usage = {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens: number;
		turns: number;
	};
	type Result = {
		agent: string;
		agentSource: "extension";
		task: string;
		exitCode: number;
		messages: [];
		stderr: string;
		stdout?: string;
		errorMessage?: string;
		usage: Usage;
		step?: number;
	};
	type ToolRecord = {
		renderResult?: (
			result: {
				content: Array<{ type: "text"; text: string }>;
				details: {
					mode: "single" | "parallel" | "chain";
					agentScope: "user";
					projectAgentsDir: null;
					results: Result[];
				};
			},
			options: { expanded: false; isPartial: false },
			theme: { fg: (_color: string, text: string) => string; bold: (text: string) => string },
		) => { text?: string };
	};

	const tools: ToolRecord[] = [];
	const pi = {
		on() {},
		registerTool(tool: ToolRecord) {
			tools.push(tool);
		},
	};
	setupExtension(pi as unknown as ExtensionAPI);
	const tool = tools[0];
	assert.ok(tool?.renderResult);

	const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	const failed: Result = {
		agent: "worker",
		agentSource: "extension",
		task: "fail before producing output",
		exitCode: 23,
		messages: [],
		stderr: "child process failed before producing assistant output",
		usage,
	};
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

	const single = tool.renderResult(
		{
			content: [{ type: "text", text: "stderr:\nchild process failed before producing assistant output" }],
			details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [failed] },
		},
		{ expanded: false, isPartial: false },
		theme,
	);
	assert.match(single.text ?? "", /child process failed/);

	const malformedStdout: Result = {
		...failed,
		stderr: "",
		stdout: "child emitted non-json stdout",
		errorMessage: "Subagent produced non-JSON stdout without any JSON messages.",
	};
	const singleMalformed = tool.renderResult(
		{
			content: [{ type: "text", text: "stdout:\nchild emitted non-json stdout" }],
			details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [malformedStdout] },
		},
		{ expanded: false, isPartial: false },
		theme,
	);
	assert.match(singleMalformed.text ?? "", /child emitted non-json stdout/);

	const parallel = tool.renderResult(
		{
			content: [{ type: "text", text: "Parallel tasks: 0/1 succeeded" }],
			details: { mode: "parallel", agentScope: "user", projectAgentsDir: null, results: [failed] },
		},
		{ expanded: false, isPartial: false },
		theme,
	);
	assert.match(parallel.text ?? "", /child process failed/);

	const chain = tool.renderResult(
		{
			content: [{ type: "text", text: "Chain stopped at step 1" }],
			details: { mode: "chain", agentScope: "user", projectAgentsDir: null, results: [{ ...failed, step: 1 }] },
		},
		{ expanded: false, isPartial: false },
		theme,
	);
	assert.match(chain.text ?? "", /child process failed/);
});

test("chain mode rejects excessive steps before spawning subprocesses", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { results: unknown[] } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { chain: Array<{ agent: string; task: string }>; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const chain = Array.from({ length: 9 }, (_, index) => ({
			agent: "worker",
			task: `step ${index + 1}`,
		}));
		const result = await tool.execute(
			"tool-call-1",
			{ chain, agentScope: "user" },
			undefined,
			undefined,
			{ cwd: dir, hasUI: false },
		);

		assert.match(result.content[0]?.text ?? "", /Too many chain steps; max is 8/);
		assert.deepEqual(result.details.results, []);
	});
});

test("parallel mode treats model error stop reasons as failed tasks", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = {
			content: Array<{ type: "text"; text: string }>;
			details: { results: Array<{ stopReason?: string; exitCode: number }> };
		};
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { tasks: Array<{ agent: string; task: string }>; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-error.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "model failed" }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } }, model: "test-model", stopReason: "error", errorMessage: "model failed" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		process.argv[1] = fakePi;
		try {
			const result = await tool.execute(
				"tool-call-1",
				{ tasks: [{ agent: "worker", task: "fail through model stopReason" }], agentScope: "user" },
				undefined,
				undefined,
				{ cwd: dir, hasUI: false },
			);

			assert.match(result.content[0]?.text ?? "", /0\/1 succeeded/);
			assert.equal(result.details.results[0]?.stopReason, "error");
		} finally {
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("uses the parent model for bundled agents that do not pin a model", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }> };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false; model: { provider: string; id: string } },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-argv.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			getThinkingLevel() {
				return "high" as const;
			},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		await withIsolatedPiAgentDir(dir, async () => {
			const originalArgv = process.argv[1];
			process.argv[1] = fakePi;
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ agent: "worker", task: "capture argv", agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false, model: { provider: "openai", id: "gpt-5" } },
				);

				const argv = JSON.parse(result.content[0]?.text ?? "[]") as string[];
				const modelFlagIndex = argv.indexOf("--model");
				assert.notEqual(modelFlagIndex, -1);
				assert.equal(argv[modelFlagIndex + 1], "openai/gpt-5:high");
			} finally {
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("uses agent-specific thinking settings when launching a subagent", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }> };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false; model: { provider: string; id: string } },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-agent-thinking.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			getThinkingLevel() {
				return "high" as const;
			},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
			registerCommand() {},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		await withIsolatedPiAgentDir(dir, async () => {
			await writeAgent(join(dir, "config", "agents"), "reviewer.md", {
				name: "reviewer",
				description: "Custom reviewer",
				model: "openai/gpt-5",
				thinking: "low",
			}, "Prompt body");

			const originalArgv = process.argv[1];
			process.argv[1] = fakePi;
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ agent: "reviewer", task: "capture argv", agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false, model: { provider: "anthropic", id: "claude-sonnet-4-5" } },
				);

				const argv = JSON.parse(result.content[0]?.text ?? "[]") as string[];
				const modelFlagIndex = argv.indexOf("--model");
				assert.notEqual(modelFlagIndex, -1);
				assert.equal(argv[modelFlagIndex + 1], "openai/gpt-5:low");
			} finally {
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("subagents inherit the parent active tool allowlist when agent tools are omitted", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }> };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-tools.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			getActiveTools() {
				return ["read", "grep"];
			},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		await withIsolatedPiAgentDir(dir, async () => {
			const originalArgv = process.argv[1];
			process.argv[1] = fakePi;
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ agent: "worker", task: "capture inherited tools", agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false },
				);

				const argv = JSON.parse(result.content[0]?.text ?? "[]") as string[];
				const toolsFlagIndex = argv.indexOf("--tools");
				assert.notEqual(toolsFlagIndex, -1);
				assert.equal(argv[toolsFlagIndex + 1], "read,grep");
			} finally {
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("subagents do not inherit the subagent tool and receive depth tracking", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }> };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-depth.mjs");
		await writeFile(
			fakePi,
			`const text = JSON.stringify({ argv: process.argv.slice(2), depth: process.env.PI_SUB_AGENT_DEPTH });\n` +
				`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			getActiveTools() {
				return ["read", "subagent", "bash"];
			},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		await withIsolatedPiAgentDir(dir, async () => {
			const originalArgv = process.argv[1];
			const originalDepth = process.env.PI_SUB_AGENT_DEPTH;
			process.argv[1] = fakePi;
			delete process.env.PI_SUB_AGENT_DEPTH;
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ agent: "worker", task: "capture inherited tools and depth", agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false },
				);

				const captured = JSON.parse(result.content[0]?.text ?? "{}") as { argv: string[]; depth?: string };
				const toolsFlagIndex = captured.argv.indexOf("--tools");
				assert.notEqual(toolsFlagIndex, -1);
				assert.equal(captured.argv[toolsFlagIndex + 1], "read,bash");
				assert.ok(!captured.argv.includes("subagent"), "subagent should not be inherited as an executable child tool");
				assert.equal(captured.depth, "1");
			} finally {
				if (originalDepth === undefined) {
					delete process.env.PI_SUB_AGENT_DEPTH;
				} else {
					process.env.PI_SUB_AGENT_DEPTH = originalDepth;
				}
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("nested subagent executions are blocked before spawning another Pi process", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { results: unknown[] } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-nested-should-not-run.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "nested process ran" }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			getActiveTools() {
				return ["read", "subagent"];
			},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		const originalDepth = process.env.PI_SUB_AGENT_DEPTH;
		process.argv[1] = fakePi;
		process.env.PI_SUB_AGENT_DEPTH = "1";
		try {
			const result = await tool.execute(
				"tool-call-1",
				{ agent: "worker", task: "try to recurse", agentScope: "user" },
				undefined,
				undefined,
				{ cwd: dir, hasUI: false },
			);

			assert.match(result.content[0]?.text ?? "", /Nested subagent execution is disabled/i);
			assert.deepEqual(result.details.results, []);
		} finally {
			if (originalDepth === undefined) {
				delete process.env.PI_SUB_AGENT_DEPTH;
			} else {
				process.env.PI_SUB_AGENT_DEPTH = originalDepth;
			}
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("agent tool allowlists cannot exceed the parent active tool allowlist", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }> };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-intersect-tools.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			getActiveTools() {
				return ["read"];
			},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		await withIsolatedPiAgentDir(dir, async () => {
			await writeAgent(join(dir, "config", "agents"), "limited.md", {
				name: "limited",
				description: "Agent that asks for more tools than the parent allows",
				tools: "read, bash",
			}, "Limited prompt");

			const originalArgv = process.argv[1];
			process.argv[1] = fakePi;
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ agent: "limited", task: "capture intersected tools", agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false },
				);

				const argv = JSON.parse(result.content[0]?.text ?? "[]") as string[];
				const toolsFlagIndex = argv.indexOf("--tools");
				assert.notEqual(toolsFlagIndex, -1);
				assert.equal(argv[toolsFlagIndex + 1], "read");
				assert.doesNotMatch(argv.join(" "), /bash/);
			} finally {
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("single-agent tasks are passed over stdin instead of exposing prompt text in argv", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }> };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const secretTask = "inspect confidential launch notes without leaking them through argv";
		const fakePi = join(dir, "fake-pi-stdin.mjs");
		await writeFile(
			fakePi,
			`let stdin = "";\n` +
				`for await (const chunk of process.stdin) stdin += chunk;\n` +
				`const text = JSON.stringify({ argv: process.argv.slice(2), stdin });\n` +
				`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		process.argv[1] = fakePi;
		try {
			const result = await tool.execute(
				"tool-call-1",
				{ agent: "worker", task: secretTask, agentScope: "user" },
				undefined,
				undefined,
				{ cwd: dir, hasUI: false },
			);

			const captured = JSON.parse(result.content[0]?.text ?? "{}") as { argv: string[]; stdin: string };
			assert.ok(captured.stdin.includes(secretTask));
			assert.ok(captured.argv.every((arg) => !arg.includes(secretTask)), "task text should not be visible in child argv");
		} finally {
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("single-agent malformed JSON stdout is treated as a failed subagent run", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { results: Array<{ stdout?: string; exitCode: number }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-malformed-stdout.mjs");
		await writeFile(
			fakePi,
			`console.log("subagent wrapper printed non-json stdout");\n`,
			"utf8",
		);

		await withIsolatedPiAgentDir(dir, async () => {
			const tools: Array<{ execute?: unknown }> = [];
			const pi = {
				on() {},
				registerTool(tool: { execute?: unknown }) {
					tools.push(tool);
				},
			};
			setupExtension(pi as unknown as ExtensionAPI);
			const tool = tools[0] as ExecutableTool | undefined;
			assert.ok(tool);

			const originalArgv = process.argv[1];
			process.argv[1] = fakePi;
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ agent: "worker", task: "produce malformed output", agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false },
				);

				const text = result.content[0]?.text ?? "";
				assert.equal(result.details.results[0]?.exitCode, 1);
				assert.match(result.details.results[0]?.stdout ?? "", /non-json stdout/);
				assert.match(text, /non-JSON stdout/i);
				assert.match(text, /subagent wrapper printed non-json stdout/);
			} finally {
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("single-agent signal terminations are treated as failed subagent runs", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { results: Array<{ stderr: string; exitCode: number; errorMessage?: string }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-signal.mjs");
		await writeFile(
			fakePi,
			`process.kill(process.pid, "SIGTERM");\n`,
			"utf8",
		);

		await withIsolatedPiAgentDir(dir, async () => {
			const tools: Array<{ execute?: unknown }> = [];
			const pi = {
				on() {},
				registerTool(tool: { execute?: unknown }) {
					tools.push(tool);
				},
			};
			setupExtension(pi as unknown as ExtensionAPI);
			const tool = tools[0] as ExecutableTool | undefined;
			assert.ok(tool);

			const originalArgv = process.argv[1];
			process.argv[1] = fakePi;
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ agent: "worker", task: "terminate by signal", agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false },
				);

				const text = result.content[0]?.text ?? "";
				assert.equal(result.details.results[0]?.exitCode, 1);
				assert.match(result.details.results[0]?.stderr ?? "", /SIGTERM/);
				assert.match(result.details.results[0]?.errorMessage ?? "", /SIGTERM/);
				assert.match(text, /SIGTERM/);
			} finally {
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("single-agent failures surface subprocess stderr in LLM-facing content", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { results: Array<{ stderr: string; exitCode: number }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-stderr.mjs");
		await writeFile(
			fakePi,
			`console.error("child process failed before producing assistant output");\n` +
				`process.exit(23);\n`,
			"utf8",
		);

		await withIsolatedPiAgentDir(dir, async () => {
			const tools: Array<{ execute?: unknown }> = [];
			const pi = {
				on() {},
				registerTool(tool: { execute?: unknown }) {
					tools.push(tool);
				},
			};
			setupExtension(pi as unknown as ExtensionAPI);
			const tool = tools[0] as ExecutableTool | undefined;
			assert.ok(tool);

			const originalArgv = process.argv[1];
			process.argv[1] = fakePi;
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ agent: "worker", task: "fail before output", agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false },
				);

				const text = result.content[0]?.text ?? "";
				assert.equal(result.details.results[0]?.exitCode, 23);
				assert.match(result.details.results[0]?.stderr ?? "", /child process failed/);
				assert.match(text, /child process failed/);
				assert.match(text, /Exit code:\s*23/);
			} finally {
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("single-agent spawn errors surface actionable diagnostics", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { results: Array<{ stderr: string; exitCode: number }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		await withIsolatedPiAgentDir(dir, async () => {
			const tools: Array<{ execute?: unknown }> = [];
			const pi = {
				on() {},
				registerTool(tool: { execute?: unknown }) {
					tools.push(tool);
				},
			};
			setupExtension(pi as unknown as ExtensionAPI);
			const tool = tools[0] as ExecutableTool | undefined;
			assert.ok(tool);

			const originalArgv = process.argv[1];
			const originalPath = process.env.PATH;
			process.argv[1] = join(dir, "missing-pi-entrypoint.mjs");
			process.env.PATH = join(dir, "no-binaries");
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ agent: "worker", task: "fail before spawning", agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false },
				);

				const text = result.content[0]?.text ?? "";
				assert.equal(result.details.results[0]?.exitCode, 1);
				assert.match(result.details.results[0]?.stderr ?? "", /Failed to start subagent process/i);
				assert.match(text, /Failed to start subagent process/i);
				assert.match(text, /pi/);
			} finally {
				if (originalPath === undefined) {
					delete process.env.PATH;
				} else {
					process.env.PATH = originalPath;
				}
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("single-agent failure diagnostics avoid duplicating model errors already present in stderr", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { results: Array<{ stderr: string; errorMessage?: string; exitCode: number }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-duplicate-error.mjs");
		await writeFile(
			fakePi,
			`console.error("model failed hard");\n` +
				`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "model failed hard" } }));\n`,
			"utf8",
		);

		await withIsolatedPiAgentDir(dir, async () => {
			const tools: Array<{ execute?: unknown }> = [];
			const pi = {
				on() {},
				registerTool(tool: { execute?: unknown }) {
					tools.push(tool);
				},
			};
			setupExtension(pi as unknown as ExtensionAPI);
			const tool = tools[0] as ExecutableTool | undefined;
			assert.ok(tool);

			const originalArgv = process.argv[1];
			process.argv[1] = fakePi;
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ agent: "worker", task: "fail with duplicate diagnostics", agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false },
				);

				const text = result.content[0]?.text ?? "";
				assert.equal(result.details.results[0]?.exitCode, 0);
				assert.equal(result.details.results[0]?.errorMessage, "model failed hard");
				assert.equal((text.match(/model failed hard/g) ?? []).length, 1);
			} finally {
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("single-agent failures include assistant output and subprocess stderr", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { results: Array<{ stderr: string; exitCode: number }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-output-and-stderr.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "assistant explained partial progress" }], stopReason: "end" } }));\n` +
				`console.error("stderr explains why the child exited non-zero");\n` +
				`process.exit(24);\n`,
			"utf8",
		);

		await withIsolatedPiAgentDir(dir, async () => {
			const tools: Array<{ execute?: unknown }> = [];
			const pi = {
				on() {},
				registerTool(tool: { execute?: unknown }) {
					tools.push(tool);
				},
			};
			setupExtension(pi as unknown as ExtensionAPI);
			const tool = tools[0] as ExecutableTool | undefined;
			assert.ok(tool);

			const originalArgv = process.argv[1];
			process.argv[1] = fakePi;
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ agent: "worker", task: "fail after partial output", agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false },
				);

				const text = result.content[0]?.text ?? "";
				assert.equal(result.details.results[0]?.exitCode, 24);
				assert.match(text, /assistant explained partial progress/);
				assert.match(text, /stderr explains why/);
			} finally {
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("single-agent failures include stop reasons alongside assistant output", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { results: Array<{ stopReason?: string; exitCode: number }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-output-stop-reason.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "assistant explained partial progress" }], stopReason: "error" } }));\n`,
			"utf8",
		);

		await withIsolatedPiAgentDir(dir, async () => {
			const tools: Array<{ execute?: unknown }> = [];
			const pi = {
				on() {},
				registerTool(tool: { execute?: unknown }) {
					tools.push(tool);
				},
			};
			setupExtension(pi as unknown as ExtensionAPI);
			const tool = tools[0] as ExecutableTool | undefined;
			assert.ok(tool);

			const originalArgv = process.argv[1];
			process.argv[1] = fakePi;
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ agent: "worker", task: "fail by stopReason after partial output", agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false },
				);

				const text = result.content[0]?.text ?? "";
				assert.equal(result.details.results[0]?.exitCode, 0);
				assert.equal(result.details.results[0]?.stopReason, "error");
				assert.match(text, /assistant explained partial progress/);
				assert.match(text, /stopReason:[\s\S]*error/i);
			} finally {
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("single-agent stop reasons are not deduped against assistant output text", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { results: Array<{ stopReason?: string; exitCode: number }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-stop-reason-overlap.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "assistant mentioned error (exit code 0) before failing" }], stopReason: "error" } }));\n`,
			"utf8",
		);

		await withIsolatedPiAgentDir(dir, async () => {
			const tools: Array<{ execute?: unknown }> = [];
			const pi = {
				on() {},
				registerTool(tool: { execute?: unknown }) {
					tools.push(tool);
				},
			};
			setupExtension(pi as unknown as ExtensionAPI);
			const tool = tools[0] as ExecutableTool | undefined;
			assert.ok(tool);

			const originalArgv = process.argv[1];
			process.argv[1] = fakePi;
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ agent: "worker", task: "fail with overlapping output text", agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false },
				);

				const text = result.content[0]?.text ?? "";
				assert.match(text, /assistant mentioned error/);
				assert.match(text, /stopReason:[\s\S]*error/i);
			} finally {
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("parallel failures include stop reason diagnostics when no output exists", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { results: Array<{ stopReason?: string; exitCode: number }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { tasks: Array<{ agent: string; task: string }>; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-parallel-stop-reason.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } }));\n`,
			"utf8",
		);

		await withIsolatedPiAgentDir(dir, async () => {
			const tools: Array<{ execute?: unknown }> = [];
			const pi = {
				on() {},
				registerTool(tool: { execute?: unknown }) {
					tools.push(tool);
				},
			};
			setupExtension(pi as unknown as ExtensionAPI);
			const tool = tools[0] as ExecutableTool | undefined;
			assert.ok(tool);

			const originalArgv = process.argv[1];
			process.argv[1] = fakePi;
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ tasks: [{ agent: "worker", task: "fail by stopReason" }], agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false },
				);

				assert.equal(result.details.results[0]?.exitCode, 0);
				assert.equal(result.details.results[0]?.stopReason, "error");
				assert.match(result.content[0]?.text ?? "", /Parallel tasks: 0\/1 succeeded/);
				assert.match(result.content[0]?.text ?? "", /stopReason:[\s\S]*error/i);
			} finally {
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("chain failures include stop reason diagnostics when no output exists", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { results: Array<{ stopReason?: string; exitCode: number }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { chain: Array<{ agent: string; task: string }>; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-chain-stop-reason.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } }));\n`,
			"utf8",
		);

		await withIsolatedPiAgentDir(dir, async () => {
			const tools: Array<{ execute?: unknown }> = [];
			const pi = {
				on() {},
				registerTool(tool: { execute?: unknown }) {
					tools.push(tool);
				},
			};
			setupExtension(pi as unknown as ExtensionAPI);
			const tool = tools[0] as ExecutableTool | undefined;
			assert.ok(tool);

			const originalArgv = process.argv[1];
			process.argv[1] = fakePi;
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ chain: [{ agent: "worker", task: "fail by stopReason" }], agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false },
				);

				assert.equal(result.details.results[0]?.exitCode, 0);
				assert.equal(result.details.results[0]?.stopReason, "error");
				assert.match(result.content[0]?.text ?? "", /Chain stopped at step 1/);
				assert.match(result.content[0]?.text ?? "", /stopReason:[\s\S]*error/i);
			} finally {
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("single-agent stopReason failures include the stop reason when no output exists", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { results: Array<{ stopReason?: string; exitCode: number }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-stop-reason.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } }));\n`,
			"utf8",
		);

		await withIsolatedPiAgentDir(dir, async () => {
			const tools: Array<{ execute?: unknown }> = [];
			const pi = {
				on() {},
				registerTool(tool: { execute?: unknown }) {
					tools.push(tool);
				},
			};
			setupExtension(pi as unknown as ExtensionAPI);
			const tool = tools[0] as ExecutableTool | undefined;
			assert.ok(tool);

			const originalArgv = process.argv[1];
			process.argv[1] = fakePi;
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ agent: "worker", task: "fail by stopReason", agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false },
				);

				assert.equal(result.details.results[0]?.exitCode, 0);
				assert.equal(result.details.results[0]?.stopReason, "error");
				assert.match(result.content[0]?.text ?? "", /stopReason:[\s\S]*error/i);
			} finally {
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("single-agent length stop reasons are treated as failed incomplete runs", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { results: Array<{ stopReason?: string; exitCode: number }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-length-stop.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial answer" }], stopReason: "length" } }));\n`,
			"utf8",
		);

		await withIsolatedPiAgentDir(dir, async () => {
			const tools: Array<{ execute?: unknown }> = [];
			const pi = {
				on() {},
				registerTool(tool: { execute?: unknown }) {
					tools.push(tool);
				},
			};
			setupExtension(pi as unknown as ExtensionAPI);
			const tool = tools[0] as ExecutableTool | undefined;
			assert.ok(tool);

			const originalArgv = process.argv[1];
			process.argv[1] = fakePi;
			try {
				const result = await tool.execute(
					"tool-call-1",
					{ agent: "worker", task: "hit output limit", agentScope: "user" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false },
				);

				assert.equal(result.details.results[0]?.exitCode, 0);
				assert.equal(result.details.results[0]?.stopReason, "length");
				assert.match(result.content[0]?.text ?? "", /partial answer/);
				assert.match(result.content[0]?.text ?? "", /stopReason:[\s\S]*length/i);
			} finally {
				if (originalArgv === undefined) {
					process.argv.splice(1, 1);
				} else {
					process.argv[1] = originalArgv;
				}
			}
		});
	});
});

test("single-agent unknown agents surface available-agent guidance", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { results: Array<{ stderr: string; exitCode: number }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		await withIsolatedPiAgentDir(dir, async () => {
			const tools: Array<{ execute?: unknown }> = [];
			const pi = {
				on() {},
				registerTool(tool: { execute?: unknown }) {
					tools.push(tool);
				},
			};
			setupExtension(pi as unknown as ExtensionAPI);
			const tool = tools[0] as ExecutableTool | undefined;
			assert.ok(tool);

			const result = await tool.execute(
				"tool-call-1",
				{ agent: "missing-agent", task: "do work", agentScope: "user" },
				undefined,
				undefined,
				{ cwd: dir, hasUI: false },
			);

			assert.equal(result.details.results[0]?.exitCode, 1);
			assert.match(result.content[0]?.text ?? "", /Unknown agent: "missing-agent"/);
			assert.match(result.content[0]?.text ?? "", /Available: .*worker/);
		});
	});
});

test("non-interactive project agents require explicit confirmation opt-out", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = {
			content: Array<{ type: "text"; text: string }>;
			details: { results: Array<{ agent: string }> };
		};
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope: "project"; confirmProjectAgents?: false },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const projectDir = join(dir, "project");
		const projectAgentsDir = join(projectDir, ".pi", "agents");
		await writeAgent(projectAgentsDir, "danger.md", {
			name: "danger",
			description: "Project controlled agent",
			tools: "read",
		}, "Project-local prompt");

		const fakePi = join(dir, "fake-pi-project-agent.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "executed project agent" }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		process.argv[1] = fakePi;
		try {
			const blocked = await tool.execute(
				"tool-call-1",
				{ agent: "danger", task: "do project-controlled work", agentScope: "project" },
				undefined,
				undefined,
				{ cwd: projectDir, hasUI: false },
			);
			assert.match(blocked.content[0]?.text ?? "", /requires.*confirmProjectAgents: false/i);
			assert.equal(blocked.details.results.length, 0);

			const allowed = await tool.execute(
				"tool-call-2",
				{ agent: "danger", task: "do project-controlled work", agentScope: "project", confirmProjectAgents: false },
				undefined,
				undefined,
				{ cwd: projectDir, hasUI: false },
			);
			assert.equal(allowed.content[0]?.text, "executed project agent");
		} finally {
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("single-agent cwd overrides resolve relative to ctx.cwd and accept @ prefixes", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }> };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; cwd: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const projectDir = join(dir, "project");
		const packageDir = join(projectDir, "packages", "app");
		await mkdir(packageDir, { recursive: true });

		const fakePi = join(dir, "fake-pi-cwd.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: process.cwd() }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		process.argv[1] = fakePi;
		try {
			const result = await tool.execute(
				"tool-call-1",
				{ agent: "worker", task: "print cwd", cwd: "@packages/app", agentScope: "user" },
				undefined,
				undefined,
				{ cwd: projectDir, hasUI: false },
			);

			assert.equal(result.content[0]?.text, packageDir);
		} finally {
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("single-agent invalid cwd overrides return actionable diagnostics before spawning", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = {
			content: Array<{ type: "text"; text: string }>;
			details: { results: Array<{ stderr: string; exitCode: number }> };
		};
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; cwd: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const projectDir = join(dir, "project");
		await mkdir(projectDir, { recursive: true });

		const fakePi = join(dir, "fake-pi-cwd-should-not-run.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "spawned" }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		process.argv[1] = fakePi;
		try {
			const result = await tool.execute(
				"tool-call-1",
				{ agent: "worker", task: "print cwd", cwd: "@missing/app", agentScope: "user" },
				undefined,
				undefined,
				{ cwd: projectDir, hasUI: false },
			);

			const expectedPath = join(projectDir, "missing", "app");
			assert.equal(result.details.results[0]?.exitCode, 1);
			assert.match(result.details.results[0]?.stderr ?? "", /Subagent working directory does not exist or is not a directory/);
			assert.match(result.content[0]?.text ?? "", new RegExp(escapeRegExp(expectedPath)));
			assert.doesNotMatch(result.content[0]?.text ?? "", /Failed to start subagent process/);
		} finally {
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("single-agent output preserves all assistant text parts in order", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { content: Array<{ type: "text"; text: string }> };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-multipart-output.mjs");
		await writeFile(
			fakePi,
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first " }, { type: "toolCall", name: "read", arguments: { path: "README.md" } }, { type: "text", text: "second" }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		process.argv[1] = fakePi;
		try {
			const result = await tool.execute(
				"tool-call-1",
				{ agent: "worker", task: "produce multipart output", agentScope: "user" },
				undefined,
				undefined,
				{ cwd: dir, hasUI: false },
			);

			assert.equal(result.content[0]?.text, "first second");
		} finally {
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("chain handoff uses an empty previous output instead of stale earlier output", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { details: { results: Array<{ task: string }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { chain: Array<{ agent: string; task: string }>; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-chain-empty.mjs");
		await writeFile(
			fakePi,
			`let stdin = "";\n` +
				`for await (const chunk of process.stdin) stdin += chunk;\n` +
				`const task = stdin;\n` +
				`const text = task.includes("empty") ? "" : task.includes("first") ? "first-output" : task.replace(/^Task: /, "");\n` +
				`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		process.argv[1] = fakePi;
		try {
			const result = await tool.execute(
				"tool-call-1",
				{
					chain: [
						{ agent: "worker", task: "first" },
						{ agent: "worker", task: "empty after {previous}" },
						{ agent: "worker", task: "third sees {previous}" },
					],
					agentScope: "user",
				},
				undefined,
				undefined,
				{ cwd: dir, hasUI: false },
			);

			assert.equal(result.details.results[2]?.task, "third sees ");
		} finally {
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("chain handoff treats a final empty assistant text as the previous output", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = { details: { results: Array<{ task: string }> } };
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { chain: Array<{ agent: string; task: string }>; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const fakePi = join(dir, "fake-pi-chain-final-empty.mjs");
		await writeFile(
			fakePi,
			`let stdin = "";\n` +
				`for await (const chunk of process.stdin) stdin += chunk;\n` +
				`const task = stdin;\n` +
				`if (task.includes("empty-final")) {\n` +
				`  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "intermediate-output" }], stopReason: "tool_use" } }));\n` +
				`  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "end" } }));\n` +
				`} else {\n` +
				`  const text = task.includes("first") ? "first-output" : task.replace(/^Task: /, "");\n` +
				`  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end" } }));\n` +
				`}\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		process.argv[1] = fakePi;
		try {
			const result = await tool.execute(
				"tool-call-1",
				{
					chain: [
						{ agent: "worker", task: "first" },
						{ agent: "worker", task: "empty-final after {previous}" },
						{ agent: "worker", task: "third sees {previous}" },
					],
					agentScope: "user",
				},
				undefined,
				undefined,
				{ cwd: dir, hasUI: false },
			);

			assert.equal(result.details.results[2]?.task, "third sees ");
		} finally {
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("single-agent results truncate LLM-facing content, save full output, and retain full details", async () => {
	await withTempDir(async (dir) => {
		type ToolResult = {
			content: Array<{ type: "text"; text: string }>;
			details: {
				results: Array<{
					messages: Array<{ content?: Array<{ type: string; text: string }> }>;
				}>;
			};
		};
		type ExecutableTool = {
			execute: (
				toolCallId: string,
				params: { agent: string; task: string; agentScope?: "user" },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: { cwd: string; hasUI: false },
			) => Promise<ToolResult>;
		};

		const longOutput = "final-output\n" + "x".repeat(60_000);
		const fakePi = join(dir, "fake-pi-long-output.mjs");
		await writeFile(
			fakePi,
			`const longOutput = ${JSON.stringify(longOutput)};\n` +
				`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: longOutput }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } }, model: "test-model", stopReason: "end" } }));\n`,
			"utf8",
		);

		const tools: Array<{ execute?: unknown }> = [];
		const pi = {
			on() {},
			registerTool(tool: { execute?: unknown }) {
				tools.push(tool);
			},
		};
		setupExtension(pi as unknown as ExtensionAPI);
		const tool = tools[0] as ExecutableTool | undefined;
		assert.ok(tool);

		const originalArgv = process.argv[1];
		process.argv[1] = fakePi;
		try {
			const result = await tool.execute(
				"tool-call-1",
				{ agent: "worker", task: "produce long output", agentScope: "user" },
				undefined,
				undefined,
				{ cwd: dir, hasUI: false },
			);

			const text = result.content[0]?.text ?? "";
			assert.match(text, /Subagent output truncated/i);
			assert.ok(text.length < longOutput.length, `expected ${text.length} to be shorter than ${longOutput.length}`);
			const match = text.match(/Full output saved to: (\S+)/);
			assert.ok(match?.[1], "expected truncated output to include a full-output temp file path");
			const savedPath = match[1];
			try {
				assert.equal(await readFile(savedPath, "utf8"), longOutput);
				const savedStats = await stat(savedPath);
				assert.equal(savedStats.mode & 0o077, 0, "full-output temp file should not be world/group-readable");
			} finally {
				await rm(dirname(savedPath), { recursive: true, force: true });
			}
			assert.equal(result.details.results[0]?.messages[0]?.content?.[0]?.text, longOutput);
		} finally {
			if (originalArgv === undefined) {
				process.argv.splice(1, 1);
			} else {
				process.argv[1] = originalArgv;
			}
		}
	});
});

test("bundled agents include the documented specialist set with conservative tool access", async () => {
	const agentDir = join("extensions", "agents");
	const files = (await readdir(agentDir)).filter((file) => file.endsWith(".md")).sort();
	assert.deepEqual(files, [
		"debugger.md",
		"docs-writer.md",
		"planner.md",
		"refactorer.md",
		"reviewer.md",
		"scout.md",
		"security-auditor.md",
		"verifier.md",
		"worker.md",
	]);

	for (const file of files) {
		const content = await readFile(join(agentDir, file), "utf8");
		assert.doesNotMatch(content, /^model:/m, `${file} should not pin a provider-specific model`);
	}

	const discovery = discoverAgents(process.cwd(), "project", agentDir);
	const byName = new Map(discovery.agents.map((agent) => [agent.name, agent]));
	assert.deepEqual([...byName.keys()].sort(), [
		"debugger",
		"docs-writer",
		"planner",
		"refactorer",
		"reviewer",
		"scout",
		"security-auditor",
		"verifier",
		"worker",
	]);

	for (const readOnlyName of ["scout", "planner", "reviewer", "security-auditor"] as const) {
		assert.deepEqual(byName.get(readOnlyName)?.tools, ["read", "grep", "find", "ls"], `${readOnlyName} should stay read-only`);
	}
	for (const investigativeName of ["debugger", "verifier"] as const) {
		assert.deepEqual(byName.get(investigativeName)?.tools, ["read", "grep", "find", "ls", "bash"], `${investigativeName} should be allowed to run diagnostic commands`);
	}
	assert.equal(byName.get("worker")?.tools, undefined, "worker should inherit parent tools for implementation tasks");
	assert.equal(byName.get("docs-writer")?.tools, undefined, "docs-writer should inherit parent tools for documentation edits");
	assert.equal(byName.get("refactorer")?.tools, undefined, "refactorer should inherit parent tools for refactoring edits");
});

test("does not bundle workflow prompt templates that become slash commands", async () => {
	const promptDir = join("extensions", "prompts");
	await assert.rejects(access(promptDir), /ENOENT/);
});

test("package manifest declares public Pi package runtime and release metadata", async () => {
	const pkg = JSON.parse(await readFile("package.json", "utf8"));
	const license = await readFile("LICENSE", "utf8");

	assert.match(license, new RegExp(`Copyright \\(c\\) 2026 ${escapeRegExp(pkg.author)}`));
	assert.deepEqual(pkg.repository, {
		type: "git",
		url: "git+https://github.com/HamdiMaz/pi-sub-agent.git",
	});
	assert.deepEqual(pkg.bugs, { url: "https://github.com/HamdiMaz/pi-sub-agent/issues" });
	assert.equal(pkg.homepage, "https://github.com/HamdiMaz/pi-sub-agent#readme");
	assert.equal(pkg.engines.node, ">=20.6.0");
	assert.equal(pkg.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.equal(pkg.peerDependencies["@earendil-works/pi-ai"], "*");
	assert.equal(pkg.peerDependencies["@earendil-works/pi-tui"], "*");
	assert.equal(pkg.peerDependencies.typebox, "*");
	assert.equal(pkg.devDependencies["@earendil-works/pi-ai"], pkg.devDependencies["@earendil-works/pi-coding-agent"]);
	assert.equal(pkg.devDependencies["@earendil-works/pi-tui"], pkg.devDependencies["@earendil-works/pi-coding-agent"]);
	assert.ok(pkg.devDependencies.typebox);
	assert.ok(pkg.files.includes("CHANGELOG.md"));
	assert.ok(pkg.scripts.test);
	assert.equal(pkg.scripts.prepublishOnly, "npm run check");
	assert.deepEqual(pkg.pi.extensions, ["./extensions/index.ts"]);
	assert.equal(pkg.pi.prompts, undefined);
});
