import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, readSync, writeSync } from "node:fs";
import { isAbsolute, normalize, parse } from "node:path";

export interface ReviewLaunchIdentityV1 {
	version: 1; subjectRunId: string; childIndex?: number;
	ownerSessionId: string; ownerSubtreeId: string; processInstanceId: string;
	nonce: string; configDigest: string; cwd: string;
}
export interface RawReviewOutcomeV1 { exitCode: number | null; signal: string | null }
export interface ReviewTerminalCaptureV1 {
	rawOutcome: RawReviewOutcomeV1; originalAcceptanceDigest: string; evidenceDigest: string;
	repo: string; cwd: string; head: string; trackedStateDigest: string; captureTime: number;
}
export interface ReviewTerminalEnvelopeV1 extends ReviewTerminalCaptureV1 { version: 1; identity: ReviewLaunchIdentityV1 }
export interface SignedReviewTerminal { bytes: Buffer; tag: Buffer }

function invalid(): never { throw new Error("Invalid review provenance data"); }
function record(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
	if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !keys.includes(key) && !optional.includes(key))) return invalid();
	if (keys.some(key => !Object.hasOwn(value, key)) || Object.values(descriptors).some(d => !Object.hasOwn(d, "value"))) return invalid();
	return value as Record<string, unknown>;
}
function text(value: unknown): string {
	if (typeof value !== "string" || !value.length || /[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(value)) return invalid();
	return value;
}
function id(value: unknown): string { const s = text(value); if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(s)) return invalid(); return s; }
function hex(value: unknown, lengths: number[]): string { const s = text(value); if (!lengths.includes(s.length) || !/^[a-f0-9]+$/.test(s)) return invalid(); return s; }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid(); return value; }
function canonicalPath(value: unknown): string { const s = text(value); if (!isAbsolute(s) || normalize(s) !== s || s !== parse(s).root && /[\\/]$/.test(s)) return invalid(); return s; }
export function validateRawReviewOutcome(value: unknown): RawReviewOutcomeV1 {
	const r = record(value, ["exitCode", "signal"]);
	const exitCode = r.exitCode === null ? null : integer(r.exitCode);
	const signal = r.signal === null ? null : id(r.signal);
	if ((exitCode === null) === (signal === null)) return invalid();
	return Object.freeze({ exitCode, signal });
}
function identity(value: unknown): ReviewLaunchIdentityV1 {
	const r = record(value, ["version", "subjectRunId", "ownerSessionId", "ownerSubtreeId", "processInstanceId", "nonce", "configDigest", "cwd"], ["childIndex"]);
	if (r.version !== 1) return invalid();
	return Object.freeze({ version: 1, subjectRunId: id(r.subjectRunId), ...(Object.hasOwn(r, "childIndex") ? { childIndex: integer(r.childIndex) } : {}), ownerSessionId: id(r.ownerSessionId), ownerSubtreeId: id(r.ownerSubtreeId), processInstanceId: id(r.processInstanceId), nonce: hex(r.nonce, [32]), configDigest: hex(r.configDigest, [64]), cwd: canonicalPath(r.cwd) });
}
const captureKeys = ["rawOutcome", "originalAcceptanceDigest", "evidenceDigest", "repo", "cwd", "head", "trackedStateDigest", "captureTime"];
function envelope(value: unknown): ReviewTerminalEnvelopeV1 {
	const r = record(value, ["version", "identity", ...captureKeys]);
	if (r.version !== 1) return invalid();
	const launch = identity(r.identity); const cwd = canonicalPath(r.cwd);
	if (cwd !== launch.cwd) return invalid();
	return Object.freeze({ version: 1, identity: launch, rawOutcome: validateRawReviewOutcome(r.rawOutcome), originalAcceptanceDigest: hex(r.originalAcceptanceDigest, [64]), evidenceDigest: hex(r.evidenceDigest, [64]), repo: canonicalPath(r.repo), cwd, head: hex(r.head, [40, 64]), trackedStateDigest: hex(r.trackedStateDigest, [64]), captureTime: integer(r.captureTime) });
}
function encode(value: unknown, max: number): Buffer { const b = Buffer.from(JSON.stringify(value), "utf8"); if (b.length > max) return invalid(); return b; }
export function encodeReviewIdentity(value: unknown): Buffer { return encode(identity(value), 4096); }
export function encodeReviewTerminal(value: unknown): Buffer { return encode(envelope(value), 65536); }
export function decodeReviewTerminal(bytes: Uint8Array): ReviewTerminalEnvelopeV1 {
	if (bytes.byteLength > 65536) return invalid();
	const value = envelope(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
	if (!Buffer.from(bytes).equals(encodeReviewTerminal(value))) return invalid();
	return value;
}

/** Internal trusted host primitive. Secret material exists only in these closures and the private FD frame. */
export function createLaunchChannel(value: ReviewLaunchIdentityV1) {
	const launch = identity(value); const key = randomBytes(32); let transferred = false;
	return Object.freeze({
		writeInitialToFd(fd: number): void {
			try {
				if (transferred) return invalid(); transferred = true;
				const frame = encode({ version: 1, identity: launch, key: key.toString("hex") }, 4096);
				try { let offset = 0; while (offset < frame.length) { const n = writeSync(fd, frame, offset, frame.length - offset); if (!n) return invalid(); offset += n; } }
				finally { frame.fill(0); }
			} finally { closeSync(fd); }
		},
		verifyTerminal(bytes: Uint8Array, tag: Uint8Array): ReviewTerminalEnvelopeV1 | undefined {
			try {
				if (bytes.byteLength > 65536 || tag.byteLength !== 32) return undefined;
				const expected = createHmac("sha256", key).update(bytes).digest();
				if (!timingSafeEqual(expected, tag)) return undefined;
				const terminal = decodeReviewTerminal(bytes);
				if (!encodeReviewIdentity(terminal.identity).equals(encodeReviewIdentity(launch))) return undefined;
				return terminal;
			} catch { return undefined; }
		},
	});
}

/** Call before execution-load; actualFinalization is a trusted runner closure, never a tool/JSON input. No signing arguments are exposed. */
export function receiveRunnerReviewChannel(fd: number, actualConfigBytes: Uint8Array, actualFinalization: () => unknown): { finalize(): SignedReviewTerminal } | undefined {
	const frame = Buffer.alloc(4097); let length = 0;
	try {
		while (length < frame.length) { const n = readSync(fd, frame, length, frame.length - length, null); if (!n) break; length += n; }
		if (length > 4096) return undefined;
		const parsed = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(0, length))) as unknown, ["version", "identity", "key"]);
		if (parsed.version !== 1) return undefined;
		const launch = identity(parsed.identity); const keyHex = hex(parsed.key, [64]);
		if (!frame.subarray(0, length).equals(encode({ version: 1, identity: launch, key: keyHex }, 4096))) return undefined;
		if (createHash("sha256").update(actualConfigBytes).digest("hex") !== launch.configDigest) return undefined;
		const key = Buffer.from(keyHex, "hex"); let finalized = false;
		return Object.freeze({ finalize(): SignedReviewTerminal {
			if (finalized) return invalid(); finalized = true;
			try {
				const captured = record(actualFinalization(), captureKeys);
				const bytes = encodeReviewTerminal({ version: 1, identity: launch, ...captured });
				return { bytes, tag: createHmac("sha256", key).update(bytes).digest() };
			} finally { key.fill(0); }
		} });
	} catch { return undefined; }
	finally { frame.fill(0); try { closeSync(fd); } catch { /* Missing channel cannot grant proof. */ } }
}
