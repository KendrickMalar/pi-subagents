import * as fs from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Script only the model; requests, replies, waits, reads and child runners are real. */
export default function (pi: ExtensionAPI) {
	const audit = process.env.PI_SUBAGENTS_SUPERVISOR_WAIT_AUDIT!;
	const append = (entry: Record<string, unknown>) => fs.appendFileSync(audit, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
	const childLaunches = new Map<string, string>();
	pi.on("tool_execution_start", (event, ctx) => {
		if (event.toolName === "bg_wait" && ctx.model?.id === "coordinator") {
			fs.writeFileSync(`${audit}.waiting`, "ready");
			append({ event: "wait-start" });
		}
	});
	pi.events.on("subagent:async-started", (event: unknown) => {
		const info = event as { id?: string; asyncDir?: string; agent?: string; agents?: string[] };
		if (info.asyncDir && (info.agent === "requester" || info.agents?.includes("requester"))) {
			if (info.id) childLaunches.set(info.id, info.asyncDir);
			append({ event: "child-launched", runId: info.id, asyncDir: info.asyncDir });
		}
	});
	pi.registerProvider("supervisor-wait-fixture", {
		baseUrl: "http://unused.invalid", apiKey: "fixture", api: "openai-completions",
		models: ["coordinator", "requester"].map(id => ({
			id, name: id, reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048,
		})),
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				const output: AssistantMessage = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: [], stopReason: "stop", timestamp: Date.now(),
					usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				try {
					const results = context.messages.filter(message => message.role === "toolResult");
					const textOf = (message: { content: Array<{ type: string; text?: string }> }) => message.content.map(part => part.text ?? "").join("\n");
					const failed = results.find(message => message.isError);
					if (failed) throw new Error(`Native supervisor fixture tool failed: ${textOf(failed)}`);
					const call = (name: string, args: ToolCall["arguments"]) => ({ type: "toolCall" as const, id: `${name}_${model.id}_${results.length}`, name, arguments: args });
					if (model.id === "requester") {
						const contact = results.find(message => message.toolName === "contact_supervisor");
						if (!contact) {
							const deadline = Date.now() + 6000;
							while (!fs.existsSync(`${audit}.waiting`)) {
								options?.signal?.throwIfAborted();
								if (Date.now() > deadline) throw new Error("Coordinator never entered its owned wait");
								await new Promise(resolve => setTimeout(resolve, 10));
							}
							append({ event: "request-issued" });
							output.content = [call("contact_supervisor", { reason: "need_decision", message: "Confirm readonly reporting only; no product edits or retries." })];
						} else {
							if (!textOf(contact).includes("APPROVED_READONLY")) throw new Error(`Requester did not receive the exact owner reply: ${textOf(contact)}`);
							append({ event: "reply-consumed" });
							fs.writeFileSync(`${audit}.reply-consumed`, "ready");
							output.content = [{ type: "text", text: "REQUESTER_READONLY_EVIDENCE" }];
						}
					} else {
						const spawned = results.find(message => message.toolName === "subagent");
						const waits = results.filter(message => message.toolName === "bg_wait");
						const pending = results.find(message => message.toolName === "subagent_supervisor" && textOf(message).startsWith("- "));
						const reply = results.find(message => message.toolName === "subagent_supervisor" && textOf(message).startsWith("Replied to supervisor request"));
						const read = results.find(message => message.toolName === "read");
						const proofCallIds = new Set<string>();
						for (const message of context.messages) {
							if (message.role !== "assistant") continue;
							for (const part of message.content) {
								if (part.type === "toolCall" && part.name === "read" && typeof part.arguments.path === "string" && part.arguments.path.endsWith("/process-terminal.json")) proofCallIds.add(part.id);
							}
						}
						const proofRead = results.find(message => message.toolName === "read" && proofCallIds.has(message.toolCallId));
						if (!spawned) {
							output.content = [
								{ type: "text", text: '```js workflow\nreturn await runs.run("requester", {agent:"requester",task:"Report readonly evidence after your supervisor confirms the scope.",output:false});\n```' },
								call("subagent", { workflow: true, async: true }),
							];
						} else {
							const runId = textOf(spawned).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)?.[0];
							if (!runId) throw new Error("Launch receipt lacks an exact run id");
							if (!waits.length) {
								output.content = [call("bg_wait", { id: runId, timeoutMs: 6000 })];
							} else if (!pending) {
								if (!/yielded for a pending supervisor request/i.test(textOf(waits[0]!))) throw new Error(`Wait did not yield for the live request: ${textOf(waits[0]!)}`);
								append({ event: "wait-yielded", workflowRunId: runId });
								output.content = [call("subagent_supervisor", { action: "pending" })];
							} else if (!reply) {
								const requestId = textOf(pending).match(/^- ([0-9a-f-]{36}):/m)?.[1];
								const childRunId = textOf(pending).match(/requester \[([0-9a-f-]{36})#0\]/)?.[1];
								if (!requestId || !childRunId) throw new Error("Owned requester is absent from pending");
								append({ event: "reply-issued", workflowRunId: runId, runId: childRunId, requestId });
								output.content = [call("subagent_supervisor", { action: "reply", replyTo: requestId, message: "APPROVED_READONLY: report only; no edits or retries." })];
							} else if (waits.length === 1) {
								// The reply receipt precedes the requester's actual consumption; wait for that native tool result.
								const deadline = Date.now() + 6000;
								while (!fs.existsSync(`${audit}.reply-consumed`)) {
									options?.signal?.throwIfAborted();
									if (Date.now() > deadline) throw new Error("Requester never consumed the owner reply");
									await new Promise(resolve => setTimeout(resolve, 10));
								}
								output.content = [call("bg_wait", { id: runId, timeoutMs: 6000 })];
							} else if (!read) {
								const reference = textOf(waits.at(-1)!).match(/^Result \[[^\]]+\]: (.+)$/m)?.[1];
								if (!reference) throw new Error(`Terminal wait lacks its result reference: ${textOf(waits.at(-1)!)}`);
								output.content = [call("read", { path: reference })];
							} else if (!proofRead) {
								const childRunId = textOf(pending!).match(/requester \[([0-9a-f-]{36})#0\]/)?.[1];
								const childDir = childRunId && childLaunches.get(childRunId);
								if (!childDir) throw new Error("Native launch omitted the owned requester's artifact directory");
								const proofPath = `${childDir}/process-terminal.json`;
								const deadline = Date.now() + 5000;
								while (JSON.parse(fs.readFileSync(proofPath, "utf8")).state === "pending") {
									options?.signal?.throwIfAborted();
									if (Date.now() > deadline) throw new Error("Requester close was not observed before coordinator final output");
									await new Promise(resolve => setTimeout(resolve, 10));
								}
								output.content = [call("read", { path: proofPath })];
							} else {
								if (!textOf(read).includes("REQUESTER_READONLY_EVIDENCE")) throw new Error("Coordinator did not consume the original child result");
								if (textOf(proofRead).match(/"state"\s*:\s*"([^"]+)"/)?.[1] !== "observed") throw new Error("Coordinator did not consume an observed native close proof");
								append({ event: "close-proof-consumed" });
								append({ event: "result-consumed", workflowRunId: runId, runId: textOf(pending!).match(/requester \[([0-9a-f-]{36})#0\]/)?.[1] });
								output.content = [{ type: "text", text: "COORDINATOR_CONSUMED_REPLY_AND_RESULT" }];
							}
						}
					}
					output.stopReason = output.content.some(part => part.type === "toolCall") ? "toolUse" : "stop";
					append({ event: "model-output", model: model.id, content: output.content });
					stream.push({ type: "start", partial: output });
					stream.push({ type: "done", reason: output.stopReason, message: output });
				} catch (error) {
					output.stopReason = options?.signal?.aborted ? "aborted" : "error";
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
