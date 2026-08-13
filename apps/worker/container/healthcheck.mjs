import BetterSqlite3 from "better-sqlite3";

let database;
try {
  database = new BetterSqlite3(
    process.env.COCEAN_DATABASE_PATH ?? "/var/lib/cocean/cocean.sqlite",
    { readonly: true, fileMustExist: true },
  );
  database.pragma("query_only = ON");
  const heartbeat = database
    .prepare(
      "SELECT state, last_seen_at AS lastSeenAt FROM worker_heartbeats WHERE role = ?",
    )
    .get("scanner");
  const age = heartbeat
    ? Date.now() - Date.parse(heartbeat.lastSeenAt)
    : Number.POSITIVE_INFINITY;
  if (
    !heartbeat ||
    heartbeat.state === "stopped" ||
    !Number.isFinite(age) ||
    age > 45_000
  )
    process.exitCode = 1;
  database.prepare("SELECT 1").get();
} catch {
  process.exitCode = 1;
} finally {
  database?.close();
}
