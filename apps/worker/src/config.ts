import { z } from "zod";

const schema = z.object({
  databasePath: z.string().default("./data/cocean.sqlite"),
  cacheRoot: z.string().default("./cache"),
  musicRoot: z.string().default("/library/music"),
  musicRootPolicy: z.enum(["WATCH_ONLY", "MANAGED"]).default("WATCH_ONLY"),
  quarantineRoot: z.string().default("/library/quarantine"),
  pollMs: z.coerce.number().int().min(250).max(60_000).default(1500),
  ffprobePath: z.string().default("ffprobe"),
  ffprobeTimeoutMs: z.coerce
    .number()
    .int()
    .min(1000)
    .max(300_000)
    .default(30_000),
  excludeDirectories: z.array(z.string()).max(128).default([]),
  logLevel: z.string().default("info"),
  once: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type WorkerConfig = z.infer<typeof schema>;

export function parseExcludedDirectories(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("COCEAN_SCAN_EXCLUDE_DIRS 必须是 JSON 字符串数组");
  }
  if (!Array.isArray(decoded) || decoded.length > 128)
    throw new Error("COCEAN_SCAN_EXCLUDE_DIRS 必须包含不超过 128 个目录");

  const normalized = decoded.map((item) => {
    if (typeof item !== "string")
      throw new Error("COCEAN_SCAN_EXCLUDE_DIRS 只能包含字符串");
    const directory = item.trim();
    const parts = directory.split("/");
    if (
      !directory ||
      directory.length > 500 ||
      directory.startsWith("/") ||
      directory.endsWith("/") ||
      directory.includes("\\") ||
      directory.includes("\0") ||
      parts.some((part) => !part || part === "." || part === "..")
    )
      throw new Error("COCEAN_SCAN_EXCLUDE_DIRS 只能包含安全的库内相对目录");
    return directory;
  });
  const unique = [...new Set(normalized)].sort((a, b) => a.localeCompare(b));
  if (unique.length !== normalized.length)
    throw new Error("COCEAN_SCAN_EXCLUDE_DIRS 不得包含重复目录");
  for (const directory of unique) {
    if (
      unique.some(
        (candidate) =>
          candidate !== directory && directory.startsWith(`${candidate}/`),
      )
    )
      throw new Error("COCEAN_SCAN_EXCLUDE_DIRS 不得包含相互嵌套的目录");
  }
  return unique;
}

export function loadWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  return schema.parse({
    databasePath: env.COCEAN_DATABASE_PATH,
    cacheRoot: env.COCEAN_CACHE_ROOT,
    musicRoot: env.COCEAN_MUSIC_ROOT,
    musicRootPolicy: env.COCEAN_MUSIC_ROOT_POLICY,
    quarantineRoot: env.COCEAN_QUARANTINE_ROOT,
    pollMs: env.COCEAN_WORKER_POLL_MS,
    ffprobePath: env.COCEAN_FFPROBE_PATH,
    ffprobeTimeoutMs: env.COCEAN_FFPROBE_TIMEOUT_MS,
    excludeDirectories: parseExcludedDirectories(env.COCEAN_SCAN_EXCLUDE_DIRS),
    logLevel: env.COCEAN_LOG_LEVEL,
    once: env.COCEAN_WORKER_ONCE,
  });
}
