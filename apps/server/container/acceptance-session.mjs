import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";

const dataRoot =
  process.env.NODE_ENV === "test" &&
  process.env.COCEAN_ACCEPTANCE_SESSION_TEST_ROOT
    ? resolve(process.env.COCEAN_ACCEPTANCE_SESSION_TEST_ROOT)
    : "/var/lib/cocean";
const databasePath = resolve(dataRoot, "cocean.sqlite");
const cookiePath = resolve(dataRoot, "acceptance/admin-session-cookie");
const acceptanceSessionId = "cocean-acceptance-admin-session-v1";
const command = process.argv[2];

if (!new Set(["issue", "revoke"]).has(command)) {
  console.error("usage: acceptance-session.mjs <issue|revoke>");
  process.exit(64);
}

const database = new BetterSqlite3(databasePath);
try {
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  if (command === "issue") await issue();
  else await revoke();
} finally {
  database.close();
}

async function issue() {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();
  database
    .transaction(() => {
      database
        .prepare("DELETE FROM app_sessions WHERE id=? AND expires_at<=?")
        .run(acceptanceSessionId, now.toISOString());
      if (
        database
          .prepare("SELECT 1 FROM app_sessions WHERE id=?")
          .get(acceptanceSessionId)
      )
        throw new Error("an acceptance session is already active");
      const admin = database
        .prepare(
          `SELECT id FROM app_users
           WHERE role='ADMIN' AND enabled=1 ORDER BY id LIMIT 1`,
        )
        .get();
      if (!admin)
        throw new Error("no enabled ADMIN is available for acceptance");
      database
        .prepare(
          `INSERT INTO app_sessions
           (id,user_id,token_hash,expires_at,created_at,last_seen_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(
          acceptanceSessionId,
          String(admin.id),
          tokenHash,
          expiresAt,
          now.toISOString(),
          now.toISOString(),
        );
    })
    .immediate();
  await mkdir(dirname(cookiePath), { recursive: true });
  const temporaryPath = `${cookiePath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, `cocean_session=${token}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, cookiePath);
  } catch (error) {
    database
      .prepare("DELETE FROM app_sessions WHERE id=? AND token_hash=?")
      .run(acceptanceSessionId, tokenHash);
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function revoke() {
  database
    .transaction(() => {
      database
        .prepare("DELETE FROM app_sessions WHERE id=?")
        .run(acceptanceSessionId);
    })
    .immediate();
  await rm(cookiePath, { force: true });
}
