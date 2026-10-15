import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../../src/agents/agents.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { DIRS, TEMP_ROOT_DIR, type SubagentState } from "../../src/shared/types.ts";
import { readStatus } from "../../src/shared/utils.ts";
import { readProcessTerminal } from "../../src/runs/background/process-terminal.ts";
import { waitForImportedAsyncRoot } from "../../src/runs/background/chain-root-attachment.ts";
import { inspectSessionLease } from "../../src/runs/shared/session-lease.ts";
import { resolveSubagentRunId } from "../../src/runs/background/run-id-resolver.ts";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

interface NestedFixtureOwner { rootId: string; childId: string; childDir: string }
const ownerEventParser = Compile(Type.Object({ parentRunId: Type.String(), child: Type.Object({ id: Type.String() }, { additionalProperties: true }) }, { additionalProperties: true }));
const auditParser = Compile(Type.Object({ event: Type.String(), model: Type.Optional(Type.String()), childId: Type.Optional(Type.String()) }, { additionalProperties: true }));

function waitForClose(dir: string, runId: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const finish = (error?: Error) => { watcher.close(); signal.removeEventListener("abort", abort); if (error) reject(error); else resolve(); };
        const check = () => { const proof = readProcessTerminal(dir, { runId }); if (proof?.state === "observed") finish(); else if (proof?.state === "unknown") finish(new Error("Native runner close is unverified: " + proof.reason)); };
        const abort = () => finish(new Error("Fixture close wait aborted.", { cause: signal.reason }));
        const watcher = fs.watch(dir, check);
        watcher.on("error", finish);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort(); else check();
    });
}
function nestedOwner(managerId: string): NestedFixtureOwner {
    const base = path.join(TEMP_ROOT_DIR, "nested-subagent-runs");
    for (const rootId of fs.readdirSync(base)) for (const childId of fs.readdirSync(path.join(base, rootId))) {
        const childDir = path.join(base, rootId, childId);
        const descriptor = path.join(childDir, "run-fanout-budget.json");
        if (!fs.existsSync(descriptor)) continue;
        const events = path.join(TEMP_ROOT_DIR, "nested-subagent-events");
        const dirs = fs.readdirSync(events).filter(name => name.startsWith(rootId + "-"));
        for (const name of dirs) {
            const eventDir = path.join(events, name, "events");
            for (const eventName of fs.readdirSync(eventDir)) {
                const event: unknown = JSON.parse(fs.readFileSync(path.join(eventDir, eventName), "utf8"));
                if (ownerEventParser.Check(event) && event.parentRunId === managerId && event.child.id === childId) return { rootId, childId, childDir };
            }
        }
    }
    throw new Error("Native manager did not launch its nested worker.");
}
function text(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content.map(part => part.text ?? "").join("\n");
}

it("original SDK parent recovers a timed-out native manager and the revived manager consumes its former child status", {
    skip: !process.env.PI_SUBAGENTS_NATIVE_PI_ROOT && "Requires the native host SDK and native-peer-loader.mjs",
    timeout: 65000,
}, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-recover-"));
    const agentDir = path.join(root, "agent");
    const extension = fileURLToPath(new URL("../fixtures/native-nested-recovery-provider.ts", import.meta.url));
    const audit = path.join(root, "audit.jsonl");
    const trace = (stage: string) => {
        const dir = process.env.PI_SUBAGENTS_RECOVERY_EVIDENCE_DIR;
        if (dir) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            fs.appendFileSync(path.join(dir, "stages.jsonl"), JSON.stringify({ stage, at: Date.now(), root }) + "\n");
        }
        t.diagnostic(stage);
    };
    trace("fixture-created");
    const saved = { ...process.env };
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_OFFLINE = "1";
    process.env.PI_SUBAGENTS_NATIVE_RECOVERY_AUDIT = audit;
    fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
    for (const agent of ["manager", "worker"]) {
        fs.writeFileSync(path.join(root, ".pi", "agents", agent + ".md"), [
            "---", "name: " + agent, "description: Native recovery fixture", "model: nested-recovery-fixture/" + agent,
            "tools: " + (agent === "manager" ? "read, subagent, bg_wait" : "read"), "extensions: " + extension,
            "allowNestedSubagents: " + (agent === "manager"), ...(agent === "manager" ? ["allowedAgents: worker"] : []),
            "inheritGlobalContext: false", "inheritProjectContext: false", "inheritSkills: false", "acceptanceRole: read-only", "---", "Only execute the native recovery fixture.",
        ].join("\n"));
    }
    let api: ExtensionAPI | undefined;
    let context: ExtensionContext | undefined;
    const resources = new DefaultResourceLoader({ cwd: root, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: [extension], extensionFactories: [pi => { api = pi; pi.on("session_start", (_event, ctx) => { context = ctx; }); }] });
    trace("resource-reload-start");
    await resources.reload();
    trace("resource-reload-done");
    const model: Model<"openai-completions"> = { id: "parent", name: "parent", api: "openai-completions", provider: "nested-recovery-fixture", baseUrl: "http://unused.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 };
    trace("create-session-start");
    const { session } = await createAgentSession({ cwd: root, resourceLoader: resources, sessionManager: SessionManager.create(root, path.join(root, "parent-sessions")), model });
    trace("create-session-done");
    t.signal.addEventListener("abort", () => { void session.abort().catch(() => trace("session-abort-failed")); }, { once: true });
    const runs: Array<{ id: string; dir: string }> = [];
    try {
        trace("bind-extensions-start");
        await session.bindExtensions({});
        trace("bind-extensions-done");
        await session.prompt("PARENT_READY");
        trace("parent-ready");
        assert.ok(api && context, "The actual SDK parent must supply its extension API and context.");
        const parentApi = api;
        const ctx = context;
        const parentSession = ctx.sessionManager.getSessionFile();
        assert.ok(parentSession && fs.existsSync(parentSession));
        const state: SubagentState = { baseCwd: root, currentSessionId: parentSession, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
        // SAFETY: the optional comparison module is an archived approved base with this same executor export; missing/incompatible exports fail the fixture.
        const executorModule = process.env.PI_SUBAGENTS_RECOVERY_BASE_ROOT
            ? await import(pathToFileURL(path.join(process.env.PI_SUBAGENTS_RECOVERY_BASE_ROOT, "src/runs/foreground/subagent-executor.ts")).href) as { createSubagentExecutor: typeof createSubagentExecutor }
            : { createSubagentExecutor };
        const executor = executorModule.createSubagentExecutor({ pi: parentApi, state, config: { maxSubagentDepth: 3, intercomBridge: { enabled: false } },
            asyncByDefault: true, tempArtifactsDir: root, getSubagentSessionRoot: () => path.join(root, "child-sessions"), expandTilde: value => value,
            discoverAgents: (cwd, scope) => discoverAgents(cwd, scope) });
        const foreign = await executor.execute("launch-foreign-manager", { agent: "manager", task: "START_CHILD_THEN_STAY_OPEN", async: true, timeoutMs: 8000, sessionDir: path.join(root, "foreign-sessions") }, undefined, undefined, ctx);
        assert.notEqual(foreign.isError, true, text(foreign));
        const foreignManagerId = foreign.details.asyncId;
        assert.ok(foreignManagerId);
        const foreignDir = path.join(DIRS.async, foreignManagerId);
        runs.push({ id: foreignManagerId, dir: foreignDir });
        trace("manager-launch-start");
        const start = await executor.execute("launch-native-manager", { agent: "manager", task: "START_CHILD_THEN_STAY_OPEN", async: true, timeoutMs: 8000, sessionDir: path.join(root, "child-sessions") }, undefined, undefined, ctx);
        trace("manager-launch-done");
        assert.notEqual(start.isError, true, text(start));
        const managerId = start.details.asyncId;
        assert.ok(managerId);
        const managerDir = path.join(DIRS.async, managerId);
        runs.push({ id: managerId, dir: managerDir });
        const result = await waitForImportedAsyncRoot({ runId: managerId, asyncDir: managerDir, resultPath: path.join(DIRS.results, managerId + ".json"), index: 0 }, { pollIntervalMs: 50, shouldAbort: () => t.signal.aborted || readProcessTerminal(managerDir)?.state === "unknown" });
        assert.notEqual(result.exitCode, 0, "The original manager must actually fail, not simulate success.");
        await waitForClose(managerDir, managerId, AbortSignal.timeout(10000));
        trace("manager-closed");
        const original = readStatus(managerDir);
        assert.equal(original?.state, "failed");
        const child = nestedOwner(managerId);
        await waitForClose(child.childDir, child.childId, AbortSignal.timeout(15000));
        trace("worker-closed");
        assert.equal(readStatus(child.childDir)?.state, "failed");
        const beforeProof = fs.readFileSync(path.join(child.childDir, "process-terminal.json"));
        await waitForClose(foreignDir, foreignManagerId, AbortSignal.timeout(15000));
        const foreignChild = nestedOwner(foreignManagerId);
        const foreignId = foreignChild.childId;
        await waitForClose(foreignChild.childDir, foreignId, AbortSignal.timeout(15000));
        assert.notEqual(foreignChild.rootId, child.rootId);
        const rootsBeforeRecovery = fs.readdirSync(DIRS.async).sort();
        const auditBeforeRecovery = fs.readFileSync(audit, "utf8");
        const recovered = await executor.execute("recover-native-owner", { action: "recover", id: managerId, nestedRootRunId: child.rootId }, undefined, undefined, ctx);
        trace("recover-returned");
        assert.notEqual(recovered.isError, true, text(recovered));
        const details = recovered.details;
        assert.equal(details.recovery?.status, "recovered");
        assert.equal(details.recovery.descendants.find(entry => entry.id === child.childId)?.resumable, true);
        assert.deepEqual(fs.readFileSync(path.join(child.childDir, "process-terminal.json")), beforeProof);
        assert.deepEqual(fs.readdirSync(DIRS.async).sort(), rootsBeforeRecovery, "Recover alone must not allocate a native runner.");
        assert.equal(fs.readFileSync(audit, "utf8"), auditBeforeRecovery, "Recover alone must not execute a model.");
        assert.equal(resolveSubagentRunId(child.childId, { state })?.kind, "nested");
        const attempts = await Promise.all(["first", "competing"].map(label => executor.execute("resume-native-manager-" + label, { action: "resume", id: managerId, message: "RECOVERED_MANAGER " + child.childId + " FORBIDDEN_CHILD " + foreignId, timeoutMs: 20000 }, undefined, undefined, ctx)));
        trace("resume-returned");
        assert.equal(attempts.filter(attempt => attempt.isError === true).length, 1, "Exactly one concurrent resume must be rejected.");
        const accepted = attempts.filter(attempt => attempt.isError !== true);
        assert.equal(accepted.length, 1, "Exactly one concurrent resume may dispatch.");
        const resumed = accepted[0];
        assert.ok(resumed);
        assert.notEqual(resumed.isError, true, text(resumed));
        const revived = resumed.details.asyncId;
        assert.ok(revived);
        const revivedDir = path.join(DIRS.async, revived);
        runs.push({ id: revived, dir: revivedDir });
        const finished = await waitForImportedAsyncRoot({ runId: revived, asyncDir: revivedDir, resultPath: path.join(DIRS.results, revived + ".json"), index: 0 }, { pollIntervalMs: 50, shouldAbort: () => t.signal.aborted || readProcessTerminal(revivedDir)?.state === "unknown" });
        await waitForClose(revivedDir, revived, AbortSignal.timeout(10000));
        trace("revival-closed");
        assert.equal(finished.exitCode, 0, finished.error ?? finished.output);
        assert.match(finished.output, /RECOVERED_CHILD_STATUS_OK/);
        const final = readStatus(revivedDir);
        assert.ok(final?.steps?.[0]?.sessionFile);
        assert.equal(inspectSessionLease(final.steps[0].sessionFile).state, "free");
        const events = fs.readFileSync(audit, "utf8").trim().split("\n").map(line => auditParser.Parse(JSON.parse(line)));
        assert.ok(events.some(event => event.event === "blocking" && event.model === "worker"));
        assert.ok(events.some(event => event.event === "former-child-consumed" && event.childId === child.childId));
        assert.ok(events.some(event => event.event === "foreign-child-rejected" && event.childId === foreignId));
        assert.equal(events.filter(event => event.event === "resumed-manager-entry").length, 1, "The lease must prevent a second native manager dispatch.");
        assert.equal(readStatus(foreignChild.childDir)?.state, "failed");
        assert.equal(readStatus(foreignDir)?.state, "failed");
        assert.equal(readStatus(managerDir)?.state, "failed", "Recovery must not falsify the original failure.");
        trace("revival-lease-free");
        const evidence = process.env.PI_SUBAGENTS_RECOVERY_EVIDENCE_DIR;
        if (evidence) {
            fs.copyFileSync(audit, path.join(evidence, "audit.jsonl"));
            fs.copyFileSync(path.join(managerDir, "process-terminal.json"), path.join(evidence, "manager-terminal.json"));
            fs.copyFileSync(path.join(child.childDir, "process-terminal.json"), path.join(evidence, "worker-terminal.json"));
            fs.copyFileSync(path.join(revivedDir, "process-terminal.json"), path.join(evidence, "revived-terminal.json"));
            fs.writeFileSync(path.join(evidence, "success.json"), JSON.stringify({ status: "pass", managerId, childId: child.childId, revived, originalState: "failed", revivedExit: finished.exitCode, lease: "free" }) + "\n");
        }
    } catch (error) {
        const evidence = process.env.PI_SUBAGENTS_RECOVERY_EVIDENCE_DIR;
        if (evidence) {
            fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
            fs.cpSync(root, path.join(evidence, "parent-fixture"), { recursive: true });
            for (const run of runs) if (fs.existsSync(run.dir)) fs.cpSync(run.dir, path.join(evidence, run.id), { recursive: true });
        }
        throw error;
    } finally {
        session.dispose();
        for (const key of ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SUBAGENTS_NATIVE_RECOVERY_AUDIT"]) {
            if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
        }
        // The isolated suite owns cleanup. Failure evidence, when requested, is outside its auto-cleaned root.
    }
});
