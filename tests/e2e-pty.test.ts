/**
 * PTY-mode end-to-end tests. Require node-pty-prebuilt-multiarch to be loaded.
 * Skipped when PTY is unavailable.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "bun:test";
import { isPtyAvailable, spawnChild } from "../src/pty.ts";
import { IS_WINDOWS } from "../src/shell.ts";
import { activateProcessTools } from "./fixtures/process-tools.ts";

function makeHarness() {
	const tools: Record<string, any> = {};
	const handlers: Record<string, any[]> = {};
	const stubCtx = {
		cwd: process.cwd(),
		ui: { notify: () => {}, setStatus: () => {} },
		hasUI: false,
	};
	const pi = {
		registerTool: (def: any) => { tools[def.name] = def; },
		on: (event: string, h: any) => { (handlers[event] ??= []).push(h); },
		registerCommand: () => {}, registerShortcut: () => {}, registerFlag: () => {},
		registerMessageRenderer: () => {},
		getFlag: () => false,
		getActiveTools: () => ["bash"],
		setActiveTools: () => {},
	};
	activateProcessTools(pi as any);
	return {
		async call(toolName: string, params: any, signal?: AbortSignal) {
			return tools[toolName].execute("id", params, signal, undefined, stubCtx);
		},
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
		},
	};
}

describe.skipIf(!isPtyAvailable())("unified-exec PTY mode", () => {
	// NOTE: every test runs its body in try/finally with session_shutdown in
	// the finally. A failed assertion mid-test must not leak a live PTY
	// session: on Windows, ConPTY's conout worker keeps the event loop alive
	// until the session exits, so a leaked session hangs the test process
	// forever (observed on windows-latest CI).

	it("tty: true runs a command with a PTY", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const r = await h.call("exec_command", {
				cmd: "tty && echo seen=$TERM",
				tty: true,
				yield_time_ms: 1500,
			});
			// If short-lived: exit_code is set; long-running: session_id. Either way output should
			// include "tty" / "dev/" to confirm a PTY was allocated.
			assert.ok(r.details.output.toLowerCase().includes("/dev/"), `output=${r.details.output}`);
			if (r.details.session_id !== undefined) {
				await h.call("kill_session", { session_id: r.details.session_id });
			}
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("write_stdin round-trips input through a Node line-echo fixture", async () => {
		// Repo-owned fixture (no python dependency): a Node child that echoes
		// each stdin line as GOT:<line>| and exits 7 on "quit". This asserts
		// MANDATORY PTY input behavior on every platform — a no-op
		// write-to-pty implementation cannot pass this test.
		const fixture =
			"node -e 'let b=\"\";process.stdin.on(\"data\",d=>{b+=d.toString();let i;while((i=b.search(/[\\r\\n]/))>=0){const line=b.slice(0,i).trim();b=b.slice(i+1);if(line){process.stdout.write(\"GOT:\"+line+\"|\\n\");if(line===\"quit\")process.exit(7);}}})'";
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const r1 = await h.call("exec_command", { cmd: fixture, tty: true, yield_time_ms: 250 });
			const sid = r1.details.session_id;
			assert.equal(typeof sid, "number", `fixture did not stay alive: ${JSON.stringify(r1.details)}`);

			const r2 = await h.call("write_stdin", { session_id: sid, chars: "hello\r", yield_time_ms: 1500 });
			let output = r2.details.output as string;
			for (let i = 0; i < 2 && !output.includes("GOT:hello|"); i++) {
				const poll = await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 });
				output += poll.details.output;
				if (!poll.details.running) break;
			}
			assert.ok(output.includes("GOT:hello|"), `PTY input did not round-trip: ${JSON.stringify(output)}`);

			const listed = await h.call("list_sessions", {});
			const live = listed.details.sessions.find((session: { session_id: number }) => session.session_id === sid);
			assert.ok(live?.pid > 0, `connected PTY has no process ID: ${JSON.stringify(live)}`);

			const r3 = await h.call("write_stdin", { session_id: sid, chars: "quit\r", yield_time_ms: 3000 });
			const finished = r3.details.running ? await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 }) : r3;
			assert.equal(finished.details.exit_code, 7, `fixture did not exit on quit: ${JSON.stringify(finished.details)}`);
			assert.equal(finished.details.session_id, sid);
			assert.ok(finished.content[0].text.startsWith(`[exited #${sid} error 7]\n`));
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it.skipIf(!IS_WINDOWS)("Windows: shell=cmd with tty:true works (verbatim /c payload)", async () => {
		// Regression: node-pty's argsToCommandLine re-escapes embedded quotes,
		// so array-args mangled the pre-quoted /s /c payload into
		// `\"echo ...\"` — guaranteed "not recognized" failure. The PTY path
		// must pass the args as a raw command-line string instead.
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const r = await h.call("exec_command", {
				cmd: "echo tty-one& echo tty-two",
				shell: "cmd",
				tty: true,
				yield_time_ms: 20000,
			});
			assert.equal(r.details.exit_code, 0, JSON.stringify(r.details));
			assert.ok(r.details.output.includes("tty-one"), `output=${r.details.output}`);
			assert.ok(r.details.output.includes("tty-two"), `output=${r.details.output}`);
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it.skipIf(!IS_WINDOWS)("Windows: kill_session terminates a PTY shell AND-list", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const started = await h.call("exec_command", {
				cmd: "sleep 8 && echo tail",
				tty: true,
				yield_time_ms: 1500,
			});
			const killed = await h.call("kill_session", { session_id: started.details.session_id });
			assert.equal(killed.details.status, "killed", JSON.stringify(killed.details));
			assert.equal(killed.details.running, false);
			assert.equal((await h.call("list_sessions", {})).details.active_count, 0);
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it.skipIf(!IS_WINDOWS)("Windows: PTY Ctrl-C reaches the command without terminating its launcher", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const started = await h.call("exec_command", {
				cmd: 'node -e \'process.on("SIGINT",()=>console.log("interrupt-handled")); console.log("interrupt-ready"); setInterval(()=>{},1000)\'',
				tty: true,
				yield_time_ms: 1500,
			});
			assert.match(started.details.output, /interrupt-ready/);
			const interrupted = await h.call("write_stdin", {
				session_id: started.details.session_id,
				chars: "\x03",
				yield_time_ms: 1500,
			});
			assert.match(interrupted.details.output, /interrupt-handled/);
			assert.equal(interrupted.details.running, true, JSON.stringify(interrupted.details));
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it.skipIf(!IS_WINDOWS)("Windows: a kill requested before ConPTY connects terminates the process", async () => {
		const child = spawnChild({
			command: ["node", "-e", "setTimeout(() => {}, 3000)"],
			cwd: process.cwd(),
			env: process.env,
			tty: true,
		});
		const exited = new Promise<number | null>((resolve) => child.onExit(resolve));
		child.kill();
		assert.equal(await exited, 1);
	}, 10_000);

});
