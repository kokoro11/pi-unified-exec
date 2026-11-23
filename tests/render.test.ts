import { strict as assert } from "node:assert";
import { beforeAll, describe, it } from "bun:test";
import { initTheme, Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";

import {
	renderKillSessionCall,
	renderKillSessionResult,
	renderListSessionsResult,
	renderProcessResult,
} from "../src/render.ts";
import {
	finalizeKillResult,
	finalizeProcessResult,
	renderKillResultText,
	renderProcessResultText,
	WAIT_CANCELLED,
	WAIT_STEERED,
} from "../src/tool-result.ts";

const encoder = new TextEncoder();
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

// Use Pi's real color handling; only the tokens used by these footer fixtures are needed.
const colorTheme = new Theme(
	{
		text: "#ffffff",
		muted: "#808080",
		error: "#ff0000",
		success: "#00ff00",
		warning: "#ffff00",
		accent: "#00ffff",
		thinkingXhigh: "#ffffff",
	} as ConstructorParameters<typeof Theme>[0],
	{ selectedBg: "#000000" } as ConstructorParameters<typeof Theme>[1],
	"truecolor",
);

function rendered(component: { render(width: number): string[] }, width = 100): string {
	return component
		.render(width)
		.map((line) => line.trimEnd())
		.join("\n");
}

function context(state: Record<string, unknown>, lastComponent?: unknown): any {
	return {
		args: {},
		state,
		lastComponent,
		cwd: "/repo",
		toolCallId: "test",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		invalidate: () => {},
	};
}

beforeAll(() => {
	initTheme("dark", false);
});

describe("unified-exec renderers", () => {
	it("kill_session is collapsed to five visual output lines and expands on demand", () => {
		const output = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n");
		const details = finalizeKillResult({
			wallTimeSec: 0.1,
			totalTimeSec: 1.5,
			collected: encoder.encode(output),
			sessionId: 73,
			pid: 777,
			requestedSignal: "SIGTERM",
			exitCode: undefined,
			signal: "SIGTERM",
			failure: null,
			tty: false,
			log: 73,
			cwd: "/repo",
			command: "noisy job",
			escalated: false,
			killed: true,
		});
		const result = { content: [{ type: "text", text: renderKillResultText(details) }], details } as any;
		const state: Record<string, unknown> = {};

		renderKillSessionCall({ session_id: 73 }, plainTheme, context(state));
		const collapsed = renderKillSessionResult(result, { expanded: false, isPartial: false }, plainTheme, context(state));
		const collapsedText = rendered(collapsed);
		assert.match(collapsedText, /line-16/);
		assert.match(collapsedText, /line-20/);
		assert.doesNotMatch(collapsedText, /\nline-1\n/);
		assert.match(collapsedText, /earlier lines/);
		assert.match(collapsedText.toLowerCase(), /to expand/);
		assert.match(collapsedText, /killed session_id=73/);
		assert.match(collapsedText, /pid=777/);
		assert.match(collapsedText, /total 1\.5s/);
		assert.match(collapsedText, / ·\s+log=73$/m);

		const expanded = renderKillSessionResult(
			result,
			{ expanded: true, isPartial: false },
			plainTheme,
			context(state, collapsed),
		);
		const expandedText = rendered(expanded);
		assert.match(expandedText, /line-1\n/);
		assert.match(expandedText, /line-20/);
		assert.doesNotMatch(expandedText, /earlier lines/);

		const recollapsed = renderKillSessionResult(
			result,
			{ expanded: false, isPartial: false },
			plainTheme,
			context(state, expanded),
		);
		const recollapsedText = rendered(recollapsed);
		assert.match(recollapsedText, /earlier lines/);
		assert.doesNotMatch(recollapsedText, /\nline-1\n/);
	});

	for (const scenario of [
		{
			name: "exec_command error",
			render: renderProcessResult,
			details: { operation: "exec_command", running: false, exit_code: 1 },
			highlight: "exit_code=1",
			color: "error",
		},
		{
			name: "write_stdin cancellation",
			render: renderProcessResult,
			details: { operation: "write_stdin", running: true, session_id: 3, wait_status: WAIT_CANCELLED },
			highlight: "cancelled",
			color: "warning",
		},
		{
			name: "write_stdin steering",
			render: renderProcessResult,
			details: { operation: "write_stdin", running: true, session_id: 3, wait_status: WAIT_STEERED },
			highlight: "steered",
			color: "accent",
		},
		{
			name: "kill_session success",
			render: renderKillSessionResult,
			details: { operation: "kill_session", status: "killed", running: false, found: true, session_id: 3 },
			highlight: "killed session_id=3",
			color: "success",
		},
		{
			name: "kill_session failure",
			render: renderKillSessionResult,
			details: { operation: "kill_session", status: "kill_failed", running: true, found: true, session_id: 3 },
			highlight: "FAILED session_id=3",
			color: "error",
		},
	]) {
		it(`keeps footer separators and log muted after ${scenario.name}`, () => {
			const result = {
				content: [{ type: "text", text: "" }],
				details: { ...scenario.details, output: "", log: 241 },
			} as any;
			const component = scenario.render(
				result,
				{ expanded: false, isPartial: false },
				colorTheme,
				context({ startedAt: 0, endedAt: 800 }),
			);
			const line = rendered(component, 200).split("\n").find((line) => line.includes("log=241"))!;
			const plain = stripTerminalSequences(line);
			const assertColor = (label: string, color: ThemeColor): void => {
				const column = plain.indexOf(label);
				assert.ok(column >= 0, plain);
				const cell = sliceByColumn(line, column + 1, 1);
				assert.ok(
					cell.endsWith(colorTheme.getFgAnsi(color) + stripTerminalSequences(cell)),
					`${color} at column ${column}: ${JSON.stringify(cell)}`,
				);
			};
			const durationLabel = scenario.details.running ? "yielded" : "took";
			assert.ok(plain.startsWith(`${durationLabel} 800ms`), plain);
			assertColor(durationLabel, "muted");
			assertColor(scenario.highlight, scenario.color as ThemeColor);
			assertColor(" · log=241", "muted");
			assertColor("log=241", "muted");
		});
	}

	it("defensively strips terminal-control sequences from calls and legacy details", () => {
		const osc = "\x1b]52;c;YXR0YWNrZXI=\x07";
		const state: Record<string, unknown> = {};
		const call = renderKillSessionCall({ session_id: 4, signal: `SIGTERM${osc}` }, plainTheme, context(state));
		assert.doesNotMatch(rendered(call), /[\u001b\u009b]/);

		const details = {
			operation: "kill_session",
			status: "killed",
			running: false,
			found: true,
			session_id: 4,
			requested_signal: "SIGTERM",
			escalated: false,
			wall_time_seconds: 0.1,
			output: `before${osc}after`,
		};
		const result = { content: [{ type: "text", text: "fallback" }], details } as any;
		const component = renderKillSessionResult(
			result,
			{ expanded: true, isPartial: false },
			plainTheme,
			context(state),
		);
		const text = rendered(component);
		assert.match(text, /beforeafter/);
		assert.doesNotMatch(text, /[\u001b\u009b]/);
	});

	it("refreshes a cached collapsed preview when partial output grows", () => {
		const state: Record<string, unknown> = {};
		const firstDetails = finalizeProcessResult({
			operation: "write_stdin",
			running: true,
			wallTimeSec: 0.1,
			collected: encoder.encode(Array.from({ length: 8 }, (_, index) => `old-${index + 1}`).join("\n")),
			sessionId: 3,
			exitCode: undefined,
			signal: null,
			failure: null,
			tty: false,
			metadata: { on_exit: "wake" },
		});
		const firstResult = {
			content: [{ type: "text", text: renderProcessResultText(firstDetails) }],
			details: firstDetails,
		} as any;
		const first = renderProcessResult(firstResult, { expanded: false, isPartial: true }, plainTheme, context(state));
		assert.match(rendered(first), /old-8/);
		assert.match(rendered(first), /on_exit=wake/);

		const nextDetails = finalizeProcessResult({
			operation: "write_stdin",
			running: true,
			wallTimeSec: 0.2,
			collected: encoder.encode(Array.from({ length: 8 }, (_, index) => `new-${index + 1}`).join("\n")),
			sessionId: 3,
			exitCode: undefined,
			signal: null,
			failure: null,
			tty: false,
			log: 80,
		});
		nextDetails.total_time_seconds = 1.25;
		const nextResult = {
			content: [{ type: "text", text: renderProcessResultText(nextDetails) }],
			details: nextDetails,
		} as any;
		const next = renderProcessResult(
			nextResult,
			{ expanded: false, isPartial: false },
			plainTheme,
			context(state, first),
		);
		const nextText = rendered(next);
		assert.match(nextText, /new-8/);
		assert.doesNotMatch(nextText, /old-8/);
		assert.match(nextText, /total 1\.25s/);
		assert.match(nextText, / · log=80$/m);
	});

	it("kill_session unknown-id results are compact errors", () => {
		const text = "[kill failed #999]\nfailure: No such session: 999";
		const component = renderKillSessionResult(
			{
				content: [{ type: "text", text }],
				details: { operation: "kill_session", status: "kill_failed", running: false, found: false },
			} as any,
			{ expanded: false, isPartial: false },
			plainTheme,
			context({}),
		);
		assert.equal(rendered(component, 80).trim(), text);
	});

	it("list_sessions previews five entries, caches rows, and expands all entries with log numbers", () => {
		const sessions = Array.from({ length: 7 }, (_, index) => ({
			session_id: index + 1,
			command: `sleep ${index + 1}`,
			cwd: "/repo",
			tty: false,
			pid: 1000 + index,
			elapsed_ms: 1234.56 * (index + 1),
			running: true,
			on_exit: index === 0 ? "wake" : undefined,
			log: index + 1,
		}));
		let firstCommandReads = 0;
		Object.defineProperty(sessions[0], "command", {
			get: () => {
				firstCommandReads++;
				return "sleep 1";
			},
		});
		const result = {
			content: [{ type: "text", text: "fallback should not render" }],
			details: { sessions, active_count: 7, just_exited_count: 0 },
		} as any;

		const collapsed = renderListSessionsResult(result, { expanded: false, isPartial: false }, plainTheme, context({}));
		const collapsedText = rendered(collapsed);
		assert.match(collapsedText, /#1 /);
		assert.match(collapsedText, /#1 pid=1000 pipe 1\.235s/);
		assert.match(collapsedText, /on_exit=wake/);
		assert.match(collapsedText, /#5 /);
		assert.doesNotMatch(collapsedText, /#6 /);
		assert.match(collapsedText, /2 more sessions/);
		assert.match(collapsedText.toLowerCase(), /to expand/);
		rendered(collapsed);
		assert.equal(firstCommandReads, 1, "same-width redraw should reuse cached rows");

		const expanded = renderListSessionsResult(
			result,
			{ expanded: true, isPartial: false },
			plainTheme,
			context({}, collapsed),
		);
		const expandedText = rendered(expanded);
		assert.match(expandedText, /#7 /);
		assert.match(expandedText, /^  log=7$/m);
		assert.doesNotMatch(expandedText, /more sessions/);
	});
});
