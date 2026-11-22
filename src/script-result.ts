/**
 * Script-facing results for Pi codemode.
 *
 * For exec_command and write_stdin, `text` is the formatted tool reply and
 * `details` holds typed state and the bounded, sanitized output tail.
 */

import { Type, type Static } from "typebox";

import type { OnExitPolicy } from "./completion.ts";
import { MIN_LOG_BYTES, OUTPUT_LOG_PATH_TEMPLATE } from "./output-log.ts";
import { type KillResultDetails, type ProcessResultDetails, renderProcessResultText, safeMeta } from "./tool-result.ts";

const optionalMeta = (value: string | undefined): string | undefined => (value ? safeMeta(value) : undefined);

/** Drop undefined fields so the value is plain JSON. */
function compact<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
	return value;
}

const logSchema = Type.Optional(Type.Integer({
	minimum: 1,
	description: `Log sequence number; present at ${MIN_LOG_BYTES} cumulative output bytes. Read ${OUTPUT_LOG_PATH_TEMPLATE} under Pi's cwd.`,
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

const processScriptDetailsSchema = Type.Object({
	status: Type.Union([Type.Literal("running"), Type.Literal("exited")]),
	running: Type.Boolean(),
	session_id: Type.Optional(
		Type.Number({ description: "Session ID, retained on write_stdin exit results. Check running before polling again." }),
	),
	...outputFields,
	total_time_seconds: Type.Optional(Type.Number({
		description: "Session lifetime in seconds, reported by write_stdin; stops when the session exits.",
	})),
	note: Type.Optional(Type.String()),
	wait_status: Type.Optional(Type.String()),
	on_exit: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("wake")])),
});

export const processScriptResultSchema = Type.Object({
	details: processScriptDetailsSchema,
	text: Type.String({ description: "Formatted tool reply with process status and output." }),
});
export type ProcessScriptResult = Static<typeof processScriptResultSchema>;

export function processScriptResult(shape: ProcessResultDetails): ProcessScriptResult {
	return {
		details: compact({
			status: shape.status,
			running: shape.running,
			session_id: shape.session_id,
			output: shape.output,
			truncated: shape.truncation?.truncated === true,
			omitted_bytes: shape.omitted_bytes || undefined,
			exit_code: shape.exit_code,
			signal: optionalMeta(shape.signal),
			failure_message: optionalMeta(shape.failure_message),
			log: shape.log,
			wall_time_seconds: shape.wall_time_seconds,
			total_time_seconds: shape.total_time_seconds,
			note: optionalMeta(shape.note),
			wait_status: shape.wait_status,
			on_exit: shape.on_exit,
		}),
		text: renderProcessResultText(shape),
	};
}

export const killScriptResultSchema = Type.Object({
	status: Type.Union([Type.Literal("killed"), Type.Literal("kill_failed")]),
	found: Type.Boolean({ description: "False when no session had this id." }),
	killed: Type.Boolean(),
	running: Type.Boolean({ description: "True when the kill was not confirmed and the session remains registered." }),
	escalated: Type.Boolean({ description: "True when SIGKILL escalation was needed." }),
	session_id: Type.Number(),
	...outputFields,
});
export type KillScriptResult = Static<typeof killScriptResultSchema>;

export function killScriptResult(shape: KillResultDetails): KillScriptResult {
	return compact({
		status: shape.status,
		found: true,
		killed: shape.killed,
		running: shape.running,
		escalated: shape.escalated,
		session_id: shape.session_id,
		output: shape.output,
		truncated: shape.truncation?.truncated === true,
		omitted_bytes: shape.omitted_bytes || undefined,
		exit_code: shape.exit_code,
		signal: optionalMeta(shape.signal),
		failure_message: optionalMeta(shape.failure_message),
		log: shape.log,
		wall_time_seconds: shape.wall_time_seconds,
	});
}

export function killNotFoundScriptResult(sessionId: number): KillScriptResult {
	return {
		status: "kill_failed",
		found: false,
		killed: false,
		running: false,
		escalated: false,
		session_id: sessionId,
		output: "",
		truncated: false,
		wall_time_seconds: 0,
	};
}

export const setOnExitScriptResultSchema = Type.Object({
	session_id: Type.Number(),
	found: Type.Boolean({ description: "False when no session or pending wake had this id." }),
	on_exit: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("wake")])),
	status: Type.Optional(Type.String()),
	running: Type.Optional(Type.Boolean()),
	wake_armed: Type.Optional(Type.Boolean()),
});
export type SetOnExitScriptResult = Static<typeof setOnExitScriptResultSchema>;

export function setOnExitScriptResult(value: {
	session_id: number;
	found: boolean;
	on_exit?: OnExitPolicy;
	status?: string;
	running?: boolean;
	wake_armed?: boolean;
}): SetOnExitScriptResult {
	return compact({ ...value });
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
