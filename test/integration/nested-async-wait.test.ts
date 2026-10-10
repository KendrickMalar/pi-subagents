import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { createDefaultChildSessionFactory, setChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { DIRS } from "../../src/shared/types.ts";
import { makeAgent } from "../support/helpers.ts";

it("native reviewer consumes nested persona results via exact, prefix, and aggregate waits", {
	skip: !process.env.PI_SUBAGENTS_NATIVE_PI_ROOT && "Requires PI_SUBAGENTS_NATIVE_PI_ROOT and native-peer-loader.mjs",
	timeout: 60000,
}, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-nested-wait-"));
	const agentDir = path.join(root, "agent");
	const auditPath = path.join(root, "audit.jsonl");
	const savedEnv = { ...process.env };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	process.env.PI_SUBAGENTS_NATIVE_WAIT_AUDIT = auditPath;
	const extension = fileURLToPath(new URL("../fixtures/native-nested-wait-provider.ts", import.meta.url));
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
	for (const name of ["arm-a", "arm-b", "persona"]) {
		fs.writeFileSync(path.join(agentDir, "agents", `${name}.md`), [
			"---", `name: ${name}`, "description: Native nested wait test", `model: nested-wait-fixture/${name}`,
			`tools: ${name === "persona" ? "read" : "read, subagent, bg_wait"}`, `extensions: ${extension}`,
			"inheritGlobalContext: false", "inheritProjectContext: false", "inheritSkills: false", "acceptanceRole: read-only", "---", "Complete only the fixture task.",
		].join("\n"));
	}
	const factory = createDefaultChildSessionFactory();
	setChildSessionFactory(factory);
	try {
		const reviewer = makeAgent("reviewer", { model: "nested-wait-fixture/reviewer", tools: ["read", "subagent", "bg_wait"], extensions: [extension], inheritGlobalContext: false, inheritProjectContext: false, inheritSkills: false });
		const result = await runSync(root, [reviewer], "reviewer", "Review using the two assigned arms", {
			runId: "native-nested-wait", sessionDir: path.join(root, "sessions"), share: true, maxSubagentDepth: 4,
			timeoutMs: 45000, waitToolDefaultTimeoutMs: 25000, childSessionFactory: factory,
		});
		assert.equal(result.exitCode, 0, `${result.error}\nAudit: ${fs.readFileSync(auditPath, "utf8")}`);
		assert.equal(result.finalOutput, "CONSUMED_reviewer: PERSONA_EVIDENCE");
		const audit = fs.readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		for (const model of ["reviewer", "arm-a", "arm-b"]) {
			assert.ok(audit.some((entry) => entry.model === model && entry.content.some((part: { text?: string }) => part.text === `CONSUMED_${model}: PERSONA_EVIDENCE`)), `${model} must actually read and consume its descendants' findings`);
			const readPaths: string[] = audit.filter((entry) => entry.model === model).flatMap((entry) => entry.content.filter((part: { name?: string }) => part.name === "read").map((part: { arguments: { path: string } }) => part.arguments.path));
			assert.equal(readPaths.length, model === "arm-a" ? 2 : 1);
			for (const file of readPaths) {
				assert.ok(fs.existsSync(file));
				assert.equal(file.startsWith(path.join(DIRS.results, "nested") + path.sep), model !== "reviewer", "ordinary workflow and nested result namespaces are both exercised");
			}
		}
	} finally {
		await factory.dispose();
		setChildSessionFactory(undefined);
		for (const key of ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SUBAGENTS_NATIVE_WAIT_AUDIT"]) {
			if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("native child coordinator yields its explicit wait, replies, and consumes the same requester result", {
	skip: !process.env.PI_SUBAGENTS_NATIVE_PI_ROOT && "Requires PI_SUBAGENTS_NATIVE_PI_ROOT and native-peer-loader.mjs",
	timeout: 30000,
}, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-supervisor-wait-"));
	const agentDir = path.join(root, "agent");
	const auditPath = path.join(root, "audit.jsonl");
	const savedEnv = { ...process.env };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	process.env.PI_SUBAGENTS_SUPERVISOR_WAIT_AUDIT = auditPath;
	process.env.PI_INTERCOM_ASK_TIMEOUT_MS = "2500";
	const extension = fileURLToPath(new URL("../fixtures/native-supervisor-wait-provider.ts", import.meta.url));
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
	fs.writeFileSync(path.join(agentDir, "agents", "requester.md"), [
		"---", "name: requester", "description: Native readonly supervisor requester", "model: supervisor-wait-fixture/requester",
		"tools: read, contact_supervisor", `extensions: ${extension}`,
		"inheritGlobalContext: false", "inheritProjectContext: false", "inheritSkills: false", "acceptanceRole: read-only", "---",
		"Request scope confirmation, consume the reply, and report readonly evidence.",
	].join("\n"));
	const factory = createDefaultChildSessionFactory();
	setChildSessionFactory(factory);
	try {
		const coordinator = makeAgent("coordinator", {
			model: "supervisor-wait-fixture/coordinator", tools: ["read", "subagent", "bg_wait", "subagent_supervisor"],
			extensions: [extension], inheritGlobalContext: false, inheritProjectContext: false, inheritSkills: false,
		});
		const result = await runSync(root, [coordinator], "coordinator", "Confirm the requester scope and consume its result before finishing.", {
			runId: "native-supervisor-wait", sessionDir: path.join(root, "sessions"), share: false, maxSubagentDepth: 3,
			timeoutMs: 20000, waitToolDefaultTimeoutMs: 6000, childSessionFactory: factory,
		});
		assert.equal(result.exitCode, 0, `${result.error}\nAudit: ${fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8") : "missing"}`);
		assert.equal(result.finalOutput, "COORDINATOR_CONSUMED_REPLY_AND_RESULT");
		const audit = fs.readFileSync(auditPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
		const ordered = ["wait-start", "request-issued", "wait-yielded", "reply-issued", "reply-consumed", "close-proof-consumed", "result-consumed"];
		let previous = -1;
		for (const event of ordered) {
			const index = audit.findIndex(entry => entry.event === event);
			assert.ok(index > previous, `${event} must occur in order after its predecessor`);
			previous = index;
		}
		const issued = audit.find(entry => entry.event === "reply-issued");
		assert.notEqual(issued.workflowRunId, issued.runId, "wait targets the workflow, not the requester directly");
		assert.equal(audit.find(entry => entry.event === "wait-yielded").workflowRunId, issued.workflowRunId);
		assert.equal(audit.find(entry => entry.event === "result-consumed").workflowRunId, issued.workflowRunId);
		assert.equal(audit.find(entry => entry.event === "result-consumed").runId, issued.runId);
		assert.ok(audit.find(entry => entry.event === "reply-consumed").ts - audit.find(entry => entry.event === "request-issued").ts < 2500, "reply must be consumed before the real request deadline");
		const calls = audit.filter(entry => entry.event === "model-output" && entry.model === "coordinator").flatMap(entry => entry.content);
		assert.equal(calls.filter(part => part.name === "bg_wait").length, 2);
		assert.equal(calls.filter(part => part.name === "subagent_supervisor" && part.arguments.action === "reply").length, 1);
		assert.equal(calls.filter(part => part.name === "read").length, 2, "coordinator reads both the result and native close proof before final output");
		const launch = audit.find(entry => entry.event === "child-launched" && entry.runId === issued.runId);
		assert.ok(launch?.asyncDir, "native launch receipt must identify the exact child artifact directory");
		// Result publication precedes the runner's real close event; await that distinct proof.
		const proofPath = path.join(launch.asyncDir, "process-terminal.json");
		const closeDeadline = Date.now() + 5000;
		while (JSON.parse(fs.readFileSync(proofPath, "utf8")).state === "pending" && Date.now() < closeDeadline) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		const proof = JSON.parse(fs.readFileSync(path.join(launch.asyncDir, "process-terminal.json"), "utf8"));
		assert.equal(proof.state, "observed");
		assert.equal(proof.runId, issued.runId);
		const runner = proof.instances.find((entry: { kind: string }) => entry.kind === "runner");
		assert.equal(runner.processInstanceId, proof.runnerProcessInstanceId);
		assert.equal(runner.exitCode, 0);
		assert.equal(runner.signal, null);
		console.log("NATIVE_SUPERVISOR_WAIT_EVIDENCE", JSON.stringify({
			workflowRunId: issued.workflowRunId, childRunId: issued.runId, requestId: issued.requestId,
			events: audit.filter(entry => ordered.includes(entry.event)), proof,
		}));
	} finally {
		await factory.dispose();
		setChildSessionFactory(undefined);
		for (const key of ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SUBAGENTS_SUPERVISOR_WAIT_AUDIT", "PI_INTERCOM_ASK_TIMEOUT_MS"]) {
			if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
		}
		// The shared test loader owns temp cleanup; the audit and close proof survive in TAP output.
	}
});

for (const [times, context] of [[1, "fresh"], [2, "fresh"], [2, "fork"]] as const) it(`native child coordinator resumes its terminal ${context === "fork" ? "forked " : ""}async worker ${times === 1 ? "once" : "again after a revival"} from the persisted session`, {
	skip: !process.env.PI_SUBAGENTS_NATIVE_PI_ROOT && "Requires PI_SUBAGENTS_NATIVE_PI_ROOT and native-peer-loader.mjs",
	timeout: 60000,
}, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-nested-resume-"));
	const agentDir = path.join(root, "agent");
	const auditPath = path.join(root, "audit.jsonl");
	const savedEnv = { ...process.env };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	process.env.PI_SUBAGENTS_NESTED_RESUME_AUDIT = auditPath;
	process.env.PI_SUBAGENTS_NESTED_RESUME_TIMES = String(times);
	process.env.PI_SUBAGENTS_NESTED_RESUME_CONTEXT = context;
	const extension = fileURLToPath(new URL("../fixtures/native-nested-resume-provider.ts", import.meta.url));
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
	for (const [name, tools] of [["worker", "read"], ["coordinator", "read, subagent, bg_wait"]] as const) {
		fs.writeFileSync(path.join(agentDir, "agents", `${name}.md`), [
			"---", `name: ${name}`, "description: Native nested resume test", `model: nested-resume-fixture/${name}`,
			`tools: ${tools}`, `extensions: ${extension}`,
			"inheritGlobalContext: false", "inheritProjectContext: false", "inheritSkills: false", "acceptanceRole: read-only", "---",
			"Complete only the fixture task.",
		].join("\n"));
	}
	const factory = createDefaultChildSessionFactory();
	setChildSessionFactory(factory);
	try {
		// The parent launches the coordinator, so the coordinator's async worker is a nested run.
		const parent = makeAgent("parent", {
			model: "nested-resume-fixture/parent", tools: ["read", "subagent"],
			extensions: [extension], inheritGlobalContext: false, inheritProjectContext: false, inheritSkills: false,
		});
		const result = await runSync(root, [parent], "parent", "Delegate to the coordinator.", {
			runId: "native-nested-resume", sessionDir: path.join(root, "sessions"), share: false, maxSubagentDepth: 4,
			timeoutMs: 45000, waitToolDefaultTimeoutMs: 15000, childSessionFactory: factory,
		});
		const auditText = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8") : "missing";
		assert.equal(result.exitCode, 0, `${result.error}\nAudit: ${auditText}`);
		assert.equal(result.finalOutput, "PARENT_SAW_RESUMED_WORKER", auditText);
		const audit = auditText.trim().split("\n").map(line => JSON.parse(line));
		const launched = audit.find(entry => entry.event === "launched");
		const resumed = audit.find(entry => entry.event === "resumed");
		assert.ok(launched?.runId && resumed?.resumedId, auditText);
		assert.match(resumed.text, /^Session: .*\.jsonl$/m, "nested resume must name the persisted session it revives");
		// A forked worker's session sits under its own run's directory, so the coordinator can resume it.
		if (context === "fork") assert.match(resumed.text, new RegExp(`^Session: .*/${launched.runId}/forks/[^/]+\\.jsonl$`, "m"), resumed.text);
		assert.ok(audit.some(entry => entry.event === "model-output" && entry.model === "worker" && entry.content.some((part: { text?: string }) => part.text === "WORKER_FIRST_REPORT")));
		assert.ok(audit.some(entry => entry.event === "model-output" && entry.model === "worker" && entry.content.some((part: { text?: string }) => part.text === "WORKER_RESUMED_WITH_MEMORY")), "the resumed worker must see its prior session and the follow-up");
		if (times === 2) {
			assert.ok(audit.some(entry => entry.event === "model-output" && entry.model === "worker" && entry.content.some((part: { text?: string }) => part.text === "WORKER_RESUMED_TWICE")), "a revived run must itself be resumable from the shared session");
			assert.equal(audit.filter(entry => entry.event === "resumed").length, 2, auditText);
		}
	} finally {
		await factory.dispose();
		setChildSessionFactory(undefined);
		for (const key of ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SUBAGENTS_NESTED_RESUME_AUDIT", "PI_SUBAGENTS_NESTED_RESUME_TIMES", "PI_SUBAGENTS_NESTED_RESUME_CONTEXT"]) {
			if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});
