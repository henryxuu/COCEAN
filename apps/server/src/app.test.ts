import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CoceanDatabase } from "@cocean/database";
import { convertLegacyStillCore } from "@cocean/still-catalog";
import { buildApp } from "./app.js";
import { createSession } from "./auth.js";
import type { ServerConfig } from "./config.js";

const close: Array<() => Promise<void> | void> = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  for (const callback of close.splice(0).reverse()) await callback();
});

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    databasePath: ":memory:",
    musicRoot: "/path/that/does/not/exist",
    musicRootPolicy: "WATCH_ONLY",
    quarantineRoot: "/path/that/does/not/exist/quarantine",
    cacheRoot: "./cache",
    webRoot: null,
    musicBrainzEnabled: false,
    metadataContact: null,
    musicBrainzBaseUrl: "https://musicbrainz.org/ws/2/",
    stillCatalogPath: "/path/that/does/not/exist/still-catalog.json",
    authBootstrapFile: null,
    sessionTtlHours: 720,
    cookieSecure: false,
    credentialKeyPath: join(
      tmpdir(),
      `cocean-server-test-${process.pid}.credential-key`,
    ),
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    appleLookupEnabled: false,
    appleLookupBaseUrl: "https://itunes.apple.com/",
    externalLookupTimeoutMs: 8_000,
    demoData: false,
    logLevel: "silent",
    nodeEnv: "test",
    ...overrides,
  };
}

describe("COCEAN HTTP API", () => {
  it("issues and idempotently revokes a bounded file-only acceptance ADMIN session", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "cocean-acceptance-session-"),
    );
    close.push(() => rm(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "cocean.sqlite");
    const database = new CoceanDatabase(databasePath);
    const now = new Date().toISOString();
    const admin = {
      id: "acceptance-admin",
      username: "acceptance-admin",
      displayName: "Acceptance Admin",
      role: "ADMIN" as const,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };
    database.createUser(admin, "unused");
    const ordinary = createSession(database, admin, 24);
    database.close();
    const script = join(
      import.meta.dirname,
      "../container/acceptance-session.mjs",
    );
    const environment = {
      ...process.env,
      NODE_ENV: "test",
      COCEAN_ACCEPTANCE_SESSION_TEST_ROOT: directory,
    };
    await execFileAsync(process.execPath, [script, "issue"], {
      env: environment,
    });
    const cookiePath = join(directory, "acceptance/admin-session-cookie");
    expect((await stat(cookiePath)).mode & 0o777).toBe(0o600);
    const cookie = (await readFile(cookiePath, "utf8")).trim();
    expect(cookie).toMatch(/^cocean_session=[A-Za-z0-9_-]{43}$/);
    const token = cookie.slice("cocean_session=".length);
    let inspection = new CoceanDatabase(databasePath);
    const session = inspection.raw
      .prepare(
        `SELECT id,token_hash,expires_at,created_at FROM app_sessions
         WHERE id='cocean-acceptance-admin-session-v1'`,
      )
      .get() as {
      id: string;
      token_hash: string;
      expires_at: string;
      created_at: string;
    };
    expect(session.id).toBe("cocean-acceptance-admin-session-v1");
    expect(session.token_hash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(session.token_hash).not.toBe(token);
    expect(
      Date.parse(session.expires_at) - Date.parse(session.created_at),
    ).toBe(3 * 60 * 60 * 1000);
    inspection.close();

    await expect(
      execFileAsync(process.execPath, [script, "issue"], { env: environment }),
    ).rejects.toThrow();
    expect((await readFile(cookiePath, "utf8")).trim()).toBe(cookie);

    await writeFile(cookiePath, "corrupt-cookie\n", { mode: 0o600 });
    await execFileAsync(process.execPath, [script, "revoke"], {
      env: environment,
    });
    inspection = new CoceanDatabase(databasePath);
    expect(
      inspection.raw
        .prepare("SELECT COUNT(*) AS count FROM app_sessions WHERE id=?")
        .get("cocean-acceptance-admin-session-v1"),
    ).toEqual({ count: 0 });
    expect(
      inspection.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM app_sessions WHERE token_hash=?",
        )
        .get(createHash("sha256").update(ordinary.token).digest("hex")),
    ).toEqual({ count: 1 });
    inspection.close();

    await execFileAsync(process.execPath, [script, "issue"], {
      env: environment,
    });
    await rm(cookiePath);
    await execFileAsync(process.execPath, [script, "revoke"], {
      env: environment,
    });
    await expect(stat(cookiePath)).rejects.toMatchObject({ code: "ENOENT" });

    await execFileAsync(process.execPath, [script, "issue"], {
      env: environment,
    });
    const expiredCookie = (await readFile(cookiePath, "utf8")).trim();
    inspection = new CoceanDatabase(databasePath);
    inspection.raw
      .prepare("UPDATE app_sessions SET expires_at=? WHERE id=?")
      .run("2000-01-01T00:00:00.000Z", "cocean-acceptance-admin-session-v1");
    inspection.close();
    await execFileAsync(process.execPath, [script, "issue"], {
      env: environment,
    });
    expect((await readFile(cookiePath, "utf8")).trim()).not.toBe(expiredCookie);
    await execFileAsync(process.execPath, [script, "revoke"], {
      env: environment,
    });

    const concurrent = await Promise.allSettled([
      execFileAsync(process.execPath, [script, "issue"], { env: environment }),
      execFileAsync(process.execPath, [script, "issue"], { env: environment }),
    ]);
    expect(
      concurrent.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      concurrent.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await execFileAsync(process.execPath, [script, "revoke"], {
      env: environment,
    });
    await execFileAsync(process.execPath, [script, "revoke"], {
      env: environment,
    });
    const revoked = new CoceanDatabase(databasePath);
    expect(
      revoked.raw.prepare("SELECT COUNT(*) AS count FROM app_sessions").get(),
    ).toEqual({ count: 1 });
    revoked.close();
  });

  it("exposes an empty but valid library", async () => {
    const database = new CoceanDatabase(":memory:");
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const response = await app.inject({ method: "GET", url: "/api/v1/albums" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [],
      limit: 100,
      offset: 0,
      total: 0,
    });
  });

  it("filters grouped library albums by a concrete integrity issue", async () => {
    const database = new CoceanDatabase(":memory:");
    const base = {
      rootId: "music",
      title: "Shared Album",
      albumArtist: "Shared Artist",
      year: 2020,
      discCount: 1,
      fileIds: [],
      audioSummary: null,
      mixedAudioSpecs: false,
      artwork: {
        source: "SIDECAR" as const,
        url: "/cover.jpg",
        mimeType: "image/jpeg",
        width: 1000,
        height: 1000,
      },
      matchStatus: "NEEDS_REVIEW" as const,
    };
    database.replaceAlbumsForRoot("music", [
      { ...base, id: "shared-a", groupKey: "shared-a" },
      { ...base, id: "shared-b", groupKey: "shared-b" },
      {
        ...base,
        id: "healthy",
        groupKey: "healthy",
        title: "Healthy Album",
      },
    ]);
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/albums?issue=IDENTITY_OVERLAP",
    });
    expect(response.statusCode, response.body).toBe(200);
    const groupedAlbumId = response.json().items[0]?.id as string;
    expect(response.json()).toEqual(
      expect.objectContaining({
        total: 1,
        items: [
          expect.objectContaining({
            title: "Shared Album",
            versionCount: 2,
            issues: expect.arrayContaining([
              expect.objectContaining({ code: "IDENTITY_OVERLAP" }),
            ]),
          }),
        ],
      }),
    );

    const [legacyDetail, groupedDetail] = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/albums/shared-a" }),
      app.inject({
        method: "GET",
        url: `/api/v1/albums/${groupedAlbumId}`,
      }),
    ]);
    expect(legacyDetail.statusCode, legacyDetail.body).toBe(200);
    expect(groupedDetail.statusCode, groupedDetail.body).toBe(200);
    expect(legacyDetail.json().id).toBe(groupedAlbumId);
    expect(legacyDetail.json()).toEqual(groupedDetail.json());
  });

  it("exposes admin-only, idempotent identity governance with stable 400/409 contracts and member-readable history", async () => {
    const database = new CoceanDatabase(":memory:");
    database.replaceAlbumsForRoot("music", [
      {
        id: "govern-a",
        rootId: "music",
        groupKey: "govern-a",
        title: "Governed",
        albumArtist: "Artist",
        year: 2026,
        discCount: 1,
        fileIds: [],
        audioSummary: null,
        mixedAudioSpecs: false,
        artwork: {
          source: "NONE",
          url: null,
          mimeType: null,
          width: null,
          height: null,
        },
      },
      {
        id: "govern-b",
        rootId: "music",
        groupKey: "govern-b",
        title: "Governed",
        albumArtist: "Artist",
        year: 2026,
        discCount: 1,
        fileIds: [],
        audioSummary: null,
        mixedAudioSpecs: false,
        artwork: {
          source: "NONE",
          url: null,
          mimeType: null,
          width: null,
          height: null,
        },
      },
    ]);
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const albumId = database.getAlbumSummary("govern-a")!.id;
    const memberCookie = sessionCookieFor(database, "MEMBER");
    const admin = adminCookie(database);
    const payload = {
      type: "CONFIRM",
      requestId: "server-confirm",
      revision: 0,
      primaryVersionId: "govern-a",
    };
    const memberWrite = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${albumId}/identity-decisions`,
      headers: { cookie: memberCookie },
      payload,
    });
    expect(memberWrite.statusCode).toBe(403);
    expect(database.getAlbumSummary(albumId)!.revision).toBe(0);
    const anonymousHistory = await app.inject({
      method: "GET",
      url: `/api/v1/albums/${albumId}/identity-decisions`,
    });
    expect(anonymousHistory.statusCode).toBe(401);

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${albumId}/identity-decisions`,
      headers: { cookie: admin },
      payload,
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json().decision).toEqual(
      expect.objectContaining({
        type: "CONFIRM",
        actor: expect.objectContaining({ displayName: "Test Admin" }),
      }),
    );
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${albumId}/identity-decisions`,
      headers: { cookie: admin },
      payload,
    });
    expect(replay.json().decision.id).toBe(confirmed.json().decision.id);
    const requestIdCollision = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${albumId}/identity-decisions`,
      headers: { cookie: admin },
      payload: {
        ...payload,
        primaryVersionId: "govern-b",
      },
    });
    expect(requestIdCollision.statusCode).toBe(409);
    expect(requestIdCollision.json()).toEqual(
      expect.objectContaining({
        error: "IDENTITY_DECISION_CONFLICT",
        message: expect.stringContaining("requestId"),
      }),
    );
    const crossEntrypointCollision = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${albumId}/identity-decisions/${confirmed.json().decision.id}/undo`,
      headers: { cookie: admin },
      payload: { requestId: payload.requestId, revision: 1 },
    });
    expect(crossEntrypointCollision.statusCode).toBe(409);
    expect(crossEntrypointCollision.json().message).toContain("requestId");

    const stale = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${albumId}/identity-decisions`,
      headers: { cookie: admin },
      payload: {
        type: "SET_PRIMARY",
        requestId: "server-stale",
        revision: 0,
        primaryVersionId: "govern-b",
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("IDENTITY_DECISION_CONFLICT");
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${albumId}/identity-decisions`,
      headers: { cookie: admin },
      payload: {
        type: "SPLIT",
        requestId: "server-invalid-split",
        revision: 1,
        partitions: [
          { versionIds: ["govern-a"] },
          { versionIds: ["govern-a"] },
        ],
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("INVALID_IDENTITY_DECISION");
    const oversized = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${albumId}/identity-decisions`,
      headers: { cookie: admin },
      payload: {
        type: "SPLIT",
        requestId: "server-oversized-split",
        revision: 1,
        partitions: [
          {
            versionIds: Array.from({ length: 101 }, (_, index) => `v-${index}`),
          },
          { versionIds: ["govern-a"] },
        ],
      },
    });
    expect(oversized.statusCode).toBe(400);

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/albums/${albumId}/identity-decisions`,
      headers: { cookie: memberCookie },
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().items).toEqual([
      expect.objectContaining({
        id: confirmed.json().decision.id,
        canUndo: true,
      }),
    ]);
    const undone = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${albumId}/identity-decisions/${confirmed.json().decision.id}/undo`,
      headers: { cookie: admin },
      payload: { requestId: "server-undo", revision: 1 },
    });
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json().decision.type).toBe("UNDO");
    const repeatedUndo = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${albumId}/identity-decisions/${confirmed.json().decision.id}/undo`,
      headers: { cookie: admin },
      payload: {
        requestId: "server-undo-again",
        revision: undone.json().decision.resultingRevision,
      },
    });
    expect(repeatedUndo.statusCode).toBe(409);
  });

  it("exposes atomic admin metadata governance with member-readable provenance and stable conflicts", async () => {
    const database = new CoceanDatabase(":memory:");
    database.replaceAlbumsForRoot("music", [
      {
        id: "metadata-http",
        rootId: "music",
        groupKey: "metadata-http",
        title: "Observed",
        albumArtist: "Artist",
        year: 2000,
        discCount: 1,
        fileIds: [],
        audioSummary: null,
        mixedAudioSpecs: false,
        artwork: {
          source: "NONE",
          url: null,
          mimeType: null,
          width: null,
          height: null,
        },
      },
    ]);
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const albumId = database.getAlbumSummary("metadata-http")!.id;
    const member = sessionCookieFor(database, "MEMBER");
    const admin = adminCookie(database);
    const anonymous = await app.inject({
      method: "GET",
      url: `/api/v1/albums/${albumId}/metadata-history`,
    });
    expect(anonymous.statusCode).toBe(401);
    const memberMetadata = await app.inject({
      method: "GET",
      url: `/api/v1/albums/${albumId}/metadata`,
      headers: { cookie: member },
    });
    expect(memberMetadata.statusCode, memberMetadata.body).toBe(200);
    expect(memberMetadata.json().album.title.observed.value).toBe("Observed");
    const anonymousDetail = await app.inject({
      method: "GET",
      url: `/api/v1/albums/${albumId}`,
    });
    expect(anonymousDetail.statusCode).toBe(200);
    expect(anonymousDetail.json().metadata).toBeUndefined();
    const memberDetail = await app.inject({
      method: "GET",
      url: `/api/v1/albums/${albumId}`,
      headers: { cookie: member },
    });
    expect(memberDetail.json().metadata.album.title.observed.value).toBe(
      "Observed",
    );
    const memberWrite = await app.inject({
      method: "PATCH",
      url: `/api/v1/albums/${albumId}/metadata`,
      headers: { cookie: member },
      payload: {
        requestId: "member-metadata-write",
        expectedMetadataRevision: 0,
        commands: [{ action: "SET", field: "title", value: "Denied" }],
      },
    });
    expect(memberWrite.statusCode).toBe(403);
    const invalid = await app.inject({
      method: "PATCH",
      url: `/api/v1/albums/${albumId}/metadata`,
      headers: { cookie: admin },
      payload: {
        requestId: "invalid-metadata-write",
        expectedMetadataRevision: 0,
        commands: [
          { action: "SET", field: "title", value: "Must Roll Back" },
          {
            action: "SET",
            field: "barcode",
            versionId: "metadata-http",
            value: "123",
          },
        ],
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(database.getAlbum(albumId)?.title).toBe("Observed");
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/albums/${albumId}/metadata`,
      headers: { cookie: admin },
      payload: {
        requestId: "valid-metadata-write",
        expectedMetadataRevision: 0,
        commands: [
          { action: "SET", field: "title", value: "Curated" },
          { action: "CLEAR", field: "year" },
        ],
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().metadata).toEqual(
      expect.objectContaining({ metadataRevision: 1 }),
    );
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/albums/${albumId}/metadata`,
      headers: { cookie: admin },
      payload: {
        requestId: "stale-metadata-write",
        expectedMetadataRevision: 0,
        commands: [{ action: "SET", field: "title", value: "Stale" }],
      },
    });
    expect(stale.statusCode).toBe(409);
    const history = await app.inject({
      method: "GET",
      url: `/api/v1/albums/${albumId}/metadata-history`,
      headers: { cookie: member },
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().items).toEqual([
      expect.objectContaining({ type: "UPDATE", canUndo: true }),
    ]);
    const eventId = history.json().items[0].id as string;
    const undone = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${albumId}/metadata-history/${eventId}/undo`,
      headers: { cookie: admin },
      payload: {
        requestId: "undo-metadata-write",
        expectedMetadataRevision: 1,
      },
    });
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json().metadata.album.title.effectiveValue).toBe("Observed");
  });

  it("exposes authenticated artwork selection, validated upload, CAA import and append-only undo", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-artwork-http-"));
    const imagePath = join(root, "front.png");
    await execFileAsync("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=40x30",
      "-frames:v",
      "1",
      imagePath,
    ]);
    const image = await readFile(imagePath);
    const database = new CoceanDatabase(":memory:");
    database.replaceAlbumsForRoot("music", [
      {
        id: "artwork-http",
        rootId: "music",
        groupKey: "artwork-http",
        title: "Artwork",
        albumArtist: "Artist",
        year: 2026,
        discCount: 1,
        fileIds: [],
        audioSummary: null,
        mixedAudioSpecs: false,
        artwork: {
          source: "NONE",
          url: null,
          mimeType: null,
          width: null,
          height: null,
        },
      },
    ]);
    database.raw
      .prepare(
        `UPDATE albums SET match_status='USER_CONFIRMED',musicbrainz_release_id=?
         WHERE id='artwork-http'`,
      )
      .run("123e4567-e89b-42d3-a456-426614174000");
    const app = await buildApp({
      config: testConfig({
        cacheRoot: root,
        musicBrainzEnabled: true,
        metadataContact: "https://example.test/cocean",
      }),
      database,
      artworkFetch: async () =>
        new Response(image, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    });
    close.push(
      () => app.close(),
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    );
    const albumId = database.getAlbumSummary("artwork-http")!.id;
    expect(database.getAlbumArtworkGovernance(albumId)).toEqual(
      expect.objectContaining({ artworkRevision: 0, candidates: [] }),
    );
    const member = sessionCookieFor(database, "MEMBER");
    const admin = adminCookie(database);
    const anonymousDetail = await app.inject({
      method: "GET",
      url: `/api/v1/albums/${albumId}`,
    });
    expect(anonymousDetail.json().artworkGovernance).toBeUndefined();
    expect(anonymousDetail.json().artworkRevision).toBeUndefined();
    const memberArtwork = await app.inject({
      method: "GET",
      url: `/api/v1/albums/${albumId}/artwork`,
      headers: { cookie: member },
    });
    expect(memberArtwork.statusCode, memberArtwork.body).toBe(200);
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${albumId}/artwork/upload`,
      headers: {
        cookie: member,
        "content-type": "multipart/form-data; boundary=cocean-boundary",
      },
      payload: artworkMultipart("cocean-boundary", "member-upload", 0, image),
    });
    expect(denied.statusCode).toBe(403);
    const uploadPayload = artworkMultipart(
      "cocean-boundary",
      "artwork-upload",
      0,
      image,
    );
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${albumId}/artwork/upload`,
      headers: {
        cookie: admin,
        "content-type": "multipart/form-data; boundary=cocean-boundary",
      },
      payload: uploadPayload,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.json()).toEqual(
      expect.objectContaining({
        artwork: expect.objectContaining({
          artworkRevision: 1,
          selectionSource: "USER_SELECTED",
        }),
        event: expect.objectContaining({ type: "UPLOAD" }),
      }),
    );
    const artworkUrl = uploaded.json().artwork.effectiveArtwork.url as string;
    const imageResponse = await app.inject({ method: "GET", url: artworkUrl });
    expect(imageResponse.statusCode).toBe(200);
    expect(imageResponse.headers["content-type"]).toContain("image/png");
    expect(imageResponse.headers["x-content-type-options"]).toBe("nosniff");
    const imported = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${albumId}/artwork/import/musicbrainz`,
      headers: { cookie: admin },
      payload: {
        localVersionId: "artwork-http",
        requestId: "artwork-import",
        expectedArtworkRevision: 1,
      },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json().event.type).toBe("IMPORT");
    const history = await app.inject({
      method: "GET",
      url: `/api/v1/albums/${albumId}/artwork-history`,
      headers: { cookie: member },
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().items).toHaveLength(2);
    const importEventId = imported.json().event.id as string;
    const undone = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${albumId}/artwork-history/${importEventId}/undo`,
      headers: { cookie: admin },
      payload: {
        requestId: "artwork-undo",
        expectedArtworkRevision: 2,
      },
    });
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json().event.type).toBe("UNDO");
    expect(undone.json().artwork.artworkRevision).toBe(3);
  });

  it("queues a read-only library scan", async () => {
    const database = new CoceanDatabase(":memory:");
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/scans",
      payload: { rootId: "music", mode: "FULL" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(
      expect.objectContaining({
        rootId: "music",
        mode: "FULL",
        triggerSource: "MANUAL",
        status: "QUEUED",
      }),
    );
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v1/scans/${response.json().id}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toEqual(
      expect.objectContaining({ status: "CANCELLED" }),
    );
  });

  it("retries a failed scan with an auditable source and the same root mutex", async () => {
    const database = new CoceanDatabase(":memory:");
    database.createScanJob({
      id: "failed-scan",
      rootId: "music",
      mode: "INCREMENTAL",
      triggerSource: "AUTO_DISCOVERY",
      retryOfScanJobId: null,
      status: "QUEUED",
      totalFiles: 0,
      processedFiles: 0,
      parsedFiles: 0,
      failedFiles: 0,
      reusedFiles: 0,
      stableAlbumDirectories: 0,
      deferredAlbumDirectories: 0,
      createdAt: "2026-08-12T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      error: null,
      cancelRequestedAt: null,
    });
    database.claimNextScanJob();
    database.finishScanJob("failed-scan", "NAS unavailable");
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );

    const retried = await app.inject({
      method: "POST",
      url: "/api/v1/scans/failed-scan/retry",
    });
    expect(retried.statusCode, retried.body).toBe(202);
    expect(retried.json()).toEqual(
      expect.objectContaining({
        rootId: "music",
        mode: "INCREMENTAL",
        triggerSource: "RETRY",
        retryOfScanJobId: "failed-scan",
      }),
    );
    expect(database.scanRequiresAlbumStability(retried.json().id)).toBe(true);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/scans/failed-scan/retry",
    });
    expect(duplicate.statusCode).toBe(409);
    expect(database.listScanJobs()).toHaveLength(2);
  });

  it("bootstraps the first owner, signs in with a Session and manages local accounts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-auth-"));
    close.push(() => rm(directory, { recursive: true, force: true }));
    const secret = join(directory, "owner");
    const ownerPassword = "a-strong-owner-password";
    await writeFile(secret, `owner:${ownerPassword}\n`, { mode: 0o600 });
    const database = new CoceanDatabase(":memory:");
    const app = await buildApp({
      config: testConfig({
        authBootstrapFile: secret,
        credentialKeyPath: join(directory, "credential.key"),
        nodeEnv: "production",
      }),
      database,
    });
    close.push(
      () => app.close(),
      () => database.close(),
    );

    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "owner", password: "not-the-password" },
    });
    expect(wrong.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "owner", password: ownerPassword },
    });
    expect(login.statusCode, login.body).toBe(200);
    const setCookie = String(login.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain(ownerPassword);
    const cookie = setCookie.split(";", 1)[0]!;
    expect(database.getUserByUsername("owner")?.passwordHash).toMatch(
      /^scrypt\$/,
    );
    expect(database.getUserByUsername("owner")?.passwordHash).not.toContain(
      ownerPassword,
    );

    const session = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().user).toEqual(
      expect.objectContaining({ username: "owner", role: "ADMIN" }),
    );

    const member = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: { cookie },
      payload: {
        username: "listener",
        displayName: "Listener",
        password: "listener-password-2026",
        role: "MEMBER",
      },
    });
    expect(member.statusCode, member.body).toBe(201);
    expect(member.json()).toEqual(
      expect.objectContaining({ username: "listener", role: "MEMBER" }),
    );

    const model = await app.inject({
      method: "PUT",
      url: "/api/v1/model/configuration",
      headers: { cookie },
      payload: {
        enabled: true,
        baseUrl: "https://api.openai.com/v1",
        model: "test-model",
        apiKey: "private-test-api-key",
      },
    });
    expect(model.statusCode, model.body).toBe(200);
    expect(model.json()).toEqual(
      expect.objectContaining({
        enabled: true,
        model: "test-model",
        apiKeyConfigured: true,
      }),
    );
    expect(database.getStoredModelConfiguration().credentialJson).not.toContain(
      "private-test-api-key",
    );

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie },
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/auth/session",
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("verifies a saved OpenAI-compatible model and exposes the real connection state", async () => {
    const database = new CoceanDatabase(":memory:");
    let requestBody: Record<string, unknown> | null = null;
    const app = await buildApp({
      config: testConfig(),
      database,
      modelFetch: async (input, init) => {
        expect(input.toString()).toBe(
          "https://models.example.test/v1/chat/completions",
        );
        expect(init.headers).toEqual(
          expect.objectContaining({
            authorization: "Bearer private-model-key",
          }),
        );
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "OK" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const cookie = adminCookie(database);
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/model/configuration",
      headers: { cookie },
      payload: {
        enabled: true,
        baseUrl: "https://models.example.test/v1/",
        model: "verified-model",
        apiKey: "private-model-key",
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toEqual(
      expect.objectContaining({ verificationStatus: "UNVERIFIED" }),
    );

    const verified = await app.inject({
      method: "POST",
      url: "/api/v1/model/configuration/verify",
      headers: { cookie },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json()).toEqual(
      expect.objectContaining({
        model: "verified-model",
        verificationStatus: "VERIFIED",
        verificationMessage: "连接正常",
        lastCheckedAt: expect.any(String),
      }),
    );
    expect(requestBody).toEqual(
      expect.objectContaining({ model: "verified-model", max_tokens: 1 }),
    );
    const capabilities = await app.inject({
      method: "GET",
      url: "/api/v1/capabilities",
    });
    expect(capabilities.json().model).toEqual(
      expect.objectContaining({
        enabled: true,
        configured: true,
        verified: true,
        verificationStatus: "VERIFIED",
      }),
    );
  });

  it("pages every scan failure for full-library acceptance reports", async () => {
    const database = new CoceanDatabase(":memory:");
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    database.createScanJob({
      id: "scan-failures",
      rootId: "music",
      mode: "FULL",
      status: "COMPLETED_WITH_WARNINGS",
      totalFiles: 2,
      processedFiles: 2,
      parsedFiles: 0,
      failedFiles: 2,
      reusedFiles: 0,
      createdAt: "2026-08-12T00:00:00.000Z",
      startedAt: "2026-08-12T00:00:01.000Z",
      finishedAt: "2026-08-12T00:00:02.000Z",
      error: null,
      cancelRequestedAt: null,
    });
    for (const [index, code] of [
      "METADATA_PARSE_FAILED",
      "UNSUPPORTED_MEDIA",
    ].entries()) {
      database.recordScanFailure({
        scanJobId: "scan-failures",
        rootId: "music",
        relativePath: `Artist/Album/${index + 1}.flac`,
        code,
        stage: "probe",
        message: code,
        recoverable: true,
      });
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/scans/scan-failures/failures?limit=1&offset=1",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        expect.objectContaining({
          code: "UNSUPPORTED_MEDIA",
          relativePath: "Artist/Album/2.flac",
        }),
      ],
      limit: 1,
      offset: 1,
      total: 2,
    });
  });

  it("serves a frozen scan report and paged file-result ledger", async () => {
    const database = new CoceanDatabase(":memory:");
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    database.createScanJob({
      id: "scan-report",
      rootId: "music",
      mode: "FULL",
      status: "RUNNING",
      totalFiles: 0,
      processedFiles: 0,
      parsedFiles: 0,
      failedFiles: 0,
      reusedFiles: 0,
      createdAt: "2026-08-12T00:00:00.000Z",
      startedAt: "2026-08-12T00:00:01.000Z",
      finishedAt: null,
      error: null,
      cancelRequestedAt: null,
    });
    database.recordScanDiscovery({
      scanJobId: "scan-report",
      rulesVersion: "server-test/1",
      candidates: 1,
      regularFiles: 2,
      auxiliaryFiles: 1,
      ignoredFiles: 0,
      skippedSymlinks: 0,
      traversalErrors: 0,
    });
    database.recordScanFileResult({
      scanJobId: "scan-report",
      rootId: "music",
      relativePath: "Artist/Album/SACD.iso",
      extension: ".iso",
      candidateKind: "KNOWN_UNSUPPORTED_AUDIO",
      outcome: "UNSUPPORTED",
      mediaFileId: null,
      sizeBytes: null,
      modifiedAtMs: null,
      errorCode: "UNSUPPORTED_MEDIA",
      errorStage: "discover",
      warningCodes: [],
    });
    database.finalizeSuccessfulScan({
      scanJobId: "scan-report",
      rootId: "music",
      stagedFiles: [],
      seenRelativePaths: ["Artist/Album/SACD.iso"],
      albums: [],
      withWarnings: true,
    });

    const report = await app.inject({
      method: "GET",
      url: "/api/v1/scans/scan-report/report",
    });
    expect(report.statusCode, report.body).toBe(200);
    expect(report.json()).toEqual(
      expect.objectContaining({
        rulesVersion: "server-test/1",
        candidates: 1,
        processed: 1,
        parsed: 0,
        unsupported: 1,
        failed: 0,
        auxiliaryFiles: 1,
        summaryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        invariants: expect.objectContaining({ valid: true }),
      }),
    );
    const files = await app.inject({
      method: "GET",
      url: "/api/v1/scans/scan-report/files?limit=1&offset=0&outcome=UNSUPPORTED",
    });
    expect(files.statusCode, files.body).toBe(200);
    expect(files.json()).toEqual({
      items: [
        expect.objectContaining({
          relativePath: "Artist/Album/SACD.iso",
          candidateKind: "KNOWN_UNSUPPORTED_AUDIO",
          outcome: "UNSUPPORTED",
        }),
      ],
      limit: 1,
      offset: 0,
      total: 1,
    });
  });

  it("serves the private inventory report only to ADMIN and distinguishes 404 from 409", async () => {
    const database = new CoceanDatabase(":memory:");
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    database.createScanJob({
      id: "inventory-ready",
      rootId: "music",
      mode: "FULL",
      status: "RUNNING",
      totalFiles: 0,
      processedFiles: 0,
      parsedFiles: 0,
      failedFiles: 0,
      reusedFiles: 0,
      createdAt: "2026-08-16T00:00:00.000Z",
      startedAt: "2026-08-16T00:00:00.000Z",
      finishedAt: null,
      error: null,
      cancelRequestedAt: null,
    });
    const inventoryFile = {
      absolutePath: "/library/private/Artist/Inventory/01 Secret.flac",
      relativePath: "Artist/Inventory/01 Secret.flac",
      extension: ".flac",
      sizeBytes: 10,
      modifiedAtMs: 1,
      audio: {
        kind: "PCM" as const,
        codec: "flac",
        container: "flac",
        lossless: true,
        bitDepth: 24,
        sampleRate: 96_000,
        bitrate: null,
        channels: 2,
        dsdRate: null,
      },
      durationSeconds: 1,
      tags: {
        album: "Inventory",
        albumArtist: "Artist",
        title: "Secret",
        artists: ["Artist"],
        year: 2026,
        date: "2026",
        genre: [],
        composer: [],
        label: [],
        catalogNumber: null,
        barcode: null,
        musicBrainzReleaseId: null,
        discNumber: 1,
        discTotal: 1,
        trackNumber: 1,
        trackTotal: 1,
      },
      artwork: [],
      warnings: [],
    };
    database.recordScanDiscovery({
      scanJobId: "inventory-ready",
      rulesVersion: "inventory-api/1",
      candidates: 1,
      regularFiles: 1,
      auxiliaryFiles: 0,
      ignoredFiles: 0,
      skippedSymlinks: 0,
      traversalErrors: 0,
    });
    database.recordScanFileResult({
      scanJobId: "inventory-ready",
      rootId: "music",
      relativePath: inventoryFile.relativePath,
      extension: ".flac",
      candidateKind: "SUPPORTED_AUDIO",
      outcome: "PARSED",
      mediaFileId: "inventory-media-stable-id",
      sizeBytes: inventoryFile.sizeBytes,
      modifiedAtMs: inventoryFile.modifiedAtMs,
      errorCode: null,
      errorStage: null,
      warningCodes: [],
    });
    database.finalizeSuccessfulScan({
      scanJobId: "inventory-ready",
      rootId: "music",
      stagedFiles: [{ id: "inventory-media-stable-id", file: inventoryFile }],
      seenRelativePaths: [inventoryFile.relativePath],
      albums: [
        {
          id: "inventory-version-stable-id",
          rootId: "music",
          groupKey: "inventory-version-stable-id",
          title: "Inventory",
          albumArtist: "Artist",
          year: 2026,
          discCount: 1,
          fileIds: ["inventory-media-stable-id"],
          audioSummary: null,
          mixedAudioSpecs: false,
          artwork: {
            source: "NONE",
            url: null,
            mimeType: null,
            width: null,
            height: null,
          },
          matchStatus: "NEEDS_REVIEW",
          aggregationIssues: [],
        },
      ],
      withWarnings: false,
    });
    database.createScanJob({
      id: "inventory-running",
      rootId: "music",
      mode: "FULL",
      status: "QUEUED",
      totalFiles: 0,
      processedFiles: 0,
      parsedFiles: 0,
      failedFiles: 0,
      reusedFiles: 0,
      createdAt: "2026-08-16T00:01:00.000Z",
      startedAt: null,
      finishedAt: null,
      error: null,
      cancelRequestedAt: null,
    });
    const admin = adminCookie(database);
    const member = sessionCookieFor(database, "MEMBER");
    const url = "/api/v1/library/inventory-report?scanJobId=inventory-ready";
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url, headers: { cookie: member } }))
        .statusCode,
    ).toBe(403);
    const response = await app.inject({
      method: "GET",
      url,
      headers: { cookie: admin },
    });
    expect(response.statusCode, response.body).toBe(200);
    const inventory = response.json();
    expect(inventory).toEqual(
      expect.objectContaining({
        schema: "cocean.library-inventory/v1",
        scanJobId: "inventory-ready",
        findings: [],
        valid: true,
      }),
    );
    expect(inventory.versions).toHaveLength(1);
    expect(inventory.versions[0]).toEqual(
      expect.objectContaining({
        localVersionId: "inventory-version-stable-id",
        mediaFileIds: ["inventory-media-stable-id"],
      }),
    );
    expect(inventory.versions[0].localVersionId).not.toBe("");
    expect(inventory.versions[0].libraryAlbumId).not.toBe("");
    expect(inventory.versions[0].mediaFileIds[0]).not.toBe("");
    expect(response.body).not.toContain("/library/");
    expect(response.body).not.toMatch(/cookie|token|password/i);
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/library/inventory-report?scanJobId=missing",
      headers: { cookie: admin },
    });
    expect(missing.statusCode).toBe(404);
    const pending = await app.inject({
      method: "GET",
      url: "/api/v1/library/inventory-report?scanJobId=inventory-running",
      headers: { cookie: admin },
    });
    expect(pending.statusCode).toBe(409);
    expect(database.claimNextScanJob()?.id).toBe("inventory-running");
    database.recordScanDiscovery({
      scanJobId: "inventory-running",
      rulesVersion: "inventory-api/1",
      candidates: 0,
      regularFiles: 0,
      auxiliaryFiles: 0,
      ignoredFiles: 0,
      skippedSymlinks: 0,
      traversalErrors: 0,
    });
    database.finalizeSuccessfulScan({
      scanJobId: "inventory-running",
      rootId: "music",
      stagedFiles: [],
      seenRelativePaths: [],
      albums: [],
      withWarnings: false,
    });
    const superseded = await app.inject({
      method: "GET",
      url,
      headers: { cookie: admin },
    });
    expect(superseded.statusCode).toBe(409);
    expect(superseded.json()).toEqual(
      expect.objectContaining({ error: "SCAN_NOT_AUTHORITATIVE" }),
    );
  });

  it("keeps orphan preview and confirm ADMIN-only and gives MEMBER a redacted history", async () => {
    const database = new CoceanDatabase(":memory:");
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    database.createScanJob({
      id: "orphan-api-scan",
      rootId: "physical",
      mode: "FULL",
      status: "RUNNING",
      totalFiles: 0,
      processedFiles: 0,
      parsedFiles: 0,
      failedFiles: 0,
      reusedFiles: 0,
      createdAt: "2026-08-16T00:00:00.000Z",
      startedAt: "2026-08-16T00:00:00.000Z",
      finishedAt: null,
      error: null,
      cancelRequestedAt: null,
    });
    database.recordScanDiscovery({
      scanJobId: "orphan-api-scan",
      rulesVersion: "orphan-api/1",
      candidates: 0,
      regularFiles: 0,
      auxiliaryFiles: 0,
      ignoredFiles: 0,
      skippedSymlinks: 0,
      traversalErrors: 0,
    });
    database.finalizeSuccessfulScan({
      scanJobId: "orphan-api-scan",
      rootId: "physical",
      stagedFiles: [],
      seenRelativePaths: [],
      albums: [],
      withWarnings: false,
    });
    database.createPhysicalOnlyAlbum({
      id: "orphan-api-version",
      groupKey: "orphan-api-version",
      title: "API Orphan",
      albumArtist: "Artist",
      year: null,
    });
    database.raw
      .prepare("DELETE FROM library_issues WHERE album_id=?")
      .run("orphan-api-version");
    const previewUrl =
      "/api/v1/local-versions/orphan-api-version/orphan-governance/preview";
    const confirmUrl =
      "/api/v1/local-versions/orphan-api-version/orphan-governance/confirm";
    const historyUrl =
      "/api/v1/local-versions/orphan-api-version/orphan-governance/history";
    const admin = adminCookie(database);
    const member = sessionCookieFor(database, "MEMBER");
    const body = { localVersionId: "orphan-api-version" };
    expect(
      (await app.inject({ method: "POST", url: previewUrl, payload: body }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: previewUrl,
          headers: { cookie: member },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    const previewResponse = await app.inject({
      method: "POST",
      url: previewUrl,
      headers: { cookie: admin },
      payload: body,
    });
    expect(previewResponse.statusCode, previewResponse.body).toBe(200);
    const preview = previewResponse.json();
    expect(preview).toEqual(
      expect.objectContaining({
        action: "CLOSE_ORPHAN_IDENTITY",
        executable: true,
        expectedFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(previewResponse.body).not.toContain("/library/");
    const crossResource = await app.inject({
      method: "POST",
      url: "/api/v1/local-versions/a-different-version/orphan-governance/preview",
      headers: { cookie: admin },
      payload: body,
    });
    expect(crossResource.statusCode).toBe(409);
    expect(crossResource.json()).toEqual(
      expect.objectContaining({ error: "ORPHAN_RESOURCE_MISMATCH" }),
    );
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/local-versions/missing-version/orphan-governance/preview",
      headers: { cookie: admin },
      payload: { localVersionId: "missing-version" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(
      expect.objectContaining({ error: "ORPHAN_TARGET_NOT_FOUND" }),
    );

    const confirmPayload = {
      requestId: "orphan-api-request",
      action: preview.action,
      expectedFingerprint: preview.expectedFingerprint,
      scanJobId: preview.expected.scanJobId,
      localVersionId: "orphan-api-version",
      expected: preview.expected,
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: confirmUrl,
          payload: confirmPayload,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: confirmUrl,
          headers: { cookie: member },
          payload: confirmPayload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM library_orphan_governance_events",
        )
        .get(),
    ).toEqual({ count: 0 });
    const mismatchedConfirm = await app.inject({
      method: "POST",
      url: "/api/v1/local-versions/a-different-version/orphan-governance/confirm",
      headers: { cookie: admin },
      payload: confirmPayload,
    });
    expect(mismatchedConfirm.statusCode).toBe(409);
    expect(mismatchedConfirm.json()).toEqual(
      expect.objectContaining({ error: "ORPHAN_RESOURCE_MISMATCH" }),
    );
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM library_orphan_governance_events",
        )
        .get(),
    ).toEqual({ count: 0 });
    const confirmResponse = await app.inject({
      method: "POST",
      url: confirmUrl,
      headers: { cookie: admin },
      payload: confirmPayload,
    });
    expect(confirmResponse.statusCode, confirmResponse.body).toBe(200);
    expect(confirmResponse.json()).toEqual(
      expect.objectContaining({ status: "APPLIED" }),
    );

    expect(
      (await app.inject({ method: "GET", url: historyUrl })).statusCode,
    ).toBe(401);
    const memberHistory = await app.inject({
      method: "GET",
      url: historyUrl,
      headers: { cookie: member },
    });
    expect(memberHistory.statusCode, memberHistory.body).toBe(200);
    expect(memberHistory.json().items[0]).toEqual(
      expect.objectContaining({ status: "APPLIED" }),
    );
    expect(memberHistory.body).not.toMatch(
      /actor|requestId|expectedFingerprint|before|after|NO_CURRENT_FACT/,
    );
    const adminHistory = await app.inject({
      method: "GET",
      url: historyUrl,
      headers: { cookie: admin },
    });
    expect(adminHistory.statusCode, adminHistory.body).toBe(200);
    expect(adminHistory.json().items[0]).toEqual(
      expect.objectContaining({
        requestId: "orphan-api-request",
        actor: expect.objectContaining({ id: expect.any(String) }),
      }),
    );
  });

  it("audits a version-scoped confirm when its target disappeared", async () => {
    const database = new CoceanDatabase(":memory:");
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    database.createScanJob({
      id: "disappeared-api-scan",
      rootId: "physical",
      mode: "FULL",
      status: "RUNNING",
      totalFiles: 0,
      processedFiles: 0,
      parsedFiles: 0,
      failedFiles: 0,
      reusedFiles: 0,
      createdAt: "2026-08-16T00:00:00.000Z",
      startedAt: "2026-08-16T00:00:00.000Z",
      finishedAt: null,
      error: null,
      cancelRequestedAt: null,
    });
    database.recordScanDiscovery({
      scanJobId: "disappeared-api-scan",
      rulesVersion: "orphan-api/1",
      candidates: 0,
      regularFiles: 0,
      auxiliaryFiles: 0,
      ignoredFiles: 0,
      skippedSymlinks: 0,
      traversalErrors: 0,
    });
    database.finalizeSuccessfulScan({
      scanJobId: "disappeared-api-scan",
      rootId: "physical",
      stagedFiles: [],
      seenRelativePaths: [],
      albums: [],
      withWarnings: false,
    });
    database.createPhysicalOnlyAlbum({
      id: "disappeared-api-version",
      groupKey: "disappeared-api-version",
      title: "Disappeared",
      albumArtist: "Artist",
      year: null,
    });
    database.raw
      .prepare(
        "DELETE FROM library_issues WHERE album_id='disappeared-api-version'",
      )
      .run();
    const cookie = adminCookie(database);
    const preview = (
      await app.inject({
        method: "POST",
        url: "/api/v1/local-versions/disappeared-api-version/orphan-governance/preview",
        headers: { cookie },
        payload: { localVersionId: "disappeared-api-version" },
      })
    ).json();
    database.raw
      .prepare(
        "DELETE FROM library_album_members WHERE album_id='disappeared-api-version'",
      )
      .run();
    database.raw
      .prepare("DELETE FROM albums WHERE id='disappeared-api-version'")
      .run();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/local-versions/disappeared-api-version/orphan-governance/confirm",
      headers: { cookie },
      payload: {
        requestId: "disappeared-api-request",
        action: preview.action,
        expectedFingerprint: preview.expectedFingerprint,
        scanJobId: preview.expected.scanJobId,
        localVersionId: "disappeared-api-version",
        expected: preview.expected,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(
      expect.objectContaining({
        error: "ORPHAN_TARGET_NOT_FOUND",
        result: expect.objectContaining({ status: "REJECTED" }),
      }),
    );
    const history = await app.inject({
      method: "GET",
      url: "/api/v1/local-versions/disappeared-api-version/orphan-governance/history",
      headers: { cookie },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().items).toHaveLength(1);
  });

  it("rejects source-library writeback in v1", async () => {
    const database = new CoceanDatabase(":memory:");
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const settings = database.getSettings();
    const cookie = adminCookie(database);
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { cookie },
      payload: { ...settings, sourceWritebackEnabled: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(
      expect.objectContaining({ error: "SOURCE_WRITEBACK_DISABLED" }),
    );
  });

  it("keeps the Music root deployment-managed and rejects unavailable automation", async () => {
    const database = new CoceanDatabase(":memory:");
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const settings = database.getSettings();
    const cookie = adminCookie(database);

    const changedRoot = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { cookie },
      payload: {
        ...settings,
        libraryRoots: settings.libraryRoots.map((root) => ({
          ...root,
          containerPath: "/tmp/not-the-compose-mount",
        })),
      },
    });
    expect(changedRoot.statusCode).toBe(400);
    expect(changedRoot.json()).toEqual(
      expect.objectContaining({ error: "LIBRARY_ROOT_DEPLOYMENT_MANAGED" }),
    );

    for (const [field, error] of [
      ["scanOnStart", "SCAN_ON_START_UNAVAILABLE"],
      ["deviceCopyMetadataEnabled", "DEVICE_COPY_PIPELINE_UNAVAILABLE"],
    ] as const) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/settings",
        headers: { cookie },
        payload: { ...settings, [field]: true },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(expect.objectContaining({ error }));
    }
  });

  it("accepts persisted auto discovery settings and rejects interval boundaries", async () => {
    const database = new CoceanDatabase(":memory:");
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const settings = database.getSettings();
    const cookie = adminCookie(database);
    const enabled = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { cookie },
      payload: {
        ...settings,
        libraryRoots: settings.libraryRoots.map((root) => ({
          ...root,
          autoDiscoveryEnabled: true,
          autoDiscoveryIntervalMinutes: 1,
        })),
      },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().libraryRoots[0]).toEqual(
      expect.objectContaining({
        autoDiscoveryEnabled: true,
        autoDiscoveryIntervalMinutes: 1,
      }),
    );

    for (const interval of [0, 1441]) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/settings",
        headers: { cookie },
        payload: {
          ...enabled.json(),
          libraryRoots: enabled
            .json()
            .libraryRoots.map((root: Record<string, unknown>) => ({
              ...root,
              autoDiscoveryIntervalMinutes: interval,
            })),
        },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("records ownership without inventing device capabilities", async () => {
    const database = new CoceanDatabase(":memory:");
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/gear/devices",
      headers: { cookie: adminCookie(database) },
      payload: {
        manufacturer: "Astell&Kern",
        model: "SP3000M",
        category: "DAP",
        ownership: "OWNED",
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toEqual(
      expect.objectContaining({
        model: "SP3000M",
        ownership: "OWNED",
        capabilities: expect.objectContaining({
          verifiedAt: null,
          supportedFormats: [],
        }),
      }),
    );
  });

  it("edits an AK File Drop target without exposing or erasing its password", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-target-"));
    close.push(() => rm(directory, { recursive: true, force: true }));
    const database = new CoceanDatabase(":memory:");
    const app = await buildApp({
      config: testConfig({
        credentialKeyPath: join(directory, "credential.key"),
      }),
      database,
    });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const cookie = adminCookie(database);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/delivery-targets",
      headers: { cookie },
      payload: {
        name: "SP3000M",
        kind: "NETWORK",
        transport: "AK_FILE_DROP",
        location: "ftp://192.168.1.20:1234/",
        username: "player",
        password: "temporary-player-password",
        enabled: true,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.body).not.toContain("temporary-player-password");

    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/delivery-targets/${created.json().id}`,
      headers: { cookie },
      payload: {
        name: "SP3000M · AK File Drop",
        kind: "NETWORK",
        transport: "AK_FILE_DROP",
        location: "ftp://192.168.1.21:1234/",
        username: "player",
        password: "",
        enabled: true,
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toEqual(
      expect.objectContaining({
        location: "ftp://192.168.1.21:1234/",
        credentialConfigured: true,
      }),
    );
    expect(
      database.getStoredDeliveryTarget(created.json().id)?.credentialJson,
    ).toBeTruthy();
    expect(
      database.getStoredDeliveryTarget(created.json().id)?.credentialJson,
    ).not.toContain("temporary-player-password");
  });

  it("creates and returns a physical-only Album without inventing digital files", async () => {
    const database = new CoceanDatabase(":memory:");
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/albums",
      payload: {
        title: "Physical Album",
        albumArtist: "Collection Artist",
        year: 1988,
        medium: "VINYL",
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toEqual(
      expect.objectContaining({
        title: "Physical Album",
        hasDigital: false,
        physicalMedia: ["VINYL"],
        tracks: [],
        sourceRoot: null,
      }),
    );
    const list = await app.inject({ method: "GET", url: "/api/v1/albums" });
    expect(list.json().items).toEqual([
      expect.objectContaining({ title: "Physical Album", hasDigital: false }),
    ]);
  });

  it("adds a physical medium to an exact digital Album identity instead of creating a duplicate", async () => {
    const database = new CoceanDatabase(":memory:");
    database.replaceAlbumsForRoot("music", [
      {
        id: "digital-album",
        rootId: "music",
        groupKey: "artist/folder\0artist\0album",
        title: "Album",
        albumArtist: "Artist",
        year: 1999,
        discCount: 1,
        fileIds: [],
        audioSummary: null,
        mixedAudioSpecs: false,
        artwork: {
          source: "NONE",
          url: null,
          mimeType: null,
          width: null,
          height: null,
        },
        matchStatus: "UNMATCHED",
      },
    ]);
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/albums",
      payload: {
        title: "Album",
        albumArtist: "Artist",
        year: 1999,
        medium: "CD",
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toEqual(
      expect.objectContaining({
        primaryVersionId: "digital-album",
        physicalMedia: ["CD"],
      }),
    );
    expect(database.countAlbums()).toBe(1);
  });

  it("returns the stable LibraryAlbum id consistently for physical-copy POST and GET", async () => {
    const database = new CoceanDatabase(":memory:");
    database.replaceAlbumsForRoot("music", [
      {
        id: "copy-local-version",
        rootId: "music",
        groupKey: "copy",
        title: "Copy Album",
        albumArtist: "Artist",
        year: 2000,
        discCount: 1,
        fileIds: [],
        audioSummary: null,
        mixedAudioSpecs: false,
        artwork: {
          source: "NONE",
          url: null,
          mimeType: null,
          width: null,
          height: null,
        },
        matchStatus: "UNMATCHED",
      },
    ]);
    const stableId = database.getAlbumSummary("copy-local-version")!.id;
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/albums/copy-local-version/physical-copies",
      payload: { medium: "CD", quantity: 1 },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().albumId).toBe(stableId);
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/albums/${stableId}/physical-copies`,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items).toEqual([
      expect.objectContaining({ id: created.json().id, albumId: stableId }),
    ]);
    expect(
      database.raw
        .prepare("SELECT album_id FROM physical_copies WHERE id=?")
        .get(created.json().id),
    ).toEqual({ album_id: "copy-local-version" });
  });

  it("keeps MusicBrainz results as reviewable evidence until confirmation", async () => {
    const database = new CoceanDatabase(":memory:");
    database.replaceAlbumsForRoot("music", [
      {
        id: "album-match",
        rootId: "music",
        groupKey: "artist\0album",
        title: "Local Album",
        albumArtist: "Local Artist",
        year: 1994,
        discCount: 1,
        fileIds: [],
        audioSummary: null,
        mixedAudioSpecs: false,
        artwork: {
          source: "NONE",
          url: null,
          mimeType: null,
          width: null,
          height: null,
        },
        matchStatus: "UNMATCHED",
      },
    ]);
    const app = await buildApp({
      config: testConfig(),
      database,
      releaseCatalogClient: {
        searchReleases: async (input) => [
          {
            id: "candidate-1",
            albumId: input.albumId,
            source: "MUSICBRAINZ",
            sourceId: "f1b2d3c4-1111-4222-8333-123456789abc",
            title: "Remote Album",
            artistCredit: "Remote Artist",
            releaseDate: "1994-09-01",
            country: "GB",
            status: "Official",
            barcode: "1234567890123",
            labels: ["Still Test"],
            catalogNumbers: ["STILL-001"],
            mediaFormats: ["CD"],
            trackCount: 2,
            coverArtAvailable: true,
            sourceScore: 98,
            fetchedAt: "2026-08-12T00:00:00.000Z",
          },
        ],
      },
    });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const libraryAlbumId = database.getAlbumSummary("album-match")!.id;

    const search = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${libraryAlbumId}/match-candidates`,
      headers: { cookie: adminCookie(database) },
      payload: {},
    });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json().items).toEqual([
      expect.objectContaining({ id: "candidate-1", source: "MUSICBRAINZ" }),
    ]);
    expect(database.getAlbum("album-match")).toEqual(
      expect.objectContaining({
        title: "Local Album",
        matchStatus: "NEEDS_REVIEW",
      }),
    );

    const confirm = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${libraryAlbumId}/match-candidates/candidate-1/confirm`,
      headers: { cookie: adminCookie(database) },
      payload: {
        requestId: "confirm-candidate-1",
        expectedMetadataRevision: 0,
        localVersionId: "album-match",
      },
    });
    expect(confirm.statusCode, confirm.body).toBe(200);
    expect(confirm.json().album).toEqual(
      expect.objectContaining({
        title: "Remote Album",
        matchStatus: "USER_CONFIRMED",
        release: expect.objectContaining({
          musicBrainzReleaseId: "f1b2d3c4-1111-4222-8333-123456789abc",
        }),
      }),
    );
  });

  it("does not contact a catalog source until it is configured", async () => {
    const database = new CoceanDatabase(":memory:");
    database.replaceAlbumsForRoot("music", [
      {
        id: "album-unconfigured",
        rootId: "music",
        groupKey: "artist\0album",
        title: "Album",
        albumArtist: "Artist",
        year: null,
        discCount: 1,
        fileIds: [],
        audioSummary: null,
        mixedAudioSpecs: false,
        artwork: {
          source: "NONE",
          url: null,
          mimeType: null,
          width: null,
          height: null,
        },
        matchStatus: "UNMATCHED",
      },
    ]);
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/albums/album-unconfigured/match-candidates",
      headers: { cookie: adminCookie(database) },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(
      expect.objectContaining({ error: "CATALOG_SOURCE_NOT_CONFIGURED" }),
    );
  });

  it("searches MusicBrainz with the explicitly selected LocalVersion facts", async () => {
    const database = new CoceanDatabase(":memory:");
    const makeAlbum = (
      id: string,
      title: string,
      artist: string,
      year: number,
    ) => ({
      id,
      rootId: "music",
      groupKey: id,
      title,
      albumArtist: artist,
      year,
      discCount: 1,
      fileIds: [],
      audioSummary: null,
      mixedAudioSpecs: false,
      artwork: {
        source: "NONE" as const,
        url: null,
        mimeType: null,
        width: null,
        height: null,
      },
    });
    database.replaceAlbumsForRoot("music", [
      makeAlbum("search-primary", "Primary Facts", "Primary Artist", 2001),
      makeAlbum(
        "search-secondary",
        "Secondary Facts",
        "Secondary Artist",
        2002,
      ),
    ]);
    const source = database.getAlbumSummary("search-secondary")!;
    const target = database.getAlbumSummary("search-primary")!;
    database.applyLibraryIdentityDecision(
      source.id,
      {
        type: "MERGE",
        requestId: "search-version-merge",
        revision: source.revision,
        targetLibraryAlbumId: target.id,
        targetRevision: target.revision,
        primaryVersionId: "search-primary",
      },
      { id: "admin", displayName: "Admin" },
    );
    let received: unknown = null;
    const app = await buildApp({
      config: testConfig(),
      database,
      releaseCatalogClient: {
        searchReleases: async (input) => {
          received = input;
          return [];
        },
      },
    });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${target.id}/match-candidates`,
      headers: { cookie: adminCookie(database) },
      payload: { localVersionId: "search-secondary" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(received).toEqual(
      expect.objectContaining({
        albumId: "search-secondary",
        title: "Secondary Facts",
        artist: "Secondary Artist",
        year: 2002,
      }),
    );
  });

  it("streams a real indexed track with byte ranges for Listen", async () => {
    const musicRoot = await mkdtemp(join(tmpdir(), "cocean-listen-"));
    close.push(() => rm(musicRoot, { recursive: true, force: true }));
    const relativePath = "Artist/Album/01 Test.flac";
    await mkdir(join(musicRoot, "Artist/Album"), { recursive: true });
    await writeFile(join(musicRoot, relativePath), "0123456789");
    const database = new CoceanDatabase(":memory:", { musicRoot });
    database.createScanJob({
      id: "scan-listen",
      rootId: "music",
      mode: "FULL",
      status: "RUNNING",
      totalFiles: 1,
      processedFiles: 1,
      parsedFiles: 1,
      failedFiles: 0,
      reusedFiles: 0,
      createdAt: "2026-08-12T00:00:00.000Z",
      startedAt: "2026-08-12T00:00:00.000Z",
      finishedAt: null,
      error: null,
      cancelRequestedAt: null,
    });
    database.upsertMediaFile("track-1", "music", "scan-listen", {
      absolutePath: join(musicRoot, relativePath),
      relativePath,
      extension: ".flac",
      sizeBytes: 10,
      modifiedAtMs: Date.now(),
      audio: {
        kind: "PCM",
        codec: "flac",
        container: "flac",
        lossless: true,
        bitDepth: 24,
        sampleRate: 96_000,
        bitrate: null,
        channels: 2,
        dsdRate: null,
      },
      durationSeconds: 1,
      tags: {
        album: "Album",
        albumArtist: "Artist",
        title: "Test",
        artists: ["Artist"],
        year: 2026,
        date: null,
        genre: [],
        composer: [],
        label: [],
        catalogNumber: null,
        barcode: null,
        musicBrainzReleaseId: null,
        discNumber: 1,
        discTotal: 1,
        trackNumber: 1,
        trackTotal: 1,
      },
      artwork: [],
      warnings: [],
    });
    database.replaceAlbumsForRoot("music", [
      {
        id: "album-listen",
        rootId: "music",
        groupKey: "artist\0album",
        title: "Album",
        albumArtist: "Artist",
        year: 2026,
        discCount: 1,
        fileIds: ["track-1"],
        audioSummary: {
          kind: "PCM",
          codec: "flac",
          container: "flac",
          lossless: true,
          bitDepth: 24,
          sampleRate: 96_000,
          bitrate: null,
          channels: 2,
          dsdRate: null,
        },
        mixedAudioSpecs: false,
        artwork: {
          source: "NONE",
          url: null,
          mimeType: null,
          width: null,
          height: null,
        },
      },
    ]);
    const app = await buildApp({
      config: { ...testConfig(), musicRoot },
      database,
    });
    close.push(
      () => app.close(),
      () => database.close(),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/tracks/track-1/listen",
      headers: { range: "bytes=2-5" },
    });
    expect(response.statusCode, response.body).toBe(206);
    expect(response.headers["content-range"]).toBe("bytes 2-5/10");
    expect(response.headers["content-type"]).toContain("audio/flac");
    expect(response.body).toBe("2345");
    const detail = await app.inject({
      method: "GET",
      url: "/api/v1/albums/album-listen",
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().tracks).toEqual([
      expect.objectContaining({ id: "track-1", sizeBytes: 10 }),
    ]);
  });

  it("serves deterministic verified-catalog recommendations without claiming v0.10 acceptance", async () => {
    const database = new CoceanDatabase(":memory:");
    database.installStillCatalog(
      convertLegacyStillCore({
        schemaID: "still.local-curated-catalog",
        schemaVersion: "0.8.0",
        contentVersion: "catalog-test-v1",
        recordCount: 2,
        contentChecksum: "a".repeat(64),
        records: [
          {
            stableEntityID: "still:warm",
            entityKind: "album",
            canonicalTitle: "Local Warm Album",
            primaryArtist: "Local Artist",
            releaseFamilyID: "release:warm",
            recordingFamilyID: "recording:warm",
            musicDomains: ["jazz"],
            eligibleDomains: ["jazz"],
            features: ["musical.timbre:warm", "musical.dynamics:soft"],
            sourceKind: "verified_catalog",
            sourceRef: "https://example.test/warm",
            verificationStatus: "verified",
            editorialStatus: "accepted",
            contentVersion: "catalog-test-v1",
            verifiedAt: "2026-08-12T00:00:00.000Z",
          },
          {
            stableEntityID: "still:dark",
            entityKind: "album",
            canonicalTitle: "Dark Album",
            primaryArtist: "Other Artist",
            releaseFamilyID: "release:dark",
            recordingFamilyID: "recording:dark",
            musicDomains: ["ambient"],
            eligibleDomains: ["ambient"],
            features: ["musical.timbre:dark"],
            sourceKind: "verified_catalog",
            sourceRef: "https://example.test/dark",
            verificationStatus: "verified",
            editorialStatus: "accepted",
            contentVersion: "catalog-test-v1",
            verifiedAt: "2026-08-12T00:00:00.000Z",
          },
        ],
      }),
    );
    database.replaceAlbumsForRoot("music", [
      {
        id: "local-warm",
        rootId: "music",
        groupKey: "local artist\0local warm album",
        title: "Local Warm Album",
        albumArtist: "Local Artist",
        year: null,
        discCount: 1,
        fileIds: [],
        audioSummary: null,
        mixedAudioSpecs: false,
        artwork: {
          source: "NONE",
          url: null,
          mimeType: null,
          width: null,
          height: null,
        },
        matchStatus: "UNMATCHED",
      },
    ]);
    const app = await buildApp({ config: testConfig(), database });
    close.push(
      () => app.close(),
      () => database.close(),
    );

    const today = await app.inject({
      method: "GET",
      url: "/api/v1/recommendations/today?dayKey=2026-08-12",
    });
    const replay = await app.inject({
      method: "GET",
      url: "/api/v1/recommendations/today?dayKey=2026-08-12",
    });
    expect(today.statusCode, today.body).toBe(200);
    expect(today.body).toBe(replay.body);
    expect(today.json()).toEqual(
      expect.objectContaining({
        mode: "VERIFIED_CATALOG_COMPATIBILITY",
        modelCallCount: 0,
        v010: expect.objectContaining({
          status: "WAITING_FOR_ACCEPTED_RUNTIME",
        }),
      }),
    );

    const discover = await app.inject({
      method: "POST",
      url: "/api/v1/recommendations/discover",
      payload: { query: "安静温暖的 90 年代女声" },
    });
    expect(discover.statusCode, discover.body).toBe(200);
    expect(discover.json()).toEqual(
      expect.objectContaining({
        query: expect.objectContaining({
          unsupportedTerms: ["年代", "演唱者性别"],
        }),
        primary: expect.objectContaining({
          stillAlbumId: "still:warm",
          localAlbum: expect.objectContaining({
            primaryVersionId: "local-warm",
          }),
        }),
      }),
    );
  });

  it("owns the delivery-plan window across clients, isolates targets, rotates stale plans, and rejects duplicate active work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-delivery-route-"));
    close.push(() => rm(directory, { recursive: true, force: true }));
    const musicRoot = join(directory, "music");
    const cacheRoot = join(directory, "cache");
    await mkdir(musicRoot, { recursive: true });
    const database = new CoceanDatabase(":memory:", { musicRoot });
    database.createScanJob({
      id: "delivery-route-scan",
      rootId: "music",
      mode: "FULL",
      status: "RUNNING",
      totalFiles: 4,
      processedFiles: 4,
      parsedFiles: 4,
      failedFiles: 0,
      reusedFiles: 0,
      createdAt: "2026-08-13T00:00:00.000Z",
      startedAt: "2026-08-13T00:00:00.000Z",
      finishedAt: null,
      error: null,
      cancelRequestedAt: null,
    });
    const albums = [];
    for (const suffix of ["one", "two", "three", "four"] as const) {
      const relativePath = `Artist/Album ${suffix}/01 Track.flac`;
      const contents = `audio-${suffix}`;
      const absolutePath = join(musicRoot, relativePath);
      await mkdir(join(absolutePath, ".."), { recursive: true });
      await writeFile(absolutePath, contents);
      const fileId = `delivery-file-${suffix}`;
      database.upsertMediaFile(fileId, "music", "delivery-route-scan", {
        absolutePath,
        relativePath,
        extension: ".flac",
        sizeBytes: Buffer.byteLength(contents),
        modifiedAtMs: 1,
        fileSha256: createHash("sha256").update(contents).digest("hex"),
        audio: {
          kind: "PCM",
          codec: "flac",
          container: "flac",
          lossless: true,
          bitDepth: 24,
          sampleRate: 96_000,
          bitrate: null,
          channels: 2,
          dsdRate: null,
        },
        durationSeconds: 60,
        tags: {
          album: `Album ${suffix}`,
          albumArtist: "Artist",
          title: "Track",
          artists: ["Artist"],
          year: 2026,
          date: "2026",
          genre: [],
          composer: [],
          label: [],
          catalogNumber: null,
          barcode: null,
          musicBrainzReleaseId: null,
          discNumber: 1,
          discTotal: 1,
          trackNumber: 1,
          trackTotal: 1,
        },
        rawTags: [],
        artwork: [],
        warnings: [],
      });
      albums.push({
        id: `delivery-album-${suffix}`,
        rootId: "music",
        groupKey: `artist\0album ${suffix}`,
        title: `Album ${suffix}`,
        albumArtist: "Artist",
        year: 2026,
        discCount: 1,
        fileIds: [fileId],
        audioSummary: null,
        mixedAudioSpecs: false,
        artwork: {
          source: "NONE" as const,
          url: null,
          mimeType: null,
          width: null,
          height: null,
        },
        matchStatus: "NEEDS_REVIEW" as const,
      });
    }
    database.replaceAlbumsForRoot("music", albums);
    database.finishScanJob("delivery-route-scan");
    const now = new Date().toISOString();
    for (const targetId of ["target-one", "target-two", "target-three"])
      database.createDeliveryTarget({
        id: targetId,
        deviceId: null,
        name: targetId,
        kind: "MOUNTED_VOLUME",
        transport: "USB_MOUNT",
        location: join(directory, targetId),
        username: null,
        credentialConfigured: false,
        enabled: true,
        verifiedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    database.createDeliveryTarget({
      id: "target-ak",
      deviceId: null,
      name: "SP3000M",
      kind: "NETWORK",
      transport: "AK_FILE_DROP",
      location: "ftp://sp3000m.test/",
      username: null,
      credentialConfigured: false,
      enabled: true,
      verifiedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    database.createDeliveryTarget({
      id: "target-ftp",
      deviceId: null,
      name: "Generic FTP",
      kind: "NETWORK",
      transport: "FTP",
      location: "ftp://generic.test/",
      username: null,
      credentialConfigured: false,
      enabled: true,
      verifiedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const app = await buildApp({
      config: testConfig({
        musicRoot,
        cacheRoot,
        credentialKeyPath: join(directory, "credential.key"),
      }),
      database,
      deliveryExecution: false,
    });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const cookie = adminCookie(database);
    const planId = "11111111-1111-4111-8111-111111111111";
    const deliver = (album: string, targetId: string, requested?: string) => {
      const localVersionId = `delivery-album-${album}`;
      const libraryAlbumId = database.getAlbumSummary(localVersionId)?.id;
      if (!libraryAlbumId) throw new Error(`Missing ${localVersionId}`);
      return app.inject({
        method: "POST",
        url: `/api/v1/albums/${libraryAlbumId}/deliveries`,
        headers: { cookie },
        payload: { targetId, ...(requested ? { planId: requested } : {}) },
      });
    };

    const first = await deliver("one", "target-one", planId);
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json()).toEqual(
      expect.objectContaining({
        planId,
        fileCount: 1,
        completedFileCount: 0,
        totalBytes: Buffer.byteLength("audio-one"),
      }),
    );
    expect(
      database.getDeliveryJobSourceBundle(first.json().id)
        ?.deliveryProfileVersion,
    ).toBeUndefined();
    const firstLibraryAlbumId =
      database.getAlbumSummary("delivery-album-one")!.id;
    const albumHistory = await app.inject({
      method: "GET",
      url: `/api/v1/albums/${firstLibraryAlbumId}/deliveries`,
    });
    expect(albumHistory.statusCode, albumHistory.body).toBe(200);
    expect(albumHistory.json().items).toEqual([
      expect.objectContaining({ id: first.json().id }),
    ]);
    const ak = await deliver("two", "target-ak");
    expect(ak.statusCode, ak.body).toBe(202);
    expect(
      database.getDeliveryJobSourceBundle(ak.json().id)?.deliveryProfileVersion,
    ).toBe("organized-v2");
    const genericFtp = await deliver("three", "target-ftp");
    expect(genericFtp.statusCode, genericFtp.body).toBe(202);
    expect(
      database.getDeliveryJobSourceBundle(genericFtp.json().id)
        ?.deliveryProfileVersion,
    ).toBeUndefined();
    const second = await deliver("two", "target-one");
    expect(second.statusCode, second.body).toBe(202);
    expect(second.json().planId).toBe(planId);

    const duplicate = await deliver("one", "target-one", planId);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual(
      expect.objectContaining({ error: "DELIVERY_ALREADY_ACTIVE" }),
    );

    const crossTarget = await deliver("three", "target-two", planId);
    expect(crossTarget.statusCode, crossTarget.body).toBe(202);
    expect(crossTarget.json().planId).not.toBe(planId);

    const stalePlanId = "22222222-2222-4222-8222-222222222222";
    database.createDeliveryJob({
      id: "stale-delivery-plan-job",
      albumId: "delivery-album-one",
      targetId: "target-three",
      targetName: "target-three",
      transport: "USB_MOUNT",
      status: "COMPLETED",
      fileCount: 1,
      completedFileCount: 0,
      totalBytes: 9,
      transferredBytes: 9,
      verified: true,
      error: null,
      createdAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      startedAt: null,
      finishedAt: null,
      planId: stalePlanId,
    });
    const stale = await deliver("four", "target-three", stalePlanId);
    expect(stale.statusCode, stale.body).toBe(202);
    expect(stale.json().planId).not.toBe(stalePlanId);

    const newestSibling = await deliver("four", "target-one", planId);
    expect(newestSibling.statusCode, newestSibling.body).toBe(202);
    expect(newestSibling.json().planId).toBe(planId);
    database.raw
      .prepare("UPDATE delivery_jobs SET created_at=? WHERE id=?")
      .run(
        new Date(Date.now() + 60_000).toISOString(),
        newestSibling.json().id,
      );

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/deliveries?limit=1",
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(
      listed
        .json()
        .items.map((job: { id: string }) => job.id)
        .sort(),
    ).toEqual(
      [first.json().id, second.json().id, newestSibling.json().id].sort(),
    );
  });

  it("governs album visibility and lifecycle plans with role-safe views", async () => {
    const database = new CoceanDatabase(":memory:", {
      musicRootPolicy: "MANAGED",
    });
    const { albumId, versionId } = seedLifecycleApiAlbum(database);
    const app = await buildApp({
      config: testConfig({ musicRootPolicy: "MANAGED" }),
      database,
      deliveryExecution: false,
    });
    close.push(
      () => app.close(),
      () => database.close(),
    );
    const admin = adminCookie(database);
    const member = sessionCookieFor(database, "MEMBER");
    const hidden = await app.inject({
      method: "PATCH",
      url: `/api/v1/albums/${albumId}/visibility`,
      headers: { cookie: admin },
      payload: {
        action: "HIDE",
        requestId: "api-hide",
        expectedVisibilityRevision: 0,
      },
    });
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect(hidden.json()).toEqual(
      expect.objectContaining({ visibility: "HIDDEN" }),
    );
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/albums" })).json().items,
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/albums?visibility=HIDDEN",
          headers: { cookie: member },
        })
      ).json().items,
    ).toEqual([expect.objectContaining({ id: albumId })]);
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/albums/${albumId}` }))
        .statusCode,
    ).toBe(404);
    const history = await app.inject({
      method: "GET",
      url: `/api/v1/albums/${albumId}/visibility-history`,
      headers: { cookie: member },
    });
    expect(history.json().items[0]).not.toHaveProperty("actor");
    expect(history.json().items[0]).not.toHaveProperty("requestId");

    const plan = await app.inject({
      method: "POST",
      url: `/api/v1/albums/${albumId}/lifecycle-plans`,
      headers: { cookie: admin },
      payload: {
        requestId: "api-lifecycle-preview",
        expectedLibraryRevision: database.getAlbumSummary(albumId)!.revision,
        localVersionId: versionId,
      },
    });
    expect(plan.statusCode, plan.body).toBe(201);
    expect(plan.json()).toEqual(
      expect.objectContaining({ executable: true, status: "PREVIEWED" }),
    );
    const memberView = await app.inject({
      method: "GET",
      url: `/api/v1/lifecycle-plans/${plan.json().id}`,
      headers: { cookie: member },
    });
    expect(memberView.statusCode, memberView.body).toBe(200);
    expect(memberView.json()).not.toHaveProperty("items");
    expect(memberView.json()).not.toHaveProperty("actor");
    expect(memberView.json()).not.toHaveProperty("requestId");
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/lifecycle-plans/${plan.json().id}/confirm`,
      headers: { cookie: admin },
      payload: { requestId: "api-lifecycle-confirm" },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(202);
    expect(confirmed.json()).toEqual(
      expect.objectContaining({ status: "QUEUED" }),
    );
    database.claimNextLibraryChangePlan();
    database.finishLibraryChangePlan(
      plan.json().id,
      "RECOVERY_REQUIRED",
      "/library/music/private/path.flac is conflicted",
    );
    const redacted = await app.inject({
      method: "GET",
      url: `/api/v1/lifecycle-plans/${plan.json().id}`,
      headers: { cookie: member },
    });
    expect(redacted.json().error).toBe("任务需要管理员处理");
    expect(redacted.body).not.toContain("/library/music");
    const retried = await app.inject({
      method: "POST",
      url: `/api/v1/lifecycle-plans/${plan.json().id}/retry`,
      headers: { cookie: admin },
      payload: { requestId: "api-lifecycle-retry" },
    });
    expect(retried.statusCode, retried.body).toBe(202);
    expect(retried.json().status).toBe("QUEUED");
  });
});

function adminCookie(database: CoceanDatabase): string {
  const existing = database.getUserByUsername("test-admin");
  const now = new Date().toISOString();
  const user = existing
    ? database.getUser(existing.id)!
    : {
        id: "test-admin",
        username: "test-admin",
        displayName: "Test Admin",
        role: "ADMIN" as const,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      };
  if (!existing) database.createUser(user, "unused-test-password-hash");
  const { token } = createSession(database, user, 1);
  return `cocean_session=${token}`;
}

function sessionCookieFor(
  database: CoceanDatabase,
  role: "ADMIN" | "MEMBER",
): string {
  const id = `test-${role.toLowerCase()}-${Date.now()}-${Math.random()}`;
  const now = new Date().toISOString();
  const user = {
    id,
    username: id,
    displayName: role === "ADMIN" ? "Test Admin" : "Test Member",
    role,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  };
  database.createUser(user, "unused-test-password-hash");
  const { token } = createSession(database, user, 1);
  return `cocean_session=${token}`;
}

function seedLifecycleApiAlbum(database: CoceanDatabase): {
  albumId: string;
  versionId: string;
} {
  const scanId = "api-lifecycle-scan";
  database.createScanJob({
    id: scanId,
    rootId: "music",
    mode: "FULL",
    status: "RUNNING",
    totalFiles: 1,
    processedFiles: 1,
    parsedFiles: 1,
    failedFiles: 0,
    reusedFiles: 0,
    createdAt: "2026-08-15T00:00:00.000Z",
    startedAt: "2026-08-15T00:00:00.000Z",
    finishedAt: null,
    error: null,
    cancelRequestedAt: null,
  });
  const versionId = "api-lifecycle-version";
  database.upsertMediaFile("api-lifecycle-file", "music", scanId, {
    absolutePath: "/library/music/Artist/Album/01.flac",
    relativePath: "Artist/Album/01.flac",
    extension: ".flac",
    sizeBytes: 5,
    modifiedAtMs: 1,
    fileSha256: createHash("sha256").update("audio").digest("hex"),
    audio: {
      kind: "PCM",
      codec: "flac",
      container: "flac",
      lossless: true,
      bitDepth: 24,
      sampleRate: 96_000,
      bitrate: null,
      channels: 2,
      dsdRate: null,
    },
    durationSeconds: 1,
    tags: {
      album: "Album",
      albumArtist: "Artist",
      title: "Track",
      artists: ["Artist"],
      year: 2026,
      date: "2026",
      genre: [],
      composer: [],
      label: [],
      catalogNumber: null,
      barcode: null,
      musicBrainzReleaseId: null,
      discNumber: 1,
      discTotal: 1,
      trackNumber: 1,
      trackTotal: 1,
    },
    rawTags: [],
    artwork: [],
    warnings: [],
  });
  database.replaceAlbumsForRoot("music", [
    {
      id: versionId,
      rootId: "music",
      groupKey: "api-lifecycle",
      title: "Album",
      albumArtist: "Artist",
      year: 2026,
      discCount: 1,
      fileIds: ["api-lifecycle-file"],
      audioSummary: null,
      mixedAudioSpecs: false,
      artwork: {
        source: "NONE",
        url: null,
        mimeType: null,
        width: null,
        height: null,
      },
      matchStatus: "NEEDS_REVIEW",
      aggregationIssues: [],
    },
  ]);
  database.finishScanJob(scanId);
  return { albumId: database.getAlbumSummary(versionId)!.id, versionId };
}

function artworkMultipart(
  boundary: string,
  requestId: string,
  expectedArtworkRevision: number,
  image: Buffer,
): Buffer {
  const text = (name: string, value: string) =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  return Buffer.concat([
    text("requestId", requestId),
    text("expectedArtworkRevision", String(expectedArtworkRevision)),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="front.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}
