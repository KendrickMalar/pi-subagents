import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, fstatSync } from "node:fs";
import { Socket } from "node:net";
import { ChildProcess } from "node:child_process";
import { Writable, type Readable } from "node:stream";
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

declare const readerBrand: unique symbol;
declare const writerBrand: unique symbol;
export type ReviewReaderHandle = Readonly<{ [readerBrand]: true }>;
export type ReviewWriterHandle = Readonly<{ [writerBrand]: true }>;
export interface ReviewChannelDiagnostic { readonly readCount: number; readonly length: number; readonly elapsedMs: number; readonly eof: boolean }
const resourceAccess = new WeakMap<object, { takeReader(handle: unknown): boolean; takeWriter(handle: unknown): Writable | undefined }>();
function object(value: unknown): value is object { return value !== null && typeof value === "object"; }
function boundedDeadline(deadline: number): number | undefined {
	const now = Date.now();
	return Number.isFinite(deadline) && deadline > now ? Math.min(deadline, now + 1000) : undefined;
}
/** Internal only: declarations originate at trusted bootstrap / actual spawn, never caller JSON.
 * The marker is routing, NOT cryptographic authority. Product bootstrap wiring is a later slice.
 */
export function createReviewChannelResources() {
	// Trusted declaration plus exact resource freshness, not fstat authentication or
	// a sandbox against arbitrary same-process descriptor manipulation.
	const readers = new WeakMap<object, { dev: bigint; ino: bigint; mode: bigint }>(); const writers = new WeakMap<object, Writable>();
	const registered = new WeakSet<object>(); let declared = false;
	const resources = Object.freeze({
		registerBootstrapReader(): ReviewReaderHandle | undefined {
			if (declared) return undefined; declared = true;
			const marker = process.env.PI_SUBAGENT_REVIEW_CHANNEL_V1;
			delete process.env.PI_SUBAGENT_REVIEW_CHANNEL_V1;
			if (marker !== "fd3") return undefined;
			try {
				const stat = fstatSync(3, { bigint: true });
				if (!stat.isSocket() || stat.ino === 0n) return undefined;
				const handle = Object.freeze({}) as ReviewReaderHandle;
				readers.set(handle, { dev: stat.dev, ino: stat.ino, mode: stat.mode }); return handle;
			} catch { return undefined; }
		},
		registerSpawnWriter(child: ChildProcess): ReviewWriterHandle | undefined {
			if (!(child instanceof ChildProcess) || !Number.isSafeInteger(child.pid) || !Array.isArray(child.stdio)) return undefined;
			const stream = child.stdio[3];
			if (!(stream instanceof Writable) || stream.destroyed || !stream.writable || child.stdio.slice(0, 3).includes(stream) || registered.has(stream)) return undefined;
			registered.add(stream);
			const handle = Object.freeze({}) as ReviewWriterHandle; writers.set(handle, stream); return handle;
		},
	});
	resourceAccess.set(resources, {
		takeReader(handle) {
			if (!object(handle)) return false;
			const original = readers.get(handle); if (!original) return false;
			readers.delete(handle);
			try {
				const fresh = fstatSync(3, { bigint: true });
				return fresh.isSocket() && fresh.ino !== 0n && fresh.dev === original.dev && fresh.ino === original.ino && fresh.mode === original.mode;
			} catch { return false; }
		},
		takeWriter(handle) { if (!object(handle)) return undefined; const stream = writers.get(handle); if (stream) writers.delete(handle); return stream; },
	});
	return resources;
}
export type ReviewChannelResources = ReturnType<typeof createReviewChannelResources>;

/** Close is acknowledged by the owned stream's event/state, not by a numeric FD fallback. */
function closeOwned(stream: Readable | Writable, deadline: number): Promise<boolean> {
	if (stream.closed) return Promise.resolve(true);
	return new Promise(resolve => {
		const timer = setTimeout(() => { stream.removeListener("close", closed); resolve(false); }, Math.max(0, deadline - Date.now()));
		function closed() { clearTimeout(timer); resolve(stream.closed); }
		stream.once("close", closed); if (!stream.destroyed) stream.destroy();
	});
}

/** Internal trusted host primitive. Secrets stay in closures and the dedicated in-memory pipe. */
export function createLaunchChannel(value: ReviewLaunchIdentityV1, resources: ReviewChannelResources) {
	const launch = identity(value); const key = randomBytes(32); let transferred = false;
	return Object.freeze({
		async writeInitial(handle: ReviewWriterHandle, absoluteDeadline: number): Promise<void> {
			if (transferred) return invalid();
			const deadline = boundedDeadline(absoluteDeadline); if (deadline === undefined) return invalid();
			const stream = resourceAccess.get(resources)?.takeWriter(handle); if (!stream) return invalid();
			transferred = true;
			let frame: Buffer | undefined; let completed = false;
			try {
				frame = encode({ version: 1, identity: launch, key: key.toString("hex") }, 4096);
				const bytes = frame;
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => { stream.destroy(); reject(new Error("Review channel deadline")); }, Math.max(0, deadline - Date.now()));
					const failed = () => { clearTimeout(timer); reject(new Error("Review channel write failed")); };
					// A write callback can precede its queued error event. Keep the owned
					// stream's handler for its lifetime, including close and late callbacks.
					stream.on("error", failed);
					stream.write(bytes, error => {
						completed = true; bytes.fill(0);
						if (error) { clearTimeout(timer); reject(new Error("Review channel write failed")); }
						else stream.end(() => { clearTimeout(timer); resolve(); });
					});
				});
			} finally {
				// A pending write retains its buffer until its own callback (never zero early).
				if (completed) frame?.fill(0);
				if (!await closeOwned(stream, deadline)) throw new Error("Review channel close unconfirmed");
			}
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

/** Await before execution-load. Finalization is a trusted closure, not a signing tool. */
export async function receiveRunnerReviewChannel(resources: ReviewChannelResources, handle: ReviewReaderHandle | undefined, actualConfigBytes: Uint8Array, actualFinalization: () => unknown, absoluteDeadline: number, diagnostic?: (value: ReviewChannelDiagnostic) => void): Promise<{ finalize(): SignedReviewTerminal } | undefined> {
	const deadline = boundedDeadline(absoluteDeadline);
	if (deadline === undefined || !resourceAccess.get(resources)?.takeReader(handle)) return undefined;
	const frame = Buffer.alloc(4097); let length = 0; let readCount = 0; let eof = false; const start = Date.now();
	let stream: Readable | undefined; let closeAttempted = false;
	try {
		stream = process.versions.bun ? createReadStream("", { fd: 3, autoClose: true, highWaterMark: 4097 }) : new Socket({ fd: 3, readable: true, writable: false });
		const owned = stream;
		const valid = await new Promise<boolean>(resolve => {
			let settled = false;
			const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
			function finish(value: boolean) { if (settled) return; settled = true; clearTimeout(timer); owned.pause(); resolve(value); }
			owned.on("data", (chunk: Buffer) => {
				if (settled) return;
				readCount++; const count = Math.min(chunk.length, frame.length - length); chunk.copy(frame, length, 0, count); length += count;
				if (length > 4096 || Date.now() >= deadline) finish(false);
			});
			owned.once("end", () => { eof = true; finish(Date.now() < deadline); });
			owned.on("error", () => finish(false)); owned.once("close", () => finish(false));
		});
		closeAttempted = true;
		if (!await closeOwned(owned, deadline) || !valid || !eof || length > 4096) return undefined;
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
	finally {
		frame.fill(0); if (stream && !closeAttempted) await closeOwned(stream, deadline);
		try { diagnostic?.(Object.freeze({ readCount, length, elapsedMs: Date.now() - start, eof })); } catch { /* Diagnostics never affect cleanup or authority. */ }
	}
}
