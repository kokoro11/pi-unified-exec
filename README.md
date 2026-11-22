# pi-unified-exec

[![CI](https://github.com/kokoro11/pi-unified-exec/actions/workflows/ci.yml/badge.svg)](https://github.com/kokoro11/pi-unified-exec/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Pi](https://pi.dev/) extension for running shell commands in reusable sessions. Pi can start a dev server, drive a REPL, or check on a build across turns. Use Pi's built-in `bash` for one-shot commands that don't need later input or polling.

## Quick start

Once loaded, paste this into Pi:

```text
Use exec_command with a 250 ms yield to run: echo ready; sleep 3; echo done
Then poll the returned session with write_stdin and show me the final output.
```

The first call yields `[running #N]`. Pi uses `N` as the `session_id` for `write_stdin`, which returns `[exited #N ok]` when the job ends. To stop a live process yourself, use `/unified-exec-sessions` in Pi.

## Install

Requires Pi **0.99.1 or newer** and Node **22.19.0 or newer** when running Pi on Node. This project is distributed from GitHub:

```bash
pi install git:github.com/kokoro11/pi-unified-exec
```

Add `-l` for a project-local install, or try it for one invocation with `pi -e git:github.com/kokoro11/pi-unified-exec`. Use `/reload` if Pi is already running. If you have the previous npm version configured, remove that package in the same scope before installing the GitHub version to avoid loading both.

Pi installs the native PTY dependency. On Windows, Git Bash is recommended; PowerShell is the fallback if Bash is unavailable. Use `--keep-builtin-bash` to keep Pi's built-in `bash` active alongside this extension.

## Tools

| Tool | Use it to |
| --- | --- |
| `exec_command` | Start a shell command, optionally with a terminal (`tty: true`). |
| `write_stdin` | Send input or poll an existing session without restarting the command. |
| `list_sessions` | See live sessions, armed wakes, and unreported exits. |
| `set_on_exit` | Arm or disarm automatic agent resumption without stopping the process. |
| `kill_session` | Stop a session and suppress its pending wake. |

See the [tool reference](docs/TOOLS.md) for parameters, output logs, waits, configuration, and Codemode scripting.

## Limits

- Commands run with Pi's permissions. The extension adds no sandbox or approval layer.
- Sessions end with the Pi session. PTY dimensions are fixed when a process starts.
- Replies show bounded output. Raw logs, when created, stay on disk until you clean them up.

## Development and license

See [Development](docs/DEV.md) to test a local checkout and [Changelog](Changelog.md) for release history. Maintained by [kokoro11](https://github.com/kokoro11) under the [MIT license](LICENSE).
