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
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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
		exitCode: 0,
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
			details: makeDetails([result]),
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

const AgentScopeSchema = Type.Union([
	Type.Literal("user"),
	Type.Literal("project"),
	Type.Literal("both"),
]);

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Single mode agent name" })),
	task: Type.Optional(Type.String({ description: "Single mode task text" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel mode task list" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Chain mode task list" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Confirm before running project agents" })),
	cwd: Type.Optional(Type.String({ description: "Default working directory for single mode" })),
});

export default function (pi: ExtensionAPI): void {
	pi.on("resources_discover", () => ({ promptPaths: [join(extensionDir, "prompts")] }));

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate tasks to specialized subagents. Supports single, parallel, and chain flows.",
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
								isError: true,
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
						isError: true,
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

				const succeeded = results.filter((result) => result.exitCode === 0).length;
				const summary = results
					.map((result, index) => {
						const icon = result.exitCode === 0 ? "✓" : "✗";
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
					isError: succeeded !== results.length,
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
						isError: true,
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
	});
}
