import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { sweepStaleAsyncRuns } from "../../src/runs/background/stale-run-sweep.ts";

function writeStatus(asyncDir: string, status: Record<string, unknown>): void {
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
}

function running(runId: string, pid: number, lastUpdate: number): Record<string, unknown> {
	return { runId, mode: "single", state: "running", pid, startedAt: lastUpdate, lastUpdate, steps: [{ agent: "worker", status: "running", startedAt: lastUpdate }] };
}

describe("stale async run sweep", () => {
	it("fails running runs whose runner is dead and leaves live, finished and broken runs alone", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stale-sweep-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			writeStatus(path.join(asyncRoot, "dead"), running("dead", 111, 1000));
			writeStatus(path.join(asyncRoot, "alive"), running("alive", 222, 1000));
			writeStatus(path.join(asyncRoot, "done"), { runId: "done", mode: "single", state: "complete", startedAt: 1000, steps: [{ agent: "worker", status: "complete" }] });
			fs.mkdirSync(path.join(asyncRoot, "broken"), { recursive: true });
			fs.writeFileSync(path.join(asyncRoot, "broken", "status.json"), "{not json", "utf-8");
			fs.writeFileSync(path.join(asyncRoot, "stray-file"), "x", "utf-8");

			const kill = (pid: number) => {
				if (pid === 222) return true;
				const error = new Error("ESRCH") as NodeJS.ErrnoException;
				error.code = "ESRCH";
				throw error;
			};
			const report = sweepStaleAsyncRuns({ asyncRoot, resultsDir, kill, now: () => 2000 });

			assert.equal(report.checked, 2);
			assert.deepEqual(report.repaired.map((r) => r.runId), ["dead"]);
			assert.equal(JSON.parse(fs.readFileSync(path.join(asyncRoot, "dead", "status.json"), "utf-8")).state, "failed");
			assert.equal(JSON.parse(fs.readFileSync(path.join(asyncRoot, "alive", "status.json"), "utf-8")).state, "running");
			assert.deepEqual(report.errors.map((e) => e.runId), ["broken"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("treats a missing async root as nothing to check", () => {
		const report = sweepStaleAsyncRuns({ asyncRoot: path.join(os.tmpdir(), `pi-stale-sweep-missing-${process.pid}`), resultsDir: os.tmpdir() });
		assert.deepEqual(report, { checked: 0, repaired: [], errors: [] });
	});

	it("runs as a script and prints one JSON line", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stale-sweep-cli-"));
		try {
			writeStatus(path.join(root, "async-subagent-runs", "gone"), running("gone", 2_147_483_000, 1000));
			const script = path.resolve("scripts/reconcile-stale-runs.ts");
			const out = spawnSync(script, [], { env: { ...process.env, PI_SUBAGENTS_TEMP_ROOT: root }, encoding: "utf-8" });
			assert.equal(out.status, 0, out.stderr);
			const lines = out.stdout.trim().split("\n");
			assert.equal(lines.length, 1);
			const report = JSON.parse(lines[0]!);
			assert.equal(report.checked, 1);
			assert.deepEqual(report.repaired.map((r: { runId: string }) => r.runId), ["gone"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
