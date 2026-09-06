# Changelog

All notable changes to `pi-codex-account` are documented in this file.

## Unreleased

### Fixed

- The `model_select` handler that cleared a stale usage statusline never fired
  under OMP. `model_select` is a legacy-Pi event that OMP does not emit, and
  `ExtensionAPI.on` accepts any event name at runtime on both hosts, so the
  handler registered without error and was simply never called. Model changes
  are now detected at `turn_start` — an event both hosts emit — and
  `model_select` is kept for Pi, where it clears on selection instead of at the
  next turn.

### Added

- `credential_disabled` (OMP-only) clears the usage statusline when OMP disables
  a Codex credential, so a rate-limited account stops showing stale usage.
- `bun run typecheck:omp` typechecks the extension against the installed
  `@oh-my-pi/pi-coding-agent` types instead of only the legacy Pi ones, which is
  what surfaced the dead handler above. `typecheck:all` runs both.
- `test/events.test.ts` pins the set of registered events and cross-checks it
  against OMP's declared event union, so a host that drops one of them fails the
  test rather than silently disabling the behaviour.

## 0.1.1 - 2026-06-05

### Fixed

- Fixed argument completions for label subcommands. Pi replaces the full command
  argument string with the selected completion value, so completions now return
  values like `rename fadils` instead of `fadils`. This prevents `/codex rename
  fadils account1` from being rewritten to `/codex fadils`.

## 0.1.0 - 2026-06-05

Initial public release.

### Added

- Added `/codex` for saving, switching, listing, renaming, and removing Codex
  OAuth account snapshots.
- Added `/codex usage` to query active-account usage directly from ChatGPT's
  usage endpoint.
- Added `codex-accounts.json` account snapshot storage with `0600` file
  permissions.
- Added a backward-compatible `/codex-account` alias.
- Added tests for account storage, active-account detection, auth switching,
  usage normalization, report formatting, and argument parsing.
