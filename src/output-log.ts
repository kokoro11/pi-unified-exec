import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, openSync, type WriteStream } from "node:fs";
import { basename, join, resolve } from "node:path";

export const MIN_LOG_BYTES = 512;
export const OUTPUT_LOG_DIRECTORY = resolve(".temp").replaceAll("\\", "/");

export function logFileName(path: string | undefined): string | undefined {
	return path ? basename(path) : undefined;
}

/** Keep small output in memory; archive the complete stream once it reaches 512 bytes. */
export class OutputLog {
	private filePath: string | undefined;
	private stream: WriteStream | undefined;
	private prefix: Uint8Array | undefined;
	private prefixBytes = 0;
	private stopped = false;

	constructor(
		private readonly sessionId: number,
		private readonly onFailure: (message: string) => void,
	) {}

	get path(): string | undefined {
		return this.filePath;
	}

	write(chunk: Uint8Array): void {
		if (this.stopped || chunk.length === 0) return;
		if (!this.stream) {
			if (this.prefixBytes + chunk.length < MIN_LOG_BYTES) {
				this.prefix ??= new Uint8Array(MIN_LOG_BYTES);
				this.prefix.set(chunk, this.prefixBytes);
				this.prefixBytes += chunk.length;
				return;
			}
			const path = join(OUTPUT_LOG_DIRECTORY, `pi-unified-exec-${this.sessionId}-${randomBytes(4).toString("hex")}.log`);
			try {
				mkdirSync(OUTPUT_LOG_DIRECTORY, { recursive: true });
				this.stream = createWriteStream(path, { fd: openSync(path, "wx") });
				this.filePath = path;
			} catch (error) {
				this.stopped = true;
				this.prefix = undefined;
				this.onFailure(`failed to open log file ${path}: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			this.stream.on("error", (error) => {
				this.stopped = true;
				this.stream = undefined;
				this.onFailure(`log stream error: ${error.message}`);
			});
			if (this.prefixBytes) this.stream.write(this.prefix!.subarray(0, this.prefixBytes));
			this.prefix = undefined;
		}
		this.stream.write(chunk);
	}

	close(onClosed: () => void): void {
		this.stopped = true;
		this.prefix = undefined;
		const stream = this.stream;
		this.stream = undefined;
		if (!stream) {
			onClosed();
			return;
		}
		stream.once("close", onClosed);
		stream.end();
	}
}
