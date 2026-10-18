import * as fs from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
const resumeParser = Compile(Type.Object({ asyncId: Type.String({ minLength: 1 }) }, { additionalProperties: true }));

interface RecoveryFixtureAudit {
    event: "model-output" | "blocking" | "former-child-consumed" | "model-error" | "resumed-manager-entry" | "foreign-child-rejected" | "child-resumed" | "worker-continuation-complete";
    model?: string;
    childId?: string;
    content?: AssistantMessage["content"];
    error?: string;
}
/** Script the model only. SDK sessions, timeout, nested launch, recovery and resume stay native. */
export default function (pi: ExtensionAPI) {
    const audit = process.env.PI_SUBAGENTS_NATIVE_RECOVERY_AUDIT;
    if (!audit) throw new Error("The native recovery fixture audit path is required.");
    const append = (entry: RecoveryFixtureAudit) => fs.appendFileSync(audit, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
    pi.registerProvider("nested-recovery-fixture", {
        baseUrl: "http://unused.invalid", apiKey: "fixture", api: "openai-completions",
        models: ["parent", "manager", "worker"].map(id => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 })),
        streamSimple(model, context, options) {
            const stream = createAssistantMessageEventStream();
            void (async () => {
                const output: AssistantMessage = {
                    role: "assistant", api: model.api, provider: model.provider, model: model.id,
                    content: [], stopReason: "stop", timestamp: Date.now(),
                    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                };
                try {
                    const text = (message: { content: string | Array<{ type: string; text?: string }> }) => Array.isArray(message.content) ? message.content.map(part => part.text ?? "").join("\n") : message.content;
                    const results = context.messages.filter(message => message.role === "toolResult");
                    const users = context.messages.filter(message => message.role === "user").map(text).join("\n");
                    const resumedWorker = results.findLast(message => message.toolCallId === "resume-owned-child");
                    const waitedWorker = results.findLast(message => message.toolCallId === "wait-resumed-child");
                    const foreignResume = results.findLast(message => message.toolCallId === "resume-foreign-child");
                    const workerResult = results.findLast(message => message.toolCallId === "read-resumed-child-result");
                    if (model.id === "parent") {
                        output.content = [{ type: "text", text: "PARENT_READY" }];
                    } else if (model.id === "manager" && users.includes("RECOVERED_MANAGER")) {
                        const id = users.match(/RECOVERED_MANAGER ([0-9a-f-]{36})/)?.[1];
                        const foreignId = users.match(/FORBIDDEN_CHILD ([0-9a-f-]{36})/)?.[1];
                        if (!id || !foreignId) throw new Error("Recovered manager task omitted its exact fixture child IDs.");
                        const status = results.findLast(message => message.toolCallId === "inspect-old-child");
                        const foreign = results.findLast(message => message.toolCallId === "inspect-foreign-child");
                        if (!status) {
                            append({ event: "resumed-manager-entry", model: model.id });
                            output.content = [{ type: "toolCall", id: "inspect-old-child", name: "subagent", arguments: { action: "status", id } }];
                        } else if (status.isError || !text(status).includes("State: failed")) {
                            throw new Error("Recovered manager did not observe the former failed child: " + text(status));
                        } else if (!foreign) {
                            append({ event: "former-child-consumed", childId: id });
                            output.content = [{ type: "toolCall", id: "inspect-foreign-child", name: "subagent", arguments: { action: "status", id: foreignId } }];
                        } else if (!foreign.isError) {
                            throw new Error("Recovered manager accessed a foreign worker.");
                        } else if (!foreignResume) {
                            append({ event: "foreign-child-rejected", childId: foreignId });
                            output.content = [{ type: "toolCall", id: "resume-foreign-child", name: "subagent", arguments: { action: "resume", id: foreignId, message: "WORKER_CONTINUE" } }];
                        } else if (!foreignResume.isError) {
                            throw new Error("Recovered manager resumed a foreign worker.");
                        } else if (!resumedWorker) {
                            output.content = [{ type: "toolCall", id: "resume-owned-child", name: "subagent", arguments: { action: "resume", id, message: "WORKER_CONTINUE", timeoutMs: 10000 } }];
                        } else if (resumedWorker.isError) {
                            throw new Error("OWNED_CHILD_RESUME_REJECTED: " + text(resumedWorker));
                        } else if (!waitedWorker) {
                            const launched = resumeParser.Parse(resumedWorker.details);
                            append({ event: "child-resumed", childId: launched.asyncId });
                            output.content = [{ type: "toolCall", id: "wait-resumed-child", name: "bg_wait", arguments: { id: launched.asyncId, timeoutMs: 20000 } }];
                        } else if (!workerResult) {
                            if (waitedWorker.isError) throw new Error("The worker continuation wait failed: " + text(waitedWorker));
                            const resultFile = text(waitedWorker).match(/Result \[[^\]]+\]: ([^\n]+)/)?.[1];
                            if (!resultFile) throw new Error("Native bg_wait omitted the worker result reference.");
                            output.content = [{ type: "toolCall", id: "read-resumed-child-result", name: "read", arguments: { path: resultFile } }];
                        } else {
                            if (workerResult.isError || !text(workerResult).includes("CHILD_CONTINUATION_OK")) throw new Error("The actual worker result was not consumed: " + text(workerResult));
                            output.content = [{ type: "text", text: "RECOVERED_CHILD_STATUS_OK CHILD_CONTINUATION_CONSUMED" }];
                        }
                    } else if (model.id === "worker" && users.includes("WORKER_CONTINUE")) {
                        append({ event: "worker-continuation-complete", model: model.id });
                        output.content = [{ type: "text", text: "CHILD_CONTINUATION_OK" }];
                    } else if (model.id === "manager" && !results.some(message => message.toolName === "subagent")) {
                        const taskDir = process.env.PI_SUBAGENTS_NATIVE_RECOVERY_TASK_DIR;
                        if (!taskDir) throw new Error("The native task session directory is missing.");
                        output.content = [{ type: "toolCall", id: "launch-owned-worker", name: "subagent", arguments: { agent: "worker", task: "BLOCK_UNTIL_OWNER_TIMEOUT", cwd: taskDir, sessionDir: path.join(taskDir, ".task-artifacts", "sessions"), async: true, timeoutMs: 12000 } }];
                    } else {
                        append({ event: "blocking", model: model.id });
                        const signal = options?.signal;
                        if (!signal) throw new Error("Native fixture expected an abort signal.");
                        if (!signal.aborted) await new Promise<void>((resolve, reject) => {
                            // A pending Promise alone does not keep a detached Node runner alive; a real model stream has a live transport.
                            const timer = setTimeout(() => { signal.removeEventListener("abort", abort); reject(new Error("Fixture owner did not abort the model within its bound.")); }, 25000);
                            const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
                            signal.addEventListener("abort", abort, { once: true });
                            if (signal.aborted) abort();
                        });
                        output.stopReason = "aborted";
                        output.errorMessage = "Fixture owner timeout observed.";
                        stream.push({ type: "error", reason: "aborted", error: output });
                        stream.end();
                        return;
                    }
                    output.stopReason = output.content.some(part => part.type === "toolCall") ? "toolUse" : "stop";
                    append({ event: "model-output", model: model.id, content: output.content });
                    stream.push({ type: "start", partial: output });
                    stream.push({ type: "done", reason: output.stopReason, message: output });
                } catch (error) {
                    output.stopReason = "error";
                    output.errorMessage = error instanceof Error ? error.message : String(error);
                    append({ event: "model-error", model: model.id, error: output.errorMessage });
                    stream.push({ type: "error", reason: "error", error: output });
                }
                stream.end();
            })();
            return stream;
        },
    });
}
