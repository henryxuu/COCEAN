import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { CoceanDatabase } from "./client.js";
import {
  createVerifiedDatabaseBackup,
  verifyDatabaseBackup,
} from "./maintenance.js";
import { convertLegacyStillCore } from "@cocean/still-catalog";
import { migrations } from "./migrations.js";

const open: CoceanDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const database of open.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CoceanDatabase", () => {
  it("persists model verification and invalidates it when the connection changes", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    expect(database.getStoredModelConfiguration().configuration).toEqual(
      expect.objectContaining({
        verificationStatus: "UNVERIFIED",
        lastCheckedAt: null,
      }),
    );
    database.saveModelConfiguration({
      enabled: true,
      baseUrl: "https://models.example.test/v1",
      model: "model-one",
      credentialJson: "encrypted-key",
    });
    const verified = database.recordModelVerification("VERIFIED", "连接正常");
    expect(verified).toEqual(
      expect.objectContaining({
        verificationStatus: "VERIFIED",
        verificationMessage: "连接正常",
        lastCheckedAt: expect.any(String),
      }),
    );
    expect(
      database.saveModelConfiguration({
        enabled: true,
        baseUrl: "https://models.example.test/v1",
        model: "model-two",
        credentialJson: "encrypted-key",
      }),
    ).toEqual(
      expect.objectContaining({
        verificationStatus: "UNVERIFIED",
        lastCheckedAt: null,
        verificationMessage: null,
      }),
    );
  });

  it("normalizes an existing FTP-address target to AK File Drop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-ak-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "cocean.sqlite");
    const legacy = new BetterSqlite3(path);
    for (const migration of migrations.slice(0, 9)) {
      legacy.exec(migration.sql);
      legacy
        .prepare(
          "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, "2026-08-12T00:00:00.000Z");
    }
    legacy
      .prepare(
        `INSERT INTO delivery_targets (
          id, device_id, name, kind, transport, location, username,
          credential_json, enabled, verified_at, created_at, updated_at
        ) VALUES (?, NULL, ?, 'NETWORK', 'SMB', ?, NULL, NULL, 1, NULL, ?, ?)`,
      )
      .run(
        "legacy-sp3000m",
        "SP3000M",
        "ftp://192.168.1.132:1212/",
        "2026-08-12T00:00:00.000Z",
        "2026-08-12T00:00:00.000Z",
      );
    legacy.close();

    const database = new CoceanDatabase(path);
    open.push(database);
    expect(database.getStoredDeliveryTarget("legacy-sp3000m")?.target).toEqual(
      expect.objectContaining({
        kind: "NETWORK",
        transport: "AK_FILE_DROP",
        credentialConfigured: false,
      }),
    );
  });

  it("refuses a database created by a newer application schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-schema-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "cocean.sqlite");
    const database = new CoceanDatabase(path);
    database.raw
      .prepare(
        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (999, 'future_schema', ?)",
      )
      .run("2026-08-12T00:00:00.000Z");
    database.close();

    expect(() => new CoceanDatabase(path)).toThrow(/newer|unsupported/);
    await expect(
      createVerifiedDatabaseBackup(
        path,
        join(directory, "backups", "future.sqlite"),
        join(directory, "backups", "future.json"),
        "0.1.0",
      ),
    ).rejects.toThrow(/newer/);
  });

  it("creates and independently verifies an online SQLite backup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-backup-test-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "cocean.sqlite");
    const backup = join(directory, "backups", "pre-upgrade.sqlite");
    const metadata = join(directory, "backups", "pre-upgrade.json");
    const database = new CoceanDatabase(source);
    database.createOwnedDevice({
      id: "backup-device",
      manufacturer: "Astell&Kern",
      model: "SP3000M",
      category: "DAP",
      ownership: "OWNED",
      nickname: null,
      serialNumber: null,
      notes: null,
      capabilities: {
        maxPcmSampleRate: null,
        maxPcmBitDepth: null,
        maxDsdRate: null,
        supportedFormats: [],
        source: null,
        verifiedAt: null,
      },
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    });

    const created = await createVerifiedDatabaseBackup(
      source,
      backup,
      metadata,
      "0.1.0",
    );
    expect(created).toEqual(
      expect.objectContaining({
        schema: "cocean.database-backup/v1",
        releaseVersion: "0.1.0",
        schemaVersion: 16,
        migrationCount: 16,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(await verifyDatabaseBackup(backup, metadata)).toEqual(created);
    const restored = new CoceanDatabase(backup);
    expect(restored.listOwnedDevices()).toEqual([
      expect.objectContaining({ id: "backup-device", model: "SP3000M" }),
    ]);
    restored.close();

    await appendFile(backup, "tamper");
    await expect(verifyDatabaseBackup(backup, metadata)).rejects.toThrow(
      /size|checksum/,
    );
  });

  it("creates a watch-only Music root and safe settings", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const settings = database.getSettings();
    expect(settings.libraryRoots).toEqual([
      expect.objectContaining({
        id: "music",
        containerPath: "/library/music",
        policy: "WATCH_ONLY",
      }),
    ]);
    expect(settings.sourceWritebackEnabled).toBe(false);
    expect(settings.scanOnStart).toBe(false);
    expect(settings.deviceCopyMetadataEnabled).toBe(false);
    expect(settings.qobuzEnabled).toBe(false);
    expect(settings.libraryRoots[0]).toEqual(
      expect.objectContaining({
        autoDiscoveryEnabled: false,
        autoDiscoveryIntervalMinutes: 5,
      }),
    );
  });

  it("upgrades existing roots with auto discovery disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-auto-upgrade-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "cocean.sqlite");
    const legacy = new BetterSqlite3(path);
    for (const migration of migrations.slice(0, 14)) {
      legacy.exec(migration.sql);
      legacy
        .prepare(
          "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, "2026-08-12T00:00:00.000Z");
    }
    legacy
      .prepare(
        `INSERT INTO library_roots
          (id, name, host_path_hint, container_path, policy, enabled,
           created_at, updated_at, system)
         VALUES ('music', 'Music', NULL, '/library/music', 'WATCH_ONLY', 1,
           ?, ?, 0)`,
      )
      .run("2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z");
    const insertLegacyScan = legacy.prepare(
      `INSERT INTO scan_jobs (
         id, root_id, mode, status, total_files, processed_files, parsed_files,
         failed_files, reused_files, created_at, started_at, finished_at, error,
         cancel_requested_at
       ) VALUES (?, 'music', 'INCREMENTAL', ?, 0, 0, 0, 0, 0, ?, ?, NULL, NULL, NULL)`,
    );
    insertLegacyScan.run(
      "queued-old",
      "QUEUED",
      "2026-08-12T00:00:00.000Z",
      null,
    );
    insertLegacyScan.run(
      "running-keeper",
      "RUNNING",
      "2026-08-12T00:01:00.000Z",
      "2026-08-12T00:01:00.000Z",
    );
    insertLegacyScan.run(
      "running-extra",
      "RUNNING",
      "2026-08-12T00:02:00.000Z",
      "2026-08-12T00:02:00.000Z",
    );
    legacy.close();

    const upgraded = new CoceanDatabase(path);
    open.push(upgraded);
    expect(upgraded.getSettings().libraryRoots[0]).toEqual(
      expect.objectContaining({
        autoDiscoveryEnabled: false,
        autoDiscoveryIntervalMinutes: 5,
      }),
    );
    expect(
      upgraded.raw
        .prepare("SELECT next_auto_scan_at FROM library_roots WHERE id='music'")
        .get(),
    ).toEqual({ next_auto_scan_at: null });
    expect(
      upgraded.listScanJobs().map((job) => ({
        id: job.id,
        status: job.status,
        error: job.error,
      })),
    ).toEqual([
      expect.objectContaining({
        id: "running-extra",
        status: "CANCELLED",
        error: expect.stringContaining("升级"),
      }),
      expect.objectContaining({
        id: "running-keeper",
        status: "RUNNING",
        error: null,
      }),
      expect.objectContaining({
        id: "queued-old",
        status: "CANCELLED",
        error: expect.stringContaining("升级"),
      }),
    ]);
  });

  it("upgrades schema 15 albums into stable library groups without rewriting owned records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-m1-upgrade-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "cocean.sqlite");
    const legacy = new BetterSqlite3(path);
    for (const migration of migrations.slice(0, 15)) {
      legacy.exec(migration.sql);
      legacy
        .prepare(
          "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, "2026-08-12T00:00:00.000Z");
    }
    legacy
      .prepare(
        `INSERT INTO library_roots
          (id, name, container_path, policy, enabled, created_at, updated_at, system,
           auto_discovery_enabled, auto_discovery_interval_minutes)
         VALUES ('music', 'Music', '/library/music', 'WATCH_ONLY', 1, ?, ?, 0, 0, 5)`,
      )
      .run("2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z");
    const insertAlbum = legacy.prepare(
      `INSERT INTO albums (
         id, root_id, group_key, title, album_artist, year, disc_count, track_count,
         audio_summary_json, audio_badge, mixed_audio_specs, artwork_json,
         match_status, created_at, updated_at
       ) VALUES (?, 'music', ?, 'Shared Album', 'Shared Artist', 2020, 1, ?,
         NULL, NULL, 0, ?, 'NEEDS_REVIEW', ?, ?)`,
    );
    const artwork = JSON.stringify({
      source: "SIDECAR",
      url: "/cover.jpg",
      mimeType: "image/jpeg",
      width: 1000,
      height: 1000,
    });
    insertAlbum.run(
      "legacy-short",
      "legacy-short",
      2,
      artwork,
      "2026-08-12T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
    );
    insertAlbum.run(
      "legacy-complete",
      "legacy-complete",
      21,
      artwork,
      "2026-08-12T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
    );
    legacy
      .prepare(
        `INSERT INTO physical_copies
          (id, album_id, medium, quantity, created_at, updated_at)
         VALUES ('legacy-cd', 'legacy-short', 'CD', 1, ?, ?)`,
      )
      .run("2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z");
    legacy.close();

    const upgraded = new CoceanDatabase(path);
    open.push(upgraded);
    expect(upgraded.listAlbums()).toEqual([
      expect.objectContaining({
        primaryVersionId: "legacy-complete",
        versionCount: 2,
        physicalMedia: ["CD"],
      }),
    ]);
    expect(
      upgraded.raw.prepare("SELECT id, album_id FROM physical_copies").all(),
    ).toEqual([{ id: "legacy-cd", album_id: "legacy-short" }]);
    expect(
      upgraded.raw
        .prepare(
          "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1",
        )
        .get(),
    ).toEqual({
      version: 16,
      name: "library_album_identity_and_integrity",
    });
  });

  it("persists validated per-root auto discovery settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-auto-settings-"));
    const path = join(directory, "cocean.sqlite");
    const database = new CoceanDatabase(path);
    const settings = database.getSettings();
    database.saveSettings({
      ...settings,
      libraryRoots: settings.libraryRoots.map((root) => ({
        ...root,
        autoDiscoveryEnabled: true,
        autoDiscoveryIntervalMinutes: 17,
      })),
    });
    expect(() =>
      database.saveSettings({
        ...database.getSettings(),
        libraryRoots: database.getSettings().libraryRoots.map((root) => ({
          ...root,
          autoDiscoveryIntervalMinutes: 0,
        })),
      }),
    ).toThrow(/1-1440/);
    const restartAt = new Date("2030-02-01T00:00:00.000Z");
    expect(database.enqueueDueAutoDiscoveryJobs(restartAt)).toHaveLength(1);
    database.close();

    const reopened = new CoceanDatabase(path);
    expect(reopened.getSettings().libraryRoots[0]).toEqual(
      expect.objectContaining({
        autoDiscoveryEnabled: true,
        autoDiscoveryIntervalMinutes: 17,
      }),
    );
    expect(reopened.enqueueDueAutoDiscoveryJobs(restartAt)).toEqual([]);
    expect(reopened.listScanJobs()).toHaveLength(1);
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("atomically deduplicates due automatic scans and advances the durable clock", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const settings = database.getSettings();
    database.saveSettings({
      ...settings,
      libraryRoots: settings.libraryRoots.map((root) => ({
        ...root,
        autoDiscoveryEnabled: true,
        autoDiscoveryIntervalMinutes: 5,
      })),
    });
    const firstAt = new Date("2030-01-01T00:00:00.000Z");
    const [first] = database.enqueueDueAutoDiscoveryJobs(firstAt);
    expect(first).toEqual(
      expect.objectContaining({
        rootId: "music",
        mode: "INCREMENTAL",
        triggerSource: "AUTO_DISCOVERY",
      }),
    );
    expect(database.enqueueDueAutoDiscoveryJobs(firstAt)).toEqual([]);
    expect(
      database.enqueueDueAutoDiscoveryJobs(
        new Date("2030-01-01T00:05:00.000Z"),
      ),
    ).toEqual([]);
    expect(database.listScanJobs()).toHaveLength(1);
    database.requestScanCancellation(first!.id);
    const [second] = database.enqueueDueAutoDiscoveryJobs(
      new Date("2030-01-01T00:10:00.000Z"),
    );
    expect(second?.id).not.toBe(first?.id);
    expect(database.listScanJobs()).toHaveLength(2);
  });

  it("requires unchanged per-directory fingerprints for at least 60 seconds", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const first = database.observeAlbumDirectories(
      "music",
      [
        { relativeDirectory: "Artist/A", fingerprint: "a1" },
        { relativeDirectory: "Artist/B", fingerprint: "b1" },
      ],
      new Date("2030-01-01T00:00:00.000Z"),
    );
    expect(first.stableDirectories).toEqual([]);
    expect(first.deferredDirectories).toEqual(["Artist/A", "Artist/B"]);

    const changed = database.observeAlbumDirectories(
      "music",
      [
        { relativeDirectory: "Artist/A", fingerprint: "a2" },
        { relativeDirectory: "Artist/B", fingerprint: "b1" },
      ],
      new Date("2030-01-01T00:01:00.000Z"),
    );
    expect(changed.stableDirectories).toEqual(["Artist/B"]);
    expect(changed.deferredDirectories).toEqual(["Artist/A"]);

    const stable = database.observeAlbumDirectories(
      "music",
      [
        { relativeDirectory: "Artist/A", fingerprint: "a2" },
        { relativeDirectory: "Artist/B", fingerprint: "b1" },
      ],
      new Date("2030-01-01T00:02:00.000Z"),
    );
    expect(stable.stableDirectories).toEqual(["Artist/A", "Artist/B"]);
    expect(stable.deferredDirectories).toEqual([]);
  });

  it("traces retry ancestry back to automatic discovery", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.createScanJob({
      ...scanJobInput("auto-origin"),
      triggerSource: "AUTO_DISCOVERY",
    });
    database.claimNextScanJob();
    database.finishScanJob("auto-origin", "NAS unavailable");
    database.createScanJob({
      ...scanJobInput("retry-one"),
      triggerSource: "RETRY",
      retryOfScanJobId: "auto-origin",
    });
    database.requestScanCancellation("retry-one");
    database.createScanJob({
      ...scanJobInput("retry-two"),
      triggerSource: "RETRY",
      retryOfScanJobId: "retry-one",
    });
    database.requestScanCancellation("retry-two");
    database.createScanJob({
      ...scanJobInput("manual-origin"),
      triggerSource: "MANUAL",
    });
    database.requestScanCancellation("manual-origin");
    database.createScanJob({
      ...scanJobInput("manual-retry"),
      triggerSource: "RETRY",
      retryOfScanJobId: "manual-origin",
    });

    expect(database.scanRequiresAlbumStability("auto-origin")).toBe(true);
    expect(database.scanRequiresAlbumStability("retry-one")).toBe(true);
    expect(database.scanRequiresAlbumStability("retry-two")).toBe(true);
    expect(database.scanRequiresAlbumStability("manual-retry")).toBe(false);
  });

  it("queues and claims a scan job atomically", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.createScanJob({
      id: "scan-1",
      rootId: "music",
      mode: "FULL",
      status: "QUEUED",
      totalFiles: 0,
      processedFiles: 0,
      parsedFiles: 0,
      failedFiles: 0,
      reusedFiles: 0,
      createdAt: "2026-08-12T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      error: null,
      cancelRequestedAt: null,
    });
    expect(database.claimNextScanJob()).toEqual(
      expect.objectContaining({ id: "scan-1", status: "RUNNING" }),
    );
    expect(database.claimNextScanJob()).toBeNull();
  });

  it("keeps per-file failures and worker heartbeat auditable", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.createScanJob({
      id: "scan-warning",
      rootId: "music",
      mode: "FULL",
      status: "QUEUED",
      totalFiles: 1,
      processedFiles: 0,
      parsedFiles: 0,
      failedFiles: 0,
      reusedFiles: 0,
      createdAt: "2026-08-12T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      error: null,
      cancelRequestedAt: null,
    });
    database.recordScanFailure({
      scanJobId: "scan-warning",
      rootId: "music",
      relativePath: "Artist/Album/broken.flac",
      code: "METADATA_PARSE_FAILED",
      stage: "metadata",
      message: "无法解析音频标签",
      recoverable: true,
    });
    database.recordScanFailure({
      scanJobId: "scan-warning",
      rootId: "music",
      relativePath: "Artist/Album/unsupported.iso",
      code: "UNSUPPORTED_MEDIA",
      stage: "discover",
      message: "暂不支持该音频载体",
      recoverable: true,
    });
    database.finishScanJob("scan-warning", null, true);
    database.touchWorkerHeartbeat("scanner", 1234, "ready");

    expect(database.getScanJob("scan-warning")?.status).toBe(
      "COMPLETED_WITH_WARNINGS",
    );
    expect(database.countScanFailures("scan-warning")).toBe(2);
    expect(database.listScanFailures("scan-warning", 1, 1)).toEqual([
      expect.objectContaining({
        relativePath: "Artist/Album/unsupported.iso",
        code: "UNSUPPORTED_MEDIA",
      }),
    ]);
    expect(database.getWorkerHeartbeat("scanner")).toEqual(
      expect.objectContaining({ processId: 1234, state: "ready" }),
    );
  });

  it("preserves physical ownership when a digital album is rescanned or disappears", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const album = {
      id: "album-stable",
      rootId: "music",
      groupKey: "artist\0album",
      title: "Album",
      albumArtist: "Artist",
      year: 1994,
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
      matchStatus: "NEEDS_REVIEW" as const,
    };
    database.replaceAlbumsForRoot("music", [album]);
    database.createPhysicalCopy({
      id: "copy-cd",
      albumId: album.id,
      medium: "CD",
      label: null,
      catalogNumber: null,
      barcode: null,
      country: null,
      releaseYear: 1994,
      quantity: 1,
      conditionNote: null,
      storageLocation: "A-01",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    });

    database.replaceAlbumsForRoot("music", [album]);
    expect(database.getAlbum(album.id)?.physicalCopies).toHaveLength(1);
    database.replaceAlbumsForRoot("music", []);
    expect(database.getAlbum(album.id)).toEqual(
      expect.objectContaining({ trackCount: 0, physicalMedia: ["CD"] }),
    );
  });

  it("keeps duplicate source files linked while exposing and delivering only primary tracks", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    createRunningScan(database, "scan-copies");
    const primary = observedFile("Artist/Album CD2/01 Track.flac", 100);
    const duplicate = observedFile("Provider/Album/01 Track.flac", 101);
    database.upsertMediaFile("primary-file", "music", "scan-copies", primary);
    database.upsertMediaFile(
      "duplicate-file",
      "music",
      "scan-copies",
      duplicate,
    );
    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("album-copies", ["primary-file", "duplicate-file"]),
        primaryFileIds: ["primary-file"],
        fileDiscNumbers: { "primary-file": 2 },
        sourceVersionCount: 2,
        duplicateFileCount: 1,
      },
    ]);

    expect(database.getAlbum("album-copies")).toEqual(
      expect.objectContaining({
        trackCount: 1,
        sourceVersionCount: 2,
        duplicateFileCount: 1,
        tracks: [
          expect.objectContaining({ id: "primary-file", discNumber: 2 }),
        ],
      }),
    );
    expect(database.getLibraryStats()).toEqual(
      expect.objectContaining({ tracks: 1, files: 2 }),
    );
    expect(database.listAlbumDeliveryFiles("album-copies")).toEqual([
      expect.objectContaining({
        id: "primary-file",
        extension: ".flac",
        container: "flac",
        album: "Album",
        albumArtist: "Artist",
        title: "Track",
        artists: ["Artist"],
        discNumber: 1,
        discTotal: 1,
        discNumberOverride: 2,
        trackNumber: 1,
        trackTotal: 1,
      }),
    ]);
    database.raw
      .prepare(
        `UPDATE media_files SET artists_json='[" Artist ",42,null,"Artist","艺术家"]'
         WHERE id='primary-file'`,
      )
      .run();
    expect(database.listAlbumDeliveryFiles("album-copies")[0]?.artists).toEqual(
      ["Artist", "艺术家"],
    );
    database.raw
      .prepare("UPDATE media_files SET artists_json=? WHERE id='primary-file'")
      .run(JSON.stringify({ artist: "wrong-shape" }));
    expect(database.listAlbumDeliveryFiles("album-copies")[0]?.artists).toEqual(
      [],
    );
  });

  it("moves ownership, model copy, and delivery history onto a merged Album", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    createRunningScan(database, "scan-merge-history");
    database.upsertMediaFile(
      "merge-primary",
      "music",
      "scan-merge-history",
      observedFile("Qobuz/Album/01 Track.flac", 100),
    );
    database.upsertMediaFile(
      "merge-copy",
      "music",
      "scan-merge-history",
      observedFile("Archive/Album/01 Track.flac", 101),
    );
    database.replaceAlbumsForRoot("music", [
      albumInput("album-primary", ["merge-primary"]),
      albumInput("album-copy", ["merge-copy"]),
    ]);
    const timestamps = {
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    };
    database.createPhysicalCopy({
      id: "merged-cd",
      albumId: "album-copy",
      medium: "CD",
      label: null,
      catalogNumber: null,
      barcode: null,
      country: null,
      releaseYear: 2020,
      quantity: 1,
      conditionNote: null,
      storageLocation: null,
      ...timestamps,
    });
    database.createDeliveryTarget({
      id: "merged-target",
      deviceId: null,
      name: "SP3000M",
      kind: "NETWORK",
      transport: "AK_FILE_DROP",
      location: "ftp://192.0.2.1:1212",
      username: null,
      credentialConfigured: false,
      enabled: true,
      verifiedAt: null,
      ...timestamps,
    });
    database.createDeliveryJob({
      id: "merged-delivery",
      albumId: "album-copy",
      targetId: "merged-target",
      targetName: "SP3000M",
      transport: "AK_FILE_DROP",
      status: "COMPLETED",
      fileCount: 1,
      completedFileCount: 0,
      totalBytes: 101,
      transferredBytes: 101,
      verified: true,
      error: null,
      createdAt: timestamps.createdAt,
      startedAt: timestamps.createdAt,
      finishedAt: timestamps.createdAt,
      planId: "merge-plan",
    });
    database.saveAlbumIntroduction(
      {
        albumId: "album-copy",
        content: "A preserved introduction.",
        model: "test-model",
        factualBasis: ["local tags"],
        generatedAt: timestamps.createdAt,
      },
      "source-hash",
    );

    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("album-primary", ["merge-primary", "merge-copy"]),
        primaryFileIds: ["merge-primary"],
        sourceVersionCount: 2,
        duplicateFileCount: 1,
      },
    ]);

    expect(database.getAlbum("album-copy")).toBeNull();
    expect(database.getAlbum("album-primary")).toEqual(
      expect.objectContaining({ physicalMedia: ["CD"] }),
    );
    expect(database.listDeliveryJobs()).toEqual([
      expect.objectContaining({
        id: "merged-delivery",
        albumId: "album-primary",
        planId: "merge-plan",
      }),
    ]);
    expect(database.getAlbumIntroduction("album-primary")).toEqual(
      expect.objectContaining({ content: "A preserved introduction." }),
    );
  });

  it("keeps schema-12 delivery history unchanged through plan migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-plan-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "cocean.sqlite");
    const legacy = new BetterSqlite3(path);
    for (const migration of migrations.slice(0, 12)) {
      legacy.exec(migration.sql);
      legacy
        .prepare(
          "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, "2026-08-12T00:00:00.000Z");
    }
    legacy
      .prepare(
        `INSERT INTO library_roots (
          id, name, host_path_hint, container_path, policy, enabled,
          created_at, updated_at
        ) VALUES ('music', 'Music', NULL, '/library/music', 'WATCH_ONLY', 1, ?, ?)`,
      )
      .run("2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z");
    legacy
      .prepare(
        `INSERT INTO albums (
          id, root_id, group_key, title, album_artist, year, disc_count,
          track_count, audio_summary_json, audio_badge, mixed_audio_specs,
          artwork_json, match_status, created_at, updated_at
        ) VALUES (
          'album', 'music', 'album', 'Album', 'Artist', 2020, 1, 0,
          NULL, NULL, 0, '{}', 'NEEDS_REVIEW', ?, ?
        )`,
      )
      .run("2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z");
    legacy
      .prepare(
        `INSERT INTO delivery_targets (
          id, device_id, name, kind, transport, location, enabled,
          verified_at, created_at, updated_at, username, credential_json
        ) VALUES (
          'target', NULL, 'SP3000M', 'NETWORK', 'AK_FILE_DROP',
          'ftp://sp3000m.test/', 1, NULL, ?, ?, NULL, NULL
        )`,
      )
      .run("2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z");
    for (const id of ["old-one", "old-two"]) {
      legacy
        .prepare(
          `INSERT INTO delivery_jobs (
            id, album_id, target_id, target_name, transport, status,
            file_count, total_bytes, transferred_bytes, manifest_json,
            verified, error, created_at, started_at, finished_at
          ) VALUES (?, 'album', 'target', 'SP3000M', 'AK_FILE_DROP',
            'COMPLETED', 1, 20, 20, '[]', 1, NULL, ?, ?, ?)`,
        )
        .run(
          id,
          `2026-08-12T00:00:0${id === "old-one" ? "1" : "2"}.000Z`,
          "2026-08-12T00:00:00.000Z",
          "2026-08-12T00:01:00.000Z",
        );
    }
    const beforeRows = legacy
      .prepare("SELECT * FROM delivery_jobs ORDER BY id")
      .all() as Array<Record<string, unknown>>;
    const planMigration = migrations[12]!;
    legacy.exec(planMigration.sql);
    legacy
      .prepare(
        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
      )
      .run(
        planMigration.version,
        planMigration.name,
        "2026-08-12T00:00:00.000Z",
      );
    const rows = legacy
      .prepare("SELECT * FROM delivery_jobs ORDER BY id")
      .all() as Array<Record<string, unknown>>;
    expect(rows.map(({ plan_id: _planId, ...row }) => row)).toEqual(beforeRows);
    expect(rows.map((row) => row.plan_id)).toEqual([null, null]);
    legacy.close();
  });

  it("resolves authoritative target plans and returns complete plan siblings", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      albumInput("plan-album-one", []),
      albumInput("plan-album-two", []),
      albumInput("plan-album-three", []),
    ]);
    createDeliveryTarget(database, "plan-target-one");
    createDeliveryTarget(database, "plan-target-two");
    const now = Date.parse("2026-08-13T00:10:00.000Z");
    database.createDeliveryJob(
      deliveryJobInput("plan-job-one", "plan-album-one", "plan-target-one", {
        planId: "shared-plan",
        createdAt: "2026-08-13T00:00:00.000Z",
      }),
    );
    database.createDeliveryJob(
      deliveryJobInput("plan-job-two", "plan-album-two", "plan-target-one", {
        planId: "shared-plan",
        createdAt: "2026-08-13T00:01:00.000Z",
      }),
    );
    database.createDeliveryJob(
      deliveryJobInput(
        "plan-job-other",
        "plan-album-three",
        "plan-target-two",
        {
          planId: "other-plan",
          createdAt: "2026-08-13T00:02:00.000Z",
        },
      ),
    );

    expect(database.resolveDeliveryPlanId("plan-target-one", null, now)).toBe(
      "shared-plan",
    );
    expect(
      database.resolveDeliveryPlanId("plan-target-two", "shared-plan", now),
    ).toBeNull();
    expect(
      database.resolveDeliveryPlanId(
        "plan-target-one",
        "shared-plan",
        Date.parse("2026-08-13T00:30:00.000Z"),
      ),
    ).toBeNull();
    expect(database.listDeliveryJobs(1).map((job) => job.id)).toEqual([
      "plan-job-other",
    ]);
    expect(database.listDeliveryJobs(2).map((job) => job.id)).toEqual([
      "plan-job-other",
      "plan-job-two",
      "plan-job-one",
    ]);
  });

  it("rejects a second active job for the same Album and target", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [albumInput("active-album", [])]);
    createDeliveryTarget(database, "active-target");
    database.createDeliveryJob(
      deliveryJobInput("active-one", "active-album", "active-target"),
    );
    expect(() =>
      database.createDeliveryJob(
        deliveryJobInput("active-two", "active-album", "active-target"),
      ),
    ).toThrow(/active delivery already exists/);
  });

  it("finds an active delivery across every local version in a LibraryAlbum", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      { ...albumInput("delivery-primary", []), title: "Delivery Group" },
      { ...albumInput("delivery-secondary", []), title: "Delivery Group" },
    ]);
    createDeliveryTarget(database, "group-target");
    database.createDeliveryJob(
      deliveryJobInput(
        "secondary-active",
        "delivery-secondary",
        "group-target",
      ),
    );
    const groupId = database.getAlbumSummary("delivery-primary")!.id;
    for (const id of [groupId, "delivery-primary", "delivery-secondary"])
      expect(database.findActiveDeliveryJob(id, "group-target")?.id).toBe(
        "secondary-active",
      );
  });

  it("parses a legacy frozen delivery bundle without a profile version", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [albumInput("legacy-album", [])]);
    createDeliveryTarget(database, "legacy-target");
    database.createDeliveryJob(
      deliveryJobInput("legacy-job", "legacy-album", "legacy-target"),
    );
    const legacyBundle = {
      albumId: "legacy-album",
      title: "Album",
      albumArtist: "Artist",
      year: 2020,
      artwork: albumInput("legacy-album", []).artwork,
      files: [
        {
          id: "legacy-file",
          relativePath: "Artist/Album/01 Track.flac",
          rootPath: "/library/music",
          sizeBytes: 20,
          sha256: "a".repeat(64),
        },
      ],
      preparedArtwork: null,
    };
    database.raw
      .prepare(
        "UPDATE delivery_jobs SET source_bundle_json=? WHERE id='legacy-job'",
      )
      .run(JSON.stringify(legacyBundle));

    expect(database.getDeliveryJobSourceBundle("legacy-job")).toEqual(
      legacyBundle,
    );
  });

  it("stores device ownership separately from delivery targets", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const timestamps = {
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    };
    database.createOwnedDevice({
      id: "device-1",
      manufacturer: "Astell&Kern",
      model: "SP3000M",
      category: "DAP",
      ownership: "OWNED",
      nickname: null,
      serialNumber: null,
      notes: null,
      capabilities: {
        maxPcmSampleRate: null,
        maxPcmBitDepth: null,
        maxDsdRate: null,
        supportedFormats: [],
        source: null,
        verifiedAt: null,
      },
      ...timestamps,
    });
    database.createDeliveryTarget({
      id: "target-1",
      deviceId: "device-1",
      name: "USB staging",
      kind: "MOUNTED_VOLUME",
      transport: "USB_MOUNT",
      location: "/delivery/usb",
      username: null,
      credentialConfigured: false,
      enabled: true,
      verifiedAt: null,
      ...timestamps,
    });
    expect(database.listOwnedDevices()).toEqual([
      expect.objectContaining({ model: "SP3000M", ownership: "OWNED" }),
    ]);
    expect(database.listDeliveryTargets()).toEqual([
      expect.objectContaining({
        deviceId: "device-1",
        location: "/delivery/usb",
      }),
    ]);

    const original = database.getStoredDeliveryTarget("target-1");
    expect(original).not.toBeNull();
    expect(
      database.updateDeliveryTarget(
        {
          ...original!.target,
          name: "SP3000M · AK File Drop",
          kind: "NETWORK",
          transport: "AK_FILE_DROP",
          location: "ftp://192.168.1.20:1234/",
          username: "sp3000m",
          credentialConfigured: true,
          updatedAt: "2026-08-12T01:00:00.000Z",
        },
        "encrypted-password",
      ),
    ).toBe(true);
    expect(database.getStoredDeliveryTarget("target-1")).toEqual(
      expect.objectContaining({
        target: expect.objectContaining({
          transport: "AK_FILE_DROP",
          username: "sp3000m",
          credentialConfigured: true,
        }),
        credentialJson: "encrypted-password",
      }),
    );
  });

  it("keeps release matches as candidates until the user confirms one", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      {
        id: "album-match",
        rootId: "music",
        groupKey: "local artist\0local title",
        title: "Local Title",
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
    const candidate = {
      id: "candidate-1",
      albumId: "album-match",
      source: "MUSICBRAINZ" as const,
      sourceId: "f1b2d3c4-1111-4222-8333-123456789abc",
      title: "Remote Title",
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
    };

    database.replaceReleaseCandidates("album-match", [candidate]);
    expect(database.listReleaseCandidates("album-match")).toEqual([candidate]);
    expect(database.getAlbum("album-match")).toEqual(
      expect.objectContaining({
        title: "Local Title",
        albumArtist: "Local Artist",
        matchStatus: "NEEDS_REVIEW",
      }),
    );

    expect(
      database.confirmReleaseCandidate("album-match", "candidate-1"),
    ).toEqual(candidate);
    expect(database.getAlbum("album-match")).toEqual(
      expect.objectContaining({
        title: "Local Title",
        albumArtist: "Local Artist",
        matchStatus: "USER_CONFIRMED",
        release: expect.objectContaining({
          label: "Still Test",
          catalogNumber: "STILL-001",
          musicBrainzReleaseId: candidate.sourceId,
        }),
      }),
    );
    expect(
      database.confirmReleaseCandidate("album-match", "missing"),
    ).toBeNull();
    database.replaceAlbumsForRoot("music", []);
    expect(database.getAlbum("album-match")).toEqual(
      expect.objectContaining({
        trackCount: 0,
        matchStatus: "USER_CONFIRMED",
        release: expect.objectContaining({
          musicBrainzReleaseId: candidate.sourceId,
        }),
      }),
    );
  });

  it("installs and atomically activates versioned Still catalogs", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const makeCatalog = (contentVersion: string, stableEntityID: string) =>
      convertLegacyStillCore({
        schemaID: "still.local-curated-catalog",
        schemaVersion: "0.8.0",
        contentVersion,
        recordCount: 1,
        contentChecksum:
          contentVersion === "v1" ? "1".repeat(64) : "2".repeat(64),
        records: [
          {
            stableEntityID,
            entityKind: "album",
            canonicalTitle: `Album ${contentVersion}`,
            primaryArtist: "Artist",
            releaseFamilyID: `release-${contentVersion}`,
            recordingFamilyID: `recording-${contentVersion}`,
            musicDomains: ["ambient"],
            eligibleDomains: ["ambient"],
            features: ["musical.timbre:warm"],
            sourceKind: "verified_catalog",
            sourceRef: `https://example.test/${contentVersion}`,
            verificationStatus: "verified",
            editorialStatus: "accepted",
            contentVersion,
            verifiedAt: "2026-08-12T00:00:00.000Z",
          },
        ],
      });
    const first = makeCatalog("v1", "still-1");
    const second = makeCatalog("v2", "still-2");
    database.installStillCatalog(first);
    database.installStillCatalog(second);
    expect(database.getStillCatalogStatus()).toEqual(
      expect.objectContaining({ activeContentVersion: "v2", recordCount: 1 }),
    );
    expect(database.listActiveStillCatalogAlbums()).toEqual([
      expect.objectContaining({ id: "still-2", contentVersion: "v2" }),
    ]);
    expect(database.activateStillCatalogVersion("v1")).toBe(true);
    expect(database.listActiveStillCatalogAlbums()).toEqual([
      expect.objectContaining({ id: "still-1", contentVersion: "v1" }),
    ]);
    expect(() =>
      database.installStillCatalog({
        ...first,
        runtimeChecksum: second.runtimeChecksum,
      }),
    ).toThrow(/checksum|different content/);
  });

  it("counts paged albums and resolves an exact local identity for catalog recommendations", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      {
        id: "local-blue",
        rootId: "music",
        groupKey: "joni mitchell\0blue",
        title: "Blue",
        albumArtist: "Joni Mitchell",
        year: 1971,
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
      {
        id: "local-kind-of-blue",
        rootId: "music",
        groupKey: "miles davis\0kind of blue",
        title: "Kind of Blue",
        albumArtist: "Miles Davis",
        year: 1959,
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

    expect(database.countAlbums()).toBe(2);
    expect(database.countAlbums({ search: "blue" })).toBe(2);
    expect(database.listAlbums({ limit: 1, offset: 1 })).toHaveLength(1);
    expect(
      database.findAlbumSummaryByIdentity("blue", "joni mitchell"),
    ).toEqual(
      expect.objectContaining({
        primaryVersionId: "local-blue",
        title: "Blue",
      }),
    );
    expect(
      database.findAlbumSummaryByIdentity("Blue", "Miles Davis"),
    ).toBeNull();
  });

  it("uses albums.id as the deterministic pagination tie-breaker", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      { ...albumInput("same-z", []), title: "Album Z" },
      { ...albumInput("same-a", []), title: "Album A" },
      { ...albumInput("same-m", []), title: "Album M" },
    ]);

    for (const sort of ["ARTIST", "TITLE", "YEAR_DESC"] as const) {
      expect(
        [0, 1, 2].map(
          (offset) => database.listAlbums({ sort, limit: 1, offset })[0]?.title,
        ),
      ).toEqual(["Album A", "Album M", "Album Z"]);
    }
  });

  it("groups overlapping local versions under a stable identity and exposes concrete integrity evidence", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    createRunningScan(database, "scan-library-identity");
    const shortIds = ["short-1", "short-2"];
    const completeIds = Array.from(
      { length: 21 },
      (_, index) => `complete-${index + 1}`,
    );
    for (const [index, id] of [...shortIds, ...completeIds].entries()) {
      const file = observedFile(
        `Source/${id}/${String(index + 1).padStart(2, "0")} Track.flac`,
        100 + index,
      );
      file.tags.album = "Shared Album";
      file.tags.albumArtist = "Shared Artist";
      file.tags.trackNumber = index + 1;
      file.tags.trackTotal = id.startsWith("short") ? 2 : 21;
      database.upsertMediaFile(id, "music", "scan-library-identity", file);
    }
    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("short-version", shortIds),
        title: "Shared Album",
        albumArtist: "Shared Artist",
        aggregationIssues: [
          {
            code: "MISSING_TRACK",
            discNumber: 1,
            trackNumber: 3,
            expected: 21,
            actual: 2,
          },
        ],
      },
      {
        ...albumInput("complete-version", completeIds),
        title: "Shared Album",
        albumArtist: "Shared Artist",
      },
      {
        ...albumInput("healthy-version", []),
        title: "Healthy Album",
        albumArtist: "Shared Artist",
        artwork: {
          source: "SIDECAR",
          url: "/cover.jpg",
          mimeType: "image/jpeg",
          width: 1000,
          height: 1000,
        },
      },
    ]);

    const grouped = database.listAlbums({ search: "Shared Album" });
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toEqual(
      expect.objectContaining({
        versionCount: 2,
        primaryVersionId: "complete-version",
      }),
    );
    const stableId = grouped[0]!.id;
    expect(database.resolveLocalVersionId(stableId)).toBe("complete-version");
    expect(database.getAlbumDeliveryBundle(stableId)?.albumId).toBe(
      "complete-version",
    );
    expect(database.getAlbum("short-version")).toEqual(
      expect.objectContaining({
        id: stableId,
        localVersions: expect.arrayContaining([
          expect.objectContaining({
            id: "short-version",
            completeness: "INCOMPLETE",
            trackCount: 2,
          }),
          expect.objectContaining({
            id: "complete-version",
            isPrimary: true,
            trackCount: 21,
            completeness: "COMPLETE",
          }),
        ]),
      }),
    );
    expect(database.getAlbum(stableId)?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "IDENTITY_OVERLAP", versionId: null }),
      ]),
    );
    expect(
      database
        .getAlbum(stableId)
        ?.localVersions?.flatMap((version) =>
          version.issues.map((issue) => issue.code),
        ),
    ).not.toContain("IDENTITY_OVERLAP");
    expect(
      database
        .listAlbums({ issue: "INCOMPLETE_TRACKS" })
        .map((album) => album.id),
    ).toEqual([stableId]);
    expect(database.listAlbums({ search: "Healthy Album" })[0]?.issues).toEqual(
      [],
    );

    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("complete-version", completeIds),
        title: "Shared Album",
        albumArtist: "Shared Artist",
      },
      {
        ...albumInput("healthy-version", []),
        title: "Healthy Album",
        albumArtist: "Shared Artist",
        artwork: {
          source: "SIDECAR",
          url: "/cover.jpg",
          mimeType: "image/jpeg",
          width: 1000,
          height: 1000,
        },
      },
    ]);
    expect(database.listAlbums({ search: "Shared Album" })[0]?.id).toBe(
      stableId,
    );
  });

  it("allows separate USER groups for one identity while keeping one automatic group and unique group issues", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("auto-one", []),
        title: "Same Identity",
        albumArtist: "Artist",
      },
    ]);
    const key = "artist\0same identity";
    const now = "2026-08-13T00:00:00.000Z";
    const insert = database.raw.prepare(`INSERT INTO library_albums
      (id, identity_key, title, album_artist, primary_version_id, decision_source, created_at, updated_at)
      VALUES (?, ?, 'Same Identity', 'Artist', NULL, 'USER', ?, ?)`);
    insert.run("user-group-a", key, now, now);
    insert.run("user-group-b", key, now, now);
    expect(
      database.raw
        .prepare(
          "SELECT decision_source, COUNT(*) AS count FROM library_albums WHERE identity_key=? GROUP BY decision_source ORDER BY decision_source",
        )
        .all(key),
    ).toEqual([
      { decision_source: "AUTOMATIC", count: 1 },
      { decision_source: "USER", count: 2 },
    ]);
    expect(() =>
      database.raw
        .prepare(
          `INSERT INTO library_albums
        (id, identity_key, title, album_artist, primary_version_id, decision_source, created_at, updated_at)
        VALUES ('auto-duplicate', ?, 'Same Identity', 'Artist', NULL, 'AUTOMATIC', ?, ?)`,
        )
        .run(key, now, now),
    ).toThrow(/UNIQUE/);

    const groupId = database.listAlbums()[0]!.id;
    database.raw
      .prepare(
        `INSERT INTO library_issues
      (library_album_id, album_id, code, evidence_json, created_at, updated_at)
      VALUES (?, NULL, 'IDENTITY_OVERLAP', '{}', ?, ?)`,
      )
      .run(groupId, now, now);
    expect(() =>
      database.raw
        .prepare(
          `INSERT INTO library_issues
        (library_album_id, album_id, code, evidence_json, created_at, updated_at)
        VALUES (?, NULL, 'IDENTITY_OVERLAP', '{}', ?, ?)`,
        )
        .run(groupId, now, now),
    ).toThrow(/UNIQUE/);
  });

  it("rebuilds integrity issues atomically and idempotently", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const overlap = [
      { ...albumInput("atomic-a", []), title: "Atomic", albumArtist: "Artist" },
      { ...albumInput("atomic-b", []), title: "Atomic", albumArtist: "Artist" },
    ];
    database.replaceAlbumsForRoot("music", overlap);
    const before = database.raw
      .prepare(
        "SELECT library_album_id, album_id, code, created_at FROM library_issues ORDER BY code, album_id",
      )
      .all();
    database.replaceAlbumsForRoot("music", overlap);
    expect(
      database.raw
        .prepare(
          "SELECT library_album_id, album_id, code, created_at FROM library_issues ORDER BY code, album_id",
        )
        .all(),
    ).toEqual(before);

    database.raw.exec(`CREATE TEMP TRIGGER fail_integrity_rebuild
      BEFORE INSERT ON library_issues WHEN NEW.code='MIXED_AUDIO_SPECS'
      BEGIN SELECT RAISE(ABORT, 'forced rebuild failure'); END;`);
    expect(() =>
      database.replaceAlbumsForRoot("music", [
        ...overlap,
        {
          ...albumInput("atomic-failure", []),
          title: "Failure",
          albumArtist: "Artist",
          mixedAudioSpecs: true,
        },
      ]),
    ).toThrow(/forced rebuild failure/);
    expect(database.getAlbumSummary("atomic-failure")).toBeNull();
    expect(
      database.raw
        .prepare(
          "SELECT library_album_id, album_id, code, created_at FROM library_issues ORDER BY code, album_id",
        )
        .all(),
    ).toEqual(before);
  });

  it("detects concrete integrity issue boundaries and reports matching health counts", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    createRunningScan(database, "scan-issue-boundaries");
    const ids = [
      "missing-art",
      "low-599",
      "ok-600",
      "mixed",
      "broken",
      "fallback",
      "legacy-incomplete",
    ];
    for (const id of ids)
      database.upsertMediaFile(
        `${id}-file`,
        "music",
        "scan-issue-boundaries",
        observedFile(`${id}/01.flac`, 100),
      );
    database.raw
      .prepare(
        "UPDATE media_files SET album=NULL, album_artist=NULL, artists_json='[]' WHERE id='fallback-file'",
      )
      .run();
    const goodArtwork = {
      source: "SIDECAR" as const,
      url: "/cover.jpg",
      mimeType: "image/jpeg",
      width: 600,
      height: 600,
    };
    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("missing-art", ["missing-art-file"]),
        title: "Missing Art",
      },
      {
        ...albumInput("low-599", ["low-599-file"]),
        title: "Low Art",
        artwork: { ...goodArtwork, width: 599 },
      },
      {
        ...albumInput("ok-600", ["ok-600-file"]),
        title: "Good Art",
        artwork: goodArtwork,
      },
      {
        ...albumInput("mixed", ["mixed-file"]),
        title: "Mixed",
        artwork: goodArtwork,
        mixedAudioSpecs: true,
      },
      {
        ...albumInput("broken", ["broken-file"]),
        title: "Broken ï¿½",
        artwork: goodArtwork,
      },
      {
        ...albumInput("fallback", ["fallback-file"]),
        title: "Fallback",
        artwork: goodArtwork,
      },
      {
        ...albumInput("legacy-incomplete", ["legacy-incomplete-file"]),
        title: "Legacy",
        artwork: goodArtwork,
        matchStatus: "TRACKS_INCOMPLETE",
      },
    ]);
    const expected: Array<[string, string]> = [
      ["missing-art", "MISSING_ARTWORK"],
      ["low-599", "LOW_RES_ARTWORK"],
      ["mixed", "MIXED_AUDIO_SPECS"],
      ["broken", "BROKEN_TEXT"],
      ["fallback", "MISSING_IDENTITY"],
      ["legacy-incomplete", "INCOMPLETE_TRACKS"],
    ];
    for (const [albumId, code] of expected) {
      expect(database.getAlbum(albumId)?.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code })]),
      );
      expect(
        database
          .listAlbums({
            issue: code as import("@cocean/contracts").LibraryIssueCode,
          })
          .map((album) => album.primaryVersionId),
      ).toContain(albumId);
    }
    expect(database.getAlbum("ok-600")?.issues).toEqual([]);
    expect(
      database
        .getAlbum("broken")
        ?.issues.find((issue) => issue.code === "BROKEN_TEXT")?.evidence,
    ).toEqual({ fields: ["title"] });
    expect(database.getLibraryStats()).toEqual(
      expect.objectContaining({
        missingArtwork: 1,
        lowResolutionArtwork: 1,
        incompleteAlbums: 1,
        brokenIdentity: 2,
      }),
    );
  });

  it("prefers the version with usable artwork as the deterministic primary", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const goodArtwork = {
      source: "SIDECAR" as const,
      url: "/cover.jpg",
      mimeType: "image/jpeg",
      width: 600,
      height: 600,
    };
    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("artless", []),
        title: "Artwork Choice",
        albumArtist: "Artist",
      },
      {
        ...albumInput("artwork", []),
        title: "Artwork Choice",
        albumArtist: "Artist",
        artwork: goodArtwork,
      },
    ]);
    expect(database.listAlbums()[0]?.primaryVersionId).toBe("artwork");
  });

  it("does not call a shorter alternate edition incomplete without missing-track evidence", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    createRunningScan(database, "scan-editions");
    const versions = [
      { id: "standard", files: ["standard-1", "standard-2"] },
      { id: "deluxe", files: ["deluxe-1", "deluxe-2", "deluxe-3"] },
    ];
    for (const version of versions) {
      for (const [index, id] of version.files.entries()) {
        const file = observedFile(
          `${version.id}/${String(index + 1).padStart(2, "0")} Track.flac`,
          100 + index,
        );
        file.tags.album = "Edition Album";
        file.tags.albumArtist = "Edition Artist";
        file.tags.trackNumber = index + 1;
        file.tags.trackTotal = version.files.length;
        database.upsertMediaFile(id, "music", "scan-editions", file);
      }
    }
    database.replaceAlbumsForRoot(
      "music",
      versions.map((version) => ({
        ...albumInput(version.id, version.files),
        title: "Edition Album",
        albumArtist: "Edition Artist",
      })),
    );

    expect(database.listAlbums({ issue: "IDENTITY_OVERLAP" })).toHaveLength(1);
    expect(database.listAlbums({ issue: "INCOMPLETE_TRACKS" })).toEqual([]);
  });

  it("persists immutable per-scan evidence and a balanced report", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    createRunningScan(database, "scan-report");
    database.recordScanDiscovery({
      scanJobId: "scan-report",
      rulesVersion: "test-rules/1",
      candidates: 3,
      regularFiles: 5,
      auxiliaryFiles: 1,
      ignoredFiles: 1,
      skippedSymlinks: 1,
      traversalErrors: 0,
    });
    expect(() =>
      database.recordScanFileResult({
        scanJobId: "scan-report",
        rootId: "music",
        relativePath: "/library/music/private.flac",
        extension: ".flac",
        candidateKind: "SUPPORTED_AUDIO",
        outcome: "FAILED",
        mediaFileId: null,
        sizeBytes: null,
        modifiedAtMs: null,
        errorCode: "UNKNOWN",
        errorStage: "probe",
        warningCodes: [],
      }),
    ).toThrow(/relative/);
    const parsed = observedFile("Artist/Album/01 Parsed.flac", 1234);
    database.recordScanFileResult({
      scanJobId: "scan-report",
      rootId: "music",
      relativePath: parsed.relativePath,
      extension: ".flac",
      candidateKind: "SUPPORTED_AUDIO",
      outcome: "PARSED",
      mediaFileId: "file-parsed",
      sizeBytes: parsed.sizeBytes,
      modifiedAtMs: parsed.modifiedAtMs,
      errorCode: null,
      errorStage: null,
      warningCodes: [],
    });
    database.recordScanFileResult({
      scanJobId: "scan-report",
      rootId: "music",
      relativePath: "Artist/Album/disc.iso",
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
    database.recordScanFileResult({
      scanJobId: "scan-report",
      rootId: "music",
      relativePath: "Artist/Album/03 Broken.flac",
      extension: ".flac",
      candidateKind: "SUPPORTED_AUDIO",
      outcome: "FAILED",
      mediaFileId: null,
      sizeBytes: null,
      modifiedAtMs: null,
      errorCode: "FFPROBE_FAILED",
      errorStage: "probe",
      warningCodes: [],
    });
    database.recordScanFileResult({
      scanJobId: "scan-report",
      rootId: "music",
      relativePath: "Artist/Album/linked.flac",
      extension: ".flac",
      candidateKind: "SYMLINK",
      outcome: "SKIPPED",
      mediaFileId: null,
      sizeBytes: null,
      modifiedAtMs: null,
      errorCode: "SKIPPED_SYMLINK",
      errorStage: "discover",
      warningCodes: [],
    });
    const report = database.finalizeSuccessfulScan({
      scanJobId: "scan-report",
      rootId: "music",
      stagedFiles: [{ id: "file-parsed", file: parsed }],
      seenRelativePaths: [
        parsed.relativePath,
        "Artist/Album/disc.iso",
        "Artist/Album/03 Broken.flac",
      ],
      albums: [albumInput("album-report", ["file-parsed"])],
      withWarnings: true,
    });

    expect(report).toEqual(
      expect.objectContaining({
        status: "COMPLETED_WITH_WARNINGS",
        rulesVersion: "test-rules/1",
        candidates: 3,
        processed: 3,
        parsed: 1,
        unsupported: 1,
        failed: 1,
        unprocessed: 0,
        auxiliaryFiles: 1,
        ignoredFiles: 1,
        skippedSymlinks: 1,
        albumCount: 1,
        summaryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        invariants: expect.objectContaining({ valid: true }),
      }),
    );
    expect(
      database.listScanFileResults("scan-report", {
        outcome: "UNSUPPORTED",
        limit: 1,
      }),
    ).toEqual([
      expect.objectContaining({ relativePath: "Artist/Album/disc.iso" }),
    ]);
    expect(database.countScanFileResults("scan-report")).toBe(4);
    expect(database.getAlbum("album-report")?.tracks[0]?.sizeBytes).toBe(1234);
    expect(() =>
      database.raw
        .prepare("UPDATE scan_file_results SET outcome='FAILED' WHERE id=1")
        .run(),
    ).toThrow(/immutable/);
    expect(() =>
      database.finishScanJob("scan-report", "mutate history"),
    ).toThrow(/frozen|immutable/);
    expect(() =>
      database.raw
        .prepare("DELETE FROM scan_file_results WHERE scan_job_id=?")
        .run("scan-report"),
    ).toThrow(/immutable|frozen/);
    expect(() =>
      database.recordScanFileResult({
        scanJobId: "scan-report",
        rootId: "music",
        relativePath: "Artist/Album/late.flac",
        extension: ".flac",
        candidateKind: "SUPPORTED_AUDIO",
        outcome: "FAILED",
        mediaFileId: null,
        sizeBytes: null,
        modifiedAtMs: null,
        errorCode: "LATE_RESULT",
        errorStage: "test",
        warningCodes: [],
      }),
    ).toThrow(/immutable|frozen/);
    expect(() =>
      database.raw
        .prepare("DELETE FROM scan_jobs WHERE id=?")
        .run("scan-report"),
    ).toThrow(/immutable|frozen/);
  });

  it("rolls back a failed library finalize and preserves the previous snapshot", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    createRunningScan(database, "seed-scan");
    const oldFile = observedFile("Artist/Old/01 Old.flac", 100);
    database.upsertMediaFile("old-file", "music", "seed-scan", oldFile);
    database.replaceAlbumsForRoot("music", [
      albumInput("old-album", ["old-file"]),
    ]);
    database.finishScanJob("seed-scan");
    createRunningScan(database, "broken-finalize");
    database.recordScanDiscovery({
      scanJobId: "broken-finalize",
      rulesVersion: "test-rules/1",
      candidates: 1,
      regularFiles: 1,
      auxiliaryFiles: 0,
      ignoredFiles: 0,
      skippedSymlinks: 0,
      traversalErrors: 0,
    });
    const replacement = observedFile("Artist/New/01 New.flac", 200);
    database.recordScanFileResult({
      scanJobId: "broken-finalize",
      rootId: "music",
      relativePath: replacement.relativePath,
      extension: ".flac",
      candidateKind: "SUPPORTED_AUDIO",
      outcome: "PARSED",
      mediaFileId: "new-file",
      sizeBytes: replacement.sizeBytes,
      modifiedAtMs: replacement.modifiedAtMs,
      errorCode: null,
      errorStage: null,
      warningCodes: [],
    });

    expect(() =>
      database.finalizeSuccessfulScan({
        scanJobId: "broken-finalize",
        rootId: "music",
        stagedFiles: [{ id: "new-file", file: replacement }],
        seenRelativePaths: [replacement.relativePath],
        albums: [albumInput("new-album", ["missing-file-id"])],
        withWarnings: false,
      }),
    ).toThrow();
    expect(database.listMediaFilesForRoot("music")).toEqual([
      expect.objectContaining({ id: "old-file" }),
    ]);
    expect(database.getAlbum("old-album")).not.toBeNull();
    expect(database.getScanJob("broken-finalize")?.status).toBe("RUNNING");

    const report = database.finalizeFailedScan(
      "broken-finalize",
      "finalize failed",
      "test-rules/1",
    );
    expect(report).toEqual(
      expect.objectContaining({
        status: "FAILED",
        parsed: 1,
        albumCount: null,
      }),
    );
  });

  it("marks interrupted RUNNING jobs failed instead of leaving them stuck", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    createRunningScan(database, "interrupted-scan");
    database.recordScanDiscovery({
      scanJobId: "interrupted-scan",
      rulesVersion: "test-rules/1",
      candidates: 2,
      regularFiles: 2,
      auxiliaryFiles: 0,
      ignoredFiles: 0,
      skippedSymlinks: 0,
      traversalErrors: 0,
    });
    const reports = database.recoverRunningScanJobs(
      "worker lease expired",
      "test-rules/1",
    );
    expect(reports).toEqual([
      expect.objectContaining({
        status: "FAILED",
        candidates: 2,
        processed: 0,
        unprocessed: 2,
      }),
    ]);
    expect(database.getScanJob("interrupted-scan")?.status).toBe("FAILED");
  });
});

function createRunningScan(database: CoceanDatabase, id: string): void {
  database.createScanJob({
    id,
    rootId: "music",
    mode: "FULL",
    status: "QUEUED",
    totalFiles: 0,
    processedFiles: 0,
    parsedFiles: 0,
    failedFiles: 0,
    reusedFiles: 0,
    createdAt: "2026-08-12T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    error: null,
    cancelRequestedAt: null,
  });
  expect(database.claimNextScanJob()?.id).toBe(id);
}

function observedFile(relativePath: string, sizeBytes: number) {
  return {
    absolutePath: `/library/music/${relativePath}`,
    relativePath,
    extension: ".flac",
    sizeBytes,
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
    durationSeconds: 60,
    tags: {
      album: "Album",
      albumArtist: "Artist",
      title: "Track",
      artists: ["Artist"],
      year: 2020,
      date: "2020",
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
}

function albumInput(id: string, fileIds: string[]) {
  return {
    id,
    rootId: "music",
    groupKey: id,
    title: "Album",
    albumArtist: "Artist",
    year: 2020,
    discCount: 1,
    fileIds,
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
    aggregationIssues: [],
  };
}

function scanJobInput(id: string) {
  return {
    id,
    rootId: "music",
    mode: "INCREMENTAL" as const,
    status: "QUEUED" as const,
    totalFiles: 0,
    processedFiles: 0,
    parsedFiles: 0,
    failedFiles: 0,
    reusedFiles: 0,
    createdAt: "2026-08-12T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    error: null,
    cancelRequestedAt: null,
  };
}

function createDeliveryTarget(database: CoceanDatabase, id: string): void {
  database.createDeliveryTarget({
    id,
    deviceId: null,
    name: id,
    kind: "NETWORK",
    transport: "AK_FILE_DROP",
    location: `ftp://${id}.example.test/`,
    username: null,
    credentialConfigured: false,
    enabled: true,
    verifiedAt: null,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  });
}

function deliveryJobInput(
  id: string,
  albumId: string,
  targetId: string,
  overrides: { planId?: string; createdAt?: string } = {},
) {
  return {
    id,
    albumId,
    targetId,
    targetName: targetId,
    transport: "AK_FILE_DROP" as const,
    status: "QUEUED" as const,
    fileCount: 1,
    completedFileCount: 0,
    totalBytes: 20,
    transferredBytes: 0,
    verified: false,
    error: null,
    createdAt: overrides.createdAt ?? "2026-08-13T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    planId: overrides.planId ?? null,
  };
}
