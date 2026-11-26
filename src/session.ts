/**
 * ExecSession — wraps a SpawnedChild with:
 *   - a terminal screen, or pipe buffers drained by polls and streamed to the TUI
 *   - state transitions (has_exited / exit_code / signal / failure)
 *   - lifecycle callbacks (onData taps, onExit fan-out)
 *
 * Mirrors codex's `UnifiedExecProcess` in `unified_exec/process.rs`, simplified
 * to the subset we need for the pi extension.
 */

import { type CollectResult, collectOutputUntilDeadline } from "./collect.ts";
import { HeadTailBuffer } from "./head-tail-buffer.ts";
import { Gate, Notify } from "./notify.ts";
import { OutputLog } from "./output-log.ts";
import { DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, type SpawnedChild, type SpawnOptions, spawnChild } from "./pty.ts";
import { PtyScreen } from "./pty-screen.ts";

/** Default per-session output retention. */
export const DEFAULT_HEAD_TAIL_MAX_BYTES = 1024 * 1024; // 1 MiB

/** Default rolling tail window used for TUI streaming (independent of the head+tail buffer). */
export const DEFAULT_STREAM_TAIL_BYTES = 32 * 1024; // 32 KiB

export interface SessionSpawnOptions extends SpawnOptions {
	headTailMaxBytes?: number;
	streamTailBytes?: number;
	displayCommand?: string; // human-readable command for list_sessions/UI
}

export class ExecSession {
	readonly id: number;
	readonly tty: boolean;
	readonly displayCommand: string;
	readonly cwd: string;
	readonly startedAt: number;
	private readonly startedAtMonotonic = performance.now();
	private endedAtMonotonic: number | undefined;
	private readonly outputLog: OutputLog;

	/** Session lifetime, frozen at exit even if the caller collects the result later. */
	get totalTimeSeconds(): number {
		return ((this.endedAtMonotonic ?? performance.now()) - this.startedAtMonotonic) / 1000;
	}

	/** Sequence number of the full-output archive, once output reaches 512 bytes. */
	get log(): number | undefined {
		return this.outputLog.id;
	}

	/** Head+tail buffer drained by each collectOutputUntilDeadline() call. */
	private readonly outputBuffer: HeadTailBuffer | undefined;
	private screen: PtyScreen | undefined;
	/** Fired when pipe output arrives or the terminal emulator paints. */
	readonly outputNotify = new Notify();
	/** Closed when the stream is done (all data flushed after exit). */
	private readonly outputClosed = new Gate();
	/** Aborts when the process has exited (may still have trailing output). */
	private readonly exitedAc = new AbortController();
	get exited(): AbortSignal {
		return this.exitedAc.signal;
	}

	/** Running tail window for TUI streaming; independent of outputBuffer. */
	private readonly streamTail: Uint8Array[] = [];
	private streamTailBytes = 0;
	private readonly streamTailCap: number;
	private totalOutputBytes = 0;

	private childExitCode: number | null = null;
	private childSignal: NodeJS.Signals | null = null;
	private failure: string | null = null;
	private readonly exitListeners = new Set<(session: ExecSession) => void>();
	private lastUsedAt: number;
	private child!: SpawnedChild;

	get pid(): number | undefined {
		return this.child?.pid;
	}

	private constructor(id: number, opts: SessionSpawnOptions) {
		this.id = id;
		this.displayCommand = opts.displayCommand ?? opts.command.join(" ");
		this.cwd = opts.cwd;
		this.tty = opts.tty;
		this.startedAt = Date.now();
		this.lastUsedAt = this.startedAt;
		if (!opts.tty) this.outputBuffer = new HeadTailBuffer(opts.headTailMaxBytes ?? DEFAULT_HEAD_TAIL_MAX_BYTES);
		this.streamTailCap = opts.streamTailBytes ?? DEFAULT_STREAM_TAIL_BYTES;
		this.outputLog = new OutputLog((message) => {
			this.failure ??= message;
		});
	}

	static spawn(id: number, opts: SessionSpawnOptions): ExecSession {
		const self = new ExecSession(id, opts);

		try {
			if (opts.tty) {
				self.screen = new PtyScreen(
					opts.cols ?? DEFAULT_PTY_COLS,
					opts.rows ?? DEFAULT_PTY_ROWS,
					() => self.outputNotify.notifyAll(),
					(reply) => self.write(reply),
				);
			}
			self.child = spawnChild(opts);
		} catch (err: any) {
			self.screen?.close(() => {});
			self.recordExit(null, null, err?.message ?? String(err));
			self.outputClosed.close();
			return self;
		}

		self.child.onData((chunk) => {
			self.totalOutputBytes += chunk.length;
			self.outputLog.write(chunk);
			if (self.screen) {
				try {
					self.screen.write(chunk);
				} catch (error) {
					self.failure ??= `terminal output error: ${error instanceof Error ? error.message : String(error)}`;
				}
				return;
			}
			self.outputBuffer!.pushChunk(chunk);
			self.appendStreamTail(chunk);
			self.outputNotify.notifyAll();
		});

		self.child.onExit((exitCode, signal, failureMessage) => {
			self.recordExit(exitCode, signal, failureMessage);
			// Fire a notify so any parked waiters wake up and see the exit.
			self.outputNotify.notifyAll();
			// Allow trailing chunks, then wait for the archive and emulator
			// before announcing that final output is ready to collect.
			setImmediate(() => {
				self.outputNotify.notifyAll();
				self.outputLog.close(() => {
					const finish = () => {
						self.outputClosed.close();
						self.outputNotify.notifyAll();
					};
					if (self.screen) self.screen.close(finish);
					else finish();
				});
			});
		});

		return self;
	}

	private appendStreamTail(chunk: Uint8Array): void {
		// A single chunk larger than the whole window replaces it outright —
		// the trim loop below never shrinks a lone chunk, and shipping a
		// multi-megabyte "tail" to the TUI every tick defeats the cap.
		if (chunk.length >= this.streamTailCap) {
			const tail = chunk.subarray(chunk.length - this.streamTailCap);
			this.streamTail[0] = tail;
			this.streamTail.length = 1;
			this.streamTailBytes = tail.length;
			return;
		}
		this.streamTail.push(chunk);
		this.streamTailBytes += chunk.length;
		while (this.streamTailBytes > this.streamTailCap && this.streamTail.length > 1) {
			const front = this.streamTail[0]!;
			if (this.streamTailBytes - front.length >= this.streamTailCap) {
				this.streamTail.shift();
				this.streamTailBytes -= front.length;
			} else {
				// Trim the front of the leading chunk just enough.
				const tail = front.subarray(this.streamTailBytes - this.streamTailCap);
				this.streamTail[0] = tail;
				this.streamTailBytes -= front.length - tail.length;
				break;
			}
		}
	}

	private recordExit(exitCode: number | null, signal: NodeJS.Signals | null, failure?: string): void {
		this.endedAtMonotonic = performance.now();
		this.childExitCode = exitCode;
		this.childSignal = signal;
		this.failure ??= failure ?? null;
		this.exitedAc.abort();
		for (const listener of this.exitListeners) {
			try {
				listener(this);
			} catch {
				// ignore listener failures
			}
		}
	}

	/** Register a listener fired when this session exits. */
	onExit(listener: (session: ExecSession) => void): () => void {
		this.exitListeners.add(listener);
		if (this.hasExited) {
			queueMicrotask(() => {
				if (this.exitListeners.has(listener)) listener(this);
			});
		}
		return () => this.exitListeners.delete(listener);
	}

	/** Snapshot the current rolling tail (for streaming updates). */
	snapshotStreamTail(): Uint8Array {
		const out = new Uint8Array(this.streamTailBytes);
		let offset = 0;
		for (const c of this.streamTail) {
			out.set(c, offset);
			offset += c.length;
		}
		return out;
	}

	/** Current viewport, or undefined for pipes. Reading it never drains it. */
	snapshotScreen(): string | undefined {
		return this.screen?.snapshot();
	}

	/**
	 * Wait until `deadlineMs` (or exit/abort), draining retained pipe output.
	 * PTY sessions keep the viewport available for `snapshotScreen`.
	 */
	collect(opts: {
		deadlineMs: number;
		externalAbort?: AbortSignal;
		stopSignal?: AbortSignal;
		postExitCloseWaitMs?: number;
	}): Promise<CollectResult> {
		return collectOutputUntilDeadline({
			buffer: this.outputBuffer,
			outputNotify: this.outputNotify,
			outputClosed: this.outputClosed,
			exited: this.exited,
			deadlineMs: opts.deadlineMs,
			externalAbort: opts.externalAbort,
			stopSignal: opts.stopSignal,
			postExitCloseWaitMs: opts.postExitCloseWaitMs,
		});
	}

	/** Write bytes to stdin. Returns true on success, false if closed/dead. */
	write(data: Uint8Array): boolean {
		if (this.hasExited) return false;
		return this.child.write(data);
	}

	/** Send a signal. No-op if already exited. */
	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		if (this.hasExited) return;
		this.child.kill(signal);
	}

	get hasExited(): boolean {
		return this.endedAtMonotonic !== undefined;
	}

	/**
	 * The shell process itself has exited. In pipes mode this can be true
	 * while `hasExited` is still false: background jobs that inherited the
	 * output pipe keep it open, so the close-based session exit lags (or
	 * never arrives). Lets callers explain a session that reports "running"
	 * although its shell is gone.
	 */
	get shellExited(): boolean {
		return this.child.processExited;
	}

	get exitCode(): number | null {
		return this.childExitCode;
	}

	get signal(): NodeJS.Signals | null {
		return this.childSignal;
	}

	get failureMessage(): string | null {
		return this.failure;
	}

	get totalBytesSeen(): number {
		return this.totalOutputBytes;
	}

	get lastUsed(): number {
		return this.lastUsedAt;
	}

	touch(): void {
		this.lastUsedAt = Date.now();
	}
}
