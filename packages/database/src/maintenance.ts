import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { migrations } from "./migrations.js";

const backupSchema = "cocean.database-backup/v1";

export interface DatabaseBackupReceipt {
  schema: typeof backupSchema;
  releaseVersion: string;
  createdAt: string;
  schemaVersion: number;
  migrationCount: number;
  sizeBytes: number;
  sha256: string;
}

export async function createVerifiedDatabaseBackup(
  sourcePath: string,
  backupPath: string,
  metadataPath: string,
  releaseVersion: string,
): Promise<DatabaseBackupReceipt> {
  assertSeparateFiles(sourcePath, backupPath, metadataPath);
  await assertRegularNonSymlink(sourcePath, "source database");
  await assertAbsent(backupPath, "backup database");
  await assertAbsent(metadataPath, "backup metadata");
  await ensureBackupDirectory(dirname(backupPath));

  const suffix = `${process.pid}-${randomUUID()}`;
  const temporaryBackup = `${backupPath}.tmp-${suffix}`;
  const temporaryMetadata = `${metadataPath}.tmp-${suffix}`;
  let source: BetterSqlite3.Database | undefined;
  try {
    source = new BetterSqlite3(sourcePath, {
      readonly: true,
      fileMustExist: true,
    });
    source.pragma("query_only = ON");
    const sourceFacts = inspectOpenDatabase(source);
    await source.backup(temporaryBackup);
    await chmod(temporaryBackup, 0o600);

    const backupFacts = inspectDatabaseFile(temporaryBackup);
    if (
      backupFacts.schemaVersion !== sourceFacts.schemaVersion ||
      backupFacts.migrationCount !== sourceFacts.migrationCount
    ) {
      throw new Error(
        "database backup schema does not match its source snapshot",
      );
    }

    const stats = await lstat(temporaryBackup);
    const receipt: DatabaseBackupReceipt = {
      schema: backupSchema,
      releaseVersion,
      createdAt: new Date().toISOString(),
      schemaVersion: backupFacts.schemaVersion,
      migrationCount: backupFacts.migrationCount,
      sizeBytes: stats.size,
      sha256: await sha256File(temporaryBackup),
    };
    await writeFile(
      temporaryMetadata,
      `${JSON.stringify(receipt, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );

    await link(temporaryBackup, backupPath);
    try {
      await link(temporaryMetadata, metadataPath);
    } catch (error) {
      await unlink(backupPath).catch(() => undefined);
      throw error;
    }
    await chmod(backupPath, 0o600);
    await chmod(metadataPath, 0o600);
    return receipt;
  } finally {
    source?.close();
    await unlink(temporaryBackup).catch(() => undefined);
    await unlink(temporaryMetadata).catch(() => undefined);
  }
}

export async function verifyDatabaseBackup(
  backupPath: string,
  metadataPath: string,
): Promise<DatabaseBackupReceipt> {
  await assertRegularNonSymlink(backupPath, "backup database");
  await assertRegularNonSymlink(metadataPath, "backup metadata");
  const parsed = JSON.parse(
    await readFile(metadataPath, "utf8"),
  ) as Partial<DatabaseBackupReceipt>;
  if (
    parsed.schema !== backupSchema ||
    typeof parsed.releaseVersion !== "string" ||
    typeof parsed.createdAt !== "string" ||
    !Number.isInteger(parsed.schemaVersion) ||
    !Number.isInteger(parsed.migrationCount) ||
    !Number.isInteger(parsed.sizeBytes) ||
    typeof parsed.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.sha256)
  ) {
    throw new Error("database backup metadata is invalid");
  }
  const receipt = parsed as DatabaseBackupReceipt;
  const stats = await lstat(backupPath);
  if (stats.size !== receipt.sizeBytes)
    throw new Error("database backup size does not match metadata");
  if ((await sha256File(backupPath)) !== receipt.sha256)
    throw new Error("database backup checksum does not match metadata");
  const facts = inspectDatabaseFile(backupPath);
  if (
    facts.schemaVersion !== receipt.schemaVersion ||
    facts.migrationCount !== receipt.migrationCount
  ) {
    throw new Error("database backup schema does not match metadata");
  }
  return receipt;
}

function inspectDatabaseFile(path: string): {
  schemaVersion: number;
  migrationCount: number;
} {
  const database = new BetterSqlite3(path, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    database.pragma("query_only = ON");
    return inspectOpenDatabase(database);
  } finally {
    database.close();
  }
}

function inspectOpenDatabase(database: BetterSqlite3.Database): {
  schemaVersion: number;
  migrationCount: number;
} {
  const integrity = database.pragma("integrity_check") as Array<
    Record<string, unknown>
  >;
  if (
    integrity.length !== 1 ||
    String(Object.values(integrity[0] ?? {})[0] ?? "").toLowerCase() !== "ok"
  ) {
    throw new Error("database integrity_check failed");
  }
  const foreignKeys = database.pragma("foreign_key_check") as Array<
    Record<string, unknown>
  >;
  if (foreignKeys.length > 0)
    throw new Error("database foreign_key_check failed");
  const table = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (!table) throw new Error("database schema_migrations table is absent");
  const rows = database
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number; name: string }>;
  const known = new Map<number, string>(
    migrations.map((migration) => [migration.version, migration.name]),
  );
  for (const row of rows) {
    if (!known.has(Number(row.version)))
      throw new Error("database schema is newer than this maintenance image");
    if (known.get(Number(row.version)) !== row.name)
      throw new Error("database migration identity is unsupported");
  }
  const row = database
    .prepare(
      "SELECT COALESCE(MAX(version), 0) AS schemaVersion, COUNT(*) AS migrationCount FROM schema_migrations",
    )
    .get() as { schemaVersion: number; migrationCount: number };
  return {
    schemaVersion: Number(row.schemaVersion),
    migrationCount: Number(row.migrationCount),
  };
}

async function ensureBackupDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error("database backup directory must be a real directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: false, mode: 0o700 });
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error("database backup directory could not be secured");
  }
}

function assertSeparateFiles(...paths: string[]): void {
  if (new Set(paths.map((path) => resolve(path))).size !== paths.length)
    throw new Error("source, backup and metadata paths must be distinct");
}

async function assertRegularNonSymlink(
  path: string,
  label: string,
): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink())
    throw new Error(`${label} must be a regular non-symlink file`);
}

async function assertAbsent(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists`);
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });
}
