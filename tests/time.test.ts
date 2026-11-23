/** Unit tests for duration formatting and empty-poll limits. */

import { strict as assert } from "node:assert";
import { describe, it } from "bun:test";
import { formatWallTime } from "../src/format-time.ts";
import { MAX_EMPTY_POLL_ENV_VAR, resolveEmptyPollYield, resolveMaxEmptyPollMs } from "../src/time.ts";

describe("formatWallTime", () => {
	it("uses milliseconds, four significant digits, and whole seconds at the requested boundaries", () => {
		for (const [seconds, expected] of [
			[0, "0ms"],
			[0.012, "12ms"],
			[0.999, "999ms"],
			[1, "1s"],
			[1.2, "1.2s"],
			[10, "10s"],
			[12.3, "12.3s"],
			[100, "100s"],
			[1.23456, "1.235s"],
			[12.3456, "12.35s"],
			[567.84, "567.8s"],
			[999.96, "1000s"],
			[1000, "1000s"],
			[12345.6, "12346s"],
		] as const) {
			assert.equal(formatWallTime(seconds), expected);
		}
	});
});

describe("empty relative poll policy", () => {
	it("keeps a short default and minimum, without a built-in maximum", () => {
		for (const value of [undefined, 0, 0.5, 250, 4999]) {
			assert.equal(resolveEmptyPollYield(value, {}), 5000);
		}
		for (const value of [290_001, 900_000, 86_400_000, Number.MAX_SAFE_INTEGER]) {
			assert.equal(resolveEmptyPollYield(value, {}), value);
		}
		assert.equal(resolveEmptyPollYield(5000.9, {}), 5000);
	});

	it("rejects invalid tool durations rather than overflowing timers", () => {
		for (const value of [NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
			assert.throws(() => resolveEmptyPollYield(value, {}), /non-negative finite/);
		}
	});

	it("keeps explicit operator limits and rejects invalid configuration", () => {
		assert.equal(resolveMaxEmptyPollMs({}), undefined);
		assert.equal(resolveMaxEmptyPollMs({ [MAX_EMPTY_POLL_ENV_VAR]: "  " }), undefined);
		assert.equal(resolveMaxEmptyPollMs({ [MAX_EMPTY_POLL_ENV_VAR]: "1000" }), 5000);
		const env = { [MAX_EMPTY_POLL_ENV_VAR]: "900000" };
		assert.equal(resolveEmptyPollYield(900_000, env), 900_000);
		assert.throws(() => resolveEmptyPollYield(900_001, env), /configured empty-poll cap.*Request a shorter wait\.$/);
		for (const raw of ["0", "-1", "NaN", "Infinity", "oops", "9007199254740992"]) {
			assert.throws(() => resolveMaxEmptyPollMs({ [MAX_EMPTY_POLL_ENV_VAR]: raw }), /positive finite/);
		}
	});
});
