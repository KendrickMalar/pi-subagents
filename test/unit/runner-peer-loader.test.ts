import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const loaderUrl = new URL("../../runner-peer-loader.mjs", import.meta.url);
const packageRootUrl = new URL("../../", import.meta.url).href;
const hostModules = path.join(os.tmpdir(), "runner-peer-loader-host", "node_modules", "@earendil-works");
const aliases = {
	"@earendil-works/pi-tui": path.join(hostModules, "pi-tui", "dist", "index.js"),
	"@earendil-works/pi-ai": path.join(hostModules, "pi-ai", "dist", "index.js"),
};
test("native preload leaves the SDK extension loader's require.resolve intact", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-extension-resolve-"));
	try {
		const sdkLoader = path.join(root, "host", "dist", "core", "extensions", "loader.js");
		const typeboxRoot = path.join(root, "host", "node_modules", "typebox");
		const target = path.join(typeboxRoot, "index.mjs");
		fs.mkdirSync(path.dirname(sdkLoader), { recursive: true });
		fs.mkdirSync(typeboxRoot, { recursive: true });
		fs.writeFileSync(sdkLoader, "");
		fs.writeFileSync(target, "export const Type = {};\n");
		fs.writeFileSync(path.join(typeboxRoot, "package.json"), JSON.stringify({ name: "typebox", type: "module", exports: "./index.mjs" }));
		const child = spawnSync(process.execPath, [
			"--import", new URL("../../runner-peer-preload.mjs", import.meta.url).href,
			"--input-type=module", "-e",
			"import { createRequire } from 'node:module'; console.log(createRequire(process.argv[1]).resolve('typebox'));",
			sdkLoader,
		], {
			encoding: "utf8",
			env: { ...process.env, JITI_ALIAS: JSON.stringify({ typebox: target }), PI_ASYNC_NATIVE_RUNNER: "1" },
			timeout: 10_000,
		});
		assert.equal(child.status, 0, child.stderr);
		assert.equal(child.stdout.trim(), fs.realpathSync(target));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

const passthrough = (specifier: string) => ({ url: specifier, shortCircuit: true });

test("fallback loader aliases every host peer for a plain-JavaScript runner", async () => {
	const loader = await import(`${loaderUrl.href}?native`);
	loader.initialize({ aliases, nativeRunner: true });
	const packageContext = { parentURL: new URL("src/runs/background/subagent-runner.js", packageRootUrl).href };
	assert.equal(loader.resolve("@earendil-works/pi-ai", packageContext, passthrough).url, pathToFileURL(aliases["@earendil-works/pi-ai"]).href);
	assert.equal(loader.resolve("@earendil-works/pi-tui", packageContext, passthrough).url, pathToFileURL(aliases["@earendil-works/pi-tui"]).href);
	assert.equal(loader.resolve("node:fs", packageContext, passthrough).url, "node:fs");
	assert.equal(loader.resolve("@earendil-works/pi-ai", { parentURL: "file:///host/pi-loader.js" }, passthrough).url, pathToFileURL(aliases["@earendil-works/pi-ai"]).href);
});

test("fallback loader aliases external imports for a native TypeScript runner", async () => {
	const loader = await import(`${loaderUrl.href}?native-typescript`);
	loader.initialize({ aliases, nativeRunner: true });
	assert.equal(loader.resolve("@earendil-works/pi-ai", { parentURL: "file:///tmp/child-factory.mjs" }, passthrough).url, pathToFileURL(aliases["@earendil-works/pi-ai"]).href);
});

test("fallback loader redirects only the TUI for a jiti-hosted TypeScript runner", async () => {
	const loader = await import(`${loaderUrl.href}?jiti`);
	loader.initialize({ aliases });
	assert.equal(loader.resolve("@earendil-works/pi-ai", {}, passthrough).url, "@earendil-works/pi-ai");
	assert.equal(loader.resolve("@earendil-works/pi-tui", {}, passthrough).url, pathToFileURL(aliases["@earendil-works/pi-tui"]).href);
});

const preloadUrl = new URL("../../runner-peer-preload.mjs", import.meta.url);

function runNativePreload(alias: string, script: string) {
	return spawnSync(process.execPath, [
		"--import", preloadUrl.href, "--input-type=module", "-e", script,
	], {
		encoding: "utf8",
		env: { ...process.env, JITI_ALIAS: JSON.stringify({ "alias-peer": alias }), PI_ASYNC_NATIVE_RUNNER: "1" },
		timeout: 10_000,
	});
}

test("native preload canonicalizes an owned file symlink for require.resolve", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-alias-"));
	try {
		const target = path.join(root, "target.mjs");
		const link = path.join(root, "link.mjs");
		fs.writeFileSync(target, "export const value = 42;\n");
		fs.symlinkSync(target, link);
		const child = runNativePreload(link, "import { createRequire } from 'node:module'; console.log(createRequire(import.meta.url).resolve('alias-peer')); console.log((await import('alias-peer')).value);");
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(child.stdout.trim().split("\n"), [fs.realpathSync(target), "42"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

if (process.platform === "darwin") {
	test("native preload resolves /tmp and /private/tmp to the same physical file", () => {
		const root = fs.mkdtempSync("/tmp/runner-alias-");
		try {
			const target = path.join(root, "target.mjs");
			fs.writeFileSync(target, "export {};\n");
			for (const alias of [target, fs.realpathSync(target)]) {
				const child = runNativePreload(alias, "import { createRequire } from 'node:module'; console.log(createRequire(import.meta.url).resolve('alias-peer'));");
				assert.equal(child.status, 0, child.stderr);
				assert.equal(child.stdout.trim(), fs.realpathSync(target));
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

// Exercise both resolver implementations with the same boundary assertions. Capture
// registerHooks in a fresh child so nonnative nextResolve and FS errors are observable.
for (const route of ["hook", "fallback"]) {
	test(`${route} preserves native canonical/missing/error and nonnative raw contracts`, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-alias-contract-"));
		try {
			const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
				import assert from 'node:assert/strict';
				import fs from 'node:fs';
				import module from 'node:module';
				import path from 'node:path';
				import { pathToFileURL } from 'node:url';
				const root = process.argv[1];
				const target = path.join(root, 'target.mjs');
				const link = path.join(root, 'link.mjs');
				const missing = path.join(root, 'missing.mjs');
				const broken = path.join(root, 'broken.mjs');
				const notdir = path.join(target, 'child.mjs');
				fs.writeFileSync(target, 'export const value = 42;');
				fs.symlinkSync(target, link);
				fs.symlinkSync(missing, broken);
				const aliases = { 'alias-peer': link, '@earendil-works/pi-tui': link, '@earendil-works/pi-ai': link };
				let sequence = 0;
				async function resolver(nativeRunner, alias = link) {
					aliases['alias-peer'] = alias;
					if (${JSON.stringify(route)} === 'fallback') {
						const loader = await import(${JSON.stringify(loaderUrl.href)} + '?' + sequence++);
						loader.initialize({ aliases, nativeRunner });
						return loader.resolve;
					}
					process.env.JITI_ALIAS = JSON.stringify(aliases);
					process.env.PI_ASYNC_NATIVE_RUNNER = nativeRunner ? '1' : '0';
					let resolve;
					const original = module.registerHooks;
					module.registerHooks = hooks => { resolve = hooks.resolve; };
					module.syncBuiltinESMExports();
					try { await import(${JSON.stringify(preloadUrl.href)} + '?' + sequence++); }
					finally { module.registerHooks = original; module.syncBuiltinESMExports(); }
					assert.equal(typeof resolve, 'function');
					return resolve;
				}
				const context = { parentURL: pathToFileURL(path.join(root, 'parent.mjs')).href };
				const unexpected = () => { throw new Error('must not fall back'); };
				for (const alias of [target, link${process.platform === "darwin" ? ", link.replace('/private/tmp/', '/tmp/')" : ""}]) {
					const resolve = await resolver(true, alias);
					assert.deepEqual(resolve('alias-peer', context, unexpected), { url: pathToFileURL(fs.realpathSync(target)).href, shortCircuit: true });
				}
				for (const alias of [missing, broken, notdir]) {
					const resolve = await resolver(true, alias);
					const result = resolve('alias-peer', context, unexpected);
					assert.deepEqual(result, { url: pathToFileURL(alias).href, shortCircuit: true });
					await assert.rejects(import(result.url), { code: 'ERR_MODULE_NOT_FOUND' });
				}
				const resolve = await resolver(true);
				const original = fs.realpathSync;
				try {
					for (const code of ['EACCES', 'EIO', 'ELOOP']) {
						const failure = Object.assign(new Error('injected FS failure'), { code });
						fs.realpathSync = () => { throw failure; };
						module.syncBuiltinESMExports();
						assert.throws(() => resolve('alias-peer', context, unexpected), error => error === failure);
					}
				} finally { fs.realpathSync = original; module.syncBuiltinESMExports(); }
				const nonnative = await resolver(false);
				try {
					fs.realpathSync = () => { throw new Error('nonnative must not touch FS'); };
					module.syncBuiltinESMExports();
					const next = (specifier, actualContext) => {
						assert.equal(actualContext, context);
						return { url: specifier, shortCircuit: false };
					};
					assert.deepEqual(nonnative('@earendil-works/pi-tui', context, next), { url: pathToFileURL(link).href, shortCircuit: false });
					assert.deepEqual(nonnative('@earendil-works/pi-ai', context, next), { url: '@earendil-works/pi-ai', shortCircuit: false });
					assert.deepEqual(resolve('node:fs', context, next), { url: 'node:fs', shortCircuit: false });
				} finally { fs.realpathSync = original; module.syncBuiltinESMExports(); }
				console.log('contracts passed');
			`, root], { encoding: "utf8", timeout: 10_000 });
			assert.equal(child.status, 0, child.stderr);
			assert.equal(child.stdout.trim(), "contracts passed");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

test("native preload missing aliases fail import instead of falling back to an installed peer", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-missing-alias-"));
	try {
		const peerRoot = path.join(root, "node_modules", "alias-peer");
		fs.mkdirSync(peerRoot, { recursive: true });
		fs.writeFileSync(path.join(peerRoot, "package.json"), JSON.stringify({ type: "module", exports: "./index.mjs" }));
		fs.writeFileSync(path.join(peerRoot, "index.mjs"), "export const value = 'wrong fallback';\n");
		const parent = path.join(root, "parent.mjs");
		fs.writeFileSync(parent, "import 'alias-peer';\n");
		const missing = path.join(root, "missing.mjs");
		const broken = path.join(root, "broken.mjs");
		fs.symlinkSync(missing, broken);
		for (const [alias, code] of [[missing, "ENOENT"], [broken, "ENOENT"], [path.join(parent, "child.mjs"), "ENOTDIR"]]) {
			const child = runNativePreload(alias, `try { await import(${JSON.stringify(pathToFileURL(parent).href)}); } catch (error) { console.log(error.code); process.exitCode = 1; }`);
			assert.equal(child.status, 1, child.stderr);
			assert.equal(child.stdout.trim(), code);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("native preload keeps the existing .js to .ts fallback", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-ts-fallback-"));
	try {
		const target = path.join(root, "target.ts");
		fs.writeFileSync(target, "export const value: number = 42;\n");
		const child = runNativePreload(path.join(root, "unused.mjs"), `console.log((await import(${JSON.stringify(pathToFileURL(target.replace(/\.ts$/, ".js")).href)})).value);`);
		assert.equal(child.status, 0, child.stderr);
		assert.equal(child.stdout.trim(), "42");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
