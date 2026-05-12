import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("registers a Pi-conventional subagent tool and bundled prompt resources", () => {
	type ToolRecord = {
		name?: unknown;
		promptSnippet?: unknown;
		promptGuidelines?: unknown;
		renderCall?: unknown;
		renderResult?: unknown;
		execute?: unknown;
		parameters?: {
			properties?: {
				agentScope?: {
					type?: unknown;
					enum?: unknown;
					anyOf?: unknown;
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
		on(event: "resources_discover", handler: ResourceHandler) {
			assert.equal(event, "resources_discover");
			resourceHandlers.push(handler);
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
	const promptSnippet = tool.promptSnippet;
	if (typeof promptSnippet !== "string") assert.fail("Expected promptSnippet to be a string");
	assert.match(promptSnippet, /single, parallel, and chain/i);
	const promptGuidelines = tool.promptGuidelines;
	if (!Array.isArray(promptGuidelines)) assert.fail("Expected promptGuidelines to be an array");
	assert.ok(promptGuidelines.some((guideline) => typeof guideline === "string" && guideline.includes("subagent")));
	assert.equal(typeof tool.renderCall, "function");
	assert.equal(typeof tool.renderResult, "function");

	const agentScope = tool.parameters?.properties?.agentScope;
	assert.ok(agentScope);
	assert.equal(agentScope.type, "string");
	assert.deepEqual(agentScope.enum, ["user", "project", "both"]);
	assert.equal(agentScope.anyOf, undefined);

	assert.equal(resourceHandlers.length, 1);
	const handler = resourceHandlers[0];
	assert.ok(handler);
	const resources = handler({ cwd: process.cwd(), reason: "startup" }, {});
	assert.equal(resources.promptPaths.length, 1);
	const promptPath = resources.promptPaths[0];
	assert.ok(promptPath);
	assert.match(promptPath, /extensions\/prompts$/);
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

test("package manifest declares public Pi package runtime and release metadata", async () => {
	const pkg = JSON.parse(await readFile("package.json", "utf8"));

	assert.equal(pkg.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.equal(pkg.peerDependencies["@earendil-works/pi-ai"], "*");
	assert.equal(pkg.peerDependencies["@earendil-works/pi-tui"], "*");
	assert.equal(pkg.peerDependencies.typebox, "*");
	assert.equal(pkg.devDependencies["@earendil-works/pi-ai"], pkg.devDependencies["@earendil-works/pi-coding-agent"]);
	assert.equal(pkg.devDependencies["@earendil-works/pi-tui"], pkg.devDependencies["@earendil-works/pi-coding-agent"]);
	assert.ok(pkg.devDependencies.typebox);
	assert.ok(pkg.files.includes("CHANGELOG.md"));
	assert.ok(pkg.scripts.test);
	assert.deepEqual(pkg.pi.extensions, ["./extensions"]);
});
