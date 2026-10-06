import { createHash, randomBytes } from "node:crypto";
import { createLaunchChannel, decodeReviewTerminal, encodeReviewIdentity, encodeReviewTerminal, validateRawReviewOutcome, type RawReviewOutcomeV1, type ReviewLaunchIdentityV1, type ReviewTerminalEnvelopeV1 } from "./review-provenance-channel.ts";

declare const launchBrand: unique symbol;
declare const terminalBrand: unique symbol;
export type ReviewLaunchCapability = Readonly<{ [launchBrand]: true }>;
export type ReviewTerminalCapability = Readonly<{ [terminalBrand]: true }>;
export interface ReviewHostLifetime { ownerSessionId: string; ownerSubtreeId: string; processInstanceId: string }
export interface ReviewLaunchInput { subjectRunId: string; childIndex?: number; cwd: string; configBytes: Uint8Array }

/** Construct once per extension lifetime from actual caller context; inject the SAME object across loaders.
	* These callbacks are trusted native lifecycle boundaries. This primitive does not establish their provenance.
	*/
export function createReviewAuthorityHost(lifetime: ReviewHostLifetime) {
	const owner = { ownerSessionId: lifetime.ownerSessionId, ownerSubtreeId: lifetime.ownerSubtreeId, processInstanceId: lifetime.processInstanceId };
	type Entry = { identity: ReviewLaunchIdentityV1; channel: ReturnType<typeof createLaunchChannel>; mode?: "async" | "foreground"; close?: RawReviewOutcomeV1; closeInvalid: boolean; consumed: boolean };
	const launches = new WeakMap<object, Entry>();
	const terminals = new WeakMap<object, ReviewTerminalEnvelopeV1>();
	const runIds = new Set<string>();
	function entry(handle: unknown): Entry | undefined { return handle !== null && typeof handle === "object" ? launches.get(handle) : undefined; }
	function requireEntry(handle: unknown): Entry { const e = entry(handle); if (!e || e.consumed) throw new Error("Unsupported review launch capability"); return e; }
	function terminal(e: Entry, value: ReviewTerminalEnvelopeV1): ReviewTerminalCapability {
		e.consumed = true;
		const handle = Object.freeze({}) as ReviewTerminalCapability; terminals.set(handle, value); return handle;
	}
	return Object.freeze({
		issueLaunch(input: ReviewLaunchInput): ReviewLaunchCapability {
			const configDigest = createHash("sha256").update(input.configBytes).digest("hex");
			const launch = JSON.parse(encodeReviewIdentity({ version: 1, subjectRunId: input.subjectRunId, ...(input.childIndex !== undefined ? { childIndex: input.childIndex } : {}), ...owner, nonce: randomBytes(16).toString("hex"), configDigest, cwd: input.cwd }).toString()) as ReviewLaunchIdentityV1;
			Object.freeze(launch);
			if (runIds.has(launch.subjectRunId)) throw new Error("Duplicate review launch");
			const channel = createLaunchChannel(launch); runIds.add(launch.subjectRunId);
			const handle = Object.freeze({}) as ReviewLaunchCapability;
			launches.set(handle, { identity: launch, channel, closeInvalid: false, consumed: false }); return handle;
		},
		hasLaunch(handle: unknown): boolean { return entry(handle) !== undefined; },
		writeLaunchToFd(handle: ReviewLaunchCapability, fd: number): void { requireEntry(handle).channel.writeInitialToFd(fd); },
		bindAsyncClose(handle: ReviewLaunchCapability, subscribeActualClose: (observe: (outcome: RawReviewOutcomeV1) => void) => void): void {
			const e = requireEntry(handle); if (e.mode) throw new Error("Review launch already bound"); e.mode = "async";
			try { subscribeActualClose(outcome => {
				if (e.close || e.closeInvalid) { e.closeInvalid = true; return; }
				try { e.close = validateRawReviewOutcome(outcome); } catch { e.closeInvalid = true; }
			}); } catch (error) { e.closeInvalid = true; throw error; }
		},
		verifyAsyncTerminal(handle: ReviewLaunchCapability, bytes: Uint8Array, tag: Uint8Array): ReviewTerminalCapability | undefined {
			const e = entry(handle);
			if (!e || e.consumed || e.mode !== "async" || !e.close || e.closeInvalid) return undefined;
			const value = e.channel.verifyTerminal(bytes, tag);
			if (!value || value.rawOutcome.exitCode !== e.close.exitCode || value.rawOutcome.signal !== e.close.signal) return undefined;
			return terminal(e, value);
		},
		registerForegroundTerminal(handle: ReviewLaunchCapability, actualFinalization: () => unknown): ReviewTerminalCapability {
			const e = requireEntry(handle); if (e.mode) throw new Error("Review launch already bound");
			const capture = actualFinalization();
			// Runtime strict validation includes unknown callback fields; no caller acceptance projection.
			if (!capture || typeof capture !== "object" || Object.getPrototypeOf(capture) !== Object.prototype || Reflect.ownKeys(capture).some(key => typeof key !== "string" || ["version", "identity"].includes(key)) || Object.values(Object.getOwnPropertyDescriptors(capture)).some(d => !Object.hasOwn(d, "value"))) throw new Error("Invalid review finalization");
			const value = decodeReviewTerminal(encodeReviewTerminal({ version: 1, identity: e.identity, ...capture }));
			e.mode = "foreground"; return terminal(e, value);
		},
		getTerminal(handle: unknown): ReviewTerminalEnvelopeV1 | undefined { return handle !== null && typeof handle === "object" ? terminals.get(handle) : undefined; },
	});
}
export type ReviewAuthorityHost = ReturnType<typeof createReviewAuthorityHost>;
