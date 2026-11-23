import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";

import type { CollectResult } from "./collect.ts";
import type { OnExitStatus } from "./completion.ts";
import { formatWallTime } from "./format-time.ts";
import { sanitizeOutputText } from "./output-safety.ts";
import type { ExecSession } from "./session.ts";

const textDecoder = new TextDecoder("utf-8", { fatal: false });

export type ProcessOperation = "exec_command" | "write_stdin";
export type ProcessStatus = "running" | "exited";
export type KillStatus = "killed" | "kill_failed";

/** Next-step guidance shared by process results and terminal renderers. */
export const WAIT_CANCELLED =
	"Follow the user's latest instruction before polling this session again. " +
	"The wait was cancelled; the process is still running and buffering output.";
export const WAIT_STEERED =
	"Read and address the user's steering message first. The process is still running and buffering output; " +
	"poll this session again only if it is still relevant.";

/** Fields shared by every result that carries child-process output. */
export interface OutputResultDetails {
	operation: ProcessOperation | "kill_session";
	status: ProcessStatus | KillStatus;
	running: boolean;
	wall_time_seconds: number;
	/** Session lifetime in seconds, frozen at exit when reported. */
	total_time_seconds?: number;
	/** Bounded, terminal-inert tail sent to the model and used by the TUI renderer. */
	output: string;
	session_id?: number;
	exit_code?: number;
	signal?: string;
	failure_message?: string;
	tty?: boolean;
	log?: number;
	on_exit?: OnExitStatus | "none";
	cwd?: string;
	command?: string;
	truncation?: TruncationResult;
	/** Middle bytes dropped by the in-memory retention cap before result truncation. */
	omitted_bytes?: number;
	/** Optional explanation of an unusual session state (e.g. shell exited but pipe held open). */
	note?: string;
}

export interface ProcessResultDetails extends OutputResultDetails {
	operation: ProcessOperation;
	status: ProcessStatus;
	yield_time_ms?: number;
	/** Plain-language guidance present only when a wait is cancelled or steered. */
	wait_status?: string;
	completion_delivery?: "direct";
}

export interface KillResultDetails extends OutputResultDetails {
	operation: "kill_session";
	status: KillStatus;
	on_exit?: OnExitStatus;
	found: true;
	session_id: number;
	total_time_seconds: number;
	pid?: number;
	requested_signal: string;
	escalated: boolean;
}

interface OutputResultInput {
	wallTimeSec: number;
	collected: Uint8Array;
	log?: number;
	/** Middle bytes dropped by the retention cap during this call's drain. */
	omittedBytes?: number;
	exitCode: number | null | undefined;
	signal: NodeJS.Signals | null;
	failure: string | null;
	tty: boolean;
	cwd?: string;
	command?: string;
}

export type ProcessResultMetadata = Pick<ProcessResultDetails, "completion_delivery" | "on_exit" | "wait_status" | "note">;

interface FinalizeProcessInput extends OutputResultInput {
	operation: ProcessOperation;
	running: boolean;
	sessionId: number | undefined;
	yieldTimeMs?: number;
	metadata?: ProcessResultMetadata;
}

interface FinalizeKillInput extends OutputResultInput {
	sessionId: number;
	totalTimeSec: number;
	pid?: number;
	requestedSignal: NodeJS.Signals;
	escalated: boolean;
	killed: boolean;
	onExit?: OnExitStatus;
}

export function safeMeta(value: string, max = 4096): string {
	// Metadata sits outside the 50 KiB child-output body. Bound both the scan and
	// rendered value so a malformed path/error cannot recreate an oversized
	// result through a header field.
	const scanLimit = max * 8;
	let end = Math.min(value.length, scanLimit);
	if (end < value.length && end > 0 && /[\ud800-\udbff]/.test(value[end - 1]!)) end--;
	const clipped = end < value.length;
	const clean = sanitizeOutputText(value.slice(0, end)).replace(/\s+/g, " ").trim();
	if (!clipped && clean.length <= max) return clean;
	return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

type OutputEnvelope = Pick<OutputResultDetails, "wall_time_seconds" | "output" | "log" | "truncation" | "omitted_bytes">;

function createOutputEnvelope(input: OutputResultInput): OutputEnvelope {
	const safeText = sanitizeOutputText(textDecoder.decode(input.collected));
	const truncation = truncateTail(safeText, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	const envelope: OutputEnvelope = {
		wall_time_seconds: input.wallTimeSec,
		output: truncation.content,
	};
	if (input.log) envelope.log = input.log;
	if (input.omittedBytes) envelope.omitted_bytes = input.omittedBytes;
	if (truncation.truncated) envelope.truncation = truncation;
	return envelope;
}

function addProcessMetadata(shape: OutputResultDetails, input: OutputResultInput): void {
	if (input.exitCode != null) shape.exit_code = input.exitCode;
	if (input.signal) shape.signal = input.signal;
	if (input.failure) shape.failure_message = input.failure;
	if (input.cwd) shape.cwd = input.cwd;
	if (input.command) shape.command = input.command;
}

export function finalizeProcessResult(input: FinalizeProcessInput): ProcessResultDetails {
	const envelope = createOutputEnvelope(input);
	const shape: ProcessResultDetails = {
		...envelope,
		operation: input.operation,
		status: input.running ? "running" : "exited",
		running: input.running,
		tty: input.tty,
	};
	if (input.sessionId !== undefined) shape.session_id = input.sessionId;
	addProcessMetadata(shape, input);
	if (input.yieldTimeMs) shape.yield_time_ms = input.yieldTimeMs;
	const metadata = input.metadata;
	if (metadata?.completion_delivery !== undefined) shape.completion_delivery = metadata.completion_delivery;
	if (metadata?.on_exit !== undefined) shape.on_exit = metadata.on_exit;
	if (metadata?.wait_status !== undefined) shape.wait_status = metadata.wait_status;
	if (metadata?.note !== undefined) shape.note = metadata.note;
	return shape;
}

export function finalizeSessionResult(
	session: ExecSession,
	collected: CollectResult,
	input: Pick<FinalizeProcessInput, "operation" | "running" | "wallTimeSec" | "failure" | "yieldTimeMs" | "metadata">,
): ProcessResultDetails {
	const { operation, running, wallTimeSec, failure, yieldTimeMs, metadata } = input;
	return finalizeProcessResult({
		operation,
		running,
		wallTimeSec,
		collected: collected.bytes,
		omittedBytes: collected.omittedBytes,
		sessionId: running || operation === "write_stdin" ? session.id : undefined,
		exitCode: running ? undefined : session.exitCode,
		signal: running ? null : session.signal,
		failure,
		tty: session.tty,
		log: session.log,
		cwd: session.cwd,
		command: session.displayCommand,
		yieldTimeMs,
		metadata,
	});
}

export function finalizeKillResult(input: FinalizeKillInput): KillResultDetails {
	const envelope = createOutputEnvelope(input);
	const shape: KillResultDetails = {
		...envelope,
		operation: "kill_session",
		status: input.killed ? "killed" : "kill_failed",
		running: !input.killed,
		found: true,
		session_id: input.sessionId,
		total_time_seconds: input.totalTimeSec,
		requested_signal: input.requestedSignal,
		escalated: input.escalated,
		tty: input.tty,
	};
	if (input.pid !== undefined) shape.pid = input.pid;
	if (input.onExit) shape.on_exit = input.onExit;
	addProcessMetadata(shape, input);
	return shape;
}

/** Pi-bash-style marker appended to model-visible text after a truncated body. */
export function truncationMarker(t: TruncationResult | undefined, log: number | undefined): string | null {
	if (!t?.truncated) return null;
	const full = log ? `. Full output: ${log}` : "";
	if (t.lastLinePartial) {
		return `[Showing last ${formatSize(t.outputBytes)} of final line (line ${t.totalLines} is larger than the ${formatSize(DEFAULT_MAX_BYTES)} limit)${full}]`;
	}
	const startLine = t.totalLines - t.outputLines + 1;
	const endLine = t.totalLines;
	if (t.truncatedBy === "lines") {
		return `[Showing lines ${startLine}-${endLine} of ${t.totalLines}${full}]`;
	}
	return `[Showing lines ${startLine}-${endLine} of ${t.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit)${full}]`;
}

function appendOutputSection(lines: string[], shape: OutputResultDetails): string {
	const header = lines.join("\n");
	const body = shape.output || "(no output)";
	const marker = truncationMarker(shape.truncation, shape.log);
	const footer = marker ? `\n\n${marker}` : "";
	return `${header}\n---\n${body}${footer}`;
}

function appendExitDiagnostics(lines: string[], shape: OutputResultDetails): void {
	if (shape.signal) lines.push(`signal: ${safeMeta(shape.signal)}`);
	if (shape.failure_message) lines.push(`failure: ${safeMeta(shape.failure_message)}`);
}

function finishOutputResult(lines: string[], shape: OutputResultDetails): string {
	if (shape.on_exit) lines.push(`on_exit: ${shape.on_exit}`);
	if (shape.log && !shape.truncation?.truncated) lines.push(`log: ${shape.log}`);
	const wallTime = formatWallTime(shape.wall_time_seconds);
	if (wallTime !== "0ms") lines.push(`wall_time: ${wallTime}`);
	if (shape.total_time_seconds !== undefined) lines.push(`total_time: ${formatWallTime(shape.total_time_seconds)}`);
	if (shape.omitted_bytes) lines.push(`omitted_bytes: ${shape.omitted_bytes}`);
	return appendOutputSection(lines, shape);
}

export function renderProcessResultText(shape: ProcessResultDetails): string {
	const id = shape.session_id === undefined ? "" : ` #${shape.session_id}`;
	const outcome = shape.exit_code === 0 ? "ok" : shape.exit_code === undefined ? "error" : `error ${shape.exit_code}`;
	const lines = [shape.running ? `[running${id}]` : `[exited${id} ${outcome}]`];
	appendExitDiagnostics(lines, shape);
	if (shape.note) lines.push(`note: ${safeMeta(shape.note)}`);
	if (shape.wait_status === WAIT_CANCELLED || shape.wait_status === WAIT_STEERED) {
		lines.push(`wait_status: ${shape.wait_status}`);
	}
	return finishOutputResult(lines, shape);
}

export function renderKillResultText(shape: KillResultDetails): string {
	const outcome = shape.status === "killed" ? "killed" : "kill failed";
	const lines = [`[${outcome} #${shape.session_id}]`];
	if (shape.running && shape.pid !== undefined) lines.push(`pid: ${shape.pid}`);
	if (shape.escalated) lines.push("escalated: true");
	if (shape.exit_code !== undefined) lines.push(`exit_code: ${shape.exit_code}`);
	appendExitDiagnostics(lines, shape);
	return finishOutputResult(lines, shape);
}
