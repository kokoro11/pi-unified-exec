import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { type CompletionCoordinator, sanitizeMeta } from "./completion.ts";
import { formatElapsed } from "./format-time.ts";
import type { ExecSession } from "./session.ts";
import type { SessionStore } from "./session-store.ts";

const SESSION_UI_KEY = "unified-exec.sessions";
const WIDGET_SESSION_LIMIT = 5;

export function formatSessionCount(count: number, qualifier?: string): string {
	return `${count}${qualifier ? ` ${qualifier}` : ""} ${count === 1 ? "session" : "sessions"}`;
}

export function formatSessionCommand(command: string, max: number): string {
	const oneLine = sanitizeMeta(command).replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}\u2026`;
}

type Ui = ExtensionContext["ui"];

export class SessionUi {
	ui: Ui | undefined;
	private widgetVisible = false;
	private readonly exitWatches = new Map<number, () => void>();

	constructor(
		private readonly store: SessionStore,
		private readonly coordinator: Pick<CompletionCoordinator, "isArmed">,
	) {}

	watchExit(session: ExecSession): void {
		this.unwatchExit(session.id);
		// Exited sessions remain available for collection; only the UI changes here.
		this.exitWatches.set(session.id, session.onExit(() => this.refresh()));
	}

	unwatchExit(id: number): void {
		this.exitWatches.get(id)?.();
		this.exitWatches.delete(id);
	}

	clearExitWatches(): void {
		for (const unsubscribe of this.exitWatches.values()) unsubscribe();
		this.exitWatches.clear();
	}

	refresh(reason?: "tree"): void {
		const ui = this.ui;
		if (ui) this.render(ui, this.store.running(), reason);
	}

	async pickKillTargets(ui: Ui): Promise<ExecSession[] | undefined> {
		const sessions = this.store.running();
		this.render(ui, sessions);
		if (sessions.length === 0) {
			ui.notify("unified-exec: no live sessions", "info");
			return undefined;
		}

		const now = Date.now();
		const labels = sessions.map((session) => this.sessionLabel(session, now, 60));
		const killAll = `Kill all ${formatSessionCount(sessions.length)}`;
		labels.push(killAll);
		const choice = await ui.select(
			`unified-exec: ${formatSessionCount(sessions.length, "live")} \u2014 select to kill (Esc to cancel)`,
			labels,
		);
		if (!choice) return undefined;
		return choice === killAll ? sessions : sessions.filter((session) => choice.startsWith(`#${session.id} `));
	}

	private render(ui: Ui, sessions: ExecSession[], reason?: "tree"): void {
		const count = sessions.length;
		if (count === 0) {
			ui.setStatus(SESSION_UI_KEY, undefined);
			if (this.widgetVisible) {
				ui.setWidget(SESSION_UI_KEY, undefined);
				this.widgetVisible = false;
			}
			return;
		}

		const sessionCount = formatSessionCount(count);
		ui.setStatus(SESSION_UI_KEY, `unified-exec: ${sessionCount} running`);
		if (reason === "tree") ui.notify(`unified-exec: ${sessionCount} still running after /tree.`, "warning");
		if (!this.widgetVisible && reason !== "tree") return;

		const now = Date.now();
		const lines = [`\u26a0 unified-exec: ${sessionCount} still running`];
		const visible = Math.min(count, WIDGET_SESSION_LIMIT);
		for (let i = 0; i < visible; i++) {
			const session = sessions[i]!;
			lines.push(`  ${this.sessionLabel(session, now, 72)} (${session.cwd})`);
		}
		if (count > visible) lines.push(`  \u2026 ${count - visible} more; use list_sessions`);
		lines.push("  Use list_sessions, write_stdin (on_exit to change wake), or kill_session.");
		ui.setWidget(SESSION_UI_KEY, lines, { placement: "aboveEditor" });
		this.widgetVisible = true;
	}

	private sessionLabel(session: ExecSession, now: number, max: number): string {
		const wake = this.coordinator.isArmed(session.id) ? " [wake]" : "";
		const held = session.shellExited ? " (shell exited, pipe held)" : "";
		return `#${session.id} ${formatElapsed(now - session.startedAt)}${wake}${held} ${formatSessionCommand(session.displayCommand, max)}`;
	}
}
