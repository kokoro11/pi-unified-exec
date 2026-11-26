/** Verify log threshold, streaming text cleanup, and exclusive file numbering. */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "bun:test";

import { OutputLog, OutputLogDirectory } from "../src/output-log.ts";

const encoder = new TextEncoder();
const fail = (message: string) => assert.fail(message);
const close = (log: OutputLog) => new Promise<void>((resolve) => log.close(resolve));

describe("output log threshold", () => {
	let root: string;
	let path: string;
	let directory: OutputLogDirectory;

	beforeEach(() => {
		const temp = resolve(".temp");
		mkdirSync(temp, { recursive: true });
		root = mkdtempSync(join(temp, "output-log-test-"));
		path = join(root, "logs");
		directory = new OutputLogDirectory(path);
	});

	afterEach(() => {
		rmSync(root, { recursive: true });
	});

	it("never creates a file for empty or 511-byte output", async () => {
		for (const bytes of [0, 511]) {
			const log = new OutputLog(fail, directory);
			log.write(new Uint8Array(bytes));
			await close(log);
			assert.equal(log.id, undefined);
		}
		assert.equal(existsSync(path), false);
	});

	it("creates a complete log at exactly 512 raw bytes, including multibyte text", async () => {
		const log = new OutputLog(fail, directory);
		const output = encoder.encode("é".repeat(256));
		log.write(output);
		await close(log);
		assert.equal(log.id, 1);
		assert.deepEqual(readFileSync(join(path, "1.log")), Buffer.from(output));
	});

	it("flushes every buffered prefix chunk and all subsequent writes", async () => {
		const log = new OutputLog(fail, directory);
		log.write(encoder.encode("a".repeat(200)));
		log.write(encoder.encode("b".repeat(311)));
		assert.equal(log.id, undefined);
		log.write(encoder.encode("c"));
		log.write(encoder.encode("tail"));
		await close(log);
		assert.equal(readFileSync(join(path, "1.log"), "utf8"), "a".repeat(200) + "b".repeat(311) + "ctail");
	});

	it("strips controls split across the archive threshold and later writes", async () => {
		const log = new OutputLog(fail, directory);
		const prefix = "a".repeat(510);
		log.write(encoder.encode(prefix + "\x1b"));
		assert.equal(log.id, undefined);
		log.write(encoder.encode("["));
		assert.equal(log.id, 1);

		log.write(encoder.encode("31mred\x1b[0m\t\x1b]0;hidden title"));
		log.write(encoder.encode("\x1b"));
		log.write(encoder.encode("\\\r\n"));
		const emoji = encoder.encode("🎉");
		log.write(emoji.subarray(0, 2));
		log.write(emoji.subarray(2));
		log.write(encoder.encode("\x07\x1bPunterminated payload"));
		await close(log);

		assert.equal(readFileSync(join(path, "1.log"), "utf8"), prefix + "red\t\n🎉");
	});

	it("continues after existing logs and skips numbers taken by another writer", async () => {
		mkdirSync(path);
		writeFileSync(join(path, "8.log"), "existing");
		writeFileSync(join(path, "2000.txt"), "not a log");
		const other = new OutputLogDirectory(path);
		const first = new OutputLog(fail, directory);
		const second = new OutputLog(fail, other);
		const third = new OutputLog(fail, directory);
		first.write(encoder.encode("a".repeat(512)));
		second.write(encoder.encode("b".repeat(512)));
		third.write(encoder.encode("c".repeat(512)));
		await Promise.all([close(first), close(second), close(third)]);
		assert.equal(first.id, 9);
		assert.equal(second.id, 10);
		assert.equal(third.id, 11);
		assert.equal(readFileSync(join(path, "8.log"), "utf8"), "existing");
		assert.equal(readFileSync(join(path, "10.log"), "utf8"), "b".repeat(512));
		assert.equal(readFileSync(join(path, "11.log"), "utf8"), "c".repeat(512));
	});
});
