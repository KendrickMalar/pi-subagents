import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLaunchChannel, decodeReviewTerminal, encodeReviewIdentity, encodeReviewTerminal, validateRawReviewOutcome, type ReviewChannelResources, type ReviewWriterHandle, type RawReviewOutcomeV1, type ReviewLaunchIdentityV1, type ReviewTerminalEnvelopeV1 } from "./review-provenance-channel.ts";

declare const launchBrand: unique symbol;
declare const terminalBrand: unique symbol;
export type ReviewLaunchCapability = Readonly<{ [launchBrand]: true }>;
export type ReviewTerminalCapability = Readonly<{ [terminalBrand]: true }>;
export interface ReviewHostLifetime { ownerSessionId: string; ownerSubtreeId: string; processInstanceId: string }
export interface ReviewLaunchInput { subjectRunId: string; childIndex?: number; cwd: string; configBytes: Uint8Array }

/** Construct once per extension lifetime from actual caller context; inject the SAME object across loaders.
	* These callbacks are trusted native lifecycle boundaries. This primitive does not establish their provenance.
	*/
export function createReviewAuthorityHost(lifetime: ReviewHostLifetime, resources: ReviewChannelResources, isActive: () => boolean = () => true) {
	const owner = { ownerSessionId: lifetime.ownerSessionId, ownerSubtreeId: lifetime.ownerSubtreeId, processInstanceId: lifetime.processInstanceId };
	type Entry = { identity: ReviewLaunchIdentityV1; channel: ReturnType<typeof createLaunchChannel>; mode?: "async" | "foreground"; close?: RawReviewOutcomeV1; closeInvalid: boolean; consumed: boolean };
	const launches = new WeakMap<object, Entry>();
	const terminals = new WeakMap<object, ReviewTerminalEnvelopeV1>();
	const runIds = new Set<string>();
	function entry(handle: unknown): Entry | undefined { return isActive() && handle !== null && typeof handle === "object" ? launches.get(handle) : undefined; }
	function requireEntry(handle: unknown): Entry { const e = entry(handle); if (!e || e.consumed) throw new Error("Unsupported review launch capability"); return e; }
	function requireCapturedEntry(handle: unknown, captured: Entry): void { if (requireEntry(handle) !== captured) throw new Error("Unsupported review launch capability"); }
	function terminal(e: Entry, value: ReviewTerminalEnvelopeV1): ReviewTerminalCapability {
		e.consumed = true;
		const handle = Object.freeze({}) as ReviewTerminalCapability; terminals.set(handle, value); return handle;
	}
	return Object.freeze({
		issueLaunch(input: ReviewLaunchInput): ReviewLaunchCapability {
			if (!isActive()) throw new Error("Inactive review owner");
			const configDigest = createHash("sha256").update(input.configBytes).digest("hex");
			const launch = JSON.parse(encodeReviewIdentity({ version: 1, subjectRunId: input.subjectRunId, ...(input.childIndex !== undefined ? { childIndex: input.childIndex } : {}), ...owner, nonce: randomBytes(16).toString("hex"), configDigest, cwd: input.cwd }).toString()) as ReviewLaunchIdentityV1;
			Object.freeze(launch);
			if (runIds.has(launch.subjectRunId)) throw new Error("Duplicate review launch");
			const channel = createLaunchChannel(launch, resources); runIds.add(launch.subjectRunId);
			const handle = Object.freeze({}) as ReviewLaunchCapability;
			launches.set(handle, { identity: launch, channel, closeInvalid: false, consumed: false }); return handle;
		},
		hasLaunch(handle: unknown): boolean { return entry(handle) !== undefined; },
		writeLaunch(handle: ReviewLaunchCapability, writer: ReviewWriterHandle, absoluteDeadline: number): Promise<void> {
			const e = requireEntry(handle);
			return e.channel.writeInitial(writer, absoluteDeadline).then(() => { requireCapturedEntry(handle, e); });
		},
		bindAsyncClose(handle: ReviewLaunchCapability, subscribeActualClose: (observe: (outcome: RawReviewOutcomeV1) => void) => void): void {
			const e = requireEntry(handle); if (e.mode) throw new Error("Review launch already bound"); e.mode = "async";
			try { subscribeActualClose(outcome => {
				if (entry(handle) !== e) { e.closeInvalid = true; return; }
				if (e.close || e.closeInvalid) { e.closeInvalid = true; return; }
				try {
					const close = validateRawReviewOutcome(outcome);
					requireCapturedEntry(handle, e); e.close = close;
				} catch { e.closeInvalid = true; }
			}); requireCapturedEntry(handle, e); } catch (error) { e.closeInvalid = true; throw error; }
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
			requireCapturedEntry(handle, e);
			// Runtime strict validation includes unknown callback fields; no caller acceptance projection.
			if (!capture || typeof capture !== "object" || Object.getPrototypeOf(capture) !== Object.prototype || Reflect.ownKeys(capture).some(key => typeof key !== "string" || ["version", "identity"].includes(key)) || Object.values(Object.getOwnPropertyDescriptors(capture)).some(d => !Object.hasOwn(d, "value"))) throw new Error("Invalid review finalization");
			const value = decodeReviewTerminal(encodeReviewTerminal({ version: 1, identity: e.identity, ...capture }));
			requireCapturedEntry(handle, e);
			e.mode = "foreground"; return terminal(e, value);
		},
		getTerminal(handle: unknown): ReviewTerminalEnvelopeV1 | undefined { return isActive() && handle !== null && typeof handle === "object" ? terminals.get(handle) : undefined; },
	});
}
export type ReviewAuthorityHost = ReturnType<typeof createReviewAuthorityHost>;

declare const scopeBrand: unique symbol;
declare const admissionBrand: unique symbol;
export type ReviewOwnerScope = Readonly<{ [scopeBrand]: true }>;
export type ReviewAdmission = Readonly<{ [admissionBrand]: true }>;
export interface ActualNativeReviewAssignment { nativeRunId: string; index?: number; attemptId: string }
type ActualCaller = Pick<ExtensionContext, "sessionManager">;

/** Snapshot only at a trusted extension-handler admission, never from tool params.
 * SDK contexts have no authentication brand: this is an internal injection boundary,
 * not a sandbox against malicious loaded host code. No dynamic getter survives admission.
 */
function snapshotActualCaller(actual: ActualCaller | unknown): { sessionManagerRef: object; sdkSessionId: string } | undefined {
	try {
		if (!actual || typeof actual !== "object") return undefined;
		const manager: unknown = (actual as ActualCaller).sessionManager;
		if (!manager || typeof manager !== "object") return undefined;
		const getter = (manager as ActualCaller["sessionManager"]).getSessionId;
		if (typeof getter !== "function") return undefined;
		const id: unknown = getter.call(manager);
		if (typeof id !== "string" || !id.trim()) return undefined;
		return { sessionManagerRef: manager, sdkSessionId: id };
	} catch { return undefined; }
}

/** Ownerless constructor. The returned object belongs only to trusted native host code.
 * Neither this coordinator nor its opaque handles belong in a tool DTO/config/status.
 * Process grants, v2 codecs, actual capture and public review APIs are separate stages.
 */
export function createReviewCoordinator() {
	const hostInstanceId = randomUUID();
	type Scope = { metadata: Readonly<{ sessionManagerRef: object; sdkSessionId: string; hostInstanceId: string; epochId: string; scopeId: string; ownerDomain: object; parentScope?: Scope }>; active: boolean; children: Set<Scope> };
	type Admission = Readonly<{ ownerScope: Scope; admissionId: string; actualNativeRunId: string; index?: number; attemptId: string; order: number }>;
	const scopes = new WeakMap<object, Scope>();
	const admissions = new WeakMap<object, Admission>();
	const roots = new WeakMap<object, { scope: Scope; handle: ReviewOwnerScope }>();
	const childScopes = new WeakMap<object, { scope: Scope; handle: ReviewOwnerScope }>();
	const allRoots = new Set<Scope>();
	let order = 0;
	function scopeEntry(handle: unknown): Scope | undefined { return handle !== null && typeof handle === "object" ? scopes.get(handle) : undefined; }
	function active(scope: Scope | undefined): scope is Scope { return !!scope && scope.active && (!scope.metadata.parentScope || active(scope.metadata.parentScope)); }
	function requireScope(handle: unknown): Scope { const scope = scopeEntry(handle); if (!active(scope)) throw new Error("Inactive or unsupported review scope"); return scope; }
	function revoke(scope: Scope): void { scope.active = false; for (const child of scope.children) revoke(child); }
	function newScope(snapshot: NonNullable<ReturnType<typeof snapshotActualCaller>>, ownerDomain: object, parent?: Scope) {
		const scope: Scope = { metadata: Object.freeze({ ...snapshot, hostInstanceId, epochId: parent?.metadata.epochId ?? randomUUID(), scopeId: randomUUID(), ownerDomain, ...(parent ? { parentScope: parent } : {}) }), active: true, children: new Set() };
		const handle = Object.freeze({}) as ReviewOwnerScope;
		scopes.set(handle, scope);
		if (parent) parent.children.add(scope); else allRoots.add(scope);
		return { scope, handle };
	}
	return Object.freeze({
		admitActualCaller(actualExtensionCtx: ActualCaller | unknown, privateOwnerDomain: object, parentAdmission?: unknown): ReviewOwnerScope | undefined {
			if (!privateOwnerDomain || typeof privateOwnerDomain !== "object") return undefined;
			const snapshot = snapshotActualCaller(actualExtensionCtx); if (!snapshot) return undefined;
			let parent: Scope | undefined;
			if (parentAdmission !== undefined) {
				const ticket = parentAdmission !== null && typeof parentAdmission === "object" ? admissions.get(parentAdmission) : undefined;
				if (!ticket || !active(ticket.ownerScope) || ticket.ownerScope.metadata.ownerDomain !== privateOwnerDomain) return undefined;
				parent = ticket.ownerScope;
			}
			const cache = parent ? childScopes : roots;
			const cacheKey = parent ? parentAdmission as object : privateOwnerDomain;
			const prior = cache.get(cacheKey);
			// An actual child admission is one-attach, never a session-rebinding mint.
			if (parent && prior && !active(prior.scope)) return undefined;
			if (prior && active(prior.scope)) {
				if (prior.scope.metadata.sessionManagerRef === snapshot.sessionManagerRef && prior.scope.metadata.sdkSessionId === snapshot.sdkSessionId) return prior.handle;
				revoke(prior.scope);
				if (parent) return undefined;
			}
			const created = newScope(snapshot, privateOwnerDomain, parent); cache.set(cacheKey, created); return created.handle;
		},
		hasScope(handle: unknown): boolean { return active(scopeEntry(handle)); },
		issueChildAdmission(ownedParentScope: ReviewOwnerScope | unknown, actualNativeAssignment: ActualNativeReviewAssignment): ReviewAdmission {
			const scope = requireScope(ownedParentScope);
			// IDs are supplied by the actual native assignment boundary, not restored run JSON.
			const { nativeRunId, index, attemptId } = actualNativeAssignment;
			if (typeof nativeRunId !== "string" || !nativeRunId.trim() || typeof attemptId !== "string" || !attemptId.trim() || (index !== undefined && (!Number.isSafeInteger(index) || index < 0)) || !Number.isSafeInteger(order)) throw new Error("Invalid actual native assignment");
			const ticket = Object.freeze({}) as ReviewAdmission;
			admissions.set(ticket, Object.freeze({ ownerScope: scope, admissionId: randomUUID(), actualNativeRunId: nativeRunId, ...(index !== undefined ? { index } : {}), attemptId, order: order++ }));
			return ticket;
		},
		invalidateOwner(reason: string, ownedScope?: ReviewOwnerScope): void {
			if (reason === "messageAppend") return;
			if (ownedScope !== undefined) { const scope = scopeEntry(ownedScope); if (scope) revoke(scope); }
			else for (const root of allRoots) revoke(root);
		},
		createAuthorityHost(ownedScope: ReviewOwnerScope, resources: ReviewChannelResources): ReviewAuthorityHost {
			const scope = requireScope(ownedScope);
			return createReviewAuthorityHost({ ownerSessionId: scope.metadata.sdkSessionId, ownerSubtreeId: scope.metadata.scopeId, processInstanceId: hostInstanceId }, resources, () => active(scope));
		},
	});
}
export type ReviewCoordinator = ReturnType<typeof createReviewCoordinator>;
