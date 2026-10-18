import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSubagentExecutor, validateNestedSessionFile } from "../../src/runs/foreground/subagent-executor.ts";
import { createNestedRoute, projectNestedEvents, readNestedRegistry, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { createRunFanoutBudget, writeRunFanoutBudgetDescriptor } from "../../src/runs/shared/run-fanout-budget.ts";
import { finalizeProcessTerminal, initializeProcessTerminal, writeProcessTerminalCandidate } from "../../src/runs/background/process-terminal.ts";
import { acquireSessionLease, inspectSessionLease, SESSION_LEASES_DIR } from "../../src/runs/shared/session-lease.ts";
import { resolveSubagentRunId } from "../../src/runs/background/run-id-resolver.ts";
import { DIRS, TEMP_ROOT_DIR, type AsyncStatus, type SubagentState } from "../../src/shared/types.ts";
import { readStatus } from "../../src/shared/utils.ts";
import { readProcessTerminal } from "../../src/runs/background/process-terminal.ts";
import type { ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";
import { recoveredNestedBinding } from "../../src/runs/background/nested-recovery.ts";
import { buildRunnerChildLaunch } from "../../src/runs/background/runner-child-launch.ts";
import { inheritedChildRuntime } from "../../src/runs/shared/child-launch.ts";
import { recoveredSessionFileForRun } from "../../src/runs/shared/recovered-nested-session.ts";
import { readAsyncRecoveryDescriptor } from "../../src/runs/background/async-resume.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run(); });

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "recover-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const ownerRunId = randomUUID();
    const childId = randomUUID();
    const nestedRootRunId = randomUUID();
    const route = createNestedRoute(nestedRootRunId);
    cleanup.push(() => fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true }));
    const ownerDir = path.join(DIRS.async, ownerRunId);
    const childDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", nestedRootRunId, childId);
    fs.mkdirSync(ownerDir, { recursive: true });
    fs.mkdirSync(childDir, { recursive: true });
    cleanup.push(() => fs.rmSync(ownerDir, { recursive: true, force: true }));
    cleanup.push(() => fs.rmSync(path.dirname(childDir), { recursive: true, force: true }));
    const parentSessionFile = path.join(root, "parent.jsonl");
    const managerSessionFile = path.join(root, "manager.jsonl");
    const childSessionFile = path.join(root, childId, "run-0", "session.jsonl");
    fs.mkdirSync(path.dirname(childSessionFile), { recursive: true });
    for (const file of [parentSessionFile, managerSessionFile, childSessionFile]) {
        fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), cwd: root })}\n`);
    }
    const budget = createRunFanoutBudget(randomUUID(), 32);
    cleanup.push(() => fs.rmSync(budget.directory, { recursive: true, force: true }));
    writeRunFanoutBudgetDescriptor(ownerDir, { ...budget, parentPath: "workflow[manager]" });
    writeRunFanoutBudgetDescriptor(childDir, { ...budget, parentPath: "workflow[manager]/coder" });
    function status(dir: string, id: string, agent: string, sessionFile: string) {
        const value: AsyncStatus = {
            runId: id, sessionId: parentSessionFile, mode: "single", state: "failed", startedAt: 1, endedAt: 3,
            launchContractDigest: "f".repeat(64), cwd: root, currentStep: 0, steps: [{ agent, status: "failed", sessionFile, exitCode: 1 }],
        };
        fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(value));
        const instance = randomUUID();
        initializeProcessTerminal(dir, id, instance);
        writeProcessTerminalCandidate(dir, {
            version: 1, runId: id, runnerProcessInstanceId: instance, writers: { "0": [] }, expectedWriters: { "0": 0 },
        });
        finalizeProcessTerminal(dir, id, { processInstanceId: instance, closeObservedAt: 4, exitCode: 0, signal: null });
    }
    status(ownerDir, ownerRunId, "coding-manager", managerSessionFile);
    status(childDir, childId, "coder", childSessionFile);
    writeNestedEvent(route, { type: "subagent.nested.started", ts: 1, parentRunId: ownerRunId, parentStepIndex: 0,
        child: { id: childId, parentRunId: ownerRunId, parentStepIndex: 0, depth: 1,
            path: [{ runId: ownerRunId, stepIndex: 0 }], state: "running", agent: "coder", asyncDir: childDir, lastUpdate: 1 } });
    projectNestedEvents(route);
    writeNestedEvent(route, { type: "subagent.nested.completed", ts: 3, parentRunId: ownerRunId, parentStepIndex: 0,
        child: { id: childId, parentRunId: ownerRunId, parentStepIndex: 0, depth: 1,
            path: [{ runId: ownerRunId, stepIndex: 0 }], state: "failed", agent: "coder", asyncDir: childDir,
            sessionFile: childSessionFile, lastUpdate: 3 } });
    const state: SubagentState = { baseCwd: root, currentSessionId: parentSessionFile, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
    function executor(childSafe = false, childRuntime?: ChildRuntimeConfig, executorState = state) {
        // SAFETY: this unit double supplies the event and session-name members used by the recovery/status executor; native integration supplies the complete SDK API.
        return createSubagentExecutor({
            pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as ExtensionAPI,
            state: executorState, childRuntime, config: {}, asyncByDefault: false, tempArtifactsDir: root, getSubagentSessionRoot: () => root,
            expandTilde: value => value, discoverAgents: () => ({ agents: [] }), allowMutatingManagementActions: !childSafe,
        });
    }
    function ctx(sessionFile = parentSessionFile) {
        // SAFETY: recovery/status reads cwd, hasUI, session identity and available models only; the native test exercises the complete SDK context.
        return { cwd: root, hasUI: false, sessionManager: { getSessionId() { return "fixture-parent"; }, getSessionFile() { return sessionFile; } }, modelRegistry: { getAvailable() { return []; } } } as ExtensionContext;
    }
    async function recover(options: { childSafe?: boolean; sessionFile?: string; id?: string; rootId?: string; extra?: { force?: boolean; timeoutMs?: number; model?: string } } = {}) {
        const input = { action: "recover", id: options.id ?? ownerRunId, nestedRootRunId: options.rootId ?? nestedRootRunId, ...options.extra };
        return executor(options.childSafe).execute("fixture-recover", input, undefined, undefined, ctx(options.sessionFile));
    }
    return { root, ownerRunId, childId, nestedRootRunId, route, ownerDir, childDir, parentSessionFile, managerSessionFile, childSessionFile, state, recover, executor, ctx, budget };
}

async function recoveredSessionFixture() {
    const f = fixture();
    fs.writeFileSync(path.join(f.childDir, "recovery-descriptor.json"), JSON.stringify({
        version: 1, launchContractDigest: "f".repeat(64), sourceRunId: f.childId, agent: "coder", cwd: f.root,
        sessionFile: f.childSessionFile, sessionDir: path.join(f.root, f.childId, "async-" + f.childId),
        systemPromptMode: "replace", outputMode: "inline", inheritProjectContext: false, inheritSkills: false,
        share: false, maxSubagentDepth: 3, runFanoutBudget: { ...f.budget, parentPath: "workflow[manager]/coder" },
    }));
    assert.notEqual((await f.recover()).isError, true);
    const binding = recoveredNestedBinding(f.state, f.managerSessionFile, "coding-manager");
    assert.ok(binding?.sessions[0]);
    const run = readNestedRegistry(f.route).children[0];
    assert.ok(run);
    const descriptor = readAsyncRecoveryDescriptor(f.childDir);
    assert.ok(descriptor);
    return { ...f, binding, input: { run, rootRunId: f.nestedRootRunId, dir: f.childDir, descriptor, nativeOwnerRunId: f.ownerRunId, nativeSessions: binding.sessions } };
}
function resultText(value: Awaited<ReturnType<ReturnType<typeof fixture>["recover"]>>) {
    return value.content.filter(part => part.type === "text").map(part => part.text).join("\n");
}

function recoveryReport(value: Awaited<ReturnType<ReturnType<typeof fixture>["recover"]>>) {
    return value.details.recovery;
}

describe("parent-scoped nested recovery", () => {
    it("keeps exact-session grants native-only and does not inherit them to grandchildren", async () => {
        const f = await recoveredSessionFixture();
        const context = { cwd: f.root, id: randomUUID(), flatIndex: 0, nestedRoute: f.route, recoveredNestedParentRunId: f.ownerRunId, recoveredNestedSessions: f.binding.sessions };
        const step = { agent: "coding-manager", task: "recover", tools: ["subagent"], allowNestedSubagents: true, allowedAgents: ["coder"], inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false };
        const launch = buildRunnerChildLaunch(step, context, { sessionEnabled: false, watchdogStatus() {} });
        assert.deepEqual(launch.config.recoveredNestedSessions, f.binding.sessions);
        assert.throws(() => buildRunnerChildLaunch(step, { ...context, recoveredNestedSessions: [...f.binding.sessions, ...f.binding.sessions] }, { sessionEnabled: false, watchdogStatus() {} }), /duplicate run identity/);
        assert.equal(Object.hasOwn(inheritedChildRuntime(launch.config) ?? {}, "recoveredNestedSessions"), false);
        assert.throws(() => buildRunnerChildLaunch(step, { ...context, recoveredNestedParentRunId: undefined }, { sessionEnabled: false, watchdogStatus() {} }), /recovered ownership/);
    });
    it("does not authorize another run in the same recovered root", async () => {
        const f = await recoveredSessionFixture();
        const other = { ...f.input.run, id: randomUUID() };
        const exact = recoveredSessionFileForRun({ ...f.input, run: other });
        assert.equal(exact, undefined);
        assert.throws(() => validateNestedSessionFile(other, [], f.input.descriptor, exact), /outside trusted/);
    });
    for (const changed of ["descriptor", "file"] as const) {
        it("rejects evidence changed while validation is in progress: " + changed, async t => {
            const f = await recoveredSessionFixture();
            const read = fsDefault.readFileSync;
            let injected = false;
            const trigger = path.join(f.childDir, changed === "descriptor" ? "status.json" : "recovery-descriptor.json");
            t.mock.method(fsDefault, "readFileSync", (...args: Parameters<typeof fsDefault.readFileSync>) => {
                const bytes = read(...args);
                if (!injected && String(args[0]) === trigger) {
                    injected = true;
                    if (changed === "descriptor") fs.appendFileSync(path.join(f.childDir, "recovery-descriptor.json"), " ");
                    else {
                        const contents = read(f.childSessionFile);
                        fs.renameSync(f.childSessionFile, f.childSessionFile + ".replaced");
                        fs.writeFileSync(f.childSessionFile, contents);
                    }
                }
                return bytes;
            });
            syncBuiltinESMExports();
            t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
            assert.throws(() => recoveredSessionFileForRun(f.input), /session/);
            assert.equal(injected, true);
            assert.equal(f.state.asyncJobs.size, 0);
            assert.equal(inspectSessionLease(f.parentSessionFile).state, "free");
        });
    }
    it("admits the verified exact file outside ordinary roots without extending them", async () => {
        const f = await recoveredSessionFixture();
        const roots: string[] = [];
        assert.throws(() => validateNestedSessionFile(f.input.run, roots, f.input.descriptor), /outside trusted/);
        const exact = recoveredSessionFileForRun(f.input);
        assert.equal(validateNestedSessionFile(f.input.run, roots, f.input.descriptor, exact), fs.realpathSync(f.childSessionFile));
        assert.deepEqual(roots, []);
        assert.equal(recoveredSessionFileForRun({ ...f.input, nativeOwnerRunId: undefined }), undefined);
    });
    for (const wrong of ["root", "owner", "agent", "recorded-file", "descriptor", "replaced-file", "symlink"] as const) {
        it("rejects changed recovered session evidence: " + wrong, async () => {
            const f = await recoveredSessionFixture();
            if (wrong === "root") f.input.rootRunId = randomUUID();
            if (wrong === "owner") f.input.nativeOwnerRunId = randomUUID();
            if (wrong === "agent") f.input.run.agent = "other-agent";
            if (wrong === "recorded-file") f.input.run.sessionFile = f.parentSessionFile;
            if (wrong === "descriptor") fs.appendFileSync(path.join(f.childDir, "recovery-descriptor.json"), "\\n");
            if (wrong === "replaced-file") {
                const bytes = fs.readFileSync(f.childSessionFile);
                fs.renameSync(f.childSessionFile, f.childSessionFile + ".old");
                fs.writeFileSync(f.childSessionFile, bytes);
            }
            if (wrong === "symlink") {
                fs.renameSync(f.childSessionFile, f.childSessionFile + ".old");
                fs.symlinkSync(f.childSessionFile + ".old", f.childSessionFile);
            }
            assert.throws(() => recoveredSessionFileForRun(f.input), /session/);
        });
    }
    it("captures only the verified custom-path child session in its private binding", async () => {
        const f = fixture();
        fs.writeFileSync(path.join(f.childDir, "recovery-descriptor.json"), JSON.stringify({
            version: 1, launchContractDigest: "f".repeat(64), sourceRunId: f.childId, agent: "coder", cwd: f.root, sessionFile: f.childSessionFile,
            sessionDir: path.join(f.root, f.childId, "async-" + f.childId),
            systemPromptMode: "replace", outputMode: "inline", inheritProjectContext: false,
            inheritSkills: false, share: false, maxSubagentDepth: 3,
            runFanoutBudget: { ...f.budget, parentPath: "workflow[manager]/coder" },
        }));
        const result = await f.recover();
        assert.notEqual(result.isError, true, resultText(result));
        const binding = recoveredNestedBinding(f.state, f.managerSessionFile, "coding-manager");
        assert.equal(binding?.sessions?.[0]?.canonicalSessionFile, fs.realpathSync(f.childSessionFile));
        assert.equal(binding?.sessions?.[0]?.runId, f.childId);
        assert.equal(binding?.sessions?.length, 1);
        assert.equal(f.state.asyncJobs.size, 0);
    });
    it("refuses a redirected lease namespace before taking reservations", async () => {
        const f = fixture();
        const original = path.join(f.root, "original-leases");
        const redirected = path.join(f.root, "redirected-leases");
        fs.mkdirSync(SESSION_LEASES_DIR, { recursive: true });
        fs.mkdirSync(redirected);
        fs.renameSync(SESSION_LEASES_DIR, original);
        fs.symlinkSync(redirected, SESSION_LEASES_DIR, "dir");
        cleanup.push(() => { fs.unlinkSync(SESSION_LEASES_DIR); fs.renameSync(original, SESSION_LEASES_DIR); });
        const result = await f.recover();
        assert.equal(recoveryReport(result)?.code, "PATH_ESCAPE");
        assert.deepEqual(fs.readdirSync(redirected), []);
        assert.equal(f.state.retainedNestedLookupRoutes, undefined);
    });
    it("blocks a contender that acquires the session between preflight and publication", async t => {
        const f = fixture();
        const exists = fsDefault.existsSync;
        let attempted = false;
        t.mock.method(fsDefault, "existsSync", (file: fs.PathLike) => {
            if (!attempted && String(file) === path.join(f.ownerDir, "nested-recovery.json")) {
                attempted = true;
                const lease = acquireSessionLease({ sessionFile: f.managerSessionFile, runId: "competing-resume", sourceRunId: f.childId });
                cleanup.push(() => { lease.release(); });
            }
            return exists(file);
        });
        syncBuiltinESMExports();
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
        const result = await f.recover();
        assert.equal(attempted, true);
        assert.equal(recoveryReport(result)?.code, "SESSION_OWNED");
        assert.equal(f.state.retainedNestedLookupRoutes, undefined);
        assert.equal(readNestedRegistry(f.route).children[0]?.state, "running");
        assert.equal(exists(path.join(f.ownerDir, "nested-recovery.json")), false);
        assert.equal(inspectSessionLease(f.childSessionFile).state, "free", "A partial reservation must be released when a later claim fails.");
    });

    it("rechecks terminal proof after preflight before publishing", async t => {
        const f = fixture();
        const exists = fsDefault.existsSync;
        const proof = readProcessTerminal(f.childDir);
        assert.ok(proof);
        let changed = false;
        t.mock.method(fsDefault, "existsSync", (file: fs.PathLike) => {
            if (!changed && String(file) === path.join(f.ownerDir, "nested-recovery.json")) {
                changed = true;
                fs.writeFileSync(path.join(f.childDir, "process-terminal.json"), JSON.stringify({ ...proof, state: "unknown", reason: "fixture changed after preflight", resumeDisposition: "blocked" }));
            }
            return exists(file);
        });
        syncBuiltinESMExports();
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
        const result = await f.recover();
        assert.equal(changed, true);
        assert.equal(recoveryReport(result)?.code, "TERMINAL_UNVERIFIED");
        assert.equal(f.state.retainedNestedLookupRoutes, undefined);
        assert.equal(readNestedRegistry(f.route).children[0]?.state, "running");
        assert.equal(inspectSessionLease(f.managerSessionFile).state, "free");
        assert.equal(inspectSessionLease(f.childSessionFile).state, "free");
    });
    it("holds the existing session lease while publishing the event projection", async t => {
        const f = fixture();
        const readdir = fsDefault.readdirSync;
        let reads = 0;
        let denied = false;
        t.mock.method(fsDefault, "readdirSync", (...args: Parameters<typeof fsDefault.readdirSync>) => {
            if (String(args[0]) === f.route.eventSink && ++reads === 2) {
                const module = new URL("../../src/runs/shared/session-lease.ts", import.meta.url).href;
                const script = `import {acquireSessionLease,SessionLeaseConflictError} from ${JSON.stringify(module)};try{const lease=acquireSessionLease({sessionFile:${JSON.stringify(f.childSessionFile)},runId:"publication-contender",sourceRunId:${JSON.stringify(f.childId)}});lease.release();process.exit(9);}catch(error){if(error instanceof SessionLeaseConflictError)process.exit(0);throw error;}`;
                const contender = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 });
                assert.equal(contender.error, undefined);
                denied = contender.status === 0;
            }
            return readdir(...args);
        });
        syncBuiltinESMExports();
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
        const result = await f.recover();
        assert.notEqual(result.isError, true, resultText(result));
        assert.equal(denied, true, "Publication must exclude a competing native resume.");
    });

    for (const [parentPath, resumable] of [["workflow[manager]/coder", true], ["workflow[another]/coder", false], [undefined, false]] as const) {
        it("checks the recovery descriptor parentPath: " + (parentPath ?? "absent"), async () => {
            const f = fixture();
            fs.writeFileSync(path.join(f.childDir, "recovery-descriptor.json"), JSON.stringify({
                version: 1, launchContractDigest: "f".repeat(64), sourceRunId: f.childId, agent: "coder", cwd: f.root, sessionFile: f.childSessionFile,
                systemPromptMode: "replace", outputMode: "inline", inheritProjectContext: false,
                inheritSkills: false, share: false, maxSubagentDepth: 3,
                runFanoutBudget: { ...f.budget, parentPath },
            }));
            const result = await f.recover();
            assert.notEqual(result.isError, true, resultText(result));
            assert.equal(recoveryReport(result)?.descendants[0]?.resumable, resumable);
        });
    }
    it("does not advertise a corrupt recovery descriptor as resumable", async () => {
        const f = fixture();
        fs.writeFileSync(path.join(f.childDir, "recovery-descriptor.json"), "{}");
        const result = await f.recover();
        assert.notEqual(result.isError, true, resultText(result));
        assert.equal(recoveryReport(result)?.descendants?.[0]?.resumable, false);
    });

    for (const extra of [{ force: true }, { timeoutMs: 1000 }, { model: "another/model" }]) {
        it("refuses unsupported recovery overrides: " + Object.keys(extra)[0], async () => {
            const f = fixture();
            const result = await f.recover({ extra });
            assert.equal(recoveryReport(result)?.code, "INVALID_TARGET");
            assert.equal(readNestedRegistry(f.route).children[0]?.state, "running");
            assert.equal(f.state.retainedNestedLookupRoutes, undefined);
        });
    }

    it("does not overwrite another recovery audit record", async () => {
        const f = fixture();
        const file = path.join(f.ownerDir, "nested-recovery.json");
        const original = JSON.stringify({ version: 1, ownerRunId: "another-owner", rootRunId: "another-root" });
        fs.writeFileSync(file, original);
        const result = await f.recover();
        assert.equal(recoveryReport(result)?.code, "PRECONDITION_FAILED");
        assert.equal(fs.readFileSync(file, "utf8"), original);
        assert.equal(readNestedRegistry(f.route).children[0]?.state, "running");
    });

    it("refuses a redirected child runtime namespace", async () => {
        const f = fixture();
        const moved = path.join(f.root, "redirected-child");
        fs.renameSync(f.childDir, moved);
        fs.symlinkSync(moved, f.childDir);
        const result = await f.recover();
        assert.equal(recoveryReport(result)?.code, "PATH_ESCAPE");
        assert.equal(f.state.retainedNestedLookupRoutes, undefined);
        assert.equal(readNestedRegistry(f.route).children[0]?.state, "running");
    });

    it("does not recreate a missing route identity during preflight", async () => {
        const f = fixture();
        const file = path.join(path.dirname(f.route.eventSink), "route.json");
        fs.unlinkSync(file);
        const result = await f.recover();
        assert.equal(result.isError, true);
        assert.equal(fs.existsSync(file), false);
        assert.equal(readNestedRegistry(f.route).children[0]?.state, "running");
    });
    it("lets a revived manager inspect only its verified former subtree", async () => {
        const f = fixture();
        const result = await f.recover();
        assert.notEqual(result.isError, true, resultText(result));
        const revivedId = randomUUID();
        const strangerId = randomUUID();
        writeNestedEvent(f.route, { type: "subagent.nested.completed", ts: 5, parentRunId: "other-manager",
            child: { id: strangerId, parentRunId: "other-manager", depth: 1, path: [{ runId: "other-manager" }], state: "complete", agent: "tester" } });
        const runtime = {
            fanoutChild: true, depth: 1, maxDepth: 3, waitTool: { enabled: true }, fast: false,
            nestedRoute: f.route,
            nestedParent: { parentRunId: revivedId, parentChildIndex: 0, depth: 1, path: [{ runId: revivedId, stepIndex: 0 }] },
            recoveredNestedParentRunId: f.ownerRunId,
        };
        const childState: SubagentState = { baseCwd: f.root, currentSessionId: f.managerSessionFile, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
        const executor = f.executor(true, runtime, childState);
        const owned = await executor.execute("child-status", { action: "status", id: f.childId }, undefined, undefined, f.ctx(f.managerSessionFile));
        assert.notEqual(owned.isError, true, resultText(owned));
        assert.match(resultText(owned), /State: failed/);
        const stranger = await executor.execute("foreign-status", { action: "status", id: strangerId }, undefined, undefined, f.ctx(f.managerSessionFile));
        assert.equal(stranger.isError, true);
    });

    it("passes recovery ownership through the native launch seam but not to grandchildren", () => {
        const route = createNestedRoute(randomUUID());
        cleanup.push(() => fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true }));
        const sourceManager = randomUUID();
        const context = { cwd: os.tmpdir(), id: randomUUID(), flatIndex: 0, nestedRoute: route, recoveredNestedParentRunId: sourceManager };
        const launch = buildRunnerChildLaunch(
            { agent: "coding-manager", task: "recover", tools: ["subagent"], allowNestedSubagents: true, allowedAgents: ["coder"], inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false },
            context,
            { sessionEnabled: false, watchdogStatus() {} }
        );
        assert.equal(launch.config.recoveredNestedParentRunId, sourceManager);
        assert.equal(Object.hasOwn(inheritedChildRuntime(launch.config) ?? {}, "recoveredNestedParentRunId"), false);
    });

    it("keeps a manager recovery binding private and rejects an owned revival session", async () => {
        const f = fixture();
        assert.notEqual((await f.recover()).isError, true);
        const binding = recoveredNestedBinding(f.state, f.managerSessionFile, "coding-manager");
        assert.equal(binding?.ownerRunId, f.ownerRunId);
        assert.throws(() => recoveredNestedBinding(f.state, f.managerSessionFile, "another-agent"), /ownership/);
        const lease = acquireSessionLease({ sessionFile: f.managerSessionFile, runId: "live-revival", sourceRunId: f.ownerRunId });
        cleanup.push(() => { lease.release(); });
        assert.throws(() => recoveredNestedBinding(f.state, f.managerSessionFile, "coding-manager"), /owned/);
    });
    it("restores only the original parent's terminal children without launching or falsifying success", async () => {
        const f = fixture();
        assert.equal(readNestedRegistry(f.route).children[0]?.state, "running");
        assert.equal(resolveSubagentRunId(f.childId, { state: f.state }), undefined);
        const before = fs.readFileSync(path.join(f.childDir, "process-terminal.json"));
        const result = await f.recover();
        assert.notEqual(result.isError, true, resultText(result));
        assert.equal(recoveryReport(result)?.status, "recovered");
        assert.deepEqual(recoveryReport(result)?.descendants?.map(child => ({ id: child.id, state: child.state, writerTerminal: child.writerTerminal })), [{ id: f.childId, state: "failed", writerTerminal: "not-applicable-in-process" }]);
        assert.equal(resolveSubagentRunId(f.childId, { state: f.state })?.kind, "nested");
        assert.equal(readNestedRegistry(f.route).children[0]?.state, "failed");
        assert.deepEqual(fs.readFileSync(path.join(f.childDir, "process-terminal.json")), before);
        assert.equal(f.state.asyncJobs.size, 0, "recover must not start a child");
        const other = { ...f.state, currentSessionId: "another-session" };
        assert.equal(resolveSubagentRunId(f.childId, { state: other }), undefined);
    });

    it("recovers a child that an older registry dropped after its events were marked processed", async () => {
        const f = fixture();
        projectNestedEvents(f.route);
        const registryFile = path.join(path.dirname(f.route.eventSink), "registry.json");
        const stored = JSON.parse(fs.readFileSync(registryFile, "utf-8")) as { children: Array<{ id: string }>; schemaVersion?: number };
        const legacy = { ...stored, children: stored.children.filter(child => child.id !== f.childId) };
        delete legacy.schemaVersion;
        fs.writeFileSync(registryFile, JSON.stringify(legacy));
        const result = await f.recover();
        assert.notEqual(result.isError, true, resultText(result));
        assert.deepEqual(recoveryReport(result)?.descendants?.map(child => ({ id: child.id, state: child.state })), [{ id: f.childId, state: "failed" }]);
        assert.equal(resolveSubagentRunId(f.childId, { state: f.state })?.kind, "nested");
    });

    it("refuses a different parent before projecting pending events", async () => {
        const f = fixture();
        const stranger = path.join(f.root, "stranger.jsonl");
        fs.writeFileSync(stranger, "{}\n");
        const result = await f.recover({ sessionFile: stranger });
        assert.equal(result.isError, true);
        assert.equal(recoveryReport(result)?.code, "PARENT_MISMATCH");
        assert.match(resultText(result), /owner|parent|session/i);
        assert.equal(readNestedRegistry(f.route).children[0]?.state, "running");
        assert.equal(f.state.retainedNestedLookupRoutes, undefined);
    });

    it("refuses child-safe callers without changing the registry", async () => {
        const f = fixture();
        const result = await f.recover({ childSafe: true });
        assert.equal(result.isError, true);
        assert.equal(recoveryReport(result)?.code, "CHILD_SAFE");
        assert.match(resultText(result), /child-safe/);
        assert.equal(readNestedRegistry(f.route).children[0]?.state, "running");
    });

    it("refuses unknown roots rather than broadening the lookup", async () => {
        const f = fixture();
        const result = await f.recover({ rootId: randomUUID() });
        assert.equal(result.isError, true);
        assert.equal(recoveryReport(result)?.code, "ROOT_NOT_FOUND");
        assert.match(resultText(result), /root|route/i);
        assert.equal(f.state.retainedNestedLookupRoutes, undefined);
    });

    it("refuses a child from another fanout budget", async () => {
        const f = fixture();
        const other = createRunFanoutBudget(randomUUID(), 32);
        cleanup.push(() => fs.rmSync(other.directory, { recursive: true, force: true }));
        writeRunFanoutBudgetDescriptor(f.childDir, other);
        const result = await f.recover();
        assert.equal(result.isError, true);
        assert.equal(recoveryReport(result)?.code, "BUDGET_MISMATCH");
        assert.match(resultText(result), /budget|identity|ownership/i);
        assert.equal(readNestedRegistry(f.route).children[0]?.state, "running");
    });

    it("refuses unknown runner proof and preserves it verbatim", async () => {
        const f = fixture();
        const p = path.join(f.childDir, "process-terminal.json");
        const d = readProcessTerminal(f.childDir);
        assert.ok(d);
        fs.writeFileSync(p, JSON.stringify({ ...d, state: "unknown", reason: "writer-close-unverified" }));
        const before = fs.readFileSync(p);
        const result = await f.recover();
        assert.equal(result.isError, true);
        assert.equal(recoveryReport(result)?.code, "TERMINAL_UNVERIFIED");
        assert.match(resultText(result), /proof|terminal|observed/i);
        assert.deepEqual(fs.readFileSync(p), before);
    });

    it("refuses an active canonical session lease without deleting it", async () => {
        const f = fixture();
        const lease = acquireSessionLease({ sessionFile: f.childSessionFile, runId: "other-live", sourceRunId: f.childId });
        cleanup.push(() => { lease.release(); });
        const before = fs.readFileSync(path.join(lease.leaseDir, "owner.json"));
        const result = await f.recover();
        assert.equal(result.isError, true);
        assert.equal(recoveryReport(result)?.code, "SESSION_OWNED");
        assert.match(resultText(result), /lease|owned/i);
        assert.deepEqual(fs.readFileSync(path.join(lease.leaseDir, "owner.json")), before);
        assert.equal(f.state.retainedNestedLookupRoutes, undefined);
    });

    it("refuses a still-running coordinator", async () => {
        const f = fixture();
        const p = path.join(f.ownerDir, "status.json");
        const d = readStatus(f.ownerDir);
        assert.ok(d);
        d.state = "running";
        fs.writeFileSync(p, JSON.stringify(d));
        const result = await f.recover();
        assert.equal(result.isError, true);
        assert.equal(recoveryReport(result)?.code, "RUN_LIVE");
        assert.match(resultText(result), /live|running|terminal/i);
        assert.equal(readNestedRegistry(f.route).children[0]?.state, "running");
    });

    it("is idempotent and never publishes capability tokens", async () => {
        const f = fixture();
        const first = await f.recover();
        const second = await f.recover();
        assert.notEqual(first.isError, true, resultText(first));
        assert.notEqual(second.isError, true, resultText(second));
        assert.equal(f.state.retainedNestedLookupRoutes?.routes.size, 1);
        assert.equal(resultText(second).includes(f.route.capabilityToken), false);
        assert.equal(f.state.asyncJobs.size, 0);
    });
});
