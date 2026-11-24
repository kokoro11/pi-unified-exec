import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

/**
 * Fixture sizes for the truncation tests.
 *
 * The extension keeps Pi's exported bounds instead of its own numbers, and
 * releases differ: Pi 1.0.0 exports 50 KiB and 2,000 lines, Pi 1.6.0 exports
 * 200,000 bytes and 200,000 lines. Fixtures are therefore derived from those
 * constants, and a test skips when its cap cannot be isolated.
 */

/** `line-00000001-` plus 50 `x` characters and the newline. */
export const BYTE_CAP_LINE_WIDTH = 65;

/** Wide lines whose total must exceed the byte cap by a visible margin. */
export const BYTE_CAP_LINES = Math.ceil((DEFAULT_MAX_BYTES * 1.2) / BYTE_CAP_LINE_WIDTH);

/** The byte cap wins only while this many wide lines still stay under the line cap. */
export const BYTE_CAP_ISOLATED = BYTE_CAP_LINES < DEFAULT_MAX_LINES;

/** Short ascending numbers, each line one newline wider than its digits. */
export const LINE_CAP_LINES = DEFAULT_MAX_LINES + 500;
export const LINE_CAP_NUMBER_WIDTH = String(LINE_CAP_LINES).length + 1;

/** The line cap wins only while those short lines still fit in the byte budget. */
export const LINE_CAP_ISOLATED = LINE_CAP_LINES * LINE_CAP_NUMBER_WIDTH <= DEFAULT_MAX_BYTES;
