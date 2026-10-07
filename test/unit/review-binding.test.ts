import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createReviewAuthorityHost } from "../../src/runs/shared/review-binding.ts";
import { createReviewChannelResources, type ReviewTerminalCaptureV1, type RawReviewOutcomeV1 } from "../../src/runs/shared/review-provenance-channel.ts";
const lifetime = { ownerSessionId: "session", ownerSubtreeId: "tree", processInstanceId: "instance" };
const launchInput = { subjectRunId: "run", childIndex: 1, cwd: "/repo", configBytes: Buffer.from("actual config") };
const capture: ReviewTerminalCaptureV1 = { rawOutcome: { exitCode: 1, signal: null }, originalAcceptanceDigest: "a".repeat(64), evidenceDigest: "b".repeat(64), repo: "/repo", cwd: "/repo", head: "c".repeat(40), trackedStateDigest: "d".repeat(64), captureTime: 10 };
async function fixture(actualCapture: () => unknown = () => capture, isActive?: () => boolean) {
	const resources = createReviewChannelResources();
	const host = createReviewAuthorityHost(lifetime, resources, isActive);
	const launch = host.issueLaunch(launchInput);
	const url = new URL("../../src/runs/shared/review-provenance-channel.ts", import.meta.url).href;
	const code = `import {createReviewChannelResources,receiveRunnerReviewChannel} from ${JSON.stringify(url)};const r=createReviewChannelResources();const runner=await receiveRunnerReviewChannel(r,r.registerBootstrapReader(),Buffer.from(${JSON.stringify(launchInput.configBytes.toString())}),()=>(${JSON.stringify(actualCapture())}),Date.now()+1000);if(!runner)throw Error('missing signer');const signed=runner.finalize();console.log(JSON.stringify({bytes:signed.bytes.toString('base64'),tag:signed.tag.toString('base64')}));`;
	const child=spawn(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{env:{...process.env,PI_SUBAGENT_REVIEW_CHANNEL_V1:"fd3"},stdio:["ignore","pipe","pipe","pipe"]});
	let stdout="",stderr="";child.stdout!.on("data",b=>stdout+=b);child.stderr!.on("data",b=>stderr+=b);
	const done=new Promise<void>((resolve,reject)=>{child.once("error",reject);child.once("close",exit=>{if(exit===0)resolve();else reject(Error(stderr))})});
	const writer=resources.registerSpawnWriter(child);assert.ok(writer);await host.writeLaunch(launch,writer,Date.now()+1000);await done;
	const raw=JSON.parse(stdout) as {bytes:string;tag:string};const signed={bytes:Buffer.from(raw.bytes,"base64"),tag:Buffer.from(raw.tag,"base64")};
	let close: (outcome: RawReviewOutcomeV1) => void = () => { throw new Error("not subscribed"); };
	host.bindAsyncClose(launch, (observer) => { close = observer; });
	return { host, launch, signed, close };
}
test("injected host validates opaque capabilities, rejects clone, JSON and another host", () => {
	const resources = createReviewChannelResources();
	const host = createReviewAuthorityHost(lifetime, resources);
	const launch = host.issueLaunch(launchInput);
	assert.ok(Object.isFrozen(launch)); assert.deepEqual(Object.keys(launch), []);
	assert.equal(host.hasLaunch(launch), true);
	for (const fake of [{}, { ...launch }, JSON.parse(JSON.stringify(launch)), { brand: "ReviewLaunchCapability" }]) assert.equal(host.hasLaunch(fake), false);
	assert.equal(createReviewAuthorityHost(lifetime, createReviewChannelResources()).hasLaunch(launch), false);
	assert.equal(createReviewAuthorityHost({ ...lifetime, ownerSessionId: "other" }, createReviewChannelResources()).hasLaunch(launch), false);
	assert.throws(() => host.issueLaunch(launchInput));
});
test("actual close is required, exact raw failure retained, terminal one-shot and opaque", async () => {
	const { host, launch, signed, close } = await fixture();
	assert.equal(host.verifyAsyncTerminal(launch, signed.bytes, signed.tag), undefined);
	close(capture.rawOutcome);
	const terminal = host.verifyAsyncTerminal(launch, signed.bytes, signed.tag);
	assert.ok(terminal); assert.ok(Object.isFrozen(terminal));
	assert.equal(host.getTerminal(terminal)?.rawOutcome.exitCode, 1);
	assert.equal(host.verifyAsyncTerminal(launch, signed.bytes, signed.tag), undefined);
	assert.equal(host.getTerminal({ ...terminal }), undefined);
	assert.equal(createReviewAuthorityHost(lifetime, createReviewChannelResources()).getTerminal(terminal), undefined);
	assert.throws(() => host.registerForegroundTerminal(launch, () => capture));
});
test("close mismatch, duplicate close and cross-launch signed identity are rejected", async () => {
	const mismatch = await fixture(); mismatch.close({ exitCode: 0, signal: null });
	assert.equal(mismatch.host.verifyAsyncTerminal(mismatch.launch, mismatch.signed.bytes, mismatch.signed.tag), undefined);
	const duplicate = await fixture(); duplicate.close(capture.rawOutcome); duplicate.close(capture.rawOutcome);
	assert.equal(duplicate.host.verifyAsyncTerminal(duplicate.launch, duplicate.signed.bytes, duplicate.signed.tag), undefined);
	const first = await fixture(); const second = await fixture(); first.close(capture.rawOutcome); second.close(capture.rawOutcome);
	assert.equal(second.host.verifyAsyncTerminal(second.launch, first.signed.bytes, first.signed.tag), undefined);
	for (const field of ["nonce", "ownerSessionId", "processInstanceId", "childIndex", "configDigest"]) {
		const value = JSON.parse(first.signed.bytes.toString()); value.identity[field] = field === "childIndex" ? 99 : "edited";
		assert.equal(first.host.verifyAsyncTerminal(first.launch, Buffer.from(JSON.stringify(value)), first.signed.tag), undefined);
	}
});
test("foreground captures trusted actual finalization once and validates callback schema", () => {
	const resources = createReviewChannelResources();
	const host = createReviewAuthorityHost(lifetime, resources); const launch = host.issueLaunch(launchInput);
	assert.throws(() => host.registerForegroundTerminal(launch, () => ({ ...capture, reviewed: true })));
	assert.throws(() => host.registerForegroundTerminal(launch, () => ({ ...capture, get captureTime() { return 10; } })));
	const terminal = host.registerForegroundTerminal(launch, () => capture);
	assert.deepEqual(host.getTerminal(terminal)?.rawOutcome, { exitCode: 1, signal: null });
	assert.ok(Object.isFrozen(host.getTerminal(terminal)?.identity));
	assert.ok(Object.isFrozen(host.getTerminal(terminal)?.rawOutcome));
	assert.throws(() => host.registerForegroundTerminal(launch, () => capture));
});
test("revocation rejects late actual close, signed terminal and captured native finalizer", async () => {
	let active = true;
	const { host, launch, signed, close } = await fixture(() => capture, () => active);
	const verify = host.verifyAsyncTerminal;
	active = false; close(capture.rawOutcome);
	assert.equal(verify(launch, signed.bytes, signed.tag), undefined);
	assert.equal(host.hasLaunch(launch), false);
	active = true;
	// Late close has been invalidated even if an incorrectly reusable external guard flips.
	assert.equal(verify(launch, signed.bytes, signed.tag), undefined);
	const guarded = createReviewAuthorityHost(lifetime, createReviewChannelResources(), () => active);
	const foreground = guarded.issueLaunch(launchInput);
	assert.throws(() => guarded.registerForegroundTerminal(foreground, () => { active = false; return capture; }));
	assert.equal(guarded.hasLaunch(foreground), false);
});
