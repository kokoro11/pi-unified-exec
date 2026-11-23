/**
 * Integration tests for write_stdin waits and exec_command's
 * `on_exit: "wake"` through the real tool pipeline.
 *
 * Uses a stub ExtensionAPI that captures pi.sendMessage calls and can emit
 * tool_execution_end / agent_settled lifecycle events. Subprocess-based tests
 * are kept small and cross-platform (sleep/echo through the default shell).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { OUTPUT_LOG_DIRECTORY } from "../src/output-log.ts";
import { activateProcessTools } from "./fixtures/process-tools.ts";

interface ToolDef {
	name: string;
	execute: (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: any,
		ctx: any,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: any; structuredContent?: any }>;
}

function makeHarness() {
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	const sentMessages: Array<{ message: any; options: any }> = [];
	const uiEvents = {
		notifications: [] as Array<{ message: string; type?: string }>,
		selectResponses: [] as Array<(options: string[]) => string | undefined>,
		statuses: new Map<string, string | undefined>(),
	};

	const stubCtx = {
		cwd: process.cwd(),
		ui: {
			notify: (message: string, type?: string) => uiEvents.notifications.push({ message, type }),
			setStatus: (key: string, value: string | undefined) => uiEvents.statuses.set(key, value),
			setWidget: () => {},
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
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
	};

	activateProcessTools(pi as any);

	let nextCallId = 1;
	let shutDown = false;
	const harness = {
		/** Call a tool with a fresh toolCallId; returns { result, toolCallId }. */
		async call(toolName: string, params: any, signal?: AbortSignal, onUpdate?: (partial: any) => void) {
			const def = tools[toolName];
			if (!def) throw new Error(`no such tool: ${toolName}`);
			const toolCallId = `call-${nextCallId++}`;
			const result = await def.execute(toolCallId, params, signal, onUpdate, stubCtx);
			return { ...result, toolCallId };
		},
		async invokeCommand(name: string, args = "") {
			return commands[name].handler(args, stubCtx);
		},
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
			if (event === "session_shutdown") shutDown = true;
		},
		/** Simulate pi finalizing a tool result. */
		async finalizeTool(toolCallId: string, isError = false) {
			await this.emit("tool_execution_end", { type: "tool_execution_end", toolCallId, toolName: "", result: {}, isError });
		},
		async shutdown() {
			if (shutDown) return;
			shutDown = true;
			try {
				await this.emit("session_shutdown");
			} catch {
				// best-effort cleanup
			}
		},
		sentMessages,
		uiEvents,
	};
	liveHarnesses.add(harness);
	return harness;
}

const liveHarnesses = new Set<{ shutdown: () => Promise<void> }>();

afterEach(async () => {
	const hs = [...liveHarnesses];
	liveHarnesses.clear();
	for (const h of hs) await h.shutdown();
});

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await cond()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return !!(await cond());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assertOnExit(result: Awaited<ReturnType<ToolDef["execute"]>>, expected?: "none" | "wake" | "consumed"): void {
	const scriptDetails = result.structuredContent.details ?? result.structuredContent;
	for (const details of [result.details, scriptDetails]) {
		assert.equal(Object.hasOwn(details, "on_exit"), expected !== undefined);
		assert.equal(details.on_exit, expected);
		assert.equal(Object.hasOwn(details, "completion_notification"), false);
		assert.equal(Object.hasOwn(details, "on_exit_wake"), false);
	}
	const text = result.content[0].text;
	if (expected) assert.match(text, new RegExp(`^on_exit: ${expected}$`, "m"));
	else assert.doesNotMatch(text, /^on_exit:/m);
	assert.doesNotMatch(text, /^(?:completion_notification|on_exit_wake):/m);
}

describe("write_stdin attached waits", () => {
	it("retains only bounded output during a long noisy wait", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", {
			cmd: `sleep 0.6; node -e 'let n=0; const t=setInterval(()=>{process.stdout.write("x".repeat(65536)+"\\n"); if(++n===48){clearInterval(t); console.log("noisy-done");}},10)'`,
			yield_time_ms: 250,
		});
		assert.equal(typeof r1.details.session_id, "number");
		const updates: any[] = [];
		const r2 = await h.call("write_stdin", {
			session_id: r1.details.session_id,
			yield_time_ms: 3 * 2_147_483_647,
		}, undefined, (p) => updates.push(p));
		assert.equal(r2.details.exit_code, 0);
		assert.equal(Object.hasOwn(r2.details, "wait_status"), false);
		assert.equal(Object.hasOwn(r2.structuredContent.details, "wait_status"), false);
		assert.ok(r2.details.omitted_bytes > 1024 * 1024, "must retain head/tail, not accumulate every drained chunk");
		assert.ok(Buffer.byteLength(r2.details.output) <= 50 * 1024);
		assert.match(r2.details.output, /noisy-done/);
		assert.ok(readFileSync(join(OUTPUT_LOG_DIRECTORY, `${r2.details.log}.log`)).length > 3 * 1024 * 1024);
		assert.ok(updates.length <= 3, `long waits must not heartbeat: ${updates.length} updates`);
		assert.ok(updates.every(p => Buffer.byteLength(p.details.output) <= 32 * 1024));
	});

	it("wait cancellation preserves buffered output and the live process", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", {
			cmd: 'sleep 0.4; printf "%0512d\\n" 0; sleep 0.6; echo cancel-marker; sleep 30',
			yield_time_ms: 250,
		});
		const ac = new AbortController();
		const wait = h.call("write_stdin", {
			session_id: r1.details.session_id, yield_time_ms: Number.MAX_SAFE_INTEGER,
		}, ac.signal);
		try {
			assert.ok(await waitFor(async () => {
				// Output can begin after the first yield; listing metadata leaves the wait's buffer intact.
				const listed = await h.call("list_sessions", {});
				const log = listed.details.sessions.find((s: any) => s.session_id === r1.details.session_id)?.log;
				return typeof log === "number" &&
					readFileSync(join(OUTPUT_LOG_DIRECTORY, `${log}.log`), "utf8").includes("cancel-marker");
			}));
		} finally {
			ac.abort();
		}
		const r2 = await wait;
		assert.match(r2.details.wait_status, /^Follow the user's latest instruction before polling this session again\./);
		assert.match(r2.content[0].text, /^wait_status: Follow the user's latest instruction before polling this session again\./m);
		assert.equal(r2.details.running, true);
		assert.equal(r2.details.output, "");
		const killed = await h.call("kill_session", { session_id: r1.details.session_id });
		assert.equal(killed.details.status, "killed");
		assert.match(killed.details.output, /cancel-marker/);
	});

	it("returns running at the deadline and sends exactly one wake after the later exit", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 6.2", yield_time_ms: 250, on_exit: "wake" });
		const updateStates: unknown[] = [];
		const r2 = await h.call("write_stdin", { session_id: r1.details.session_id }, undefined, (update) => {
			updateStates.push(update.details.on_exit);
		});
		assert.equal(r2.details.yield_time_ms, 5000);
		assert.equal(Object.hasOwn(r2.details, "wait_status"), false);
		assert.equal(Object.hasOwn(r2.structuredContent.details, "wait_status"), false);
		assert.equal(r2.details.running, true);
		assertOnExit(r2, "wake");
		assert.ok(updateStates.length > 0);
		assert.ok(updateStates.every((state) => state === "wake"));
		assert.ok(r2.details.effective_wait_ms >= 4900);
		assert.equal(h.sentMessages.length, 0);
		await h.finalizeTool(r2.toolCallId, false);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "wake after later exit");
		await sleep(600);
		assert.equal(h.sentMessages.length, 1, "exactly one wake");
		const r3 = await h.call("write_stdin", { session_id: r1.details.session_id });
		assert.equal(r3.details.exit_code, 0);
	});
});

describe("exec_command on_exit", () => {
	it("omitted or explicit 'none' preserves current behavior (no wake)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250 });
		const r2 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "none" });
		assert.ok(typeof r1.details.session_id === "number");
		assert.ok(typeof r2.details.session_id === "number");
		assertOnExit(r1);
		assertOnExit(r2);
		await new Promise((r) => setTimeout(r, 1200)); // both exit + debounce window
		assert.equal(h.sentMessages.length, 0);
		// Drain them.
		assertOnExit(await h.call("write_stdin", { session_id: r1.details.session_id, yield_time_ms: 5000 }));
		assertOnExit(await h.call("write_stdin", { session_id: r2.details.session_id, yield_time_ms: 5000 }));
		await h.emit("session_shutdown");
	});

	it("wake process exiting inside the initial exec_command yield gives a direct result, no wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo quick", yield_time_ms: 5000, on_exit: "wake" });
		assert.equal(r.details.exit_code, 0);
		assert.equal(r.details.session_id, undefined);
		assertOnExit(r, "consumed");
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 0);
		await h.emit("session_shutdown");
	});

	it("backgrounded wake session exiting while idle sends exactly one follow-up prompt", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Output ("BYE") deliberately differs from the command text ("bye") so we
		// can assert the wake carries command metadata but never raw stdout.
		const r1 = await h.call("exec_command", {
			cmd: "sleep 0.4 && echo bye | tr a-z A-Z",
			yield_time_ms: 250,
			on_exit: "wake",
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		assertOnExit(r1, "wake");

		assert.ok(await waitFor(() => h.sentMessages.length === 1), "expected one wake");
		const { message, options } = h.sentMessages[0];
		assert.equal(message.customType, "unified-exec-completed");
		assert.equal(message.display, true);
		assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
		assert.match(message.content, new RegExp(`session_id=${sid}`));
		assert.match(message.content, /exit_code=0/);
		assert.ok(!message.content.includes("BYE"), "wake must not contain raw stdout");

		// A new wake request after delivery still collects the final output.
		const r2 = await h.call("write_stdin", { session_id: sid, on_exit: "wake" });
		assert.equal(r2.details.exit_code, 0);
		assert.match(r2.details.output, /BYE/);
		assert.match(r2.content[0].text, /\n---\nBYE\n/);
		assert.equal(r2.structuredContent.details.output, r2.details.output);
		assert.equal(r2.details.note, "Session already exited. No new wake was armed.");
		assertOnExit(r2, "consumed");
		await h.finalizeTool(r2.toolCallId, false);
		// …and consuming it does not send another wake.
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 1);
		await h.emit("session_shutdown");
	});

	it("exit during a relative write_stdin observer is delivered directly, no wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.5", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		const r2 = await h.call("write_stdin", { session_id: sid, on_exit: "wake", yield_time_ms: 900_000 });
		assert.equal(r2.details.exit_code, 0);
		assert.equal(r2.details.completion_delivery, "direct");
		assertOnExit(r2, "consumed");
		await h.finalizeTool(r2.toolCallId, false);
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 0);
		await h.emit("session_shutdown");
	});

	it("cancelled wait keeps the wake armed; later exit sends exactly one wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 1.2", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const ac = new AbortController();
		const inflight = h.call("write_stdin", { session_id: sid, yield_time_ms: 60_000 }, ac.signal);
		setTimeout(() => ac.abort(), 150);
		const r2 = await inflight;
		assert.match(r2.details.wait_status, /^Follow the user's latest instruction before polling this session again\./);
		assertOnExit(r2, "wake");
		await h.finalizeTool(r2.toolCallId, true); // pi records the cancelled call as error
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "wake after later exit");
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 1);
		await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 }).catch(() => {});
		await h.emit("session_shutdown");
	});

	it("a terminal result finalized as error keeps the completion wake-eligible", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.4", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const r2 = await h.call("write_stdin", { session_id: sid, yield_time_ms: 10_000 });
		assert.equal(r2.details.exit_code, 0);
		// Pi finalizes the constructed result as an error → wake must fire.
		await h.finalizeTool(r2.toolCallId, true);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "wake despite constructed result");
		await h.emit("session_shutdown");
	});

	it("write_stdin disarms a wake and drains available output without waiting for exit", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", {
			cmd: "sleep 0.8; echo buffered; read -r line; echo finished; exit 1",
			yield_time_ms: 250,
			on_exit: "wake",
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const r2 = await h.call("write_stdin", { session_id: sid, on_exit: "none" });
		assert.equal(r2.details.running, true);
		assertOnExit(r2, "none");
		let drained = r2;
		assert.ok(await waitFor(async () => {
			if (drained.details.output.includes("buffered")) return true;
			drained = await h.call("write_stdin", { session_id: sid, on_exit: "none" });
			return drained.details.output.includes("buffered");
		}), "expected buffered output while the child waited for input");
		assert.equal(drained.details.running, true);
		assert.equal(drained.details.yield_time_ms, undefined);
		assertOnExit(drained, "none");
		assert.match(drained.content[0].text, /\n---\nbuffered\n/);
		assert.equal(drained.structuredContent.details.output, drained.details.output);

		const unchanged = await h.call("write_stdin", { session_id: sid, on_exit: "none" });
		assert.equal(unchanged.details.output, "");
		assertOnExit(unchanged, "none");
		const finished = await h.call("write_stdin", { session_id: sid, chars: "done\\n", yield_time_ms: 5000 });
		assertOnExit(finished);
		assert.equal(finished.details.exit_code, 1);
		assert.match(finished.details.output, /finished/);
		await sleep(400);
		assert.equal(h.sentMessages.length, 0, "disarmed wake must not fire");
	});

	for (const initialPolicy of ["none", "wake"] as const) {
		it(`write_stdin collects an already-exited session started with on_exit: ${initialPolicy}`, async () => {
			const h = makeHarness();
			await h.emit("session_start");
			const started = await h.call("exec_command", {
				cmd: "sleep 0.6; echo finished-before-wake; exit 7",
				yield_time_ms: 250,
				on_exit: initialPolicy,
			});
			const sid = started.details.session_id;
			assert.equal(typeof sid, "number");
			assert.ok(await waitFor(() => h.uiEvents.statuses.get("unified-exec.sessions") === undefined));
			assert.equal(h.sentMessages.length, 0, "collect before a pending wake is delivered");

			const result = await h.call("write_stdin", { session_id: sid, on_exit: "wake" });
			assert.equal(result.details.running, false);
			assert.equal(result.details.exit_code, 7);
			assertOnExit(result, initialPolicy === "wake" ? "consumed" : "none");
			assert.match(result.content[0].text, new RegExp(`^\\[exited #${sid} error 7\\]`));
			if (initialPolicy === "wake") assert.equal(result.details.note, undefined);
			else assert.match(result.content[0].text, /^note: Session already exited\. No new wake was armed\.$/m);
			assert.match(result.content[0].text, /\n---\nfinished-before-wake\n/);
			assert.equal(result.structuredContent.details.output, result.details.output);
			await h.finalizeTool(result.toolCallId, false);
			await sleep(400);
			assert.equal(h.sentMessages.length, 0);
			await assert.rejects(h.call("write_stdin", { session_id: sid, on_exit: "wake" }), /unknown session_id/);
		});
	}

	it("write_stdin arms a session without waiting for it to exit", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", {
			cmd: "sleep 0.5; exit 0",
			yield_time_ms: 250,
			on_exit: "none",
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const r2 = await h.call("write_stdin", { session_id: sid, on_exit: "wake" });
		assert.equal(r2.details.running, true);
		assertOnExit(r2, "wake");
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "armed session should wake");
		await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 }).catch(() => {});
	});

	it("write_stdin applies a new policy before writing input", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const started = await h.call("exec_command", {
			cmd: "read -r line; printf 'received: %s\\n' \"$line\"",
			yield_time_ms: 250,
			on_exit: "wake",
		});
		const result = await h.call("write_stdin", {
			session_id: started.details.session_id,
			on_exit: "none",
			chars: "hello\\n",
			yield_time_ms: 5000,
		});
		assert.equal(result.details.exit_code, 0);
		assert.match(result.details.output, /received: hello/);
		assertOnExit(result, "none");
		await h.finalizeTool(result.toolCallId);
		assert.equal(h.sentMessages.length, 0);
	});

	it("list_sessions reports a live wake and consumes it when listing the exit", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 1", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const l = await h.call("list_sessions", {});
		assert.equal(l.details.sessions[0].session_id, sid);
		assert.equal(l.details.sessions[0].wake_armed, true);
		assert.equal(l.details.sessions[0].on_exit, "wake");
		assert.equal(l.structuredContent.sessions[0].on_exit, "wake");
		assert.match(l.content[0].text, /^\s+on_exit: wake$/m);

		assert.ok(await waitFor(async () => {
			const exited = await h.call("list_sessions", {});
			if (exited.details.just_exited_count === 0) return false;
			assert.equal(exited.details.sessions[0].on_exit, "consumed");
			assert.equal(exited.structuredContent.sessions[0].on_exit, "consumed");
			assert.match(exited.content[0].text, /^\s+on_exit: consumed$/m);
			return true;
		}));
		await sleep(400);
		assert.equal(h.sentMessages.length, 0);
	});

	it("explicit model kill suppresses the wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const killed = await h.call("kill_session", { session_id: sid });
		assertOnExit(killed, "consumed");
		assert.ok(!(await waitFor(() => h.sentMessages.length > 0, 600)));
		assert.equal(h.sentMessages.length, 0);
	});

	it("human slash-command kill suppresses the wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		h.uiEvents.selectResponses.push((options) => options.find((o) => o.startsWith(`#${sid} `)));
		await h.invokeCommand("unified-exec-sessions");
		assert.ok(!(await waitFor(() => h.sentMessages.length > 0, 600)));
		assert.equal(h.sentMessages.length, 0);
	});

	it("session_shutdown cancels pending wakes (no stale prompt)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "wake" });
		assert.ok(typeof r1.details.session_id === "number");
		// Shut down before the process exits / the debounce fires.
		await h.emit("session_shutdown");
		assert.ok(!(await waitFor(() => h.sentMessages.length > 0, 800)));
		assert.equal(h.sentMessages.length, 0);
	});

	it("agent_settled flushes a wake whose send previously failed", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Make the first send throw.
		const originalPush = h.sentMessages.push.bind(h.sentMessages);
		let failures = 1;
		(h.sentMessages as any).push = (...args: any[]) => {
			if (failures > 0) {
				failures--;
				throw new Error("synthetic send failure");
			}
			return originalPush(...args);
		};
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "wake" });
		assert.ok(typeof r1.details.session_id === "number");
		assert.ok(await waitFor(() => failures === 0), "the first wake send should have failed");
		assert.equal(h.sentMessages.length, 0);
		await h.emit("agent_settled");
		assert.equal(h.sentMessages.length, 1, "retry at agent_settled");
		await h.call("write_stdin", { session_id: r1.details.session_id, yield_time_ms: 5000 });
	});
});
