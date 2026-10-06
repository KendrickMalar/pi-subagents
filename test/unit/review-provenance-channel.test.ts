import assert from "node:assert/strict";
import test from "node:test";
import { openSync, closeSync, mkdtempSync, readFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createLaunchChannel, receiveRunnerReviewChannel, encodeReviewIdentity, encodeReviewTerminal, decodeReviewTerminal, type ReviewLaunchIdentityV1, type ReviewTerminalCaptureV1 } from "../../src/runs/shared/review-provenance-channel.ts";

const config = Buffer.from('{"actual":true}');
const digest = "a".repeat(64);
const identity: ReviewLaunchIdentityV1 = { version: 1, subjectRunId: "run-1", childIndex: 0, ownerSessionId: "session", ownerSubtreeId: "tree", processInstanceId: "instance", nonce: "b".repeat(32), configDigest: createHash("sha256").update(config).digest("hex"), cwd: "/repo" };
const capture: ReviewTerminalCaptureV1 = { rawOutcome: { exitCode: 1, signal: null }, originalAcceptanceDigest: digest, evidenceDigest: digest, repo: "/repo", cwd: "/repo", head: "c".repeat(40), trackedStateDigest: digest, captureTime: 123 };
function transfer(actualConfig = config, actualCapture: () => unknown = () => capture) {
	const channel = createLaunchChannel(identity);
	const file = join(mkdtempSync(join(tmpdir(), "review-channel-")), "fd");
	channel.writeInitialToFd(openSync(file, "w", 0o600));
	const fd = openSync(file, "r");
	const runner = receiveRunnerReviewChannel(fd, actualConfig, actualCapture);
	assert.throws(() => closeSync(fd), { code: "EBADF" });
	return { channel, runner, file };
}

test("FD-received private signer authenticates raw failure and is one-shot", () => {
	const { channel, runner } = transfer();
	assert.ok(runner);
	assert.deepEqual(Object.keys(runner), ["finalize"]);
	const signed = runner.finalize();
	assert.equal(channel.verifyTerminal(signed.bytes, signed.tag)?.rawOutcome.exitCode, 1);
	assert.throws(() => runner.finalize());
	const bad = Buffer.from(signed.tag); bad[0] = bad[0]! ^ 1;
	assert.equal(channel.verifyTerminal(signed.bytes, bad), undefined);
	assert.equal(channel.verifyTerminal(signed.bytes, Buffer.alloc(1)), undefined);
	assert.equal(channel.verifyTerminal(Buffer.concat([signed.bytes, Buffer.from(" ")]), signed.tag), undefined);
	assert.equal(channel.verifyTerminal(Buffer.alloc(65537), signed.tag), undefined);
	assert.equal(createLaunchChannel(identity).verifyTerminal(signed.bytes, signed.tag), undefined);
});

test("config drift, malformed actual capture and repeated transfer produce no proof", () => {
	assert.equal(transfer(Buffer.from("edited")).runner, undefined);
	const { runner, channel } = transfer(config, () => ({ ...capture, reviewed: true }));
	assert.ok(runner); assert.throws(() => runner.finalize());
	const file = join(mkdtempSync(join(tmpdir(), "review-repeat-")), "frame");
	const fd = openSync(file, "w", 0o600);
	assert.throws(() => channel.writeInitialToFd(fd));
	assert.throws(() => closeSync(fd), { code: "EBADF" });
	assert.equal(readFileSync(file).length, 0);
});

test("strict codecs reject fake fields, invalid values and noncanonical bytes", () => {
	assert.equal(encodeReviewIdentity(identity).toString(), JSON.stringify(identity));
	const envelope = { version: 1 as const, identity, ...capture };
	const bytes = encodeReviewTerminal(envelope);
	assert.deepEqual(decodeReviewTerminal(bytes), envelope);
	for (const invalid of [[], { ...identity, extra: true }, { ...identity, childIndex: NaN }, { ...identity, childIndex: -1 }, { ...identity, cwd: "/repo/../repo" }, { ...identity, cwd: "/repo/" }, { ...identity, subjectRunId: "run\n" }, { ...identity, nonce: "x".repeat(32) }]) assert.throws(() => encodeReviewIdentity(invalid));
	for (const invalid of [{ ...envelope, reviewed: true }, { ...envelope, cwd: "/other" }, { ...envelope, rawOutcome: { exitCode: null, signal: null } }, { ...envelope, rawOutcome: { exitCode: -1, signal: null } }, { ...envelope, rawOutcome: { exitCode: 0, signal: "SIGTERM" } }, { ...envelope, captureTime: Infinity }, { ...envelope, head: "short" }, { ...envelope, evidenceDigest: "A".repeat(64) }, { ...envelope, repo: "/" + "x".repeat(65536) }]) assert.throws(() => encodeReviewTerminal(invalid));
	assert.throws(() => decodeReviewTerminal(Buffer.from(JSON.stringify(envelope, null, 2))));
	assert.throws(() => decodeReviewTerminal(Buffer.from('{"version":1,"version":1}')));
});

test("initial frame limit, truncation and extra bytes fail closed and close FD", () => {
	const { file } = transfer();
	const frame = readFileSync(file);
	// Test files are owned temporary fixtures; never inspect or print frame contents.
	for (const bytes of [Buffer.alloc(4097), frame.subarray(0, frame.length - 1), Buffer.concat([frame, Buffer.from(" ")])]) {
		const fd = openSync(join(mkdtempSync(join(tmpdir(), "review-invalid-")), "frame"), "w+", 0o600);
		// positional write preserves the read cursor at zero
		writeSync(fd, bytes, 0, bytes.length, 0);
		assert.equal(receiveRunnerReviewChannel(fd, config, () => capture), undefined);
		assert.throws(() => closeSync(fd), { code: "EBADF" });
	}
});
