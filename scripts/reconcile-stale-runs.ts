#!/usr/bin/env node
// Reconciles every running async subagent run once and prints one JSON line:
// {"checked":N,"repaired":[{"runId":...,"message":...}],"errors":[...]}
// The stale threshold for live-looking runners comes from PI_SUBAGENTS_STALE_ALIVE_PID_MS (default 24h);
// the run directory from PI_SUBAGENTS_TEMP_ROOT like the extension itself.
import { sweepStaleAsyncRuns } from "../src/runs/background/stale-run-sweep.ts";

process.stdout.write(`${JSON.stringify(sweepStaleAsyncRuns())}\n`);
