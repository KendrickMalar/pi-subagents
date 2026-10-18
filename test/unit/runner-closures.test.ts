import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trackRunnerClosure, waitForRunnerClosures } from "../../src/runs/background/runner-closures.ts";

describe("runner closures", () => {
	it("waits until a tracked child runner close has been finalized", async () => {
		let finish!: () => void;
		trackRunnerClosure(new Promise<void>((resolve) => { finish = resolve; }));
		let waited = false;
		const wait = waitForRunnerClosures(5_000).then(() => { waited = true; });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(waited, false);
		finish();
		await wait;
		assert.equal(waited, true);
	});

	it("stops waiting at the bound when a child runner never closes", async () => {
		let finish!: () => void;
		const closure = new Promise<void>((resolve) => { finish = resolve; });
		trackRunnerClosure(closure);
		const started = Date.now();
		await waitForRunnerClosures(50);
		assert.ok(Date.now() - started < 1_000);
		finish();
		await closure;
	});

	it("does not wait for closures that already finished", async () => {
		const done = Promise.resolve();
		trackRunnerClosure(done);
		await done;
		await new Promise((resolve) => setImmediate(resolve));
		const started = Date.now();
		await waitForRunnerClosures(5_000);
		assert.ok(Date.now() - started < 1_000);
	});
});
