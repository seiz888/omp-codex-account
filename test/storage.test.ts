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
  test("save then switch restores snapshots through the active database row", () => {
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
    expect(activeData(dbPath).refresh).toBe(main.refresh);

    storage.switchTo(storage.readAccount("fallback")!.credential, "fallback");
    expect(storage.readActiveCredential()!.accountId).toBe(fallback.accountId);
    expect(activeData(dbPath).refresh).toBe(fallback.refresh);

    const snapshot = JSON.parse(readFileSync(join(accountsDir, "main.json"), "utf-8"));
    expect(snapshot.row.data.refresh).toBe(main.refresh);
    expect(snapshot.row.data.email).toBe(main.email);
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
