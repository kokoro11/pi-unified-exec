/**
 * Codemode script-facing results and their registered output schemas.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import {
	execCommandScriptResult,
	execCommandScriptResultSchema,
	killNotFoundScriptResult,
	killScriptResult,
	killScriptResultSchema,
	listSessionsScriptResultSchema,
	setOnExitScriptResultSchema,
} from "../src/script-result.ts";
import { IS_WINDOWS } from "../src/shell.ts";
import {
	finalizeKillResult,
	finalizeProcessResult,
	renderKillResultText,
	renderProcessResultText,
} from "../src/tool-result.ts";
import { activateProcessTools } from "./fixtures/process-tools.ts";

const encoder = new TextEncoder();

function assertPlainJson(value: unknown): void {
	assert.deepEqual(JSON.parse(JSON.stringify(value)), value, "structuredContent must be plain JSON");
}

function processInput(overrides: Partial<Parameters<typeof finalizeProcessResult>[0]> = {}) {
	return {
		operation: "exec_command" as const,
		running: false,
		wallTimeSec: 0.25,
		collected: encoder.encode("hello\nworld\n"),
		sessionId: undefined,
		exitCode: 0,
		signal: null,
		failure: null,
		tty: false,
		log: 1,
		...overrides,
	};
}

function makeHarness() {
	const tools: Record<string, any> = {};
	const ctx = {
		cwd: process.cwd(),
		ui: { notify() {}, setStatus() {}, setWidget() {}, select: async () => undefined },
		hasUI: false,
	};
	activateProcessTools({
		registerTool: (def: any) => (tools[def.name] = def),
		on() {},
		registerCommand() {},
		registerShortcut() {},
		registerFlag() {},
		registerMessageRenderer() {},
		getFlag: () => false,
		getActiveTools: () => [],
		setActiveTools() {},
	} as any);
	return {
		tools,
		call: (name: string, params: any) => tools[name].execute("test-call-id", params, undefined, undefined, ctx),
	};
}

describe("script result projections", () => {
	it("exited process: real newlines, exit code, schema-valid plain JSON", () => {
		const details = finalizeProcessResult(processInput());
		const value = execCommandScriptResult(details);
		assert.ok(Value.Check(execCommandScriptResultSchema, value));
		assertPlainJson(value);
		assert.equal(value.details.status, "exited");
		assert.equal(value.details.running, false);
		assert.equal(value.details.exit_code, 0);
		assert.equal(value.details.output, "hello\nworld\n");
		assert.equal(value.details.truncated, false);
		assert.equal(value.details.session_id, undefined);
		assert.equal(value.text, renderProcessResultText(details));
	});

	it("running process exposes session_id; non-zero exit and signal are typed", () => {
		const running = execCommandScriptResult(finalizeProcessResult(processInput({ running: true, sessionId: 3, exitCode: undefined })));
		assert.ok(Value.Check(execCommandScriptResultSchema, running));
		assert.equal(running.details.status, "running");
		assert.equal(running.details.session_id, 3);
		assert.equal(running.details.exit_code, undefined);

		const failed = execCommandScriptResult(
			finalizeProcessResult(processInput({ exitCode: 2, signal: "SIGTERM", failure: "boom\nsecond line" })),
		);
		assert.ok(Value.Check(execCommandScriptResultSchema, failed));
		assert.equal(failed.details.exit_code, 2);
		assert.equal(failed.details.signal, "SIGTERM");
		assert.equal(failed.details.failure_message, "boom second line", "metadata stays single-line and bounded");
	});

	it("truncated output is flagged and preserves UTF-8 within the byte cap", () => {
		const big = "界".repeat(DEFAULT_MAX_BYTES);
		const value = execCommandScriptResult(finalizeProcessResult(processInput({ collected: encoder.encode(big) })));
		assert.ok(Value.Check(execCommandScriptResultSchema, value));
		assert.equal(value.details.truncated, true);
		assert.ok(Buffer.byteLength(value.details.output) <= DEFAULT_MAX_BYTES);
		assert.match(value.details.output, /^界+$/);
		assert.match(value.text, /\[Showing .+Full output: 1\]/);
	});

	it("terminal control sequences never reach script output", () => {
		const value = execCommandScriptResult(
			finalizeProcessResult(processInput({ collected: encoder.encode("\u001b[31mred\u001b[0m\u0007 ok\n") })),
		);
		assert.doesNotMatch(value.details.output, /\u001b|\u0007/);
		assert.match(value.details.output, /red ok/);
		assert.doesNotMatch(value.text, /\u001b|\u0007/);
	});

	it("kill results, including failed and unknown sessions, match the kill schema", () => {
		const killInput = {
			wallTimeSec: 0.1,
			totalTimeSec: 2.5,
			collected: encoder.encode("bye\n"),
			sessionId: 4,
			pid: 1234,
			requestedSignal: "SIGTERM" as NodeJS.Signals,
			exitCode: undefined,
			signal: "SIGTERM" as NodeJS.Signals,
			failure: null,
			tty: false,
			escalated: false,
			killed: true,
		};
		const shape = finalizeKillResult(killInput);
		const killed = killScriptResult(shape);
		assert.ok(Value.Check(killScriptResultSchema, killed));
		assertPlainJson(killed);
		assert.equal(killed.details.status, "killed");
		assert.equal(killed.details.output, "bye\n");
		assert.equal(killed.details.pid, 1234);
		assert.equal(killed.details.total_time_seconds, 2.5);
		assert.equal(Object.hasOwn(killed.details, "killed"), false);
		assert.equal(killed.text, renderKillResultText(shape));
		assert.doesNotMatch(killed.text, /^pid:/m);

		const failed = killScriptResult(finalizeKillResult({ ...killInput, killed: false, failure: "still alive" }));
		assert.ok(Value.Check(killScriptResultSchema, failed));
		assert.equal(failed.details.status, "kill_failed");
		assert.equal(failed.details.running, true);
		assert.equal(failed.details.pid, 1234);
		assert.equal(failed.details.total_time_seconds, 2.5);
		assert.match(failed.text, /^pid: 1234$/m);

		const missing = killNotFoundScriptResult(99);
		assert.ok(Value.Check(killScriptResultSchema, missing));
		assertPlainJson(missing);
		assert.equal(missing.details.found, false);
		assert.equal(Object.hasOwn(missing.details, "total_time_seconds"), false);
		assert.equal(Object.hasOwn(missing.details, "pid"), false);
		assert.equal(Object.hasOwn(missing.details, "killed"), false);
		assert.equal(missing.text, "[kill failed #99]\nfailure: No such session: 99");
	});
});

describe("registered tools return structuredContent", () => {
	it("every tool declares an outputSchema", () => {
		const { tools } = makeHarness();
		for (const name of ["exec_command", "write_stdin", "kill_session", "list_sessions", "set_on_exit"]) {
			assert.ok(tools[name]?.outputSchema, `${name} must declare outputSchema`);
		}
	});

	it("exec_command exposes the same formatted reply and bounded output to scripts", async () => {
		const { call, tools } = makeHarness();
		const result = await call("exec_command", {
			cmd: `node -e "console.log('a'); console.log('b'); process.exitCode = 3"`,
			shell: IS_WINDOWS ? "cmd" : "bash",
			yield_time_ms: 5000,
		});
		assert.equal(result.content[0].text, renderProcessResultText(result.details));
		assert.ok(Value.Check(tools.exec_command.outputSchema, result.structuredContent));
		assertPlainJson(result.structuredContent);
		assert.equal(result.structuredContent.text, result.content[0].text);
		assert.equal(result.structuredContent.details.output, result.details.output);
		assert.equal(result.structuredContent.details.output, "a\nb\n");
		assert.equal(result.structuredContent.details.exit_code, 3);
		assert.equal(Object.hasOwn(result.structuredContent.details, "total_time_seconds"), false);
	});

	it("write_stdin, list_sessions, set_on_exit and kill_session cover live and unknown sessions", async () => {
		const { call, tools } = makeHarness();
		const started = await call("exec_command", {
			cmd: `node -e "setTimeout(() => {}, 30000)"`,
			shell: IS_WINDOWS ? "cmd" : "bash",
			yield_time_ms: 300,
		});
		const sid = started.structuredContent.details.session_id;
		assert.equal(typeof sid, "number");
		assert.equal(started.structuredContent.details.status, "running");

		const polled = await call("write_stdin", { session_id: sid, yield_time_ms: 5000 });
		assert.ok(Value.Check(tools.write_stdin.outputSchema, polled.structuredContent));
		assertPlainJson(polled.structuredContent);
		assert.equal(polled.structuredContent.details.running, true);
		assert.equal(polled.structuredContent.details.session_id, sid);
		assert.equal(polled.structuredContent.text, polled.content[0].text);
		assert.ok(polled.structuredContent.details.total_time_seconds > polled.structuredContent.details.wall_time_seconds);
		assert.match(polled.structuredContent.text, /^total_time: \d+(?:\.\d+)?(?:ms|s)$/m);
		assert.equal(Object.hasOwn(polled.structuredContent.details, "tool_time_utc"), false);

		const listed = await call("list_sessions", {});
		assert.ok(Value.Check(listSessionsScriptResultSchema, listed.structuredContent));
		assertPlainJson(listed.structuredContent);
		assert.ok(listed.structuredContent.sessions.some((s: any) => s.session_id === sid && s.running));
		assert.equal(Object.hasOwn(listed.structuredContent, "tool_time_utc"), false);

		const armed = await call("set_on_exit", { session_id: sid, on_exit: "wake" });
		assert.ok(Value.Check(setOnExitScriptResultSchema, armed.structuredContent));
		assert.equal(armed.structuredContent.wake_armed, true);
		const unknownOnExit = await call("set_on_exit", { session_id: 999_999, on_exit: "wake" });
		assert.ok(Value.Check(setOnExitScriptResultSchema, unknownOnExit.structuredContent));
		assert.equal(unknownOnExit.structuredContent.found, false);

		const killed = await call("kill_session", { session_id: sid });
		assert.ok(Value.Check(killScriptResultSchema, killed.structuredContent));
		assert.equal(killed.structuredContent.details.status, "killed");
		assert.equal(killed.structuredContent.details.pid, listed.structuredContent.sessions[0].pid);
		assert.ok(killed.structuredContent.details.total_time_seconds >= polled.structuredContent.details.total_time_seconds);
		assert.equal(killed.structuredContent.text, killed.content[0].text);
		const unknownKill = await call("kill_session", { session_id: sid });
		assert.ok(Value.Check(killScriptResultSchema, unknownKill.structuredContent));
		assert.equal(unknownKill.structuredContent.details.found, false);
		assert.equal(unknownKill.structuredContent.text, unknownKill.content[0].text);
	});
});

describe("actual Pi codemode", () => {
	it("scripts receive typed details and can print the formatted reply directly", () => {
		mkdirSync(".temp", { recursive: true });
		const root = mkdtempSync(join(process.cwd(), ".temp", "pi-exec-script-result-"));
		try {
			const agentDir = join(root, "agent");
			mkdirSync(agentDir);
			const cmd = `node -e "for (let i = 1; i <= 40; i++) console.log('line of build output number', i)"`;
			const script = String.raw`
const r = await tools.exec_command(${JSON.stringify({ cmd, shell: IS_WINDOWS ? "cmd" : "bash", yield_time_ms: 5000 })});
const decl = await describeTool("exec_command");
const pollDetails = (await describeTool("write_stdin")).split(/details:\s*\{/)[1];
text({
  exit_code: r.details.exit_code,
  lines: r.details.output.trimEnd().split("\n").length,
  log: r.details.log,
  execDeclared: /details:\s*\{/.test(decl) && /text:\s*string/.test(decl) && !decl.includes("total_time_seconds"),
  pollDeclared: /\bsession_id:\s*number\b/.test(pollDetails) && /\btotal_time_seconds:\s*number\b/.test(pollDetails),
});
text(r.text);
`;
			const provider = join(root, "provider.ts");
			writeFileSync(
				provider,
				`
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/compat';
export default function(pi) {
  const faux = fauxProvider({ provider: 'exec-codemode' });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('codemode', { code: ${JSON.stringify(script)} }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('CODEMODE_OK'),
  ]);
  pi.registerProvider(faux.provider);
}
`,
			);
			const cli =
				process.env.PI_UNIFIED_EXEC_TEST_CLI ??
				fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
			const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
			// prettier-ignore
			const run = spawnSync("node", [
				// No --no-extensions: codemode is a built-in extension. HOME and the agent dir are isolated.
				cli, "--mode", "json", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes",
				"-e", provider, "-e", extension, "--tools", "codemode,exec_command,write_stdin", "--provider", "exec-codemode", "--model", "faux-1", "run it",
			], {
				cwd: root,
				env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
				encoding: "utf8",
				timeout: 30_000,
				maxBuffer: 8 * 1024 * 1024,
			});
			assert.equal(run.error, undefined);
			assert.equal(run.status, 0, run.stderr);
			const rows = run.stdout
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line));
			const end = rows.find((row) => row.type === "tool_execution_end" && row.toolName === "codemode");
			assert.ok(end, run.stdout.slice(-8000));
			assert.equal(end.isError, false, JSON.stringify(end.result).slice(0, 4000));
			const output: string = end.result.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
			const summaryText = output.match(/^\{"exit_code".*\}$/m)?.[0];
			assert.ok(summaryText, output);
			assert.deepEqual(JSON.parse(summaryText), { exit_code: 0, lines: 40, log: 1, execDeclared: true, pollDeclared: true });
			assert.match(output, /^\[exited ok\]\n/m);
			assert.match(output, /^log: 1$/m);
			assert.match(output, /\n---\nline of build output number 1\n/);
			assert.match(output, /^line of build output number 40$/m);
			assert.match(run.stdout, /CODEMODE_OK/);
			const archive = readFileSync(join(root, ".temp", "pi-unified-exec", "1.log"), "utf8");
			assert.equal(archive.trimEnd().split("\n").length, 40);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 35_000);
});
