/** Attachment duration policy shared by all process tools that wait for output. */

export const DEFAULT_YIELD_MS = 10_000;
export const DEFAULT_INPUT_YIELD_MS = 250;
export const MAX_YIELD_ENV_VAR = "PI_UNIFIED_EXEC_MAX_YIELD_MS";

/** No built-in cap. An invalid explicit limit must not silently disable protection. */
export function resolveMaxYieldMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env[MAX_YIELD_ENV_VAR]?.trim();
	if (!raw) return undefined;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`${MAX_YIELD_ENV_VAR} must be a non-negative finite duration in milliseconds.`);
	}
	return Math.floor(parsed);
}

export function resolveYieldTimeMs(
	tool: "exec_command" | "write_stdin",
	ms: number | undefined,
	hasInput = false,
	env: NodeJS.ProcessEnv = process.env,
): number {
	if (ms !== undefined && (!Number.isFinite(ms) || ms < 0)) {
		throw new Error(`${tool}: yield_time_ms must be a non-negative finite duration in milliseconds.`);
	}
	const defaultMs = tool === "write_stdin" && hasInput ? DEFAULT_INPUT_YIELD_MS : DEFAULT_YIELD_MS;
	const duration = ms === undefined ? defaultMs : Math.floor(ms);
	const cap = resolveMaxYieldMs(env);
	return cap === undefined ? duration : Math.min(duration, cap);
}
