import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthJsonStorage,
  OmpAgentDbStorage,
  resolveActiveStorage,
  type CodexCredential,
} from "../src/index";

const originalEnv = { ...process.env };
const tempRoots: string[] = [];

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-codex-account-"));
  tempRoots.push(dir);
  return dir;
}

function makeCredential(name: string): CodexCredential {
  return {
    type: "oauth",
    access: `access-${name}-abcdef123456`,
    refresh: `refresh-${name}-abcdef123456`,
    expires: Date.now() + 60_000,
    accountId: `acct-${name}`,
    email: `${name}@example.test`,
  };
}

function createOmpDb(path: string): void {
  const db = new Database(path);
  db.run(`CREATE TABLE auth_credentials (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    credential_type TEXT NOT NULL,
    data TEXT NOT NULL,
    disabled_cause TEXT,
    identity_key TEXT,
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
  )`);
  db.run(`CREATE TABLE auth_credential_blocks (
    credential_id INTEGER NOT NULL,
    provider_key TEXT NOT NULL,
    block_scope TEXT NOT NULL DEFAULT '',
    blocked_until_ms INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (credential_id, provider_key, block_scope)
  )`);
  db.close();
}

/** Credential ids this extension has parked, newest schema: a sentinel deadline. */
function blockedIds(path: string): number[] {
  const db = new Database(path);
  try {
    const rows = db
      .query(
        "SELECT credential_id FROM auth_credential_blocks WHERE provider_key = 'openai-codex:oauth' AND block_scope = '' AND blocked_until_ms = 4102444800000 ORDER BY credential_id",
      )
      .all() as Array<{ credential_id: number }>;
    return rows.map((row) => row.credential_id);
  } finally {
    db.close();
  }
}

function insertCredential(path: string, id: number, credential: CodexCredential): void {
  const db = new Database(path);
  (db.run as unknown as (query: string, ...params: unknown[]) => void)(
    `INSERT INTO auth_credentials (id, provider, credential_type, data, identity_key, updated_at)
     VALUES (?, 'openai-codex', 'oauth', ?, ?, ?)`,
    id,
    JSON.stringify(credential),
    `email:${credential.email}`,
    Math.floor(Date.now() / 1000) + id,
  );
  db.close();
}

function activeData(path: string): Record<string, unknown> {
  const db = new Database(path, { readonly: true });
  const row = db
    .query("SELECT data FROM auth_credentials WHERE provider = 'openai-codex' ORDER BY id DESC LIMIT 1")
    .get() as { data: string };
  db.close();
  return JSON.parse(row.data) as Record<string, unknown>;
}

describe("storage auto-detection", () => {
  test("falls back to legacy auth.json when no valid OMP database exists", () => {
    const root = tempRoot();
    process.env.OMP_AGENT_DB_PATH = join(root, "missing-agent.db");
    process.env.OMP_CODEX_ACCOUNTS_DIR = join(root, "omp-accounts");
    process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");

    const storage = resolveActiveStorage();

    expect(storage).toBeInstanceOf(AuthJsonStorage);
    expect(storage.debugInfo().kind).toBe("AuthJsonStorage");
  });

  test("selects OMP agent.db when it contains openai-codex credentials", () => {
    const root = tempRoot();
    const dbPath = join(root, "agent.db");
    createOmpDb(dbPath);
    insertCredential(dbPath, 1, makeCredential("main"));
    process.env.OMP_AGENT_DB_PATH = dbPath;
    process.env.OMP_CODEX_ACCOUNTS_DIR = join(root, "omp-accounts");
    process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");

    const storage = resolveActiveStorage();

    expect(storage).toBeInstanceOf(OmpAgentDbStorage);
    expect(storage.debugInfo()).toMatchObject({
      kind: "OmpAgentDbStorage",
      hasCodexRows: true,
      providerRowCount: 1,
    });
  });
});

describe("OMP SQLite storage", () => {
  test("switching pins the target row and destroys nothing", () => {
    const root = tempRoot();
    const dbPath = join(root, "agent.db");
    const accountsDir = join(root, "accounts");
    createOmpDb(dbPath);
    const main = makeCredential("main");
    const fallback = makeCredential("fallback");
    insertCredential(dbPath, 1, main);
    const storage = new OmpAgentDbStorage(dbPath, accountsDir);

    storage.saveAccount("main", { credential: storage.readActiveCredential()!, savedAt: Date.now() });
    insertCredential(dbPath, 2, fallback);
    storage.saveAccount("fallback", { credential: storage.readActiveCredential()!, savedAt: Date.now() });

    storage.switchTo(storage.readAccount("main")!.credential, "main");
    expect(storage.readActiveCredential()!.accountId).toBe(main.accountId);
    expect(storage.pinnedLabel()).toBe("main");

    // The point of pinning: the row that is not in use still holds its own
    // credential, untouched. Under the previous overwrite-in-place switch this
    // credential was gone.
    const rows = storage.listDbAccounts();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.credential.accountId === fallback.accountId)?.credential.refresh)
      .toBe(fallback.refresh);
    expect(rows.find((r) => r.credential.accountId === main.accountId)?.credential.refresh)
      .toBe(main.refresh);

    storage.switchTo(storage.readAccount("fallback")!.credential, "fallback");
    expect(storage.readActiveCredential()!.accountId).toBe(fallback.accountId);
    expect(storage.pinnedLabel()).toBe("fallback");
    expect(storage.listDbAccounts()).toHaveLength(2);

    const snapshot = JSON.parse(readFileSync(join(accountsDir, "main.json"), "utf-8"));
    expect(snapshot.row.data.refresh).toBe(main.refresh);
    expect(snapshot.row.data.email).toBe(main.email);
  });

  test("unpin restores every row the pin parked", () => {
    const root = tempRoot();
    const dbPath = join(root, "agent.db");
    createOmpDb(dbPath);
    const main = makeCredential("main");
    const fallback = makeCredential("fallback");
    insertCredential(dbPath, 1, main);
    insertCredential(dbPath, 2, fallback);
    const storage = new OmpAgentDbStorage(dbPath, join(root, "accounts"));
    storage.importExisting();

    storage.switchTo(storage.readAccount("main")!.credential, "main");
    expect(blockedIds(dbPath)).toEqual([2]);

    expect(storage.unpin()).toBe(1);
    expect(blockedIds(dbPath)).toEqual([]);
    expect(storage.pinnedLabel()).toBeUndefined();
    expect(storage.unpin()).toBe(0);
  });

  // The regression this guards: an earlier pin parked accounts by setting
  // `disabled_cause`, and OMP loads only rows where that column is NULL
  // (auth/sqlite-credential-store.ts). Every other account therefore vanished
  // from OMP's own account list the moment you switched.
  test("a pin never disables a row, so OMP still lists every account", () => {
    const root = tempRoot();
    const dbPath = join(root, "agent.db");
    createOmpDb(dbPath);
    insertCredential(dbPath, 1, makeCredential("main"));
    insertCredential(dbPath, 2, makeCredential("second"));
    insertCredential(dbPath, 3, makeCredential("third"));
    const storage = new OmpAgentDbStorage(dbPath, join(root, "accounts"));
    storage.importExisting();

    storage.switchTo(storage.readAccount("main")!.credential, "main");

    const visible = new Database(dbPath);
    const visibleToOmp = visible
      .query(
        "SELECT id FROM auth_credentials WHERE provider = 'openai-codex' AND disabled_cause IS NULL ORDER BY id",
      )
      .all() as Array<{ id: number }>;
    visible.close();
    expect(visibleToOmp.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(blockedIds(dbPath)).toEqual([2, 3]);
  });

  test("unpin leaves a rate-limit block OMP wrote alone", () => {
    const root = tempRoot();
    const dbPath = join(root, "agent.db");
    createOmpDb(dbPath);
    insertCredential(dbPath, 1, makeCredential("main"));
    insertCredential(dbPath, 2, makeCredential("second"));
    const storage = new OmpAgentDbStorage(dbPath, join(root, "accounts"));
    storage.importExisting();
    storage.switchTo(storage.readAccount("main")!.credential, "main");

    // OMP backs off the pinned account for its own reasons.
    const db = new Database(dbPath);
    db.run(
      "INSERT OR REPLACE INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (1, 'openai-codex:oauth', '', 111, 111)",
    );
    db.close();

    expect(storage.unpin()).toBe(1);
    const after = new Database(dbPath);
    const left = after
      .query("SELECT credential_id, blocked_until_ms FROM auth_credential_blocks")
      .all() as Array<{ credential_id: number; blocked_until_ms: number }>;
    after.close();
    expect(left).toEqual([{ credential_id: 1, blocked_until_ms: 111 }]);
  });

  test("a pin never re-enables a row OMP disabled for its own reason", () => {
    const root = tempRoot();
    const dbPath = join(root, "agent.db");
    createOmpDb(dbPath);
    const main = makeCredential("main");
    const broken = makeCredential("broken");
    insertCredential(dbPath, 1, main);
    insertCredential(dbPath, 2, broken);

    const db = new Database(dbPath);
    db.run("UPDATE auth_credentials SET disabled_cause = ? WHERE id = 2", ["refresh failed"]);
    db.close();

    const storage = new OmpAgentDbStorage(dbPath, join(root, "accounts"));
    storage.importExisting();
    storage.switchTo(storage.readAccount("main")!.credential, "main");
    storage.unpin();

    const stillDisabled = storage
      .listDbAccounts()
      .find((r) => r.credential.accountId === broken.accountId);
    expect(stillDisabled?.disabledCause).toBe("refresh failed");
  });

  test("pinning a credential OMP disabled is refused", () => {
    const root = tempRoot();
    const dbPath = join(root, "agent.db");
    createOmpDb(dbPath);
    const only = makeCredential("only");
    insertCredential(dbPath, 1, only);

    const db = new Database(dbPath);
    db.run("UPDATE auth_credentials SET disabled_cause = ? WHERE id = 1", ["refresh failed"]);
    db.close();

    const storage = new OmpAgentDbStorage(dbPath, join(root, "accounts"));
    expect(() => storage.pinAccount(only.accountId!)).toThrow(/disabled/);
  });
});

describe("legacy auth.json storage", () => {
  test("save and switch still use ~/.pi/agent/auth.json semantics", () => {
    const root = tempRoot();
    const agentDir = join(root, "pi-agent");
    mkdirSync(agentDir, { recursive: true });
    const main = makeCredential("main");
    const fallback = makeCredential("fallback");
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": main }));
    const storage = new AuthJsonStorage(agentDir);

    storage.saveAccount("main", { credential: storage.readActiveCredential()!, savedAt: Date.now() });
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": fallback }));
    storage.saveAccount("fallback", { credential: storage.readActiveCredential()!, savedAt: Date.now() });

    storage.switchTo(storage.readAccount("main")!.credential, "main");
    let auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
    expect(auth["openai-codex"].refresh).toBe(main.refresh);
    expect(auth["openai-codex"].expires).toBe(0);

    storage.switchTo(storage.readAccount("fallback")!.credential, "fallback");
    auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
    expect(auth["openai-codex"].refresh).toBe(fallback.refresh);
    expect(auth["openai-codex"].expires).toBe(0);
  });
});
