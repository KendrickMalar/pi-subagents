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
						const users = context.messages.filter(message => message.role === "user");
						const resumed = users.some(message => textOf(message).includes("RESUME_PROMPT"));
						output.content = [{ type: "text", text: resumed ? "WORKER_RESUMED_WITH_MEMORY" : "WORKER_FIRST_REPORT" }];
					} else {
						const failed = results.find(message => message.isError);
						if (failed) throw new Error(`Coordinator tool failed: ${textOf(failed)}`);
						const launch = results.find(message => message.toolName === "subagent");
						const waits = results.filter(message => message.toolName === "bg_wait");
						const resume = results.filter(message => message.toolName === "subagent")[1];
						const read = results.find(message => message.toolName === "read");
						const uuid = (text: string) => text.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)?.[0];
						if (!launch) {
							output.content = [call("subagent", { agent: "worker", task: "Report your first finding.", async: true })];
						} else if (waits.length === 0) {
							const runId = uuid(textOf(launch));
							if (!runId) throw new Error(`Launch receipt lacks a run id: ${textOf(launch)}`);
							append({ event: "launched", runId, text: textOf(launch) });
							output.content = [call("bg_wait", { id: runId, timeoutMs: 15000 })];
						} else if (!resume) {
							const runId = uuid(textOf(launch))!;
							append({ event: "first-wait", text: textOf(waits[0]!) });
							output.content = [call("subagent", { action: "resume", id: runId, message: "RESUME_PROMPT: report again from the same session." })];
						} else if (waits.length === 1) {
							const resumedId = textOf(resume).match(/^Revived run: ([0-9a-f-]{36})$/m)?.[1];
							append({ event: "resumed", resumedId, text: textOf(resume) });
							append({ event: "resume-receipt", text: textOf(resume) });
							if (!resumedId) throw new Error(`Resume receipt lacks a run id: ${textOf(resume)}`);
							output.content = [call("bg_wait", { id: resumedId, timeoutMs: 15000 })];
						} else if (!read) {
							const reference = textOf(waits[waits.length - 1]!).match(/^Result \[[^\]]+\]: (.+)$/m)?.[1];
							if (!reference) throw new Error(`Resumed wait lacks a result reference: ${textOf(waits[waits.length - 1]!)}`);
							output.content = [call("read", { path: reference })];
						} else {
							const consumed = textOf(read).includes("WORKER_RESUMED_WITH_MEMORY");
							append({ event: "consumed", consumed });
							output.content = [{ type: "text", text: consumed ? "COORDINATOR_CONSUMED_RESUMED_WORKER" : `UNEXPECTED: ${textOf(read).slice(0, 200)}` }];
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
