/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation, giving it an
 * isolated context window.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface RawUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: {
		total?: number;
	};
}

interface RawMessage {
	role?: string;
	content?: unknown;
	usage?: RawUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "extension" | "unknown";
	task: string;
	exitCode: number;
	messages: RawMessage[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

type OnUpdateCallback = (partial: { content: Array<{ type: "text"; text: string }>; details: SubagentDetails }) => void;

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatAggregateUsageStats(results: SingleResult[]): string {
	const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	for (const result of results) {
		usage.input += result.usage.input;
		usage.output += result.usage.output;
		usage.cacheRead += result.usage.cacheRead;
		usage.cacheWrite += result.usage.cacheWrite;
		usage.cost += result.usage.cost;
		usage.turns += result.usage.turns;
		usage.contextTokens = Math.max(usage.contextTokens, result.usage.contextTokens);
	}
	return formatUsageStats(usage);
}

function shortenPath(filePath: string): string {
	const home = os.homedir();
	return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	switch (toolName) {
		case "bash": {
			const command = typeof args.command === "string" ? args.command : "...";
			const preview = makePlaceholder(command);
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "...";
			let text = themeFg("accent", shortenPath(rawPath));
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "...";
			const content = typeof args.content === "string" ? args.content : "";
			const lines = content ? content.split("\n").length : 0;
			let text = themeFg("muted", "write ") + themeFg("accent", shortenPath(rawPath));
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "...";
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = typeof args.path === "string" ? args.path : ".";
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "*";
			const rawPath = typeof args.path === "string" ? args.path : ".";
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			const rawPath = typeof args.path === "string" ? args.path : ".";
			return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		default: {
			const argsText = JSON.stringify(args);
			const preview = makePlaceholder(argsText);
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = basename(process.execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: "pi", args };
	}
	return { command: process.execPath, args };
}

function addUsage(base: UsageStats, raw?: RawUsage): UsageStats {
	if (!raw) return base;
	return {
		...base,
		input: base.input + (raw.input ?? 0),
		output: base.output + (raw.output ?? 0),
		cacheRead: base.cacheRead + (raw.cacheRead ?? 0),
		cacheWrite: base.cacheWrite + (raw.cacheWrite ?? 0),
		cost: base.cost + (raw.cost?.total ?? 0),
		contextTokens: raw.totalTokens ?? base.contextTokens,
	};
}

function collectTextFromMessage(message: RawMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i];
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
			return part.text;
		}
	}
	return "";
}

function collectFinalOutput(messages: RawMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message) continue;
		if (message.role !== "assistant") continue;
		const text = collectTextFromMessage(message);
		if (text) return text;
	}
	return "";
}

function collectDisplayItems(messages: RawMessage[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const content = message.content;
		if (typeof content === "string") {
			items.push({ type: "text", text: content });
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!isRecord(part)) continue;
			if (part.type === "text" && typeof part.text === "string") {
				items.push({ type: "text", text: part.text });
			} else if (part.type === "toolCall" && typeof part.name === "string") {
				items.push({
					type: "toolCall",
					name: part.name,
					args: isRecord(part.arguments) ? part.arguments : {},
				});
			}
		}
	}
	return items;
}

function getLastErrorMessage(messages: RawMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message) continue;
		if (message.role === "assistant" && typeof message.errorMessage === "string" && message.errorMessage) {
			return message.errorMessage;
		}
	}
	return "";
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function makePlaceholder(text = ""): string {
	return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results = new Array<TOut | undefined>(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			const item = items[current];
			if (item === undefined) continue;
			results[current] = await fn(item, current);
		}
	});
	await Promise.all(workers);
	return results.map((value, index) => {
		if (value === undefined) {
			throw new Error(`Parallel worker did not return a result for task index ${index}`);
		}
		return value;
	});
}

function isTaskError(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

function isFailedResultLike(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const exitCode = typeof value.exitCode === "number" ? value.exitCode : 0;
	const stopReason = typeof value.stopReason === "string" ? value.stopReason : undefined;
	return exitCode !== 0 || stopReason === "error" || stopReason === "aborted";
}

function hasFailedSubagentResult(details: unknown): boolean {
	if (!isRecord(details)) return false;
	return Array.isArray(details.results) && details.results.some(isFailedResultLike);
}

function snapshotResult(result: SingleResult): SingleResult {
	return {
		...result,
		messages: [...result.messages],
		usage: { ...result.usage },
	};
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((candidate) => candidate.name === agentName);
	const emptyUsage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

	if (!agent) {
		const known = agents.map((entry) => entry.name).sort().join(", ") || "none";
		const result: SingleResult = {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available: ${known}`,
			usage: { ...emptyUsage },
		};
		if (step !== undefined) {
			result.step = step;
		}
		return result;
	}

	const args = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) {
		args.push("--model", agent.model);
	}
	if (agent.tools !== undefined && agent.tools.length > 0) {
		args.push("--tools", agent.tools.join(","));
	}

	let tmpDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let aborted = false;
	let abortListener: (() => void) | null = null;
	const result: SingleResult = {
		agent: agent.name,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { ...emptyUsage },
	};
	if (step !== undefined) {
		result.step = step;
	}
	if (agent.model) {
		result.model = agent.model;
	}

	const emitUpdate = () => {
		if (!onUpdate) return;
		onUpdate({
			content: [{ type: "text", text: collectFinalOutput(result.messages) || "(running...)" }],
			details: makeDetails([snapshotResult(result)]),
		});
	};

	try {
		if (agent.systemPrompt.trim()) {
			const file = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpDir = file.dir;
			tmpPromptPath = file.filePath;
			args.push("--append-system-prompt", file.filePath);
		}

		args.push(`Task: ${task}`);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";
			const parseLine = (line: string): void => {
				const trimmed = line.trim();
				if (!trimmed) return;
				let event: unknown;
				try {
					event = JSON.parse(trimmed);
				} catch {
					return;
				}
				if (!isRecord(event)) return;
				const eventType = event.type;
				if (eventType !== "message_end" && eventType !== "tool_result_end") return;
				const rawMessage = event.message;
				if (!isRecord(rawMessage)) return;
				const message = rawMessage as RawMessage;
				result.messages.push(message);
				if (message.role === "assistant") {
					result.usage = addUsage(result.usage, message.usage);
					result.usage.turns += 1;
					if (!result.model && typeof message.model === "string") {
						result.model = message.model;
					}
					if (typeof message.stopReason === "string") {
						result.stopReason = message.stopReason;
					}
					if (typeof message.errorMessage === "string" && message.errorMessage) {
						result.errorMessage = message.errorMessage;
					}
				}
				emitUpdate();
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					parseLine(line);
				}
			});
			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			const abort = (): void => {
				if (aborted) return;
				aborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};

			if (signal) {
				if (signal.aborted) {
					abort();
				} else {
					abortListener = () => abort();
					signal.addEventListener("abort", abortListener, { once: true });
				}
			}

			proc.on("close", (code) => {
				if (buffer.trim()) parseLine(buffer);
				if (signal && abortListener) {
					signal.removeEventListener("abort", abortListener);
					abortListener = null;
				}
				resolve(code ?? 0);
			});
			proc.on("error", () => resolve(1));
		});

		result.exitCode = exitCode;
		if (aborted) {
			result.exitCode = 1;
			result.stopReason = "aborted";
			if (!result.errorMessage) {
				result.errorMessage = "Subagent execution was aborted.";
			}
		}
		if (!result.errorMessage) {
			const last = getLastErrorMessage(result.messages);
			if (last) result.errorMessage = last;
		}
	} catch (error) {
		result.exitCode = 1;
		result.errorMessage = error instanceof Error ? error.message : String(error);
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				// Ignore cleanup errors.
			}
		}
		if (tmpDir) {
			try {
				fs.rmdirSync(tmpDir);
			} catch {
				// Ignore cleanup errors.
			}
		}
		if (!result.stderr && result.exitCode !== 0 && !collectFinalOutput(result.messages)) {
			result.stderr = `Subagent exited with code ${result.exitCode}.`;
		}
	}

	if (result.exitCode !== 0 && result.errorMessage) {
		result.stderr = result.stderr ? `${result.stderr}\n${result.errorMessage}` : result.errorMessage;
	}

	return result;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate" }),
	cwd: Type.Optional(Type.String({ description: "Working directory override for this task" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		description: "Task with optional {previous} placeholder",
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory override for this task" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Single mode agent name" })),
	task: Type.Optional(Type.String({ description: "Single mode task text" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel mode task list" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Chain mode task list" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Confirm before running project agents", default: true })),
	cwd: Type.Optional(Type.String({ description: "Default working directory for single mode" })),
});

export default function (pi: ExtensionAPI): void {
	pi.on("resources_discover", () => ({ promptPaths: [join(extensionDir, "prompts")] }));
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		if (!hasFailedSubagentResult(event.details)) return;
		return { isError: true };
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Supports single, parallel, and chain flows.",
			'Bundled default agents are always available; user agents are used by default from ~/.pi/agent/agents.',
			'Use agentScope "project" or "both" to include trusted project-local agents from .pi/agents.',
		].join(" "),
		promptSnippet: "Delegate work to specialized subagents in isolated Pi processes; supports single, parallel, and chain workflows.",
		promptGuidelines: [
			"Use subagent when a task benefits from isolated context, parallel research, or specialized bundled/user/project agents.",
			'Use subagent with agentScope "project" or "both" only for trusted repositories because project agents are repo-controlled prompts.',
			"Use subagent chain tasks with {previous} only when each step should consume the previous agent output.",
		],
		parameters: SubagentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope, join(extensionDir, "agents"));
			const agents = discovery.agents;
			const makeDetails = (mode: "single" | "parallel" | "chain") => (results: SingleResult[]): SubagentDetails => ({
				mode,
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			});

			const hasSingle = Boolean(params.agent && params.task);
			const hasParallel = (params.tasks?.length ?? 0) > 0;
			const hasChain = (params.chain?.length ?? 0) > 0;
			const modeCount = Number(hasSingle) + Number(hasParallel) + Number(hasChain);

			if (modeCount !== 1) {
				return {
					content: [
						{
							type: "text",
							text: "Invalid subagent arguments. Use exactly one of: {agent,task} or {tasks} or {chain}.",
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && params.confirmProjectAgents !== false && ctx.hasUI) {
				const names = new Set<string>();
				if (params.agent) names.add(params.agent);
				for (const task of params.tasks ?? []) names.add(task.agent);
				for (const step of params.chain ?? []) names.add(step.agent);
				const projectAgents = Array.from(names)
					.map((name) => agents.find((agent) => agent.name === name))
					.filter((agent): agent is AgentConfig => agent !== undefined && agent.source === "project");
				if (projectAgents.length > 0) {
					const approved = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${projectAgents.map((entry) => entry.name).join(", ")}\nSource: ${discovery.projectAgentsDir ?? "(none)"}`,
					);
					if (!approved) {
						return {
							content: [
								{
									type: "text",
									text: "Canceled: project-local agents not approved.",
								},
							],
							details: makeDetails(modeCount === 1 && hasChain ? "chain" : hasParallel ? "parallel" : "single")([]),
						};
					}
				}
			}

			if (hasChain && params.chain) {
				const results: SingleResult[] = [];
				let previous = "";
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					if (!step) continue;
					const task = step.task.replace(/\{previous\}/g, previous);
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						task,
						step.cwd,
						i + 1,
						signal,
						onUpdate
							? (partial) => {
								const current = partial.details.results[0];
								if (!current) return;
								onUpdate({
									content: partial.content,
									details: {
										mode: "chain",
										agentScope,
										projectAgentsDir: discovery.projectAgentsDir,
										results: [...results, current],
									},
								});
							}
							: undefined,
						makeDetails("chain"),
					);
					results.push(result);
					if (isTaskError(result)) {
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${result.agent}): ${makePlaceholder(collectFinalOutput(result.messages) || result.stderr || "(no output)")}`,
								},
							],
							details: makeDetails("chain")(results),
						};
					}
					previous = collectFinalOutput(result.messages) || previous;
				}

				return {
					content: [
						{
							type: "text",
							text: collectFinalOutput(results.at(-1)?.messages ?? []) || "(no output)",
						},
					],
					details: makeDetails("chain")(results),
				};
			}

			if (hasParallel && params.tasks) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{ type: "text", text: `Too many parallel tasks; max is ${MAX_PARALLEL_TASKS}.` },
						],
						details: makeDetails("parallel")([]),
					};
				}

				const live: SingleResult[] = params.tasks.map((task) => ({
					agent: task.agent,
					agentSource: "unknown",
					task: task.task,
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				}));

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						task.agent,
						task.task,
						task.cwd,
						undefined,
						signal,
						onUpdate
							? (partial) => {
								const current = partial.details.results[0];
								if (!current) return;
								live[index] = current;
								onUpdate({
									content: partial.content,
									details: makeDetails("parallel")(live),
								});
							}
							: undefined,
						makeDetails("parallel"),
					);
					live[index] = result;
					return result;
				});

				const succeeded = results.filter((result) => !isTaskError(result)).length;
				const summary = results
					.map((result, index) => {
						const icon = isTaskError(result) ? "✗" : "✓";
						const output = makePlaceholder(
							collectFinalOutput(result.messages) || result.stderr || "(no output)",
						);
						return `${index + 1}. ${icon} ${result.agent} - ${output}`;
					})
					.join("\n");

				return {
					content: [
						{
							type: "text",
							text: `Parallel tasks: ${succeeded}/${results.length} succeeded\n\n${summary}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				if (isTaskError(result)) {
					return {
						content: [
							{
								type: "text",
								text: result.errorMessage || collectFinalOutput(result.messages) || "Subagent failed",
							},
						],
						details: makeDetails("single")([result]),
					};
				}
				return {
					content: [{ type: "text", text: collectFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";
			return {
				content: [
					{
						type: "text",
						text: `Invalid request. Available agents: ${available}`,
					},
				],
				details: makeDetails("single")([]),
			};
		},
		renderCall(args, theme) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					if (!step) continue;
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = makePlaceholder(cleanTask);
					text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.chain.length > 3) {
					text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				}
				return new Text(text, 0, 0);
			}

			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const task of args.tasks.slice(0, 3)) {
					const preview = makePlaceholder(task.task);
					text += `\n  ${theme.fg("accent", task.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) {
					text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				}
				return new Text(text, 0, 0);
			}

			const agentName = args.agent || "...";
			const preview = args.task ? makePlaceholder(args.task) : "...";
			const text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`) +
				`\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const renderDisplayItems = (items: DisplayItem[], limit?: number): string => {
				const visibleItems = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = skipped > 0 ? theme.fg("muted", `... ${skipped} earlier items\n`) : "";
				for (const item of visibleItems) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const single = details.results[0];
				if (!single) return new Text("(no output)", 0, 0);
				const isRunning = single.exitCode === -1 || (isPartial && single.exitCode === 0);
				const isError = !isRunning && isTaskError(single);
				const icon = isRunning ? theme.fg("warning", "⏳") : isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = collectDisplayItems(single.messages);
				const finalOutput = collectFinalOutput(single.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(single.agent))}${theme.fg("muted", ` (${single.agentSource})`)}`;
					if (isRunning) header += ` ${theme.fg("warning", "[running]")}`;
					if (isError && single.stopReason) header += ` ${theme.fg("error", `[${single.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && single.errorMessage) {
						container.addChild(new Text(theme.fg("error", `Error: ${single.errorMessage}`), 0, 0));
					}
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", single.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					for (const item of displayItems) {
						if (item.type === "toolCall") {
							container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
						}
					}
					if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					} else if (displayItems.length === 0) {
						container.addChild(new Text(theme.fg("muted", isRunning ? "(running...)" : "(no output)"), 0, 0));
					}
					const usage = formatUsageStats(single.usage, single.model);
					if (usage) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usage), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(single.agent))}${theme.fg("muted", ` (${single.agentSource})`)}`;
				if (isRunning) text += ` ${theme.fg("warning", "[running]")}`;
				if (isError && single.stopReason) text += ` ${theme.fg("error", `[${single.stopReason}]`)}`;
				if (isError && single.errorMessage) {
					text += `\n${theme.fg("error", `Error: ${single.errorMessage}`)}`;
				} else if (displayItems.length === 0) {
					text += `\n${theme.fg("muted", isRunning ? "(running...)" : "(no output)")}`;
				} else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usage = formatUsageStats(single.usage, single.model);
				if (usage) text += `\n${theme.fg("dim", usage)}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "chain") {
				const successCount = details.results.filter((entry) => entry.exitCode !== -1 && !isTaskError(entry)).length;
				const runningCount = details.results.filter((entry) => entry.exitCode === -1).length;
				const icon = runningCount > 0 ? theme.fg("warning", "⏳") : successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} steps`)}`, 0, 0));
					for (const entry of details.results) {
						const entryRunning = entry.exitCode === -1;
						const entryIcon = entryRunning ? theme.fg("warning", "⏳") : isTaskError(entry) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = collectDisplayItems(entry.messages);
						const finalOutput = collectFinalOutput(entry.messages);
						container.addChild(new Spacer(1));
						container.addChild(new Text(`${theme.fg("muted", `─── Step ${entry.step ?? "?"}: `)}${theme.fg("accent", entry.agent)} ${entryIcon}`, 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", entry.task), 0, 0));
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
							}
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						} else if (entryRunning) {
							container.addChild(new Text(theme.fg("muted", "(running...)"), 0, 0));
						}
						const usage = formatUsageStats(entry.usage, entry.model);
						if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
					}
					const totalUsage = formatAggregateUsageStats(details.results);
					if (totalUsage) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} steps`)}`;
				for (const entry of details.results) {
					const entryIcon = entry.exitCode === -1 ? theme.fg("warning", "⏳") : isTaskError(entry) ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const displayItems = collectDisplayItems(entry.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${entry.step ?? "?"}: `)}${theme.fg("accent", entry.agent)} ${entryIcon}`;
					if (displayItems.length === 0) {
						text += `\n${theme.fg("muted", entry.exitCode === -1 ? "(running...)" : "(no output)")}`;
					} else {
						text += `\n${renderDisplayItems(displayItems, 5)}`;
					}
				}
				const totalUsage = formatAggregateUsageStats(details.results);
				if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const runningCount = details.results.filter((entry) => entry.exitCode === -1).length;
				const successCount = details.results.filter((entry) => entry.exitCode !== -1 && !isTaskError(entry)).length;
				const failCount = details.results.filter((entry) => entry.exitCode !== -1 && isTaskError(entry)).length;
				const isRunning = runningCount > 0;
				const icon = isRunning ? theme.fg("warning", "⏳") : failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
				const status = isRunning ? `${successCount + failCount}/${details.results.length} done, ${runningCount} running` : `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0));
					for (const entry of details.results) {
						const entryIcon = isTaskError(entry) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = collectDisplayItems(entry.messages);
						const finalOutput = collectFinalOutput(entry.messages);
						container.addChild(new Spacer(1));
						container.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", entry.agent)} ${entryIcon}`, 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", entry.task), 0, 0));
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
							}
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
						const usage = formatUsageStats(entry.usage, entry.model);
						if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
					}
					const totalUsage = formatAggregateUsageStats(details.results);
					if (totalUsage) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const entry of details.results) {
					const entryIcon = entry.exitCode === -1 ? theme.fg("warning", "⏳") : isTaskError(entry) ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const displayItems = collectDisplayItems(entry.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", entry.agent)} ${entryIcon}`;
					if (displayItems.length === 0) {
						text += `\n${theme.fg("muted", entry.exitCode === -1 ? "(running...)" : "(no output)")}`;
					} else {
						text += `\n${renderDisplayItems(displayItems, 5)}`;
					}
				}
				if (!isRunning) {
					const totalUsage = formatAggregateUsageStats(details.results);
					if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const first = result.content[0];
			return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
		},
	});
}
