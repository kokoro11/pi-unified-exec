/**
 * Script-facing results for Pi codemode.
 *
 * For exec_command, write_stdin, and kill_session, `text` is the formatted tool reply and
 * `details` holds typed state and the bounded, sanitized output tail.
 */

import { Type, type Static } from "typebox";

import type { OnExitStatus } from "./completion.ts";
import {
	type KillResultDetails,
	type OutputResultDetails,
	type ProcessResultDetails,
	renderKillResultText,
	renderProcessResultText,
	safeMeta,
} from "./tool-result.ts";

const optionalMeta = (value: string | undefined): string | undefined => (value ? safeMeta(value) : undefined);

/** Drop undefined fields so the value is plain JSON. */
function compact<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
	return value;
}

const logSchema = Type.Optional(Type.Integer({
	minimum: 1,
	description: "Log sequence number.",
}));

const onExitSchema = Type.Optional(Type.Union([Type.Literal("wake"), Type.Literal("consumed")], {
	description: "Wake policy active, or the wake has already been resolved.",
}));

const outputFields = {
	output: Type.String({
		description: "Bounded, terminal-safe tail of the child output with real newlines.",
	}),
	truncated: Type.Boolean({ description: "True when earlier output was dropped; the full stream is in log." }),
	omitted_bytes: Type.Optional(Type.Number({ description: "Middle bytes dropped by the in-memory retention cap." })),
	exit_code: Type.Optional(Type.Number({ description: "Exit code once the process has exited." })),
	signal: Type.Optional(Type.String({ description: "Signal that terminated the process, if any." })),
	failure_message: Type.Optional(Type.String()),
	log: logSchema,
	wall_time_seconds: Type.Number(),
};

const processScriptDetailFields = {
	status: Type.Union([Type.Literal("running"), Type.Literal("exited")]),
	running: Type.Boolean(),
	...outputFields,
	note: Type.Optional(Type.String()),
	wait_status: Type.Optional(Type.String({ description: "Plain-language guidance present only when a wait is cancelled or steered." })),
};

const processTextSchema = Type.String({ description: "Formatted tool reply with process status and output." });

export const execCommandScriptResultSchema = Type.Object({
	details: Type.Object({
		...processScriptDetailFields,
		on_exit: onExitSchema,
		session_id: Type.Optional(Type.Number({ description: "Session ID when the command is still running." })),
	}),
	text: processTextSchema,
});
export type ExecCommandScriptResult = Static<typeof execCommandScriptResultSchema>;

export const writeStdinScriptResultSchema = Type.Object({
	details: Type.Object({
		...processScriptDetailFields,
		on_exit: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("wake"), Type.Literal("consumed")], {
			description: "Wake status. An explicit on_exit argument always reports the resulting status, including none when no wake is armed or consumed.",
		})),
		session_id: Type.Number({ description: "Session ID, retained on exit. Check running before polling again." }),
		total_time_seconds: Type.Number({ description: "Session lifetime in seconds, frozen at exit." }),
	}),
	text: processTextSchema,
});
export type WriteStdinScriptResult = Static<typeof writeStdinScriptResultSchema>;

function scriptOutputDetails(shape: OutputResultDetails) {
	return {
		output: shape.output,
		truncated: shape.truncation?.truncated === true,
		omitted_bytes: shape.omitted_bytes || undefined,
		exit_code: shape.exit_code,
		signal: optionalMeta(shape.signal),
		failure_message: optionalMeta(shape.failure_message),
		log: shape.log,
		wall_time_seconds: shape.wall_time_seconds,
	};
}

function processScriptResult<T extends Record<string, unknown>>(shape: ProcessResultDetails, fields: T) {
	return {
		details: compact(Object.assign({
			status: shape.status,
			running: shape.running,
		}, scriptOutputDetails(shape), {
			note: optionalMeta(shape.note),
			wait_status: shape.wait_status,
		}, fields)),
		text: renderProcessResultText(shape),
	};
}

export function execCommandScriptResult(shape: ProcessResultDetails): ExecCommandScriptResult {
	return processScriptResult(shape, {
		session_id: shape.session_id,
		on_exit: shape.on_exit === "none" ? undefined : shape.on_exit,
	});
}

export function writeStdinScriptResult(
	shape: ProcessResultDetails & { session_id: number; total_time_seconds: number },
): WriteStdinScriptResult {
	return processScriptResult(shape, {
		session_id: shape.session_id,
		total_time_seconds: shape.total_time_seconds,
		on_exit: shape.on_exit,
	});
}

export const killScriptResultSchema = Type.Object({
	details: Type.Object({
		status: Type.Union([Type.Literal("killed"), Type.Literal("kill_failed")]),
		found: Type.Boolean({ description: "False when no session had this id." }),
		running: Type.Boolean({ description: "True when the kill was not confirmed and the session remains registered." }),
		escalated: Type.Boolean({ description: "True when SIGKILL escalation was needed." }),
		session_id: Type.Number(),
		pid: Type.Optional(Type.Number({ description: "Session process ID, when known. On Windows this is the launcher PID." })),
		total_time_seconds: Type.Optional(Type.Number({
			description: "Session lifetime in seconds, frozen at exit. Omitted when no session had this id.",
		})),
		on_exit: onExitSchema,
		...outputFields,
	}),
	text: Type.String({ description: "Formatted kill result with status, session ID, timing, and output." }),
});
export type KillScriptResult = Static<typeof killScriptResultSchema>;

export function killScriptResult(shape: KillResultDetails): KillScriptResult {
	return {
		details: compact(Object.assign({
			status: shape.status,
			found: true,
			running: shape.running,
			escalated: shape.escalated,
			session_id: shape.session_id,
			pid: shape.pid,
			total_time_seconds: shape.total_time_seconds,
			on_exit: shape.on_exit,
		}, scriptOutputDetails(shape))),
		text: renderKillResultText(shape),
	};
}

export function killNotFoundScriptResult(sessionId: number): KillScriptResult {
	const failure = `No such session: ${sessionId}`;
	return {
		details: {
			status: "kill_failed",
			found: false,
			running: false,
			escalated: false,
			session_id: sessionId,
			output: "",
			truncated: false,
			wall_time_seconds: 0,
			failure_message: failure,
		},
		text: `[kill failed #${sessionId}]\nfailure: ${failure}`,
	};
}

export const listSessionsScriptResultSchema = Type.Object({
	sessions: Type.Array(
		Type.Object({
			session_id: Type.Number(),
			command: Type.String(),
			cwd: Type.Optional(Type.String()),
			tty: Type.Boolean(),
			pid: Type.Optional(Type.Number()),
			elapsed_ms: Type.Number(),
			running: Type.Boolean({ description: "False for sessions that just exited; they are removed after this listing." }),
			on_exit: onExitSchema,
			wake_armed: Type.Boolean(),
			exit_code: Type.Optional(Type.Number()),
			signal: Type.Optional(Type.String()),
			log: logSchema,
		}),
	),
	active_count: Type.Number(),
	just_exited_count: Type.Number(),
});
export type ListSessionsScriptResult = Static<typeof listSessionsScriptResultSchema>;

export function listSessionsScriptResult(value: {
	sessions: ReadonlyArray<{
		session_id: number;
		command: string;
		cwd?: string;
		tty: boolean;
		pid?: number;
		elapsed_ms: number;
		running: boolean;
		on_exit?: OnExitStatus;
		wake_armed: boolean;
		exit_code?: number | null;
		signal?: string;
		log?: number;
	}>;
	active_count: number;
	just_exited_count: number;
}): ListSessionsScriptResult {
	return {
		sessions: value.sessions.map((s) =>
			compact({
				session_id: s.session_id,
				command: safeMeta(s.command),
				cwd: optionalMeta(s.cwd),
				tty: s.tty,
				pid: s.pid,
				elapsed_ms: s.elapsed_ms,
				running: s.running,
				on_exit: s.on_exit,
				wake_armed: s.wake_armed,
				exit_code: s.exit_code ?? undefined,
				signal: optionalMeta(s.signal),
				log: s.log,
			}),
		),
		active_count: value.active_count,
		just_exited_count: value.just_exited_count,
	};
}
