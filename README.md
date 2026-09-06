# pi-codex-account

**pi-codex-account** for [Oh My Pi](https://ohmy.pi) (OMP) — save, switch, inspect, and manage multiple OpenAI Codex (ChatGPT) OAuth accounts.

Forked from [MateuszJuszczyk/omp-codex-account](https://github.com/MateuszJuszczyk/omp-codex-account)
(itself a fork of [fadilsflow/pi-codex-account](https://github.com/fadilsflow/pi-codex-account)), kept
typechecked against the OMP release actually in use.

## Problem

Your AI coding agent stores one `openai-codex` login at a time. If you have multiple Codex accounts — work, personal, team — switching between them means re-authenticating every time. This extension saves named snapshots of your Codex OAuth credentials and swaps the active login on demand.

## Storage

**pi-codex-account** auto-detects which credential store to use:

| Environment | Storage backend | Location |
|---|---|---|
| **Oh My Pi** (OMP) | SQLite (`bun:sqlite`) | `~/.omp/agent/agent.db` — credentials saved and restored from the database. Named snapshots stored as JSON files in `~/.omp/codex-accounts/`. |
| **Legacy Pi** | JSON file | `~/.pi/agent/auth.json` (active login), `~/.pi/agent/codex-accounts.json` (saved snapshots). |

Detection works in order:
1. If `~/.omp/agent/agent.db` exists and contains `openai-codex` credentials, it uses the **OMP SQLite backend**.
2. Otherwise, it falls back to the **legacy JSON backend**.

Both backends present the same commands and behaviour.

> **Environment variables for override:**
> - `OMP_AGENT_DB_PATH` — path to the OMP agent database (default `~/.omp/agent/agent.db`)
> - `OMP_CODEX_ACCOUNTS_DIR` — directory for named credential snapshots (default `~/.omp/codex-accounts`)
> - `PI_CODING_AGENT_DIR` — path to the legacy Pi agent directory (default `~/.pi/agent`)

## Install

### From GitHub (Oh My Pi)

```bash
omp plugin install github:seiz888/omp-codex-account
```

`npm:github:<owner>/<repo>` is rejected by OMP as an invalid package name; use the
`github:` form above, or the full HTTPS clone URL.

### From a local checkout

```bash
git clone https://github.com/MateuszJuszczyk/pi-codex-account
pi -e /path/to/pi-codex-account
```

After installing or updating, reload the agent:

```text
/reload
```

## Commands

Use `/codex` without arguments to open the interactive account picker.

**On OMP, run `/codex import` first.** OMP stores every `openai-codex` login it
has been given as its own row in `agent.db` and picks one per request, rotating
past rows it has blocked. Those accounts are real and already in use, but they
were never saved through this extension, so `/codex list` starts empty. `import`
adopts them all in one step — it only writes snapshot files and never modifies a
credential.

| Command | What it does |
|---|---|
| `/codex import` | Adopt every Codex login already in the credential store, labelled by email. Start here on OMP. |
| `/codex save <label>` | Save the current Codex login under a label. |
| `/codex switch <label>` | Switch to a saved login and reload the agent. |
| `/codex list` | List all saved logins. |
| `/codex current` | Show the active (in-use) login. |
| `/codex usage` | Query usage for the active login from ChatGPT's usage endpoint. |
| `/codex status` | Show active logins and storage backend details. |
| `/codex debug-db` | Inspect internal credential rows in the OMP agent database. |
| `/codex rename <old> <new>` | Rename a saved login. |
| `/codex remove <label>` | Delete a saved login. |

`/codex-account` is also a registered alias.
`/codex switch` (or `/codex use`) will try to match an unknown token as a label, so `/codex personal` is a shortcut for `/codex switch personal`.

Short aliases: `ls` = `list`, `mv` = `rename`, `rm`/`delete` = `remove`, `active` = `current`, `use` = `switch`.

## Typical flow — two accounts

```text
/codex import         ← adopt logins OMP already holds
/codex list           ← they are all there, labelled by email

/login openai-codex
/codex save work

/login openai-codex   ← authenticate with your personal account
/codex save personal

/codex switch work    ← back to work credentials
/codex current        ← verify active login
```

Now you can flip between both accounts any time with `/codex switch work` or `/codex switch personal`.

## Diagnostics

### /codex status

Shows the storage backend (OMP SQLite or legacy JSON), how many credentials are stored, and which label is currently active.

### /codex debug-db

When running on the OMP backend, shows SQLite table names, column names, and the `openai-codex` row count. It intentionally does **not** print OAuth token values.

### Usage check

If `/codex usage` reports an expired token, send one model request first to let the agent refresh the credentials, then run `/codex usage` again.

## Security

The credential store contains OAuth tokens that grant access to your OpenAI Codex account.

- **OMP backend:** credentials are stored in `~/.omp/agent/agent.db` (the OMP agent database) with named snapshots in `~/.omp/codex-accounts/`.
- **Legacy backend:** credentials are in `~/.pi/agent/auth.json` and snapshots in `~/.pi/agent/codex-accounts.json`.

**Never** commit, share, or copy these files to untrusted machines. The legacy backend writes `codex-accounts.json` with `0600` permissions (owner read/write only).

### Backups

Before every SQLite write, the OMP backend creates:

```text
~/.omp/agent/agent.db.bak.<timestamp>
```

Named snapshots are plain JSON files. You can back them up by copying:
- OMP: `~/.omp/codex-accounts/*.json`
- Legacy: `~/.pi/agent/codex-accounts.json`

To restore snapshots, place the files back in the same location and run `/reload`.

## Development

```bash
git clone https://github.com/MateuszJuszczyk/pi-codex-account
cd pi-codex-account
bun install
bun run typecheck        # types against legacy Pi
bun run typecheck:omp    # types against OMP
bun run typecheck:all    # both
bun test             # Run test suite
```

The Pi extension manifest lives in `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## Compatibility

- **Oh My Pi / OMP** — full support with OMP SQLite credential storage.
- **Legacy Pi** — full backward compatibility via `~/.pi/agent/auth.json` + `codex-accounts.json`.
- Requires `@earendil-works/pi-coding-agent` as a peer dependency.
