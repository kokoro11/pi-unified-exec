# Tool reference

For installation and a first run, see [the README](../README.md).

## `exec_command`

Starts a process and waits for an initial result. A process that finishes during this call reports `[exited ok]` or `[exited error CODE]`. A reply starting with `[running #N]` gives you the session ID for later calls.

| Parameter | Default | Use |
| --- | --- | --- |
| `cmd` | Required | Shell command to run. |
| `workdir` | Pi's working directory | Working directory for the child. |
| `shell` | Bash; PowerShell fallback on Windows | Shell executable. Windows also supports explicit `cmd`, `powershell`, or `pwsh`. |
| `tty` | `false` | Set to `true` for a terminal. Use pipes for programs that only need stdin and output. |
| `cols`, `rows` | `120`, `30` | Initial terminal size; clamped to 20–500 columns and 5–300 rows. Ignored in pipe mode. |
| `yield_time_ms` | `10000` | How long the call stays attached. `0` starts the command without waiting. |
| `on_exit` | `"none"` | Use `"wake"` only when the human requests automatic resumption after an unobserved exit. |

## `write_stdin`

Takes a `session_id` from `exec_command`. Omit input to poll, or send input before collecting more output. An exit result keeps the ID, for example `[exited #4 error 2]`. After collecting output, continue polling only while `details.running` is true or the header says `[running #N]`.

| Parameter | Default | Use |
| --- | --- | --- |
| `chars` | Empty | Text and C-style escapes, written as UTF-8. |
| `chars_b64` | Empty | Base64 for exact bytes. Use it instead of `chars`; malformed base64 is rejected. |
| `yield_time_ms` | `250` with input; `10000` for an empty poll | How long the call stays attached. `0` sends any input and collects available output without waiting for more. |
| `on_exit` | Keep the current policy | `"none"` disarms a pending wake. `"wake"` arms a live session. Use `"wake"` only when the human requests automatic resumption. |

Pass `session_id` and `on_exit` alone to apply the wake policy and drain available output without waiting for the process to exit. If the session has already exited, the same call collects its final output and retires the session ID. A late `"wake"` request cannot arm a new wake for an exited session. The reply explains this and reports `"none"` if there was no wake or `"consumed"` if the wake has already been resolved. If an existing wake is still pending, collecting the exit consumes it.

This form also lets you disarm a pending wake after its session has been evicted. A follow-up already queued to Pi stays queued. If you supply input or `yield_time_ms`, `write_stdin` applies the policy first, then writes or polls as usual.

### Waiting and cancellation

- For both tools, use a finite non-negative duration in milliseconds. Fractions round down. There is no built-in maximum; `PI_UNIFIED_EXEC_MAX_YIELD_MS` can cap every attachment window.
- Reaching the effective duration ends the current wait and leaves the process running. Use short polls for REPLs, dev servers, and other ongoing or interactive work.
- Esc cancels the wait without killing the child. An empty poll keeps its buffered output available for the next call.
- A human steer (including RPC `steer`) returns early, drains output so far, and leaves the child alive. `wait_status` tells the model to read and address the steering message first, then poll again only if the session is still relevant. Nested Codemode calls throw while a steer is queued so a script can stop polling. Follow-ups and extension-generated steers do not trigger this behavior.
- `wait_status` is optional and gives plain-language next steps only for cancellation and steering. Normal completion and reached deadlines omit the field from tool replies and structured results. Scripts use `running` and `exit_code` to inspect process state.
- `wall_time` is the current call's elapsed time; `total_time` on `write_stdin` covers the session from launch through the current result or exit. Scripts get numeric seconds in `details.wall_time_seconds` and `details.total_time_seconds`.

### Sending input

In `chars`, use `\n` for a pipe's newline, `\r` for Enter in a terminal (including Windows), and `\x03` for Ctrl-C in a terminal. In pipe mode Ctrl-C is just a byte. Other supported escapes include tabs and control characters (`\t`, `\b`, `\f`, `\v`, `\0`, `\a`, `\e`), Unicode (`\uHHHH`, `\u{H…H}`), hex (`\xHH`), and escaped quotes (`\"`, `\'`). Unknown escapes stay literal. Use `\\` for a literal backslash and `chars_b64` for arbitrary binary, including bytes above `0x7F`.

## Session management

| Tool | Parameters | Result |
| --- | --- | --- |
| `kill_session` | `session_id`, optional `signal` (default `SIGTERM`) | Suppress a pending wake and stop the child. On POSIX, escalate to `SIGKILL` after two seconds as needed. On Windows, force-terminate the session's Job Object, including descendants whose parents have exited. An unconfirmed kill leaves the session registered. |
| `list_sessions` | None | Include `session_id`, `running`, and `wake_armed`, plus `on_exit` and `log` when applicable. Report each unobserved exit once, then remove it from the list. |

`kill_session` reports `[killed #N]` or `[kill failed #N]`. For a known session, `total_time` covers its lifetime from launch and stops at exit; `wall_time` measures the kill call. The text shows a PID only while the session remains running, and reports `escalated` only when true. A missing session reports `[kill failed #N]` with a failure message and omits its unknown lifetime.

A wake sends a follow-up with exit metadata and a log number when available. A successful poll or listing that reports the exit consumes a pending wake. A deadline, steer, or cancellation keeps it armed. To disarm promptly, call `write_stdin` with the session ID and `on_exit: "none"`.

Tool replies and Codemode details report `on_exit: "wake"` while a wake is active. They report `on_exit: "consumed"` when an output collection or listing reports an armed exit, the follow-up has been sent, or a successful kill retires the wake. When `write_stdin` receives an `on_exit` argument it always reports the resulting status, including `on_exit: "none"` when the session has neither an active nor a consumed wake. Other calls omit the field for sessions without a wake policy.

## Output and logs

Text durations use whole milliseconds below 1s, up to four significant digits below 1000s, and whole seconds from 1000s. Terminal previews, wait labels, session lists, widgets, pickers, and wake messages share this format. Script details retain their numeric units.

`exec_command`, `write_stdin`, and `kill_session` include the output collected by that call. When there is no output to show, the text says `(no output)` and Codemode's `details.output` is an empty string. Results show up to 50 KiB or 2,000 lines of terminal-safe text. More than 1 MiB of output between drains can also leave a gap in the in-memory buffer. Expand a collapsed result with Pi's `app.tools.expand` binding (Ctrl+O by default) to see the full **bounded** result.

At 512 cumulative raw bytes, the extension starts archiving the full stream, including the initial bytes. Both `log: 4` in the tool reply and `log=4` in the terminal preview point to `.temp/pi-unified-exec/4.log` under **Pi's starting directory**, even if the command uses another `workdir`. Smaller output stays inline. Raw logs can contain terminal control sequences; open them with a plain-text reader or hex viewer.

## Codemode

`exec_command`, `write_stdin`, and `kill_session` return `{ details, text }` inside Codemode. `exec_command` includes `details.session_id` when the command is still running. `write_stdin` always includes `details.session_id` and `details.total_time_seconds`, even when it reports an exit. The total stops at exit. `details.output` is the bounded text; `text(r.text)` prints the formatted reply with line breaks.

```js
const r = await tools.exec_command({ cmd: "git status --short" });
text(r.text);
```

For `kill_session`, use `details.status` for the outcome, `details.found` to identify a missing session, and `details.running` to check whether it remains registered and running. `details.pid` preserves a known PID, including after exit; `details.total_time_seconds` reports the session lifetime and is omitted when the session is missing. The result has no `killed` field.

`list_sessions` returns typed fields directly. See the [result schemas](../src/script-result.ts). The extension caps collapsed Codemode text at ten visual rows across nested tools without enabling Codemode or changing script results or expanded output.

## Configuration

The `--keep-builtin-bash` flag opts out of replacing Pi's built-in `bash` tool.

| Environment variable | Effect |
| --- | --- |
| `PI_UNIFIED_EXEC_BASH` | Override Git Bash discovery on Windows. The default searches PATH and common Git installations before falling back to PowerShell. |
| `PI_UNIFIED_EXEC_MAX_YIELD_MS` | Clamp default and explicit waits for `exec_command` and `write_stdin` to this many milliseconds. Use a finite non-negative value; fractions round down. `0` disables waiting. Unset or blank means no cap. |
| `PI_UNIFIED_EXEC_STEER_INTERRUPT=0` | Leave waits attached when a human steers. |
| `PI_UNIFIED_EXEC_COMPACT_CODEMODE=0` | Use the native Codemode rendering. |
