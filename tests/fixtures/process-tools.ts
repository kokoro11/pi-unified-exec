import { COMPACT_CODEMODE_ENV } from "../../src/codemode-render.ts";
import activate from "../../src/index.ts";

/** The process-tool stubs do not implement Pi's native codemode API. */
export function activateProcessTools(pi: Parameters<typeof activate>[0]): void {
	const previous = process.env[COMPACT_CODEMODE_ENV];
	process.env[COMPACT_CODEMODE_ENV] = "0";
	try {
		activate(pi);
	} finally {
		if (previous === undefined) delete process.env[COMPACT_CODEMODE_ENV];
		else process.env[COMPACT_CODEMODE_ENV] = previous;
	}
}
