import { z } from "zod";

const booleanFromEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const booleanDefaultTrueFromEnv = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const configSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().min(1).max(65_535).default(8787),
  databasePath: z.string().default("./data/cocean.sqlite"),
  musicRoot: z.string().default("/library/music"),
  musicRootPolicy: z.enum(["WATCH_ONLY", "MANAGED"]).default("WATCH_ONLY"),
  quarantineRoot: z.string().default("/library/quarantine"),
  cacheRoot: z.string().default("./cache"),
  webRoot: z.string().nullable().default(null),
  musicBrainzEnabled: booleanFromEnv,
  metadataContact: z.string().trim().min(1).nullable().default(null),
  musicBrainzBaseUrl: z.string().url().default("https://musicbrainz.org/ws/2/"),
  stillCatalogPath: z.string().default("./data/still-catalog.json"),
  authBootstrapFile: z.string().nullable().default(null),
  sessionTtlHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .default(720),
  cookieSecure: booleanFromEnv,
  credentialKeyPath: z.string().default("./data/credential.key"),
  ffmpegPath: z.string().default("ffmpeg"),
  ffprobePath: z.string().default("ffprobe"),
  appleLookupEnabled: booleanDefaultTrueFromEnv,
  appleLookupBaseUrl: z.string().url().default("https://itunes.apple.com/"),
  externalLookupTimeoutMs: z.coerce
    .number()
    .int()
    .min(1000)
    .max(30000)
    .default(8000),
  demoData: booleanFromEnv,
  logLevel: z.string().default("info"),
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
});

export type ServerConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return configSchema.parse({
    host: env.COCEAN_HOST,
    port: env.COCEAN_PORT,
    databasePath: env.COCEAN_DATABASE_PATH,
    musicRoot: env.COCEAN_MUSIC_ROOT,
    musicRootPolicy: env.COCEAN_MUSIC_ROOT_POLICY,
    quarantineRoot: env.COCEAN_QUARANTINE_ROOT,
    cacheRoot: env.COCEAN_CACHE_ROOT,
    webRoot: env.COCEAN_WEB_ROOT ?? null,
    musicBrainzEnabled: env.COCEAN_MUSICBRAINZ_ENABLED,
    metadataContact: env.COCEAN_METADATA_CONTACT?.trim() || null,
    musicBrainzBaseUrl: env.COCEAN_MUSICBRAINZ_BASE_URL,
    stillCatalogPath: env.COCEAN_STILL_CATALOG_PATH,
    authBootstrapFile: env.COCEAN_AUTH_BOOTSTRAP_FILE ?? null,
    sessionTtlHours: env.COCEAN_SESSION_TTL_HOURS,
    cookieSecure: env.COCEAN_COOKIE_SECURE,
    credentialKeyPath: env.COCEAN_CREDENTIAL_KEY_PATH,
    ffmpegPath: env.COCEAN_FFMPEG_PATH,
    ffprobePath: env.COCEAN_FFPROBE_PATH,
    appleLookupEnabled: env.COCEAN_APPLE_LOOKUP_ENABLED,
    appleLookupBaseUrl: env.COCEAN_APPLE_LOOKUP_BASE_URL,
    externalLookupTimeoutMs: env.COCEAN_EXTERNAL_LOOKUP_TIMEOUT_MS,
    demoData: env.COCEAN_DEMO_DATA,
    logLevel: env.COCEAN_LOG_LEVEL,
    nodeEnv: env.NODE_ENV,
  });
}
