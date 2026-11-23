/**
 * End-to-end tests for unified-exec.
 *
 * Exercises the full tool pipeline by instantiating the extension with a stub
 * ExtensionAPI and calling the registered tools' `execute` functions directly.
 * Bypasses pi's event loop but uses the real SessionStore / ExecSession /
 * SpawnedChild code paths.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { MAX_EMPTY_POLL_ENV_VAR } from "../src/time.ts";
import { OUTPUT_LOG_DIRECTORY } from "../src/output-log.ts";
import { IS_WINDOWS } from "../src/shell.ts";
import { activateProcessTools } from "./fixtures/process-tools.ts";

interface ToolDef {
	name: string;
	execute: (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: any,
		ctx: any,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: any; structuredContent?: Record<string, any> }>;
	renderCall?: (...args: any[]) => unknown;
	renderResult?: (...args: any[]) => unknown;
}

function makeHarness() {
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const commands: Record<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }> = {};
	const uiEvents = {
		notifications: [] as Array<{ message: string; type?: string }>,
		statuses: new Map<string, string | undefined>(),
		widgets: new Map<string, { content: string[] | undefined; options?: unknown }>(),
		// Queue of responders for ui.select(); each gets the options array.
		selectResponses: [] as Array<(options: string[]) => string | undefined>,
	};

	const stubCtx = {
		cwd: process.cwd(),
		ui: {
			notify: (message: string, type?: string) => uiEvents.notifications.push({ message, type }),
			setStatus: (key: string, value: string | undefined) => uiEvents.statuses.set(key, value),
			setWidget: (key: string, content: string[] | undefined, options?: unknown) =>
				uiEvents.widgets.set(key, { content, options }),
			select: (_title: string, options: string[]) => {
				const responder = uiEvents.selectResponses.shift();
				return Promise.resolve(responder ? responder(options) : undefined);
			},
		},
		hasUI: false,
	};

	const pi = {
		registerTool: (def: ToolDef) => {
			tools[def.name] = def;
		},
		on: (event: string, handler: (e: any, ctx: any) => any) => {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand: (name: string, options: any) => {
			commands[name] = options;
		},
		registerShortcut: () => {},
		registerFlag: () => {},
		registerMessageRenderer: () => {},
		getFlag: () => false,
		getActiveTools: () => ["bash"],
		setActiveTools: () => {},
	};

	activateProcessTools(pi as any);

	return {
		async call(toolName: string, params: any, signal?: AbortSignal, onUpdate?: (partial: any) => void) {
			const def = tools[toolName];
			if (!def) throw new Error(`no such tool: ${toolName}`);
			return def.execute("test-call-id", params, signal, onUpdate, stubCtx);
		},
		async invokeCommand(name: string, args = "") {
			const cmd = commands[name];
			if (!cmd) throw new Error(`no such command: ${name}`);
			return cmd.handler(args, stubCtx);
		},
		stubCtx,
		tools,
		uiEvents,
		async emit(event: string, evt: any = {}) {
			const results = [];
			for (const h of handlers[event] ?? []) results.push(await h(evt, stubCtx));
			return results;
		},
	};
}

/** Poll until `cond` is true or the deadline passes (CI runners are slow). */
async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!cond() && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 50));
	}
	return cond();
}

describe("unified-exec e2e", () => {
	it("registers explicit call/result renderers for every unified-exec tool", () => {
		const h = makeHarness();
		for (const name of ["exec_command", "write_stdin", "set_on_exit", "kill_session", "list_sessions"]) {
			assert.equal(typeof h.tools[name]?.renderCall, "function", `${name} renderCall missing`);
			assert.equal(typeof h.tools[name]?.renderResult, "function", `${name} renderResult missing`);
		}
	});

	it.skipIf(!IS_WINDOWS)("Windows: shell=powershell and shell=cmd get shell-appropriate flags", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "Write-Output ps-ok", shell: "powershell", yield_time_ms: 20000 });
		assert.equal(r1.details.exit_code, 0, `powershell details=${JSON.stringify(r1.details)}`);
		assert.ok(
			r1.details.output.includes("ps-ok"),
			`powershell output=${JSON.stringify(r1.details.output)} session_id=${r1.details.session_id}`,
		);
		const r2 = await h.call("exec_command", { cmd: "echo cmd-ok", shell: "cmd", yield_time_ms: 20000 });
		assert.equal(r2.details.exit_code, 0, `cmd details=${JSON.stringify(r2.details)}`);
		assert.ok(r2.details.output.includes("cmd-ok"), `cmd output=${JSON.stringify(r2.details.output)}`);
		await h.emit("session_shutdown");
	});

	it.skipIf(!IS_WINDOWS)("Windows: cmd.exe quoting survives operators, quotes, %VAR%, parens", async () => {
		// These are exactly the inputs the /d /s /c "<cmd>" + verbatim-args
		// mechanism exists for; `echo simple` would pass even if it broke.
		const h = makeHarness();
		await h.emit("session_start");
		const cases: Array<{ cmd: string; expect: string[] }> = [
			{ cmd: "echo one& echo two", expect: ["one", "two"] }, // & separator
			{ cmd: 'echo "a & b"', expect: ['"a & b"'] }, // quoted & is literal
			{ cmd: "echo %OS%", expect: ["Windows_NT"] }, // env expansion
			{ cmd: "(echo grouped)", expect: ["grouped"] }, // parentheses
			// findstr, not find: Git Bash environments often shadow Windows'
			// find.exe with GNU find earlier on PATH.
			{ cmd: "echo piped-x | findstr piped", expect: ["piped-x"] }, // pipe
		];
		for (const { cmd, expect } of cases) {
			const r = await h.call("exec_command", { cmd, shell: "cmd", yield_time_ms: 20000 });
			assert.equal(r.details.exit_code, 0, `cmd=${cmd} details=${JSON.stringify(r.details)}`);
			for (const e of expect) {
				assert.ok(r.details.output.includes(e), `cmd=${cmd} expected "${e}" in output=${r.details.output}`);
			}
		}
		await h.emit("session_shutdown");
	});

	it("short-lived command returns exit_code and no session_id", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo hello && echo world" });
		assert.equal(r.details.exit_code, 0);
		assert.equal(r.details.session_id, undefined);
		assert.ok(r.details.output.includes("hello"));
		assert.ok(r.details.output.includes("world"));
		await h.emit("session_shutdown");
	});

	it("write_stdin returns the final result when the process already exited before the write", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// 3 ticks @ 200ms = 600ms runtime. Yield at 250ms -> session_id returned.
		// Then wait 800ms so the process exits, then poll.
		const startedAt = performance.now();
		const r1 = await h.call("exec_command", {
			cmd: "for i in 1 2 3; do echo tock $i; sleep 0.2; done",
			yield_time_ms: 250,
		});
		assert.ok(
			typeof r1.details.session_id === "number",
			`first yield should return session_id; got ${JSON.stringify(r1.details)}`,
		);
		const sid = r1.details.session_id;

		// Wait for the process to definitely exit (600ms runtime - 250ms yield + slack).
		await new Promise((r) => setTimeout(r, 800));

		// Try a write — the process has already exited, but the store should still have
		// the entry so we can observe the exit and drain trailing output.
		const secondsBeforePoll = (performance.now() - startedAt) / 1000;
		const r2 = await h.call("write_stdin", {
			session_id: sid,
			chars: "input after exit\n",
			yield_time_ms: 5000,
		});
		assert.equal(r2.details.exit_code, 0, `expected exit_code=0; got ${JSON.stringify(r2.details)}`);
		assert.equal(r2.details.session_id, sid);
		assert.equal(r2.details.running, false);
		assert.ok(r2.content[0].text.startsWith(`[exited #${sid} ok]\n`));
		assert.ok(r2.details.output.includes("tock 3"), `expected 'tock 3' in output: ${r2.details.output}`);
		const total = r2.details.total_time_seconds;
		assert.ok(total >= 0.55 && total < secondsBeforePoll - 0.1, `total_time should stop at exit: ${JSON.stringify(r2.details)}`);
		assert.equal(r2.structuredContent?.details.session_id, sid);
		assert.equal(r2.structuredContent?.details.total_time_seconds, total);
		await assert.rejects(() => h.call("write_stdin", { session_id: sid }), /unknown session_id/);
		await h.emit("session_shutdown");
	});

	it("empty write_stdin accepts a long relative wait and returns early on exit", async () => {
		const previous = process.env[MAX_EMPTY_POLL_ENV_VAR];
		delete process.env[MAX_EMPTY_POLL_ENV_VAR];
		const h = makeHarness();
		try {
			await h.emit("session_start");
			const r1 = await h.call("exec_command", {
				cmd: "sleep 0.6; echo long-poll-finished",
				yield_time_ms: 250,
			});
			assert.ok(typeof r1.details.session_id === "number", `got ${JSON.stringify(r1.details)}`);
			const sid = r1.details.session_id;
			const start = performance.now();
			const r2 = await h.call("write_stdin", { session_id: sid, chars: "", yield_time_ms: 2_000_000 });
			assert.ok(performance.now() - start < 10_000);
			assert.equal(r2.details.yield_time_ms, 2_000_000);
			assert.equal(r2.details.session_id, sid);
			assert.equal(r2.details.running, false);
			assert.equal(r2.details.exit_code, 0);
			assert.equal(Object.hasOwn(r2.details, "wait_status"), false);
			assert.match(r2.details.output, /long-poll-finished/);
		} finally {
			if (previous === undefined) delete process.env[MAX_EMPTY_POLL_ENV_VAR];
			else process.env[MAX_EMPTY_POLL_ENV_VAR] = previous;
			await h.emit("session_shutdown");
		}
	});

	it("an explicit operator cap rejects longer relative waits without clamping", async () => {
		const previous = process.env[MAX_EMPTY_POLL_ENV_VAR];
		process.env[MAX_EMPTY_POLL_ENV_VAR] = "10000";
		const h = makeHarness();
		try {
			await h.emit("session_start");
			const r1 = await h.call("exec_command", {
				cmd: "sleep 0.4",
				yield_time_ms: 250,
			});
			assert.ok(typeof r1.details.session_id === "number", `got ${JSON.stringify(r1.details)}`);
			const sid = r1.details.session_id;

			await new Promise((r) => setTimeout(r, 700));

			// Values above the lowered cap are rejected against that cap…
			await assert.rejects(
				() => h.call("write_stdin", { session_id: sid, chars: "", yield_time_ms: 20_000 }),
				/exceeds the configured empty-poll cap of 10000 ms/,
			);
			// …while in-cap values behave normally.
			const r2 = await h.call("write_stdin", {
				session_id: sid,
				chars: "",
				yield_time_ms: 10_000,
			});
			assert.equal(r2.details.yield_time_ms, 10_000);
			assert.equal(r2.details.session_id, sid);
			assert.equal(r2.details.running, false);
			assert.equal(r2.details.exit_code, 0);
		} finally {
			if (previous === undefined) delete process.env[MAX_EMPTY_POLL_ENV_VAR];
			else process.env[MAX_EMPTY_POLL_ENV_VAR] = previous;
			await h.emit("session_shutdown");
		}
	});

	it("long-running command yields session_id and write_stdin resumes", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// 5 ticks, 0.3s apart = ~1.5s total. Yield at 600ms.
		const r1 = await h.call("exec_command", {
			cmd: "for i in 1 2 3 4 5; do echo tick $i; sleep 0.3; done",
			yield_time_ms: 600,
		});
		assert.equal(r1.details.exit_code, undefined, "should still be running");
		assert.ok(typeof r1.details.session_id === "number", `got session_id=${r1.details.session_id}`);
		const sid = r1.details.session_id;
		// Expect ~ticks 1-2 in first yield.
		assert.ok(r1.details.output.includes("tick 1"), `first out: ${r1.details.output}`);

		// Poll with big yield to catch the rest + exit.
		const r2 = await h.call("write_stdin", {
			session_id: sid,
			chars: "",
			yield_time_ms: 5000,
		});
		assert.equal(r2.details.exit_code, 0, `r2=${JSON.stringify(r2.details)}`);
		assert.equal(r2.details.session_id, sid);
		assert.equal(r2.details.running, false);
		assert.ok(r2.details.output.includes("tick 5"), `second out: ${r2.details.output}`);
		await h.emit("session_shutdown");
	});

	it("write_stdin sends input to a stdin consumer in pipe mode", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// cat prints back whatever you feed it on stdin. Pipe mode keeps stdin open.
		const r1 = await h.call("exec_command", {
			cmd: "cat",
			yield_time_ms: 300,
		});
		assert.ok(typeof r1.details.session_id === "number", `got ${JSON.stringify(r1.details)}`);
		const sid = r1.details.session_id;

		// Send a line.
		const r2 = await h.call("write_stdin", {
			session_id: sid,
			chars: "hello from stdin\n",
			yield_time_ms: 400,
		});
		assert.ok(r2.details.output.includes("hello from stdin"), `got ${JSON.stringify(r2.details)}`);
		assert.ok(typeof r2.details.session_id === "number");
		assert.ok(r2.details.total_time_seconds > r2.details.wall_time_seconds);

		// Send EOF so cat exits.
		const r3 = await h.call("write_stdin", {
			session_id: sid,
			chars: "\x04",
			yield_time_ms: 1000,
		});
		// Some environments need stdin.end() instead of \x04; in pipe mode \x04 won't EOF.
		// If r3 is still running, force kill to clean up.
		if (r3.details.running) {
			await h.call("kill_session", { session_id: sid });
		}
		await h.emit("session_shutdown");
	});

	it("kill_session terminates a stuck process", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", {
			cmd: "sleep 60",
			yield_time_ms: 300,
		});
		assert.ok(typeof r1.details.session_id === "number");
		const sid = r1.details.session_id;

		const t0 = Date.now();
		const r2 = await h.call("kill_session", { session_id: sid });
		const dt = Date.now() - t0;
		assert.ok(dt < 2500, `kill_session took too long: ${dt}ms`);
		assert.equal(r2.details.session_id, sid);
		// Either signal=SIGTERM, or exit_code set (sleep can be killed with no code).
		assert.ok(r2.details.signal === "SIGTERM" || r2.details.exit_code != null, `details=${JSON.stringify(r2.details)}`);
		await h.emit("session_shutdown");
	});

	it.skipIf(!IS_WINDOWS)("Windows: kill_session terminates a shell AND-list and releases inherited pipes", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const started = await h.call("exec_command", {
				cmd: "sleep 8 && echo tail",
				yield_time_ms: 300,
			});
			const sid = started.details.session_id;
			assert.equal(typeof sid, "number", JSON.stringify(started.details));

			const killed = await h.call("kill_session", { session_id: sid });
			assert.equal(killed.details.status, "killed", JSON.stringify(killed.details));
			assert.equal(killed.details.killed, true);
			assert.equal(killed.details.running, false);
			assert.equal(killed.structuredContent?.status, "killed");
			assert.equal(killed.structuredContent?.running, false);
			const listed = await h.call("list_sessions", {});
			assert.ok(!listed.details.sessions.some((s: any) => s.session_id === sid));
		} finally {
			await h.emit("session_shutdown");
		}
	});

	for (const operation of ["kill_session", "session_shutdown"] as const) {
		it.skipIf(!IS_WINDOWS)(`Windows: ${operation} terminates an orphan holding pipes after shell exit`, async () => {
			const h = makeHarness();
			await h.emit("session_start");
			try {
				const leaf = 'console.log("leaf:" + process.pid); setTimeout(() => {}, 8000)';
				// Skip Node's own kill-on-parent-exit job so the leaf survives
				// its parent, while remaining in the session's Windows job.
				const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(leaf)}], {stdio:"inherit",detached:true}).unref()`;
				const started = await h.call("exec_command", {
					cmd: `node -e '${parent}'`,
					yield_time_ms: 1000,
				});
				const sid = started.details.session_id;
				assert.equal(typeof sid, "number", JSON.stringify(started.details));
				assert.match(started.details.note, /shell has exited/);
				const pid = Number(/leaf:(\d+)/.exec(started.details.output)?.[1]);
				assert.ok(pid > 0, JSON.stringify(started.details));
				process.kill(pid, 0);

				if (operation === "kill_session") {
					const killed = await h.call("kill_session", { session_id: sid });
					assert.equal(killed.details.status, "killed", JSON.stringify(killed.details));
				} else {
					await h.emit("session_shutdown");
				}
				assert.ok(await waitFor(() => {
					try { process.kill(pid, 0); return false; } catch { return true; }
				}), `orphan ${pid} survived ${operation}`);
				const listed = await h.call("list_sessions", {});
				assert.equal(listed.details.active_count, 0, JSON.stringify(listed.details));
			} finally {
				await h.emit("session_shutdown");
			}
		});
	}

	it.skipIf(!IS_WINDOWS)("Windows: normal completion preserves descendants with detached stdio", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		let pid: number | undefined;
		try {
			const parent = 'const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], {stdio:"ignore",detached:true}); child.unref(); console.log(child.pid)';
			const finished = await h.call("exec_command", { cmd: `node -e '${parent}'` });
			assert.equal(finished.details.exit_code, 0, JSON.stringify(finished.details));
			pid = Number(finished.details.output.trim());
			assert.ok(pid > 0, JSON.stringify(finished.details));
			process.kill(pid, 0);
		} finally {
			if (pid) {
				try { process.kill(pid); } catch {}
			}
			await h.emit("session_shutdown");
		}
	});

	it("kill_session bounds delayed noisy output while the log retains the complete stream", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			// Yield before the burst so kill_session, rather than exec_command,
			// owns the buffered output that exercises this regression.
			const started = await h.call("exec_command", {
				cmd: 'printf "%0512d\\n" 0; sleep 0.8; for i in $(seq 1 4000); do echo "kill-line-${i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done; sleep 60',
				yield_time_ms: 250,
			});
			const sid = started.details.session_id;
			assert.ok(typeof sid === "number", JSON.stringify(started.details));
			const log = started.details.log;
			assert.ok(Number.isSafeInteger(log) && log > 0);
			const logPath = join(OUTPUT_LOG_DIRECTORY, `${log}.log`);
			assert.ok(
				await waitFor(() => {
					try {
						return readFileSync(logPath, "utf8").includes("kill-line-4000-");
					} catch {
						return false;
					}
				}),
				"noisy command did not finish its output burst",
			);

			const killed = await h.call("kill_session", { session_id: sid });
			assert.equal(killed.details.operation, "kill_session");
			assert.equal(killed.details.status, "killed");
			assert.equal(killed.details.running, false);
			assert.equal(killed.details.killed, true);
			assert.equal(Object.hasOwn(killed.details, "final_output"), false);
			assert.ok(Buffer.byteLength(killed.details.output, "utf8") <= DEFAULT_MAX_BYTES);
			assert.equal(killed.details.truncation?.truncated, true, JSON.stringify(killed.details.truncation));
			assert.match(killed.content[0].text, /^\[killed\]/);
			assert.match(killed.content[0].text, /Showing lines/);
			assert.equal(killed.details.log, log);
			assert.equal(killed.structuredContent?.log, log);
			assert.ok(killed.content[0].text.includes(`Full output: ${log}]`));
			assert.ok(
				Buffer.byteLength(killed.content[0].text, "utf8") < DEFAULT_MAX_BYTES + 4096,
				`kill content unexpectedly large: ${Buffer.byteLength(killed.content[0].text, "utf8")}`,
			);

			const fullLog = readFileSync(logPath, "utf8");
			assert.match(fullLog, /kill-line-1-/);
			assert.match(fullLog, /kill-line-4000-/);
			assert.ok(fullLog.split("\n").filter((line) => line.startsWith("kill-line-")).length >= 4000);
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("kill_session escalates to SIGKILL when SIGTERM is trapped", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Trap SIGTERM so bash ignores it; SIGKILL should still work.
		const r1 = await h.call("exec_command", {
			cmd: "trap '' TERM; sleep 60",
			yield_time_ms: 300,
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const r2 = await h.call("kill_session", { session_id: sid });
		if (IS_WINDOWS) {
			// No POSIX signals on Windows: the initial "SIGTERM" is already a
			// Job Object termination and escalation is skipped. Don't assert
			// on exit timing (a loaded runner can exceed the 2s
			// window) — assert the session is gone from the store instead.
			assert.equal(r2.details.escalated, false, `details=${JSON.stringify(r2.details)}`);
			const l = await h.call("list_sessions", {});
			assert.ok(
				!l.details.sessions.some((s: any) => s.session_id === sid && s.running),
				`session ${sid} still listed as running: ${JSON.stringify(l.details)}`,
			);
		} else {
			assert.equal(r2.details.escalated, true, `details=${JSON.stringify(r2.details)}`);
		}
		await h.emit("session_shutdown");
	});

	it("list_sessions enumerates live sessions", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 300 });
		const r2 = await h.call("exec_command", { cmd: "sleep 11", yield_time_ms: 300 });
		const l = await h.call("list_sessions", {});
		assert.equal(l.details.active_count, 2, `details=${JSON.stringify(l.details)}`);
		const ids = l.details.sessions.map((s: any) => s.session_id);
		assert.ok(ids.includes(r1.details.session_id));
		assert.ok(ids.includes(r2.details.session_id));
		// Cleanup.
		await h.call("kill_session", { session_id: r1.details.session_id });
		await h.call("kill_session", { session_id: r2.details.session_id });
		await h.emit("session_shutdown");
	});

	it("session_tree surfaces running sessions in the TUI", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 300 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");

		await h.emit("session_tree", { oldLeafId: "old", newLeafId: "new" });
		assert.equal(h.uiEvents.statuses.get("unified-exec.sessions"), "unified-exec: 1 session running");
		const widget = h.uiEvents.widgets.get("unified-exec.sessions");
		const widgetContent = widget?.content;
		if (!widgetContent) assert.fail(`widget=${JSON.stringify(widget)}`);
		assert.ok(widgetContent[0].includes("1 session still running"), `widget=${JSON.stringify(widget)}`);
		assert.ok(widgetContent.some((line) => line.includes(`#${sid}`)), `widget=${JSON.stringify(widget)}`);
		assert.ok(widgetContent.some((line) => line.includes("set_on_exit") || line.includes("write_stdin")), `widget=${JSON.stringify(widget)}`);
		assert.ok(
			h.uiEvents.notifications.some((n) => n.type === "warning" && n.message.includes("still running after /tree")),
			`notifications=${JSON.stringify(h.uiEvents.notifications)}`,
		);

		await h.call("kill_session", { session_id: sid });
		assert.equal(h.uiEvents.statuses.get("unified-exec.sessions"), undefined);
		assert.equal(h.uiEvents.widgets.get("unified-exec.sessions")?.content, undefined);
		await h.emit("session_shutdown");
	});

	it("running-session footer clears automatically when a background process exits", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.4", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", `details=${JSON.stringify(r1.details)}`);
		assert.equal(h.uiEvents.statuses.get("unified-exec.sessions"), "unified-exec: 1 session running");

		// Poll, don't fixed-sleep: `sleep 0.4` can take >700ms wall time on a
		// loaded CI runner (observed on windows-latest).
		assert.ok(
			await waitFor(() => h.uiEvents.statuses.get("unified-exec.sessions") === undefined),
			`status did not clear: ${h.uiEvents.statuses.get("unified-exec.sessions")}`,
		);

		const r2 = await h.call("write_stdin", { session_id: sid, chars: "", yield_time_ms: 5000 });
		assert.equal(r2.details.exit_code, 0, `details=${JSON.stringify(r2.details)}`);
		assert.equal(r2.details.session_id, sid);
		assert.equal(r2.details.running, false);
		await h.emit("session_shutdown");
	});

	it("post-tree running-session widget clears automatically when the process exits", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.4", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", `details=${JSON.stringify(r1.details)}`);

		await h.emit("session_tree", { oldLeafId: "old", newLeafId: "new" });
		assert.ok(h.uiEvents.widgets.get("unified-exec.sessions")?.content?.[0].includes("1 session still running"));

		// Poll, don't fixed-sleep (slow CI runners).
		assert.ok(
			await waitFor(() => h.uiEvents.widgets.get("unified-exec.sessions")?.content === undefined),
			`widget did not clear: ${JSON.stringify(h.uiEvents.widgets.get("unified-exec.sessions"))}`,
		);

		const r2 = await h.call("write_stdin", { session_id: sid, chars: "", yield_time_ms: 5000 });
		assert.equal(r2.details.exit_code, 0, `details=${JSON.stringify(r2.details)}`);
		await h.emit("session_shutdown");
	});

	it("running-session UI decrements when one of multiple sessions exits", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const short = await h.call("exec_command", { cmd: "sleep 1.2", yield_time_ms: 250 });
		const long = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 250 });
		const shortSid = short.details.session_id;
		const longSid = long.details.session_id;
		assert.ok(typeof shortSid === "number", `short=${JSON.stringify(short.details)}`);
		assert.ok(typeof longSid === "number", `long=${JSON.stringify(long.details)}`);

		await h.emit("session_tree", { oldLeafId: "old", newLeafId: "new" });
		assert.equal(h.uiEvents.statuses.get("unified-exec.sessions"), "unified-exec: 2 sessions running");

		// Poll for the short session's exit instead of a fixed 1.1s sleep.
		assert.ok(
			await waitFor(() => h.uiEvents.statuses.get("unified-exec.sessions") === "unified-exec: 1 session running"),
			`status did not decrement: ${h.uiEvents.statuses.get("unified-exec.sessions")}`,
		);
		const widget = h.uiEvents.widgets.get("unified-exec.sessions")?.content?.join("\n") ?? "";
		assert.ok(widget.includes(`#${longSid}`), `widget=${widget}`);
		assert.ok(!widget.includes(`#${shortSid}`), `widget=${widget}`);

		const drained = await h.call("write_stdin", { session_id: shortSid, chars: "", yield_time_ms: 5000 });
		assert.equal(drained.details.exit_code, 0, `details=${JSON.stringify(drained.details)}`);
		await h.call("kill_session", { session_id: longSid });
		await h.emit("session_shutdown");
	});

	it("session_shutdown terminates all live sessions", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 200 });
		const r2 = await h.call("exec_command", { cmd: "sleep 11", yield_time_ms: 200 });
		assert.ok(r1.details.session_id);
		assert.ok(r2.details.session_id);
		await h.emit("session_shutdown");
		const l = await h.call("list_sessions", {});
		assert.equal(l.details.active_count, 0);
	});

	it("session_shutdown racing exec_command creation does not orphan the child", async () => {
		// Regression: exec_command inserts into the store only AFTER the
		// 150ms early-exit grace; a shutdown inside that window used to drain
		// the store without seeing the new session, leaving the process alive
		// and untracked.
		const h = makeHarness();
		await h.emit("session_start");
		const inflight = h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 500 });
		await new Promise((r) => setTimeout(r, 40)); // inside the grace window
		await h.emit("session_shutdown");
		const r = await inflight;
		// The pending session must have been terminated by the shutdown: the
		// call resolves with exit info (or a dead session), never a live one.
		if (r.details.session_id !== undefined) {
			await new Promise((res) => setTimeout(res, 1000)); // let the tree-kill land
			const l = await h.call("list_sessions", {});
			assert.ok(
				!l.details.sessions.some((s: any) => s.running),
				`orphaned live session: ${JSON.stringify(l.details)}`,
			);
		} else {
			assert.ok(r.details.exit_code != null || r.details.signal, JSON.stringify(r.details));
		}
	});

	it("exec_command is rejected after session_shutdown until the next session_start", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await h.emit("session_shutdown");
		await assert.rejects(() => h.call("exec_command", { cmd: "echo nope" }), /shutting down/);
		// A new session_start re-arms the extension (reload/new/resume).
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo back" });
		assert.equal(r.details.exit_code, 0);
		await h.emit("session_shutdown");
	});

	for (const reason of ["quit", "reload", "new", "resume", "fork"] as const) {
		it(`session_shutdown reason=${reason} terminates live sessions`, async () => {
			const h = makeHarness();
			await h.emit("session_start");
			const r = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 200 });
			assert.ok(r.details.session_id);
			await h.emit("session_shutdown", {
				type: "session_shutdown",
				reason,
				targetSessionFile: reason === "new" || reason === "resume" || reason === "fork" ? "/tmp/next.jsonl" : undefined,
			});
			const l = await h.call("list_sessions", {});
			assert.equal(l.details.active_count, 0);
		});
	}

	it("external abort breaks the yield but leaves session alive", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const ac = new AbortController();
		const promise = h.call(
			"exec_command",
			{ cmd: "sleep 10", yield_time_ms: 30_000 },
			ac.signal,
		);
		setTimeout(() => ac.abort(), 100);
		const t0 = Date.now();
		const r = await promise;
		const dt = Date.now() - t0;
		assert.ok(dt < 2000, `should have returned near abort time; dt=${dt}`);
		// Session should still be alive.
		assert.ok(typeof r.details.session_id === "number", `${JSON.stringify(r.details)}`);
		const sid = r.details.session_id;
		const list = await h.call("list_sessions", {});
		assert.ok(list.details.sessions.some((s: any) => s.session_id === sid));
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});

	it("unknown session_id throws", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await assert.rejects(
			() => h.call("write_stdin", { session_id: 9999, chars: "hi\n" }),
			/unknown session_id/,
		);
		await h.emit("session_shutdown");
	});

	it("kill_session on unknown id returns found: false", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("kill_session", { session_id: 9999 });
		assert.equal(r.details.found, false);
		await h.emit("session_shutdown");
	});

	it("retains cwd, command, and yield_time_ms in details", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo ok", yield_time_ms: 2000 });
		assert.equal(r.details.exit_code, 0);
		assert.equal(r.details.cwd, process.cwd());
		assert.equal(r.details.command, "echo ok");
		assert.equal(r.details.yield_time_ms, 2000);
		await h.emit("session_shutdown");
	});

	it("short output stays inline without a log file", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo hello" });
		assert.equal(r.details.exit_code, 0);
		assert.equal(r.details.tty, false);
		assert.equal(r.details.log, undefined);
		assert.match(r.details.output, /hello/);
		await h.emit("session_shutdown");
	});

	for (const { channel, input, hex } of [
		{ channel: "chars", input: { chars: "é\n\x1b\x03|\\x1b:wq\\n\\u001b\\x03\\\\" }, hex: "c3a90a1b037c1b3a77710a1b035c" },
		{ channel: "chars_b64", input: { chars_b64: "AP8bAwrDqQ==" }, hex: "00ff1b030ac3a9" },
	] as const) {
		it(`write_stdin sends the exact bytes for ${channel}`, async () => {
			const h = makeHarness();
			await h.emit("session_start");
			try {
				const started = await h.call("exec_command", {
					cmd: `node -e '
						const chunks = [];
						let size = 0;
						process.stdin.on("data", chunk => {
							chunks.push(chunk);
							size += chunk.length;
							if (size < ${hex.length / 2}) return;
							process.stdin.pause();
							process.stdout.write(Buffer.concat(chunks).toString("hex"), () => process.exit(0));
						});
					'`,
					yield_time_ms: 250,
				});
				const sid = started.details.session_id;
				assert.equal(typeof sid, "number");
				if (channel === "chars_b64") {
					await assert.rejects(h.call("write_stdin", { session_id: sid, chars: "hi", ...input }), /either `chars` or `chars_b64`/);
					await assert.rejects(h.call("write_stdin", { session_id: sid, chars_b64: "not@valid!" }), /not valid base64/);
				}
				const result = await h.call("write_stdin", { session_id: sid, ...input, yield_time_ms: 3000 });
				assert.equal(result.details.output, hex);
				assert.equal(result.details.exit_code, 0);
			} finally {
				await h.emit("session_shutdown");
			}
		});
	}

	it("archives the full stream when output crosses 512 bytes across tool calls", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const started = await h.call("exec_command", {
				cmd: `node -e 'process.stdout.write("a".repeat(511)); process.stdin.once("data", () => process.stdout.write("b", () => process.exit(0)));'`,
				yield_time_ms: 2000,
			});
			assert.equal(started.details.output, "a".repeat(511));
			assert.equal(started.details.log, undefined);
			const finished = await h.call("write_stdin", { session_id: started.details.session_id, chars: "go\n", yield_time_ms: 2000 });
			assert.equal(finished.details.exit_code, 0);
			assert.equal(finished.details.output, "b");
			assert.equal(finished.structuredContent?.details.session_id, started.details.session_id);
			assert.equal(finished.structuredContent?.details.running, false);
			const log = finished.details.log;
			assert.ok(Number.isSafeInteger(log) && log > 0);
			assert.equal(finished.structuredContent?.details.log, log);
			const path = join(".temp", "pi-unified-exec", `${log}.log`);
			assert.equal(readFileSync(path, "utf8"), "a".repeat(511) + "b");
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("output over 50 KiB is tail-truncated with marker; log file has full bytes", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// 4000 lines x ~55 bytes = ~210 KiB of output. Well over the 50 KiB cap.
		const r = await h.call("exec_command", {
			cmd: "for i in $(seq 1 4000); do echo \"line-number-${i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"; done",
			yield_time_ms: 10000,
		});
		assert.equal(r.details.exit_code, 0);

		// details.output is the truncated body only (no header/footer).
		const bytes = Buffer.byteLength(r.details.output, "utf8");
		assert.ok(bytes <= 60 * 1024, `LLM-visible output should be <=60KB; got ${bytes}`);
		assert.ok(bytes > 40 * 1024, `LLM-visible output should be close to 50KiB; got ${bytes}`);
		assert.equal(r.details.truncation.truncatedBy, "bytes");
		assert.equal(r.details.truncation.totalLines, 4000); // trailing \n does not count an empty line (pi >= 0.80)

		// The rendered text (what actually goes to the LLM) includes the marker.
		const rendered = r.content[0].text;
		assert.ok(rendered.includes("Showing lines"), `missing truncation marker in rendered text`);
		assert.ok(rendered.includes(`Full output: ${r.details.log}]`), "marker should reference the log number");

		// The reply has a bounded post-exit wait; a busy disk may still be
		// flushing the log. Check it once the final line reaches disk.
		const path = join(OUTPUT_LOG_DIRECTORY, `${r.details.log}.log`);
		let logContent = "";
		assert.ok(await waitFor(() => {
			logContent = readFileSync(path, "utf8");
			return /\nline-number-4000-x+\r?\n/.test(logContent);
		}), "the final line never reached the log");
		const logLines = logContent.split("\n").filter(Boolean);
		assert.equal(logLines.length, 4000);
		await h.emit("session_shutdown");
	});

	it("output over 2000 lines is line-truncated with marker", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// 2500 short lines, well under 50 KiB total → line-cap wins.
		const r = await h.call("exec_command", {
			cmd: "for i in $(seq 1 2500); do echo $i; done",
			yield_time_ms: 10000,
		});
		assert.equal(r.details.exit_code, 0);
		assert.ok(r.details.truncation, `expected truncation metadata`);
		assert.equal(r.details.truncation.truncatedBy, "lines");
		assert.equal(r.details.truncation.outputLines, 2000);
		assert.equal(r.details.truncation.totalLines, 2500); // trailing \n does not count an empty line (pi >= 0.80)
		// Marker lives in the rendered content text, not in details.output.
		assert.ok(r.content[0].text.includes("Showing lines"));
		await h.emit("session_shutdown");
	});

	it("list_sessions entries include log", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: 'printf "%0512d" 0; sleep 10', yield_time_ms: 200 });
		const l = await h.call("list_sessions", {});
		assert.equal(l.details.active_count, 1);
		const entry = l.details.sessions[0];
		assert.equal(entry.session_id, r1.details.session_id);
		assert.equal(entry.log, r1.details.log);
		assert.equal(l.structuredContent?.sessions[0].log, entry.log);
		assert.ok(existsSync(join(OUTPUT_LOG_DIRECTORY, `${entry.log}.log`)));
		await h.call("kill_session", { session_id: r1.details.session_id });
		await h.emit("session_shutdown");
	});

	it("kill_session omits the log for a silent session", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 200 });
		const sid = r1.details.session_id;
		const r2 = await h.call("kill_session", { session_id: sid });
		assert.equal(r2.details.log, r1.details.log);
		assert.equal(r2.details.log, undefined);
		await h.emit("session_shutdown");
	});

	it("nonexistent shell binary fails diagnosably", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		if (IS_WINDOWS) {
			// Fail-closed: resolution throws before spawn — a bare name must
			// never reach CreateProcess (cwd-first lookup could execute a
			// planted binary from an untrusted workdir).
			await assert.rejects(
				() => h.call("exec_command", { cmd: "echo hi", shell: "definitely-not-a-real-shell-xyz" }),
				/not found on PATH/,
			);
		} else {
			const r = await h.call("exec_command", { cmd: "echo hi", shell: "definitely-not-a-real-shell-xyz" });
			assert.equal(r.details.session_id, undefined, JSON.stringify(r.details));
			assert.ok(
				typeof r.details.failure_message === "string" && /ENOENT/.test(r.details.failure_message),
				`expected ENOENT failure_message; got ${JSON.stringify(r.details)}`,
			);
			assert.ok(r.content[0].text.includes("failure:"), r.content[0].text);
		}
		await h.emit("session_shutdown");
	});

	it("nonexistent workdir surfaces a failure_message", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo hi", workdir: "/definitely/not/a/real/dir" });
		assert.equal(r.details.session_id, undefined, JSON.stringify(r.details));
		assert.ok(
			typeof r.details.failure_message === "string" && /ENOENT/.test(r.details.failure_message),
			`expected ENOENT failure_message; got ${JSON.stringify(r.details)}`,
		);
		await h.emit("session_shutdown");
	});

	it("write_stdin to a child that closed stdin does not crash the host (EPIPE)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "exec 0<&-; sleep 3", yield_time_ms: 300 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		// First write hits EPIPE asynchronously; must be swallowed, not crash.
		const r2 = await h.call("write_stdin", { session_id: sid, chars: "hello\n", yield_time_ms: 300 });
		assert.equal(r2.details.session_id, sid);
		// By now the stdin stream is destroyed; a follow-up write should report
		// the failure instead of silently dropping the bytes.
		const r3 = r2.details.running
			? await h.call("write_stdin", { session_id: sid, chars: "again\n", yield_time_ms: 300 })
			: r2;
		if (r3.details.running) {
			// On Windows, writes to a pipe whose reader closed don't fail
			// deterministically (bytes can sit in the pipe buffer without an
			// error), so the failure note may legitimately never appear. The
			// core guarantee — the host doesn't crash — holds either way.
			if (!IS_WINDOWS) {
				assert.ok(
					typeof r3.details.failure_message === "string" && r3.details.failure_message.includes("stdin"),
					`expected stdin failure note; got ${JSON.stringify(r3.details)}`,
				);
			}
			await h.call("kill_session", { session_id: sid });
		}
		await h.emit("session_shutdown");
	});

	it("kill_session normalizes signal names (lowercase, no SIG prefix)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 60", yield_time_ms: 300 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const r2 = await h.call("kill_session", { session_id: sid, signal: "term" });
		assert.equal(r2.details.session_id, sid);
		assert.ok(r2.details.signal === "SIGTERM" || r2.details.exit_code != null, JSON.stringify(r2.details));
		await h.emit("session_shutdown");
	});

	it("kill_session rejects unknown signal names instead of silently no-opping", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await assert.rejects(() => h.call("kill_session", { session_id: 1, signal: "BOGUS" }), /unknown signal/);
		await h.emit("session_shutdown");
	});

	it("list_sessions reports just-exited sessions once with exit info, then removes them", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		await new Promise((r) => setTimeout(r, 600));

		const l1 = await h.call("list_sessions", {});
		assert.equal(l1.details.active_count, 0, JSON.stringify(l1.details));
		const entry = l1.details.sessions.find((s: any) => s.session_id === sid);
		assert.ok(entry, `exited session should be reported once: ${JSON.stringify(l1.details)}`);
		assert.equal(entry.running, false);
		assert.equal(entry.exit_code, 0);
		assert.ok(l1.content[0].text.includes("exited"), l1.content[0].text);

		const l2 = await h.call("list_sessions", {});
		assert.equal(l2.details.sessions.length, 0, JSON.stringify(l2.details));
		await h.emit("session_shutdown");
	});

	it("session_shutdown SIGKILLs children that trap SIGTERM", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "trap '' TERM; sleep 30", yield_time_ms: 300 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		const l = await h.call("list_sessions", {});
		const pid = l.details.sessions.find((s: any) => s.session_id === sid)?.pid;
		assert.ok(typeof pid === "number");

		await h.emit("session_shutdown");
		await new Promise((r) => setTimeout(r, 200));
		assert.throws(() => process.kill(pid, 0), /ESRCH/, `pid ${pid} should be dead after shutdown`);
	});

	it("onUpdate streams growing partial output while running", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const updates: any[] = [];
		const r = await h.call(
			"exec_command",
			{ cmd: "for i in 1 2 3 4; do echo beat-$i; sleep 0.25; done", yield_time_ms: 1500 },
			undefined,
			(partial: any) => updates.push(partial),
		);
		assert.ok(updates.length >= 2, `expected >=2 partial updates; got ${updates.length}`);
		const first = updates[0];
		const last = updates[updates.length - 1];
		assert.ok(typeof first.details.output === "string");
		assert.ok(last.details.output.length >= first.details.output.length, "output should grow");
		assert.ok(last.details.output.includes("beat-1"), last.details.output);
		assert.ok(
			updates.every((u) => typeof u.details.session_id === "number"),
			"partial updates should carry session_id",
		);
		if (r.details.session_id !== undefined) {
			await h.call("kill_session", { session_id: r.details.session_id });
		}
		await h.emit("session_shutdown");
	});

	it("/unified-exec-sessions command kills a selected session", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");

		h.uiEvents.selectResponses.push((options) => options.find((o) => o.startsWith(`#${sid} `)));
		await h.invokeCommand("unified-exec-sessions");

		const l = await h.call("list_sessions", {});
		assert.equal(l.details.active_count, 0, JSON.stringify(l.details));
		assert.ok(
			h.uiEvents.notifications.some((n) => n.message.includes("killed 1")),
			JSON.stringify(h.uiEvents.notifications),
		);
		await h.emit("session_shutdown");
	});

	it("/unified-exec-sessions command can kill all sessions", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		await h.call("exec_command", { cmd: "sleep 31", yield_time_ms: 250 });

		h.uiEvents.selectResponses.push((options) => options.find((o) => o.startsWith("Kill all")));
		await h.invokeCommand("unified-exec-sessions");

		const l = await h.call("list_sessions", {});
		assert.equal(l.details.active_count, 0, JSON.stringify(l.details));
		await h.emit("session_shutdown");
	});

	it("/unified-exec-sessions notifies when there is nothing to kill", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await h.invokeCommand("unified-exec-sessions");
		assert.ok(
			h.uiEvents.notifications.some((n) => n.message.includes("no live sessions")),
			JSON.stringify(h.uiEvents.notifications),
		);
		await h.emit("session_shutdown");
	});
});
