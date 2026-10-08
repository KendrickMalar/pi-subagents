import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents, readModelRoleContext } from "../../src/agents/agents.ts";
import {
	expandModelRoleReference,
	resolveEffectiveSubagentModel,
	resolveSubagentModelOverride,
	type ModelRoleContext,
} from "../../src/runs/shared/model-resolution.ts";
import { cycleRoles, formatResolvedModel, resolveRole, type PiDefaultModel, type RoleMap } from "../../src/shared/model-roles.ts";

const vectors = JSON.parse(fs.readFileSync(new URL("../fixtures/model-roles/vectors.json", import.meta.url), "utf-8")) as {
	cases: Array<{
		name: string;
		roles: RoleMap;
		piDefault?: PiDefaultModel;
		ref: string;
		expect?: { role: string; model: string; thinking?: string; source: string; chain: string[]; formatted: string };
		error?: string;
	}>;
	cycles: Array<{ name: string; roles: RoleMap; order: string[]; expect: string[] }>;
};

describe("shared model role vectors (verbatim copy of pi-model-roles)", () => {
	for (const testCase of vectors.cases) {
		it(testCase.name, () => {
			const result = resolveRole(testCase.ref, testCase.roles, testCase.piDefault);
			if (testCase.error) {
				assert.equal(result.ok, false);
				if (!result.ok) assert.equal(result.code, testCase.error);
				return;
			}
			assert.equal(result.ok, true);
			if (!result.ok) return;
			const { formatted, ...expected } = testCase.expect!;
			assert.deepEqual(
				{ role: result.role, model: result.model, ...(result.thinking ? { thinking: result.thinking } : {}), source: result.source, chain: result.chain },
				expected,
			);
			assert.equal(formatResolvedModel(result), formatted);
		});
	}
	for (const testCase of vectors.cycles) {
		it(`cycle: ${testCase.name}`, () => {
			assert.deepEqual(cycleRoles(testCase.roles, testCase.order), testCase.expect);
		});
	}
});

const models = [
	{ provider: "openai-codex", id: "gpt-6-luna", fullId: "openai-codex/gpt-6-luna" },
	{ provider: "openai-codex", id: "gpt-6.1-sol", fullId: "openai-codex/gpt-6.1-sol" },
];
const parent = { provider: "openai-codex", id: "gpt-6-luna" };
const context: ModelRoleContext = {
	roles: { default: "openai-codex/gpt-6-luna:xhigh", slow: "openai-codex/gpt-6.1-sol:high", task: "@slow" },
	piDefault: { provider: "openai-codex", model: "gpt-6-luna" },
};

describe("@role model references at launch", () => {
	it("expands roles and leaves other values untouched", () => {
		assert.equal(expandModelRoleReference("@task", context), "openai-codex/gpt-6.1-sol:high");
		assert.equal(expandModelRoleReference("@slow:low", context), "openai-codex/gpt-6.1-sol:low");
		assert.equal(expandModelRoleReference("@smol", context), "openai-codex/gpt-6-luna:xhigh");
		assert.equal(expandModelRoleReference("openai-codex/gpt-6-luna", context), "openai-codex/gpt-6-luna");
	});

	it("errors instead of falling back", () => {
		assert.throws(() => expandModelRoleReference("@fast", context), /Unknown model role '@fast'/);
		assert.throws(() => expandModelRoleReference("@slow", undefined), /without model role settings/);
		assert.throws(() => expandModelRoleReference("@slow", { roles: { slow: "@task", task: "@slow" } }), /cycle/);
	});

	it("resolves an agent's @role model through the registry with the thinking suffix", () => {
		assert.equal(
			resolveSubagentModelOverride("@task", parent, models, undefined, { modelRoles: context }),
			"openai-codex/gpt-6.1-sol:high",
		);
	});

	it("resolves an explicit per-run @role over the agent model", () => {
		assert.equal(
			resolveEffectiveSubagentModel("@slow:medium", "openai-codex/gpt-6-luna", parent, models, undefined, { modelRoles: context }),
			"openai-codex/gpt-6.1-sol:medium",
		);
	});

	it("rejects a role whose model is not available for explicit requests", () => {
		const missing: ModelRoleContext = { roles: { slow: "openai-codex/missing:high" } };
		assert.throws(
			() => resolveSubagentModelOverride("@slow", parent, models, undefined, { modelRoles: missing, source: "explicit" }),
			/Unknown subagent model 'openai-codex\/missing:high'/,
		);
	});

	it("keeps 'inherit' and empty values on the parent model", () => {
		assert.equal(resolveSubagentModelOverride("inherit", parent, models, undefined, { modelRoles: context }), "openai-codex/gpt-6-luna");
	});
});

describe("readModelRoleContext", () => {
	let tempHome = "";
	let tempProject = "";
	const originalHome = process.env.HOME;
	const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

	function writeJson(filePath: string, value: unknown): void {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
	}

	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-roles-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-roles-project-"));
		fs.mkdirSync(path.join(tempProject, ".git"));
		process.env.HOME = tempHome;
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("merges project roles over user roles and reads Pi's default model", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			defaultProvider: "openai-codex",
			defaultModel: "gpt-6-luna",
			defaultThinkingLevel: "xhigh",
			modelRoles: { default: "openai-codex/gpt-6-luna", slow: "openai-codex/gpt-6.1-sol:high" },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), { modelRoles: { slow: "openai-codex/gpt-6.1-sol:low" } });
		assert.deepEqual(readModelRoleContext(tempProject), {
			roles: { default: "openai-codex/gpt-6-luna", slow: "openai-codex/gpt-6.1-sol:low" },
			piDefault: { provider: "openai-codex", model: "gpt-6-luna", thinking: "xhigh" },
		});
	});

	it("keeps @role references on discovered agents and resolves them at launch", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			modelRoles: { slow: "openai-codex/gpt-6.1-sol:high" },
			subagents: { agentOverrides: { reviewer: { model: "@slow" } } },
		});
		const agentPath = path.join(tempProject, ".pi", "agents", "reviewer.md");
		fs.mkdirSync(path.dirname(agentPath), { recursive: true });
		fs.writeFileSync(agentPath, "---\nname: reviewer\ndescription: Reviews\n---\nReview.\n", "utf-8");
		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.equal(reviewer?.model, "@slow");
		assert.equal(
			resolveSubagentModelOverride(reviewer?.model, parent, models, undefined, { modelRoles: readModelRoleContext(tempProject) }),
			"openai-codex/gpt-6.1-sol:high",
		);
	});
});
