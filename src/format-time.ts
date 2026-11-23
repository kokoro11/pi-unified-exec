/**
 * Shared human-readable duration formatters for tool replies, TUI banners,
 * widgets, and wake metadata. Keep wall-clock math in callers.
 */

/** Integer ms below 1s; four significant digits without trailing decimal zeroes below 1000s; then integer seconds. */
export function formatWallTime(seconds: number): string {
	if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
	if (seconds < 1000) return `${Number(seconds.toPrecision(4))}s`;
	return `${Math.round(seconds)}s`;
}

/** Widget / session lists: floored seconds → `45s`, `2m05s`, `2h40m`. */
export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(totalMinutes / 60);
	return `${hours}h${String(totalMinutes % 60).padStart(2, "0")}m`;
}

/** Wake messages: rounded seconds, same shape as formatElapsed. */
export function formatElapsedShort(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Tool result footer while running: always one decimal second (`1.2s`). */
export function formatDurationSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}
