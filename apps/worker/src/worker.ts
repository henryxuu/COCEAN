import pino from "pino";
import { CoceanDatabase } from "@cocean/database";
import { loadWorkerConfig } from "./config.js";
import { shouldRecoverInterruptedJobs } from "./lease.js";
import { processNextJob, SCAN_RULES_VERSION } from "./runner.js";

const config = loadWorkerConfig();
const logger = pino({ level: config.logLevel });
const database = new CoceanDatabase(config.databasePath, {
  musicRoot: config.musicRoot,
});
const controller = new AbortController();
const previousHeartbeat = database.getWorkerHeartbeat("scanner");
if (!shouldRecoverInterruptedJobs(previousHeartbeat)) {
  database.close();
  throw new Error(
    "A scanner worker lease is still active; refusing to run a second scanner",
  );
} else {
  const recovered = database.recoverRunningScanJobs(
    "扫描 Worker 租约已失效；上一版曲库快照已保留，可重新创建扫描任务",
    SCAN_RULES_VERSION,
  );
  if (recovered.length)
    logger.warn(
      { recoveredJobs: recovered.map((report) => report.scanJobId) },
      "recovered interrupted scan jobs",
    );
}
const heartbeat = () =>
  database.touchWorkerHeartbeat(
    "scanner",
    process.pid,
    controller.signal.aborted ? "stopping" : "ready",
  );
heartbeat();
const heartbeatTimer = setInterval(heartbeat, 10_000);
heartbeatTimer.unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort(signal));
}

try {
  do {
    const processed = await processNextJob(
      database,
      config,
      logger,
      controller.signal,
    );
    if (config.once || controller.signal.aborted) break;
    if (!processed) await wait(config.pollMs, controller.signal);
  } while (!controller.signal.aborted);
} finally {
  clearInterval(heartbeatTimer);
  database.touchWorkerHeartbeat("scanner", process.pid, "stopped");
  database.close();
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
