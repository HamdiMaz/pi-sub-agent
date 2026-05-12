import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import setupExtension from "../extensions/index.ts";
import { discoverAgents } from "../extensions/agents.ts";

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

test("discovers agents with YAML list tools and skips invalid frontmatter without throwing", async () => {
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

		const discovery = discoverAgents(dir, "project", extensionAgentsDir);
		assert.deepEqual(
			discovery.agents.map((agent) => [agent.name, agent.description, agent.tools]),
			[["list-tools", "Uses YAML list tools", ["read", "grep"]]],
		);
	});
});

test("registers a Pi-conventional subagent tool and bundled prompt resources", () => {
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
							agent?: { minLength?: unknown };
							task?: { minLength?: unknown };
							cwd?: { minLength?: unknown };
						};
					};
				};
				chain?: {
					minItems?: unknown;
					items?: {
						properties?: {
							agent?: { minLength?: unknown };
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
					minLength?: unknown;
				};
			};
		};
	};
	type ResourceHandler = (
		event: { cwd: string; reason: "startup" | "reload" },
		ctx: unknown,
	) => { promptPaths: string[] };

	const tools: ToolRecord[] = [];
	const resourceHandlers: ResourceHandler[] = [];
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "resources_discover") {
				resourceHandlers.push(handler as ResourceHandler);
			}
		},
		registerTool(tool: ToolRecord) {
			tools.push(tool);
		},
	};

	setupExtension(pi as unknown as ExtensionAPI);

	assert.equal(tools.length, 1);
	const tool = tools[0];
	assert.ok(tool);
	assert.equal(tool.name, "subagent");
	assert.match(String(tool.description), /truncated/i);
	const promptSnippet = tool.promptSnippet;
	if (typeof promptSnippet !== "string") assert.fail("Expected promptSnippet to be a string");
	assert.match(promptSnippet, /single, parallel, and chain/i);
	const promptGuidelines = tool.promptGuidelines;
	if (!Array.isArray(promptGuidelines)) assert.fail("Expected promptGuidelines to be an array");
	assert.ok(promptGuidelines.some((guideline) => typeof guideline === "string" && guideline.includes("subagent")));
	assert.equal(typeof tool.renderCall, "function");
	assert.equal(typeof tool.renderResult, "function");

	assert.equal(tool.parameters?.properties?.agent?.minLength, 1);
	assert.equal(tool.parameters?.properties?.task?.minLength, 1);
	assert.equal(tool.parameters?.properties?.cwd?.minLength, 1);
	assert.equal(tool.parameters?.properties?.tasks?.minItems, 1);
	assert.equal(tool.parameters?.properties?.tasks?.maxItems, 8);
	assert.equal(tool.parameters?.properties?.tasks?.items?.properties?.agent?.minLength, 1);
	assert.equal(tool.parameters?.properties?.tasks?.items?.properties?.task?.minLength, 1);
	assert.equal(tool.parameters?.properties?.tasks?.items?.properties?.cwd?.minLength, 1);
	assert.equal(tool.parameters?.properties?.chain?.minItems, 1);
	assert.equal(tool.parameters?.properties?.chain?.items?.properties?.agent?.minLength, 1);
	assert.equal(tool.parameters?.properties?.chain?.items?.properties?.task?.minLength, 1);
	assert.equal(tool.parameters?.properties?.chain?.items?.properties?.cwd?.minLength, 1);

	const agentScope = tool.parameters?.properties?.agentScope;
	assert.ok(agentScope);
	assert.equal(agentScope.type, "string");
	assert.deepEqual(agentScope.enum, ["user", "project", "both"]);
	assert.equal(agentScope.anyOf, undefined);
	assert.equal(tool.parameters?.properties?.confirmProjectAgents?.default, true);

	assert.equal(resourceHandlers.length, 1);
	const handler = resourceHandlers[0];
	assert.ok(handler);
	const resources = handler({ cwd: process.cwd(), reason: "startup" }, {});
	assert.equal(resources.promptPaths.length, 1);
	const promptPath = resources.promptPaths[0];
	assert.ok(promptPath);
	assert.match(promptPath, /extensions\/prompts$/);
});

test("marks failed subagent tool results as Pi tool errors without dropping details", () => {
	type ToolResultHandler = (
		event: {
			toolName: string;
			details?: {
				mode: "parallel";
				agentScope: "user";
				projectAgentsDir: null;
				results: Array<{ exitCode: number; stopReason?: string }>;
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

test("single-agent results truncate LLM-facing content while retaining full details", async () => {
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

test("bundled agents inherit the active Pi model and minimize tool access unless users override them", async () => {
	const agentDir = join("extensions", "agents");
	const files = (await readdir(agentDir)).filter((file) => file.endsWith(".md"));
	assert.ok(files.length > 0);
	for (const file of files) {
		const content = await readFile(join(agentDir, file), "utf8");
		assert.doesNotMatch(content, /^model:/m, `${file} should not pin a provider-specific model`);
	}

	const discovery = discoverAgents(process.cwd(), "project", agentDir);
	const scout = discovery.agents.find((agent) => agent.name === "scout");
	assert.ok(scout);
	assert.ok(!scout.tools?.includes("bash"), "scout should use read-only search tools instead of bash");
});

test("workflow prompt templates include autocomplete metadata", async () => {
	const promptDir = join("extensions", "prompts");
	const files = (await readdir(promptDir)).filter((file) => file.endsWith(".md"));
	assert.deepEqual(files.sort(), ["implement-and-review.md", "implement.md", "scout-and-plan.md"]);
	for (const file of files) {
		const content = await readFile(join(promptDir, file), "utf8");
		assert.match(content, /^description: .+$/m, `${file} should include a description`);
		assert.match(content, /^argument-hint: "<request>"$/m, `${file} should include an argument hint`);
	}
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
	assert.deepEqual(pkg.pi.extensions, ["./extensions/index.ts"]);
	assert.deepEqual(pkg.pi.prompts, ["./extensions/prompts"]);
});
