# Changelog

All notable changes to `pi-codex-account` are documented in this file.

## Unreleased

### Changed

- On OMP, `/codex switch` now pins instead of overwriting. It parks the other
  `openai-codex` rows with a marker of its own and leaves the target as OMP's
  only candidate, so every credential survives a switch. A snapshot with no row
  of its own is inserted as a new row rather than written over an existing one,
  which removes the last path that could overwrite a credential.

### Added

- `/codex unpin` (alias `/codex release`) clears the pin and lets OMP rotate
  across every account again. It restores only rows this extension parked: one
  OMP disabled for its own reason keeps its cause.
- A pin releases itself when OMP disables the pinned credential, so a rate limit
  on the pinned account cannot strand the session without a usable login.
- `/codex list` says whether a pin is active and which account holds it.

### Fixed

- Switching accounts could destroy a credential. The switch rewrites the active
  `agent.db` row in place, but the outgoing credential was only snapshotted when
  it already carried a label — so any login the user had not saved through this
  extension, including every one OMP collected by itself, was overwritten with
  no copy anywhere. An unlabelled credential is now adopted under a label
  derived from its email before the row is rewritten.
- `detectActiveLabel` returned the remembered `active-label` even when it did
  not match the active credential. Since that file is rewritten on every save,
  it routinely named the wrong account: `/codex current` reported the wrong
  login, and the switch above treated an unlabelled credential as labelled,
  which is what defeated its own auto-snapshot. Only a verified match is
  reported now.

### Added

- `/codex import` (alias `/codex adopt`) adopts every Codex credential the host
  already holds, labelling each from its email. On OMP this turns a bare
  `/codex list` into the full set of logins immediately, with no re-login. It
  writes snapshot files only and is idempotent.
- The "no saved accounts" message now distinguishes an empty credential store
  from one holding accounts that were never adopted, and names them.
- `/codex list` and the picker show the account email instead of only a
  truncated account id.

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
