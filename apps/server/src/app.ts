import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { selectCatalogRecommendations } from "@cocean/catalog-recommendation";
import {
  MusicBrainzClient,
  type ReleaseSearchInput,
} from "@cocean/catalog-sources";
import {
  catalogRecommendationResponseSchema,
  artworkDecisionCommandSchema,
  confirmReleaseCandidateCommandSchema,
  coceanSettingsSchema,
  deviceCategorySchema,
  deviceOwnershipSchema,
  libraryIdentityDecisionCommandSchema,
  importMusicBrainzArtworkCommandSchema,
  physicalMediumSchema,
  scanFileOutcomeSchema,
  scanModeSchema,
  undoAlbumMetadataCommandSchema,
  undoAlbumArtworkCommandSchema,
  undoLibraryIdentityDecisionCommandSchema,
  updateAlbumMetadataCommandSchema,
  type ReleaseCandidate,
} from "@cocean/contracts";
import {
  AlbumMetadataDecisionError,
  AlbumArtworkDecisionError,
  CoceanDatabase,
  LibraryIdentityDecisionError,
} from "@cocean/database";
import { parseRuntimeStillCatalog } from "@cocean/still-catalog";
import { z } from "zod";
import type { ServerConfig } from "./config.js";
import {
  assertPassword,
  assertUsername,
  bootstrapOwner,
  createSession,
  deleteSession,
  expiredSessionCookie,
  hashPassword,
  readSession,
  sessionCookie,
  verifyPassword,
} from "./auth.js";
import { AppleCatalogClient, externalMediaFallback } from "./apple-catalog.js";
import {
  ArtworkValidationError,
  fetchCoverArtArchiveFront,
  validateAndStoreArtwork,
} from "./artwork.js";
import { CredentialVault } from "./credential-vault.js";
import { DeliveryRunner } from "./delivery.js";

const albumQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  filter: z
    .enum([
      "ALL",
      "DIGITAL",
      "CD",
      "SACD",
      "VINYL",
      "CASSETTE",
      "BLURAY_AUDIO",
      "OTHER",
    ])
    .default("ALL"),
  sort: z.enum(["ARTIST", "TITLE", "YEAR_DESC"]).default("ARTIST"),
  issue: z
    .enum([
      "ALL",
      "IDENTITY_OVERLAP",
      "INCOMPLETE_TRACKS",
      "MISSING_ARTWORK",
      "LOW_RES_ARTWORK",
      "MIXED_AUDIO_SPECS",
      "BROKEN_TEXT",
      "MISSING_IDENTITY",
    ])
    .default("ALL"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const physicalAlbumInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  albumArtist: z.string().trim().min(1).max(300),
  year: z.number().int().min(1877).max(2200).nullable().optional(),
  medium: physicalMediumSchema,
});

const scanRequestSchema = z.object({
  rootId: z.string().min(1).default("music"),
  mode: scanModeSchema.default("INCREMENTAL"),
});
const matchSearchSchema = z.object({
  limit: z.number().int().min(1).max(25).default(8),
  localVersionId: z.string().min(1).optional(),
});
const matchCandidatesQuerySchema = z.object({
  localVersionId: z.string().min(1).optional(),
});
const todayRecommendationQuerySchema = z.object({
  dayKey: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
const discoverRecommendationInputSchema = z.object({
  query: z.string().trim().max(500).default(""),
  limit: z.number().int().min(1).max(24).default(12),
  dayKey: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
const physicalCopyInputSchema = z.object({
  medium: physicalMediumSchema,
  label: z.string().trim().max(200).nullable().optional(),
  catalogNumber: z.string().trim().max(100).nullable().optional(),
  barcode: z.string().trim().max(100).nullable().optional(),
  country: z.string().trim().max(100).nullable().optional(),
  releaseYear: z.number().int().min(1877).max(2200).nullable().optional(),
  quantity: z.number().int().min(1).max(999).default(1),
  conditionNote: z.string().trim().max(500).nullable().optional(),
  storageLocation: z.string().trim().max(300).nullable().optional(),
});
const ownedDeviceInputSchema = z.object({
  manufacturer: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(160),
  category: deviceCategorySchema,
  ownership: deviceOwnershipSchema,
  nickname: z.string().trim().max(120).nullable().optional(),
  serialNumber: z.string().trim().max(160).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
const deliveryTargetInputSchema = z
  .object({
    deviceId: z.string().nullable().optional(),
    name: z.string().trim().min(1).max(160),
    kind: z.enum(["MOUNTED_VOLUME", "NETWORK"]),
    transport: z.enum([
      "USB_MOUNT",
      "SMB",
      "SFTP",
      "FTP",
      "AK_FILE_DROP",
      "OTHER",
    ]),
    location: z.string().trim().min(1).max(500),
    username: z.string().trim().max(128).nullable().optional(),
    password: z.string().max(256).nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((input, context) => {
    if (
      input.kind === "MOUNTED_VOLUME" &&
      (!input.location.startsWith("/") ||
        input.location === "/" ||
        (input.location !== "/delivery/usb" &&
          !input.location.startsWith("/delivery/usb/")))
    ) {
      context.addIssue({
        code: "custom",
        path: ["location"],
        message: "U 盘目标必须位于 /delivery/usb 挂载边界内",
      });
    }
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*:[^/@]+@/i.test(input.location)) {
      context.addIssue({
        code: "custom",
        path: ["location"],
        message: "目标地址不得包含明文密码",
      });
    }
    if (
      ["FTP", "AK_FILE_DROP"].includes(input.transport) &&
      !input.location.startsWith("ftp://")
    ) {
      context.addIssue({
        code: "custom",
        path: ["location"],
        message: "AK File Drop / FTP 目标必须使用 ftp:// 地址",
      });
    }
  });

const loginInputSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});
const createUserInputSchema = z.object({
  username: z.string().trim().min(1).max(64),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(10).max(256),
  role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
});
const updateUserInputSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  password: z.string().min(10).max(256).optional(),
  role: z.enum(["ADMIN", "MEMBER"]).optional(),
  enabled: z.boolean().optional(),
});
const modelConfigurationInputSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().url(),
  model: z.string().trim().max(200),
  apiKey: z.string().max(500).optional(),
  clearApiKey: z.boolean().default(false),
});

export interface AppOptions {
  config: ServerConfig;
  database?: CoceanDatabase;
  modelFetch?: (input: URL, init: RequestInit) => Promise<Response>;
  releaseCatalogClient?: {
    searchReleases(input: ReleaseSearchInput): Promise<ReleaseCandidate[]>;
  };
  deliveryExecution?: boolean;
  artworkFetch?: typeof globalThis.fetch;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const database =
    options.database ??
    new CoceanDatabase(options.config.databasePath, {
      musicRoot: options.config.musicRoot,
    });
  await bootstrapOwner(
    database,
    options.config.authBootstrapFile,
    options.config.nodeEnv === "production",
  );
  const vault = await CredentialVault.load(options.config.credentialKeyPath);
  const modelFetch =
    options.modelFetch ??
    ((input: URL, init: RequestInit) => fetch(input, init));
  const deliveryRunner = new DeliveryRunner(
    database,
    vault,
    "/delivery/usb",
    options.config.cacheRoot,
    options.config.ffmpegPath,
    options.config.ffprobePath,
  );
  if (options.deliveryExecution !== false) deliveryRunner.start();
  const appleCatalogClient = options.config.appleLookupEnabled
    ? new AppleCatalogClient(
        options.config.appleLookupBaseUrl,
        options.config.externalLookupTimeoutMs,
      )
    : null;
  const releaseCatalogClient =
    options.releaseCatalogClient ??
    (options.config.musicBrainzEnabled && options.config.metadataContact
      ? new MusicBrainzClient({
          contact: options.config.metadataContact,
          baseUrl: options.config.musicBrainzBaseUrl,
        })
      : null);
  let catalogLoadError: string | null = null;
  const loadStillCatalog = async (): Promise<boolean> => {
    try {
      const source = JSON.parse(
        await readFile(options.config.stillCatalogPath, "utf8"),
      );
      database.installStillCatalog(parseRuntimeStillCatalog(source));
      catalogLoadError = null;
      return true;
    } catch (error) {
      if (isMissingFileError(error)) {
        catalogLoadError = null;
        return false;
      }
      catalogLoadError = error instanceof Error ? error.message : String(error);
      return false;
    }
  };
  await loadStillCatalog();
  const app = Fastify({
    logger:
      options.config.nodeEnv === "test"
        ? false
        : { level: options.config.logLevel },
  });

  app.decorate("coceanDatabase", database);
  app.addHook("onClose", async () => {
    if (!options.database) database.close();
  });
  app.setErrorHandler(async (error, request, reply) => {
    const multipartErrorCode =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : null;
    if (multipartErrorCode === "FST_REQ_FILE_TOO_LARGE")
      return reply.code(413).send({
        error: "ARTWORK_TOO_LARGE",
        message: "封面文件不能超过 20 MiB",
      });
    if (
      multipartErrorCode &&
      ["FST_FILES_LIMIT", "FST_FIELDS_LIMIT"].includes(multipartErrorCode)
    )
      return reply.code(400).send({
        error: "INVALID_ARTWORK_FILE",
        message: "封面上传字段或文件数量超出限制",
      });
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        message: "请求参数不符合 COCEAN API 合同",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    request.log.error({ err: error }, "COCEAN request failed");
    const candidateStatus =
      typeof error === "object" && error !== null && "statusCode" in error
        ? (error as { statusCode?: unknown }).statusCode
        : null;
    const statusCode =
      typeof candidateStatus === "number" && candidateStatus >= 400
        ? candidateStatus
        : 500;
    const message = error instanceof Error ? error.message : "请求失败";
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED",
      message: statusCode >= 500 ? "COCEAN 服务处理请求时发生错误" : message,
    });
  });

  if (options.config.nodeEnv !== "production") {
    await app.register(cors, { origin: true });
  }
  await app.register(multipart, {
    limits: { files: 1, fields: 4, fileSize: 20 * 1024 * 1024 },
  });

  const health = async () => ({
    status: "ok",
    service: "cocean-server",
    version: "0.1.0",
  });
  app.get("/api/health", health);
  app.get("/api/v1/health", health);

  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  app.post("/api/v1/auth/login", async (request, reply) => {
    const input = loginInputSchema.parse(request.body ?? {});
    const key = String(request.headers["x-forwarded-for"] ?? request.ip)
      .split(",", 1)[0]!
      .trim();
    const current = loginAttempts.get(key);
    if (current && current.resetAt > Date.now() && current.count >= 8) {
      return reply.code(429).send({
        error: "LOGIN_RATE_LIMITED",
        message: "登录尝试过多，请稍后再试",
      });
    }
    const user = database.getUserByUsername(input.username);
    const accepted = Boolean(
      user?.enabled &&
      (await verifyPassword(input.password, user?.passwordHash ?? "invalid")),
    );
    if (!accepted || !user) {
      loginAttempts.set(key, {
        count: current && current.resetAt > Date.now() ? current.count + 1 : 1,
        resetAt: Date.now() + 15 * 60_000,
      });
      return reply.code(401).send({
        error: "INVALID_CREDENTIALS",
        message: "账号或密码不正确",
      });
    }
    loginAttempts.delete(key);
    database.touchUserLogin(user.id);
    const refreshed = database.getUser(user.id)!;
    const { session, token } = createSession(
      database,
      refreshed,
      options.config.sessionTtlHours,
    );
    return reply
      .header(
        "set-cookie",
        sessionCookie(token, session.expiresAt, options.config.cookieSecure),
      )
      .header("cache-control", "no-store")
      .send(session);
  });

  app.get("/api/v1/auth/session", async (request, reply) => {
    const session = readSession(database, request.headers.cookie);
    if (!session)
      return reply.code(401).send({
        error: "AUTHENTICATION_REQUIRED",
        message: "请先登录 COCEAN",
      });
    return reply
      .header("cache-control", "no-store")
      .header("x-cocean-role", session.user.role)
      .send(session);
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    deleteSession(database, request.headers.cookie);
    return reply
      .header("set-cookie", expiredSessionCookie(options.config.cookieSecure))
      .code(204)
      .send();
  });

  const requireSession = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): ReturnType<typeof readSession> => {
    const session = readSession(database, request.headers.cookie);
    if (!session) {
      reply.code(401).send({
        error: "AUTHENTICATION_REQUIRED",
        message: "请先登录 COCEAN",
      });
      return null;
    }
    return session;
  };

  const requireAdmin = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): ReturnType<typeof readSession> => {
    const session = requireSession(request, reply);
    if (!session) return null;
    if (session.user.role !== "ADMIN") {
      reply.code(403).send({
        error: "ADMIN_REQUIRED",
        message: "只有管理员可以管理账号与服务配置",
      });
      return null;
    }
    return session;
  };

  app.get("/api/v1/users", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return { items: database.listUsers() };
  });

  app.post("/api/v1/users", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const input = createUserInputSchema.parse(request.body ?? {});
    try {
      assertUsername(input.username);
      assertPassword(input.password);
      const now = new Date().toISOString();
      const user = {
        id: randomUUID(),
        username: input.username,
        displayName: input.displayName,
        role: input.role,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      } as const;
      database.createUser(user, await hashPassword(input.password));
      return reply.code(201).send(database.getUser(user.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "账号创建失败";
      return reply.code(409).send({ error: "USER_CREATE_FAILED", message });
    }
  });

  app.patch("/api/v1/users/:id", async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = updateUserInputSchema.parse(request.body ?? {});
    const existing = database.getUser(id);
    if (!existing)
      return reply
        .code(404)
        .send({ error: "USER_NOT_FOUND", message: "账号不存在" });
    const disablingLastAdmin =
      existing.role === "ADMIN" &&
      existing.enabled &&
      (input.enabled === false || input.role === "MEMBER") &&
      database.countEnabledAdmins() <= 1;
    if (disablingLastAdmin)
      return reply.code(409).send({
        error: "LAST_ADMIN_REQUIRED",
        message: "至少保留一个启用的管理员账号",
      });
    const update: {
      displayName?: string;
      role?: "ADMIN" | "MEMBER";
      enabled?: boolean;
      passwordHash?: string;
    } = {};
    if (input.displayName !== undefined) update.displayName = input.displayName;
    if (input.role !== undefined) update.role = input.role;
    if (input.enabled !== undefined) update.enabled = input.enabled;
    if (input.password)
      update.passwordHash = await hashPassword(input.password);
    const updated = database.updateUser(id, update);
    return updated;
  });

  const readiness = async (_request: FastifyRequest, reply: FastifyReply) => {
    const root = database.getLibraryRoot("music");
    const rootPath = root?.containerPath ?? options.config.musicRoot;
    let musicRootReadable = false;
    let musicRootKind: "directory" | "missing" | "other" = "missing";
    try {
      await access(rootPath, constants.R_OK);
      const information = await stat(rootPath);
      musicRootReadable = information.isDirectory();
      musicRootKind = information.isDirectory() ? "directory" : "other";
    } catch {
      musicRootReadable = false;
    }
    const payload = {
      status: musicRootReadable ? "ready" : "waiting_for_music_mount",
      database: "ready",
      musicRoot: {
        path: rootPath,
        readable: musicRootReadable,
        kind: musicRootKind,
        readOnlyPolicy: true,
        mountReadOnlyVerified: null,
      },
    };
    return reply.code(musicRootReadable ? 200 : 503).send(payload);
  };
  app.get("/api/readiness", readiness);
  app.get("/api/v1/readiness", readiness);

  app.get("/api/v1/library/stats", async () => database.getLibraryStats());

  app.get("/api/v1/capabilities", async () => {
    const storedModel = database.getStoredModelConfiguration();
    const modelConfigured = Boolean(
      storedModel.configuration.baseUrl &&
      storedModel.configuration.model &&
      storedModel.credentialJson,
    );
    return {
      catalogSources: {
        localFiles: { enabled: true, implemented: true },
        musicBrainz: {
          enabled: options.config.musicBrainzEnabled,
          implemented: true,
          configured: Boolean(releaseCatalogClient),
        },
        coverArtArchive: {
          enabled: options.config.musicBrainzEnabled,
          implemented: true,
          configured: Boolean(options.config.metadataContact),
        },
        acoustId: { enabled: false, implemented: false },
        discogs: { enabled: false, implemented: false },
      },
      providers: {
        appleMusic: {
          enabled: Boolean(appleCatalogClient),
          implemented: true,
          mode: "ARTWORK_PREVIEW_AND_DEEP_LINK",
        },
        qobuz: { enabled: false, implemented: false },
      },
      model: {
        enabled: storedModel.configuration.enabled,
        implemented: true,
        configured: modelConfigured,
        verified: storedModel.configuration.verificationStatus === "VERIFIED",
        verificationStatus: storedModel.configuration.verificationStatus,
        model: storedModel.configuration.model || undefined,
      },
      stillCatalog: {
        installed: database.getStillCatalogStatus().recordCount > 0,
      },
      recommendations: {
        catalogCompatibility: {
          implemented: true,
          ready: database.getStillCatalogStatus().recordCount > 0,
        },
        stillV010: {
          implemented: true,
          ready: false,
          reasonCode: "ACCEPTED_RUNTIME_SNAPSHOT_MISSING",
        },
      },
    };
  });

  app.get("/api/v1/catalog/status", async () => {
    const stored = database.getStillCatalogStatus();
    let fileAvailable = false;
    try {
      await access(options.config.stillCatalogPath, constants.R_OK);
      fileAvailable = true;
    } catch {
      fileAvailable = false;
    }
    return {
      configuredPath: options.config.stillCatalogPath,
      fileAvailable,
      ...stored,
      lastLoadError: catalogLoadError,
    };
  });

  app.post("/api/v1/catalog/reload", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const loaded = await loadStillCatalog();
    if (!loaded) {
      return reply.code(catalogLoadError ? 422 : 404).send({
        error: catalogLoadError
          ? "STILL_CATALOG_INVALID"
          : "STILL_CATALOG_FILE_NOT_FOUND",
        message:
          catalogLoadError ?? `没有找到 ${options.config.stillCatalogPath}`,
      });
    }
    return database.getStillCatalogStatus();
  });

  const recommendationResponse = async (
    kind: "TODAY" | "DISCOVER",
    dayKey: string,
    query = "",
    limit?: number,
  ) => {
    const status = database.getStillCatalogStatus();
    if (!status.activeContentVersion || status.recordCount === 0) return null;
    const selection = selectCatalogRecommendations({
      kind,
      catalog: database.listActiveStillCatalogAlbums(),
      contentVersion: status.activeContentVersion,
      dayKey,
      query,
      ...(limit === undefined ? {} : { limit }),
    });
    const items = await Promise.all(
      selection.items.map(async ({ album, matchedCriteria }) => ({
        stillAlbumId: album.id,
        title: album.title,
        artist: album.artist,
        domains: album.domains,
        features: album.features,
        sourceKind: album.sourceKind,
        sourceRef: album.sourceRef,
        external:
          (appleCatalogClient
            ? await appleCatalogClient.lookup(album.sourceRef)
            : null) ?? externalMediaFallback(album.sourceRef),
        matchedCriteria: [...matchedCriteria],
        localAlbum: database.findAlbumSummaryByIdentity(
          album.title,
          album.artist,
        ),
      })),
    );
    return catalogRecommendationResponseSchema.parse({
      mode: "VERIFIED_CATALOG_COMPATIBILITY",
      requestKind: kind,
      sourceContentVersion: selection.sourceContentVersion,
      algorithmVersion: selection.algorithmVersion,
      modelCallCount: selection.modelCallCount,
      query: selection.query,
      primary: items[0] ?? null,
      items,
      v010: {
        algorithmVersion: selection.stillV010AlgorithmVersion,
        status: "WAITING_FOR_ACCEPTED_RUNTIME",
        reasonCode: "ACCEPTED_RUNTIME_SNAPSHOT_MISSING",
      },
      limitations: [
        "当前结果来自已核验 Still 兼容目录，不等同于 v0.10 Accepted Runtime 推荐。",
        "只使用目录中明确存在的领域与音乐特征；未提供的年代、人声和音频规格不会被推断。",
      ],
    });
  };

  app.get("/api/v1/recommendations/today", async (request, reply) => {
    const query = todayRecommendationQuerySchema.parse(request.query);
    const result = await recommendationResponse(
      "TODAY",
      query.dayKey ?? new Date().toISOString().slice(0, 10),
    );
    if (!result) {
      return reply.code(409).send({
        error: "STILL_CATALOG_NOT_READY",
        message: "尚未安装 Still 精选目录；请先在设置中导入并校验目录文件",
      });
    }
    return result;
  });

  app.post("/api/v1/recommendations/discover", async (request, reply) => {
    const input = discoverRecommendationInputSchema.parse(request.body ?? {});
    const result = await recommendationResponse(
      "DISCOVER",
      input.dayKey ?? new Date().toISOString().slice(0, 10),
      input.query,
      input.limit,
    );
    if (!result) {
      return reply.code(409).send({
        error: "STILL_CATALOG_NOT_READY",
        message: "尚未安装 Still 精选目录；请先在设置中导入并校验目录文件",
      });
    }
    return result;
  });

  app.get("/api/v1/albums", async (request) => {
    const query = albumQuerySchema.parse(request.query);
    return {
      items: database.listAlbums({
        limit: query.limit,
        offset: query.offset,
        filter: query.filter,
        sort: query.sort,
        issue: query.issue,
        ...(query.search ? { search: query.search } : {}),
      }),
      limit: query.limit,
      offset: query.offset,
      total: database.countAlbums({
        filter: query.filter,
        issue: query.issue,
        ...(query.search ? { search: query.search } : {}),
      }),
    };
  });

  app.post("/api/v1/albums", async (request, reply) => {
    const input = physicalAlbumInputSchema.parse(request.body ?? {});
    const groupKey = [input.albumArtist, input.title, input.year ?? ""]
      .map((value) =>
        String(value)
          .normalize("NFKC")
          .trim()
          .toLocaleLowerCase("en-US")
          .replace(/\s+/g, " "),
      )
      .join("\0");
    const identityMatch = database.findAlbumSummaryByIdentity(
      input.title,
      input.albumArtist,
    );
    const compatibleIdentity =
      identityMatch &&
      (input.year == null ||
        identityMatch.year == null ||
        identityMatch.year === input.year)
        ? database.getAlbum(identityMatch.id)
        : null;
    let album = compatibleIdentity ?? database.findPhysicalOnlyAlbum(groupKey);
    if (!album) {
      album = database.createPhysicalOnlyAlbum({
        id: randomUUID(),
        groupKey,
        title: input.title,
        albumArtist: input.albumArtist,
        year: input.year ?? null,
      });
    }
    const now = new Date().toISOString();
    const copy = {
      id: randomUUID(),
      albumId: album.id,
      medium: input.medium,
      label: null,
      catalogNumber: null,
      barcode: null,
      country: null,
      releaseYear: input.year ?? null,
      quantity: 1,
      conditionNote: null,
      storageLocation: null,
      createdAt: now,
      updatedAt: now,
    };
    database.createPhysicalCopy(copy);
    return reply.code(201).send(database.getAlbum(album.id));
  });

  app.get("/api/v1/albums/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const album = database.getAlbum(id);
    if (!album)
      return reply
        .code(404)
        .send({ error: "ALBUM_NOT_FOUND", message: "没有找到这张专辑" });
    if (!readSession(database, request.headers.cookie)) {
      const {
        metadata: _metadata,
        artworkGovernance: _artworkGovernance,
        ...publicAlbum
      } = album;
      return publicAlbum;
    }
    return album;
  });

  app.get("/api/v1/albums/:id/artwork", async (request, reply) => {
    if (!requireSession(request, reply)) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const artwork = database.getAlbumArtworkGovernance(id);
    if (!artwork)
      return reply
        .code(404)
        .send({ error: "ALBUM_NOT_FOUND", message: "没有找到这张专辑" });
    return artwork;
  });

  app.post("/api/v1/albums/:id/artwork/select", async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const command = artworkDecisionCommandSchema.parse(request.body ?? {});
    try {
      return database.applyAlbumArtworkDecision(id, command, {
        id: admin.user.id,
        displayName: admin.user.displayName,
      });
    } catch (error) {
      return handleArtworkDecisionError(error, reply);
    }
  });

  app.post(
    "/api/v1/albums/:id/artwork/upload",
    { bodyLimit: 21 * 1024 * 1024 },
    async (request, reply) => {
      const admin = requireAdmin(request, reply);
      if (!admin) return;
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const fields: Record<string, string> = {};
      let upload: { bytes: Buffer; mimeType: string; filename: string } | null =
        null;
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (upload) {
            part.file.resume();
            return reply.code(400).send({
              error: "INVALID_ARTWORK_FILE",
              message: "一次只能上传一张封面",
            });
          }
          upload = {
            bytes: await part.toBuffer(),
            mimeType: part.mimetype,
            filename: part.filename,
          };
        } else fields[part.fieldname] = String(part.value);
      }
      if (!upload)
        return reply.code(400).send({
          error: "INVALID_ARTWORK_FILE",
          message: "请选择要上传的封面文件",
        });
      const command = z
        .object({
          requestId: z.string().trim().min(1).max(200),
          expectedArtworkRevision: z.coerce.number().int().nonnegative(),
        })
        .parse(fields);
      try {
        const asset = await validateAndStoreArtwork({
          bytes: upload.bytes,
          declaredMimeType: upload.mimeType,
          cacheRoot: options.config.cacheRoot,
          ffprobePath: options.config.ffprobePath,
        });
        return database.applyAlbumArtworkCandidateDecision(
          id,
          {
            ...asset,
            source: "USER_UPLOAD",
            localVersionId: null,
            relativePath: null,
            kind: "FRONT",
            evidence: { originalFilename: upload.filename },
          },
          command,
          { id: admin.user.id, displayName: admin.user.displayName },
          "UPLOAD",
        );
      } catch (error) {
        return handleArtworkDecisionError(error, reply);
      }
    },
  );

  app.post(
    "/api/v1/albums/:id/artwork/import/musicbrainz",
    async (request, reply) => {
      const admin = requireAdmin(request, reply);
      if (!admin) return;
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const command = importMusicBrainzArtworkCommandSchema.parse(
        request.body ?? {},
      );
      if (!options.config.musicBrainzEnabled || !options.config.metadataContact)
        return reply.code(409).send({
          error: "CATALOG_SOURCE_NOT_CONFIGURED",
          message:
            "CAA 导入需要启用 MusicBrainz 并配置 COCEAN_METADATA_CONTACT",
        });
      const releaseId = database.getConfirmedMusicBrainzReleaseId(
        id,
        command.localVersionId,
      );
      if (!releaseId)
        return reply.code(409).send({
          error: "ARTWORK_DECISION_CONFLICT",
          message:
            "只能从当前本地版本已人工确认的 MusicBrainz Release 导入封面",
        });
      try {
        const remote = await fetchCoverArtArchiveFront({
          releaseId,
          contact: options.config.metadataContact,
          timeoutMs: options.config.externalLookupTimeoutMs,
          ...(options.artworkFetch ? { fetch: options.artworkFetch } : {}),
        });
        const asset = await validateAndStoreArtwork({
          bytes: remote.bytes,
          declaredMimeType: remote.mimeType,
          cacheRoot: options.config.cacheRoot,
          ffprobePath: options.config.ffprobePath,
        });
        return database.applyAlbumArtworkCandidateDecision(
          id,
          {
            ...asset,
            source: "MUSICBRAINZ_CAA",
            localVersionId: command.localVersionId,
            relativePath: null,
            kind: "FRONT",
            evidence: { releaseId, sourceUrl: remote.sourceUrl },
          },
          {
            requestId: command.requestId,
            expectedArtworkRevision: command.expectedArtworkRevision,
          },
          { id: admin.user.id, displayName: admin.user.displayName },
          "IMPORT",
        );
      } catch (error) {
        return handleArtworkDecisionError(error, reply);
      }
    },
  );

  app.get("/api/v1/albums/:id/artwork-history", async (request, reply) => {
    if (!requireSession(request, reply)) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!database.getAlbumArtworkGovernance(id))
      return reply
        .code(404)
        .send({ error: "ALBUM_NOT_FOUND", message: "没有找到这张专辑" });
    return { items: database.listAlbumArtworkHistory(id) };
  });

  app.post(
    "/api/v1/albums/:id/artwork-history/:eventId/undo",
    async (request, reply) => {
      const admin = requireAdmin(request, reply);
      if (!admin) return;
      const { id, eventId } = z
        .object({ id: z.string(), eventId: z.string() })
        .parse(request.params);
      const command = undoAlbumArtworkCommandSchema.parse(request.body ?? {});
      try {
        return database.undoAlbumArtworkEvent(
          id,
          eventId,
          command.requestId,
          command.expectedArtworkRevision,
          { id: admin.user.id, displayName: admin.user.displayName },
        );
      } catch (error) {
        return handleArtworkDecisionError(error, reply);
      }
    },
  );

  app.get("/api/v1/albums/:id/metadata", async (request, reply) => {
    if (!requireSession(request, reply)) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const metadata = database.getAlbumMetadata(id);
    if (!metadata)
      return reply
        .code(404)
        .send({ error: "ALBUM_NOT_FOUND", message: "没有找到这张专辑" });
    return metadata;
  });

  app.patch("/api/v1/albums/:id/metadata", async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const command = updateAlbumMetadataCommandSchema.parse(request.body ?? {});
    try {
      return database.applyAlbumMetadata(id, command, {
        id: admin.user.id,
        displayName: admin.user.displayName,
      });
    } catch (error) {
      if (error instanceof AlbumMetadataDecisionError)
        return reply
          .code(error.code === "INVALID_METADATA_DECISION" ? 400 : 409)
          .send({ error: error.code, message: error.message });
      throw error;
    }
  });

  app.get("/api/v1/albums/:id/metadata-history", async (request, reply) => {
    if (!requireSession(request, reply)) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!database.getAlbumMetadata(id))
      return reply
        .code(404)
        .send({ error: "ALBUM_NOT_FOUND", message: "没有找到这张专辑" });
    return { items: database.listAlbumMetadataHistory(id) };
  });

  app.post(
    "/api/v1/albums/:id/metadata-history/:eventId/undo",
    async (request, reply) => {
      const admin = requireAdmin(request, reply);
      if (!admin) return;
      const { id, eventId } = z
        .object({ id: z.string(), eventId: z.string() })
        .parse(request.params);
      const command = undoAlbumMetadataCommandSchema.parse(request.body ?? {});
      try {
        return database.undoAlbumMetadataEvent(
          id,
          eventId,
          command.requestId,
          command.expectedMetadataRevision,
          { id: admin.user.id, displayName: admin.user.displayName },
        );
      } catch (error) {
        if (error instanceof AlbumMetadataDecisionError)
          return reply
            .code(error.code === "INVALID_METADATA_DECISION" ? 400 : 409)
            .send({ error: error.code, message: error.message });
        throw error;
      }
    },
  );

  app.get("/api/v1/albums/:id/identity-decisions", async (request, reply) => {
    if (!requireSession(request, reply)) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!database.getAlbum(id))
      return reply
        .code(404)
        .send({ error: "ALBUM_NOT_FOUND", message: "没有找到这张专辑" });
    return { items: database.listLibraryIdentityDecisionHistory(id) };
  });

  app.post("/api/v1/albums/:id/identity-decisions", async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const command = libraryIdentityDecisionCommandSchema.parse(
      request.body ?? {},
    );
    try {
      return database.applyLibraryIdentityDecision(id, command, {
        id: admin.user.id,
        displayName: admin.user.displayName,
      });
    } catch (error) {
      if (error instanceof LibraryIdentityDecisionError)
        return reply
          .code(error.code === "INVALID_IDENTITY_DECISION" ? 400 : 409)
          .send({ error: error.code, message: error.message });
      throw error;
    }
  });

  app.post(
    "/api/v1/albums/:id/identity-decisions/:decisionId/undo",
    async (request, reply) => {
      const admin = requireAdmin(request, reply);
      if (!admin) return;
      const { id, decisionId } = z
        .object({ id: z.string(), decisionId: z.string() })
        .parse(request.params);
      const command = undoLibraryIdentityDecisionCommandSchema.parse(
        request.body ?? {},
      );
      try {
        return database.undoLibraryIdentityDecision(
          id,
          decisionId,
          command.requestId,
          command.revision,
          { id: admin.user.id, displayName: admin.user.displayName },
        );
      } catch (error) {
        if (error instanceof LibraryIdentityDecisionError)
          return reply
            .code(error.code === "INVALID_IDENTITY_DECISION" ? 400 : 409)
            .send({ error: error.code, message: error.message });
        throw error;
      }
    },
  );

  app.get("/api/v1/albums/:id/match-candidates", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const query = matchCandidatesQuerySchema.parse(request.query);
    if (!database.getAlbum(id))
      return reply
        .code(404)
        .send({ error: "ALBUM_NOT_FOUND", message: "没有找到这张专辑" });
    return { items: database.listReleaseCandidates(id, query.localVersionId) };
  });

  app.post("/api/v1/albums/:id/match-candidates", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const album = database.getAlbum(id);
    if (!album)
      return reply
        .code(404)
        .send({ error: "ALBUM_NOT_FOUND", message: "没有找到这张专辑" });
    if (!releaseCatalogClient) {
      return reply.code(409).send({
        error: "CATALOG_SOURCE_NOT_CONFIGURED",
        message: options.config.musicBrainzEnabled
          ? "请为 MusicBrainz 请求配置 COCEAN_METADATA_CONTACT（维护者邮箱或项目网址）"
          : "MusicBrainz 当前关闭；请先在部署环境设置 COCEAN_MUSICBRAINZ_ENABLED=true",
      });
    }
    const { limit, localVersionId } = matchSearchSchema.parse(
      request.body ?? {},
    );
    const selectedVersionId =
      localVersionId ?? album.primaryVersionId ?? album.localVersions?.[0]?.id;
    const selectedVersion = album.localVersions?.find(
      (version) => version.id === selectedVersionId,
    );
    if (!selectedVersionId || !selectedVersion)
      return reply.code(409).send({
        error: "METADATA_DECISION_CONFLICT",
        message: "候选目标版本已不属于当前唱片",
      });
    try {
      const candidates = await releaseCatalogClient.searchReleases({
        albumId: selectedVersionId,
        title: selectedVersion.title,
        artist: selectedVersion.albumArtist,
        year: selectedVersion.year,
        limit,
      });
      database.replaceReleaseCandidates(
        album.id,
        candidates,
        selectedVersionId,
      );
      return {
        items: database.listReleaseCandidates(album.id, selectedVersionId),
      };
    } catch (error) {
      request.log.warn(
        { err: error, albumId: album.id },
        "catalog source search failed",
      );
      return reply.code(502).send({
        error: "CATALOG_SOURCE_UNAVAILABLE",
        message: "MusicBrainz 暂时不可用，原始唱片信息没有被修改",
      });
    }
  });

  app.post(
    "/api/v1/albums/:albumId/match-candidates/:candidateId/confirm",
    async (request, reply) => {
      const admin = requireAdmin(request, reply);
      if (!admin) return;
      const { albumId, candidateId } = z
        .object({ albumId: z.string(), candidateId: z.string() })
        .parse(request.params);
      if (!database.getAlbum(albumId)) {
        return reply
          .code(404)
          .send({ error: "ALBUM_NOT_FOUND", message: "没有找到这张专辑" });
      }
      const command = confirmReleaseCandidateCommandSchema.parse(
        request.body ?? {},
      );
      try {
        const confirmed = database.confirmReleaseCandidateMetadata(
          albumId,
          candidateId,
          command.localVersionId,
          command.requestId,
          command.expectedMetadataRevision,
          { id: admin.user.id, displayName: admin.user.displayName },
        );
        if (!confirmed) {
          return reply.code(404).send({
            error: "MATCH_CANDIDATE_NOT_FOUND",
            message: "没有找到这条发行版候选，或候选已经漂移",
          });
        }
        return {
          candidate: confirmed.candidate,
          album: database.getAlbum(albumId),
          metadataEvent: confirmed.result.event,
        };
      } catch (error) {
        if (error instanceof AlbumMetadataDecisionError)
          return reply
            .code(error.code === "INVALID_METADATA_DECISION" ? 400 : 409)
            .send({ error: error.code, message: error.message });
        throw error;
      }
    },
  );

  app.get("/api/v1/albums/:id/physical-copies", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!database.getAlbum(id))
      return reply
        .code(404)
        .send({ error: "ALBUM_NOT_FOUND", message: "没有找到这张专辑" });
    return { items: database.listPhysicalCopies(id) };
  });

  app.post("/api/v1/albums/:id/physical-copies", async (request, reply) => {
    const { id: albumId } = z.object({ id: z.string() }).parse(request.params);
    const album = database.getAlbum(albumId);
    if (!album)
      return reply
        .code(404)
        .send({ error: "ALBUM_NOT_FOUND", message: "没有找到这张专辑" });
    const input = physicalCopyInputSchema.parse(request.body ?? {});
    const now = new Date().toISOString();
    const copy = {
      id: randomUUID(),
      albumId: album.id,
      medium: input.medium,
      label: input.label ?? null,
      catalogNumber: input.catalogNumber ?? null,
      barcode: input.barcode ?? null,
      country: input.country ?? null,
      releaseYear: input.releaseYear ?? null,
      quantity: input.quantity,
      conditionNote: input.conditionNote ?? null,
      storageLocation: input.storageLocation ?? null,
      createdAt: now,
      updatedAt: now,
    };
    database.createPhysicalCopy(copy);
    return reply.code(201).send(copy);
  });

  app.delete(
    "/api/v1/albums/:albumId/physical-copies/:copyId",
    async (request, reply) => {
      const { albumId, copyId } = z
        .object({ albumId: z.string(), copyId: z.string() })
        .parse(request.params);
      if (!database.deletePhysicalCopy(albumId, copyId)) {
        return reply.code(404).send({
          error: "PHYSICAL_COPY_NOT_FOUND",
          message: "没有找到这条实体唱片记录",
        });
      }
      return reply.code(204).send();
    },
  );

  app.get("/api/v1/gear/devices", async () => ({
    items: database.listOwnedDevices(),
  }));

  app.post("/api/v1/gear/devices", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const input = ownedDeviceInputSchema.parse(request.body ?? {});
    const now = new Date().toISOString();
    const device = {
      id: randomUUID(),
      manufacturer: input.manufacturer,
      model: input.model,
      category: input.category,
      ownership: input.ownership,
      nickname: input.nickname ?? null,
      serialNumber: input.serialNumber ?? null,
      notes: input.notes ?? null,
      capabilities: {
        maxPcmSampleRate: null,
        maxPcmBitDepth: null,
        maxDsdRate: null,
        supportedFormats: [],
        source: null,
        verifiedAt: null,
      },
      createdAt: now,
      updatedAt: now,
    };
    database.createOwnedDevice(device);
    return reply.code(201).send(device);
  });

  app.delete("/api/v1/gear/devices/:id", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!database.deleteOwnedDevice(id))
      return reply
        .code(404)
        .send({ error: "DEVICE_NOT_FOUND", message: "没有找到这台设备" });
    return reply.code(204).send();
  });

  app.get("/api/v1/delivery-targets", async () => ({
    items: database.listDeliveryTargets(),
  }));

  app.post("/api/v1/delivery-targets", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const input = deliveryTargetInputSchema.parse(request.body ?? {});
    if (
      input.deviceId &&
      !database
        .listOwnedDevices()
        .some((device) => device.id === input.deviceId)
    ) {
      return reply
        .code(400)
        .send({ error: "INVALID_DEVICE", message: "投送目标引用的设备不存在" });
    }
    const now = new Date().toISOString();
    const target = {
      id: randomUUID(),
      deviceId: input.deviceId ?? null,
      name: input.name,
      kind: input.kind,
      transport: input.transport,
      location: input.location,
      username: input.username ?? null,
      credentialConfigured: Boolean(input.password),
      enabled: input.enabled,
      verifiedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const credentialJson = input.password
      ? vault.encrypt(JSON.stringify({ password: input.password }))
      : null;
    database.createDeliveryTarget(target, credentialJson);
    return reply.code(201).send(target);
  });

  app.put("/api/v1/delivery-targets/:id", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const stored = database.getStoredDeliveryTarget(id);
    if (!stored)
      return reply.code(404).send({
        error: "DELIVERY_TARGET_NOT_FOUND",
        message: "没有找到这个投送目标",
      });
    const input = deliveryTargetInputSchema.parse(request.body ?? {});
    if (
      input.deviceId &&
      !database
        .listOwnedDevices()
        .some((device) => device.id === input.deviceId)
    ) {
      return reply
        .code(400)
        .send({ error: "INVALID_DEVICE", message: "投送目标引用的设备不存在" });
    }
    const credentialJson = ["FTP", "AK_FILE_DROP"].includes(input.transport)
      ? input.password
        ? vault.encrypt(JSON.stringify({ password: input.password }))
        : stored.credentialJson
      : null;
    const target = {
      ...stored.target,
      deviceId: input.deviceId ?? null,
      name: input.name,
      kind: input.kind,
      transport: input.transport,
      location: input.location,
      username: input.username ?? null,
      credentialConfigured: Boolean(credentialJson),
      enabled: input.enabled,
      verifiedAt: null,
      updatedAt: new Date().toISOString(),
    };
    database.updateDeliveryTarget(target, credentialJson);
    return target;
  });

  app.get("/api/v1/albums/:id/deliveries", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!database.getAlbum(id))
      return reply
        .code(404)
        .send({ error: "ALBUM_NOT_FOUND", message: "没有找到这张专辑" });
    return { items: database.listAlbumDeliveryJobs(id) };
  });

  app.get("/api/v1/deliveries", async (request) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(request.query);
    return { items: database.listDeliveryJobs(limit) };
  });

  app.post("/api/v1/albums/:id/deliveries", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id: albumId } = z.object({ id: z.string() }).parse(request.params);
    const { targetId, planId } = z
      .object({
        targetId: z.string().min(1),
        planId: z.string().uuid().nullable().optional(),
      })
      .parse(request.body ?? {});
    const album = database.getAlbum(albumId);
    const stored = database.getStoredDeliveryTarget(targetId);
    if (!album)
      return reply
        .code(404)
        .send({ error: "ALBUM_NOT_FOUND", message: "没有找到这张专辑" });
    if (!album.hasDigital)
      return reply.code(409).send({
        error: "NO_DIGITAL_FILES",
        message: "这张专辑只有实体记录，没有可投送的数字文件",
      });
    if (!stored?.target.enabled)
      return reply.code(400).send({
        error: "DELIVERY_TARGET_UNAVAILABLE",
        message: "投送目标不存在或已停用",
      });
    const active = database.findActiveDeliveryJob(albumId, targetId);
    if (active)
      return reply.code(409).send({
        error: "DELIVERY_ALREADY_ACTIVE",
        message: "这张专辑正在投送到该目标，请等待现有任务完成",
        jobId: active.id,
      });
    let bundle;
    try {
      bundle = await deliveryRunner.prepareAlbumDelivery(
        albumId,
        stored.target.transport,
      );
    } catch (error) {
      return reply.code(409).send({
        error: "DELIVERY_PREPARATION_FAILED",
        message: error instanceof Error ? error.message : "投送文件准备失败",
      });
    }
    const now = new Date().toISOString();
    const resolvedPlanId =
      database.resolveDeliveryPlanId(targetId, planId ?? null) ?? randomUUID();
    const job = {
      id: randomUUID(),
      albumId: bundle.albumId,
      targetId,
      targetName: stored.target.name,
      transport: stored.target.transport,
      status: "QUEUED" as const,
      fileCount: bundle.files.length + Number(Boolean(bundle.preparedArtwork)),
      completedFileCount: 0,
      totalBytes:
        bundle.files.reduce(
          (total, file) => total + (file.outputSizeBytes ?? file.sizeBytes),
          0,
        ) + (bundle.preparedArtwork?.sizeBytes ?? 0),
      transferredBytes: 0,
      verified: false,
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      planId: resolvedPlanId,
    };
    try {
      database.createDeliveryJob(job, bundle);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("active delivery already exists")
      )
        return reply.code(409).send({
          error: "DELIVERY_ALREADY_ACTIVE",
          message: "这张专辑正在投送到该目标，请等待现有任务完成",
        });
      throw error;
    }
    if (options.deliveryExecution !== false) deliveryRunner.start();
    return reply.code(202).send(job);
  });

  app.get("/api/v1/scans", async (request) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
      .parse(request.query);
    return { items: database.listScanJobs(limit) };
  });

  app.get("/api/v1/scans/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const job = database.getScanJob(id);
    if (!job)
      return reply
        .code(404)
        .send({ error: "SCAN_NOT_FOUND", message: "没有找到扫描任务" });
    return job;
  });

  app.get("/api/v1/scans/:id/report", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const job = database.getScanJob(id);
    if (!job)
      return reply
        .code(404)
        .send({ error: "SCAN_NOT_FOUND", message: "没有找到扫描任务" });
    const report = database.getScanReport(id);
    if (!report) {
      return reply.code(409).send({
        error: "SCAN_REPORT_NOT_READY",
        message:
          job.status === "QUEUED" || job.status === "RUNNING"
            ? "扫描报告将在任务进入终态后冻结"
            : "该历史任务创建于逐文件证据合同之前，没有可用报告",
      });
    }
    return report;
  });

  app.get("/api/v1/scans/:id/files", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!database.getScanJob(id))
      return reply
        .code(404)
        .send({ error: "SCAN_NOT_FOUND", message: "没有找到扫描任务" });
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(5000).default(500),
        offset: z.coerce.number().int().nonnegative().default(0),
        outcome: scanFileOutcomeSchema.optional(),
      })
      .parse(request.query);
    return {
      items: database.listScanFileResults(id, {
        limit: query.limit,
        offset: query.offset,
        ...(query.outcome ? { outcome: query.outcome } : {}),
      }),
      limit: query.limit,
      offset: query.offset,
      total: database.countScanFileResults(id, query.outcome),
    };
  });

  app.get("/api/v1/scans/:id/failures", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!database.getScanJob(id))
      return reply
        .code(404)
        .send({ error: "SCAN_NOT_FOUND", message: "没有找到扫描任务" });
    const { limit, offset } = z
      .object({
        limit: z.coerce.number().int().min(1).max(5000).default(500),
        offset: z.coerce.number().int().nonnegative().default(0),
      })
      .parse(request.query);
    return {
      items: database.listScanFailures(id, limit, offset),
      limit,
      offset,
      total: database.countScanFailures(id),
    };
  });

  app.post("/api/v1/scans", async (request, reply) => {
    const input = scanRequestSchema.parse(request.body ?? {});
    const root = database.getLibraryRoot(input.rootId);
    if (!root || !root.enabled) {
      return reply.code(400).send({
        error: "INVALID_LIBRARY_ROOT",
        message: "音乐目录不存在或未启用",
      });
    }
    const active = database
      .listScanJobs(100)
      .find(
        (job) =>
          job.rootId === root.id &&
          (job.status === "QUEUED" || job.status === "RUNNING"),
      );
    if (active)
      return reply.code(409).send({
        error: "SCAN_ALREADY_ACTIVE",
        message: "该音乐目录已有扫描任务正在等待或运行，请先完成或取消它",
      });
    const job = {
      id: randomUUID(),
      rootId: root.id,
      mode: input.mode,
      triggerSource: "MANUAL" as const,
      retryOfScanJobId: null,
      status: "QUEUED" as const,
      totalFiles: 0,
      processedFiles: 0,
      parsedFiles: 0,
      failedFiles: 0,
      reusedFiles: 0,
      stableAlbumDirectories: 0,
      deferredAlbumDirectories: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      cancelRequestedAt: null,
    };
    if (!database.tryCreateScanJob(job))
      return reply.code(409).send({
        error: "SCAN_ALREADY_ACTIVE",
        message: "该音乐目录已有扫描任务正在等待或运行，请先完成或取消它",
      });
    return reply.code(202).send(job);
  });

  app.post("/api/v1/scans/:id/retry", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const previous = database.getScanJob(id);
    if (!previous)
      return reply
        .code(404)
        .send({ error: "SCAN_NOT_FOUND", message: "没有找到扫描任务" });
    if (previous.status !== "FAILED")
      return reply.code(409).send({
        error: "SCAN_NOT_FAILED",
        message: "只有失败的扫描任务可以重试",
      });
    const root = database.getLibraryRoot(previous.rootId);
    if (!root || !root.enabled)
      return reply.code(400).send({
        error: "INVALID_LIBRARY_ROOT",
        message: "音乐目录不存在或未启用",
      });
    const job = {
      id: randomUUID(),
      rootId: previous.rootId,
      mode: previous.mode,
      triggerSource: "RETRY" as const,
      retryOfScanJobId: previous.id,
      status: "QUEUED" as const,
      totalFiles: 0,
      processedFiles: 0,
      parsedFiles: 0,
      failedFiles: 0,
      reusedFiles: 0,
      stableAlbumDirectories: 0,
      deferredAlbumDirectories: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      cancelRequestedAt: null,
    };
    if (!database.tryCreateScanJob(job))
      return reply.code(409).send({
        error: "SCAN_ALREADY_ACTIVE",
        message: "该音乐目录已有扫描任务正在等待或运行，请先完成或取消它",
      });
    return reply.code(202).send(job);
  });

  app.post("/api/v1/scans/:id/cancel", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const job = database.getScanJob(id);
    if (!job)
      return reply
        .code(404)
        .send({ error: "SCAN_NOT_FOUND", message: "没有找到扫描任务" });
    if (!["QUEUED", "RUNNING"].includes(job.status))
      return reply.code(409).send({
        error: "SCAN_NOT_ACTIVE",
        message: "该扫描已经结束，不能再取消",
      });
    return reply
      .code(job.status === "RUNNING" ? 202 : 200)
      .send(database.requestScanCancellation(id));
  });

  app.get("/api/v1/settings", async () => database.getSettings());

  app.put("/api/v1/settings", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const settings = coceanSettingsSchema.parse(request.body);
    if (settings.sourceWritebackEnabled) {
      return reply.code(400).send({
        error: "SOURCE_WRITEBACK_DISABLED",
        message: "V1 不允许写回源音乐目录",
      });
    }
    if (settings.scanOnStart) {
      return reply.code(400).send({
        error: "SCAN_ON_START_UNAVAILABLE",
        message: "当前版本尚未实现启动自动扫描",
      });
    }
    if (settings.deviceCopyMetadataEnabled) {
      return reply.code(400).send({
        error: "DEVICE_COPY_PIPELINE_UNAVAILABLE",
        message: "当前可投送原始文件，但尚未开放投送副本的标签修改",
      });
    }
    if (
      JSON.stringify(settings.libraryRoots.map(deploymentRootView)) !==
      JSON.stringify(
        database.getSettings().libraryRoots.map(deploymentRootView),
      )
    ) {
      return reply.code(400).send({
        error: "LIBRARY_ROOT_DEPLOYMENT_MANAGED",
        message: "NAS 主机路径与容器挂载只能通过 FNOS Compose 修改",
      });
    }
    database.saveSettings(settings);
    return database.getSettings();
  });

  app.get("/api/v1/model/configuration", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return database.getStoredModelConfiguration().configuration;
  });

  app.put("/api/v1/model/configuration", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const input = modelConfigurationInputSchema.parse(request.body ?? {});
    const stored = database.getStoredModelConfiguration();
    const credentialJson = input.clearApiKey
      ? null
      : input.apiKey
        ? vault.encrypt(input.apiKey)
        : stored.credentialJson;
    if (input.enabled && (!input.model || !credentialJson))
      return reply.code(400).send({
        error: "MODEL_CONFIGURATION_INCOMPLETE",
        message: "启用模型前必须填写模型名称和 API Key",
      });
    return database.saveModelConfiguration({
      enabled: input.enabled,
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      model: input.model,
      credentialJson,
    });
  });

  app.post("/api/v1/model/configuration/verify", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const stored = database.getStoredModelConfiguration();
    if (
      !stored.configuration.baseUrl ||
      !stored.configuration.model ||
      !stored.credentialJson
    )
      return reply.code(409).send({
        error: "MODEL_CONFIGURATION_INCOMPLETE",
        message: "请先填写 Base URL、模型名称和 API Key",
      });
    const apiKey = vault.decrypt(stored.credentialJson);
    let response: Response;
    try {
      response = await modelFetch(
        modelCompletionEndpoint(stored.configuration.baseUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: stored.configuration.model,
            temperature: 0,
            max_tokens: 1,
            stream: false,
            messages: [
              {
                role: "user",
                content: "Reply with OK.",
              },
            ],
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (error) {
      const message = modelNetworkErrorMessage(error);
      database.recordModelVerification("FAILED", message);
      return reply.code(502).send({
        error: "MODEL_CONNECTION_FAILED",
        message,
      });
    }
    if (!response.ok) {
      const message = await modelProviderErrorMessage(response);
      database.recordModelVerification("FAILED", message);
      return reply.code(502).send({
        error: "MODEL_CONNECTION_FAILED",
        message,
      });
    }
    return database.recordModelVerification("VERIFIED", "连接正常");
  });

  app.get("/api/v1/albums/:id/introduction", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!database.getAlbum(id))
      return reply
        .code(404)
        .send({ error: "ALBUM_NOT_FOUND", message: "没有找到这张专辑" });
    return { introduction: database.getAlbumIntroduction(id) };
  });

  app.post("/api/v1/albums/:id/introduction", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const album = database.getAlbum(id);
    if (!album)
      return reply
        .code(404)
        .send({ error: "ALBUM_NOT_FOUND", message: "没有找到这张专辑" });
    const stored = database.getStoredModelConfiguration();
    if (
      !stored.configuration.enabled ||
      !stored.configuration.model ||
      !stored.credentialJson
    )
      return reply.code(409).send({
        error: "MODEL_NOT_CONFIGURED",
        message: "请先由管理员在设置中配置大模型",
      });
    if (stored.configuration.verificationStatus !== "VERIFIED")
      return reply.code(409).send({
        error: "MODEL_NOT_VERIFIED",
        message: "模型连接尚未验证；请先在设置中执行连接验证",
      });
    const apiKey = vault.decrypt(stored.credentialJson);
    const factualBasis = [
      `Album: ${album.title}`,
      `Artist: ${album.albumArtist}`,
      album.year ? `Year: ${album.year}` : null,
      album.release.label ? `Label: ${album.release.label}` : null,
      album.audioBadge ? `Local audio: ${album.audioBadge}` : null,
      `Tracks: ${album.tracks
        .map((track) => track.title)
        .slice(0, 30)
        .join(" / ")}`,
    ].filter((value): value is string => Boolean(value));
    let response: Response;
    try {
      response = await modelFetch(
        modelCompletionEndpoint(stored.configuration.baseUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: stored.configuration.model,
            temperature: 0.35,
            max_tokens: 500,
            stream: false,
            messages: [
              {
                role: "system",
                content:
                  "你是严谨的音乐编辑。仅使用用户提供的事实，为 Hi-Fi 听众写 120-220 字中文专辑介绍；不得编造录音、母带、获奖、乐手或发行事实。不确定内容不要写。",
              },
              { role: "user", content: factualBasis.join("\n") },
            ],
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch (error) {
      return reply.code(502).send({
        error: "MODEL_REQUEST_FAILED",
        message: modelNetworkErrorMessage(error),
      });
    }
    if (!response.ok)
      return reply.code(502).send({
        error: "MODEL_REQUEST_FAILED",
        message: await modelProviderErrorMessage(response),
      });
    const payload = z
      .object({
        choices: z.array(
          z.object({ message: z.object({ content: z.string().min(1) }) }),
        ),
      })
      .parse(await response.json());
    const introduction = {
      albumId: id,
      content: payload.choices[0]?.message.content.trim() ?? "",
      model: stored.configuration.model,
      generatedAt: new Date().toISOString(),
      factualBasis,
    };
    if (!introduction.content)
      return reply.code(502).send({
        error: "MODEL_EMPTY_RESPONSE",
        message: "模型没有返回可用介绍",
      });
    database.saveAlbumIntroduction(
      introduction,
      createHash("sha256").update(JSON.stringify(factualBasis)).digest("hex"),
    );
    return introduction;
  });

  app.get("/api/v1/artwork/:hash", async (request, reply) => {
    const { hash } = z
      .object({ hash: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(request.params);
    const artworkRoot = resolve(options.config.cacheRoot, "artwork");
    for (const [extension, mimeType] of [
      [".avif", "image/avif"],
      [".bmp", "image/bmp"],
      [".jpg", "image/jpeg"],
      [".png", "image/png"],
      [".tif", "image/tiff"],
      [".tiff", "image/tiff"],
      [".webp", "image/webp"],
      [".gif", "image/gif"],
    ] as const) {
      const path = join(artworkRoot, `${hash}${extension}`);
      try {
        await access(path, constants.R_OK);
        const [canonicalRoot, canonicalPath] = await Promise.all([
          realpath(artworkRoot),
          realpath(path),
        ]);
        const withinRoot = relative(canonicalRoot, canonicalPath);
        if (
          withinRoot === "" ||
          withinRoot.startsWith("..") ||
          isAbsolute(withinRoot) ||
          !(await stat(canonicalPath)).isFile()
        )
          continue;
        return reply
          .header("cache-control", "private, max-age=31536000, immutable")
          .header("x-content-type-options", "nosniff")
          .type(mimeType)
          .send(createReadStream(canonicalPath));
      } catch {
        // Try the next supported image extension.
      }
    }
    return reply
      .code(404)
      .send({ error: "ARTWORK_NOT_FOUND", message: "没有找到封面缓存" });
  });

  app.get("/api/v1/tracks/:id/listen", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { mode } = z
      .object({ mode: z.enum(["source", "browser"]).default("source") })
      .parse(request.query);
    const location = database.getMediaFileLocation(id);
    if (!location)
      return reply
        .code(404)
        .send({ error: "TRACK_NOT_FOUND", message: "没有找到这首曲目" });
    let path: string;
    try {
      const rootPath = await realpath(location.rootPath);
      const unresolved = resolve(rootPath, location.relativePath);
      const unresolvedRelative = relative(rootPath, unresolved);
      if (unresolvedRelative.startsWith("..") || isAbsolute(unresolvedRelative))
        throw new Error("track escaped library root");
      path = await realpath(unresolved);
      const resolvedRelative = relative(rootPath, path);
      if (resolvedRelative.startsWith("..") || isAbsolute(resolvedRelative))
        throw new Error("track symlink escaped library root");
      const information = await stat(path);
      if (!information.isFile()) throw new Error("track is not a regular file");
      if (mode === "browser" && isDsdPath(path)) {
        const child = spawn(
          options.config.ffmpegPath,
          [
            "-nostdin",
            "-v",
            "error",
            "-i",
            path,
            "-map",
            "0:a:0",
            "-vn",
            "-c:a",
            "flac",
            "-compression_level",
            "2",
            "-sample_fmt",
            "s32",
            "-ar",
            "176400",
            "-f",
            "flac",
            "pipe:1",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        request.raw.once("close", () => {
          if (child.exitCode === null) child.kill("SIGTERM");
        });
        child.stderr.on("data", (chunk) =>
          request.log.debug(
            { trackId: id, detail: String(chunk).slice(0, 300) },
            "DSD browser transcode diagnostic",
          ),
        );
        child.once("error", (spawnError) => {
          request.log.warn(
            { err: spawnError, trackId: id },
            "DSD browser transcode could not start",
          );
          child.stdout.destroy(spawnError);
        });
        return reply
          .headers({
            "cache-control": "private, no-store",
            "content-type": "audio/flac",
            "x-cocean-source-format": extname(path).slice(1).toUpperCase(),
            "x-cocean-playback-format": "PCM-FLAC-24-176.4",
            "x-content-type-options": "nosniff",
          })
          .send(child.stdout);
      }
      const mimeType = audioMimeType(path);
      const commonHeaders = {
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "content-type": mimeType,
        "x-content-type-options": "nosniff",
      };
      const range = request.headers.range;
      if (!range) {
        return reply
          .headers({
            ...commonHeaders,
            "content-length": String(information.size),
          })
          .send(createReadStream(path));
      }
      const parsed = parseByteRange(range, information.size);
      if (!parsed) {
        return reply
          .code(416)
          .header("content-range", `bytes */${information.size}`)
          .send();
      }
      return reply
        .code(206)
        .headers({
          ...commonHeaders,
          "content-length": String(parsed.end - parsed.start + 1),
          "content-range": `bytes ${parsed.start}-${parsed.end}/${information.size}`,
        })
        .send(createReadStream(path, parsed));
    } catch (error) {
      request.log.warn(
        { err: error, trackId: id },
        "listen source is unavailable or outside the library root",
      );
      return reply.code(404).send({
        error: "TRACK_SOURCE_UNAVAILABLE",
        message: "曲目源文件不可用或不在音乐目录内",
      });
    }
  });

  if (options.config.webRoot) {
    const webRoot = resolve(options.config.webRoot);
    await app.register(staticPlugin, { root: webRoot, wildcard: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "NOT_FOUND" });
    });
  }

  return app;
}

function deploymentRootView(
  root: z.infer<typeof coceanSettingsSchema>["libraryRoots"][number],
) {
  return {
    id: root.id,
    name: root.name,
    hostPathHint: root.hostPathHint,
    containerPath: root.containerPath,
    policy: root.policy,
    enabled: root.enabled,
  };
}

function handleArtworkDecisionError(
  error: unknown,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof AlbumArtworkDecisionError)
    return reply
      .code(error.code === "INVALID_ARTWORK_DECISION" ? 400 : 409)
      .send({ error: error.code, message: error.message });
  if (error instanceof ArtworkValidationError)
    return reply
      .code(error.statusCode)
      .send({ error: error.code, message: error.message });
  throw error;
}

function modelCompletionEndpoint(baseUrl: string): URL {
  return new URL(`${baseUrl.replace(/\/+$/, "")}/chat/completions`);
}

async function modelProviderErrorMessage(response: Response): Promise<string> {
  const fallback = `模型服务返回 HTTP ${response.status}`;
  const raw = (await response.text().catch(() => "")).slice(0, 2_000);
  if (!raw) return fallback;
  try {
    const payload = JSON.parse(raw) as {
      message?: unknown;
      error?: { message?: unknown } | string;
    };
    const detail =
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.error?.message === "string"
          ? payload.error.message
          : typeof payload.message === "string"
            ? payload.message
            : null;
    return detail ? `${fallback}：${detail.slice(0, 300)}` : fallback;
  } catch {
    return fallback;
  }
}

function modelNetworkErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError")
    return "模型连接超时，请检查 Base URL 与 NAS 外网连接";
  return "无法连接模型服务，请检查 Base URL、DNS 与 NAS 网络";
}

function parseByteRange(
  value: string,
  size: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size <= 0) return null;
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (!startText && !endText) return null;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(size - suffixLength, 0), end: size - 1 };
  }
  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  )
    return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function audioMimeType(path: string): string {
  return (
    (
      {
        ".flac": "audio/flac",
        ".wav": "audio/wav",
        ".wave": "audio/wav",
        ".aif": "audio/aiff",
        ".aiff": "audio/aiff",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".ogg": "audio/ogg",
        ".opus": "audio/ogg; codecs=opus",
        ".dsf": "audio/x-dsf",
        ".dff": "audio/x-dff",
      } as Record<string, string>
    )[extname(path).toLowerCase()] ?? "application/octet-stream"
  );
}

function isDsdPath(path: string): boolean {
  return [".dsf", ".dff"].includes(extname(path).toLowerCase());
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

declare module "fastify" {
  interface FastifyInstance {
    coceanDatabase: CoceanDatabase;
  }
}
