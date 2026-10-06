import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const loaderState = process.env.PI_SUBAGENTS_TEST_LOADER;
const nestedTestProcess = loaderState !== undefined;
const testFileProcess = process.env.NODE_TEST_CONTEXT !== undefined && loaderState !== "test-file";
// The suite launcher shares only a container. Each fresh test file owns its HOME
// and temp state; descendants of that file must keep the same fixture paths.
const evalEntry = process.execArgv.some((arg) =>
	arg === "-e" || arg === "-p" || arg === "-pe" ||
	arg === "--eval" || arg === "--print" || arg.startsWith("--eval=") || arg.startsWith("--print="));
const freshSuiteFile = testFileProcess && process.argv[1] !== undefined && process.argv[1] !== "-" && !evalEntry;
if (freshSuiteFile) {
	const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	if (path.basename(sdkEntry) !== "index.js" || path.basename(path.dirname(sdkEntry)) !== "dist") {
		throw new Error(`Unexpected local SDK entry layout: ${sdkEntry}`);
	}
	process.env.PI_PACKAGE_DIR = path.dirname(path.dirname(sdkEntry));
}
const configuredTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
const containerRoot = configuredTempRoot
	? path.resolve(configuredTempRoot)
	: fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-"));
fs.mkdirSync(containerRoot, { recursive: true });
const ownedRoot = freshSuiteFile
	? fs.mkdtempSync(path.join(containerRoot, "file-"))
	: containerRoot;
const isolatedHome = freshSuiteFile
	? path.join(ownedRoot, "home")
	: nestedTestProcess && !testFileProcess ? process.env.HOME : path.join(containerRoot, "home");
const tempRoot = freshSuiteFile
	? path.join(isolatedHome, "pi-subagents-tmp")
	: containerRoot;
fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
if (process.platform === "darwin") fs.closeSync(fs.openSync(path.join(tempRoot, ".metadata_never_index"), "a"));
process.env.PI_SUBAGENTS_TEMP_ROOT = tempRoot;
process.env.TMPDIR = tempRoot;
process.env.TMP = tempRoot;
process.env.TEMP = tempRoot;

if (!nestedTestProcess || testFileProcess) process.env.PI_SUBAGENTS_TEST_PARENT_PID = String(process.pid);
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
if (!nestedTestProcess || freshSuiteFile) delete process.env.PI_CODING_AGENT_DIR;
process.env.PI_SUBAGENTS_TEST_LOADER = testFileProcess ? "test-file" : "loaded";

if (!configuredTempRoot || freshSuiteFile) {
	// Housekeeping for a root no other process shares: a Windows handle or a leftover
	// descendant must not turn a test file whose tests all passed into a failed file.
	process.on("exit", () => {
		try {
			fs.rmSync(ownedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		} catch (error) {
			try {
				fs.writeSync(2, `warning: test temp root not removed: ${ownedRoot} (${error?.code ?? error})\n`);
			} catch {}
		}
	});
}
