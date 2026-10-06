import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";

const loaderUrl = new URL("../support/isolated-temp-root.mjs", import.meta.url).href;
const typesUrl = new URL("../../src/shared/types.ts", import.meta.url).href;

it("gives suite files private HOME-bound temp roots while nested fixtures share their file owner", () => {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "loader-contract-"));
	const configuredRoot = path.join(fixture, "pi-subagents-suite");
	const callerAgentDir = path.join(fixture, "caller-agent");
	fs.mkdirSync(configuredRoot, { mode: 0o700 });
	try {
		for (const name of ["first", "second"]) {
			fs.writeFileSync(path.join(fixture, `${name}.test.mjs`), `
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { TEMP_ROOT_DIR } from ${JSON.stringify(typesUrl)};
const home = os.homedir();
const temp = os.tmpdir();
const stateDir = path.join(home, ".pi", "agent", "pi-subagents");
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const marker = path.join(stateDir, "owner");
const priorOwner = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null;
fs.writeFileSync(marker, ${JSON.stringify(name)});
const sentinel = path.join(temp, "nested-sentinel");
fs.writeFileSync(sentinel, "keep");
const nestedScript = 'import * as os from "node:os"; console.log(JSON.stringify({ home: os.homedir(), temp: os.tmpdir(), parent: process.env.PI_SUBAGENTS_TEST_PARENT_PID, agent: process.env.PI_CODING_AGENT_DIR }));';
const nestedEntry = path.join(temp, "nested.mjs");
fs.writeFileSync(nestedEntry, nestedScript);
const nestedEnv = { ...process.env, PI_CODING_AGENT_DIR: stateDir };
const child = spawnSync(process.execPath, ["--import", ${JSON.stringify(loaderUrl)}, "--input-type=module", "--eval", nestedScript],
  { encoding: "utf8", env: nestedEnv });
const fileChild = spawnSync(process.execPath, ["--import", ${JSON.stringify(loaderUrl)}, nestedEntry],
  { encoding: "utf8", env: nestedEnv });
if (child.status !== 0) throw new Error(child.stderr);
if (fileChild.status !== 0) throw new Error(fileChild.stderr);
fs.writeFileSync(${JSON.stringify(path.join(fixture, `${name}.json`))}, JSON.stringify({
  home, temp, shared: TEMP_ROOT_DIR, pid: process.pid,
  parent: process.env.PI_SUBAGENTS_TEST_PARENT_PID, agent: process.env.PI_CODING_AGENT_DIR,
  stateMode: fs.statSync(stateDir).mode & 0o777, homeMode: fs.statSync(home).mode & 0o777,
  tempMode: fs.statSync(temp).mode & 0o777, priorOwner,
  nested: JSON.parse(child.stdout), nestedFile: JSON.parse(fileChild.stdout), sentinelSurvived: fs.existsSync(sentinel)
}));
`);
		}
		const env = { ...process.env, PI_SUBAGENTS_TEMP_ROOT: configuredRoot, PI_CODING_AGENT_DIR: callerAgentDir };
		delete env.PI_SUBAGENTS_TEST_LOADER;
		delete env.NODE_TEST_CONTEXT;
		const result = spawnSync(process.execPath, [
			"--experimental-strip-types", "--import", "data:text/javascript,process.umask(0o022)",
			"--import", loaderUrl, "--test", "--test-concurrency=1",
			path.join(fixture, "first.test.mjs"), path.join(fixture, "second.test.mjs"),
		], { encoding: "utf8", env, timeout: 20_000 });
		assert.equal(result.status, 0, result.stderr + result.stdout);
		const records = ["first", "second"].map((name) => JSON.parse(fs.readFileSync(path.join(fixture, `${name}.json`), "utf8")) as {
			home: string; temp: string; shared: string; pid: number; parent: string; agent?: string;
			stateMode: number; homeMode: number; tempMode: number; priorOwner: string | null; sentinelSurvived: boolean;
			nested: { home: string; temp: string; parent: string; agent: string };
			nestedFile: { home: string; temp: string; parent: string; agent: string };
		});
		assert.notEqual(records[0].home, records[1].home);
		assert.notEqual(records[0].temp, records[1].temp);
		for (const record of records) {
			assert.equal(path.dirname(record.temp), record.home);
			assert.match(path.basename(record.temp), /^pi-subagents-/);
			assert.equal(record.shared, record.temp);
			assert.equal(record.parent, String(record.pid));
			assert.equal(record.agent, undefined);
			assert.equal(record.priorOwner, null);
			assert.equal(record.stateMode, 0o700);
			assert.equal(record.homeMode, 0o700);
			assert.equal(record.tempMode, 0o700);
			assert.deepEqual(record.nested, {
				home: record.home, temp: record.temp, parent: String(record.pid),
				agent: path.join(record.home, ".pi", "agent", "pi-subagents"),
			});
			assert.deepEqual(record.nestedFile, record.nested);
			assert.equal(record.sentinelSurvived, true);
			assert.equal(fs.existsSync(record.home), false);
		}
		assert.equal(fs.existsSync(configuredRoot), true);
		assert.equal(fs.existsSync(callerAgentDir), false);
	} finally {
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});

it("cleans an unconfigured standalone root on exit", () => {
	const env = { ...process.env };
	delete env.PI_SUBAGENTS_TEMP_ROOT;
	delete env.PI_SUBAGENTS_TEST_LOADER;
	delete env.NODE_TEST_CONTEXT;
	const result = spawnSync(process.execPath, ["--import", loaderUrl, "--input-type=module", "--eval",
		"console.log(process.env.PI_SUBAGENTS_TEMP_ROOT)"], { encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.existsSync(result.stdout.trim()), false);
});

it("keeps explicit standalone layout for eval variants and entryless children with inherited test context", () => {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "loader-eval-"));
	const script = 'import * as os from "node:os"; console.log(JSON.stringify({ home: os.homedir(), temp: os.tmpdir(), agent: process.env.PI_CODING_AGENT_DIR }));';
	try {
		const invocations = [
			["--eval", script, "entry-argument"],
			["-e", script, "entry-argument"],
			[`--eval=${script}`, "entry-argument"],
			[],
		];
		for (const [index, args] of invocations.entries()) {
			const root = path.join(fixture, `root-${index}`);
			const env = { ...process.env, PI_SUBAGENTS_TEMP_ROOT: root, NODE_TEST_CONTEXT: "child-v8", PI_CODING_AGENT_DIR: path.join(fixture, "caller-agent") };
			delete env.PI_SUBAGENTS_TEST_LOADER;
			const result = spawnSync(process.execPath, ["--import", loaderUrl, "--input-type=module", ...args], {
				encoding: "utf8", env, input: args.length === 0 ? script : undefined,
			});
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(JSON.parse(result.stdout), { home: path.join(root, "home"), temp: root });
			assert.equal(fs.existsSync(root), true);
		}
	} finally {
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});

it("does not treat stdin or print evaluation arguments as fresh suite file entries", () => {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "loader-entry-"));
	const script = 'console.log(JSON.stringify({ home: process.env.HOME, temp: process.env.TMPDIR }));';
	try {
		const invocations = [
			{ args: ["-p", script, "entry-argument"] },
			{ args: ["-"], input: script },
			{ args: ["-pe", script, "entry-argument"] },
			{ args: ["--print", script, "entry-argument"] },
			// Node accepts --print=... as a print flag; the expression is the next argument.
			{ args: [`--print=${script}`, script, "entry-argument"] },
			{ args: ["--eval", script, "--", "entry-argument"] },
		];
		for (const state of [undefined, "loaded"]) {
			for (const [index, invocation] of invocations.entries()) {
				const root = path.join(fixture, `${state ?? "unset"}-${index}`);
				const env = { ...process.env, PI_SUBAGENTS_TEMP_ROOT: root, NODE_TEST_CONTEXT: "child-v8" };
				delete env.PI_SUBAGENTS_TEST_LOADER;
				if (state !== undefined) env.PI_SUBAGENTS_TEST_LOADER = state;
				const result = spawnSync(process.execPath, ["--import", loaderUrl, ...invocation.args], {
					encoding: "utf8", env, input: invocation.input,
				});
				assert.equal(result.status, 0, result.stderr);
				assert.deepEqual(JSON.parse(result.stdout.trim().split("\n")[0]), {
					home: path.join(root, "home"), temp: root,
				});
				assert.equal(fs.existsSync(root), true);
			}
		}
	} finally {
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});
