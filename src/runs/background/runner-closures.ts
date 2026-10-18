// Only the process that spawned a child runner can observe its close and write the terminal proof.
// A runner that exits while its own children are still closing leaves their proofs pending forever,
// which nested recovery then refuses. The runner waits for these closures before it exits.
// The extension inside the runner's Pi session may load its own copy of this module, so the set lives on globalThis.
const pending: Set<Promise<void>> = ((globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents.runner-closures")] ??= new Set<Promise<void>>()) as Set<Promise<void>>;

export function trackRunnerClosure(closure: Promise<void>): void {
	pending.add(closure);
	void closure.finally(() => pending.delete(closure));
}

/** Resolve once every tracked child runner close has been finalized, or at the bound. */
export async function waitForRunnerClosures(timeoutMs: number): Promise<void> {
	if (!pending.size) return;
	let timer: NodeJS.Timeout | undefined;
	await Promise.race([
		Promise.allSettled([...pending]),
		new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
	]);
	clearTimeout(timer);
}
