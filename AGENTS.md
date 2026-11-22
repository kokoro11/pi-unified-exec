# AGENTS.md

Whenever you edit code, docs, tests, or package metadata, update `Changelog.md` in the same change.

- **Waits, steering, or wakes:** read [Waits and wakes](docs/DEV.md#waits-and-wakes).
- **Result bounds, logs, tool rendering, or Pi upgrades:** read [Output and rendering](docs/DEV.md#output-and-rendering). On Pi upgrades, run the Codemode unit/CLI tests and `bun run test:tui`; generic renderer fallback fails qualification.

Canonical verification:

```bash
bun run test
```

For Pi source inspection, clone [earendil-works/pi](https://github.com/earendil-works/pi) into the ignored `local_data/pi-mono` directory.

## Frontier Models

The following are the frontier models. Prefer to use them as defaults:

- `gpt-5.5`
- `claude-opus-4-7`
