import { strict as assert } from "node:assert";
import { describe, it } from "bun:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

import {
	finalizeKillResult,
	finalizeProcessResult,
	renderKillResultText,
	renderProcessResultText,
} from "../src/tool-result.ts";

const encoder = new TextEncoder();

describe("bounded tool results", () => {
	it("preserves the existing process response contract with explicit operation state", () => {
		const details = finalizeProcessResult({
			operation: "exec_command",
			running: true,
			wallTimeSec: 0.25,
			collected: encoder.encode("hello\nworld\n"),
			sessionId: 7,
			exitCode: undefined,
			signal: null,
			failure: null,
			tty: false,
			log: 1,
			cwd: "/tmp",
			command: "printf hello",
			yieldTimeMs: 250,
		});

		assert.equal(details.operation, "exec_command");
		assert.equal(details.status, "running");
		assert.equal(details.running, true);
		assert.equal(details.session_id, 7);
		assert.equal(details.output, "hello\nworld\n");
		assert.equal(
			renderProcessResultText(details),
			"[running #7]\nlog: 1\nwall_time: 250ms\n---\nhello\nworld\n",
		);
	});

	it("shows an exit without a numeric code and omits a rounded-zero wall time", () => {
		const details = finalizeProcessResult({
			operation: "write_stdin",
			running: false,
			wallTimeSec: 0.0004,
			collected: encoder.encode("stopped"),
			sessionId: 17,
			exitCode: null,
			signal: "SIGTERM",
			failure: null,
			tty: false,
		});
		assert.equal(renderProcessResultText(details), "[exited #17 error]\nsignal: SIGTERM\n---\nstopped");
	});

	it("bounds kill output and puts the recovery marker in model-visible text", () => {
		// Enough short lines to exceed either cap, whichever the host Pi exports first.
		const raw = Array.from({ length: Math.ceil((DEFAULT_MAX_BYTES * 1.2) / 10) }, (_, index) => `line-${index + 1}`).join(
			"\n",
		);
		const details = finalizeKillResult({
			wallTimeSec: 0.5,
			totalTimeSec: 1.5,
			collected: encoder.encode(raw),
			sessionId: 42,
			pid: 1234,
			requestedSignal: "SIGTERM",
			exitCode: undefined,
			signal: "SIGTERM",
			failure: null,
			tty: false,
			log: 42,
			cwd: "/repo",
			command: "noisy-job",
			escalated: false,
			killed: true,
		});

		assert.equal(details.operation, "kill_session");
		assert.equal(details.status, "killed");
		assert.equal(details.running, false);
		assert.equal(details.total_time_seconds, 1.5);
		assert.ok(Buffer.byteLength(details.output, "utf8") <= DEFAULT_MAX_BYTES);
		assert.equal(details.truncation?.truncated, true);
		assert.ok((details.truncation?.outputLines ?? 0) <= DEFAULT_MAX_LINES);
		if (details.truncation?.truncatedBy === "lines") {
			assert.equal(details.truncation.outputLines, DEFAULT_MAX_LINES);
		}
		assert.equal(Object.hasOwn(details, "final_output"), false);

		const text = renderKillResultText(details);
		assert.match(text, /^\[killed #42\]\n/);
		assert.match(text, /^total_time: 1\.5s$/m);
		assert.doesNotMatch(text, /^(?:session_id|pid|running|escalated):/m);
		assert.match(text, /Showing lines/);
		assert.match(text, /Full output: 42\]/);
		assert.ok(Buffer.byteLength(text, "utf8") < DEFAULT_MAX_BYTES + 4096, `text bytes=${Buffer.byteLength(text)}`);
	});

	it("bounds model-visible metadata outside the output body", () => {
		const huge = `bad\x1b]52;c;payload\x07${"x".repeat(100_000)}`;
		const details = finalizeProcessResult({
			operation: "exec_command",
			running: false,
			wallTimeSec: 0,
			collected: encoder.encode("small output"),
			sessionId: undefined,
			exitCode: -1,
			signal: null,
			failure: huge,
			tty: false,
			cwd: huge,
		});
		const text = renderProcessResultText(details);

		assert.ok(Buffer.byteLength(text, "utf8") < 12_000, `text bytes=${Buffer.byteLength(text)}`);
		assert.doesNotMatch(text, /[\u001b\u009b]/);
		assert.match(text, /^\[exited error -1\]\n/);
		assert.match(text, /…/);
	});

	it("makes terminal control sequences inert before storing or rendering output", () => {
		const dangerous = "before\x1b]52;c;YXR0YWNrZXI=\x07after\x1b[?1049h";
		const details = finalizeProcessResult({
			operation: "write_stdin",
			running: true,
			wallTimeSec: 0.1,
			collected: encoder.encode(dangerous),
			sessionId: 5,
			exitCode: undefined,
			signal: null,
			failure: null,
			tty: true,
		});

		assert.equal(details.output, "beforeafter");
		assert.doesNotMatch(renderProcessResultText(details), /[\u001b\u009b]/);
	});

	it("represents a failed kill as a live, retained session", () => {
		const details = finalizeKillResult({
			wallTimeSec: 0,
			totalTimeSec: 15.25,
			collected: encoder.encode("last diagnostic\n"),
			sessionId: 9,
			pid: 999,
			requestedSignal: "SIGTERM",
			exitCode: undefined,
			signal: null,
			failure: "process still running; session remains registered",
			tty: false,
			log: 9,
			escalated: true,
			killed: false,
		});

		assert.equal(details.status, "kill_failed");
		assert.equal(details.running, true);
		const text = renderKillResultText(details);
		assert.match(text, /^\[kill failed #9\]\n/);
		assert.match(text, /^pid: 999$/m);
		assert.match(text, /^escalated: true$/m);
		assert.match(text, /^total_time: 15\.25s$/m);
		assert.doesNotMatch(text, /^(?:running|session_id):/m);
		assert.doesNotMatch(text, /^wall_time:/m);
		assert.match(text, /session remains registered/);
	});
});
