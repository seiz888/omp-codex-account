import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OmpAgentDbStorage,
  labelFromCredential,
  uniqueLabel,
  type CodexCredential,
} from "../src/index";

let dir: string;
let dbPath: string;
let snapshotsDir: string;

/** Minimal stand-in for the `auth_credentials` table OMP creates. */
function seedDb(accounts: Array<{ email: string; accountId: string }>): void {
  const db = new Database(dbPath);
  db.run(`CREATE TABLE auth_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    credential_type TEXT NOT NULL,
    data TEXT NOT NULL,
    disabled_cause TEXT,
    identity_key TEXT,
    created_at INTEGER,
    updated_at INTEGER
  )`);
  for (const account of accounts) {
    db.run(
      "INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, ?, ?, ?)",
      [
        "openai-codex",
        "oauth",
        JSON.stringify({
          access: `ACCESS_${account.accountId}`,
          refresh: `REFRESH_${account.accountId}`,
          expires: 4_102_444_800_000,
          accountId: account.accountId,
          email: account.email,
        }),
        `email:${account.email}|org:${account.accountId}`,
      ],
    );
  }
  db.close();
}

function codexRows(): Array<Record<string, unknown>> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .query("SELECT identity_key FROM auth_credentials WHERE provider = ?")
    .all("openai-codex") as Array<Record<string, unknown>>;
  db.close();
  return rows;
}

const storage = () => new OmpAgentDbStorage(dbPath, snapshotsDir);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-codex-adoption-"));
  dbPath = join(dir, "agent.db");
  snapshotsDir = join(dir, "snapshots");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("label derivation", () => {
  test("prefers the email local part", () => {
    expect(
      labelFromCredential({
        type: "oauth",
        access: "a",
        refresh: "r",
        expires: 1,
        email: "work@example.com",
      } as CodexCredential),
    ).toBe("work");
  });

  test("falls back to the account id", () => {
    expect(
      labelFromCredential({
        type: "oauth",
        access: "a",
        refresh: "r",
        expires: 1,
        accountId: "abcdef0123456789",
      } as CodexCredential),
    ).toBe("account-abcdef01");
  });

  test("uniqueLabel suffixes collisions", () => {
    expect(uniqueLabel("work", new Set(["work", "work-2"]))).toBe("work-3");
  });
});

describe("adopting credentials OMP already holds", () => {
  test("credentials in agent.db are reported as unsaved", () => {
    seedDb([
      { email: "work@example.com", accountId: "acct-1" },
      { email: "personal@example.com", accountId: "acct-2" },
    ]);
    const s = storage();
    expect(s.listLabels()).toEqual([]);
    expect(s.listUnsaved().sort()).toEqual([
      "personal@example.com",
      "work@example.com",
    ]);
  });

  test("import adopts every one of them, labelled by email", () => {
    seedDb([
      { email: "work@example.com", accountId: "acct-1" },
      { email: "personal@example.com", accountId: "acct-2" },
    ]);
    const s = storage();
    const result = s.importExisting();

    expect(result.imported.sort()).toEqual(["personal", "work"]);
    expect(result.skipped).toEqual([]);
    expect(s.listLabels().sort()).toEqual(["personal", "work"]);
    expect(s.listUnsaved()).toEqual([]);
    expect(s.readAccount("work")?.credential.accountId).toBe("acct-1");
  });

  test("import is idempotent and never touches the credentials", () => {
    seedDb([{ email: "work@example.com", accountId: "acct-1" }]);
    const s = storage();
    s.importExisting();
    const rowsAfterFirst = codexRows();

    const again = s.importExisting();
    expect(again.imported).toEqual([]);
    expect(again.skipped).toEqual(["work"]);
    expect(codexRows()).toEqual(rowsAfterFirst);
  });
});

describe("switching never loses the outgoing credential", () => {
  test("an unlabelled active credential is adopted before being overwritten", () => {
    seedDb([{ email: "outgoing@example.com", accountId: "acct-out" }]);
    const s = storage();

    const incoming: CodexCredential = {
      type: "oauth",
      access: "ACCESS_IN",
      refresh: "REFRESH_IN",
      expires: 4_102_444_800_000,
      accountId: "acct-in",
      email: "incoming@example.com",
    };
    s.saveAccount("incoming", { credential: incoming, savedAt: Date.now() });

    // Nothing describes the outgoing credential yet: this is the state a user
    // is in after pasting logins into OMP without ever running /codex save.
    expect(s.detectActiveLabel(s.readActiveCredential())).toBeUndefined();

    s.switchTo(incoming, "incoming");

    const rescued = s.readAccount("outgoing");
    expect(rescued).toBeDefined();
    expect(rescued?.credential.accountId).toBe("acct-out");
    expect(rescued?.credential.refresh).toBe("REFRESH_acct-out");
  });
});

describe("detectActiveLabel", () => {
  test("does not name a remembered label that does not match", () => {
    seedDb([{ email: "active@example.com", accountId: "acct-active" }]);
    const s = storage();

    // saveAccount records this label as "active"; it describes a different
    // credential, so it must not be reported as the active one.
    s.saveAccount("unrelated", {
      credential: {
        type: "oauth",
        access: "a",
        refresh: "r",
        expires: 4_102_444_800_000,
        accountId: "acct-other",
        email: "other@example.com",
      },
      savedAt: Date.now(),
    });

    expect(s.detectActiveLabel(s.readActiveCredential())).toBeUndefined();
  });

  test("names the label that actually holds the active credential", () => {
    seedDb([{ email: "active@example.com", accountId: "acct-active" }]);
    const s = storage();
    s.importExisting();
    expect(s.detectActiveLabel(s.readActiveCredential())).toBe("active");
  });
});
