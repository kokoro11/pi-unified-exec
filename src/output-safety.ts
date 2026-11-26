/*
 * Convert untrusted child/argument text into inert terminal text.
 *
 * Strip ANSI/VT sequences and control characters while retaining printable
 * text, tabs, and newlines. Drop CR so progress output can't rewrite a line.
 */

const ESC = 0x1b;
const NEEDS_SCAN = /[\x00-\x08\x0b-\x1f\x7f-\x9f\ud800-\udfff\ufff9-\ufffb]/;

type ScanState = "text" | "escape" | "escape-intermediate" | "csi-param" | "csi-intermediate" | "osc" | "string";

function isIntermediate(code: number): boolean {
	return code >= 0x20 && code <= 0x2f;
}

/** Scan decoded chunks without buffering control sequences across writes. */
export class OutputTextSanitizer {
	private state: ScanState = "text";
	private stringEscape = false;

	static sanitize(input: string): string {
		return NEEDS_SCAN.test(input) ? new OutputTextSanitizer().strip(input) : input;
	}

	write(input: string): string {
		// Plain text is common; skip the parser when no sequence is pending.
		if (this.state === "text" && !NEEDS_SCAN.test(input)) return input;
		return this.strip(input);
	}

	private strip(input: string): string {
		let state = this.state;
		let stringEscape = this.stringEscape;
		let output = "";
		let start = 0;

		for (let i = 0; i < input.length; i++) {
			const code = input.charCodeAt(i);
			let consumed = true;
			switch (state) {
				case "osc":
				case "string":
					// OSC accepts BEL as well as ST. Other strings end only at ST.
					if (code === 0x9c || (stringEscape && code === 0x5c) || (state === "osc" && code === 0x07)) {
						state = "text";
					}
					stringEscape = code === ESC;
					break;
				case "escape":
				case "escape-intermediate":
					if (state === "escape" && code === 0x5b) state = "csi-param"; // [
					else if (state === "escape" && code === 0x5d) state = "osc"; // ]
					else if (state === "escape" && (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f)) {
						state = "string"; // P, X, ^, _
					} else if (isIntermediate(code)) state = "escape-intermediate";
					else {
						state = "text";
						consumed = code >= 0x30 && code <= 0x7e;
					}
					break;
				case "csi-param":
				case "csi-intermediate":
					if (state === "csi-param" && code >= 0x30 && code <= 0x3f) break;
					if (isIntermediate(code)) state = "csi-intermediate";
					else {
						state = "text";
						consumed = code >= 0x40 && code <= 0x7e;
					}
					break;
				case "text":
					consumed = false;
					break;
			}
			if (consumed) {
				start = i + 1;
				continue;
			}

			// Recheck invalid sequence bytes as text; one may begin a new sequence.
			if (code === ESC) state = "escape";
			else if (code === 0x9b) state = "csi-param";
			else if (code === 0x9d) state = "osc";
			else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) state = "string";
			else if (code >= 0xd800 && code <= 0xdfff) {
				const next = input.charCodeAt(i + 1);
				if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
					i++;
					continue;
				}
			} else if (
				code === 0x09 || code === 0x0a ||
				(code >= 0x20 && (code < 0x7f || code > 0x9f) && (code < 0xfff9 || code > 0xfffb))
			) {
				continue;
			}

			output += input.slice(start, i);
			start = i + 1;
		}

		this.state = state;
		this.stringEscape = stringEscape;
		return output + input.slice(start);
	}
}

export function sanitizeOutputText(input: string): string {
	return OutputTextSanitizer.sanitize(input);
}
