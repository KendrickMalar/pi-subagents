import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { DIRS, TEMP_ROOT_DIR, type AsyncStatus, type NestedRouteInfo, type NestedRunSummary, type SubagentState } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { applyNestedEvent, isSafeNestedId, NESTED_EVENTS_DIR, parseNestedEventRecords, projectNestedEvents, readNestedRegistry, resolveNestedRoute, retainNestedLookupRoute } from "../shared/nested-events.ts";
import { acquireSessionLease, canonicalSessionFilePath, inspectSessionLease, SessionLeaseConflictError, SESSION_LEASES_DIR, type SessionLeaseHandle } from "../shared/session-lease.ts";
import { readRunFanoutBudgetDescriptor, validateRunFanoutBudgetDescriptor } from "../shared/run-fanout-budget.ts";
import { readProcessTerminal, readProcessTerminalCandidate } from "./process-terminal.ts";
import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";
import { readAsyncRecoveryDescriptor } from "./async-resume.ts";

export interface NestedRecoveryChild {
    id: string;
    state: string;
    runnerTerminal: "observed";
    writerTerminal: "observed" | "not-applicable-in-process";
    sessionLease: "free";
    resumable: boolean;
}
export interface NestedRecoveryResult {
    status: "recovered" | "blocked";
    ownerRunId: string;
    rootRunId: string;
    code?: string;
    message: string;
    descendants: NestedRecoveryChild[];
}
export interface RecoveredNestedBinding {
    ownerRunId: string;
    ownerSessionFile: string;
    managerSessionFile: string;
    managerAgent: string;
    route: NestedRouteInfo;
    ownerStatusDigest: string;
    ownerAsyncDir: string;
}
const bindings = new WeakMap<SubagentState, Map<string, RecoveredNestedBinding>>();

class RecoveryFailure extends Error {
    readonly code: string;
    constructor(code: string, message: string) { super(message); this.code = code; }
}
function fail(code: string, message: string): never { throw new RecoveryFailure(code, message); }
const metadataSchema = Type.Object({
    version: Type.Optional(Type.Integer()),
    kind: Type.Optional(Type.String()),
    rootRunId: Type.Optional(Type.String()),
    capabilityToken: Type.Optional(Type.String()),
    routeRoot: Type.Optional(Type.String()),
    ownerRunId: Type.Optional(Type.String()),
}, { additionalProperties: true });
const metadataParser = Compile(metadataSchema);
const routeIndexParser = Compile(Type.Object({
    rootRunId: Type.String({ minLength: 1 }),
    capabilityToken: Type.String({ minLength: 1 }),
    routeRoot: Type.String({ minLength: 1 }),
}, { additionalProperties: true }));
function readMetadata(file: string): Static<typeof metadataSchema> {
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) fail("INVALID_METADATA", "Metadata must be a bounded regular file.");
        const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        return metadataParser.Parse(value);
    } catch (error) {
        if (error instanceof RecoveryFailure) throw error;
        return fail("INVALID_METADATA", "Required metadata is unreadable.");
    }
}
/** Accept the platform's canonical temp alias, but no symlink below the trusted root. */
function contained(root: string, file: string): string {
    const realRoot = fs.realpathSync.native(root);
    const resolved = path.resolve(file);
    const lexicalRoot = path.resolve(root);
    const base = resolved === lexicalRoot || resolved.startsWith(lexicalRoot + path.sep) ? lexicalRoot : realRoot;
    if (resolved !== base && !resolved.startsWith(base + path.sep)) fail("PATH_ESCAPE", "Path is outside the runtime namespace.");
    const expected = path.join(realRoot, path.relative(base, resolved));
    const real = fs.realpathSync.native(resolved);
    if (real !== expected) fail("PATH_ESCAPE", "Runtime paths cannot be redirected by symlinks.");
    return real;
}
function routeForRoot(rootRunId: string): NestedRouteInfo {
    const index = path.join(NESTED_EVENTS_DIR, ".route-index", "roots", encodeURIComponent(rootRunId));
    if (!fs.existsSync(index)) return fail("ROOT_NOT_FOUND", "The exact nested root route is unavailable.");
    contained(NESTED_EVENTS_DIR, index);
    const entries = fs.readdirSync(index);
    if (entries.length !== 1) return fail("ROOT_NOT_FOUND", "The nested root route is ambiguous.");
    const entry = path.join(index, entries[0]!);
    contained(NESTED_EVENTS_DIR, entry);
    const meta = readMetadata(entry);
    if (!routeIndexParser.Check(meta) || meta.rootRunId !== rootRunId) fail("ROOT_NOT_FOUND", "Invalid nested root route identity.");
    const root = path.join(NESTED_EVENTS_DIR, path.basename(meta.routeRoot));
    contained(NESTED_EVENTS_DIR, root);
    for (const file of [path.join(root, "route.json"), path.join(root, "events"), path.join(root, "controls")]) contained(NESTED_EVENTS_DIR, file);
    readMetadata(path.join(root, "route.json"));
    return resolveNestedRoute({ rootRunId, capabilityToken: meta.capabilityToken, eventSink: path.join(root, "events"), controlInbox: path.join(root, "controls") });
}
function terminal(status: AsyncStatus): void {
    if (status.state === "running" || status.state === "queued") fail("RUN_LIVE", "The run is still running; recovery cannot interrupt it.");
    if (!["failed", "complete", "paused"].includes(status.state)) fail("TERMINAL_UNVERIFIED", "The terminal run state is not recoverable.");
}
function statusAt(dir: string, runId: string): AsyncStatus {
    contained(TEMP_ROOT_DIR, dir);
    const file = path.join(dir, "status.json");
    contained(TEMP_ROOT_DIR, file);
    readMetadata(file);
    const status = readStatus(dir);
    if (!status || status.runId !== runId) return fail("INVALID_METADATA", "Run status identity does not match.");
    return status;
}
function sessionOf(status: AsyncStatus, reservations?: ReadonlyMap<string, SessionLeaseHandle>): string {
    if (status.steps?.length !== 1 || !status.steps[0]?.sessionFile) return fail("TERMINAL_UNVERIFIED", "A single persisted child session is required.");
    const sessionFile = canonicalSessionFilePath(status.steps[0].sessionFile);
    const lease = inspectSessionLease(sessionFile);
    const held = reservations?.get(sessionFile);
    if (held) {
        if (lease.state !== "owned" || lease.owner.token !== held.owner.token || lease.owner.canonicalSessionFile !== sessionFile || lease.owner.writerState !== "none") fail("SESSION_OWNED", "The recovery reservation lost its session authority.");
    } else if (lease.state !== "free") fail("SESSION_OWNED", "The canonical session lease is owned or unreadable.");
    return sessionFile;
}
function verifyTerminal(dir: string, status: AsyncStatus, reservations?: ReadonlyMap<string, SessionLeaseHandle>): NestedRecoveryChild["writerTerminal"] {
    terminal(status);
    for (const name of ["process-terminal.json", "process-terminal-candidate.json"]) {
        contained(TEMP_ROOT_DIR, path.join(dir, name));
        readMetadata(path.join(dir, name));
    }
    const proof = readProcessTerminal(dir, { runId: status.runId, runnerProcessInstanceId: status.processTerminal?.runnerProcessInstanceId });
    const candidate = readProcessTerminalCandidate(dir);
    if (!proof || proof.state !== "observed" || !candidate || candidate.runId !== status.runId || candidate.runnerProcessInstanceId !== proof.runnerProcessInstanceId) fail("TERMINAL_UNVERIFIED", "A matching observed terminal proof is required.");
    const expected = candidate.expectedWriters;
    if (!expected || Object.keys(expected).length !== status.steps?.length) fail("TERMINAL_UNVERIFIED", "Writer terminal proof coverage is incomplete.");
    let separateWriters = false;
    for (const [index, count] of Object.entries(expected)) {
        const records = candidate.writers[index];
        if (!records || records.length !== count || !status.steps?.[Number(index)]) fail("TERMINAL_UNVERIFIED", "Writer terminal proof coverage is inconsistent.");
        if (count === 0) {
            if (status.steps[Number(index)]?.runner) fail("TERMINAL_UNVERIFIED", "Zero separate writers is supported only for native in-process Pi.");
        } else {
            separateWriters = true;
            if (records.some(record => record.kind !== "pi-writer" || record.processTree.state !== "observed") || status.steps[Number(index)]?.processTerminal?.state !== "observed") fail("TERMINAL_UNVERIFIED", "Separate writer terminal proof is incomplete.");
        }
    }
    sessionOf(status, reservations);
    return separateWriters ? "observed" : "not-applicable-in-process";
}
function descendants(children: NestedRunSummary[], owner: string): NestedRunSummary[] {
    const all = new Map<string, NestedRunSummary>();
    const visit = (items: NestedRunSummary[]): void => {
        for (const item of items) {
            if (all.has(item.id) && all.get(item.id)?.parentRunId !== item.parentRunId) fail("INVALID_METADATA", "Conflicting nested parent identity.");
            all.set(item.id, item);
            visit(item.children ?? []);
            for (const step of item.steps ?? []) visit(step.children ?? []);
        }
    };
    visit(children);
    const owned = new Set([owner]);
    const found: NestedRunSummary[] = [];
    for (let n = 0; n <= all.size; n++) {
        let changed = false;
        for (const item of all.values()) if (owned.has(item.parentRunId) && !owned.has(item.id)) {
            found.push(item); owned.add(item.id); changed = true;
        }
        if (!changed) break;
    }
    return found;
}
function digestStatus(dir: string): string {
    return createHash("sha256").update(fs.readFileSync(path.join(dir, "status.json"))).digest("hex");
}
function canResume(dir: string, status: AsyncStatus, sessionFile: string): boolean {
    try {
        const file = path.join(dir, "recovery-descriptor.json");
        if (!fs.existsSync(file)) return false;
        contained(TEMP_ROOT_DIR, file);
        readMetadata(file);
        const recovery = readAsyncRecoveryDescriptor(dir);
        const budget = readRunFanoutBudgetDescriptor(dir);
        return Boolean(recovery && budget && recovery.sourceRunId === status.runId
            && recovery.agent === status.steps?.[0]?.agent
            && recovery.sessionFile && canonicalSessionFilePath(recovery.sessionFile) === sessionFile
            && recovery.runFanoutBudget?.directory === budget.directory
            && recovery.runFanoutBudget.rootRunId === budget.rootRunId
            && recovery.runFanoutBudget.limit === budget.limit
            && recovery.runFanoutBudget.parentPath === budget.parentPath
            && (!status.launchContractDigest || recovery.launchContractDigest === status.launchContractDigest));
    } catch {
        return false;
    }
}
export function recoverNestedRunTree(request: { ownerRunId: string; nestedRootRunId: string }, context: { state: SubagentState; parentSessionFile: string }): NestedRecoveryResult {
    const { ownerRunId, nestedRootRunId } = request;
    const blocked = (code: string, message: string): NestedRecoveryResult => ({ status: "blocked", ownerRunId, rootRunId: nestedRootRunId, code, message, descendants: [] });
    try {
        if (!isSafeNestedId(ownerRunId) || !isSafeNestedId(nestedRootRunId)) return blocked("INVALID_TARGET", "Exact safe owner and root IDs are required.");
        const ownerDir = path.join(DIRS.async, ownerRunId);
        const owner = statusAt(ownerDir, ownerRunId);
        const parent = canonicalSessionFilePath(context.parentSessionFile);
        if (!owner.sessionId || canonicalSessionFilePath(owner.sessionId) !== parent) return blocked("PARENT_MISMATCH", "Only the original parent session can recover this owner.");
        verifyTerminal(ownerDir, owner);
        const managerSessionFile = sessionOf(owner);
        const ownerStatusDigest = digestStatus(ownerDir);
        const managerAgent = owner.steps![0]!.agent;
        const ownerBudget = readRunFanoutBudgetDescriptor(ownerDir);
        if (!ownerBudget) return blocked("BUDGET_MISMATCH", "The owner budget identity is missing.");
        const route = routeForRoot(nestedRootRunId);
        // Build a read-only projection first. No registry/proof/lease mutation until every child passes.
        let projected = readNestedRegistry(route);
        const seen = new Set(projected.processedEvents);
        const eventFiles = fs.readdirSync(route.eventSink).filter(name => /\.jsonl?$/.test(name)).sort();
        if (eventFiles.length > 10000) return blocked("INVALID_METADATA", "The explicit recovery event set exceeds its bound.");
        for (const name of eventFiles) {
            if (seen.has(name)) continue;
            const file = path.join(route.eventSink, name);
            contained(NESTED_EVENTS_DIR, file);
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.size > 64 * 1024) return blocked("INVALID_METADATA", "A nested event is not a bounded regular file.");
            for (const event of parseNestedEventRecords(fs.readFileSync(file, "utf8"), route)) projected = applyNestedEvent(projected, event);
        }
        const runs = descendants(projected.children, ownerRunId);
        if (!runs.length) return blocked("ROOT_NOT_FOUND", "The root has no descendants belonging to this owner.");
        const checked: NestedRecoveryChild[] = [];
        const sourceDigests = new Map<string, string>([[ownerDir, ownerStatusDigest]]);
        const sources = new Map<string, AsyncStatus>([[ownerDir, owner]]);
        const sessions = new Set([managerSessionFile]);
        for (const run of runs) {
            const dir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", nestedRootRunId, run.id);
            if (!run.asyncDir || fs.realpathSync.native(run.asyncDir) !== contained(TEMP_ROOT_DIR, dir)) return blocked("PATH_ESCAPE", "Nested async directory identity does not match.");
            const status = statusAt(dir, run.id);
            if (status.steps?.[0]?.agent !== run.agent) return blocked("INVALID_METADATA", "Nested agent identity does not match its status.");
            const childBudget = readRunFanoutBudgetDescriptor(dir);
            if (!childBudget || childBudget.rootRunId !== ownerBudget.rootRunId || childBudget.directory !== ownerBudget.directory || childBudget.limit !== ownerBudget.limit || (ownerBudget.parentPath && !childBudget.parentPath?.startsWith(ownerBudget.parentPath + "/"))) return blocked("BUDGET_MISMATCH", "Nested fanout budget ownership does not match.");
            const writerTerminal = verifyTerminal(dir, status);
            const sessionFile = sessionOf(status);
            if (run.sessionFile && canonicalSessionFilePath(run.sessionFile) !== sessionFile) return blocked("INVALID_METADATA", "Nested session identity does not match.");
            sourceDigests.set(dir, digestStatus(dir));
            sources.set(dir, status);
            sessions.add(sessionFile);
            checked.push({ id: run.id, state: status.state, runnerTerminal: "observed", writerTerminal, sessionLease: "free", resumable: canResume(dir, status, sessionFile) });
        }
        for (const [dir, hash] of sourceDigests) if (digestStatus(dir) !== hash) return blocked("PRECONDITION_FAILED", "The nested state changed during validation.");
        validateRunFanoutBudgetDescriptor(ownerBudget);
        const auditFile = path.join(ownerDir, "nested-recovery.json");
        if (fs.existsSync(auditFile)) {
            contained(TEMP_ROOT_DIR, auditFile);
            const previous = readMetadata(auditFile);
            if (previous.kind !== "nested-recovery" || previous.version !== 1 || previous.ownerRunId !== ownerRunId || previous.rootRunId !== nestedRootRunId) return blocked("PRECONDITION_FAILED", "Another recovery record already occupies the audit path.");
        }
        // Reuse the revival lease namespace: no writer may enter between verification and publication.
        if (!fs.existsSync(SESSION_LEASES_DIR)) fs.mkdirSync(SESSION_LEASES_DIR, { mode: 0o700 });
        contained(TEMP_ROOT_DIR, SESSION_LEASES_DIR);
        const reservations = new Map<string, SessionLeaseHandle>();
        const recoveryId = "recover-" + randomUUID();
        try {
            for (const sessionFile of [...sessions].sort()) {
                try {
                    reservations.set(sessionFile, acquireSessionLease({ sessionFile, runId: recoveryId, sourceRunId: ownerRunId, parentSessionId: parent }));
                } catch (error) {
                    if (error instanceof SessionLeaseConflictError) fail("SESSION_OWNED", "A session was claimed before recovery could reserve it.");
                    throw error;
                }
            }
            for (const [dir, status] of sources) {
                if (digestStatus(dir) !== sourceDigests.get(dir)) return blocked("PRECONDITION_FAILED", "The run state changed before recovery publication.");
                verifyTerminal(dir, status, reservations);
            }
            // The sidecar and audit are published while every canonical session is reserved.
            const reconciled = projectNestedEvents(route);
            const finalRuns = descendants(reconciled.children, ownerRunId);
            if (finalRuns.length !== runs.length || finalRuns.some(run => !checked.some(item => item.id === run.id && item.state === run.state))) return blocked("PRECONDITION_FAILED", "Projected terminal events do not agree with validated statuses.");
            const audit = { kind: "nested-recovery", version: 1, ownerRunId, rootRunId: nestedRootRunId, ownerStatusDigest, descendants: checked, recoveredAt: Date.now() };
            writeAtomicJson(auditFile, audit);
        } finally {
            let released = true;
            for (const lease of [...reservations.values()].reverse()) {
                try { if (!lease.release()) released = false; } catch { released = false; }
            }
            if (!released) fail("SESSION_OWNED", "A recovery reservation could not be released; no new binding is granted.");
        }
        context.state.currentSessionId = context.parentSessionFile;
        retainNestedLookupRoute(context.state, route, context.parentSessionFile);
        const ticket: RecoveredNestedBinding = { ownerRunId, ownerSessionFile: parent, managerSessionFile, managerAgent, route, ownerStatusDigest, ownerAsyncDir: ownerDir };
        let map = bindings.get(context.state);
        if (!map) { map = new Map(); bindings.set(context.state, map); }
        map.set(managerSessionFile, ticket);
        return { status: "recovered", ownerRunId, rootRunId: nestedRootRunId, message: "Nested recovery completed; no child was started.", descendants: checked };
    } catch (error) {
        return error instanceof RecoveryFailure ? blocked(error.code, error.message) : blocked("INVALID_METADATA", "Required ownership metadata is missing or unreadable.");
    }
}

/** Private native-launch binding, never accepted from model parameters. */
export function recoveredNestedBinding(state: SubagentState, sessionFile: string, agent: string): RecoveredNestedBinding | undefined {
    const ticket = bindings.get(state)?.get(canonicalSessionFilePath(sessionFile));
    if (!ticket) return undefined;
    if (!state.currentSessionId || canonicalSessionFilePath(state.currentSessionId) !== ticket.ownerSessionFile || agent !== ticket.managerAgent || digestStatus(ticket.ownerAsyncDir) !== ticket.ownerStatusDigest) fail("PRECONDITION_FAILED", "Recovered manager ownership changed before resume.");
    if (inspectSessionLease(ticket.managerSessionFile).state !== "free") fail("SESSION_OWNED", "The recovered manager session is already owned.");
    resolveNestedRoute(ticket.route);
    return ticket;
}
