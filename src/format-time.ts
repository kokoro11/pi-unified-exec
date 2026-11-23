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

/** Millisecond-input counterpart to formatWallTime. */
export function formatElapsed(ms: number): string {
	return formatWallTime(Math.max(0, ms) / 1000);
}
