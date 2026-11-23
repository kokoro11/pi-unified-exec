/**
 * unified-exec — pi extension that ports codex's unified_exec session model,
 * with pi's built-in `bash` tool's on-disk retention layered on top.
 *
 * Tools exposed to the LLM:
 *   - exec_command(cmd, workdir?, shell?, tty?, yield_time_ms?, on_exit?)
 *   - write_stdin(session_id, chars?, chars_hex?, yield_time_ms?, on_exit?)
 *   - kill_session(session_id, signal?)          [pi-flavor; codex has no equivalent]
 *   - list_sessions()                            [pi-flavor]
 *
 * Semantics:
 *   - Every exec_command starts a long-lived session. If the process is still
 *     alive when the call's yield deadline expires, the tool returns with
 *     `[running #N]` and the LLM can follow up with write_stdin.
 *   - `write_stdin` can poll, write bytes, or change the wake policy.
 *   - Aborting the tool call (Esc) breaks the wait but does not kill the
 *     session; the next turn can still drive it.
 *   - Sessions are terminated on session_shutdown (codex parity).
 *   - Once a session produces 512 bytes, its complete output is archived in
 *     the starting directory's .temp/pi-unified-exec/ folder. The LLM sees
 *     the last ~50 KiB / 2000 lines per call and a log number for recovery.
 */

import { constants as osConstants } from "node:os";
import { type AgentToolResult, type AgentToolUpdateCallback, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "typebox";

import type { CollectResult } from "./collect.ts";
import { registerCompactCodemode } from "./codemode-render.ts";
import { CompletionCoordinator, type OnExitPolicy, type OnExitStatus } from "./completion.ts";
import { type LongWaitOutcome, startRateLimitedStream, waitForExitOrDeadline } from "./long-wait.ts";
import { OUTPUT_LOG_PATH_TEMPLATE } from "./output-log.ts";
import { sanitizeOutputText } from "./output-safety.ts";
import { getPtyLoadError, isPtyAvailable } from "./pty.ts";
import {
	renderExecCommandCall,
	renderKillSessionCall,
	renderKillSessionResult,
	renderListSessionsCall,
	renderListSessionsResult,
	renderProcessResult,
	renderWriteStdinCall,
} from "./render.ts";
import {
	execCommandScriptResult,
	execCommandScriptResultSchema,
	killNotFoundScriptResult,
	killScriptResult,
	killScriptResultSchema,
	listSessionsScriptResult,
	listSessionsScriptResultSchema,
	writeStdinScriptResult,
	writeStdinScriptResultSchema,
} from "./script-result.ts";
import { ExecSession } from "./session.ts";
import { SessionStore } from "./session-store.ts";
import { SessionUi, formatSessionCount } from "./session-ui.ts";
import {
	isNestedToolCall,
	type PendingProbe,
	STEER_NESTED_ERROR,
	SteerGate,
	steerInterruptEnabled,
} from "./steer-gate.ts";
import { buildShellCommand, IS_WINDOWS, resolveDefaultShell, resolveWindowsShell } from "./shell.ts";
import { DEFAULT_INPUT_YIELD_MS, DEFAULT_YIELD_MS, MAX_YIELD_ENV_VAR, resolveYieldTimeMs } from "./time.ts";
export { MAX_YIELD_ENV_VAR, resolveMaxYieldMs } from "./time.ts";
import {
	finalizeKillResult,
	finalizeProcessResult,
	finalizeSessionResult,
	type ProcessResultDetails,
	type ProcessResultMetadata,
	WAIT_CANCELLED,
	WAIT_STEERED,
} from "./tool-result.ts";
import { hexByteLength, unescapeChars } from "./unescape.ts";

// ---------------- Constants (mirror codex) ----------------

const EARLY_EXIT_GRACE_PERIOD_MS = 150;
const MAX_SESSIONS = 64;
const WARNING_SESSIONS = 60;
const LRU_PROTECTED_COUNT = 8;
const OUTPUT_POLL_INTERVAL_MS = 250;
// PTY dimension clamps for exec_command's cols/rows (tty: true only).
const MIN_PTY_COLS = 20;
const MAX_PTY_COLS = 500;
const MIN_PTY_ROWS = 5;
const MAX_PTY_ROWS = 300;
// Long waits keep output in the session buffer and use output-driven updates.
const LONG_WAIT_THRESHOLD_MS = 30_000;
const LONG_WAIT_UPDATE_INTERVAL_MS = 30_000;
const YIELD_DESCRIPTION = `Minimum 0 (return without waiting), no built-in maximum. ${MAX_YIELD_ENV_VAR} clamps longer waits to the configured cap.`;

/**
 * Google-compatible string enum schema (plain `type: "string"` + `enum`,
 * mirroring pi-ai's StringEnum helper) — a TypeBox literal union (anyOf/const)
 * breaks Google models.
 */
function StringEnum<T extends readonly string[]>(values: T, description: string): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({ type: "string", enum: values as unknown as string[], description });
}

// ---------------- Helpers ----------------

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

/**
 * Normalize a user/LLM-supplied signal name ("TERM", "sigint", "SIGKILL") to
 * a valid NodeJS.Signals for the current platform. Throws on unknown names so
 * a typo doesn't silently no-op and then escalate to SIGKILL.
 */
function normalizeSignal(raw: string | undefined): NodeJS.Signals {
	if (!raw) return "SIGTERM";
	let name = raw.trim().toUpperCase();
	if (!name.startsWith("SIG")) name = `SIG${name}`;
	if (!(name in osConstants.signals)) {
		throw new Error(`unknown signal "${raw}" (use SIGTERM, SIGINT, SIGKILL, …)`);
	}
	return name as NodeJS.Signals;
}

const textDecoder = new TextDecoder("utf-8", { fatal: false });
const textEncoder = new TextEncoder();

type ProcessUpdateDetails = Partial<ProcessResultDetails> & { pid?: number; total_bytes?: number };

function sessionToolResult<Details, Structured extends { text: string }>(
	store: SessionStore,
	details: Details & { note?: string },
	format: (details: Details & { note?: string }) => Structured,
) {
	const reminder = store.takeExitReminder();
	if (reminder) details.note = details.note ? `${reminder}. ${details.note}` : reminder;
	const structuredContent = format(details);
	return {
		content: [{ type: "text" as const, text: structuredContent.text }],
		details,
		structuredContent,
	};
}

// ---------------- Extension ----------------

interface ExtensionCtx {
	store: SessionStore;
	/** Agent-level wake scheduling for on_exit: "wake" (see completion.ts). */
	coordinator: CompletionCoordinator;
	sessionUi: SessionUi;
	warnedShellFallback: boolean;
	notifiedBashSource: boolean;
	/**
	 * Sessions spawned but not yet inserted into the store (inside the
	 * early-exit grace window). session_shutdown must see these too —
	 * otherwise a shutdown racing exec_command orphans the child.
	 */
	pendingSessions: Set<ExecSession>;
	/** Set on session_shutdown; new exec_commands are rejected. */
	shuttingDown: boolean;
	/** Ends attached waits early while a human steer is queued (steer-gate.ts). */
	steer: SteerGate;
}

type ExecCommandArgs = {
	cmd: string;
	workdir?: string;
	shell?: string;
	tty?: boolean;
	cols?: number;
	rows?: number;
	yield_time_ms?: number;
	on_exit?: OnExitPolicy;
};

type WriteStdinArgs = {
	session_id: number;
	chars?: string;
	chars_hex?: string;
	yield_time_ms?: number;
	on_exit?: OnExitPolicy;
};

function resolveWriteInput({ chars, chars_hex }: WriteStdinArgs): Uint8Array | undefined {
	if (chars && chars_hex) {
		throw new Error("write_stdin: pass either `chars` or `chars_hex`, not both.");
	}
	if (chars_hex) {
		const hex = chars_hex.replace(/\s+/g, "");
		if (!hex) return undefined;
		// Buffer.from silently stops at an invalid digit or incomplete byte.
		if (hexByteLength(hex) === undefined) {
			throw new Error("write_stdin: `chars_hex` must contain two hex digits (0-9, A-F) per byte after removing whitespace.");
		}
		return Buffer.from(hex, "hex");
	}
	return chars ? textEncoder.encode(unescapeChars(chars)) : undefined;
}

const HELD_OPEN_NOTE =
	"shell has exited, but background process(es) still hold the output pipe " +
	"(inherited stdout/stderr, or a backgrounded `cd … && cmd &` chain whose subshell is still waiting), " +
	"so this session stays open until they exit. To detach: redirect inside the job — " +
	"`(cd dir && cmd >log 2>&1 </dev/null) &` or `setsid cmd >log 2>&1 </dev/null &` — " +
	"or end the session with kill_session.";

/**
 * Explanation for sessions whose shell has exited but whose output pipe is
 * still held open by background processes: they report "running" even though
 * the foreground command is long done. State-driven (never command-text
 * matching), so it covers any construct that leaves a pipe holder behind.
 */
function heldOpenNote(session: ExecSession): string | undefined {
	return session.shellExited && !session.hasExited ? HELD_OPEN_NOTE : undefined;
}

async function runExecCommand(
	ctx: ExtensionCtx,
	args: ExecCommandArgs,
	signal: AbortSignal | undefined,
	steerSignal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	cwd: string,
): Promise<ProcessResultDetails> {
	if (ctx.shuttingDown) {
		throw new Error("unified-exec: session is shutting down; not starting new commands.");
	}
	const yieldTimeMs = resolveYieldTimeMs("exec_command", args.yield_time_ms);
	const tty = args.tty ?? false;
	if (tty && !isPtyAvailable()) {
		throw new Error(
			`tty: true requires @homebridge/node-pty-prebuilt-multiarch but it failed to load: ${getPtyLoadError() ?? "unknown"}.\n` +
				`Run:  cd .pi/extensions/unified-exec && npm install\n` +
				`Or call with tty: false (default).`,
		);
	}

	let shellBin = args.shell;
	if (!shellBin) {
		const resolved = resolveDefaultShell();
		shellBin = resolved.shell;
		if (resolved.fellBack && !ctx.warnedShellFallback) {
			ctx.warnedShellFallback = true;
			ctx.sessionUi.ui?.notify(
				"unified-exec: no bash found (PATH, git-derived, or known install roots); falling back to powershell. Install Git Bash or set PI_UNIFIED_EXEC_BASH.",
				"warning",
			);
		} else if (
			!resolved.fellBack &&
			resolved.bashSource &&
			resolved.bashSource !== "path" &&
			resolved.bashSource !== "env" &&
			!ctx.notifiedBashSource
		) {
			// bash located off PATH (derived from git.exe or a known install
			// root) — say so once, so shell selection is never mysterious.
			ctx.notifiedBashSource = true;
			ctx.sessionUi.ui?.notify(`unified-exec: using bash at ${resolved.shell} (not on PATH)`, "info");
		}
	} else if (IS_WINDOWS) {
		// Resolve bare names to the absolute PATH match, failing closed —
		// Windows' CreateProcess checks the child's cwd (the LLM-supplied
		// workdir) before PATH for bare names, so an unresolved name must
		// never reach spawn.
		shellBin = resolveWindowsShell(shellBin);
	}
	const shellCommand = buildShellCommand(shellBin, args.cmd);
	const effectiveCwd = args.workdir && args.workdir.length > 0 ? args.workdir : cwd;
	const wantsWake = args.on_exit === "wake";
	const directWake = wantsWake ? directCompletionFields("wake") : undefined;

	const id = ctx.store.allocateId();
	const session = ExecSession.spawn(id, {
		command: shellCommand.command,
		cwd: effectiveCwd,
		env: process.env,
		tty,
		cols: args.cols !== undefined ? clamp(Math.floor(args.cols), MIN_PTY_COLS, MAX_PTY_COLS) : undefined,
		rows: args.rows !== undefined ? clamp(Math.floor(args.rows), MIN_PTY_ROWS, MAX_PTY_ROWS) : undefined,
		displayCommand: args.cmd,
		windowsVerbatimArguments: shellCommand.windowsVerbatimArguments,
	});

	if (session.failureMessage) {
		return finalizeProcessResult({
			operation: "exec_command",
			wallTimeSec: 0,
			collected: new Uint8Array(0),
			running: false,
			sessionId: undefined,
			exitCode: -1,
			signal: null,
			failure: session.failureMessage,
			tty,
			cwd: effectiveCwd,
			command: args.cmd,
			yieldTimeMs,
			metadata: directWake,
		});
	}

	// Track the session from spawn to store-insertion: session_shutdown must
	// be able to terminate children that are still inside the grace window.
	ctx.pendingSessions.add(session);
	try {
		// Give short-lived commands a chance to finish without registering
		// them. This time counts against the requested attachment window.
		const start = performance.now();
		const earlyDuration = Math.min(yieldTimeMs, EARLY_EXIT_GRACE_PERIOD_MS);
		if (earlyDuration > 0) {
			await waitForExitOrDeadline({
				exited: session.exited, externalAbort: signal, steerAbort: steerSignal, durationMs: earlyDuration,
			});
		}
		if (session.hasExited) {
			// Fully short-lived: collect everything in the buffer + any trailing
			// bytes. macOS can deliver stdout/stderr shortly after the exit event
			// for very fast commands — give the trailing drain a bounded window.
			const collected = await session.collect({ deadlineMs: Date.now() + 500, externalAbort: signal });
			return finalizeSessionResult(session, collected, {
				operation: "exec_command",
				wallTimeSec: (performance.now() - start) / 1000,
				running: false,
				failure: session.failureMessage,
				yieldTimeMs,
				metadata: directWake,
			});
		}

		// Live session: register it BEFORE we keep polling, so an early abort
		// doesn't let the session be GC'd / lose its place.
		const { pruned, count } = ctx.store.insert(session);
		ctx.sessionUi.watchExit(session);
		if (pruned) {
			ctx.sessionUi.unwatchExit(pruned.id);
			// Suppresses the wake for live victims; keeps a tombstone for a
			// naturally-exited wake session so its completion is not silently lost.
			ctx.coordinator.handleEviction(pruned);
			ctx.sessionUi.ui?.notify(`unified-exec: evicted session ${pruned.id} (LRU, over cap ${ctx.store.maxSessions})`, "warning");
		}
		if (count >= WARNING_SESSIONS) {
			ctx.sessionUi.ui?.notify(`unified-exec: ${count}/${ctx.store.maxSessions} sessions open`, "warning");
		}
		// Keep exited sessions available until their final output is collected.

		// Wait until the yield deadline (or abort/exit). Stream updates meanwhile.
		const collected = await collectAttachedOutput(
			session, yieldTimeMs, start, signal, steerSignal, onUpdate, () => wantsWake ? "wake" : undefined,
		);

		session.touch();
		const running = !session.hasExited;
		const elapsedMs = performance.now() - start;
		const steered = steerSignal?.aborted === true && signal?.aborted !== true && elapsedMs < yieldTimeMs;

		if (running) {
			// COMMIT POINT for on_exit: "wake" — we are now returning a background
			// session_id, so arm the wake. If the process exits a moment after this
			// check, the coordinator's exit listener (which fires even for
			// already-exited sessions) still delivers the completion exactly once.
			if (wantsWake) ctx.coordinator.register(session);
		} else {
			// Exit was delivered directly, without registering a wake.
			removeSession(ctx, session.id);
		}
		return finalizeSessionResult(session, collected, {
			operation: "exec_command",
			wallTimeSec: elapsedMs / 1000,
			running,
			failure: running ? null : session.failureMessage,
			yieldTimeMs,
			metadata: running ? {
				on_exit: wantsWake ? "wake" : undefined,
				wait_status: steered ? WAIT_STEERED : undefined,
				note: heldOpenNote(session),
			} : directWake,
		});
	} finally {
		ctx.pendingSessions.delete(session);
	}
}

async function runWriteStdin(
	ctx: ExtensionCtx,
	args: WriteStdinArgs,
	signal: AbortSignal | undefined,
	steerSignal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	toolCallId: string,
): Promise<ProcessResultDetails & { session_id: number; total_time_seconds: number }> {
	const writeBytes = resolveWriteInput(args);
	const hasInput = writeBytes !== undefined && writeBytes.length > 0;
	const policy = args.on_exit;
	const policyOnly = policy !== undefined && !hasInput && args.yield_time_ms === undefined;
	const sid = args.session_id;
	const session = ctx.store.get(sid) ??
		(policyOnly && policy === "none" ? ctx.coordinator.pendingWakeSession(sid) : undefined);
	if (!(session instanceof ExecSession)) throw new Error(`unknown session_id: ${sid}`);
	const yieldTimeMs = policyOnly ? undefined : resolveYieldTimeMs("write_stdin", args.yield_time_ms, hasInput);

	if (policy !== undefined) signal?.throwIfAborted();
	const change = policy === undefined ? undefined : ctx.coordinator.setOnExit(sid, policy, session);
	const getOnExit = (): ProcessResultDetails["on_exit"] =>
		ctx.coordinator.onExitStatus(session) ?? (policy === undefined ? undefined : "none");
	const shape = hasInput && yieldTimeMs !== undefined
		? await writeAndCollect(ctx, session, writeBytes, yieldTimeMs, signal, steerSignal, onUpdate, toolCallId, getOnExit)
		: await runAttachedWait(ctx, session, yieldTimeMs, signal, steerSignal, onUpdate, toolCallId, getOnExit);
	if (change === "too_late") {
		const note = session.hasExited
			? "Session already exited. No new wake was armed."
			: "Could not arm a wake for this session.";
		shape.note = shape.note ? `${note} ${shape.note}` : note;
	}
	return Object.assign(shape, { session_id: sid, total_time_seconds: session.totalTimeSeconds });
}

async function writeAndCollect(
	ctx: ExtensionCtx,
	session: ExecSession,
	writeBytes: Uint8Array,
	yieldTimeMs: number,
	signal: AbortSignal | undefined,
	steerSignal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	toolCallId: string,
	getOnExit: () => ProcessResultDetails["on_exit"],
): Promise<ProcessResultDetails> {
	const start = performance.now();
	session.touch();

	// Observation lease: while this call may return terminal status, a
	// concurrent exit is held instead of enqueuing a wake (see completion.ts).
	ctx.coordinator.beginObservation(session.id, toolCallId);
	try {
		const ok = session.write(writeBytes);
		if (!ok && session.hasExited) {
			const collected = await session.collect({ deadlineMs: Date.now() + 50, externalAbort: signal });
			const onExit = getOnExit();
			removeSession(ctx, session.id);
			ctx.coordinator.markPendingTerminal(session.id, toolCallId);
			return finalizeSessionResult(session, collected, {
				operation: "write_stdin",
				wallTimeSec: (performance.now() - start) / 1000,
				running: false,
				failure: session.failureMessage,
				yieldTimeMs,
				metadata: directCompletionFields(onExit),
			});
		}
		const writeFailure = ok ? null : "stdin write failed: the child closed its stdin; bytes were not delivered";
		const collected = await collectAttachedOutput(session, yieldTimeMs, start, signal, steerSignal, onUpdate, getOnExit);
		const elapsedMs = performance.now() - start;
		const steered = steerSignal?.aborted === true && signal?.aborted !== true && elapsedMs < yieldTimeMs;

		const onExit = getOnExit();
		const running = !session.hasExited;
		if (!running) {
			removeSession(ctx, session.id);
			// Terminal result constructed: keep the lease until Pi finalizes it
			// (tool_execution_end) so an error/cancelled finalization keeps the
			// completion wake-eligible.
			ctx.coordinator.markPendingTerminal(session.id, toolCallId);
		} else {
			// A live result keeps the wake eligible.
			ctx.coordinator.releaseObservation(session.id, toolCallId);
		}
		return finalizeSessionResult(session, collected, {
			operation: "write_stdin",
			wallTimeSec: elapsedMs / 1000,
			running,
			failure: running ? writeFailure : session.failureMessage ?? writeFailure,
			yieldTimeMs,
			metadata: running ? {
				on_exit: onExit,
				wait_status: steered ? WAIT_STEERED : undefined,
				note: heldOpenNote(session),
			} : directCompletionFields(onExit),
		});
	} catch (err) {
		// Handler failure: release the lease so the wake stays eligible.
		ctx.coordinator.releaseObservation(session.id, toolCallId);
		throw err;
	}
}

/** Extra fields for a tool result that directly reports completion. */
function directCompletionFields(onExit: ProcessResultDetails["on_exit"]): ProcessResultMetadata {
	return {
		completion_delivery: "direct",
		on_exit: onExit === "wake" ? "consumed" : onExit,
	};
}

/** Keep output in the session during empty polls and long command/input waits. */
async function waitForBufferedOutput(
	session: ExecSession,
	durationMs: number | undefined,
	remainingMs: number,
	signal: AbortSignal | undefined,
	steerSignal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	getOnExit: () => ProcessResultDetails["on_exit"],
): Promise<{ outcome: LongWaitOutcome; collected: CollectResult }> {
	const streamer = onUpdate && remainingMs > 0 ? startRateLimitedStream({
		outputNotify: session.outputNotify,
		minIntervalMs: remainingMs <= LONG_WAIT_THRESHOLD_MS ? OUTPUT_POLL_INTERVAL_MS : LONG_WAIT_UPDATE_INTERVAL_MS,
		emit: () => onUpdate(buildStreamUpdate(session, getOnExit(), durationMs)),
	}) : undefined;
	try {
		let outcome = await waitForExitOrDeadline({
			exited: session.exited,
			externalAbort: signal,
			steerAbort: steerSignal,
			durationMs: remainingMs,
		});
		// Exit wins close races. Live cancellation leaves the buffer intact.
		if (session.hasExited) outcome = "exit";
		const collected = outcome === "cancelled"
			? { bytes: new Uint8Array(0), omittedBytes: 0 }
			: await session.collect({
				deadlineMs: Date.now() + (outcome === "exit" ? 1000 : 0),
				externalAbort: outcome === "exit" ? undefined : signal,
			});
		return { outcome, collected };
	} finally {
		streamer?.stop();
	}
}

async function collectAttachedOutput(
	session: ExecSession,
	durationMs: number,
	startedAt: number,
	signal: AbortSignal | undefined,
	steerSignal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	getOnExit: () => ProcessResultDetails["on_exit"],
): Promise<CollectResult> {
	const remainingMs = Math.max(0, durationMs - (performance.now() - startedAt));
	if (durationMs > LONG_WAIT_THRESHOLD_MS) {
		return (await waitForBufferedOutput(session, durationMs, remainingMs, signal, steerSignal, onUpdate, getOnExit)).collected;
	}
	const deadlineMs = Date.now() + remainingMs;
	const streamer = remainingMs > 0 ? startStreaming(session, onUpdate, deadlineMs, signal, getOnExit) : undefined;
	try {
		return await session.collect({ deadlineMs, externalAbort: signal, stopSignal: steerSignal });
	} finally {
		streamer?.stop();
	}
}

async function runAttachedWait(
	ctx: ExtensionCtx,
	session: ExecSession,
	durationMs: number | undefined,
	signal: AbortSignal | undefined,
	steerSignal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	toolCallId: string,
	getOnExit: () => ProcessResultDetails["on_exit"],
): Promise<ProcessResultDetails> {
	const startedAt = performance.now();
	session.touch();
	ctx.coordinator.beginObservation(session.id, toolCallId);
	let pendingTerminal = false;
	try {
		const { outcome, collected } = await waitForBufferedOutput(
			session, durationMs, durationMs ?? 0, signal, steerSignal, onUpdate, getOnExit,
		);
		const onExit = getOnExit();
		const elapsedMs = performance.now() - startedAt;
		const running = outcome !== "exit";
		const shape = finalizeSessionResult(session, collected, {
			operation: "write_stdin",
			wallTimeSec: elapsedMs / 1000,
			running,
			failure: !running || durationMs === undefined ? session.failureMessage : null,
			yieldTimeMs: durationMs,
			metadata: running ? {
				on_exit: onExit,
				wait_status: outcome === "cancelled" ? WAIT_CANCELLED : outcome === "steered" ? WAIT_STEERED : undefined,
				note: heldOpenNote(session),
			} : directCompletionFields(onExit),
		});
		if (!running) {
			removeSession(ctx, session.id);
			ctx.coordinator.markPendingTerminal(session.id, toolCallId);
			pendingTerminal = true;
		} else {
			session.touch();
		}
		return shape;
	} finally {
		// Successful terminal delivery is committed by tool_execution_end.
		if (!pendingTerminal) ctx.coordinator.releaseObservation(session.id, toolCallId);
	}
}

/** Result of terminating a session via kill_session or the sessions command. */
interface TerminateOutcome {
	session: ExecSession;
	escalated: boolean;
	collected: CollectResult;
	/** true when the process is confirmed dead; false = kill did NOT land. */
	killed: boolean;
	onExit: OnExitStatus | undefined;
}

/**
 * Kill a session (initial signal → 2s grace → SIGKILL escalation), drain its
 * trailing output, and remove it from the store — but ONLY on confirmed
 * exit. A kill that doesn't land (OS failure, access denied,
 * unkillable state) keeps the session in the store and returns
 * killed: false, so ownership of a live process is never silently dropped.
 * Shared by the kill_session tool and the /unified-exec-sessions command.
 */
async function terminateSessionById(
	ctx: ExtensionCtx,
	sid: number,
	initial: NodeJS.Signals,
): Promise<TerminateOutcome | undefined> {
	const session = ctx.store.get(sid);
	if (!session) return undefined;
	// Explicit kill (model tool or human slash command): suppress the wake
	// BEFORE signaling so the induced exit can never race a wake enqueue.
	ctx.coordinator.suppress(sid);
	session.kill(initial);
	// Event-driven wait (resolves the instant the exit fires): up to 2s.
	await waitForExitOrDeadline({ exited: session.exited, durationMs: 2000 });
	let escalated = false;
	// On Windows every signal force-terminates the Job Object. A second
	// signal uses the same OS operation, so escalation is POSIX-only.
	if (!session.hasExited && !IS_WINDOWS) {
		session.kill("SIGKILL");
		escalated = true;
		await waitForExitOrDeadline({ exited: session.exited, durationMs: 500 });
	}
	// Final drain.
	const collected = await session.collect({ deadlineMs: Date.now() + 100 });
	const killed = session.hasExited;
	if (killed) {
		ctx.coordinator.confirmKill(sid);
		removeSession(ctx, sid);
	} else {
		// The kill did NOT land — the process is still alive and still owned.
		// Restore its prior wake eligibility.
		ctx.coordinator.restoreAfterFailedKill(sid);
	}
	return { session, escalated, collected, killed, onExit: ctx.coordinator.onExitStatus(session) };
}

function removeSession(ctx: ExtensionCtx, id: number): void {
	ctx.sessionUi.unwatchExit(id);
	ctx.store.remove(id);
}

/** Shared streaming-update payload for attached waits. */
function buildStreamUpdate(
	session: ExecSession,
	onExit: ProcessResultDetails["on_exit"],
	yieldTimeMs?: number,
): AgentToolResult<ProcessUpdateDetails> {
	const tailText = sanitizeOutputText(textDecoder.decode(session.snapshotStreamTail()));
	const details: ProcessUpdateDetails = {
		session_id: session.id,
		pid: session.pid,
		running: !session.hasExited,
		total_bytes: session.totalBytesSeen,
		tty: session.tty,
		command: session.displayCommand,
		cwd: session.cwd,
		log: session.log,
		output: tailText,
	};
	if (onExit) details.on_exit = onExit;
	if (yieldTimeMs !== undefined) details.yield_time_ms = yieldTimeMs;
	return {
		content: [{ type: "text", text: tailText }],
		details,
	};
}

/**
 * The steer signal for one exec_command/write_stdin call. A top-level call
 * made while a steer is already queued returns promptly (its wait sees an
 * aborted signal). A nested codemode call throws instead: otherwise a script
 * polling in a loop would spin on instant returns and still hold the steer.
 */
function steerSignalFor(ctx: ExtensionCtx, toolCallId: string, probe: PendingProbe): AbortSignal | undefined {
	if (!ctx.steer.enabled) return undefined;
	if (ctx.steer.isPending(probe) && isNestedToolCall(toolCallId)) throw new Error(STEER_NESTED_ERROR);
	return ctx.steer.signal;
}

function startStreaming(
	session: ExecSession,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	deadlineMs: number,
	externalAbort: AbortSignal | undefined,
	getOnExit: () => ProcessResultDetails["on_exit"],
): { stop: () => void } {
	if (!onUpdate) return { stop: () => {} };
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	const tick = () => {
		if (stopped) return;
		try {
			onUpdate(buildStreamUpdate(session, getOnExit()));
		} catch {
			// ignore transient errors
		}
		if (stopped) return;
		if (Date.now() >= deadlineMs) return;
		if (externalAbort?.aborted) return;
		timer = setTimeout(tick, OUTPUT_POLL_INTERVAL_MS);
	};
	timer = setTimeout(tick, OUTPUT_POLL_INTERVAL_MS);
	return {
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		},
	};
}

export default function (pi: ExtensionAPI) {
	const store = new SessionStore({ maxSessions: MAX_SESSIONS, lruProtectedCount: LRU_PROTECTED_COUNT });
	const coordinator = new CompletionCoordinator({
		send: (message) => {
			// If pi is idle this starts a model turn; if a run is active it is
			// queued as a follow-up — never steering/interrupting the current turn.
			pi.sendMessage(
				{
					customType: "unified-exec-completed",
					content: message.content,
					display: true,
					details: message.details,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
		onSendError: (err) => {
			ctx.sessionUi.ui?.notify(
				`unified-exec: failed to deliver completion notification: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		},
	});
	const ctx: ExtensionCtx = {
		coordinator,
		store,
		sessionUi: new SessionUi(store, coordinator),
		warnedShellFallback: false,
		notifiedBashSource: false,
		pendingSessions: new Set(),
		shuttingDown: false,
		steer: new SteerGate({ enabled: steerInterruptEnabled() }),
	};

	// By default, unified-exec removes pi's built-in `bash` tool so the LLM
	// is steered toward exec_command/write_stdin. Pass --keep-builtin-bash to
	// preserve the built-in alongside the unified-exec tools.
	pi.registerFlag("keep-builtin-bash", {
		description: "Keep pi's built-in `bash` tool alongside exec_command/write_stdin. By default it is removed.",
		type: "boolean",
		default: false,
	});

	// Observation finalization: "observed" is committed at pi's finalized
	// tool-result event, not merely when the handler returns — see completion.ts.
	pi.on("tool_execution_end", async (event) => {
		ctx.coordinator.handleToolExecutionEnd(event.toolCallId, event.isError === true);
	});
	pi.on("tool_result", (event) => {
		if (!event.isError || event.structuredContent !== undefined) return;
		if (event.toolName !== "exec_command" && event.toolName !== "write_stdin" && event.toolName !== "kill_session") return;
		const note = ctx.store.takeExitReminder();
		if (!note) return;
		const details = typeof event.details === "object" ? event.details : undefined;
		return { content: [...event.content, { type: "text", text: `note: ${note}` }], details: { ...details, note } };
	});
	pi.on("agent_settled", async () => {
		ctx.steer.reset();
		ctx.coordinator.flushPending();
	});

	// Steer interrupt: a human steer queued during a long wait ends the wait
	// early so Pi can deliver it after this tool batch (see steer-gate.ts).
	pi.on("input", async (event, eventCtx) => {
		if (event.streamingBehavior === "steer") ctx.steer.onSteerInput(eventCtx);
	});
	pi.on("message_start", async (event) => {
		if (event.message.role === "user") ctx.steer.onUserMessageDelivered();
	});

	pi.on("session_start", async (_event, eventCtx) => {
		ctx.sessionUi.ui = eventCtx.ui;
		ctx.shuttingDown = false; // reload/new/resume re-arms the extension
		ctx.steer.reset();
		ctx.coordinator.reset(); // never resurrect wakes from a previous session
		ctx.sessionUi.refresh();
		// Default behavior is to remove the built-in `bash` tool. Only keep it
		// if --keep-builtin-bash was passed. Flag lookup uses the registered
		// name without leading dashes.
		const keep = pi.getFlag("keep-builtin-bash");
		if (keep !== true) {
			const active = pi.getActiveTools();
			const filtered = active.filter((name) => name !== "bash");
			if (filtered.length !== active.length) {
				pi.setActiveTools(filtered);
			}
		}
		if (!isPtyAvailable() && eventCtx.hasUI) {
			// Non-fatal: pipes mode still works.
			eventCtx.ui.notify(
				"unified-exec: node-pty not available; tty: true will fail. Pipes (tty: false) still work.",
				"info",
			);
		}
	});

	pi.on("session_tree", async (_event, eventCtx) => {
		ctx.sessionUi.ui = eventCtx.ui;
		ctx.sessionUi.refresh("tree");
	});

	pi.on("session_shutdown", async () => {
		// Reject new sessions from here on and terminate everything we own —
		// including sessions still inside exec_command's early-exit grace
		// window (spawned but not yet inserted into the store).
		ctx.shuttingDown = true;
		ctx.steer.reset();
		// Cancel wake timers/listeners first: no stale prompt may ever be
		// injected into a new or closed session.
		ctx.coordinator.shutdown();
		const drained = ctx.store.terminateAll();
		for (const s of ctx.pendingSessions) {
			if (!s.hasExited) {
				s.kill();
				drained.push(s);
			}
		}
		ctx.sessionUi.clearExitWatches();
		ctx.sessionUi.refresh();
		// Children run detached (own process groups), so anything that ignores
		// SIGTERM would outlive pi as an orphan. Give them a short grace, then
		// SIGKILL survivors and wait briefly for confirmation. On Windows the
		// initial kill already terminates the Job Object, so the grace wait
		// below confirms exits without escalation. Each wait resolves
		// the instant that session's exit fires.
		await Promise.all(drained.map((s) => waitForExitOrDeadline({ exited: s.exited, durationMs: 1000 })));
		if (!IS_WINDOWS) {
			const survivors = drained.filter((s) => !s.hasExited);
			for (const s of survivors) s.kill("SIGKILL");
			await Promise.all(survivors.map((s) => waitForExitOrDeadline({ exited: s.exited, durationMs: 500 })));
		}
		if (drained.length && ctx.sessionUi.ui) {
			const leftover = drained.filter((s) => !s.hasExited).length;
			ctx.sessionUi.ui.notify(
				`unified-exec: terminated ${drained.length - leftover} live session(s) on shutdown` +
					(leftover ? `; ${leftover} did not confirm exit` : ""),
				 leftover ? "warning" : "info",
			);
		}
	});

	// Human-facing escape hatch: inspect and kill live sessions without going
	// through the model.
	pi.registerCommand("unified-exec-sessions", {
		description: "List live unified-exec sessions and optionally kill one (or all)",
		handler: async (_args, cmdCtx) => {
			ctx.sessionUi.ui = cmdCtx.ui;
			const targets = await ctx.sessionUi.pickKillTargets(cmdCtx.ui);
			if (!targets) return;
			let killed = 0;
			let failed = 0;
			for (const s of targets) {
				const outcome = await terminateSessionById(ctx, s.id, "SIGTERM");
				if (outcome?.killed) killed++;
				else if (outcome) failed++;
			}
			ctx.sessionUi.refresh();
			cmdCtx.ui.notify(
				`unified-exec: killed ${formatSessionCount(killed)}` +
					(failed ? `; ${failed} did not confirm exit (still listed)` : ""),
				failed ? "warning" : "info",
			);
		},
	});

	// ---------------- Tools ----------------

	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		description:
			'Run a command in a persistent session. `[running #N]` means N is the session_id; `[exited ok]` or `[exited error N]` means the command finished. on_exit defaults to "none". Only pass on_exit: "wake" when the human explicitly wants auto-resume on unobserved exit. Use write_stdin with on_exit to change the policy.',
		promptSnippet: "Run a routine shell command or an async/interactive task",
		promptGuidelines: [
			"exec_command & write_stdin: Use the default wait for routine commands and their final poll. Use a short wait when starting or driving an interactive task.",
			"exec_command: Use yield_time_ms: 0 to start a background task and return without waiting.",
			"exec_command: Long-running commands return a session_id (#N) you can use to drive write_stdin.",
		],
		outputSchema: execCommandScriptResultSchema,
		parameters: Type.Object({
			cmd: Type.String({ description: "Shell command to execute." }),
			workdir: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
			shell: Type.Optional(
				Type.String({
					description: "Shell binary to run the command. Default is bash. On Windows you can also use cmd, powershell or pwsh.",
				}),
			),
			tty: Type.Optional(Type.Boolean({ description: "Allocate a PTY. Default false (plain pipes)." })),
			cols: Type.Optional(
				Type.Number({
					description: `PTY width in columns (tty: true only; ignored for pipes). Default 120, clamped to [${MIN_PTY_COLS}, ${MAX_PTY_COLS}].`,
				}),
			),
			rows: Type.Optional(
				Type.Number({
					description: `PTY height in rows (tty: true only; ignored for pipes). Default 30, clamped to [${MIN_PTY_ROWS}, ${MAX_PTY_ROWS}].`,
				}),
			),
			yield_time_ms: Type.Optional(
				Type.Number({
					minimum: 0,
					description: `How long (ms) to stay attached and collect output. Does not stop the command. Default ${DEFAULT_YIELD_MS}. ${YIELD_DESCRIPTION}`,
				}),
			),
			on_exit: Type.Optional(
				StringEnum(
					["none", "wake"] as const,
					'"none" (default): no auto-resume; poll with write_stdin. "wake": ONE follow-up notification on unobserved exit that resumes the agent — only when the human explicitly wants auto-resume. Change later via write_stdin. A completion observed directly by a tool result consumes the wake.',
				),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.sessionUi.ui ??= eventCtx.ui;
			const steerSignal = steerSignalFor(ctx, toolCallId, eventCtx);
			const shape = await runExecCommand(ctx, params, signal, steerSignal, onUpdate, eventCtx.cwd);
			ctx.sessionUi.refresh();
			return sessionToolResult(ctx.store, shape, execCommandScriptResult);
		},
		renderCall: renderExecCommandCall,
		renderResult: renderProcessResult,
	});

	pi.registerTool({
		name: "write_stdin",
		label: "write_stdin",
		description:
			"Send input, poll for output or exit, or change a session's wake policy. Use `chars` for text with C-style escapes (e.g. \\x03 Ctrl-C, \\x1b ESC, \\n newline) or `chars_hex` for exact bytes. Use on_exit to change wake policy. Omit both input fields to poll. #N in the tool output is the session ID.",
		promptSnippet: "Send input, poll or collect output, or change a session's wake policy",
		promptGuidelines: [
			"write_stdin: Don't use chars and chars_hex at the same time.",
			"write_stdin: Don't poll again after collecting a session's final output. You can still collect an exit shown by list_sessions.",
			'write_stdin: Only set on_exit to "wake" when the human asks for auto-resume. To disarm a pending wake promptly, use on_exit: "none" with just the session ID. An exit collected by a poll consumes its wake.',
			"write_stdin: In tty sessions, submit lines with \\r (the Enter key) rather than \\n: POSIX terminals accept both, but Windows console programs only execute input on \\r.",
			"exec_command & write_stdin: For very noisy jobs, rely on the log and final/truncated output instead of repeatedly polling.",
			`exec_command, write_stdin, kill_session, list_sessions: If the tool output contains a log number, you can read ${OUTPUT_LOG_PATH_TEMPLATE} under Pi's cwd for the full command output.`,
			"exec_command, write_stdin & kill_session: In codemode, results are { details, text }. Use r.details for structured data such as status and session_id, or call text(r.text) to display the formatted reply.",
		],
		outputSchema: writeStdinScriptResultSchema,
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session id from exec_command." }),
			chars: Type.Optional(
				Type.String({
					description:
						"Text with C-style escapes: \\xHH, \\uHHHH, \\u{H\u2026}, \\n \\r \\t \\0 \\a \\e \\b \\f \\v \\\\ \\\". Unknown \\X preserved literally. Mutually exclusive with chars_hex.",
				}),
			),
			chars_hex: Type.Optional(
				Type.String({
					description: "Exact bytes as hex digits (e.g. '1a 2B dF'). Case-insensitive; whitespace is ignored. Each byte needs two hex digits. Mutually exclusive with chars.",
				}),
			),
			yield_time_ms: Type.Optional(
				Type.Number({
					minimum: 0,
					description: `How long (ms) to stay attached and collect output. Default ${DEFAULT_YIELD_MS} without input or ${DEFAULT_INPUT_YIELD_MS} with input. ${YIELD_DESCRIPTION}`,
				}),
			),
			on_exit: Type.Optional(StringEnum(
				["none", "wake"] as const,
				'Omit to keep the policy. "none" disarms a pending wake. "wake" arms a live session.',
			)),
		}, { additionalProperties: false }),
		async execute(toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.sessionUi.ui ??= eventCtx.ui;
			const steerSignal = steerSignalFor(ctx, toolCallId, eventCtx);
			const shape = await runWriteStdin(ctx, params, signal, steerSignal, onUpdate, toolCallId);
			ctx.sessionUi.refresh();
			return sessionToolResult(ctx.store, shape, writeStdinScriptResult);
		},
		renderCall: renderWriteStdinCall,
		renderResult: renderProcessResult,
	});

	pi.registerTool({
		name: "kill_session",
		label: "kill_session",
		description:
			"Terminate a session with SIGTERM, escalating to SIGKILL after 2s on POSIX; Windows force-kills all session processes for any signal. Returns `[killed #N]` or `[kill failed #N]`, where N is the session ID. A successful kill invalidates the session ID and suppresses its wake; a failed kill won't stop the session.",
		promptSnippet: "Terminate a session",
		outputSchema: killScriptResultSchema,
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session to terminate." }),
			signal: Type.Optional(
				Type.String({ description: 'Initial signal (default "SIGTERM"). Examples: SIGINT, SIGHUP, SIGKILL.' }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.sessionUi.ui ??= eventCtx.ui;
			const sid = (params as { session_id: number; signal?: string }).session_id;
			const initial = normalizeSignal((params as { signal?: string }).signal);
			const startedAt = Date.now();
			const outcome = await terminateSessionById(ctx, sid, initial);
			if (!outcome) {
				return sessionToolResult(ctx.store, {
					operation: "kill_session",
					status: "kill_failed",
					running: false,
					session_id: sid,
					found: false,
				} as const, (details) => killNotFoundScriptResult(sid, details.note));
			}
			const { session, escalated, collected, killed, onExit } = outcome;
			ctx.sessionUi.refresh();
			const killFailure = killed
				? session.failureMessage
				: [
						`process still running after ${initial}${escalated ? " and SIGKILL escalation" : ""}; ` +
							"the session remains registered — retry kill_session or check permissions",
						session.failureMessage,
					]
					.filter((value): value is string => Boolean(value))
					.join("; ");
			const details = finalizeKillResult({
				wallTimeSec: (Date.now() - startedAt) / 1000,
				collected: collected.bytes,
				omittedBytes: collected.omittedBytes,
				sessionId: sid,
				totalTimeSec: session.totalTimeSeconds,
				pid: session.pid,
				requestedSignal: initial,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: killFailure || null,
				tty: session.tty,
				log: session.log,
				cwd: session.cwd,
				command: session.displayCommand,
				escalated,
				killed,
				onExit,
			});
			return sessionToolResult(ctx.store, details, killScriptResult);
		},
		renderCall: renderKillSessionCall,
		renderResult: renderKillSessionResult,
	});

	pi.registerTool({
		name: "list_sessions",
		label: "list_sessions",
		description: "List live unified-exec sessions and exits with output still available. Use write_stdin to collect final output.",
		promptSnippet: "List live sessions and exits awaiting collection",
		outputSchema: listSessionsScriptResultSchema,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, eventCtx) {
			ctx.sessionUi.ui ??= eventCtx.ui;
			let exited = 0;
			const now = Date.now();
			const sessions = ctx.store.values()
				.sort((a, b) => a.id - b.id)
				.map((s) => {
					const running = !s.hasExited;
					if (!running) {
						// Report the exit without draining or retiring the session.
						ctx.coordinator.observeViaListing(s.id);
						exited++;
					}
					const onExit = ctx.coordinator.onExitStatus(s);
					return {
						session_id: s.id,
						command: s.displayCommand,
						cwd: s.cwd,
						tty: s.tty,
						pid: s.pid,
						started_at_ms: s.startedAt,
						elapsed_ms: running ? now - s.startedAt : s.totalTimeSeconds * 1000,
						running,
						...(onExit ? { on_exit: onExit } : {}),
						wake_armed: ctx.coordinator.isArmed(s.id),
						exit_code: running ? undefined : s.exitCode,
						signal: running ? undefined : (s.signal ?? undefined),
						failure_message: s.failureMessage ?? undefined,
						log: s.log,
					};
				});
			ctx.sessionUi.refresh();
			const active = sessions.length - exited;
			const details = { sessions, active_count: active, just_exited_count: exited };
			const structuredContent = listSessionsScriptResult(details);
			const lines = [`active_count: ${active}, just_exited_count: ${exited}`];
			for (const session of structuredContent.sessions) lines.push(JSON.stringify(session));
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details,
				structuredContent,
			};
		},
		renderCall: renderListSessionsCall,
		renderResult: renderListSessionsResult,
	});

	// Shadows native codemode at session start without replacing
	// builtin:codemode. Presentation only, for every nested tool.
	registerCompactCodemode(pi);
}
