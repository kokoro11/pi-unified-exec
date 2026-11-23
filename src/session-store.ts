/**
 * SessionStore — keyed registry of ExecSession instances with LRU eviction.
 *
 * Mirrors codex's `ProcessStore` + `prune_processes_if_needed`:
 *   - Caps at `maxSessions` entries.
 *   - When inserting would exceed the cap, prune the LRU entry that is NOT in
 *     the N-most-recent "protected" set. Prefer already-exited entries first.
 *   - IDs are monotonic and never reused.
 *
 * The store does NOT own process lifetime beyond terminate-on-evict and
 * terminate-all-on-shutdown. The ExecSession itself drives its child.
 */

import type { ExecSession } from "./session.ts";

interface SessionStoreOptions {
	maxSessions: number;
	lruProtectedCount: number;
}

export class SessionStore {
	private readonly sessions = new Map<number, ExecSession>();
	private readonly remindedExits = new WeakSet<ExecSession>();
	private nextId = 1;
	readonly maxSessions: number;
	private readonly lruProtectedCount: number;

	constructor(opts: SessionStoreOptions) {
		this.maxSessions = opts.maxSessions;
		this.lruProtectedCount = opts.lruProtectedCount;
	}

	/** Allocate a new monotonic session id (never reused). */
	allocateId(): number {
		return this.nextId++;
	}

	get(id: number): ExecSession | undefined {
		return this.sessions.get(id);
	}

	values(): ExecSession[] {
		return Array.from(this.sessions.values());
	}

	running(): ExecSession[] {
		const running: ExecSession[] = [];
		for (const session of this.sessions.values()) {
			if (!session.hasExited) running.push(session);
		}
		return running.sort((a, b) => a.id - b.id);
	}

	/** A new exit prompts a reminder for every exit still available to collect. */
	takeExitReminder(): string | undefined {
		for (const session of this.sessions.values()) {
			if (!session.hasExited || this.remindedExits.has(session)) continue;
			const pending: string[] = [];
			for (const exited of this.sessions.values()) {
				if (!exited.hasExited) continue;
				pending.push(`#${exited.id}`);
				this.remindedExits.add(exited);
			}
			return `Remember to poll and collect output of ${pending.join(", ")}`;
		}
	}

	get size(): number {
		return this.sessions.size;
	}

	/**
	 * Insert a session. Returns the evicted session, if any. If inserting the
	 * new session would exceed the cap, prune an LRU non-protected entry first.
	 */
	insert(session: ExecSession): { pruned?: ExecSession; count: number } {
		const pruned = this.sessions.size >= this.maxSessions ? this.pruneLru() : undefined;
		this.sessions.set(session.id, session);
		return { pruned, count: this.sessions.size };
	}

	/** Retire a session after its final output is collected. */
	remove(id: number): void {
		this.sessions.delete(id);
	}

	/** Terminate all sessions and clear the store. Used on session_shutdown. */
	terminateAll(): ExecSession[] {
		const drained = this.values();
		this.sessions.clear();
		for (const session of drained) killBestEffort(session);
		return drained;
	}

	/**
	 * LRU eviction policy (matches codex's `process_id_to_prune_from_meta`):
	 *   1. Protect the N most-recently-used entries.
	 *   2. Among unprotected: prefer already-exited entries (oldest first).
	 *   3. Otherwise: oldest unprotected entry, alive or not.
	 */
	private pruneLru(): ExecSession | undefined {
		const byRecency = this.values().sort((a, b) => a.lastUsed - b.lastUsed);
		const unprotectedCount = byRecency.length - Math.max(0, this.lruProtectedCount);
		if (unprotectedCount <= 0) return undefined;

		let victim = byRecency[0]!;
		for (let i = 0; i < unprotectedCount; i++) {
			const candidate = byRecency[i]!;
			if (!candidate.hasExited) continue;
			victim = candidate;
			break;
		}
		this.sessions.delete(victim.id);
		killBestEffort(victim);
		return victim;
	}
}

function killBestEffort(session: ExecSession): void {
	try {
		session.kill();
	} catch {
		// Keep cleaning up other sessions when signaling fails.
	}
}
