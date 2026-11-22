import { createWriteStream, mkdirSync, openSync, readdirSync, type WriteStream } from "node:fs";
import { join, resolve } from "node:path";

export const MIN_LOG_BYTES = 512;
const LOG_DIRECTORY = ".temp/pi-unified-exec";
const LOG_EXTENSION = ".log";
export const OUTPUT_LOG_DIRECTORY = resolve(LOG_DIRECTORY);
export const OUTPUT_LOG_PATH_TEMPLATE = `${LOG_DIRECTORY}/<log>${LOG_EXTENSION}`;

/** Allocate numbers from the existing archive; reserve each file exclusively. */
export class OutputLogDirectory {
	private next: number | undefined;

	constructor(private readonly path: string) {}

	open(): { id: number; stream: WriteStream } {
		mkdirSync(this.path, { recursive: true });
		if (this.next === undefined) {
			let highest = 0;
			for (const name of readdirSync(this.path)) {
				if (!/^[1-9]\d*\.log$/.test(name)) continue;
				const number = Number(name.slice(0, -LOG_EXTENSION.length));
				if (Number.isSafeInteger(number) && number > highest) highest = number;
			}
			this.next = highest + 1;
		}
		while (Number.isSafeInteger(this.next)) {
			const id = this.next;
			const path = join(this.path, `${id}${LOG_EXTENSION}`);
			let fd: number;
			try {
				fd = openSync(path, "wx");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				// Another Pi process already reserved this number.
				this.next++;
				continue;
			}
			this.next++;
			return { id, stream: createWriteStream(path, { fd }) };
		}
		throw new Error("log sequence exhausted");
	}
}

const defaultDirectory = new OutputLogDirectory(OUTPUT_LOG_DIRECTORY);

/** Keep small output in memory; archive the complete stream once it reaches 512 bytes. */
export class OutputLog {
	private logId: number | undefined;
	private stream: WriteStream | undefined;
	private prefix: Uint8Array | undefined;
	private prefixBytes = 0;
	private stopped = false;

	constructor(
		private readonly onFailure: (message: string) => void,
		private readonly directory = defaultDirectory,
	) {}

	get id(): number | undefined {
		return this.logId;
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
			try {
				const { id, stream } = this.directory.open();
				this.stream = stream;
				this.logId = id;
			} catch (error) {
				this.stopped = true;
				this.prefix = undefined;
				this.onFailure(`failed to open log file: ${error instanceof Error ? error.message : String(error)}`);
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
