import * as fs from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Script only the model; launch, waits, nested resume, session files and reads are real. */
export default function (pi: ExtensionAPI) {
	const audit = process.env.PI_SUBAGENTS_NESTED_RESUME_AUDIT!;
	const append = (entry: Record<string, unknown>) => fs.appendFileSync(audit, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
	pi.registerProvider("nested-resume-fixture", {
		baseUrl: "http://unused.invalid", apiKey: "fixture", api: "openai-completions",
		models: ["parent", "coordinator", "worker"].map(id => ({
			id, name: id, reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048,
		})),
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				const output: AssistantMessage = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: [], stopReason: "stop", timestamp: Date.now(),
					usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				try {
					const textOf = (message: { content: string | Array<{ type: string; text?: string }> }) =>
						typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("\n");
					const results = context.messages.filter(message => message.role === "toolResult");
					const call = (name: string, args: ToolCall["arguments"]) => ({ type: "toolCall" as const, id: `${name}_${model.id}_${results.length}`, name, arguments: args });
					if (model.id === "parent") {
						const managed = results.find(message => message.toolName === "subagent");
						if (!managed) {
							output.content = [call("subagent", { agent: "coordinator", task: "Launch the worker, wait, then resume it once.", async: false })];
						} else {
							append({ event: "parent-saw", text: textOf(managed) });
							output.content = [{ type: "text", text: textOf(managed).includes("COORDINATOR_CONSUMED_RESUMED_WORKER") ? "PARENT_SAW_RESUMED_WORKER" : `PARENT_UNEXPECTED: ${textOf(managed).slice(0, 300)}` }];
						}
					} else if (model.id === "worker") {
						const resumes = context.messages.filter(message => message.role === "user" && textOf(message).includes("RESUME_PROMPT")).length;
						output.content = [{ type: "text", text: ["WORKER_FIRST_REPORT", "WORKER_RESUMED_WITH_MEMORY", "WORKER_RESUMED_TWICE"][Math.min(resumes, 2)]! }];
					} else {
						const failed = results.find(message => message.isError);
						if (failed) throw new Error(`Coordinator tool failed: ${textOf(failed)}`);
						const wanted = Number(process.env.PI_SUBAGENTS_NESTED_RESUME_TIMES ?? "1");
						const subagents = results.filter(message => message.toolName === "subagent");
						const [launch, ...resumes] = subagents;
						const waits = results.filter(message => message.toolName === "bg_wait");
						const reads = results.filter(message => message.toolName === "read");
						const uuid = (text: string) => text.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)?.[0];
						const revivedId = (text: string) => text.match(/^Revived run: ([0-9a-f-]{36})$/m)?.[1];
						const launchId = launch ? uuid(textOf(launch)) : undefined;
						const latestId = resumes.length === 0 ? launchId : revivedId(textOf(resumes[resumes.length - 1]!));
						if (!launch) {
							output.content = [call("subagent", { agent: "worker", task: "Report your first finding.", async: true })];
						} else if (!latestId) {
							throw new Error(`Receipt lacks a run id: ${textOf(subagents[subagents.length - 1]!)}`);
						} else if (waits.length === resumes.length) {
							append({ event: resumes.length === 0 ? "launched" : "resumed", runId: latestId, resumedId: latestId, text: textOf(subagents[subagents.length - 1]!) });
							output.content = [call("bg_wait", { id: latestId, timeoutMs: 15000 })];
						} else if (resumes.length > 0 && reads.length < resumes.length) {
							const reference = textOf(waits[waits.length - 1]!).match(/^Result \[[^\]]+\]: (.+)$/m)?.[1];
							if (!reference) throw new Error(`Resumed wait lacks a result reference: ${textOf(waits[waits.length - 1]!)}`);
							output.content = [call("read", { path: reference })];
						} else if (resumes.length < wanted) {
							output.content = [call("subagent", { action: "resume", id: latestId, message: `RESUME_PROMPT ${resumes.length + 1}: report again from the same session.` })];
						} else {
							const expected = wanted >= 2 ? "WORKER_RESUMED_TWICE" : "WORKER_RESUMED_WITH_MEMORY";
							const consumed = textOf(reads[reads.length - 1]!).includes(expected);
							append({ event: "consumed", consumed });
							output.content = [{ type: "text", text: consumed ? "COORDINATOR_CONSUMED_RESUMED_WORKER" : `UNEXPECTED: ${textOf(reads[reads.length - 1]!).slice(0, 200)}` }];
						}
					}
					output.stopReason = output.content.some(part => part.type === "toolCall") ? "toolUse" : "stop";
					append({ event: "model-output", model: model.id, content: output.content });
					stream.push({ type: "start", partial: output });
					stream.push({ type: "done", reason: output.stopReason, message: output });
				} catch (error) {
					output.stopReason = "error";
					output.errorMessage = error instanceof Error ? error.message : String(error);
					append({ event: "model-error", model: model.id, error: output.errorMessage });
					stream.push({ type: "error", reason: output.stopReason, error: output });
				}
				stream.end();
			})();
			return stream;
		},
	});
}
