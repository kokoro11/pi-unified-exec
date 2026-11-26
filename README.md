# pi-unified-exec

[![CI](https://github.com/kokoro11/pi-unified-exec/actions/workflows/ci.yml/badge.svg)](https://github.com/kokoro11/pi-unified-exec/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Pi](https://pi.dev/) extension that gives agents reusable shell sessions so they can run dev servers, drive REPLs, and check on builds across turns.

The extension replaces Pi's built-in `bash` tool by default. Agents call `exec_command` for both one-shot commands and long-running processes.

## Install

Requires Pi **0.99.1 or newer** and Node **22.19.0 or newer** when running Pi on Node. This project is distributed from GitHub:

```bash
pi install git:github.com/kokoro11/pi-unified-exec
```

Add `-l` for a project-local install, or try it for one invocation with `pi -e git:github.com/kokoro11/pi-unified-exec`. Use `/reload` if Pi is already running. If you have the previous npm version configured, remove that package in the same scope before installing the GitHub version to avoid loading both.

Pi installs the native PTY dependency. On Windows, Git Bash is recommended; PowerShell is the fallback if Bash is unavailable.

## Quick start

After installing, paste this prompt into Pi:

```text
Use exec_command with a 250 ms yield to run: echo ready; sleep 3; echo done
Then poll the returned session with write_stdin and show me the final output.
```

In this example, `exec_command` returns `[running #N]`. The agent passes `N` as `session_id` to `write_stdin`, which returns `[exited #N ok]` on successful completion. To stop a live process yourself, run `/unified-exec-sessions`.

## Tools

| Tool | What the agent can do |
| --- | --- |
| `exec_command` | Start a shell command, optionally with a terminal (`tty: true`). |
| `write_stdin` | Send input, poll an existing session, or change its automatic resumption policy. |
| `list_sessions` | See live sessions, armed wakes, and exits awaiting output collection. |
| `kill_session` | Stop a session and suppress its pending wake. |

See the [tool reference](docs/TOOLS.md) for parameters, output logs, waits, configuration, and Codemode scripting.

## Limits

- Commands run with Pi's permissions. The extension adds no sandbox or approval layer.
- Sessions end with the Pi session. PTY dimensions are fixed when a process starts.
- Replies show bounded output. Plain-text logs, when created, stay on disk until you clean them up.

## Development and license

See [Development](docs/DEV.md) to test a local checkout and [Changelog](Changelog.md) for release history. Maintained by [kokoro11](https://github.com/kokoro11) under the [MIT license](LICENSE).
