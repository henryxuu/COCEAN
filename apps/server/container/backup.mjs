import { dirname, join, resolve } from "node:path";
import {
  createVerifiedDatabaseBackup,
  verifyDatabaseBackup,
} from "@cocean/database";

const command = process.argv[2];
const backupID = process.argv[3];
if (!new Set(["create", "verify"]).has(command) || !backupID) {
  console.error("usage: node backup.mjs <create|verify> BACKUP_ID");
  process.exit(64);
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(backupID)) {
  console.error("backup ID contains unsupported characters");
  process.exit(64);
}

const databasePath = resolve(
  process.env.COCEAN_DATABASE_PATH ?? "/var/lib/cocean/cocean.sqlite",
);
const dataRoot = dirname(databasePath);
const backupRoot = join(dataRoot, "backups");
const backupPath = join(backupRoot, `${backupID}.sqlite`);
const metadataPath = join(backupRoot, `${backupID}.json`);
const releaseVersion = process.env.COCEAN_VERSION ?? "unknown";

try {
  const receipt =
    command === "create"
      ? await createVerifiedDatabaseBackup(
          databasePath,
          backupPath,
          metadataPath,
          releaseVersion,
        )
      : await verifyDatabaseBackup(backupPath, metadataPath);
  console.log(
    JSON.stringify({
      status: "ok",
      backupID,
      schemaVersion: receipt.schemaVersion,
      sizeBytes: receipt.sizeBytes,
      sha256: receipt.sha256,
    }),
  );
} catch (error) {
  console.error(
    `database backup ${command} failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exit(1);
}
