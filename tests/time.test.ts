/** Unit tests for duration formatting and attachment windows. */

import { strict as assert } from "node:assert";
import { describe, it } from "bun:test";
import { formatElapsed, formatWallTime } from "../src/format-time.ts";
import { MAX_YIELD_ENV_VAR, resolveMaxYieldMs, resolveYieldTimeMs } from "../src/time.ts";

describe("duration formatting", () => {
	it("formats second and millisecond inputs with the same precision", () => {
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
			assert.equal(formatElapsed(seconds * 1000), expected);
		}
		assert.equal(formatElapsed(-1), "0ms");
	});
});

describe("attachment window policy", () => {
	for (const [tool, hasInput, defaultMs] of [
		["exec_command", false, 10_000],
		["write_stdin", false, 10_000],
		["write_stdin", true, 250],
	] as const) {
		it(`${tool}${hasInput ? " with input" : ""} uses its default and accepts any non-negative finite duration`, () => {
			assert.equal(resolveYieldTimeMs(tool, undefined, hasInput, {}), defaultMs);
			for (const ms of [0, 0.5, 25.9, 30_001, Number.MAX_VALUE]) {
				assert.equal(resolveYieldTimeMs(tool, ms, hasInput, {}), Math.floor(ms));
			}
			for (const ms of [NaN, Infinity, -Infinity, -1]) {
				assert.throws(() => resolveYieldTimeMs(tool, ms, hasInput, {}), /non-negative finite/);
			}
		});

		it(`${tool}${hasInput ? " with input" : ""} clamps both default and explicit waits`, () => {
			for (const cap of [0, 100, 1000, 90_000]) {
				const env = { [MAX_YIELD_ENV_VAR]: `${cap}.9` };
				assert.equal(resolveYieldTimeMs(tool, undefined, hasInput, env), Math.min(defaultMs, cap));
				assert.equal(resolveYieldTimeMs(tool, 0, hasInput, env), 0);
				assert.equal(resolveYieldTimeMs(tool, cap, hasInput, env), cap);
				assert.equal(resolveYieldTimeMs(tool, cap + 1, hasInput, env), cap);
			}
		});
	}

	it("treats blank configuration as uncapped and rejects invalid caps", () => {
		assert.equal(resolveMaxYieldMs({}), undefined);
		assert.equal(resolveMaxYieldMs({ [MAX_YIELD_ENV_VAR]: "  " }), undefined);
		for (const raw of ["-1", "NaN", "Infinity", "oops"]) {
			assert.throws(() => resolveMaxYieldMs({ [MAX_YIELD_ENV_VAR]: raw }), /non-negative finite/);
		}
	});
});
