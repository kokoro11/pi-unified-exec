/** Apply terminal updates to a single PTY viewport and expose its visible text. */
import { createRequire } from "node:module";
import type { Terminal } from "@xterm/headless";

const require = createRequire(import.meta.url);
const encoder = new TextEncoder();

export class PtyScreen {
	private terminal: Terminal | undefined;
	private text: string | undefined;
	private pending = 0;
	private onClosed: (() => void) | undefined;

	constructor(cols: number, rows: number, onChange: () => void, reply: (data: Uint8Array) => void) {
		// Load the emulator only for PTY sessions. It never writes to the host terminal.
		const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
		const terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
		this.terminal = terminal;
		terminal.onWriteParsed(() => {
			if (!this.terminal) return;
			this.text = undefined;
			onChange();
		});
		// Programs can ask their terminal for state such as the cursor position.
		terminal.onData((data) => reply(encoder.encode(data)));
	}

	private readonly acknowledgeWrite = (): void => {
		if (--this.pending === 0 && this.onClosed) this.freeze(this.onClosed);
	};

	write(data: Uint8Array): void {
		const terminal = this.terminal;
		if (!terminal) return;
		this.pending++;
		try {
			terminal.write(data, this.acknowledgeWrite);
		} catch (error) {
			this.pending--;
			throw error;
		}
	}

	snapshot(): string {
		return this.text ??= this.terminal ? readViewport(this.terminal) : "";
	}

	close(onClosed: () => void): void {
		// The parser processes writes asynchronously. Keep the final painted
		// screen after those writes finish, then release the emulator.
		if (this.pending) this.onClosed = onClosed;
		else this.freeze(onClosed);
	}

	private freeze(onClosed: () => void): void {
		const terminal = this.terminal;
		if (terminal) {
			this.text = readViewport(terminal);
			this.terminal = undefined;
			terminal.dispose();
		}
		this.onClosed = undefined;
		onClosed();
	}
}

function readViewport(terminal: Terminal): string {
	const buffer = terminal.buffer.active;
	const lines: string[] = [];
	const end = buffer.viewportY + terminal.rows;
	for (let y = buffer.viewportY; y < end; y++) {
		lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
	}
	while (lines.at(-1) === "") lines.pop();
	return lines.join("\n");
}
