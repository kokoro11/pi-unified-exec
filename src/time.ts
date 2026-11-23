/** Empty-poll duration policy. */

import { formatElapsed } from "./format-time.ts";

export const MIN_EMPTY_YIELD_TIME_MS = 5_000;
export const MAX_EMPTY_POLL_ENV_VAR = "PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS";

/** No built-in cap. An invalid explicit limit must not silently disable protection. */
export function resolveMaxEmptyPollMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env[MAX_EMPTY_POLL_ENV_VAR]?.trim();
	if (!raw) return undefined;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > Number.MAX_SAFE_INTEGER) {
		throw new Error(`${MAX_EMPTY_POLL_ENV_VAR} must be a positive finite duration no greater than Number.MAX_SAFE_INTEGER.`);
	}
	return Math.max(MIN_EMPTY_YIELD_TIME_MS, Math.floor(parsed));
}

/** Normalize an empty poll without imposing a provider-cache lifetime. */
export function resolveEmptyPollYield(ms: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
	if (ms !== undefined && (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > Number.MAX_SAFE_INTEGER)) {
		throw new Error("write_stdin: yield_time_ms must be a non-negative finite duration no greater than Number.MAX_SAFE_INTEGER.");
	}
	const duration = Math.max(MIN_EMPTY_YIELD_TIME_MS, Math.floor(ms ?? MIN_EMPTY_YIELD_TIME_MS));
	const cap = resolveMaxEmptyPollMs(env);
	if (cap !== undefined && duration > cap) {
		throw new Error(
			`write_stdin: yield_time_ms ${duration} exceeds the configured empty-poll cap of ${formatElapsed(cap)} ` +
				`(${MAX_EMPTY_POLL_ENV_VAR}). Request a shorter wait.`,
		);
	}
	return duration;
}
