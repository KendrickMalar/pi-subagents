// Model role resolution shared by pi-model-roles and the pi-subagents fork.
// Keep this file dependency-free and type-strippable: pi-subagents vendors a
// verbatim copy, and test/vectors.json pins identical behavior in both repos.

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type RoleThinkingLevel = (typeof THINKING_LEVELS)[number];

export const KNOWN_ROLES = [
	"default",
	"smol",
	"slow",
	"task",
	"plan",
	"vision",
	"commit",
	"tiny",
	"advisor",
	"designer",
] as const;

export const DEFAULT_ROLE_CYCLE = ["smol", "default", "slow"] as const;

export type RoleMap = Record<string, string>;

/** Pi's own startup default, used when the `default` role is unassigned. */
export interface PiDefaultModel {
	provider?: string;
	model?: string;
	thinking?: string;
}

export type RoleSource = "explicit" | "inherited-default" | "pi-default";

export interface ResolvedRole {
	ok: true;
	/** Role that was asked for (without "@"). */
	role: string;
	/** Roles visited while following aliases and inheritance, in order. */
	chain: string[];
	provider: string;
	modelId: string;
	/** "provider/id" without a thinking suffix. */
	model: string;
	thinking?: RoleThinkingLevel;
	source: RoleSource;
}

export type RoleErrorCode =
	| "unknown_role"
	| "role_cycle"
	| "invalid_value"
	| "invalid_thinking"
	| "no_default";

export interface RoleError {
	ok: false;
	role: string;
	code: RoleErrorCode;
	message: string;
}

export type RoleResolution = ResolvedRole | RoleError;

export function isThinkingLevel(value: string): value is RoleThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function isRoleReference(value: string): boolean {
	return value.trim().startsWith("@");
}

/** Split a trailing ":level" only when it is a known thinking level, so ids like "model:free" stay intact. */
export function splitThinkingSuffix(value: string): { base: string; thinking?: RoleThinkingLevel } {
	const trimmed = value.trim();
	const index = trimmed.lastIndexOf(":");
	if (index > 0) {
		const suffix = trimmed.slice(index + 1);
		if (isThinkingLevel(suffix)) return { base: trimmed.slice(0, index), thinking: suffix };
	}
	return { base: trimmed };
}

/** Read `modelRoles` from a parsed settings object, keeping only non-empty string values. */
export function readRoleMap(settings: unknown): RoleMap {
	const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>).modelRoles : undefined;
	const map: RoleMap = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === "string" && value.trim()) map[name] = value.trim();
	}
	return map;
}

/** Read `modelRoleCycle`, falling back to the OMP default order. */
export function readRoleCycle(settings: unknown): string[] {
	const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>).modelRoleCycle : undefined;
	if (!Array.isArray(raw)) return [...DEFAULT_ROLE_CYCLE];
	return raw.filter((name): name is string => typeof name === "string" && name.trim() !== "").map((name) => name.trim());
}

export function isKnownRole(name: string, map: RoleMap): boolean {
	return (KNOWN_ROLES as readonly string[]).includes(name) || Object.hasOwn(map, name);
}

function fail(role: string, code: RoleErrorCode, message: string): RoleError {
	return { ok: false, role, code, message };
}

/**
 * Resolve a role reference such as "slow", "@slow" or "@slow:low".
 * A thinking suffix on the reference overrides the role's own level.
 */
export function resolveRole(reference: string, map: RoleMap, piDefault?: PiDefaultModel): RoleResolution {
	const { base, thinking: overrideThinking } = splitThinkingSuffix(reference);
	const role = base.startsWith("@") ? base.slice(1) : base;
	if (!role) return fail(reference, "unknown_role", `Model role reference '${reference}' has no role name`);
	const resolved = resolveRoleName(role, map, piDefault, []);
	if (!resolved.ok || !overrideThinking) return resolved;
	return { ...resolved, thinking: overrideThinking };
}

function resolveRoleName(role: string, map: RoleMap, piDefault: PiDefaultModel | undefined, chain: string[]): RoleResolution {
	if (chain.includes(role)) {
		return fail(chain[0] ?? role, "role_cycle", `Model role cycle: ${[...chain, role].map((name) => `@${name}`).join(" -> ")}`);
	}
	if (!isKnownRole(role, map)) {
		return fail(chain[0] ?? role, "unknown_role", `Unknown model role '@${role}'`);
	}
	const nextChain = [...chain, role];
	const value = map[role];
	if (value === undefined) {
		if (role !== "default") {
			const inherited = resolveRoleName("default", map, piDefault, nextChain);
			if (!inherited.ok) return inherited;
			return { ...inherited, role: nextChain[0]!, source: inherited.source === "explicit" ? "inherited-default" : inherited.source };
		}
		return resolvePiDefault(nextChain, piDefault);
	}
	if (isRoleReference(value)) {
		const { base, thinking } = splitThinkingSuffix(value);
		const target = resolveRoleName(base.slice(1), map, piDefault, nextChain);
		if (!target.ok) return target;
		return { ...target, role: nextChain[0]!, thinking: thinking ?? target.thinking };
	}
	return parseModelValue(nextChain, value, "explicit");
}

function resolvePiDefault(chain: string[], piDefault: PiDefaultModel | undefined): RoleResolution {
	const role = chain[0]!;
	if (!piDefault?.provider || !piDefault.model) {
		return fail(role, "no_default", `Model role '@${role}' is unassigned and no default model is configured`);
	}
	const value = piDefault.model.includes("/") ? piDefault.model : `${piDefault.provider}/${piDefault.model}`;
	const parsed = parseModelValue(chain, value, "pi-default");
	if (!parsed.ok || parsed.thinking || !piDefault.thinking) return parsed;
	if (!isThinkingLevel(piDefault.thinking)) {
		return fail(role, "invalid_thinking", `Default thinking level '${piDefault.thinking}' is not a known level`);
	}
	return { ...parsed, thinking: piDefault.thinking };
}

function parseModelValue(chain: string[], value: string, source: RoleSource): RoleResolution {
	const role = chain[0]!;
	const { base, thinking } = splitThinkingSuffix(value);
	const slash = base.indexOf("/");
	if (slash <= 0 || slash === base.length - 1 || /\s|,/.test(base)) {
		return fail(role, "invalid_value", `Model role '@${chain[chain.length - 1]}' value '${value}' must be 'provider/model[:thinking]'`);
	}
	return {
		ok: true,
		role,
		chain,
		provider: base.slice(0, slash),
		modelId: base.slice(slash + 1),
		model: base,
		...(thinking ? { thinking } : {}),
		source,
	};
}

/** Format a resolution as the model string used by Pi and pi-subagents: "provider/id[:thinking]". */
export function formatResolvedModel(resolved: ResolvedRole): string {
	return resolved.thinking ? `${resolved.model}:${resolved.thinking}` : resolved.model;
}

/** Roles in cycle order that have an explicit assignment; unassigned roles are skipped. */
export function cycleRoles(map: RoleMap, order: readonly string[]): string[] {
	const seen = new Set<string>();
	return order.filter((role) => {
		if (seen.has(role) || map[role] === undefined) return false;
		seen.add(role);
		return true;
	});
}
