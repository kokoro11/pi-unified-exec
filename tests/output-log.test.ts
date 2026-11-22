import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

import { OutputLog, OUTPUT_LOG_DIRECTORY } from "../src/output-log.ts";

const encoder = new TextEncoder();
const fail = (message: string) => assert.fail(message);
const close = (log: OutputLog) => new Promise<void>((resolve) => log.close(resolve));

describe("output log threshold", () => {
	it("never creates a file for empty or 511-byte output", async () => {
		const files = () => existsSync(OUTPUT_LOG_DIRECTORY)
			? readdirSync(OUTPUT_LOG_DIRECTORY).filter((name) => name.startsWith("pi-unified-exec-801511-"))
			: [];
		const before = files();
		for (const bytes of [0, 511]) {
			const log = new OutputLog(801511, fail);
			log.write(new Uint8Array(bytes));
			await close(log);
			assert.equal(log.path, undefined);
		}
		assert.deepEqual(files(), before);
	});

	it("creates a complete log at exactly 512 raw bytes, including multibyte text", async () => {
		const log = new OutputLog(2, fail);
		const output = encoder.encode("é".repeat(256));
		log.write(output);
		await close(log);
		assert.deepEqual(readFileSync(log.path!), Buffer.from(output));
	});

	it("flushes every buffered prefix chunk and all subsequent writes", async () => {
		const log = new OutputLog(3, fail);
		log.write(encoder.encode("a".repeat(200)));
		log.write(encoder.encode("b".repeat(311)));
		assert.equal(log.path, undefined);
		log.write(encoder.encode("c"));
		log.write(encoder.encode("tail"));
		await close(log);
		assert.equal(readFileSync(log.path!, "utf8"), "a".repeat(200) + "b".repeat(311) + "ctail");
	});
});
