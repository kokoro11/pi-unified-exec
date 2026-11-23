/**
 * unified-exec — pi extension that ports codex's unified_exec session model,
 * with pi's built-in `bash` tool's on-disk retention layered on top.
 *
 * Tools exposed to the LLM:
 *   - exec_command(cmd, workdir?, shell?, tty?, yield_time_ms?, on_exit?)
 *   - write_stdin(session_id, chars?, chars_b64?, yield_time_ms?, on_exit?)
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
import { type AgentToolResult, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "typebox";

import type { CollectResult } from "./collect.ts";
import { registerCompactCodemode } from "./codemode-render.ts";
import { CompletionCoordinator, type OnExitPolicy, type OnExitStatus, sanitizeMeta } from "./completion.ts";
import { formatElapsed } from "./format-time.ts";
import { type LongWaitOutcome, startRateLimitedStream, waitForExitOrDeadline } from "./long-wait.ts";
import { sleep } from "./notify.ts";
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
import {
	isNestedToolCall,
	type PendingProbe,
	STEER_NESTED_ERROR,
	SteerGate,
	steerInterruptEnabled,
} from "./steer-gate.ts";
import { buildShellCommand, IS_WINDOWS, resolveDefaultShell, resolveWindowsShell } from "./shell.ts";
import { MIN_EMPTY_YIELD_TIME_MS, resolveEmptyPollYield } from "./time.ts";
export { MAX_EMPTY_POLL_ENV_VAR, resolveMaxEmptyPollMs } from "./time.ts";
import {
	finalizeKillResult,
	finalizeProcessResult,
	type FinalizeProcessInput,
	type ProcessResultDetails,
	WAIT_CANCELLED,
	WAIT_STEERED,
} from "./tool-result.ts";
import { unescapeChars } from "./unescape.ts";

// ---------------- Constants (mirror codex) ----------------

const MIN_YIELD_TIME_MS = 250;
const MAX_YIELD_TIME_MS = 30_000;
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_MS = 250;
const EARLY_EXIT_GRACE_PERIOD_MS = 150;
const MAX_SESSIONS = 64;
const WARNING_SESSIONS = 60;
const LRU_PROTECTED_COUNT = 8;
const OUTPUT_POLL_INTERVAL_MS = 250; // exec/input updates and short empty-poll rate limit
// PTY dimension clamps for exec_command's cols/rows (tty: true only).
const MIN_PTY_COLS = 20;
const MAX_PTY_COLS = 500;
const MIN_PTY_ROWS = 5;
const MAX_PTY_ROWS = 300;
// Long empty polls use output-driven updates, never a periodic heartbeat.
const LONG_WAIT_UPDATE_INTERVAL_MS = 30_000;
const SESSION_UI_KEY = "unified-exec.sessions";

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

function clampYield(ms: number | undefined, defaultMs: number): number {
	const v = typeof ms === "number" && ms > 0 ? ms : defaultMs;
	return clamp(Math.floor(v), MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS);
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

type ResponseShape = ProcessResultDetails;
type ProcessUpdateDetails = Partial<ProcessResultDetails> & { pid?: number; total_bytes?: number };
type FinalizeInput = Omit<FinalizeProcessInput, "operation">;

function decode(bytes: Uint8Array): string {
	return textDecoder.decode(bytes);
}

function encode(str: string): Uint8Array {
	return textEncoder.encode(str);
}

// ---------------- Extension ----------------

interface ExtensionCtx {
	store: SessionStore;
	/** Agent-level wake scheduling for on_exit: "wake" (see completion.ts). */
	coordinator: CompletionCoordinator;
	ui: ExtensionContext["ui"] | undefined;
	widgetVisible: boolean;
	exitUnsubscribers: Map<number, () => void>;
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
	chars_b64?: string;
	yield_time_ms?: number;
	on_exit?: OnExitPolicy;
};

/**
 * Resolve the two mutually-exclusive input channels (`chars` and
 * `chars_b64`) to a single byte payload. Throws on conflicts or malformed
 * base64.
 */
function resolveWriteInput(args: WriteStdinArgs): Uint8Array | undefined {
	const hasChars = typeof args.chars === "string" && args.chars.length > 0;
	const hasB64 = typeof args.chars_b64 === "string" && args.chars_b64.length > 0;
	if (hasChars && hasB64) {
		throw new Error("write_stdin: pass either `chars` or `chars_b64`, not both.");
	}
	if (hasB64) {
		const b64 = args.chars_b64!.replace(/\s+/g, "");
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
			throw new Error("write_stdin: `chars_b64` is not valid base64.");
		}
		return new Uint8Array(Buffer.from(b64, "base64"));
	}
	if (hasChars) {
		// Decode C-style escapes so the LLM can send \x03, \x1b, \n, etc.
		return encode(unescapeChars(args.chars!));
	}
	return undefined;
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
): Promise<ResponseShape> {
	const finalizeResponse = (input: FinalizeInput): ResponseShape =>
		finalizeProcessResult({ ...input, operation: "exec_command" });
	if (ctx.shuttingDown) {
		throw new Error("unified-exec: session is shutting down; not starting new commands.");
	}
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
			ctx.ui?.notify(
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
			ctx.ui?.notify(`unified-exec: using bash at ${resolved.shell} (not on PATH)`, "info");
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
	const yieldTimeMs = clampYield(args.yield_time_ms, DEFAULT_EXEC_YIELD_MS);
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
		shell: shellBin,
		windowsVerbatimArguments: shellCommand.windowsVerbatimArguments,
	});

	if (session.failureMessage) {
		return finalizeResponse({
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
			extra: directWake,
		});
	}

	// Track the session from spawn to store-insertion: session_shutdown must
	// be able to terminate children that are still inside the grace window.
	ctx.pendingSessions.add(session);
	try {
		// Early-exit grace: if the process dies within 150 ms, treat it as a
		// short-lived command and never register it.
		const start = Date.now();
		const earlyDeadline = start + EARLY_EXIT_GRACE_PERIOD_MS;
		await Promise.race([
			new Promise<void>((resolve) => {
				if (session.hasExited) return resolve();
				session.exited.addEventListener("abort", () => resolve(), { once: true });
			}),
			sleep(EARLY_EXIT_GRACE_PERIOD_MS, signal),
		]);

		if (session.hasExited && Date.now() <= earlyDeadline + 20) {
			// Fully short-lived: collect everything in the buffer + any trailing
			// bytes. macOS can deliver stdout/stderr shortly after the exit event
			// for very fast commands — give the trailing drain a bounded window.
			const collected = await session.collect({ deadlineMs: Date.now() + 500, externalAbort: signal });
			const wallSec = (Date.now() - start) / 1000;
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected: collected.bytes,
				omittedBytes: collected.omittedBytes,
				running: false,
				sessionId: undefined,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: session.failureMessage,
				tty,
				log: session.log,
				cwd: effectiveCwd,
				command: args.cmd,
				yieldTimeMs,
				extra: directWake,
			});
		}

		// Live session: register it BEFORE we keep polling, so an early abort
		// doesn't let the session be GC'd / lose its place.
		const { pruned, count } = ctx.store.insert(session);
		watchSessionExit(ctx, session);
		if (pruned) {
			unwatchSessionExit(ctx, pruned.id);
			// Suppresses the wake for live victims; keeps a tombstone for a
			// naturally-exited wake session so its completion is not silently lost.
			ctx.coordinator.handleEviction(pruned);
			ctx.ui?.notify(`unified-exec: evicted session ${pruned.id} (LRU, over cap ${ctx.store.maxSessions})`, "warning");
		}
		if (count >= WARNING_SESSIONS) {
			ctx.ui?.notify(`unified-exec: ${count}/${ctx.store.maxSessions} sessions open`, "warning");
		}
		// Note: sessions stay in the store until a later tool call observes the
		// exit: write_stdin returns the final exit_code/output, and list_sessions
		// reports exited sessions one last time (with exit info) before removing
		// them. Matches codex's lazy-drain so exit information is never silently
		// lost across turns.

		// Wait until the yield deadline (or abort/exit). Stream updates meanwhile.
		const deadlineMs = start + yieldTimeMs;
		const pollStream = startStreaming(session, onUpdate, deadlineMs, signal, () => wantsWake ? "wake" : undefined);
		const collected = await session.collect({ deadlineMs, externalAbort: signal, stopSignal: steerSignal });
		pollStream.stop();

		session.touch();
		const stillAlive = !session.hasExited;
		const steered = steerSignal?.aborted === true && signal?.aborted !== true && Date.now() < deadlineMs;
		const wallSec = (Date.now() - start) / 1000;

		if (stillAlive) {
			// COMMIT POINT for on_exit: "wake" — we are now returning a background
			// session_id, so arm the wake. If the process exits a moment after this
			// check, the coordinator's exit listener (which fires even for
			// already-exited sessions) still delivers the completion exactly once.
			if (wantsWake) ctx.coordinator.register(session);
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected: collected.bytes,
				omittedBytes: collected.omittedBytes,
				running: true,
				sessionId: session.id,
				exitCode: undefined,
				signal: null,
				failure: null,
				tty,
				log: session.log,
				cwd: effectiveCwd,
				command: args.cmd,
				yieldTimeMs,
				extra: {
					on_exit: wantsWake ? "wake" : undefined,
					...(steered ? { wait_status: WAIT_STEERED } : {}),
					note: heldOpenNote(session),
				},
			});
		}
		// Process exited during this call → respond with exit info, not a
		// session_id. The wake is never armed: the exit was delivered directly.
		removeSession(ctx, session.id);
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected: collected.bytes,
			omittedBytes: collected.omittedBytes,
			running: false,
			sessionId: undefined,
			exitCode: session.exitCode,
			signal: session.signal,
			failure: session.failureMessage,
			tty,
			log: session.log,
			cwd: effectiveCwd,
			command: args.cmd,
			yieldTimeMs,
			extra: directWake,
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
): Promise<ResponseShape & { session_id: number; total_time_seconds: number }> {
	const writeBytes = resolveWriteInput(args);
	const hasInput = writeBytes !== undefined && writeBytes.length > 0;
	const policy = args.on_exit;
	const policyOnly = policy !== undefined && !hasInput && args.yield_time_ms === undefined;
	const sid = args.session_id;
	const session = ctx.store.get(sid) ??
		(policyOnly && policy === "none" ? ctx.coordinator.pendingWakeSession(sid) : undefined);
	if (!(session instanceof ExecSession)) throw new Error(`unknown session_id: ${sid}`);
	const yieldTimeMs = policyOnly ? undefined : hasInput
		? clampYield(args.yield_time_ms, DEFAULT_WRITE_STDIN_YIELD_MS)
		: resolveEmptyPollYield(args.yield_time_ms);

	if (policy !== undefined) signal?.throwIfAborted();
	const change = policy === undefined ? undefined : ctx.coordinator.setOnExit(sid, policy, session);
	const getOnExit = (): ResponseShape["on_exit"] =>
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
	getOnExit: () => ResponseShape["on_exit"],
): Promise<ResponseShape> {
	const finalizeResponse = (input: Omit<FinalizeInput, "sessionId">): ResponseShape =>
		finalizeProcessResult({ ...input, operation: "write_stdin", sessionId: session.id });

	const start = Date.now();
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
			return finalizeResponse({
				wallTimeSec: (Date.now() - start) / 1000,
				collected: collected.bytes,
				omittedBytes: collected.omittedBytes,
				running: false,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: session.failureMessage,
				tty: session.tty,
				log: session.log,
				cwd: session.cwd,
				command: session.displayCommand,
				yieldTimeMs,
				extra: directCompletionFields(onExit),
			});
		}
		const writeFailure = ok ? null : "stdin write failed: the child closed its stdin; bytes were not delivered";
		// Give the child a small window to react before the poll.
		await sleep(100, signal);

		const deadlineMs = start + yieldTimeMs;
		const pollStream = startStreaming(session, onUpdate, deadlineMs, signal, getOnExit);
		const collected = await session.collect({ deadlineMs, externalAbort: signal, stopSignal: steerSignal });
		pollStream.stop();
		const wallSec = (Date.now() - start) / 1000;
		const steered = steerSignal?.aborted === true && signal?.aborted !== true && Date.now() < deadlineMs;

		const onExit = getOnExit();
		if (session.hasExited) {
			removeSession(ctx, session.id);
			// Terminal result constructed: keep the lease until Pi finalizes it
			// (tool_execution_end) so an error/cancelled finalization keeps the
			// completion wake-eligible.
			ctx.coordinator.markPendingTerminal(session.id, toolCallId);
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected: collected.bytes,
				omittedBytes: collected.omittedBytes,
				running: false,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: session.failureMessage ?? writeFailure,
				tty: session.tty,
				log: session.log,
				cwd: session.cwd,
				command: session.displayCommand,
				yieldTimeMs,
				extra: directCompletionFields(onExit),
			});
		}
		// Still running: release the lease WITHOUT marking observed — the wake
		// (if armed) stays eligible.
		ctx.coordinator.releaseObservation(session.id, toolCallId);
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected: collected.bytes,
			omittedBytes: collected.omittedBytes,
			running: true,
			exitCode: undefined,
			signal: null,
			failure: writeFailure,
			tty: session.tty,
			log: session.log,
			cwd: session.cwd,
			command: session.displayCommand,
			yieldTimeMs,
			extra: {
				on_exit: onExit,
				...(steered ? { wait_status: WAIT_STEERED } : {}),
				note: heldOpenNote(session),
			},
		});
	} catch (err) {
		// Handler failure: release the lease so the wake stays eligible.
		ctx.coordinator.releaseObservation(session.id, toolCallId);
		throw err;
	}
}

/** Extra fields for a tool result that directly reports completion. */
function directCompletionFields(onExit: ResponseShape["on_exit"]): Partial<ResponseShape> {
	return {
		completion_delivery: "direct",
		on_exit: onExit === "wake" ? "consumed" : onExit,
	};
}

/** Empty polls retain bounded output in the session, not in the wait. */
async function runAttachedWait(
	ctx: ExtensionCtx,
	session: ExecSession,
	durationMs: number | undefined,
	signal: AbortSignal | undefined,
	steerSignal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	toolCallId: string,
	getOnExit: () => ResponseShape["on_exit"],
): Promise<ResponseShape> {
	const startedAt = performance.now();
	const waitFields: Partial<ResponseShape> = { yield_time_ms: durationMs };
	session.touch();
	ctx.coordinator.beginObservation(session.id, toolCallId);
	let pendingTerminal = false;
	let streamer: { stop: () => void } | undefined;
	try {
		if (onUpdate && durationMs !== undefined) {
			streamer = startRateLimitedStream({
				outputNotify: session.outputNotify,
				minIntervalMs: durationMs <= MAX_YIELD_TIME_MS
					? OUTPUT_POLL_INTERVAL_MS : LONG_WAIT_UPDATE_INTERVAL_MS,
				emit: () => onUpdate(buildStreamUpdate(session, getOnExit(), waitFields)),
			});
		}
		let outcome: LongWaitOutcome = await waitForExitOrDeadline({
			exited: session.exited,
			externalAbort: signal,
			steerAbort: steerSignal,
			durationMs: durationMs ?? 0,
		});
		// Exit wins close races. A cancelled live wait never drains output; a
		// steered one drains like a reached deadline (the session stays live).
		if (session.hasExited) outcome = "exit";
		const collected = outcome === "cancelled"
			? { bytes: new Uint8Array(0), omittedBytes: 0 }
			: await session.collect({
				deadlineMs: Date.now() + (outcome === "exit" ? 1000 : 0),
				externalAbort: outcome === "exit" ? undefined : signal,
			});
		const onExit = getOnExit();
		const elapsedMs = performance.now() - startedAt;
		const extra: Partial<ResponseShape> = { ...waitFields };
		if (outcome === "exit") {
			Object.assign(extra, directCompletionFields(onExit));
		} else {
			if (outcome === "cancelled") extra.wait_status = WAIT_CANCELLED;
			else if (outcome === "steered") extra.wait_status = WAIT_STEERED;
			if (durationMs !== undefined) extra.effective_wait_ms = elapsedMs;
			extra.note = heldOpenNote(session);
			extra.on_exit = onExit;
		}
		const shape = finalizeProcessResult({
			operation: "write_stdin",
			wallTimeSec: elapsedMs / 1000,
			collected: collected.bytes,
			omittedBytes: collected.omittedBytes,
			running: outcome !== "exit",
			sessionId: session.id,
			exitCode: outcome === "exit" ? session.exitCode : undefined,
			signal: outcome === "exit" ? session.signal : null,
			failure: outcome === "exit" || durationMs === undefined ? session.failureMessage : null,
			tty: session.tty,
			log: session.log,
			cwd: session.cwd,
			command: session.displayCommand,
			extra,
		});
		if (outcome === "exit") {
			removeSession(ctx, session.id);
			ctx.coordinator.markPendingTerminal(session.id, toolCallId);
			pendingTerminal = true;
		} else {
			session.touch();
		}
		return shape;
	} finally {
		streamer?.stop();
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

function runningSessions(ctx: ExtensionCtx): ExecSession[] {
	return ctx.store
		.values()
		.filter((s) => !s.hasExited)
		.sort((a, b) => a.id - b.id);
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
	return n === 1 ? singular : pluralForm;
}

function oneLineCommand(command: string, max = 120): string {
	// sanitizeMeta strips control chars (ESC included) — \s+ alone would let
	// terminal escape sequences through to widgets and pickers.
	const oneLine = sanitizeMeta(command).replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function formatRunningSessionsWidget(ctx: ExtensionCtx, sessions: ExecSession[]): string[] {
	const now = Date.now();
	const shown = sessions.slice(0, 5);
	const lines = [
		`⚠ unified-exec: ${sessions.length} ${plural(sessions.length, "session")} still running`,
		...shown.map((s) => {
			const wake = ctx.coordinator.isArmed(s.id) ? " [wake]" : "";
			const held = s.shellExited ? " (shell exited, pipe held)" : "";
			return `  #${s.id} ${formatElapsed(now - s.startedAt)}${wake}${held} ${oneLineCommand(s.displayCommand, 72)} (${s.cwd})`;
		}),
	];
	if (sessions.length > shown.length) lines.push(`  … ${sessions.length - shown.length} more; use list_sessions`);
	lines.push("  Use list_sessions, write_stdin (on_exit to change wake), or kill_session.");
	return lines;
}

function updateRunningSessionsUi(ctx: ExtensionCtx, opts: { showWidget?: boolean; notifyTree?: boolean } = {}): void {
	const ui = ctx.ui;
	if (!ui) return;
	const sessions = runningSessions(ctx);
	const status = sessions.length ? `unified-exec: ${sessions.length} ${plural(sessions.length, "session")} running` : undefined;
	ui.setStatus(SESSION_UI_KEY, status);

	if (opts.notifyTree && sessions.length > 0) {
		ui.notify(
			`unified-exec: ${sessions.length} ${plural(sessions.length, "session")} still running after /tree.`,
			"warning",
		);
	}

	if (sessions.length === 0) {
		if (ctx.widgetVisible) {
			ui.setWidget(SESSION_UI_KEY, undefined);
			ctx.widgetVisible = false;
		}
		return;
	}

	if (opts.showWidget || ctx.widgetVisible) {
		ui.setWidget(SESSION_UI_KEY, formatRunningSessionsWidget(ctx, sessions), { placement: "aboveEditor" });
		ctx.widgetVisible = true;
	}
}

function watchSessionExit(ctx: ExtensionCtx, session: ExecSession): void {
	ctx.exitUnsubscribers.get(session.id)?.();
	const unsubscribe = session.onExit(() => {
		// Preserve lazy-drain semantics: an exited session stays in the store until
		// write_stdin/list_sessions/kill_session observes it. The UI only reflects
		// currently running processes.
		updateRunningSessionsUi(ctx);
	});
	ctx.exitUnsubscribers.set(session.id, unsubscribe);
}

function unwatchSessionExit(ctx: ExtensionCtx, id: number): void {
	ctx.exitUnsubscribers.get(id)?.();
	ctx.exitUnsubscribers.delete(id);
}

function removeSession(ctx: ExtensionCtx, id: number): ExecSession | undefined {
	unwatchSessionExit(ctx, id);
	return ctx.store.remove(id);
}

function clearSessionExitWatchers(ctx: ExtensionCtx): void {
	for (const unsubscribe of ctx.exitUnsubscribers.values()) {
		unsubscribe();
	}
	ctx.exitUnsubscribers.clear();
}

/** Shared streaming-update payload for attached waits. */
function buildStreamUpdate(
	session: ExecSession,
	onExit: ResponseShape["on_exit"],
	extra?: Partial<ProcessResultDetails>,
): AgentToolResult<ProcessUpdateDetails> {
	const tailText = sanitizeOutputText(decode(session.snapshotStreamTail()));
	return {
		content: [{ type: "text", text: tailText }],
		details: {
			session_id: session.id,
			pid: session.pid,
			running: !session.hasExited,
			total_bytes: session.totalBytesSeen,
			tty: session.tty,
			command: session.displayCommand,
			cwd: session.cwd,
			log: session.log,
			...(onExit ? { on_exit: onExit } : {}),
			// Populate `output` so renderResult has a single source regardless
			// of streaming vs final state.
			output: tailText,
			...extra,
		},
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
	getOnExit: () => ResponseShape["on_exit"],
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
			ctx.ui?.notify(
				`unified-exec: failed to deliver completion notification: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		},
	});
	const ctx: ExtensionCtx = {
		coordinator,
		// Eviction UI (status clear + warning) is handled at the insert site;
		// no onEvict callback needed.
		store: new SessionStore({ maxSessions: MAX_SESSIONS, lruProtectedCount: LRU_PROTECTED_COUNT }),
		ui: undefined,
		widgetVisible: false,
		exitUnsubscribers: new Map(),
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
		ctx.ui = eventCtx.ui;
		ctx.shuttingDown = false; // reload/new/resume re-arms the extension
		ctx.steer.reset();
		ctx.coordinator.reset(); // never resurrect wakes from a previous session
		updateRunningSessionsUi(ctx);
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
		ctx.ui = eventCtx.ui;
		updateRunningSessionsUi(ctx, { showWidget: true, notifyTree: runningSessions(ctx).length > 0 });
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
				s.terminate();
				drained.push(s);
			}
		}
		clearSessionExitWatchers(ctx);
		updateRunningSessionsUi(ctx);
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
		if (drained.length && ctx.ui) {
			const leftover = drained.filter((s) => !s.hasExited).length;
			ctx.ui.notify(
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
			ctx.ui = cmdCtx.ui;
			// Reap silently-exited sessions first so the picker only shows live ones.
			for (const s of ctx.store.values()) {
				if (s.hasExited) removeSession(ctx, s.id);
			}
			updateRunningSessionsUi(ctx);
			const sessions = runningSessions(ctx);
			if (sessions.length === 0) {
				cmdCtx.ui.notify("unified-exec: no live sessions", "info");
				return;
			}
			const now = Date.now();
			const labels = sessions.map((s) => {
				const wake = ctx.coordinator.isArmed(s.id) ? " [wake]" : "";
				const held = s.shellExited ? " (shell exited, pipe held)" : "";
				return `#${s.id} ${formatElapsed(now - s.startedAt)}${wake}${held} ${oneLineCommand(s.displayCommand, 60)}`;
			});
			const KILL_ALL = `Kill all ${sessions.length} ${plural(sessions.length, "session")}`;
			const choice = await cmdCtx.ui.select(
				`unified-exec: ${sessions.length} live ${plural(sessions.length, "session")} — select to kill (Esc to cancel)`,
				[...labels, KILL_ALL],
			);
			if (!choice) return;
			const targets = choice === KILL_ALL ? sessions : sessions.filter((s) => choice.startsWith(`#${s.id} `));
			let killed = 0;
			let failed = 0;
			for (const s of targets) {
				const outcome = await terminateSessionById(ctx, s.id, "SIGTERM");
				if (outcome?.killed) killed++;
				else if (outcome) failed++;
			}
			updateRunningSessionsUi(ctx);
			cmdCtx.ui.notify(
				`unified-exec: killed ${killed} ${plural(killed, "session")}` +
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
			'Run a command in a persistent session. `[running #N]` means pass N as session_id to write_stdin; `[exited ok]` or `[exited error N]` means the command finished. on_exit defaults to "none". Only pass on_exit: "wake" when the human explicitly wants auto-resume on unobserved exit — stale wakes interrupt later work. Use write_stdin with on_exit to change the policy.',
		promptSnippet: "Run a routine shell command or an async/interactive task",
		promptGuidelines: [
			`exec_command: For routine commands do not set yield_time_ms to below ${DEFAULT_EXEC_YIELD_MS}, unless it's a background/async/interactive task. The yield_time_ms of the final write_stdin should also not be set below ${DEFAULT_EXEC_YIELD_MS}.`,
			"exec_command: For interactive tasks, start with a brief yield (1000ms). Don't set yield too low, you still need it to boot up.",
			`exec_command: For async/background tasks, you can start with a very low yield (${MIN_YIELD_TIME_MS}ms).`,
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
					description: `How long (ms) this call stays attached waiting for output before yielding — an attachment window, not the command's lifetime or completion timeout. Default ${DEFAULT_EXEC_YIELD_MS}, clamped to [${MIN_YIELD_TIME_MS}, ${MAX_YIELD_TIME_MS}].`,
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
			ctx.ui ??= eventCtx.ui;
			const steerSignal = steerSignalFor(ctx, toolCallId, eventCtx);
			const shape = await runExecCommand(ctx, params, signal, steerSignal, onUpdate, eventCtx.cwd);
			updateRunningSessionsUi(ctx);
			const structuredContent = execCommandScriptResult(shape);
			return {
				content: [{ type: "text", text: structuredContent.text }],
				details: shape,
				structuredContent,
			};
		},
		renderCall: renderExecCommandCall,
		renderResult: renderProcessResult,
	});

	pi.registerTool({
		name: "write_stdin",
		label: "write_stdin",
		description:
			"Send input, poll for output or exit, or change a session's wake policy. Use `chars` for text with C-style escapes (e.g. \\x03 Ctrl-C, \\x1b ESC, \\n newline) and `chars_b64` for raw binary. With on_exit and neither input nor yield_time_ms, update the policy and collect available output without waiting for exit. Empty polls accept a finite relative yield_time_ms with no built-in maximum. The reply keeps the session ID at exit.",
		promptSnippet: "Send input, poll or collect output, or change a session's wake policy",
		promptGuidelines: [
			"write_stdin: Don't use chars and chars_b64 at the same time.",
			'write_stdin: Only set on_exit to "wake" when the human asks for auto-resume. To disarm a pending wake promptly, use on_exit: "none" with just the session ID. An exit collected by a poll consumes its wake.',
			"write_stdin: In tty sessions, submit lines with \\r (the Enter key) rather than \\n: POSIX terminals accept both, but Windows console programs only execute input on \\r.",
			"exec_command & write_stdin: For very noisy jobs, rely on the log and final/truncated output instead of repeatedly polling.",
			`exec_command, write_stdin, kill_session, list_sessions: If the tool output contains a log number, you can read ${OUTPUT_LOG_PATH_TEMPLATE.replace("<log>", "<log number>")} under Pi's cwd for the full command output`,
			"exec_command, write_stdin & kill_session: In codemode, results are { details, text }. Use r.details for structured data such as status and session_id, or call text(r.text) to display the formatted reply.",
		],
		outputSchema: writeStdinScriptResultSchema,
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session id from exec_command." }),
			chars: Type.Optional(
				Type.String({
					description:
						"Text with C-style escapes: \\xHH, \\uHHHH, \\u{H\u2026}, \\n \\r \\t \\0 \\a \\e \\b \\f \\v \\\\ \\\". Unknown \\X preserved literally. Mutually exclusive with chars_b64.",
				}),
			),
			chars_b64: Type.Optional(
				Type.String({
					description: "Raw bytes (base64) to write. Mutually exclusive with chars.",
				}),
			),
			yield_time_ms: Type.Optional(
				Type.Number({
					description: `Attachment window, same as exec_command. When input exists: default is ${DEFAULT_WRITE_STDIN_YIELD_MS}, clamped to [${MIN_YIELD_TIME_MS}, ${MAX_YIELD_TIME_MS}]. Otherwise, default/minimum is ${MIN_EMPTY_YIELD_TIME_MS}, no built-in maximum.`,
				}),
			),
			on_exit: Type.Optional(StringEnum(
				["none", "wake"] as const,
				'Omit to keep the policy. "none" disarms a pending wake. "wake" arms a live session. Passing on_exit includes the current wake status in the reply. Without input or yield_time_ms, collect available output without waiting for exit.',
			)),
		}),
		async execute(toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const steerSignal = steerSignalFor(ctx, toolCallId, eventCtx);
			const shape = await runWriteStdin(ctx, params, signal, steerSignal, onUpdate, toolCallId);
			updateRunningSessionsUi(ctx);
			const structuredContent = writeStdinScriptResult(shape);
			return {
				content: [{ type: "text", text: structuredContent.text }],
				details: shape,
				structuredContent,
			};
		},
		renderCall: renderWriteStdinCall,
		renderResult: renderProcessResult,
	});

	pi.registerTool({
		name: "kill_session",
		label: "kill_session",
		description:
			"Terminate a session with SIGTERM, escalating to SIGKILL after 2s on POSIX; Windows force-kills all session processes for any signal. Returns `[killed #N]` or `[kill failed #N]`, with total_time for known sessions. A successful kill invalidates the session ID and suppresses its wake; an unconfirmed kill keeps the session registered.",
		promptSnippet: "Terminate a session",
		outputSchema: killScriptResultSchema,
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session to terminate." }),
			signal: Type.Optional(
				Type.String({ description: 'Initial signal (default "SIGTERM"). Examples: SIGINT, SIGHUP, SIGKILL.' }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const sid = (params as { session_id: number; signal?: string }).session_id;
			const initial = normalizeSignal((params as { signal?: string }).signal);
			const startedAt = Date.now();
			const outcome = await terminateSessionById(ctx, sid, initial);
			if (!outcome) {
				const structuredContent = killNotFoundScriptResult(sid);
				return {
					content: [{ type: "text", text: structuredContent.text }],
					details: {
						operation: "kill_session",
						status: "kill_failed",
						running: false,
						session_id: sid,
						found: false,
					} as const,
					structuredContent,
				};
			}
			const { session, escalated, collected, killed, onExit } = outcome;
			updateRunningSessionsUi(ctx);
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
			const structuredContent = killScriptResult(details);
			return {
				content: [{ type: "text", text: structuredContent.text }],
				details,
				structuredContent,
			};
		},
		renderCall: renderKillSessionCall,
		renderResult: renderKillSessionResult,
	});

	pi.registerTool({
		name: "list_sessions",
		label: "list_sessions",
		description: "List live unified-exec sessions and unreported exits in this Pi run.",
		promptSnippet: "List live sessions and unreported exits",
		outputSchema: listSessionsScriptResultSchema,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			// Reap any sessions that have exited silently (e.g., completed between
			// tool calls without anyone observing them) — but report each of them
			// one final time with exit info instead of dropping them on the floor.
			// This mirrors codex's `refresh_process_state` filter while preserving
			// our "exit information is never silently lost" guarantee.
			let justExited = 0;
			const now = Date.now();
			const sessions = ctx.store.values()
				.sort((a, b) => a.id - b.id)
				.map((s) => {
					const running = !s.hasExited;
					const wake = ctx.coordinator.onExitStatus(s);
					const onExit = wake && !running ? "consumed" : wake;
					if (!running) {
						// Reporting terminal completion consumes any pending wake.
						ctx.coordinator.observeViaListing(s.id);
						removeSession(ctx, s.id);
						justExited++;
					}
					return {
						session_id: s.id,
						command: s.displayCommand,
						cwd: s.cwd,
						tty: s.tty,
						pid: s.pid,
						started_at_ms: s.startedAt,
						elapsed_ms: now - s.startedAt,
						running,
						...(onExit ? { on_exit: onExit } : {}),
						wake_armed: ctx.coordinator.isArmed(s.id),
						exit_code: running ? undefined : s.exitCode,
						signal: running ? undefined : (s.signal ?? undefined),
						failure_message: s.failureMessage ?? undefined,
						log: s.log,
					};
				});
			updateRunningSessionsUi(ctx);
			const active = sessions.length - justExited;
			const lines = sessions.length
				? sessions.map((s) => {
						const exitedSuffix = s.running
							? ""
							: `  [exited${s.exit_code !== undefined && s.exit_code !== null ? ` exit_code=${s.exit_code}` : ""}${s.signal ? ` signal=${s.signal}` : ""}; removed from store]`;
						const wake = s.on_exit ? `\n        on_exit: ${s.on_exit}` : "";
						return `  ${String(s.session_id).padStart(3)}  pid=${String(s.pid ?? "?").padStart(6)}  ${
							s.tty ? "tty" : "pipe"
						}  ${formatElapsed(s.elapsed_ms).padStart(8)}  ${oneLineCommand(s.command, 60)}${exitedSuffix}${wake}${s.log ? `\n        log: ${s.log}` : ""}`;
					})
				: ["  (no live sessions)"];
			const header = justExited
				? `unified-exec sessions (${active} live, ${justExited} just exited):`
				: `unified-exec sessions (${active}):`;
			const details = { sessions, active_count: active, just_exited_count: justExited };
			return {
				content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
				details,
				structuredContent: listSessionsScriptResult(details),
			};
		},
		renderCall: renderListSessionsCall,
		renderResult: renderListSessionsResult,
	});

	// Shadows native codemode at session start without replacing
	// builtin:codemode. Presentation only, for every nested tool.
	registerCompactCodemode(pi);
}
