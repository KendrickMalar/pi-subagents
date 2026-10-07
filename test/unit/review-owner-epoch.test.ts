import assert from "node:assert/strict";
import test from "node:test";
import * as binding from "../../src/runs/shared/review-binding.ts";
import { createReviewChannelResources } from "../../src/runs/shared/review-provenance-channel.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const input = { subjectRunId: "run", cwd: "/repo", configBytes: Buffer.from("actual") };
const capture = { rawOutcome: { exitCode: 1, signal: null }, originalAcceptanceDigest: "a".repeat(64), evidenceDigest: "b".repeat(64), repo: "/repo", cwd: "/repo", head: "c".repeat(40), trackedStateDigest: "d".repeat(64), captureTime: 10 };
const ctx = (id = "session") => ({ sessionManager: { getSessionId: () => id } });

test("existing host refuses every captured operation after private active guard revocation", async () => {
	let active = true;
	const host = binding.createReviewAuthorityHost({ ownerSessionId: "session", ownerSubtreeId: "scope", processInstanceId: "host" }, createReviewChannelResources(), () => active);
	const launch = host.issueLaunch(input);
	const terminal = host.registerForegroundTerminal(launch, () => capture);
	const pending = host.issueLaunch({ ...input, subjectRunId: "pending" });
	const { issueLaunch, hasLaunch, getTerminal, registerForegroundTerminal, bindAsyncClose, verifyAsyncTerminal, writeLaunch } = host;
	active = false;
	assert.equal(hasLaunch(launch), false);
	assert.equal(getTerminal(terminal), undefined);
	assert.throws(() => issueLaunch({ ...input, subjectRunId: "late" }));
	let called = false;
	assert.throws(() => registerForegroundTerminal(pending, () => { called = true; return capture; }));
	assert.throws(() => bindAsyncClose(pending, () => { called = true; }));
	assert.equal(verifyAsyncTerminal(pending, Buffer.alloc(0), Buffer.alloc(0)), undefined);
	assert.throws(() => writeLaunch(pending, Object.freeze({}) as Parameters<typeof writeLaunch>[1], Date.now() + 1000));
	assert.equal(called, false);
});

test("captured write rejects revoked epoch after real FD3 delivery even with a newly admitted epoch", async () => {
	const c = binding.createReviewCoordinator(); const domain = {}; let reads = 0;
	const actual = { sessionManager: { getSessionId: () => { reads++; return "session"; } } };
	const scope = c.admitActualCaller(actual, domain); assert.ok(scope);
	const resources = createReviewChannelResources(); const host = c.createAuthorityHost(scope, resources);
	const launch = host.issueLaunch(input);
	const child = spawn(process.execPath, ["-e", `const {Socket}=require('node:net');const s=new Socket({fd:3,readable:true,writable:false});let received=false;s.on('data',()=>{received=true});s.on('end',()=>console.log(received?'received-frame':'empty'));s.on('error',e=>{console.error(e.code);process.exitCode=1});`], { stdio: ["ignore", "pipe", "pipe", "pipe"], env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PATH: process.env.PATH } });
	let output = "", errors = "";
	child.stdout!.on("data", b => output += b); child.stderr!.on("data", b => errors += b);
	const closed = once(child, "close"); const writer = resources.registerSpawnWriter(child); assert.ok(writer);
	const { writeLaunch } = host; const pending = writeLaunch(launch, writer, Date.now() + 1000);
	c.invalidateOwner("reload", scope);
	const replacement = c.admitActualCaller(actual, domain); assert.ok(replacement); assert.notEqual(replacement, scope);
	let writeOutcome = "resolved"; try { await pending; } catch { writeOutcome = "rejected"; }
	const [exit, signal] = await closed;
	console.log(JSON.stringify({ writeOutcome, ownerActive: c.hasScope(scope), childExit: exit, childSignal: signal, childOutput: output.trim(), childErrors: errors.trim() }));
	assert.equal(exit, 0); assert.equal(signal, null); assert.equal(output.trim(), "received-frame"); assert.equal(errors, "");
	assert.equal(reads, 2, "completion must not reread SDK identity or re-admit");
	assert.equal(writeOutcome, "rejected"); assert.equal(host.hasLaunch(launch), false);
});

test("subscription revocation rejects completion and late close across a replacement epoch", () => {
	const c = binding.createReviewCoordinator(); const domain = {}; const actual = ctx();
	const scope = c.admitActualCaller(actual, domain); assert.ok(scope);
	const host = c.createAuthorityHost(scope, createReviewChannelResources()); const launch = host.issueLaunch(input);
	let close: (outcome: typeof capture.rawOutcome) => void = () => { throw Error("missing observer"); };
	assert.throws(() => host.bindAsyncClose(launch, observe => {
		close = observe; c.invalidateOwner("reload", scope);
		assert.ok(c.admitActualCaller(actual, domain)); observe(capture.rawOutcome);
	}));
	close(capture.rawOutcome);
	assert.equal(host.hasLaunch(launch), false);
	assert.equal(host.verifyAsyncTerminal(launch, Buffer.alloc(0), Buffer.alloc(0)), undefined);
	assert.equal(host.getTerminal({}), undefined);
	assert.throws(() => host.issueLaunch({ ...input, subjectRunId: "late" }));
	assert.throws(() => host.bindAsyncClose(launch, () => assert.fail("inactive subscriber called")));
	assert.throws(() => host.registerForegroundTerminal(launch, () => assert.fail("inactive finalizer called")));
});

test("finalization revocation rejects captured original scope despite replacement admission", () => {
	const c = binding.createReviewCoordinator(); const domain = {}; const actual = ctx();
	const scope = c.admitActualCaller(actual, domain); assert.ok(scope);
	const host = c.createAuthorityHost(scope, createReviewChannelResources()); const launch = host.issueLaunch(input);
	assert.throws(() => host.registerForegroundTerminal(launch, () => {
		c.invalidateOwner("reload", scope); assert.ok(c.admitActualCaller(actual, domain)); return capture;
	}));
	assert.equal(host.hasLaunch(launch), false); assert.equal(host.getTerminal({}), undefined);
});

test("finalization validation cannot publish a terminal after callback capture revokes its epoch", () => {
	const c = binding.createReviewCoordinator(); const scope = c.admitActualCaller(ctx(), {}); assert.ok(scope);
	const host = c.createAuthorityHost(scope, createReviewChannelResources()); const launch = host.issueLaunch(input);
	const captured = new Proxy(capture, { getPrototypeOf(target) { c.invalidateOwner("reload", scope); return Object.getPrototypeOf(target); } });
	assert.throws(() => host.registerForegroundTerminal(launch, () => captured));
	assert.equal(host.hasLaunch(launch), false); assert.equal(host.getTerminal({}), undefined);
});

test("constructor creates no owner; missing and serialized caller data cannot mint scopes", () => {
	assert.equal(typeof binding.createReviewCoordinator, "function");
	const c = binding.createReviewCoordinator();
	const domain = {};
	for (const fake of [undefined, null, {}, "session", { sessionManager: { sessionId: "session", sessionFile: "/session", leafId: "leaf" } }, JSON.parse(JSON.stringify(ctx())), { sessionManager: { getSessionId: () => "" } }, { get sessionManager() { throw Error("unavailable"); } }]) {
		assert.equal(c.admitActualCaller(fake, domain), undefined);
	}
	assert.equal(c.hasScope({}), false);
	assert.throws(() => c.issueChildAdmission({}, { nativeRunId: "r", attemptId: "a" }));
});

test("snapshot reads actual identity once; wrappers reuse but manager/session/domain/host isolate", () => {
	const c = binding.createReviewCoordinator(); const domain = {};
	let id = "first", reads = 0, managerReads = 0;
	const manager = { getSessionId: () => { reads++; return id; } };
	const actual = { get sessionManager() { managerReads++; return manager; } };
	const first = c.admitActualCaller(actual, domain); assert.ok(first);
	assert.equal(reads, 1); assert.equal(managerReads, 1);
	assert.equal(c.admitActualCaller({ sessionManager: manager }, domain), first);
	const scheduled = c.admitActualCaller({ sessionManager: manager }, {}); assert.ok(scheduled); assert.notEqual(scheduled, first);
	assert.equal(binding.createReviewCoordinator().hasScope(first), false);
	assert.equal(c.hasScope({ ...first }), false);
	assert.deepEqual(Object.keys(first), []); assert.ok(Object.isFrozen(first));
	id = "second";
	const next = c.admitActualCaller(actual, domain); assert.ok(next); assert.notEqual(next, first); assert.equal(c.hasScope(first), false);
	const replaced = c.admitActualCaller(ctx("second"), domain); assert.ok(replaced); assert.notEqual(replaced, next); assert.equal(c.hasScope(next), false);
});

test("opaque private admission attaches descendants; clones cross-owner and scheduled spreads reject", () => {
	const c = binding.createReviewCoordinator(); const domain = {}; const root = c.admitActualCaller(ctx(), domain); assert.ok(root);
	const ticket = c.issueChildAdmission(root, { nativeRunId: "native", index: 0, attemptId: "attempt" });
	assert.ok(Object.isFrozen(ticket)); assert.deepEqual(Object.keys(ticket), []);
	for (const fake of [{}, { ...ticket }, JSON.parse(JSON.stringify(ticket))]) assert.equal(c.admitActualCaller(ctx("child"), domain, fake), undefined);
	assert.equal(binding.createReviewCoordinator().admitActualCaller(ctx("child"), domain, ticket), undefined);
	assert.equal(c.admitActualCaller(ctx("child"), {}, ticket), undefined);
	const child = c.admitActualCaller(ctx("child"), domain, ticket); assert.ok(child);
	const grandTicket = c.issueChildAdmission(child, { nativeRunId: "nested", attemptId: "attempt" });
	const grand = c.admitActualCaller(ctx("grand"), domain, grandTicket); assert.ok(grand);
	const { issueChildAdmission } = c;
	c.invalidateOwner("treeNavigation", root);
	for (const scope of [root, child, grand]) { assert.equal(c.hasScope(scope), false); assert.throws(() => issueChildAdmission(scope, { nativeRunId: "late", attemptId: "attempt" })); }
	assert.equal(c.admitActualCaller(ctx("child"), domain, ticket), undefined);
});

test("parent admission binds once; changed child identity cannot reattach or revive", () => {
	const c = binding.createReviewCoordinator(); const domain = {}; const root = c.admitActualCaller(ctx(), domain); assert.ok(root);
	for (const change of ["session", "manager"]) {
		const ticket = c.issueChildAdmission(root, { nativeRunId: change, attemptId: "attempt" });
		let id = "child"; const manager = { getSessionId: () => id };
		const child = c.admitActualCaller({ sessionManager: manager }, domain, ticket); assert.ok(child);
		assert.equal(c.admitActualCaller({ sessionManager: manager }, domain, ticket), child);
		id = change === "session" ? "changed" : "child";
		const changed = change === "manager" ? ctx("child") : { sessionManager: manager };
		assert.equal(c.admitActualCaller(changed, domain, ticket), undefined);
		assert.equal(c.hasScope(child), false);
		id = "child";
		assert.equal(c.admitActualCaller({ sessionManager: manager }, domain, ticket), undefined);
	}
});

test("all lifecycle invalidations revoke guarded hosts; messageAppend preserves failure and history bytes", () => {
	for (const reason of ["new", "resume", "fork", "reload", "shutdown", "treeNavigation"]) {
		const c = binding.createReviewCoordinator(); const scope = c.admitActualCaller(ctx(), {}); assert.ok(scope);
		const host = c.createAuthorityHost(scope, createReviewChannelResources());
		const launch = host.issueLaunch(input); const terminal = host.registerForegroundTerminal(launch, () => capture);
		const bytes = Buffer.from(JSON.stringify({ status: "failed", acceptance: "review-required", capture })); const saved = Buffer.from(bytes);
		c.invalidateOwner("messageAppend"); assert.equal(host.getTerminal(terminal)?.rawOutcome.exitCode, 1);
		c.invalidateOwner(reason); assert.equal(host.getTerminal(terminal), undefined); assert.equal(host.hasLaunch(launch), false);
		assert.throws(() => host.issueLaunch({ ...input, subjectRunId: "later" })); assert.deepEqual(bytes, saved);
	}
});

test("actual SDK SessionManager identity in isolated synthetic HOME admits and snapshots", () => {
	const root = mkdtempSync(join(tmpdir(), "owner-sdk-"));
	const manager = SessionManager.create(root, join(root, "sessions"));
	const c = binding.createReviewCoordinator(); const domain = {};
	const scope = c.admitActualCaller({ sessionManager: manager }, domain); assert.ok(scope);
	assert.ok(manager.getSessionId());
	assert.equal(c.admitActualCaller({ sessionManager: manager }, domain), scope);
	assert.equal(c.admitActualCaller(JSON.parse(JSON.stringify({ sessionManager: manager })), domain), undefined);
});
