# Development

Use Node 22.19 or newer and the Bun version pinned in [package.json](../package.json). Git Bash is recommended on Windows. Install and verify from a checkout:

```bash
git clone https://github.com/kokoro11/pi-unified-exec.git
cd pi-unified-exec
bun install --frozen-lockfile
bun run test
```

Try the working copy with `pi -e .` from the checkout. For repeated testing, use `pi install -l .` and `/reload` after edits. Finish or stop live calls before reloading; already-running calls use the previous code.

## Tests

`bun run test` typechecks and runs the Bun suite in two isolated workers. CI runs on Linux, macOS, and Windows with `EXPECT_PTY=1`, so a missing native PTY fails the run. The CLI tests start real Pi under Node with local scripted providers. The terminal tests use tmux and skip on Windows or when tmux is unavailable.

| For changes to | Run |
| --- | --- |
| Process lifecycle and input | `bun test --timeout 30000 ./tests/e2e.test.ts ./tests/e2e-pty.test.ts` |
| Waits, steering, and wakes | `bun test --timeout 30000 ./tests/long-wait.test.ts ./tests/steer.test.ts ./tests/wake-e2e.test.ts ./tests/cli-wait.test.ts ./tests/cli-steer.test.ts` |
| Output bounds and recovery | `bun test ./tests/tool-result.test.ts ./tests/output-log.test.ts ./tests/output-safety.test.ts` |
| Codemode and terminal rendering | `bun test --timeout 30000 ./tests/codemode-render.test.ts ./tests/codemode-models.test.ts ./tests/codemode-cli.test.ts` and `bun run test:tui` |

Set `PI_UNIFIED_EXEC_TEST_CLI` to another Pi `dist/cli.js` to requalify the real CLI and TUI without changing dependencies. Add an entry to [Changelog.md](../Changelog.md) with every change. Distribution uses the GitHub repository; a Git tag can pin a version for Pi installs.

## Tool guidance

Pi puts `promptGuidelines` entries in the shared Rules section without adding their tool names. Make the applicable tool explicit in the first rule, and prefer `tool_name:` at the start of every tool-specific entry so each rule remains clear on its own. For example: `write_stdin: Don't use chars and chars_hex at the same time.` Rules shared by several tools should explicitly name the tools they cover.

## Code map

| Concern | Start here |
| --- | --- |
| Tool schemas and lifecycle hooks | [`src/index.ts`](../src/index.ts) |
| Session status, widget, and picker | [`src/session-ui.ts`](../src/session-ui.ts) |
| Process, buffers, and eviction | [`src/session.ts`](../src/session.ts), [`src/session-store.ts`](../src/session-store.ts), [`src/head-tail-buffer.ts`](../src/head-tail-buffer.ts) |
| Shell selection, native terminals, screen snapshots, and input decoding | [`src/shell.ts`](../src/shell.ts), [`src/pty.ts`](../src/pty.ts), [`src/pty-screen.ts`](../src/pty-screen.ts), [`src/unescape.ts`](../src/unescape.ts) |
| Windows process ownership | [`src/windows-job.ts`](../src/windows-job.ts), [`src/windows-launcher.js`](../src/windows-launcher.js) |
| Attachment windows and wake ownership | [`src/collect.ts`](../src/collect.ts), [`src/long-wait.ts`](../src/long-wait.ts), [`src/steer-gate.ts`](../src/steer-gate.ts), [`src/completion.ts`](../src/completion.ts) |
| Logs, bounded results, and display | [`src/output-log.ts`](../src/output-log.ts), [`src/tool-result.ts`](../src/tool-result.ts), [`src/render.ts`](../src/render.ts), [`src/codemode-render.ts`](../src/codemode-render.ts) |

On Windows, a Node/Bun launcher waits on a private pipe until `@seydx/win-job` assigns it to a Job Object. Only then does it start the command. The reported PID belongs to this launcher, which exits with the shell's exit code; descendants can still hold its inherited output pipes open. Keep the job handle until those pipes close so explicit kill and shutdown can terminate descendants after their parents exit. Normal completion releases the handle without terminating processes that deliberately detached their stdio.

## Waits and wakes

- Empty polls and long command/input waits use an event-driven wait with a monotonic clock, bounded timers and buffered output. Keep quiet waits quiet and leave cache warming to Pi.
- Exit wins a simultaneous wait race. Esc leaves output buffered; a human steer drains it like a deadline. Neither cancels the child or disarms a pending wake. Confirm that the `input` steer made it into Pi's queue; release all attached calls together and throw from nested Codemode calls to stop polling scripts.
- `write_stdin` holds the completion until a successful `tool_execution_end` commits direct delivery. Failed delivery releases the observation. A pending wake can be disarmed after eviction; a failed kill keeps the process registered and restores wake eligibility. Successful kill and shutdown suppress wakes.
- Read [the public wait contract](TOOLS.md#waiting-and-cancellation) when changing these paths. CLI regressions check that warming can run during a long poll, that another extension can veto warming, and that RPC steering releases the wait.

## Output and rendering

- Enforce bounds and strip terminal controls before output reaches model text, tool details, or streaming updates. Pi can fall back to raw result content when custom rendering fails. Bound metadata independently of the output body.
- Feed PTY bytes to the headless terminal before filtering them for display. Only pipe sessions drain a text stream; PTY replies and previews read the active viewport without scrollback. At exit, let pending terminal writes finish and keep the final snapshot after disposing the emulator.
- At the raw-byte archive threshold, decode and sanitize the buffered prefix and all subsequent chunks as one UTF-8 stream. Carry incomplete characters and control sequences across writes. Reserve archive numbers exclusively so simultaneous Pi processes never overwrite each other's logs. Recovery uses the log number; expansion displays the bounded output without reading an arbitrary log file.
- Use Pi's configured expansion key and count visual rows after wrapping. In Codemode, preserve the public native factory and replace only result rendering. Register at `session_start` to let the built-in load without conflict warnings. Unwrap `lastComponent` before delegating to the native renderer and preserve the expansion hint and recovery footer.
- On Pi upgrades, check factory and schema identity, activation (including MCP), mode and budget, store/load, model helpers, and cached renderer reuse. Run the Codemode unit/CLI tests and `bun run test:tui`. A fallback to generic rendering fails qualification.
