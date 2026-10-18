import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";
import type { AsyncStatus, NestedRunSummary, SteeringRecoveryDescriptor } from "../../shared/types.ts";
import { readAsyncRecoveryDescriptor } from "../background/async-resume.ts";

const schema = Type.Object({
    runId: Type.String({ minLength: 1 }), agent: Type.String({ minLength: 1 }),
    ownerRunId: Type.String({ minLength: 1 }), rootRunId: Type.String({ minLength: 1 }),
    canonicalSessionFile: Type.String({ minLength: 1 }),
    sessionOwnerRunId: Type.String({ minLength: 1 }),
    fileDevice: Type.Integer({ minimum: 0 }), fileInode: Type.Integer({ minimum: 0 }),
    statusSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    descriptorSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    launchContractDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
}, { additionalProperties: false });
const parser = Compile(Type.Array(schema));
export type RecoveredNestedSession = Static<typeof schema>;

export function parseRecoveredNestedSessions(value: RecoveredNestedSession[]): RecoveredNestedSession[] {
    const sessions = parser.Parse(value);
    const ids = new Set<string>();
    for (const session of sessions) {
        if (ids.has(session.runId)) throw new Error("Recovered session grants contain a duplicate run identity.");
        ids.add(session.runId);
    }
    return sessions;
}

function digest(file: string): string {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error("Recovered session evidence is not a bounded regular file.");
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function ownerOf(descriptor: SteeringRecoveryDescriptor, runId: string): string {
    return descriptor.sessionOwnerRunId ?? runId;
}
function ownedFile(file: string, ownerRunId: string): boolean {
    return path.isAbsolute(file) && path.extname(file) === ".jsonl" && path.dirname(file).split(path.sep).includes(ownerRunId);
}

/** Called only after the original parent verified ownership, terminal proof and all session reservations. */
export function captureRecoveredNestedSession(input: {
    ownerRunId: string; rootRunId: string; dir: string; status: AsyncStatus; canonicalSessionFile: string;
}): RecoveredNestedSession | undefined {
    const { status, canonicalSessionFile } = input;
    const descriptor = readAsyncRecoveryDescriptor(input.dir);
    if (!descriptor || !status.launchContractDigest || descriptor.launchContractDigest !== status.launchContractDigest
        || descriptor.sourceRunId !== status.runId || descriptor.agent !== status.steps?.[0]?.agent
        || !descriptor.sessionFile || fs.realpathSync(descriptor.sessionFile) !== canonicalSessionFile) return undefined;
    const owner = ownerOf(descriptor, status.runId);
    const stat = fs.lstatSync(canonicalSessionFile);
    if (!stat.isFile() || stat.isSymbolicLink() || !ownedFile(canonicalSessionFile, owner)) return undefined;
    // A symlink at the recorded spelling must not become a grant merely because realpath resolved it.
    if (fs.lstatSync(descriptor.sessionFile).isSymbolicLink()) return undefined;
    return {
        runId: status.runId, agent: descriptor.agent, ownerRunId: input.ownerRunId, rootRunId: input.rootRunId,
        canonicalSessionFile, sessionOwnerRunId: owner, fileDevice: stat.dev, fileInode: stat.ino,
        statusSha256: digest(path.join(input.dir, "status.json")),
        descriptorSha256: digest(path.join(input.dir, "recovery-descriptor.json")),
        launchContractDigest: status.launchContractDigest,
    };
}

/** Private native context only. Never turns a directory or a model parameter into a trusted root. */
export function recoveredSessionFileForRun(input: {
    run: NestedRunSummary; rootRunId: string; dir: string; descriptor?: SteeringRecoveryDescriptor;
    nativeOwnerRunId?: string; nativeSessions?: RecoveredNestedSession[];
}): string | undefined {
    if (!input.nativeOwnerRunId || !input.nativeSessions) return undefined;
    const grant = parseRecoveredNestedSessions(input.nativeSessions).find(item => item.runId === input.run.id);
    if (!grant) return undefined;
    const descriptor = input.descriptor;
    if (grant.ownerRunId !== input.nativeOwnerRunId || grant.rootRunId !== input.rootRunId
        || grant.agent !== (input.run.agent ?? input.run.steps?.[0]?.agent) || !descriptor || descriptor.sourceRunId !== grant.runId
        || descriptor.agent !== grant.agent || descriptor.launchContractDigest !== grant.launchContractDigest
        || !descriptor.sessionFile || ownerOf(descriptor, grant.runId) !== grant.sessionOwnerRunId
        || digest(path.join(input.dir, "status.json")) !== grant.statusSha256
        || digest(path.join(input.dir, "recovery-descriptor.json")) !== grant.descriptorSha256) {
        throw new Error("Recovered nested session evidence changed or belongs to another owner.");
    }
    const recordedFile = input.run.sessionFile ?? input.run.steps?.[0]?.sessionFile;
    if (!recordedFile || fs.realpathSync(recordedFile) !== grant.canonicalSessionFile) throw new Error("The scoped run names another session file.");
    const stat = fs.lstatSync(descriptor.sessionFile);
    const canonical = fs.realpathSync(descriptor.sessionFile);
    if (!stat.isFile() || stat.isSymbolicLink() || canonical !== grant.canonicalSessionFile
        || stat.dev !== grant.fileDevice || stat.ino !== grant.fileInode || !ownedFile(canonical, grant.sessionOwnerRunId)) {
        throw new Error("Recovered nested session file identity changed.");
    }
    return canonical;
}
