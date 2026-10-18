import * as fs from "node:fs";
import * as path from "node:path";
import { DIRS } from "../../shared/types.ts";
import { reconcileAsyncRun } from "./stale-run-reconciler.ts";

export interface StaleRunSweepOptions {
	asyncRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

export interface StaleRunSweepReport {
	checked: number;
	repaired: { runId: string; message?: string }[];
	errors: { runId: string; error: string }[];
}

/** Reconciles every running async run once, from outside any Pi session (e.g. a launchd watchdog).
 * A run whose runner died is failed by reconcileAsyncRun, which writes its result; the owning session picks the
 * result up through its result watcher (now, or when that session is resumed). Runs that are not running are skipped. */
export function sweepStaleAsyncRuns(options: StaleRunSweepOptions = {}): StaleRunSweepReport {
	const asyncRoot = options.asyncRoot ?? DIRS.async;
	const report: StaleRunSweepReport = { checked: 0, repaired: [], errors: [] };
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(asyncRoot, { withFileTypes: true });
	} catch {
		return report;
	}
	for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
		const asyncDir = path.join(asyncRoot, entry.name);
		let state: unknown;
		try {
			state = (JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as { state?: unknown }).state;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			report.errors.push({ runId: entry.name, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		if (state !== "running") continue;
		report.checked += 1;
		try {
			const result = reconcileAsyncRun(asyncDir, { ...(options.resultsDir ? { resultsDir: options.resultsDir } : {}), ...(options.kill ? { kill: options.kill } : {}), ...(options.now ? { now: options.now } : {}) });
			if (result.repaired) report.repaired.push({ runId: result.status?.runId ?? entry.name, ...(result.message ? { message: result.message } : {}) });
		} catch (error) {
			report.errors.push({ runId: entry.name, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return report;
}
