import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewAuthorityHost } from "../../src/runs/shared/review-binding.ts";
import { receiveRunnerReviewChannel, type ReviewTerminalCaptureV1, type RawReviewOutcomeV1 } from "../../src/runs/shared/review-provenance-channel.ts";
const lifetime = { ownerSessionId: "session", ownerSubtreeId: "tree", processInstanceId: "instance" };
const launchInput = { subjectRunId: "run", childIndex: 1, cwd: "/repo", configBytes: Buffer.from("actual config") };
const capture: ReviewTerminalCaptureV1 = { rawOutcome: { exitCode: 1, signal: null }, originalAcceptanceDigest: "a".repeat(64), evidenceDigest: "b".repeat(64), repo: "/repo", cwd: "/repo", head: "c".repeat(40), trackedStateDigest: "d".repeat(64), captureTime: 10 };
function fixture(actualCapture: () => unknown = () => capture) {
	const host = createReviewAuthorityHost(lifetime);
	const launch = host.issueLaunch(launchInput);
	const file = join(mkdtempSync(join(tmpdir(), "review-binding-")), "channel");
	host.writeLaunchToFd(launch, openSync(file, "w", 0o600));
	const runner = receiveRunnerReviewChannel(openSync(file, "r"), launchInput.configBytes, actualCapture);
	assert.ok(runner);
	let close: (outcome: RawReviewOutcomeV1) => void = () => { throw new Error("not subscribed"); };
	host.bindAsyncClose(launch, (observer) => { close = observer; });
	return { host, launch, signed: runner.finalize(), close };
}
test("injected host validates opaque capabilities, rejects clone, JSON and another host", () => {
	const host = createReviewAuthorityHost(lifetime);
	const launch = host.issueLaunch(launchInput);
	assert.ok(Object.isFrozen(launch)); assert.deepEqual(Object.keys(launch), []);
	assert.equal(host.hasLaunch(launch), true);
	for (const fake of [{}, { ...launch }, JSON.parse(JSON.stringify(launch)), { brand: "ReviewLaunchCapability" }]) assert.equal(host.hasLaunch(fake), false);
	assert.equal(createReviewAuthorityHost(lifetime).hasLaunch(launch), false);
	assert.equal(createReviewAuthorityHost({ ...lifetime, ownerSessionId: "other" }).hasLaunch(launch), false);
	assert.throws(() => host.issueLaunch(launchInput));
});
test("actual close is required, exact raw failure retained, terminal one-shot and opaque", () => {
	const { host, launch, signed, close } = fixture();
	assert.equal(host.verifyAsyncTerminal(launch, signed.bytes, signed.tag), undefined);
	close(capture.rawOutcome);
	const terminal = host.verifyAsyncTerminal(launch, signed.bytes, signed.tag);
	assert.ok(terminal); assert.ok(Object.isFrozen(terminal));
	assert.equal(host.getTerminal(terminal)?.rawOutcome.exitCode, 1);
	assert.equal(host.verifyAsyncTerminal(launch, signed.bytes, signed.tag), undefined);
	assert.equal(host.getTerminal({ ...terminal }), undefined);
	assert.equal(createReviewAuthorityHost(lifetime).getTerminal(terminal), undefined);
	assert.throws(() => host.registerForegroundTerminal(launch, () => capture));
});
test("close mismatch, duplicate close and cross-launch signed identity are rejected", () => {
	const mismatch = fixture(); mismatch.close({ exitCode: 0, signal: null });
	assert.equal(mismatch.host.verifyAsyncTerminal(mismatch.launch, mismatch.signed.bytes, mismatch.signed.tag), undefined);
	const duplicate = fixture(); duplicate.close(capture.rawOutcome); duplicate.close(capture.rawOutcome);
	assert.equal(duplicate.host.verifyAsyncTerminal(duplicate.launch, duplicate.signed.bytes, duplicate.signed.tag), undefined);
	const first = fixture(); const second = fixture(); first.close(capture.rawOutcome); second.close(capture.rawOutcome);
	assert.equal(second.host.verifyAsyncTerminal(second.launch, first.signed.bytes, first.signed.tag), undefined);
	for (const field of ["nonce", "ownerSessionId", "processInstanceId", "childIndex", "configDigest"]) {
		const value = JSON.parse(first.signed.bytes.toString()); value.identity[field] = field === "childIndex" ? 99 : "edited";
		assert.equal(first.host.verifyAsyncTerminal(first.launch, Buffer.from(JSON.stringify(value)), first.signed.tag), undefined);
	}
});
test("foreground captures trusted actual finalization once and validates callback schema", () => {
	const host = createReviewAuthorityHost(lifetime); const launch = host.issueLaunch(launchInput);
	assert.throws(() => host.registerForegroundTerminal(launch, () => ({ ...capture, reviewed: true })));
	assert.throws(() => host.registerForegroundTerminal(launch, () => ({ ...capture, get captureTime() { return 10; } })));
	const terminal = host.registerForegroundTerminal(launch, () => capture);
	assert.deepEqual(host.getTerminal(terminal)?.rawOutcome, { exitCode: 1, signal: null });
	assert.ok(Object.isFrozen(host.getTerminal(terminal)?.identity));
	assert.ok(Object.isFrozen(host.getTerminal(terminal)?.rawOutcome));
	assert.throws(() => host.registerForegroundTerminal(launch, () => capture));
});
