/**
 * codex-accounts — switch between multiple OpenAI Codex (ChatGPT) logins in pi.
 *
 * pi only stores ONE set of `openai-codex` OAuth credentials at a time.
 * This extension keeps named snapshots and lets you swap which one is active.
 *
 * Two storage backends:
 *   AuthJsonStorage    — legacy ~/.pi/agent/auth.json + codex-accounts.json
 *   OmpAgentDbStorage  — OMP ~/.omp/agent/agent.db (bun:sqlite) + separate
 *                        snapshot files at ~/.omp/codex-accounts/<label>.json
 *
 * Auto-detected via resolveActiveStorage(): OMP preferred when agent.db exists
 * and has openai-codex credentials; falls back to AuthJsonStorage.
 *
 * Commands:
 *   /codex                 Interactive: pick an account to switch to
 *   /codex list            List saved accounts (active one marked)
 *   /codex current         Show which account is active right now
 *   /codex save <label>    Snapshot the CURRENT logged-in codex creds
 *   /codex switch <label>  Make <label> the active codex account
 *   /codex usage           Show usage for the active account
 *   /codex status          Show storage backend info (no tokens)
 *   /codex debug-db        Show DB schema/provider counts (no tokens)
 *   /codex rename <a> <b>  Rename account <a> to <b>
 *   /codex remove <label>  Delete a saved account
 *
 * Typical flow:
 *   1. /login openai-codex            (log in to account #1)
 *   2. /codex save work               (snapshot it as "work")
 *   3. /login openai-codex            (log in to account #2)
 *   4. /codex save personal           (snapshot it as "personal")
 *   5. /codex switch work             (swap back to account #1 — auto reloads)
 *   6. /codex usage                   (show usage for the active account)
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// @ts-ignore - OMP runs plugins on Bun; some packaged installs do not carry bun:sqlite declarations.
import { Database } from "bun:sqlite";

const CODEX_PROVIDER_ID = "openai-codex";
/**
 * Written into `disabled_cause` for rows this extension parks so one account is
 * the only candidate left.
 *
 * OMP picks a credential per request from every non-disabled row of a provider
 * (`auth-storage.ts#selectCredentialByType`) and short-circuits to the single
 * row when only one remains, so parking the others pins the survivor without
 * touching any credential. The marker is deliberately distinctive: only rows
 * carrying THIS exact cause are ever re-enabled, so a row OMP disabled for a
 * real reason is never silently resurrected.
 */
const PIN_PAUSE_CAUSE = "paused by /codex pin (pi-codex-account)";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_SETTINGS_URL = "https://chatgpt.com/codex/settings/usage";
const DEFAULT_USAGE_TIMEOUT_MS = 15_000;
const BAR_SEGMENTS = 20;
const LIMIT_VALUE_COLUMN = 29;
const MAX_ERROR_BODY_CHARS = 600;

/** Shape of an `openai-codex` OAuth credential. */
export interface CodexCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  [key: string]: unknown;
}

export interface SavedAccount {
  /** The credential snapshot. */
  credential: CodexCredential;
  /** When this snapshot was saved (ms). */
  savedAt: number;
  /** Last time this account was made active (ms). */
  lastUsedAt?: number;
}

export interface DbAccount {
  /** `auth_credentials.id`, or -1 when the table has no id column. */
  id: number;
  credential: CodexCredential;
  /** Non-null when OMP has disabled this row (e.g. a failed refresh). */
  disabledCause?: string;
}

export interface ImportResult {
  /** Labels newly written by the import. */
  imported: string[];
  /** Labels that already covered a host credential, left untouched. */
  skipped: string[];
}

/**
 * Derives a snapshot label from a credential, preferring the email local part
 * (`work@example.com` -> `work`) and falling back to the account id.
 */
export function labelFromCredential(credential: CodexCredential): string {
  const email = credential.email;
  if (typeof email === "string" && email.includes("@")) {
    const local = sanitizeLabel(email.slice(0, email.indexOf("@")));
    if (local) return local;
  }
  const id = credential.accountId;
  if (typeof id === "string" && id) return `account-${id.slice(0, 8)}`;
  return "account";
}

/** Appends `-2`, `-3`, ... until the label is free. */
export function uniqueLabel(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface AccountsStore {
  /** label -> account */
  accounts: Record<string, SavedAccount>;
  /** Label of the account last activated via this extension. */
  active?: string;
}

// ---------------------------------------------------------------------------
// Storage abstraction layer
// ---------------------------------------------------------------------------

export interface StorageDebugInfo {
  kind: string;
  path: string;
  hasCodexRows: boolean;
  providerRowCount: number;
  tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>;
}

export interface ICredentialStorage {
  /** Read the currently active codex credential, if any. */
  readActiveCredential(): CodexCredential | undefined;

  /** Write a codex credential as the active one. */
  writeActiveCredential(credential: CodexCredential): void;

  /** List saved account labels, sorted. */
  listLabels(): string[];

  /** Read a saved account by label. */
  readAccount(label: string): SavedAccount | undefined;

  /** Save or update an account. */
  saveAccount(label: string, account: SavedAccount): void;

  /** Remove a saved account. */
  removeAccount(label: string): void;

  /** Rename a saved account. Returns false if source missing or target exists. */
  renameAccount(from: string, to: string): boolean;

  /** Detect which saved label matches the active credential. */
  detectActiveLabel(credential: CodexCredential | undefined): string | undefined;

  /** Switch active credential to the one from a saved account. */
  switchTo(credential: CodexCredential, label: string): void;

  /**
   * Credentials the host already holds that have no snapshot yet.
   *
   * OMP keeps every `openai-codex` login it has ever been given as its own row
   * in `agent.db` and rotates across them by itself, so a fresh install can be
   * holding several accounts while this extension has saved none. Returns a
   * display string per unsaved credential (email when known).
   */
  listUnsaved(): string[];

  /**
   * Adopts every host credential that has no snapshot yet, labelling each from
   * its email. Purely additive: it writes snapshot files and never touches the
   * credentials themselves.
   */
  importExisting(): ImportResult;

  /**
   * Whether this backend can pin an account without rewriting credentials.
   * True for OMP, whose store holds every login as its own row; false for the
   * legacy JSON backend, which has a single credential slot.
   */
  supportsPinning(): boolean;

  /** Label of the currently pinned account, if one is pinned. */
  pinnedLabel(): string | undefined;

  /**
   * Whether a pin is active AND its target is still usable. False both when
   * nothing is pinned and when the pinned credential has since been disabled —
   * the second case is a session with no Codex login left.
   */
  pinHealthy(): boolean;

  /** Releases a pin, restoring every row this extension parked. Returns the count. */
  unpin(): number;

  /** Human-readable storage description (no tokens). */
  description(): string;

  /** Debug info (schema/counts, no token values). */
  debugInfo(): StorageDebugInfo;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override && override.trim().length > 0) {
    const trimmed = override.trim();
    if (trimmed === "~") return homedir();
    if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
    return trimmed;
  }
  return join(homedir(), ".pi", "agent");
}

function getOmpAgentDbPath(): string {
  const override = process.env.OMP_AGENT_DB_PATH;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".omp", "agent", "agent.db");
}

function getOmpCodexAccountsDir(): string {
  const override = process.env.OMP_CODEX_ACCOUNTS_DIR;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".omp", "codex-accounts");
}

// ---------------------------------------------------------------------------
// JSON file helpers
// ---------------------------------------------------------------------------

function readJsonFile<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    const raw = readFileSync(path, "utf-8").trim();
    if (raw.length === 0) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFileSecure(path: string, data: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort
  }
}

/** Safely parse a JSON value into a CodexCredential. */
export function normalizedCredential(
  value: unknown,
): CodexCredential | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const access = typeof obj.access === "string"
    ? obj.access
    : typeof obj.access_token === "string"
      ? obj.access_token
      : undefined;
  const refresh = typeof obj.refresh === "string"
    ? obj.refresh
    : typeof obj.refresh_token === "string"
      ? obj.refresh_token
      : undefined;
  if (!access || !refresh) return undefined;
  const expires = typeof obj.expires === "number"
    ? obj.expires
    : typeof obj.expires_at === "number"
      ? obj.expires_at
      : 0;
  return {
    ...obj,
    type: "oauth",
    access,
    refresh,
    expires,
    accountId: typeof obj.accountId === "string" ? obj.accountId : undefined,
  };
}

// ---------------------------------------------------------------------------
// AuthJsonStorage — legacy ~/.pi/agent/auth.json + codex-accounts.json
// ---------------------------------------------------------------------------

export class AuthJsonStorage implements ICredentialStorage {
  private agentDir: string;

  constructor(agentDir?: string) {
    this.agentDir = agentDir ?? getAgentDir();
  }

  private authPath(): string {
    return join(this.agentDir, "auth.json");
  }

  private storePath(): string {
    return join(this.agentDir, "codex-accounts.json");
  }

  readActiveCredential(): CodexCredential | undefined {
    const auth = readJsonFile<Record<string, unknown>>(this.authPath(), {});
    return normalizedCredential(auth[CODEX_PROVIDER_ID]);
  }

  writeActiveCredential(credential: CodexCredential): void {
    const authPath = this.authPath();
    const auth = readJsonFile<Record<string, unknown>>(authPath, {});
    auth[CODEX_PROVIDER_ID] = {
      ...credential,
      type: "oauth",
      // Force pi to refresh-from-disk on next use so the swap takes effect.
      expires: 0,
    };
    writeJsonFileSecure(authPath, auth);
  }

  private loadStore(): AccountsStore {
    const store = readJsonFile<Partial<AccountsStore>>(this.storePath(), {});
    return {
      accounts:
        store.accounts && typeof store.accounts === "object"
          ? store.accounts
          : ({} as Record<string, SavedAccount>),
      active: typeof store.active === "string" ? store.active : undefined,
    };
  }

  private saveStore(store: AccountsStore): void {
    writeJsonFileSecure(this.storePath(), store);
  }

  listLabels(): string[] {
    return Object.keys(this.loadStore().accounts).sort();
  }

  readAccount(label: string): SavedAccount | undefined {
    return this.loadStore().accounts[label];
  }

  saveAccount(label: string, account: SavedAccount): void {
    const store = this.loadStore();
    store.accounts[label] = account;
    store.active = label;
    this.saveStore(store);
  }

  removeAccount(label: string): void {
    const store = this.loadStore();
    delete store.accounts[label];
    if (store.active === label) store.active = undefined;
    this.saveStore(store);
  }

  renameAccount(from: string, to: string): boolean {
    const store = this.loadStore();
    if (!store.accounts[from]) return false;
    if (store.accounts[to]) return false;
    store.accounts[to] = store.accounts[from]!;
    delete store.accounts[from];
    if (store.active === from) store.active = to;
    this.saveStore(store);
    return true;
  }

  detectActiveLabel(credential: CodexCredential | undefined): string | undefined {
    if (!credential) return undefined;
    const store = this.loadStore();
    for (const [label, acct] of Object.entries(store.accounts)) {
      const c = acct.credential;
      if (
        credential.accountId &&
        c.accountId &&
        credential.accountId === c.accountId
      ) {
        return label;
      }
    }
    for (const [label, acct] of Object.entries(store.accounts)) {
      if (acct.credential.refresh === credential.refresh) return label;
    }
    return store.active;
  }

  switchTo(credential: CodexCredential, label: string): void {
    // Auto-snapshot the currently-active account first
    const store = this.loadStore();
    const currentActive = this.readActiveCredential();
    if (currentActive) {
      const activeLabel = this.detectActiveLabel(currentActive);
      if (activeLabel && store.accounts[activeLabel]) {
        store.accounts[activeLabel] = {
          ...store.accounts[activeLabel]!,
          credential: { ...currentActive, type: "oauth" },
        };
      }
    }

    this.writeActiveCredential(credential);

    // Update last used time
    if (store.accounts[label]) {
      store.accounts[label] = {
        ...store.accounts[label]!,
        lastUsedAt: Date.now(),
      };
    }
    store.active = label;
    this.saveStore(store);
  }

  listUnsaved(): string[] {
    const active = this.readActiveCredential();
    if (!active) return [];
    if (this.detectActiveLabel(active)) return [];
    const email = active.email;
    return [typeof email === "string" && email ? email : shortAccountId(active)];
  }

  importExisting(): ImportResult {
    const active = this.readActiveCredential();
    if (!active) return { imported: [], skipped: [] };
    const existing = this.detectActiveLabel(active);
    if (existing) return { imported: [], skipped: [existing] };
    const taken = new Set(this.listLabels());
    const label = uniqueLabel(labelFromCredential(active), taken);
    this.saveAccount(label, {
      credential: { ...active, type: "oauth" },
      savedAt: Date.now(),
    });
    return { imported: [label], skipped: [] };
  }

  supportsPinning(): boolean {
    // The legacy store keeps a single active credential, so there is nothing
    // to pin against: switching necessarily rewrites that one slot.
    return false;
  }

  pinnedLabel(): string | undefined {
    return undefined;
  }

  pinHealthy(): boolean {
    return false;
  }

  unpin(): number {
    return 0;
  }

  description(): string {
    const authPath = this.authPath();
    return `AuthJsonStorage (auth: ${authPath}, store: ${this.storePath()})`;
  }

  debugInfo(): StorageDebugInfo {
    const authPath = this.authPath();
    const auth = readJsonFile<Record<string, unknown>>(authPath, {});
    const hasCodexRows = !!normalizedCredential(auth[CODEX_PROVIDER_ID]);
    return {
      kind: "AuthJsonStorage",
      path: authPath,
      hasCodexRows,
      providerRowCount: hasCodexRows ? 1 : 0,
      tables: [],
    };
  }
}

// Backward-compatible test/public helpers from the original package. They operate
// on the legacy auth.json backend only; command handlers use resolveActiveStorage().
export function loadStore(): AccountsStore {
  const storage = new AuthJsonStorage() as unknown as { loadStore(): AccountsStore };
  return storage.loadStore();
}

export function saveStore(store: AccountsStore): void {
  const storage = new AuthJsonStorage() as unknown as { saveStore(store: AccountsStore): void };
  storage.saveStore(store);
}

export function writeActiveCodexCredential(credential: CodexCredential): void {
  new AuthJsonStorage().writeActiveCredential(credential);
}

export function detectActiveLabel(
  store: AccountsStore,
  active: CodexCredential | undefined,
): string | undefined {
  if (!active) return undefined;
  for (const [label, acct] of Object.entries(store.accounts)) {
    const credential = acct.credential;
    if (
      active.accountId &&
      credential.accountId &&
      active.accountId === credential.accountId
    ) {
      return label;
    }
  }
  for (const [label, acct] of Object.entries(store.accounts)) {
    if (acct.credential.refresh === active.refresh) return label;
  }
  // `store.active` is the last label written, not a verified match — see the
  // note on OmpAgentDbStorage.detectActiveLabel.
  return undefined;
}

// ---------------------------------------------------------------------------
// OmpAgentDbStorage — OMP bun:sqlite agent.db + snapshot files
// ---------------------------------------------------------------------------

/**
 * Shape of an OMP credential snapshot saved to disk. Carries all original
 * DB columns needed to restore the row, plus a normalized CodexCredential
 * for existing UI/usage code.
 */
export interface OmpCredentialSnapshot {
  /** DB column values for restore */
  row: {
    provider: string;
    credential_type: string;
    data: Record<string, unknown>;
    identity_key: string | null;
    disabled_cause: string | null;
  };
  /** Normalized credential for existing UI */
  credential: CodexCredential;
  /** Metadata */
  savedAt: number;
  lastUsedAt?: number;
}

interface AuthCredColumns {
  id: boolean;
  provider: boolean;
  credential_type: boolean;
  data: boolean;
  disabled_cause: boolean;
  identity_key: boolean;
  created_at: boolean;
  updated_at: boolean;
}

interface TableIntrospection {
  hasAuthCredentials: boolean;
  tableName?: string;
  columns: AuthCredColumns;
  error?: string;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, "\"\"")}"`;
}

function runSql(db: Database, sql: string, ...bindings: unknown[]): void {
  (db.run as unknown as (query: string, ...params: unknown[]) => void)(
    sql,
    ...bindings,
  );
}

function introspectCredentialsTable(db: Database): TableIntrospection {
  try {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY CASE WHEN name = 'auth_credentials' THEN 0 ELSE 1 END, name")
      .all() as Array<{ name: string }>;

    for (const table of tables) {
      const cols = db
        .query(`PRAGMA table_info(${quoteIdent(table.name)})`)
        .all() as Array<{ name: string; type: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      const columns = {
        id: colNames.has("id"),
        provider: colNames.has("provider"),
        credential_type: colNames.has("credential_type"),
        data: colNames.has("data"),
        disabled_cause: colNames.has("disabled_cause"),
        identity_key: colNames.has("identity_key"),
        created_at: colNames.has("created_at"),
        updated_at: colNames.has("updated_at"),
      };
      if (!columns.provider || !columns.data) continue;

      try {
        const rows = db
          .query(`SELECT COUNT(*) AS cnt FROM ${quoteIdent(table.name)} WHERE provider = ?`)
          .all(CODEX_PROVIDER_ID) as Array<{ cnt: number }>;
        if ((rows[0]?.cnt ?? 0) > 0 || table.name === "auth_credentials") {
          return {
            hasAuthCredentials: true,
            tableName: table.name,
            columns,
          };
        }
      } catch {
        // Not a provider/data credential table.
      }
    }

    return { hasAuthCredentials: false, columns: blankColumns() };
  } catch (e) {
    return {
      hasAuthCredentials: false,
      columns: blankColumns(),
      error: String(e),
    };
  }
}

function blankColumns(): AuthCredColumns {
  return {
    id: false,
    provider: false,
    credential_type: false,
    data: false,
    disabled_cause: false,
    identity_key: false,
    created_at: false,
    updated_at: false,
  };
}

/** Is this credential currently blocked in auth_credential_blocks? */
function isCredentialBlocked(db: Database, credentialId: number): boolean {
  try {
    const rows = db
      .query(
        "SELECT 1 FROM auth_credential_blocks WHERE credential_id = ? AND (blocked_until_ms IS NULL OR blocked_until_ms > ?) LIMIT 1",
      )
      .all(credentialId, Date.now()) as Array<Record<string, unknown>>;
    return rows.length > 0;
  } catch {
    // Table may not exist or other error — assume not blocked.
    return false;
  }
}

export class OmpAgentDbStorage implements ICredentialStorage {
  private dbPath: string;
  private snapshotsDir: string;
  private activeLabelPath: string;

  constructor(dbPath?: string, snapshotsDir?: string) {
    this.dbPath = dbPath ?? getOmpAgentDbPath();
    this.snapshotsDir = snapshotsDir ?? getOmpCodexAccountsDir();
    this.activeLabelPath = join(this.snapshotsDir, "active-label");
  }

  private openDb(readonly = false): Database {
    return readonly
      ? new Database(this.dbPath, { readonly: true })
      : new Database(this.dbPath);
  }

  /**
   * Every `openai-codex` OAuth row OMP holds, oldest first.
   *
   * OMP does not keep a single "logged in" credential: it stores each login as
   * its own row and picks one per request, rotating past rows it has blocked
   * (see `auth-storage.ts#selectCredentialByType`). Enumerating them is what
   * lets this extension see accounts the user never saved through it.
   */
  listDbAccounts(): DbAccount[] {
    try {
      const db = this.openDb(true);
      try {
        const intro = introspectCredentialsTable(db);
        if (
          !intro.hasAuthCredentials ||
          !intro.columns.provider ||
          !intro.columns.data
        ) {
          return [];
        }
        const rows = db
          .query(
            `SELECT * FROM ${quoteIdent(intro.tableName ?? "auth_credentials")}
             WHERE provider = ? AND credential_type = ?
             ORDER BY id ASC`,
          )
          .all(CODEX_PROVIDER_ID, "oauth") as Array<Record<string, unknown>>;

        const accounts: DbAccount[] = [];
        for (const row of rows) {
          const data = parseDataField(row.data);
          const credential = normalizedCredential(data);
          if (!credential) continue;
          accounts.push({
            id: typeof row.id === "number" ? row.id : -1,
            credential: { ...data, ...credential, type: "oauth" },
            disabledCause:
              typeof row.disabled_cause === "string"
                ? row.disabled_cause
                : undefined,
          });
        }
        return accounts;
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  }

  /** Snapshot labels indexed by the account id they hold. */
  private labelsByAccountId(): Map<string, string> {
    const byAccount = new Map<string, string>();
    for (const label of this.listLabels()) {
      const accountId = this.readAccount(label)?.credential.accountId;
      if (typeof accountId === "string" && accountId) {
        byAccount.set(accountId, label);
      }
    }
    return byAccount;
  }

  listUnsaved(): string[] {
    const saved = this.labelsByAccountId();
    const unsaved: string[] = [];
    for (const account of this.listDbAccounts()) {
      const accountId = account.credential.accountId;
      if (typeof accountId === "string" && saved.has(accountId)) continue;
      const email = account.credential.email;
      unsaved.push(
        typeof email === "string" && email
          ? email
          : shortAccountId(account.credential),
      );
    }
    return unsaved;
  }

  importExisting(): ImportResult {
    const saved = this.labelsByAccountId();
    const taken = new Set(this.listLabels());
    const imported: string[] = [];
    const skipped: string[] = [];

    for (const account of this.listDbAccounts()) {
      const accountId = account.credential.accountId;
      const existing =
        typeof accountId === "string" ? saved.get(accountId) : undefined;
      if (existing) {
        skipped.push(existing);
        continue;
      }
      const label = uniqueLabel(labelFromCredential(account.credential), taken);
      taken.add(label);
      this.saveAccount(label, {
        credential: account.credential,
        savedAt: Date.now(),
      });
      imported.push(label);
    }

    return { imported, skipped };
  }

  /** The `auth_credentials` row holding a given account id, if any. */
  private findRowByAccountId(accountId: string): DbAccount | undefined {
    return this.listDbAccounts().find(
      (account) => account.credential.accountId === accountId,
    );
  }

  supportsPinning(): boolean {
    return true;
  }

  /**
   * Parks every other Codex row so `accountId` is the only candidate OMP has.
   *
   * Nothing is rewritten: only `disabled_cause` changes, and only on rows that
   * were either free or parked by us before. A row OMP itself disabled keeps
   * its own cause and stays disabled.
   */
  pinAccount(accountId: string): { pinnedId: number; paused: number } {
    const target = this.findRowByAccountId(accountId);
    if (!target) throw new Error(`no stored credential for account ${accountId}`);
    if (target.disabledCause && target.disabledCause !== PIN_PAUSE_CAUSE) {
      throw new Error(
        `OMP has disabled that credential (${target.disabledCause}); pinning it would leave no usable Codex login`,
      );
    }

    const db = this.openDb();
    try {
      const intro = introspectCredentialsTable(db);
      if (!intro.hasAuthCredentials || !intro.columns.disabled_cause) {
        throw new Error("this agent.db has no disabled_cause column to pin with");
      }
      const table = quoteIdent(intro.tableName ?? "auth_credentials");
      this.backupDb();

      // Release the target first, so a re-pin of an already-parked row works.
      runSql(
        db,
        `UPDATE ${table} SET disabled_cause = NULL
         WHERE provider = ? AND credential_type = ? AND id = ? AND disabled_cause = ?`,
        CODEX_PROVIDER_ID,
        "oauth",
        target.id,
        PIN_PAUSE_CAUSE,
      );

      runSql(
        db,
        `UPDATE ${table} SET disabled_cause = ?
         WHERE provider = ? AND credential_type = ? AND id != ? AND disabled_cause IS NULL`,
        PIN_PAUSE_CAUSE,
        CODEX_PROVIDER_ID,
        "oauth",
        target.id,
      );

      const paused = (
        db
          .query(
            `SELECT COUNT(*) AS n FROM ${table}
             WHERE provider = ? AND credential_type = ? AND disabled_cause = ?`,
          )
          .get(CODEX_PROVIDER_ID, "oauth", PIN_PAUSE_CAUSE) as { n?: number } | null
      )?.n ?? 0;

      return { pinnedId: target.id, paused };
    } finally {
      db.close();
    }
  }

  /** The account id left running while others are parked, if a pin is active. */
  pinnedAccountId(): string | undefined {
    const accounts = this.listDbAccounts();
    const parked = accounts.filter((a) => a.disabledCause === PIN_PAUSE_CAUSE);
    if (parked.length === 0) return undefined;
    const running = accounts.filter((a) => !a.disabledCause);
    if (running.length !== 1) return undefined;
    const accountId = running[0]!.credential.accountId;
    return typeof accountId === "string" ? accountId : undefined;
  }

  pinnedLabel(): string | undefined {
    const accountId = this.pinnedAccountId();
    if (!accountId) return undefined;
    return this.labelsByAccountId().get(accountId);
  }

  pinHealthy(): boolean {
    return this.pinnedAccountId() !== undefined;
  }

  unpin(): number {
    const db = this.openDb();
    try {
      const intro = introspectCredentialsTable(db);
      if (!intro.hasAuthCredentials || !intro.columns.disabled_cause) return 0;
      const table = quoteIdent(intro.tableName ?? "auth_credentials");
      const parked = (
        db
          .query(
            `SELECT COUNT(*) AS n FROM ${table}
             WHERE provider = ? AND credential_type = ? AND disabled_cause = ?`,
          )
          .get(CODEX_PROVIDER_ID, "oauth", PIN_PAUSE_CAUSE) as { n?: number } | null
      )?.n ?? 0;
      if (parked === 0) return 0;

      this.backupDb();
      runSql(
        db,
        `UPDATE ${table} SET disabled_cause = NULL
         WHERE provider = ? AND credential_type = ? AND disabled_cause = ?`,
        CODEX_PROVIDER_ID,
        "oauth",
        PIN_PAUSE_CAUSE,
      );
      return parked;
    } finally {
      db.close();
    }
  }

  description(): string {
    return `OmpAgentDbStorage (db: ${this.dbPath}, snapshots: ${this.snapshotsDir})`;
  }

  debugInfo(): StorageDebugInfo {
    try {
      const db = this.openDb(true);
      try {
        const intro = introspectCredentialsTable(db);
        let providerRowCount = 0;
        if (intro.hasAuthCredentials && intro.columns.provider) {
          const countRows = db
            .query(
              `SELECT COUNT(*) AS cnt FROM ${quoteIdent(intro.tableName ?? "auth_credentials")} WHERE provider = ?`,
            )
            .all(CODEX_PROVIDER_ID) as Array<{ cnt: number }>;
          providerRowCount = countRows[0]?.cnt ?? 0;
        }

        const tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }> = [];
        try {
          const allTables = db
            .query(
              "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            )
            .all() as Array<{ name: string }>;
          for (const t of allTables) {
            const cols = db
              .query(`PRAGMA table_info('${t.name}')`)
              .all() as Array<{ name: string; type: string }>;
            tables.push({ name: t.name, columns: cols });
          }
        } catch {
          // Best-effort — some tables may not support PRAGMA
        }

        return {
          kind: "OmpAgentDbStorage",
          path: this.dbPath,
          hasCodexRows: providerRowCount > 0,
          providerRowCount,
          tables,
        };
      } finally {
        db.close();
      }
    } catch {
      return {
        kind: "OmpAgentDbStorage",
        path: this.dbPath,
        hasCodexRows: false,
        providerRowCount: 0,
        tables: [],
      };
    }
  }

  /**
   * Find the currently active openai-codex oauth row.
   * Prefers the newest non-disabled row that is not currently blocked.
   * If all are blocked, returns the newest non-disabled row.
   */
  private findActiveRow(
    db: Database,
  ): {
    id: number;
    data: Record<string, unknown>;
    row: Record<string, unknown>;
  } | null {
    const intro = introspectCredentialsTable(db);
    if (
      !intro.hasAuthCredentials ||
      !intro.columns.provider ||
      !intro.columns.data
    ) {
      return null;
    }

    const rows = db
      .query(
        `SELECT * FROM ${quoteIdent(intro.tableName ?? "auth_credentials")}
         WHERE provider = ? AND credential_type = ?
         AND disabled_cause IS NULL
         ORDER BY id DESC`,
      )
      .all(CODEX_PROVIDER_ID, "oauth") as Array<Record<string, unknown>>;

    if (rows.length === 0) return null;

    // First non-blocked row
    if (intro.columns.id) {
      for (const row of rows) {
        const id = row.id as number;
        if (!isCredentialBlocked(db, id)) {
          return {
            id,
            data: parseDataField(row.data),
            row,
          };
        }
      }
    }

    // All blocked — fall back to newest non-disabled row
    const newest = rows[0]!;
    return {
      id: intro.columns.id ? (newest.id as number) : -1,
      data: parseDataField(newest.data),
      row: newest,
    };
  }

  readActiveCredential(): CodexCredential | undefined {
    try {
      const db = this.openDb(true);
      try {
        const found = this.findActiveRow(db);
        if (!found) return undefined;
        const credential = normalizedCredential(found.data);
        return credential ? { ...found.data, ...credential, type: "oauth" } : undefined;
      } finally {
        db.close();
      }
    } catch {
      return undefined;
    }
  }

  writeActiveCredential(credential: CodexCredential): void {
    const db = this.openDb();
    try {
      const intro = introspectCredentialsTable(db);
      if (!intro.hasAuthCredentials) return;

      const found = this.findActiveRow(db);
      if (!found) {
        this.backupDb();
        runSql(
          db,
          `INSERT INTO ${quoteIdent(intro.tableName ?? "auth_credentials")} (provider, credential_type, data, identity_key)
           VALUES (?, ?, ?, ?)`,
          CODEX_PROVIDER_ID,
          "oauth",
          JSON.stringify({
            ...credential,
            type: "oauth",
            expires: 0,
          }),
          credential.accountId
            ? `account:${credential.accountId}`
            : null,
        );
        return;
      }

      this.backupDb();

      const newData = {
        ...credential,
        type: "oauth",
        expires: 0,
      };

      const updates: string[] = [];
      const params: unknown[] = [];

      if (intro.columns.provider) {
        updates.push("provider = ?");
        params.push(CODEX_PROVIDER_ID);
      }
      if (intro.columns.credential_type) {
        updates.push("credential_type = ?");
        params.push("oauth");
      }
      if (intro.columns.data) {
        updates.push("data = ?");
        params.push(JSON.stringify(newData));
      }
      if (intro.columns.identity_key) {
        updates.push("identity_key = ?");
        params.push(
          credential.accountId
            ? `account:${credential.accountId}`
            : null,
        );
      }
      if (intro.columns.disabled_cause) {
        updates.push("disabled_cause = ?");
        params.push(null);
      }
      if (intro.columns.updated_at) {
        updates.push("updated_at = CAST(strftime('%s','now') AS INTEGER)");
      }

      if (intro.columns.id) {
        params.push(found.id);
        runSql(
          db,
          `UPDATE ${quoteIdent(intro.tableName ?? "auth_credentials")} SET ${updates.join(", ")} WHERE id = ?`,
          ...params,
        );
      }
    } finally {
      db.close();
    }
  }

  listLabels(): string[] {
    if (!existsSync(this.snapshotsDir)) return [];
    const labels: string[] = [];
    try {
      const entries = readdirSync(this.snapshotsDir);
      for (const entry of entries) {
        if (entry === "active-label") continue;
        if (entry.endsWith(".json")) {
          labels.push(entry.slice(0, -5));
        }
      }
    } catch {
      // best effort
    }
    return labels.sort();
  }

  readAccount(label: string): SavedAccount | undefined {
    const snap = this.readSnapshot(label);
    if (!snap) return undefined;
    return {
      credential: snap.credential,
      savedAt: snap.savedAt,
      lastUsedAt: snap.lastUsedAt,
    };
  }

  saveAccount(label: string, account: SavedAccount): void {
    const credential = account.credential;
    let row: OmpCredentialSnapshot["row"] = {
      provider: CODEX_PROVIDER_ID,
      credential_type: "oauth",
      data: { ...credential },
      identity_key: credential.accountId
        ? `account:${credential.accountId}`
        : null,
      disabled_cause: null,
    };

    try {
      const db = this.openDb(true);
      try {
        const found = this.findActiveRow(db);
        if (found) {
          row = {
            provider: String(found.row.provider ?? CODEX_PROVIDER_ID),
            credential_type: String(found.row.credential_type ?? "oauth"),
            data: parseDataField(found.row.data),
            identity_key:
              typeof found.row.identity_key === "string"
                ? found.row.identity_key
                : null,
            disabled_cause:
              typeof found.row.disabled_cause === "string"
                ? found.row.disabled_cause
                : null,
          };
        }
      } finally {
        db.close();
      }
    } catch {
      // Fall back to normalized credential data; snapshot still remains restorable.
    }

    const snapshot: OmpCredentialSnapshot = {
      row,
      credential: { ...row.data, ...credential, type: "oauth" },
      savedAt: account.savedAt,
      lastUsedAt: account.lastUsedAt,
    };
    this.writeSnapshot(label, snapshot);
    this.writeActiveLabel(label);
  }

  removeAccount(label: string): void {
    const path = this.snapshotPath(label);
    try {
      if (existsSync(path)) {
        rmSync(path);
      }
    } catch {
      // best effort
    }
    const current = this.readActiveLabel();
    if (current === label) {
      this.writeActiveLabel(undefined);
    }
  }

  renameAccount(from: string, to: string): boolean {
    const fromPath = this.snapshotPath(from);
    const toPath = this.snapshotPath(to);
    if (!existsSync(fromPath)) return false;
    if (existsSync(toPath)) return false;
    try {
      renameSync(fromPath, toPath);
      const active = this.readActiveLabel();
      if (active === from) {
        this.writeActiveLabel(to);
      }
      return true;
    } catch {
      return false;
    }
  }

  detectActiveLabel(credential: CodexCredential | undefined): string | undefined {
    if (!credential) return undefined;

    // First try the stored active label
    const stored = this.readActiveLabel();
    if (stored) {
      const acct = this.readAccount(stored);
      if (acct) {
        const c = acct.credential;
        if (
          credential.accountId &&
          c.accountId &&
          credential.accountId === c.accountId
        ) {
          return stored;
        }
        if (c.refresh === credential.refresh) {
          return stored;
        }
      }
    }

    // Fall back to scanning all labels
    const labels = this.listLabels();
    for (const label of labels) {
      const snap = this.readSnapshot(label);
      if (!snap) continue;
      const c = snap.credential;
      if (
        credential.accountId &&
        c.accountId &&
        credential.accountId === c.accountId
      ) {
        return label;
      }
    }
    for (const label of labels) {
      const snap = this.readSnapshot(label);
      if (!snap) continue;
      if (snap.credential.refresh === credential.refresh) {
        return label;
      }
    }
    // The remembered label is a HINT, not an answer: it is rewritten on every
    // save, so it routinely names an account other than the active one. Earlier
    // it was returned unverified, which made `/codex current` report the wrong
    // account and made `switchTo` treat an unlabelled credential as labelled —
    // overwriting the wrong snapshot and losing the outgoing credential. Only a
    // match established above counts.
    return undefined;
  }

  /**
   * Makes `label` the account OMP uses — by pinning, never by overwriting.
   *
   * The previous implementation rewrote the active row in place, which
   * destroyed whatever credential that row held. OMP stores each login as its
   * own row and selects among the non-disabled ones per request, so the switch
   * instead parks the other rows and leaves the target as the only candidate.
   * Every credential survives, and `unpin()` puts things back.
   *
   * A snapshot with no row of its own (restored from a backup, or carried over
   * from the legacy JSON store) is INSERTED as a new row rather than written
   * over an existing one, then pinned like any other.
   */
  switchTo(credential: CodexCredential, label: string): void {
    const accountId = credential.accountId;

    // Adopt whatever is running now, so a pin is never the reason an
    // un-snapshotted credential becomes unreachable.
    const currentActive = this.readActiveCredential();
    if (currentActive && !this.detectActiveLabel(currentActive)) {
      const adopted = uniqueLabel(
        labelFromCredential(currentActive),
        new Set(this.listLabels()),
      );
      this.saveAccount(adopted, {
        credential: { ...currentActive, type: "oauth" },
        savedAt: Date.now(),
      });
    }

    let targetId =
      typeof accountId === "string"
        ? this.findRowByAccountId(accountId)?.id
        : undefined;

    if (targetId === undefined) {
      const db = this.openDb();
      try {
        const intro = introspectCredentialsTable(db);
        if (!intro.hasAuthCredentials) return;
        this.backupDb();
        runSql(
          db,
          `INSERT INTO ${quoteIdent(intro.tableName ?? "auth_credentials")} (provider, credential_type, data, identity_key)
           VALUES (?, ?, ?, ?)`,
          CODEX_PROVIDER_ID,
          "oauth",
          JSON.stringify({ ...credential, type: "oauth" }),
          typeof accountId === "string" && accountId
            ? `account:${accountId}`
            : null,
        );
      } finally {
        db.close();
      }
      targetId =
        typeof accountId === "string"
          ? this.findRowByAccountId(accountId)?.id
          : undefined;
      if (targetId === undefined) return;
    }

    const pinTarget = this.listDbAccounts().find((a) => a.id === targetId);
    const pinAccountId = pinTarget?.credential.accountId;
    if (typeof pinAccountId !== "string") return;
    this.pinAccount(pinAccountId);

    this.writeActiveLabel(label);

    const existingSnapshot = this.readSnapshot(label);
    if (existingSnapshot) {
      existingSnapshot.lastUsedAt = Date.now();
      this.writeSnapshot(label, existingSnapshot);
    }
  }

  // -----------------------------------------------------------------------
  // Internal snapshot management
  // -----------------------------------------------------------------------

  private snapshotPath(label: string): string {
    return join(this.snapshotsDir, `${sanitizeLabel(label)}.json`);
  }

  private readSnapshot(label: string): OmpCredentialSnapshot | undefined {
    const path = this.snapshotPath(label);
    if (!existsSync(path)) return undefined;
    try {
      const raw = readFileSync(path, "utf-8").trim();
      if (!raw) return undefined;
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.credential &&
        typeof parsed.row === "object"
      ) {
        return parsed as OmpCredentialSnapshot;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private writeSnapshot(label: string, snapshot: OmpCredentialSnapshot): void {
    const dir = this.snapshotsDir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeJsonFileSecure(this.snapshotPath(label), snapshot);
  }

  private readActiveLabel(): string | undefined {
    try {
      if (!existsSync(this.activeLabelPath)) return undefined;
      const raw = readFileSync(this.activeLabelPath, "utf-8").trim();
      return raw || undefined;
    } catch {
      return undefined;
    }
  }

  private writeActiveLabel(label: string | undefined): void {
    const dir = dirname(this.activeLabelPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (label) {
      writeFileSync(this.activeLabelPath, label, {
        encoding: "utf-8",
        mode: 0o600,
      });
    } else {
      try {
        writeFileSync(this.activeLabelPath, "", { encoding: "utf-8" });
      } catch {
        // best effort
      }
    }
  }

  private backupDb(): void {
    if (!existsSync(this.dbPath)) return;
    const backupPath = `${this.dbPath}.bak.${Date.now()}`;
    try {
      copyFileSync(this.dbPath, backupPath);
    } catch {
      // best effort; switch proceeds without a backup
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-detection
// ---------------------------------------------------------------------------

export function resolveActiveStorage(): ICredentialStorage {
  const dbPath = getOmpAgentDbPath();
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const intro = introspectCredentialsTable(db);
        if (
          intro.hasAuthCredentials &&
          intro.columns.provider &&
          intro.columns.data
        ) {
          const rows = db
            .query(
              `SELECT COUNT(*) AS cnt FROM ${quoteIdent(intro.tableName ?? "auth_credentials")} WHERE provider = ?`,
            )
            .all(CODEX_PROVIDER_ID) as Array<{ cnt: number }>;
          if (rows[0] && rows[0].cnt > 0) {
            return new OmpAgentDbStorage();
          }
        }
      } finally {
        db.close();
      }
    } catch {
      // DB corrupt or locked — fall through to AuthJsonStorage
    }
  }
  return new AuthJsonStorage();
}

// ---------------------------------------------------------------------------
// Credential parsing helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Safely parse a JSON data field from the DB. */
function parseDataField(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      // fall through
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function shortAccountId(credential: CodexCredential | undefined): string {
  const id = credential?.accountId;
  if (!id || typeof id !== "string") return "unknown account";
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function formatExpiry(expires: number): string {
  if (!expires || expires <= 0) return "needs refresh";
  const now = Date.now();
  if (expires <= now) return "expired";
  const mins = Math.round((expires - now) / 60000);
  if (mins < 60) return `~${mins}m left`;
  const hours = Math.round(mins / 60);
  return `~${hours}h left`;
}

function summarizeAccount(label: string, acct: SavedAccount): string {
  const email = acct.credential.email;
  const who =
    typeof email === "string" && email ? email : shortAccountId(acct.credential);
  const exp = formatExpiry(acct.credential.expires);
  return `${label} — ${who} (${exp})`;
}

/**
 * Message for "nothing saved yet", which has two very different causes: the
 * host holds no Codex login at all, or it holds several that were never
 * adopted (the normal state on OMP, which collects logins by itself).
 */
function emptyStateMessage(storage: ICredentialStorage): string {
  const unsaved = storage.listUnsaved();
  if (unsaved.length === 0) {
    return "No saved Codex accounts, and none found in the credential store. Log in with /login openai-codex, then run /codex save <label>.";
  }
  const shown = unsaved.slice(0, 6).join(", ");
  const more = unsaved.length > 6 ? `, +${unsaved.length - 6} more` : "";
  return `${unsaved.length} Codex account(s) already in the credential store but not saved here: ${shown}${more}. Run /codex import to adopt them.`;
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function doList(
  ctx: ExtensionCommandContext,
  storage: ICredentialStorage,
): void {
  const labels = storage.listLabels();
  const active = storage.readActiveCredential();
  const activeLabel = storage.detectActiveLabel(active);

  if (labels.length === 0) {
    ctx.ui.notify(
      emptyStateMessage(storage),
      "info",
    );
    return;
  }

  const lines = labels.map((label) => {
    const acct = storage.readAccount(label);
    const marker = label === activeLabel ? "● " : "  ";
    const desc = acct
      ? summarizeAccount(label, acct)
      : `${label} — (empty)`;
    return marker + desc;
  });
  const pinned = storage.pinnedLabel();
  ctx.ui.setWidget("codex-accounts", [
    pinned
      ? `Codex accounts (● = active, pinned to "${pinned}" — /codex unpin to rotate again):`
      : "Codex accounts (● = active, OMP rotates across them):",
    ...lines,
  ]);
  ctx.ui.notify(
    `${labels.length} saved Codex account(s). Active: ${activeLabel ?? "unknown"}.`,
    "info",
  );
}

function doImport(
  ctx: ExtensionCommandContext,
  storage: ICredentialStorage,
): void {
  const { imported, skipped } = storage.importExisting();

  if (imported.length === 0) {
    ctx.ui.notify(
      skipped.length > 0
        ? `Nothing to import — all ${skipped.length} stored credential(s) are already saved.`
        : "Nothing to import: the credential store holds no Codex login.",
      "info",
    );
    return;
  }

  ctx.ui.setWidget("codex-accounts", [
    `Imported ${imported.length} Codex account(s):`,
    ...imported.map((label) => {
      const acct = storage.readAccount(label);
      return "  " + (acct ? summarizeAccount(label, acct) : label);
    }),
  ]);
  ctx.ui.notify(
    `Imported ${imported.length} account(s)${skipped.length > 0 ? `, ${skipped.length} already saved` : ""}. Switch with /codex switch <label>.`,
    "info",
  );
}

async function doUnpin(
  ctx: ExtensionCommandContext,
  storage: ICredentialStorage,
): Promise<void> {
  if (!storage.supportsPinning()) {
    ctx.ui.notify(
      "This credential store has a single active slot, so there is no pin to release.",
      "info",
    );
    return;
  }
  const restored = storage.unpin();
  if (restored === 0) {
    ctx.ui.notify("No pin is active — every Codex account is already in play.", "info");
    return;
  }
  ctx.ui.notify(
    `Released the pin: ${restored} account(s) back in play. OMP will rotate across them again. Reloading…`,
    "info",
  );
  await ctx.reload();
}

function doCurrent(
  ctx: ExtensionCommandContext,
  storage: ICredentialStorage,
): void {
  const active = storage.readActiveCredential();
  if (!active) {
    ctx.ui.notify(
      "No openai-codex credentials found. Run /login openai-codex first.",
      "warning",
    );
    return;
  }
  const label = storage.detectActiveLabel(active);
  ctx.ui.notify(
    `Active Codex account: ${label ?? "(unsaved)"} — ${shortAccountId(active)} (${formatExpiry(active.expires)}).`,
    "info",
  );
}

function doSave(
  ctx: ExtensionCommandContext,
  storage: ICredentialStorage,
  rawLabel: string,
): void {
  if (!rawLabel) {
    ctx.ui.notify("Usage: /codex save <label>", "warning");
    return;
  }
  const active = storage.readActiveCredential();
  if (!active) {
    ctx.ui.notify(
      "No openai-codex credentials to save. Run /login openai-codex first.",
      "warning",
    );
    return;
  }
  const existed = !!storage.readAccount(rawLabel);
  const account: SavedAccount = {
    credential: { ...active, type: "oauth" },
    savedAt: Date.now(),
    lastUsedAt: storage.readAccount(rawLabel)?.lastUsedAt,
  };

  storage.saveAccount(rawLabel, account);

  ctx.ui.notify(
    `${existed ? "Updated" : "Saved"} Codex account "${rawLabel}" — ${shortAccountId(active)}.`,
    "info",
  );
}

async function doSwitch(
  ctx: ExtensionCommandContext,
  storage: ICredentialStorage,
  label: string,
): Promise<void> {
  const acct = storage.readAccount(label);
  if (!acct) {
    const known = storage.listLabels().join(", ") || "(none)";
    ctx.ui.notify(
      `No saved account "${label}". Known accounts: ${known}.`,
      "warning",
    );
    return;
  }

  storage.switchTo(acct.credential, label);

  const pinned = storage.pinnedLabel();
  ctx.ui.notify(
    storage.supportsPinning() && pinned === label
      ? `Pinned Codex account "${label}" — ${acct.credential.email ?? shortAccountId(acct.credential)}. Other accounts are paused, not deleted; /codex unpin restores them. Reloading…`
      : `Switched to Codex account "${label}" — ${acct.credential.email ?? shortAccountId(acct.credential)}. Reloading…`,
    "info",
  );

  // Reload so the model registry / providers re-resolve.
  await ctx.reload();
}

function doRename(
  ctx: ExtensionCommandContext,
  storage: ICredentialStorage,
  from: string,
  to: string,
): void {
  if (!from || !to) {
    ctx.ui.notify("Usage: /codex rename <old> <new>", "warning");
    return;
  }
  if (storage.renameAccount(from, to)) {
    ctx.ui.notify(`Renamed Codex account "${from}" → "${to}".`, "info");
  } else {
    if (!storage.readAccount(from)) {
      ctx.ui.notify(`No saved account "${from}".`, "warning");
    } else {
      ctx.ui.notify(`Account "${to}" already exists.`, "warning");
    }
  }
}

async function doUsage(ctx: ExtensionCommandContext): Promise<void> {
  // Usage always reads from the active storage.
  const storage = resolveActiveStorage();
  const active = storage.readActiveCredential();
  if (!active) {
    ctx.ui.notify(
      "No openai-codex credentials found. Run /login openai-codex first.",
      "warning",
    );
    return;
  }

  if (active.expires > 0 && active.expires <= Date.now()) {
    ctx.ui.notify(
      "The active Codex access token is expired. Send one Codex model request first so pi refreshes it, then run /codex usage again.",
      "warning",
    );
    return;
  }

  ctx.ui.setStatus("codex-accounts-usage", undefined);
  try {
    const report = await queryCodexUsage(active, DEFAULT_USAGE_TIMEOUT_MS);
    ctx.ui.notify(formatUsageReport(report, active), "info");
  } catch (error) {
    ctx.ui.notify(`Unable to read Codex usage: ${errorMessage(error)}`, "error");
  }
}

function doStatus(
  ctx: ExtensionCommandContext,
  storage: ICredentialStorage,
): void {
  const desc = storage.description();
  const active = storage.readActiveCredential();
  const hasCreds = !!active;
  const label = storage.detectActiveLabel(active);
  ctx.ui.notify(
    `Storage: ${desc}\n` +
      `Has openai-codex: ${hasCreds ? "yes" : "no"}\n` +
      `Saved accounts: ${storage.listLabels().length}\n` +
      `Active label: ${label ?? "(none)"}`,
    "info",
  );
}

function doDebugDb(
  ctx: ExtensionCommandContext,
  storage: ICredentialStorage,
): void {
  const info = storage.debugInfo();
  const lines: string[] = [
    `Kind: ${info.kind}`,
    `Path: ${info.path}`,
    `Has openai-codex rows: ${info.hasCodexRows}`,
    `Provider row count (openai-codex): ${info.providerRowCount}`,
  ];
  if (info.tables.length > 0) {
    lines.push("", "Tables:");
    for (const t of info.tables) {
      lines.push(
        `  ${t.name} (${t.columns.length} cols: ${t.columns.map((c) => `${c.name} ${c.type}`).join(", ")})`,
      );
    }
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

function doRemove(
  ctx: ExtensionCommandContext,
  storage: ICredentialStorage,
  label: string,
): void {
  if (!label) {
    ctx.ui.notify("Usage: /codex remove <label>", "warning");
    return;
  }
  if (!storage.readAccount(label)) {
    ctx.ui.notify(`No saved account "${label}".`, "warning");
    return;
  }
  storage.removeAccount(label);
  ctx.ui.notify(
    `Removed Codex account "${label}". (Active credential was not modified.)`,
    "info",
  );
}

async function doInteractive(
  ctx: ExtensionCommandContext,
  storage: ICredentialStorage,
): Promise<void> {
  const labels = storage.listLabels();
  if (labels.length === 0) {
    ctx.ui.notify(
      emptyStateMessage(storage),
      "info",
    );
    return;
  }
  const active = storage.readActiveCredential();
  const activeLabel = storage.detectActiveLabel(active);

  const options = labels.map((label) => {
    const acct = storage.readAccount(label);
    const marker = label === activeLabel ? "● " : "  ";
    const desc = acct
      ? summarizeAccount(label, acct)
      : `${label} — (empty)`;
    return marker + desc;
  });

  const choice = await ctx.ui.select("Switch to Codex account:", options);
  if (!choice) return;
  const idx = options.indexOf(choice);
  if (idx < 0) return;
  const label = labels[idx]!;
  if (label === activeLabel) {
    ctx.ui.notify(`"${label}" is already active.`, "info");
    return;
  }
  await doSwitch(ctx, storage, label);
}

// ---------------------------------------------------------------------------
// Usage reporting (unchanged from original)
// ---------------------------------------------------------------------------

export type UsageReport = {
  capturedAt: number;
  planType?: string;
  snapshots: UsageSnapshot[];
};

export type UsageSnapshot = {
  limitId: string;
  limitName?: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
  credits?: UsageCredits;
};

export type UsageWindow = {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
};

export type UsageCredits = {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
};

async function queryCodexUsage(
  credential: CodexCredential,
  timeoutMs: number,
): Promise<UsageReport> {
  const response = await fetchWithTimeout(
    CODEX_USAGE_URL,
    {
      headers: {
        Authorization: `Bearer ${credential.access}`,
        "User-Agent": "pi-codex-accounts",
      },
    },
    timeoutMs,
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `usage endpoint returned ${response.status} ${response.statusText}: ${redactErrorBody(text)}`,
    );
  }

  const payload = parseJsonObject(text, "Codex usage endpoint response");
  return normalizeUsagePayload(payload, Date.now());
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s while fetching Codex usage`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeUsagePayload(
  payload: Record<string, unknown>,
  capturedAt: number,
): UsageReport {
  const snapshots: UsageSnapshot[] = [];
  const planType = asString(payload.plan_type);

  const primary = normalizeUsageSnapshot(
    "codex",
    undefined,
    payload.rate_limit,
    payload.credits,
  );
  if (primary) snapshots.push(primary);

  const additional = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits
    : [];
  for (const item of additional) {
    const additionalLimit = assertObject(item, "additional rate limit");
    const limitId =
      asString(additionalLimit.metered_feature) ??
      asString(additionalLimit.limit_name);
    if (!limitId) continue;
    const snapshot = normalizeUsageSnapshot(
      limitId,
      asString(additionalLimit.limit_name),
      additionalLimit.rate_limit,
      undefined,
    );
    if (snapshot) snapshots.push(snapshot);
  }

  if (snapshots.length === 0) {
    throw new Error("usage endpoint returned no displayable rate-limit windows");
  }

  return { capturedAt, planType, snapshots };
}

function normalizeUsageSnapshot(
  limitId: string,
  limitName: string | undefined,
  rateLimit: unknown,
  credits: unknown,
): UsageSnapshot | undefined {
  const normalizedCredits = normalizeUsageCredits(credits);
  if (rateLimit === null || rateLimit === undefined) {
    return normalizedCredits
      ? { limitId, limitName, credits: normalizedCredits }
      : undefined;
  }

  const details = assertObject(rateLimit, "rate limit");
  const primary = normalizeUsageWindow(details.primary_window);
  const secondary = normalizeUsageWindow(details.secondary_window);
  if (!primary && !secondary && !normalizedCredits) return undefined;
  return {
    limitId,
    limitName,
    primary,
    secondary,
    credits: normalizedCredits,
  };
}

function normalizeUsageWindow(value: unknown): UsageWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = assertObject(value, "rate-limit window");
  const usedPercent = asNumber(window.used_percent);
  if (usedPercent === undefined) return undefined;
  const limitSeconds = asNumber(window.limit_window_seconds);
  const resetsAt = asNumber(window.reset_at);
  return {
    usedPercent,
    windowMinutes:
      limitSeconds && limitSeconds > 0
        ? Math.ceil(limitSeconds / 60)
        : undefined,
    resetsAt,
  };
}

function normalizeUsageCredits(value: unknown): UsageCredits | undefined {
  if (value === null || value === undefined) return undefined;
  const credits = assertObject(value, "credits");
  const hasCredits = asBoolean(credits.has_credits);
  const unlimited = asBoolean(credits.unlimited);
  if (hasCredits === undefined || unlimited === undefined) return undefined;
  return { hasCredits, unlimited, balance: asString(credits.balance) };
}

export function formatUsageReport(
  report: UsageReport,
  credential: CodexCredential,
): string {
  const lines = [
    `Codex usage — ${shortAccountId(credential)}`,
    report.planType ? `Plan: ${formatPlanType(report.planType)}` : undefined,
    `Captured: ${new Date(report.capturedAt).toLocaleString()}`,
    `Details: ${USAGE_SETTINGS_URL}`,
    "",
  ].filter((line): line is string => Boolean(line));

  for (const snapshot of report.snapshots) {
    const label = snapshot.limitName ?? snapshot.limitId;
    if (!isPrimaryUsageSnapshot(snapshot)) lines.push(`${label} limit:`);
    if (snapshot.primary)
      lines.push(formatUsageWindowLine("5h limit:", snapshot.primary));
    if (snapshot.secondary)
      lines.push(
        formatUsageWindowLine("Weekly limit:", snapshot.secondary),
      );
    if (!snapshot.primary && !snapshot.secondary)
      lines.push("Limits unavailable for this account");
    if (snapshot.credits)
      lines.push(`Credits: ${formatCredits(snapshot.credits)}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function isPrimaryUsageSnapshot(snapshot: UsageSnapshot): boolean {
  return (
    normalizedUsageKey(snapshot.limitId) === "codex" ||
    normalizedUsageKey(snapshot.limitName) === "codex"
  );
}

function formatUsageWindowLine(label: string, window: UsageWindow): string {
  return `${label.padEnd(LIMIT_VALUE_COLUMN)}${formatUsageWindow(window)}`;
}

function formatUsageWindow(window: UsageWindow): string {
  const remaining = 100 - clampPercent(window.usedPercent);
  const reset = window.resetsAt
    ? ` (resets ${formatReset(window.resetsAt)})`
    : "";
  return `${progressBar(remaining)} ${remaining.toFixed(0)}% left${reset}`;
}

function progressBar(percentRemaining: number): string {
  const filled = Math.round(
    (clampPercent(percentRemaining) / 100) * BAR_SEGMENTS,
  );
  return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}]`;
}

function formatCredits(credits: UsageCredits): string {
  if (!credits.hasCredits) return "no credits";
  if (credits.unlimited) return "unlimited credits";
  const balance = credits.balance?.trim();
  if (!balance) return "credits available";
  return `${formatNumber(Number(balance), balance)} credits`;
}

function formatReset(epochSeconds: number): string {
  const reset = new Date(epochSeconds * 1000);
  if (Number.isNaN(reset.getTime())) return "at an unknown time";
  const now = new Date();
  const time = `${reset.getHours().toString().padStart(2, "0")}:${reset
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
  if (reset.toDateString() === now.toDateString()) return time;
  const day = reset.getDate().toString();
  const month = reset.toLocaleDateString(undefined, { month: "short" });
  return `${time} on ${day} ${month}`;
}

function formatPlanType(planType: string): string {
  const key = planType
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  if (key === "pro_lite" || key === "prolite") return "Pro Lite";
  if (
    key === "team" ||
    key === "self_serve_business_usage_based" ||
    key === "business"
  )
    return "Business";
  if (key === "enterprise_cbp_usage_based") return "Enterprise";
  return planType
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizedUsageKey(value: string | undefined): string | undefined {
  const key = value
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || undefined;
}

function parseJsonObject(
  text: string,
  description: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${description} was not valid JSON: ${errorMessage(error)}`,
    );
  }
  return assertObject(parsed, description);
}

function assertObject(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} was not an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function formatNumber(value: number, fallback: string): string {
  if (!Number.isFinite(value)) return fallback;
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(value);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function redactErrorBody(body: string): string {
  return truncateEnd(
    body
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
      .replace(
        /"access_token"\s*:\s*"[^"]+"/gi,
        '"access_token":"<redacted>"',
      )
      .trim(),
    MAX_ERROR_BODY_CHARS,
  );
}

function truncateEnd(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export function tokenize(args: string): string[] {
  return args
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Label sanitization for filesystem safety
// ---------------------------------------------------------------------------

function sanitizeLabel(label: string): string {
  return label.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const clearUsageStatuslines = (
    ctx: ExtensionCommandContext | ExtensionContext,
  ) => {
    ctx.ui.setStatus("codex-accounts-usage", undefined);
  };

  /**
   * Registers an event that only one of the two hosts emits.
   *
   * OMP and legacy Pi expose different event unions: `model_select` is Pi-only
   * (OMP dropped it), `credential_disabled` is OMP-only. At runtime both hosts
   * implement `on` as a permissive `on(event: string, handler)` that files the
   * handler under a key the host may simply never emit — no error, no warning.
   * The typed overloads, however, each reject the other host's event name, so
   * the cast is confined here rather than spread across call sites.
   */
  const onHostEvent = (
    event: string,
    handler: (event: unknown, ctx: ExtensionContext) => void,
  ) => {
    (
      pi.on as unknown as (
        event: string,
        handler: (event: unknown, ctx: ExtensionContext) => void,
      ) => void
    )(event, handler);
  };

  /** Stable identity for "did the active model change?" comparisons. */
  const modelKey = (ctx: ExtensionContext): string | undefined => {
    const model = ctx.model as
      | { id?: unknown; provider?: unknown }
      | undefined;
    if (!model) return undefined;
    const provider = typeof model.provider === "string" ? model.provider : "";
    const id = typeof model.id === "string" ? model.id : "";
    return provider || id ? `${provider}/${id}` : undefined;
  };

  let lastModelKey: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    lastModelKey = modelKey(ctx);
    clearUsageStatuslines(ctx);
  });

  // A cached usage line describes the account the previous model ran on, so it
  // is stale the moment the model changes. Pi announces that with
  // `model_select`; OMP has no equivalent event, so detect the change at turn
  // start instead — an event both hosts do emit.
  pi.on("turn_start", (_event, ctx) => {
    const current = modelKey(ctx);
    if (current === lastModelKey) return;
    lastModelKey = current;
    clearUsageStatuslines(ctx);
  });

  // Pi-only: clears on selection instead of waiting for the next turn.
  onHostEvent("model_select", (_event, ctx) => clearUsageStatuslines(ctx));

  // OMP-only: a Codex credential the host just disabled (rate limit, refresh
  // failure) invalidates whatever usage we last displayed for it.
  onHostEvent("credential_disabled", (event, ctx) => {
    const provider = (event as { provider?: unknown } | null)?.provider;
    if (provider !== CODEX_PROVIDER_ID) return;
    clearUsageStatuslines(ctx);

    // A pin leaves exactly one Codex credential in play. If OMP has just
    // disabled that one, the pin would strand the session with no usable login
    // at all, so release it and let OMP rotate again rather than fail every
    // request. Deliberately silent about which account took over: the point is
    // that work continues.
    try {
      const storage = resolveActiveStorage();
      if (!storage.supportsPinning()) return;
      if (storage.pinHealthy()) return; // the pinned account still works
      const restored = storage.unpin();
      if (restored > 0) {
        ctx.ui.notify(
          `The pinned Codex account was disabled by OMP; released the pin and put ${restored} account(s) back in play.`,
          "warning",
        );
      }
    } catch {
      // Never let a credential event take down the session.
    }
  });

  pi.on("session_shutdown", (_event, ctx) => clearUsageStatuslines(ctx));

  const command = {
    description:
      "Switch between multiple OpenAI Codex logins and show usage (import/save/switch/unpin/usage/list/current/status/debug-db/rename/remove)",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        "list",
        "current",
        "save",
        "switch",
        "unpin",
        "import",
        "usage",
        "status",
        "debug-db",
        "rename",
        "remove",
      ];
      const tokens = prefix.split(/\s+/);
      if (tokens.length <= 1) {
        const items = subcommands
          .filter((s) => s.startsWith(tokens[0] ?? ""))
          .map((s) => ({ value: s, label: s }));
        return items.length > 0 ? items : null;
      }
      const sub = tokens[0];
      if (sub === "switch" || sub === "remove" || sub === "rename") {
        if (sub === "rename" && tokens.length > 2) return null;

        const storage = resolveActiveStorage();
        const labelPrefix = tokens[1] ?? "";
        const labels = storage.listLabels();
        const items = labels
          .filter((l) => l.startsWith(labelPrefix))
          .map((l) => ({ value: `${sub} ${l}`, label: l }));
        return items.length > 0 ? items : null;
      }
      return null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = tokenize(args);
      const sub = (tokens[0] ?? "").toLowerCase();

      switch (sub) {
        case "":
        {
          const storage = resolveActiveStorage();
          await doInteractive(ctx, storage);
          return;
        }
        case "list":
        case "ls":
        {
          const storage = resolveActiveStorage();
          doList(ctx, storage);
          return;
        }
        case "current":
        case "active":
        {
          const storage = resolveActiveStorage();
          doCurrent(ctx, storage);
          return;
        }
        case "save":
        {
          const storage = resolveActiveStorage();
          doSave(ctx, storage, tokens[1] ?? "");
          return;
        }
        case "switch":
        case "use":
        {
          const storage = resolveActiveStorage();
          await doSwitch(ctx, storage, tokens[1] ?? "");
          return;
        }
        case "unpin":
        case "release":
        {
          const storage = resolveActiveStorage();
          await doUnpin(ctx, storage);
          return;
        }
        case "import":
        case "adopt":
        {
          const storage = resolveActiveStorage();
          doImport(ctx, storage);
          return;
        }
        case "usage":
          await doUsage(ctx);
          return;
        case "status":
        {
          const storage = resolveActiveStorage();
          doStatus(ctx, storage);
          return;
        }
        case "debug-db":
        {
          const storage = resolveActiveStorage();
          doDebugDb(ctx, storage);
          return;
        }
        case "rename":
        case "mv":
        {
          const storage = resolveActiveStorage();
          doRename(ctx, storage, tokens[1] ?? "", tokens[2] ?? "");
          return;
        }
        case "remove":
        case "rm":
        case "delete":
        {
          const storage = resolveActiveStorage();
          doRemove(ctx, storage, tokens[1] ?? "");
          return;
        }
        default:
        {
          const storage = resolveActiveStorage();
          await doSwitch(ctx, storage, tokens[0]!);
          return;
        }
      }
    },
  };

  pi.registerCommand("codex", command);
  // Backward-compatible alias for users who installed earlier local builds.
  pi.registerCommand("codex-account", {
    ...command,
    description: "Alias for /codex",
  });
}
