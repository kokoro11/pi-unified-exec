/** Archive complete, terminal-safe command output once the raw byte threshold is reached. */
import { createWriteStream, mkdirSync, openSync, readdirSync, type WriteStream } from "node:fs";
import { join, resolve } from "node:path";

import { OutputTextSanitizer } from "./output-safety.ts";

export const MIN_LOG_BYTES = 512;
const LOG_DIRECTORY = ".temp/pi-unified-exec";
const LOG_EXTENSION = ".log";
export const OUTPUT_LOG_DIRECTORY = resolve(LOG_DIRECTORY);
export const OUTPUT_LOG_PATH_TEMPLATE = `${LOG_DIRECTORY}/<log number>${LOG_EXTENSION}`;

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

interface LogWriter {
	stream: WriteStream;
	decoder: TextDecoder;
	sanitizer: OutputTextSanitizer;
}

function writeChunk(writer: LogWriter, chunk: Uint8Array): void {
	const text = writer.sanitizer.write(writer.decoder.decode(chunk, { stream: true }));
	if (text) writer.stream.write(text);
}

export class OutputLog {
	private logId: number | undefined;
	private writer: LogWriter | undefined;
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
		let writer = this.writer;
		if (!writer) {
			if (this.prefixBytes + chunk.length < MIN_LOG_BYTES) {
				this.prefix ??= new Uint8Array(MIN_LOG_BYTES);
				this.prefix.set(chunk, this.prefixBytes);
				this.prefixBytes += chunk.length;
				return;
			}
			try {
				const { id, stream } = this.directory.open();
				this.writer = writer = {
					stream,
					decoder: new TextDecoder("utf-8", { ignoreBOM: true }),
					sanitizer: new OutputTextSanitizer(),
				};
				this.logId = id;
			} catch (error) {
				this.stopped = true;
				this.prefix = undefined;
				this.onFailure(`failed to open log file: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			writer.stream.on("error", (error) => {
				this.stopped = true;
				this.writer = undefined;
				this.onFailure(`log stream error: ${error.message}`);
			});
			if (this.prefixBytes) writeChunk(writer, this.prefix!.subarray(0, this.prefixBytes));
			this.prefix = undefined;
		}
		writeChunk(writer, chunk);
	}

	close(onClosed: () => void): void {
		this.stopped = true;
		this.prefix = undefined;
		const writer = this.writer;
		this.writer = undefined;
		if (!writer) {
			onClosed();
			return;
		}
		writer.stream.once("close", onClosed);
		writer.stream.end(writer.sanitizer.write(writer.decoder.decode()));
	}
}
