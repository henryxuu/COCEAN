import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { albumAddedAtSchema } from "@cocean/contracts";
import {
  AlbumArtworkDecisionError,
  AlbumMetadataDecisionError,
  CoceanDatabase,
  LibraryLifecycleError,
  OrphanGovernanceError,
  countClosedInventoryPartitionEntries,
} from "./client.js";
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
  it("counts only members of the closed inventory partition", () => {
    expect(
      countClosedInventoryPartitionEntries([
        "CURRENT_DIGITAL",
        "PHYSICAL_ONLY",
        "REFERENCED_HISTORY",
        "ORPHAN",
      ]),
    ).toBe(4);
    expect(
      countClosedInventoryPartitionEntries(["CURRENT_DIGITAL", "UNKNOWN"]),
    ).toBe(1);
  });

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

  it("migrates schema 18 integrity rows to schema 19 without changing prior governance", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "cocean-artwork-migration-"),
    );
    temporaryDirectories.push(directory);
    const path = join(directory, "cocean.sqlite");
    const legacy = new BetterSqlite3(path);
    for (const migration of migrations.slice(0, 18)) {
      legacy.exec(migration.sql);
      legacy
        .prepare(
          "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, "2026-08-14T00:00:00.000Z");
    }
    legacy
      .prepare(
        `INSERT INTO albums
         (id,root_id,group_key,title,album_artist,disc_count,track_count,
          artwork_json,match_status,created_at,updated_at)
         VALUES ('legacy-version','physical','legacy-version','Broken �','Artist',1,0,
                 '{"source":"NONE","url":null,"mimeType":null,"width":null,"height":null}',
                 'UNMATCHED',?,?)`,
      )
      .run("2026-08-14T00:00:00.000Z", "2026-08-14T00:00:00.000Z");
    legacy
      .prepare(
        `INSERT INTO library_albums
         (id,identity_key,title,album_artist,primary_version_id,decision_source,
          primary_version_source,revision,metadata_revision,created_at,updated_at)
         VALUES ('legacy-art',?,'Broken �','Artist','legacy-version','USER',
                 'AUTOMATIC',7,4,?,?)`,
      )
      .run(
        "artist\0album",
        "2026-08-14T00:00:00.000Z",
        "2026-08-14T00:00:00.000Z",
      );
    legacy
      .prepare(
        `INSERT INTO library_album_members
         (library_album_id,album_id,relationship_status,created_at,updated_at)
         VALUES ('legacy-art','legacy-version','USER_CONFIRMED',?,?)`,
      )
      .run("2026-08-14T00:00:00.000Z", "2026-08-14T00:00:00.000Z");
    legacy
      .prepare(
        `INSERT INTO library_metadata_values
         (scope_type,owner_id,field_name,source_type,value_json,evidence_json,
          actor_id,actor_display_name,created_at,updated_at)
         VALUES ('ALBUM','legacy-art','title','USER_OVERRIDE','"Curated"','{}',
                 'admin','Admin',?,?)`,
      )
      .run("2026-08-14T00:00:00.000Z", "2026-08-14T00:00:00.000Z");
    legacy
      .prepare(
        `INSERT INTO library_issues
         (library_album_id,album_id,code,evidence_json,created_at,updated_at,resolution_status)
         VALUES ('legacy-art',NULL,'BROKEN_TEXT','{"legacy":true}',?,?,
                 'RESOLVED_BY_METADATA')`,
      )
      .run("2026-08-14T00:00:00.000Z", "2026-08-14T00:00:00.000Z");
    legacy.close();

    const database = new CoceanDatabase(path);
    open.push(database);
    expect(
      database.raw
        .prepare(
          `SELECT revision,metadata_revision,artwork_revision,effective_artwork_source
           FROM library_albums WHERE id='legacy-art'`,
        )
        .get(),
    ).toEqual({
      revision: 7,
      metadata_revision: 4,
      artwork_revision: 1,
      effective_artwork_source: "NONE",
    });
    expect(
      database.raw
        .prepare(
          `SELECT evidence_json,resolution_status FROM library_issues
           WHERE library_album_id='legacy-art'`,
        )
        .get(),
    ).toEqual({
      evidence_json: expect.any(String),
      resolution_status: "RESOLVED_BY_METADATA",
    });
    expect(
      database.raw
        .prepare(
          "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ version: 21 });
    expect(database.getAlbumSummary("legacy-art")?.addedAt).toBe(
      "2026-08-14T00:00:00.000Z",
    );
    expect(
      (
        database.raw
          .prepare("PRAGMA table_info(library_albums)")
          .all() as Array<{
          name: string;
        }>
      ).some((column) => column.name === "added_at"),
    ).toBe(false);
    open.splice(open.indexOf(database), 1);
    database.close();
    const reopened = new CoceanDatabase(path);
    open.push(reopened);
    expect(reopened.getAlbumSummary("legacy-art")?.addedAt).toBe(
      "2026-08-14T00:00:00.000Z",
    );
  });

  it("upgrades schema 20 to additive schema 21 without rewriting library data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-orphan-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "cocean.sqlite");
    const legacy = new BetterSqlite3(path);
    for (const migration of migrations.slice(0, 20)) {
      legacy.exec(migration.sql);
      legacy
        .prepare(
          "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, "2026-08-16T00:00:00.000Z");
    }
    legacy
      .prepare(
        `INSERT INTO albums
         (id,root_id,group_key,title,album_artist,disc_count,track_count,
          artwork_json,match_status,created_at,updated_at)
         VALUES ('schema20-version','physical','schema20-version','Schema 20','Artist',
                 1,0,'[]','UNMATCHED',?,?)`,
      )
      .run("2026-08-16T00:00:00.000Z", "2026-08-16T00:00:00.000Z");
    const schema20AddedAt = "2025-05-06T07:08:09.000Z";
    legacy
      .prepare(
        `INSERT INTO library_albums
         (id,identity_key,title,album_artist,primary_version_id,decision_source,
          primary_version_source,revision,created_at,updated_at)
         VALUES ('schema20-library',?,'Schema 20','Artist','schema20-version',
                 'AUTOMATIC','AUTOMATIC',0,?,?)`,
      )
      .run("artist\0schema 20", schema20AddedAt, schema20AddedAt);
    legacy
      .prepare(
        `INSERT INTO library_album_members
         (library_album_id,album_id,relationship_status,created_at,updated_at)
         VALUES ('schema20-library','schema20-version','AUTO_CANDIDATE',?,?)`,
      )
      .run(schema20AddedAt, schema20AddedAt);
    legacy.close();

    let database = new CoceanDatabase(path);
    open.push(database);
    expect(
      database.raw
        .prepare(
          "SELECT version,name FROM schema_migrations ORDER BY version DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ version: 21, name: "safe_orphan_governance" });
    expect(
      database.raw
        .prepare("SELECT id,title FROM albums WHERE id='schema20-version'")
        .get(),
    ).toEqual({ id: "schema20-version", title: "Schema 20" });
    expect(
      database.raw
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type='trigger' AND name IN (
             'library_orphan_governance_events_no_update',
             'library_orphan_governance_events_no_delete'
           )`,
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      database.raw
        .prepare("PRAGMA foreign_key_list(library_orphan_governance_events)")
        .all(),
    ).toEqual([]);
    expect(database.getAlbumSummary("schema20-library")?.addedAt).toBe(
      schema20AddedAt,
    );
    open.splice(open.indexOf(database), 1);
    database.close();
    database = new CoceanDatabase(path);
    open.push(database);
    expect(database.getAlbumSummary("schema20-library")?.addedAt).toBe(
      schema20AddedAt,
    );
    const insertEvent = database.raw.prepare(
      `INSERT INTO library_orphan_governance_events
       (id,request_id,local_version_id,status,action,actor_id,
        actor_display_name,input_json,expected_fingerprint,result_json,
        error_code,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    insertEvent.run(
      "schema21-event",
      "schema21-request",
      "already-disappeared-version",
      "REJECTED",
      "CLOSE_ORPHAN_IDENTITY",
      "admin",
      "Admin",
      "{}",
      "a".repeat(64),
      "{}",
      "ORPHAN_TARGET_NOT_FOUND",
      "2026-08-16T00:00:00.000Z",
    );
    expect(() =>
      insertEvent.run(
        "schema21-event-two",
        "schema21-request",
        "another-version",
        "REJECTED",
        "CLOSE_ORPHAN_IDENTITY",
        "admin",
        "Admin",
        "{}",
        "b".repeat(64),
        "{}",
        "ORPHAN_TARGET_NOT_FOUND",
        "2026-08-16T00:00:00.000Z",
      ),
    ).toThrow(/UNIQUE/);
    expect(
      database.raw
        .prepare("DELETE FROM albums WHERE id='schema20-version'")
        .run().changes,
    ).toBe(1);
    expect(
      database.raw
        .prepare(
          "SELECT local_version_id FROM library_orphan_governance_events WHERE id='schema21-event'",
        )
        .get(),
    ).toEqual({ local_version_id: "already-disappeared-version" });
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
        schemaVersion: 21,
        migrationCount: 21,
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
        `UPDATE albums SET match_status='USER_CONFIRMED',label='Legacy Label',
         catalog_number='LEG-001',barcode='1234567890123',country='GB',
         release_date='2020-02-03',
         musicbrainz_release_id='aaaaaaaa-1111-4222-8333-123456789abc'
         WHERE id='legacy-complete'`,
      )
      .run();
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
    const migratedRelease = upgraded
      .getAlbumMetadata("legacy-complete")!
      .versions.find((version) => version.versionId === "legacy-complete")!;
    for (const [field, value] of Object.entries({
      label: "Legacy Label",
      catalogNumber: "LEG-001",
      barcode: "1234567890123",
      country: "GB",
      releaseDate: "2020-02-03",
    }))
      expect(
        migratedRelease.fields[field as keyof typeof migratedRelease.fields]
          .confirmedExternal,
      ).toEqual(
        expect.objectContaining({
          value,
          provider: "MUSICBRAINZ",
          candidateId: "aaaaaaaa-1111-4222-8333-123456789abc",
        }),
      );
    expect(
      upgraded.raw
        .prepare(
          "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1",
        )
        .get(),
    ).toEqual({
      version: 21,
      name: "safe_orphan_governance",
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

    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM albums WHERE id='album-copy'")
        .get(),
    ).toEqual({ count: 1 });
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
        title: "Remote Title",
        albumArtist: "Remote Artist",
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

  it("applies metadata SET CLEAR RESET atomically with exact idempotency and append-only undo", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      {
        id: "metadata-album",
        rootId: "music",
        groupKey: "artist\0observed",
        title: "Observed Title",
        albumArtist: "Observed Artist",
        year: 2001,
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
    const libraryId = database.getAlbumSummary("metadata-album")!.id;
    const actor = { id: "admin", displayName: "Admin" };
    const input = {
      requestId: "metadata-request-1",
      expectedMetadataRevision: 0,
      commands: [
        {
          action: "SET" as const,
          field: "title" as const,
          value: "Fixed Title",
        },
        { action: "CLEAR" as const, field: "year" as const },
      ],
    };
    const first = database.applyAlbumMetadata(libraryId, input, actor);
    expect(first.metadata).toEqual(
      expect.objectContaining({
        metadataRevision: 1,
        album: expect.objectContaining({
          title: expect.objectContaining({
            effectiveValue: "Fixed Title",
            effectiveSource: "USER_OVERRIDE",
            observed: expect.objectContaining({ value: "Observed Title" }),
          }),
          year: expect.objectContaining({
            effectiveValue: null,
            effectiveSource: "USER_OVERRIDE",
            observed: expect.objectContaining({ value: 2001 }),
          }),
        }),
      }),
    );
    expect(database.applyAlbumMetadata(libraryId, input, actor).event.id).toBe(
      first.event.id,
    );
    expect(database.getAlbumMetadata(libraryId)?.metadataRevision).toBe(1);
    expect(database.getAlbumSummary(libraryId)?.year).toBeNull();
    expect(database.listAlbums()[0]?.year).toBeNull();
    expect(database.getAlbum(libraryId)?.year).toBeNull();
    expect(database.getAlbumDeliveryBundle(libraryId)?.year).toBeNull();
    expect(() =>
      database.applyAlbumMetadata(
        libraryId,
        { ...input, commands: [{ action: "RESET", field: "title" }] },
        actor,
      ),
    ).toThrowError(AlbumMetadataDecisionError);
    expect(() =>
      database.applyAlbumMetadata(
        libraryId,
        {
          requestId: "metadata-invalid",
          expectedMetadataRevision: 1,
          commands: [
            { action: "SET", field: "albumArtist", value: "Must Roll Back" },
            {
              action: "SET",
              field: "label",
              versionId: "missing-version",
              value: "Invalid",
            },
          ],
        },
        actor,
      ),
    ).toThrowError(AlbumMetadataDecisionError);
    expect(database.getAlbum(libraryId)?.albumArtist).toBe("Observed Artist");

    const undone = database.undoAlbumMetadataEvent(
      libraryId,
      first.event.id,
      "metadata-undo-1",
      1,
      actor,
    );
    expect(undone.metadata.metadataRevision).toBe(2);
    expect(undone.metadata.album.title.effectiveValue).toBe("Observed Title");
    expect(undone.metadata.album.year.effectiveValue).toBe(2001);
    expect(database.listAlbumMetadataHistory(libraryId)).toEqual([
      expect.objectContaining({
        type: "UNDO",
        compensatesEventId: first.event.id,
      }),
      expect.objectContaining({ type: "UPDATE", canUndo: false }),
    ]);
  });

  it("preserves album overrides across primary changes and rejects conflicting metadata merges", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const base = {
      rootId: "music",
      title: "Grouped",
      albumArtist: "Artist",
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
    };
    database.replaceAlbumsForRoot("music", [
      { ...base, id: "group-a", groupKey: "a", year: 2000 },
      { ...base, id: "group-b", groupKey: "b", year: 2001 },
      {
        ...base,
        id: "other",
        groupKey: "other",
        title: "Other",
        year: 2002,
      },
    ]);
    const grouped = database.getAlbumSummary("group-a")!;
    const other = database.getAlbumSummary("other")!;
    const actor = { id: "admin", displayName: "Admin" };
    database.applyAlbumMetadata(
      grouped.id,
      {
        requestId: "group-title",
        expectedMetadataRevision: 0,
        commands: [{ action: "SET", field: "title", value: "Curated" }],
      },
      actor,
    );
    database.applyAlbumMetadata(
      other.id,
      {
        requestId: "other-title",
        expectedMetadataRevision: 0,
        commands: [{ action: "SET", field: "title", value: "Different" }],
      },
      actor,
    );
    const alternate = database
      .getAlbum(grouped.id)!
      .localVersions!.find((version) => !version.isPrimary)!;
    database.applyLibraryIdentityDecision(
      grouped.id,
      {
        type: "SET_PRIMARY",
        requestId: "set-primary-metadata",
        revision: grouped.revision,
        primaryVersionId: alternate.id,
      },
      actor,
    );
    expect(database.getAlbum(grouped.id)).toEqual(
      expect.objectContaining({ title: "Curated", metadataRevision: 2 }),
    );
    expect(() =>
      database.applyLibraryIdentityDecision(
        grouped.id,
        {
          type: "MERGE",
          requestId: "merge-metadata-conflict",
          revision: database.getAlbumSummary(grouped.id)!.revision,
          targetLibraryAlbumId: other.id,
          targetRevision: other.revision,
          primaryVersionId: alternate.id,
        },
        actor,
      ),
    ).toThrowError(/字段冲突/);
    expect(database.getAlbum(grouped.id)?.title).toBe("Curated");
    expect(database.getAlbum(other.id)?.title).toBe("Different");
  });

  it("keeps album overrides on the primary partition and moves version metadata during a split", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const album = (id: string) => ({
      ...albumInput(id, []),
      title: "Split Governed",
      albumArtist: "Split Artist",
      year: 2004,
    });
    database.replaceAlbumsForRoot("music", [
      album("metadata-split-a"),
      album("metadata-split-b"),
    ]);
    const parent = database.getAlbumSummary("metadata-split-a")!;
    const primaryVersionId = parent.primaryVersionId!;
    const childVersionId =
      primaryVersionId === "metadata-split-a"
        ? "metadata-split-b"
        : "metadata-split-a";
    const candidate = {
      id: "metadata-split-candidate",
      albumId: childVersionId,
      source: "MUSICBRAINZ" as const,
      sourceId: "a1b2c3d4-1111-4222-8333-123456789abc",
      title: "Split Governed",
      artistCredit: "Split Artist",
      releaseDate: "2004-01-02",
      country: "GB",
      status: "Official",
      barcode: "1234567890123",
      labels: ["Child Label"],
      catalogNumbers: ["CHILD-001"],
      mediaFormats: ["CD"],
      trackCount: 1,
      coverArtAvailable: false,
      sourceScore: 99,
      fetchedAt: "2026-08-12T00:00:00.000Z",
    };
    database.replaceReleaseCandidates(parent.id, [candidate], childVersionId);
    database.confirmReleaseCandidateMetadata(
      parent.id,
      candidate.id,
      childVersionId,
      "metadata-split-confirm",
      0,
      { id: "admin", displayName: "Admin" },
    );
    database.applyAlbumMetadata(
      parent.id,
      {
        requestId: "metadata-split-override",
        expectedMetadataRevision: 1,
        commands: [{ action: "SET", field: "title", value: "Primary Curated" }],
      },
      { id: "admin", displayName: "Admin" },
    );

    database.applyLibraryIdentityDecision(
      parent.id,
      {
        type: "SPLIT",
        requestId: "metadata-split",
        revision: parent.revision,
        partitions: [
          { versionIds: [primaryVersionId] },
          { versionIds: [childVersionId] },
        ],
      },
      { id: "admin", displayName: "Admin" },
    );

    const child = database.getAlbum(childVersionId)!;
    expect(database.getAlbum(parent.id)?.title).toBe("Primary Curated");
    expect(child.metadata?.album.title).toEqual(
      expect.objectContaining({
        userOverride: null,
        effectiveValue: "Split Governed",
        effectiveSource: "CONFIRMED_EXTERNAL",
      }),
    );
    expect(child.release).toEqual(
      expect.objectContaining({
        label: "Child Label",
        catalogNumber: "CHILD-001",
      }),
    );
  });

  it("keeps governed values and stable ownership when rescanned observations change", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const observed = (title: string, artist: string, year: number) => ({
      id: "rescan-version",
      rootId: "music",
      groupKey: "rescan-version",
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
      observed("Broken", "Observed Artist", 2000),
    ]);
    const libraryId = database.getAlbumSummary("rescan-version")!.id;
    database.applyAlbumMetadata(
      libraryId,
      {
        requestId: "rescan-override",
        expectedMetadataRevision: 0,
        commands: [{ action: "SET", field: "title", value: "Curated Title" }],
      },
      { id: "admin", displayName: "Admin" },
    );
    database.replaceAlbumsForRoot("music", [
      observed("New Scan Title", "New Scan Artist", 2001),
    ]);
    const rescanned = database.getAlbum(libraryId)!;
    expect(rescanned).toEqual(
      expect.objectContaining({
        id: libraryId,
        title: "Curated Title",
        albumArtist: "New Scan Artist",
        year: 2001,
        metadataRevision: 2,
      }),
    );
    expect(rescanned.metadata?.album.title).toEqual(
      expect.objectContaining({
        observed: expect.objectContaining({ value: "New Scan Title" }),
        effectiveValue: "Curated Title",
      }),
    );
    expect(database.listAlbums({ search: "Curated Title" })).toHaveLength(1);
    expect(database.listAlbums({ search: "New Scan Title" })).toHaveLength(0);
    expect(database.getAlbumDeliveryBundle(libraryId)?.title).toBe(
      "Curated Title",
    );
    const frozen = {
      ...database.getAlbumDeliveryBundle(libraryId)!,
      files: [],
      preparedArtwork: null,
    };
    createDeliveryTarget(database, "metadata-freeze-target");
    database.createDeliveryJob(
      deliveryJobInput(
        "metadata-freeze-job",
        "rescan-version",
        "metadata-freeze-target",
      ),
      frozen,
    );
    database.applyAlbumMetadata(
      libraryId,
      {
        requestId: "metadata-after-queue",
        expectedMetadataRevision: 2,
        commands: [
          { action: "SET", field: "title", value: "Edited After Queue" },
        ],
      },
      { id: "admin", displayName: "Admin" },
    );
    expect(database.getAlbumDeliveryBundle(libraryId)?.title).toBe(
      "Edited After Queue",
    );
    expect(
      database.getDeliveryJobSourceBundle("metadata-freeze-job")?.title,
    ).toBe("Curated Title");
  });

  it("keeps governed LocalVersions through temporary disappearance and revisions USER observations", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const observed = (title: string, label: string | null) => ({
      ...albumInput("protected-version", []),
      title,
      label,
      catalogNumber: label ? "CAT-1" : null,
      barcode: label ? "12345678" : null,
    });
    database.replaceAlbumsForRoot("music", [observed("Before", "Old Label")]);
    const group = database.getAlbumSummary("protected-version")!;
    database.applyLibraryIdentityDecision(
      group.id,
      { type: "CONFIRM", requestId: "protect-confirm", revision: 0 },
      { id: "admin", displayName: "Admin" },
    );
    database.applyAlbumMetadata(
      group.id,
      {
        requestId: "protect-version-field",
        expectedMetadataRevision: 0,
        commands: [
          {
            action: "SET",
            field: "label",
            versionId: "protected-version",
            value: "Curated Label",
          },
        ],
      },
      { id: "admin", displayName: "Admin" },
    );
    database.replaceAlbumsForRoot("music", []);
    expect(database.getAlbum(group.id)).toEqual(
      expect.objectContaining({ primaryVersionId: "protected-version" }),
    );
    database.replaceAlbumsForRoot("music", [observed("After", null)]);
    const restored = database.getAlbum(group.id)!;
    expect(restored.title).toBe("After");
    expect(restored.metadataRevision).toBeGreaterThan(1);
    expect(restored.metadata?.versions[0]?.fields.label).toEqual(
      expect.objectContaining({
        observed: expect.objectContaining({ value: null }),
        effectiveValue: "Curated Label",
      }),
    );
    expect(
      database.raw
        .prepare(
          "SELECT label,catalog_number,barcode FROM albums WHERE id='protected-version'",
        )
        .get(),
    ).toEqual({ label: null, catalog_number: null, barcode: null });
  });

  it("replaces external candidate fields, replays after candidate deletion, and undoes release state", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      albumInput("candidate-replace", []),
    ]);
    const group = database.getAlbumSummary("candidate-replace")!;
    const candidate = (id: string, complete: boolean) => ({
      id,
      albumId: "candidate-replace",
      source: "MUSICBRAINZ" as const,
      sourceId:
        id === "11111111"
          ? "11111111-1111-4222-8333-123456789abc"
          : "22222222-1111-4222-8333-123456789abc",
      title: `Title ${id}`,
      artistCredit: "Artist",
      releaseDate: complete ? "2020-01-02" : null,
      country: complete ? "GB" : null,
      status: "Official",
      barcode: complete ? "1234567890123" : null,
      labels: complete ? ["First Label"] : [],
      catalogNumbers: complete ? ["FIRST-1"] : [],
      mediaFormats: ["CD"],
      trackCount: 1,
      coverArtAvailable: false,
      sourceScore: 90,
      fetchedAt: "2026-08-12T00:00:00.000Z",
    });
    const first = candidate("11111111", true);
    database.replaceReleaseCandidates(group.id, [first], "candidate-replace");
    database.confirmReleaseCandidateMetadata(
      group.id,
      first.id,
      "candidate-replace",
      "candidate-first",
      0,
      { id: "admin", displayName: "Admin" },
    );
    const second = candidate("22222222", false);
    database.replaceReleaseCandidates(group.id, [second], "candidate-replace");
    const confirmed = database.confirmReleaseCandidateMetadata(
      group.id,
      second.id,
      "candidate-replace",
      "candidate-second",
      1,
      { id: "admin", displayName: "Admin" },
    )!;
    expect(database.getAlbum(group.id)?.release).toEqual(
      expect.objectContaining({
        label: null,
        catalogNumber: null,
        barcode: null,
      }),
    );
    database.replaceReleaseCandidates(group.id, [], "candidate-replace");
    expect(
      database.confirmReleaseCandidateMetadata(
        group.id,
        second.id,
        "candidate-replace",
        "candidate-second",
        1,
        { id: "admin", displayName: "Admin" },
      )?.candidate,
    ).toEqual(second);
    database.undoAlbumMetadataEvent(
      group.id,
      confirmed.result.event.id,
      "candidate-second-undo",
      2,
      { id: "admin", displayName: "Admin" },
    );
    expect(database.getAlbum(group.id)?.release).toEqual(
      expect.objectContaining({
        label: "First Label",
        musicBrainzReleaseId: first.sourceId,
      }),
    );
  });

  it("resolves broken and fallback identity issues without deleting evidence and RESET reopens them", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.createScanJob(scanJobInput("issue-scan"));
    database.upsertMediaFile("issue-file", "music", "issue-scan", {
      ...observedFile("Broken/01.flac", 20),
      tags: {
        ...observedFile("Broken/01.flac", 20).tags,
        album: null,
        albumArtist: null,
        artists: [],
      },
    });
    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("issue-album", ["issue-file"]),
        title: "Bad\uFFFD",
        albumArtist: "锟斤拷",
      },
    ]);
    const group = database.getAlbumSummary("issue-album")!;
    expect(database.getLibraryStats().brokenIdentity).toBe(1);
    database.applyAlbumMetadata(
      group.id,
      {
        requestId: "issue-fix",
        expectedMetadataRevision: 0,
        commands: [
          { action: "SET", field: "title", value: "Good Title" },
          { action: "SET", field: "albumArtist", value: "Good Artist" },
        ],
      },
      { id: "admin", displayName: "Admin" },
    );
    expect(database.getAlbum(group.id)?.issues).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ code: "BROKEN_TEXT" }),
        expect.objectContaining({ code: "MISSING_IDENTITY" }),
      ]),
    );
    expect(database.listAlbums({ issue: "BROKEN_TEXT" })).toEqual([]);
    expect(database.getLibraryStats().brokenIdentity).toBe(0);
    expect(database.getAlbumMetadata(group.id)?.observedIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "BROKEN_TEXT",
          resolutionStatus: "RESOLVED_BY_METADATA",
        }),
        expect.objectContaining({
          code: "MISSING_IDENTITY",
          resolutionStatus: "RESOLVED_BY_METADATA",
        }),
      ]),
    );
    database.applyAlbumMetadata(
      group.id,
      {
        requestId: "issue-reset",
        expectedMetadataRevision: 1,
        commands: [
          { action: "RESET", field: "title" },
          { action: "RESET", field: "albumArtist" },
        ],
      },
      { id: "admin", displayName: "Admin" },
    );
    expect(database.getLibraryStats().brokenIdentity).toBe(1);
  });

  it("restores metadata ownership on identity undo without discarding later field events", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const album = (id: string, title: string) => ({
      id,
      rootId: "music",
      groupKey: id,
      title,
      albumArtist: "Observed Artist",
      year: 2000,
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
      album("undo-source", "Source"),
      album("undo-target", "Target"),
    ]);
    const source = database.getAlbumSummary("undo-source")!;
    const target = database.getAlbumSummary("undo-target")!;
    const actor = { id: "admin", displayName: "Admin" };
    database.applyAlbumMetadata(
      source.id,
      {
        requestId: "undo-source-title",
        expectedMetadataRevision: 0,
        commands: [{ action: "SET", field: "title", value: "Source Curated" }],
      },
      actor,
    );
    const merged = database.applyLibraryIdentityDecision(
      source.id,
      {
        type: "MERGE",
        requestId: "undo-merge",
        revision: source.revision,
        targetLibraryAlbumId: target.id,
        targetRevision: target.revision,
        primaryVersionId: "undo-target",
      },
      actor,
    );
    const mergedMetadata = database.getAlbumMetadata(target.id)!;
    expect(mergedMetadata.album.title.effectiveValue).toBe("Source Curated");
    database.applyAlbumMetadata(
      target.id,
      {
        requestId: "later-target-artist",
        expectedMetadataRevision: mergedMetadata.metadataRevision,
        commands: [
          { action: "SET", field: "albumArtist", value: "Later Artist" },
        ],
      },
      actor,
    );
    expect(database.listAlbumMetadataHistory(target.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: "later-target-artist",
          canUndo: true,
        }),
        expect.objectContaining({
          requestId: "undo-source-title",
          canUndo: false,
        }),
      ]),
    );
    database.undoLibraryIdentityDecision(
      source.id,
      merged.decision.id,
      "undo-merge-request",
      merged.decision.resultingRevision,
      actor,
    );
    expect(database.getAlbum(source.id)?.title).toBe("Source Curated");
    expect(database.getAlbum(target.id)?.albumArtist).toBe("Later Artist");
    expect(database.listAlbumMetadataHistory(source.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: "undo-source-title",
          canUndo: false,
        }),
      ]),
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

  it("defaults to latest-added and uses the real library id across page boundaries", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("added-old", []),
        title: "Artist First",
        albumArtist: "A",
      },
      { ...albumInput("added-new", []), title: "Newest", albumArtist: "Z" },
      {
        ...albumInput("added-middle", []),
        title: "Middle",
        albumArtist: "M",
      },
    ]);
    const albums = ["added-old", "added-new", "added-middle"].map((versionId) =>
      database.getAlbumSummary(versionId)!,
    );
    const addedAtByVersion = new Map([
      ["added-old", "2026-08-10T00:00:00.000Z"],
      ["added-new", "2026-08-12T00:00:00.000Z"],
      ["added-middle", "2026-08-11T00:00:00.000Z"],
    ]);
    for (const [versionId, addedAt] of addedAtByVersion) {
      database.raw
        .prepare("UPDATE library_albums SET created_at=? WHERE id=?")
        .run(addedAt, database.getAlbumSummary(versionId)!.id);
    }

    expect(database.listAlbums().map((album) => album.title)).toEqual([
      "Newest",
      "Middle",
      "Artist First",
    ]);
    expect(
      database.listAlbums({ sort: "ADDED_DESC" }).map((album) => album.title),
    ).toEqual(["Newest", "Middle", "Artist First"]);
    expect(
      database.listAlbums({ sort: "ARTIST" }).map((album) => album.title),
    ).toEqual(["Artist First", "Middle", "Newest"]);

    for (const album of albums) {
      database.raw
        .prepare("UPDATE library_albums SET created_at=? WHERE id=?")
        .run("2026-08-12T00:00:00.000Z", album.id);
    }
    const expectedIds = albums.map((album) => album.id).sort();
    const pagedIds = [0, 1, 2].map(
      (offset) => database.listAlbums({ limit: 1, offset })[0]!.id,
    );
    expect(pagedIds).toEqual(expectedIds);
    const acrossPages = [
      ...database.listAlbums({ limit: 2, offset: 0 }),
      ...database.listAlbums({ limit: 2, offset: 2 }),
    ].map((album) => album.id);
    expect(acrossPages).toEqual(expectedIds);
    expect(new Set(acrossPages).size).toBe(expectedIds.length);
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
    expect(database.getLibraryStats().tracks).toBe(21);
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

  it("persists the earliest member time and keeps addedAt isolated from mutable album facts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-added-at-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "cocean.sqlite");
    let database = new CoceanDatabase(path);
    open.push(database);
    const observed = (id: string, year: number) => ({
      ...albumInput(id, []),
      title: "Stable Added At",
      albumArtist: "Artist",
      year,
    });
    const firstMemberAt = "2026-02-03T04:05:06.000Z";
    const secondMemberAt = "2026-01-02T03:04:05.000Z";
    const stableAddedAt = "2025-12-01T00:00:00.000Z";
    database.replaceAlbumsForRoot("music", [
      observed("added-first", 2001),
      observed("added-second", 2002),
    ]);
    database.raw
      .prepare(
        `UPDATE albums SET created_at=CASE id
           WHEN 'added-first' THEN ? WHEN 'added-second' THEN ? ELSE created_at END`,
      )
      .run(firstMemberAt, secondMemberAt);
    database.raw.prepare("DELETE FROM library_albums").run();
    open.splice(open.indexOf(database), 1);
    database.close();
    database = new CoceanDatabase(path);
    open.push(database);

    const initial = database.getAlbumSummary("added-first")!;
    expect(initial.primaryVersionId).toBe("added-first");
    expect(initial.addedAt).toBe(secondMemberAt);
    database.raw
      .prepare("UPDATE library_albums SET created_at=? WHERE id=?")
      .run(stableAddedAt, initial.id);
    const expectStableAddedAt = () => {
      expect(database.listAlbums()).toEqual([
        expect.objectContaining({ id: initial.id, addedAt: stableAddedAt }),
      ]);
      expect(database.getAlbum(initial.id)?.addedAt).toBe(stableAddedAt);
      expect(database.getAlbumSummary("added-first")?.addedAt).toBe(
        stableAddedAt,
      );
      expect(database.getAlbumSummary("added-second")?.addedAt).toBe(
        stableAddedAt,
      );
    };
    expectStableAddedAt();

    database.raw
      .prepare("UPDATE albums SET created_at='not-a-date' WHERE id=?")
      .run("added-first");
    expect(() =>
      database.replaceAlbumsForRoot("music", [
        observed("added-first", 2011),
        observed("added-second", 2012),
      ]),
    ).not.toThrow();
    expectStableAddedAt();
    const afterRescan = database.getAlbumSummary(initial.id)!;
    database.applyAlbumMetadata(
      initial.id,
      {
        requestId: "added-at-metadata",
        expectedMetadataRevision: afterRescan.metadataRevision ?? 0,
        commands: [{ action: "SET", field: "title", value: "Curated" }],
      },
      { id: "admin", displayName: "Admin" },
    );
    expectStableAddedAt();
    database.upsertArtworkCandidate(initial.id, {
      sha256: "f".repeat(64),
      mimeType: "image/jpeg",
      width: 1000,
      height: 1000,
      sizeBytes: 10_000,
      extension: ".jpg",
      source: "OBSERVED_EMBEDDED",
      localVersionId: "added-first",
      relativePath: "Artist/Stable Added At/cover.jpg",
      kind: "Front Cover",
      evidence: { test: true },
    });
    expectStableAddedAt();
    database.applyLibraryIdentityDecision(
      initial.id,
      {
        type: "SET_PRIMARY",
        requestId: "added-at-primary",
        revision: database.getAlbumSummary(initial.id)!.revision,
        primaryVersionId: "added-second",
      },
      { id: "admin", displayName: "Admin" },
    );
    expectStableAddedAt();
    database.replaceAlbumsForRoot("music", [
      observed("added-first", 2011),
      observed("added-second", 2012),
      observed("added-third", 2013),
    ]);
    expect(database.getAlbumSummary("added-third")?.id).toBe(initial.id);
    expectStableAddedAt();

    open.splice(open.indexOf(database), 1);
    database.close();
    database = new CoceanDatabase(path);
    open.push(database);
    expectStableAddedAt();
  });

  it("creates automatic groups from already loaded member times without a dynamic member-id query", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const originalPrepare = database.raw.prepare.bind(database.raw);
    const prepare = vi.spyOn(database.raw, "prepare");
    prepare.mockImplementation(((source: string) => {
      if (/SELECT id,created_at FROM albums\s+WHERE id IN/.test(source))
        throw new Error("automatic grouping queried member ids dynamically");
      return originalPrepare(source);
    }) as typeof database.raw.prepare);
    try {
      expect(() =>
        database.replaceAlbumsForRoot("music", [
          { ...albumInput("loaded-time-a", []), title: "Loaded Time" },
          { ...albumInput("loaded-time-b", []), title: "Loaded Time" },
          { ...albumInput("loaded-time-c", []), title: "Loaded Time" },
        ]),
      ).not.toThrow();
    } finally {
      prepare.mockRestore();
    }
    expect(database.getAlbumSummary("loaded-time-a")?.versionCount).toBe(3);
  });

  it("maintains merge, split and undo addedAt invariants for aliases and version entry points", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const actor = { id: "admin", displayName: "Admin" };
    database.replaceAlbumsForRoot("music", [
      { ...albumInput("time-merge-source", []), title: "Time Source" },
      { ...albumInput("time-merge-target", []), title: "Time Target" },
      { ...albumInput("time-split-a", []), title: "Time Split" },
      { ...albumInput("time-split-b", []), title: "Time Split" },
      { ...albumInput("time-split-c", []), title: "Time Split" },
    ]);
    const source = database.getAlbumSummary("time-merge-source")!;
    const target = database.getAlbumSummary("time-merge-target")!;
    const sourceAddedAt = new Date(
      Date.now() - 24 * 60 * 60 * 1000,
    ).toISOString();
    const targetAddedAt = new Date(
      Date.now() - 31 * 24 * 60 * 60 * 1000,
    ).toISOString();
    database.raw
      .prepare(
        `UPDATE library_albums SET created_at=CASE id
           WHEN ? THEN ? WHEN ? THEN ? ELSE created_at END`,
      )
      .run(source.id, sourceAddedAt, target.id, targetAddedAt);
    const recentlyAddedBeforeMerge = database.getLibraryStats().recentlyAdded;
    const merged = database.applyLibraryIdentityDecision(
      source.id,
      {
        type: "MERGE",
        requestId: "time-merge",
        revision: source.revision,
        targetLibraryAlbumId: target.id,
        targetRevision: target.revision,
        primaryVersionId: "time-merge-target",
      },
      actor,
    );
    for (const entry of [
      target.id,
      source.id,
      "time-merge-source",
      "time-merge-target",
    ])
      expect(database.getAlbumSummary(entry)?.addedAt).toBe(targetAddedAt);
    expect(database.getLibraryStats().recentlyAdded).toBe(
      recentlyAddedBeforeMerge - 1,
    );
    database.undoLibraryIdentityDecision(
      target.id,
      merged.decision.id,
      "time-merge-undo",
      database.getAlbumSummary(target.id)!.revision,
      actor,
    );
    expect(database.getAlbumSummary(source.id)?.addedAt).toBe(sourceAddedAt);
    expect(database.getAlbumSummary(target.id)?.addedAt).toBe(targetAddedAt);
    expect(database.getLibraryStats().recentlyAdded).toBe(
      recentlyAddedBeforeMerge,
    );

    const splitSource = database.getAlbumSummary("time-split-a")!;
    expect(splitSource.primaryVersionId).toBe("time-split-a");
    const splitOriginalAt = new Date(
      Date.now() - 32 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const splitAAt = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const splitBAt = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const splitCAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    database.raw
      .prepare("UPDATE library_albums SET created_at=? WHERE id=?")
      .run(splitOriginalAt, splitSource.id);
    database.raw
      .prepare(
        `UPDATE albums SET created_at=CASE id
           WHEN 'time-split-a' THEN ? WHEN 'time-split-b' THEN ?
           WHEN 'time-split-c' THEN ? ELSE created_at END`,
      )
      .run(splitAAt, splitBAt, splitCAt);
    const recentlyAddedBeforeSplit = database.getLibraryStats().recentlyAdded;
    const split = database.applyLibraryIdentityDecision(
      splitSource.id,
      {
        type: "SPLIT",
        requestId: "time-split",
        revision: splitSource.revision,
        partitions: [
          { versionIds: ["time-split-a"] },
          {
            versionIds: ["time-split-b", "time-split-c"],
            primaryVersionId: "time-split-c",
          },
        ],
      },
      actor,
    );
    const newGroup = database.getAlbumSummary("time-split-b")!;
    expect(database.getAlbumSummary(splitSource.id)?.addedAt).toBe(
      splitOriginalAt,
    );
    expect(newGroup.primaryVersionId).toBe("time-split-c");
    expect(newGroup.addedAt).toBe(splitBAt);
    expect(database.getLibraryStats().recentlyAdded).toBe(
      recentlyAddedBeforeSplit + 1,
    );
    database.undoLibraryIdentityDecision(
      splitSource.id,
      split.decision.id,
      "time-split-undo",
      database.getAlbumSummary(splitSource.id)!.revision,
      actor,
    );
    expect(database.getAlbumSummary(splitSource.id)?.addedAt).toBe(
      splitOriginalAt,
    );
    expect(database.getAlbumSummary(newGroup.id)?.addedAt).toBe(
      splitOriginalAt,
    );
    expect(database.getLibraryStats().recentlyAdded).toBe(
      recentlyAddedBeforeSplit,
    );
  });

  it("fails instead of returning a non-UTC addedAt and treats full deletion as newly added", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [albumInput("time-invalid", [])]);
    const first = database.getAlbumSummary("time-invalid")!;
    database.raw
      .prepare("UPDATE library_albums SET created_at=? WHERE id=?")
      .run("2026-08-12T08:00:00+08:00", first.id);
    expect(() => database.getAlbumSummary(first.id)).toThrow();
    expect(() => database.listAlbums()).toThrow();
    const oldAddedAt = "2000-01-01T00:00:00.000Z";
    database.raw
      .prepare("UPDATE library_albums SET created_at=? WHERE id=?")
      .run(oldAddedAt, first.id);
    expect(database.getAlbumSummary(first.id)?.addedAt).toBe(oldAddedAt);
    database.raw.prepare("DELETE FROM albums WHERE id=?").run("time-invalid");
    database.replaceAlbumsForRoot("music", []);
    expect(database.getAlbumSummary(first.id)).toBeNull();
    database.replaceAlbumsForRoot("music", [albumInput("time-invalid", [])]);
    const recreated = database.getAlbumSummary("time-invalid")!;
    const recreatedVersion = database.raw
      .prepare("SELECT created_at FROM albums WHERE id=?")
      .get("time-invalid") as { created_at: string };
    expect(recreated.id).toBe(first.id);
    expect(recreated.addedAt).toBe(recreatedVersion.created_at);
    expect(recreated.addedAt).not.toBe(oldAddedAt);
    expect(albumAddedAtSchema.parse(recreated.addedAt)).toBe(
      recreatedVersion.created_at,
    );
  });

  it("rolls back automatic creation and split when member creation facts are not UTC", () => {
    const automatic = new CoceanDatabase(":memory:");
    open.push(automatic);
    automatic.replaceAlbumsForRoot("music", [
      albumInput("invalid-auto-member", []),
    ]);
    automatic.raw
      .prepare("UPDATE albums SET created_at='invalid-auto-time' WHERE id=?")
      .run("invalid-auto-member");
    automatic.raw.prepare("DELETE FROM library_albums").run();
    expect(() =>
      automatic.replaceAlbumsForRoot("music", [
        { ...albumInput("invalid-auto-member", []), year: 2021 },
      ]),
    ).toThrow();
    expect(
      automatic.raw
        .prepare("SELECT year FROM albums WHERE id=?")
        .get("invalid-auto-member"),
    ).toEqual({ year: 2020 });
    expect(
      automatic.raw
        .prepare("SELECT COUNT(*) AS count FROM library_albums")
        .get(),
    ).toEqual({ count: 0 });

    const splitDatabase = new CoceanDatabase(":memory:");
    open.push(splitDatabase);
    splitDatabase.replaceAlbumsForRoot("music", [
      { ...albumInput("invalid-split-a", []), title: "Invalid Split" },
      { ...albumInput("invalid-split-b", []), title: "Invalid Split" },
      { ...albumInput("invalid-split-c", []), title: "Invalid Split" },
    ]);
    const source = splitDatabase.getAlbumSummary("invalid-split-a")!;
    splitDatabase.raw
      .prepare("UPDATE albums SET created_at='invalid-split-time' WHERE id=?")
      .run("invalid-split-b");
    const membersBefore = splitDatabase
      .getAlbum(source.id)!
      .localVersions.map((version) => version.id)
      .sort();
    expect(() =>
      splitDatabase.applyLibraryIdentityDecision(
        source.id,
        {
          type: "SPLIT",
          requestId: "invalid-time-split",
          revision: source.revision,
          partitions: [
            { versionIds: ["invalid-split-a"] },
            {
              versionIds: ["invalid-split-b", "invalid-split-c"],
              primaryVersionId: "invalid-split-c",
            },
          ],
        },
        { id: "admin", displayName: "Admin" },
      ),
    ).toThrow();
    expect(splitDatabase.getAlbumSummary(source.id)).toEqual(
      expect.objectContaining({ id: source.id, revision: source.revision }),
    );
    expect(
      splitDatabase
        .getAlbum(source.id)!
        .localVersions.map((version) => version.id)
        .sort(),
    ).toEqual(membersBefore);
    expect(splitDatabase.listLibraryIdentityDecisionHistory(source.id)).toEqual(
      [],
    );
  });

  it("applies, replays, splits and safely undoes manual identity decisions without moving version dependencies", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const versions = [
      {
        ...albumInput("manual-short", []),
        title: "Manual",
        albumArtist: "Artist",
        trackCount: 2,
      },
      {
        ...albumInput("manual-complete", []),
        title: "Manual",
        albumArtist: "Artist",
        trackCount: 21,
      },
    ];
    database.replaceAlbumsForRoot("music", versions);
    database.raw
      .prepare(
        `INSERT INTO physical_copies
           (id,album_id,medium,quantity,created_at,updated_at)
         VALUES ('manual-copy','manual-short','CD',1,?,?)`,
      )
      .run("2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    const stableId = database.getAlbumSummary("manual-short")!.id;
    const actor = { id: "admin", displayName: "Admin" };
    const confirm = {
      type: "CONFIRM" as const,
      requestId: "confirm-manual",
      revision: 0,
      primaryVersionId: "manual-complete",
    };
    const confirmed = database.applyLibraryIdentityDecision(
      stableId,
      confirm,
      actor,
    );
    expect(
      database.applyLibraryIdentityDecision(stableId, confirm, actor),
    ).toEqual(confirmed);
    expect(database.getAlbum(stableId)).toEqual(
      expect.objectContaining({
        revision: 1,
        primaryVersionId: "manual-complete",
        primaryVersionSource: "USER",
        localVersions: expect.arrayContaining([
          expect.objectContaining({ relationshipStatus: "USER_CONFIRMED" }),
        ]),
      }),
    );
    database.replaceAlbumsForRoot("music", [versions[1]!]);
    expect(
      database.getAlbum(stableId)?.localVersions?.map((version) => version.id),
    ).toEqual(["manual-complete", "manual-short"]);
    database.replaceAlbumsForRoot("music", versions);
    expect(database.getAlbum(stableId)?.primaryVersionId).toBe(
      "manual-complete",
    );

    const split = database.applyLibraryIdentityDecision(
      stableId,
      {
        type: "SPLIT",
        requestId: "split-manual",
        revision: 1,
        partitions: [
          { versionIds: ["manual-short"] },
          { versionIds: ["manual-complete"] },
        ],
      },
      actor,
    );
    const shortGroupId = database.getAlbumSummary("manual-short")!.id;
    expect(shortGroupId).not.toBe(stableId);
    expect(database.getAlbumSummary("manual-complete")!.id).toBe(stableId);
    expect(database.listPhysicalCopies(shortGroupId)).toEqual([
      expect.objectContaining({ id: "manual-copy" }),
    ]);
    expect(database.listPhysicalCopies(stableId)).toEqual([]);
    database.replaceAlbumsForRoot("music", versions);
    expect(database.getAlbumSummary("manual-short")!.id).toBe(shortGroupId);

    const undone = database.undoLibraryIdentityDecision(
      stableId,
      split.decision.id,
      "undo-split-manual",
      2,
      actor,
    );
    expect(undone.decision.type).toBe("UNDO");
    expect(database.getAlbumSummary("manual-complete")!.id).toBe(stableId);
    expect(database.getAlbumSummary(shortGroupId)!.id).toBe(stableId);
    expect(() =>
      database.undoLibraryIdentityDecision(
        stableId,
        split.decision.id,
        "undo-split-again",
        database.getAlbumSummary(stableId)!.revision,
        actor,
      ),
    ).toThrow(/已经撤销/);
  });

  it("keeps merge aliases and local-version dependencies while rejecting stale or conflicting changes atomically", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("merge-source", []),
        title: "Source",
        albumArtist: "Artist",
      },
      {
        ...albumInput("merge-target", []),
        title: "Target",
        albumArtist: "Artist",
      },
    ]);
    const sourceId = database.getAlbumSummary("merge-source")!.id;
    const targetId = database.getAlbumSummary("merge-target")!.id;
    const actor = { id: "admin", displayName: "Admin" };
    expect(() =>
      database.applyLibraryIdentityDecision(
        sourceId,
        {
          type: "SET_PRIMARY",
          requestId: "bad-member",
          revision: 0,
          primaryVersionId: "merge-target",
        },
        actor,
      ),
    ).toThrow(/主版本必须属于当前唱片/);
    expect(database.getAlbumSummary(sourceId)!.revision).toBe(0);
    const now = "2026-08-13T00:00:00.000Z";
    database.createDeliveryTarget({
      id: "merge-target-device",
      deviceId: null,
      name: "Merge target",
      kind: "MOUNTED_VOLUME",
      transport: "USB_MOUNT",
      location: "/delivery/usb/merge",
      username: null,
      credentialConfigured: false,
      enabled: true,
      verifiedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    for (const [index, localVersionId] of [
      "merge-source",
      "merge-target",
    ].entries())
      database.createDeliveryJob({
        id: `merge-active-${index}`,
        albumId: localVersionId,
        targetId: "merge-target-device",
        targetName: "Merge target",
        transport: "USB_MOUNT",
        status: "QUEUED",
        fileCount: 0,
        completedFileCount: 0,
        totalBytes: 0,
        transferredBytes: 0,
        verified: false,
        error: null,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        planId: null,
      });
    expect(() =>
      database.applyLibraryIdentityDecision(
        sourceId,
        {
          type: "MERGE",
          requestId: "merge-active-conflict",
          revision: 0,
          targetLibraryAlbumId: targetId,
          targetRevision: 0,
          primaryVersionId: "merge-target",
        },
        actor,
      ),
    ).toThrow(/重复活动任务/);
    expect(database.getAlbumSummary(sourceId)!.id).toBe(sourceId);
    database.raw
      .prepare(
        "UPDATE delivery_jobs SET status='COMPLETED', finished_at=? WHERE id LIKE 'merge-active-%'",
      )
      .run(now);
    const merged = database.applyLibraryIdentityDecision(
      sourceId,
      {
        type: "MERGE",
        requestId: "merge-two",
        revision: 0,
        targetLibraryAlbumId: targetId,
        targetRevision: 0,
        primaryVersionId: "merge-target",
      },
      actor,
    );
    expect(merged.currentLibraryAlbumId).toBe(targetId);
    expect(database.getAlbumSummary(sourceId)!.id).toBe(targetId);
    expect(database.getAlbumSummary("merge-source")!.id).toBe(targetId);
    expect(() =>
      database.applyLibraryIdentityDecision(
        targetId,
        {
          type: "SET_PRIMARY",
          requestId: "stale-primary",
          revision: 0,
          primaryVersionId: "merge-source",
        },
        actor,
      ),
    ).toThrow(/刷新后重试/);
    expect(database.getAlbumSummary(targetId)!.primaryVersionId).toBe(
      "merge-target",
    );

    database.applyLibraryIdentityDecision(
      targetId,
      {
        type: "SET_PRIMARY",
        requestId: "later-primary",
        revision: 1,
        primaryVersionId: "merge-source",
      },
      actor,
    );
    expect(() =>
      database.undoLibraryIdentityDecision(
        targetId,
        merged.decision.id,
        "conflicting-undo",
        2,
        actor,
      ),
    ).toThrow(/后续决定覆盖/);
  });

  it("sets an explicit primary without silently confirming automatic candidates and rejects incomplete split partitions", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("primary-a", []),
        title: "Primary",
        albumArtist: "Artist",
      },
      {
        ...albumInput("primary-b", []),
        title: "Primary",
        albumArtist: "Artist",
      },
      {
        ...albumInput("primary-c", []),
        title: "Primary",
        albumArtist: "Artist",
      },
    ]);
    const groupId = database.getAlbumSummary("primary-a")!.id;
    database.applyLibraryIdentityDecision(
      groupId,
      {
        type: "SET_PRIMARY",
        requestId: "set-primary-only",
        revision: 0,
        primaryVersionId: "primary-b",
      },
      { id: "admin", displayName: "Admin" },
    );
    expect(database.getAlbum(groupId)).toEqual(
      expect.objectContaining({
        primaryVersionId: "primary-b",
        primaryVersionSource: "USER",
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "IDENTITY_OVERLAP" }),
        ]),
        localVersions: expect.arrayContaining([
          expect.objectContaining({ relationshipStatus: "AUTO_CANDIDATE" }),
        ]),
      }),
    );
    expect(() =>
      database.applyLibraryIdentityDecision(
        groupId,
        {
          type: "SPLIT",
          requestId: "split-with-omission",
          revision: 1,
          partitions: [
            { versionIds: ["primary-a"] },
            { versionIds: ["primary-b"] },
          ],
        },
        { id: "admin", displayName: "Admin" },
      ),
    ).toThrow(/覆盖全部本地版本/);
    expect(database.getAlbumSummary(groupId)!.revision).toBe(1);
  });

  it("keeps the identity decision ledger append-only at the database boundary", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("ledger-album", []),
        title: "Ledger",
        albumArtist: "Artist",
      },
    ]);
    const groupId = database.getAlbumSummary("ledger-album")!.id;
    const result = database.applyLibraryIdentityDecision(
      groupId,
      {
        type: "SET_PRIMARY",
        requestId: "ledger-request",
        revision: 0,
        primaryVersionId: "ledger-album",
      },
      { id: "admin", displayName: "Admin" },
    );
    expect(() =>
      database.raw
        .prepare(
          "UPDATE library_identity_decisions SET actor_display_name='tampered' WHERE id=?",
        )
        .run(result.decision.id),
    ).toThrow(/append-only/);
    expect(() =>
      database.raw
        .prepare("DELETE FROM library_identity_decisions WHERE id=?")
        .run(result.decision.id),
    ).toThrow(/append-only/);
    expect(() =>
      database.raw
        .prepare(
          "UPDATE library_identity_decision_groups SET library_album_id='tampered' WHERE decision_id=?",
        )
        .run(result.decision.id),
    ).toThrow(/append-only/);
    expect(() =>
      database.raw
        .prepare(
          "DELETE FROM library_identity_decision_groups WHERE decision_id=?",
        )
        .run(result.decision.id),
    ).toThrow(/append-only/);
    expect(database.listLibraryIdentityDecisionHistory(groupId)).toEqual([
      expect.objectContaining({ id: result.decision.id }),
    ]);
  });

  it("binds requestId replay to the exact album, command payload and apply-or-undo entrypoint", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("idempotent-a", []),
        title: "Idempotent A",
        albumArtist: "Artist",
      },
      {
        ...albumInput("idempotent-b", []),
        title: "Idempotent B",
        albumArtist: "Artist",
      },
    ]);
    const groupA = database.getAlbumSummary("idempotent-a")!.id;
    const groupB = database.getAlbumSummary("idempotent-b")!.id;
    const actor = { id: "admin", displayName: "Admin" };
    const command = {
      type: "SET_PRIMARY" as const,
      requestId: "bound-request",
      revision: 0,
      primaryVersionId: "idempotent-a",
    };
    const first = database.applyLibraryIdentityDecision(groupA, command, actor);
    expect(
      database.applyLibraryIdentityDecision(groupA, command, actor),
    ).toEqual(first);
    expect(() =>
      database.applyLibraryIdentityDecision(
        groupA,
        { ...command, primaryVersionId: "different-version" },
        actor,
      ),
    ).toThrow(/requestId 已用于不同/);
    expect(() =>
      database.applyLibraryIdentityDecision(groupB, command, actor),
    ).toThrow(/requestId 已用于不同/);
    expect(() =>
      database.undoLibraryIdentityDecision(
        groupA,
        first.decision.id,
        command.requestId,
        1,
        actor,
      ),
    ).toThrow(/requestId 已用于不同/);

    const undo = database.undoLibraryIdentityDecision(
      groupA,
      first.decision.id,
      "bound-undo-request",
      1,
      actor,
    );
    expect(
      database.undoLibraryIdentityDecision(
        groupA,
        first.decision.id,
        "bound-undo-request",
        1,
        actor,
      ),
    ).toEqual(undo);
    expect(() =>
      database.applyLibraryIdentityDecision(
        groupA,
        {
          type: "SET_PRIMARY",
          requestId: "bound-undo-request",
          revision: undo.decision.resultingRevision,
          primaryVersionId: "idempotent-a",
        },
        actor,
      ),
    ).toThrow(/requestId 已用于不同/);
  });

  it("undoes SET_PRIMARY after an automatic rebuild without rolling scan issue facts back", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const initial = [
      {
        ...albumInput("rescan-incomplete", []),
        title: "Rescan",
        albumArtist: "Artist",
        aggregationIssues: [
          {
            code: "MISSING_TRACK" as const,
            discNumber: 1,
            trackNumber: 2,
            expected: 2,
            actual: 1,
          },
        ],
      },
      {
        ...albumInput("rescan-complete", []),
        title: "Rescan",
        albumArtist: "Artist",
      },
    ];
    database.replaceAlbumsForRoot("music", initial);
    const groupId = database.getAlbumSummary("rescan-incomplete")!.id;
    expect(database.getAlbumSummary(groupId)!.primaryVersionId).toBe(
      "rescan-complete",
    );
    const decision = database.applyLibraryIdentityDecision(
      groupId,
      {
        type: "SET_PRIMARY",
        requestId: "rescan-primary",
        revision: 0,
        primaryVersionId: "rescan-incomplete",
      },
      { id: "admin", displayName: "Admin" },
    );
    const rescanned = [
      {
        ...initial[0]!,
        aggregationIssues: [
          {
            code: "MISSING_TRACK" as const,
            discNumber: 1,
            trackNumber: 2,
            expected: 9,
            actual: 1,
          },
        ],
      },
      initial[1]!,
    ];
    database.replaceAlbumsForRoot("music", rescanned);
    const scannedEvidence = database.raw
      .prepare(
        `SELECT evidence_json FROM library_issues
         WHERE library_album_id=? AND album_id='rescan-incomplete'
           AND code='INCOMPLETE_TRACKS'`,
      )
      .get(groupId) as { evidence_json: string };
    expect(scannedEvidence.evidence_json).toContain('"expected":9');
    expect(database.listLibraryIdentityDecisionHistory(groupId)[0]).toEqual(
      expect.objectContaining({ id: decision.decision.id, canUndo: true }),
    );

    database.undoLibraryIdentityDecision(
      groupId,
      decision.decision.id,
      "undo-rescan-primary",
      1,
      { id: "admin", displayName: "Admin" },
    );
    expect(database.getAlbumSummary(groupId)).toEqual(
      expect.objectContaining({
        primaryVersionId: "rescan-complete",
        primaryVersionSource: "AUTOMATIC",
        revision: 2,
      }),
    );
    expect(
      (
        database.raw
          .prepare(
            `SELECT evidence_json FROM library_issues
             WHERE library_album_id=? AND album_id='rescan-incomplete'
               AND code='INCOMPLETE_TRACKS'`,
          )
          .get(groupId) as { evidence_json: string }
      ).evidence_json,
    ).toBe(scannedEvidence.evidence_json);
  });

  it("refreshes scan-derived issues for CONFIRM, SPLIT and MERGE user groups without changing governance", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const actor = { id: "admin", displayName: "Admin" };
    const a = {
      ...albumInput("facts-a", []),
      title: "Facts",
      albumArtist: "Artist",
    };
    const b = {
      ...albumInput("facts-b", []),
      title: "Facts",
      albumArtist: "Artist",
    };
    const target = {
      ...albumInput("facts-target", []),
      title: "Target",
      albumArtist: "Artist",
    };
    database.replaceAlbumsForRoot("music", [a, b, target]);
    const groupId = database.getAlbumSummary("facts-a")!.id;
    database.applyLibraryIdentityDecision(
      groupId,
      { type: "CONFIRM", requestId: "facts-confirm", revision: 0 },
      actor,
    );
    database.replaceAlbumsForRoot("music", [
      {
        ...a,
        artwork: {
          source: "SIDECAR" as const,
          url: "/new-cover.jpg",
          mimeType: "image/jpeg",
          width: 1200,
          height: 1200,
        },
      },
      b,
      target,
    ]);
    expect(database.getAlbum(groupId)?.localVersions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "facts-a",
          relationshipStatus: "USER_CONFIRMED",
        }),
        expect.objectContaining({
          id: "facts-b",
          relationshipStatus: "USER_CONFIRMED",
        }),
      ]),
    );
    expect(
      database.raw
        .prepare(
          `SELECT 1 FROM library_issues WHERE library_album_id=?
           AND album_id='facts-a' AND code='MISSING_ARTWORK'`,
        )
        .get(groupId),
    ).toBeUndefined();

    const split = database.applyLibraryIdentityDecision(
      groupId,
      {
        type: "SPLIT",
        requestId: "facts-split",
        revision: 1,
        partitions: [{ versionIds: ["facts-a"] }, { versionIds: ["facts-b"] }],
      },
      actor,
    );
    const splitId = database.getAlbumSummary("facts-b")!.id;
    database.replaceAlbumsForRoot("music", [
      a,
      {
        ...b,
        mixedAudioSpecs: true,
      },
      target,
    ]);
    expect(database.getAlbum(splitId)?.localVersions[0]).toEqual(
      expect.objectContaining({ relationshipStatus: "USER_SEPARATE" }),
    );
    expect(
      database.raw
        .prepare(
          `SELECT evidence_json FROM library_issues WHERE library_album_id=?
           AND album_id='facts-b' AND code='MIXED_AUDIO_SPECS'`,
        )
        .get(splitId),
    ).toBeTruthy();

    const targetId = database.getAlbumSummary("facts-target")!.id;
    database.applyLibraryIdentityDecision(
      splitId,
      {
        type: "MERGE",
        requestId: "facts-merge",
        revision: database.getAlbumSummary(splitId)!.revision,
        targetLibraryAlbumId: targetId,
        targetRevision: database.getAlbumSummary(targetId)!.revision,
        primaryVersionId: "facts-target",
      },
      actor,
    );
    database.replaceAlbumsForRoot("music", [a, b, target]);
    expect(database.getAlbum(targetId)?.localVersions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "facts-b",
          relationshipStatus: "USER_CONFIRMED",
        }),
        expect.objectContaining({
          id: "facts-target",
          relationshipStatus: "USER_CONFIRMED",
        }),
      ]),
    );
    expect(
      database.raw
        .prepare(
          `SELECT 1 FROM library_issues WHERE library_album_id=?
           AND album_id='facts-b' AND code='MIXED_AUDIO_SPECS'`,
        )
        .get(targetId),
    ).toBeUndefined();
    expect(split.decision.details.partitions).toHaveLength(2);
  });

  it("pins USER primary membership and advances automatic revisions for observed membership changes", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const base = [
      {
        ...albumInput("revision-a", []),
        title: "Revision",
        albumArtist: "Artist",
      },
      {
        ...albumInput("revision-b", []),
        title: "Revision",
        albumArtist: "Artist",
      },
    ];
    database.replaceAlbumsForRoot("music", base);
    const groupId = database.getAlbumSummary("revision-a")!.id;
    database.applyLibraryIdentityDecision(
      groupId,
      {
        type: "SET_PRIMARY",
        requestId: "revision-primary",
        revision: 0,
        primaryVersionId: "revision-b",
      },
      { id: "admin", displayName: "Admin" },
    );
    database.replaceAlbumsForRoot("music", [
      base[0]!,
      { ...base[1]!, title: "Renamed by scan" },
    ]);
    expect(database.getAlbum(groupId)).toEqual(
      expect.objectContaining({
        primaryVersionId: "revision-b",
        revision: 1,
        localVersions: expect.arrayContaining([
          expect.objectContaining({ id: "revision-b" }),
        ]),
      }),
    );
    database.replaceAlbumsForRoot("music", [
      base[0]!,
      { ...base[1]!, title: "Renamed by scan" },
      {
        ...albumInput("revision-c", []),
        title: "Revision",
        albumArtist: "Artist",
      },
    ]);
    expect(database.getAlbumSummary(groupId)!.revision).toBe(2);
    expect(() =>
      database.applyLibraryIdentityDecision(
        groupId,
        {
          type: "SET_PRIMARY",
          requestId: "revision-stale",
          revision: 1,
          primaryVersionId: "revision-a",
        },
        { id: "admin", displayName: "Admin" },
      ),
    ).toThrow(/刷新后重试/);
    database.replaceAlbumsForRoot("music", [
      { ...base[1]!, title: "Renamed by scan" },
      {
        ...albumInput("revision-c", []),
        title: "Revision",
        albumArtist: "Artist",
      },
    ]);
    expect(database.getAlbumSummary(groupId)!.revision).toBe(2);
    expect(
      database.getAlbum(groupId)?.localVersions.map((item) => item.id),
    ).toEqual(["revision-a", "revision-b", "revision-c"]);
  });

  it("advances revision when automatic primary selection changes on rescan", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const goodArtwork = {
      source: "SIDECAR" as const,
      url: "/cover.jpg",
      mimeType: "image/jpeg",
      width: 1200,
      height: 1200,
    };
    const poorArtwork = albumInput("unused", []).artwork;
    const a = {
      ...albumInput("auto-primary-a", []),
      title: "Auto Primary",
      albumArtist: "Artist",
      artwork: goodArtwork,
    };
    const b = {
      ...albumInput("auto-primary-b", []),
      title: "Auto Primary",
      albumArtist: "Artist",
      artwork: poorArtwork,
    };
    database.replaceAlbumsForRoot("music", [a, b]);
    const groupId = database.getAlbumSummary("auto-primary-a")!.id;
    expect(database.getAlbumSummary(groupId)!.primaryVersionId).toBe(
      "auto-primary-a",
    );
    database.replaceAlbumsForRoot("music", [
      { ...a, artwork: poorArtwork },
      { ...b, artwork: goodArtwork },
    ]);
    expect(database.getAlbumSummary(groupId)).toEqual(
      expect.objectContaining({
        primaryVersionId: "auto-primary-b",
        revision: 1,
      }),
    );
  });

  it("keeps alias/current ids disjoint and uses a collision-safe automatic id after merge", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const source = {
      ...albumInput("alias-source-version", []),
      title: "Alias Source",
      albumArtist: "Artist",
    };
    const target = {
      ...albumInput("alias-target-version", []),
      title: "Alias Target",
      albumArtist: "Artist",
    };
    database.replaceAlbumsForRoot("music", [source, target]);
    const sourceId = database.getAlbumSummary(source.id)!.id;
    const targetId = database.getAlbumSummary(target.id)!.id;
    database.applyLibraryIdentityDecision(
      sourceId,
      {
        type: "MERGE",
        requestId: "alias-merge",
        revision: 0,
        targetLibraryAlbumId: targetId,
        targetRevision: 0,
        primaryVersionId: target.id,
      },
      { id: "admin", displayName: "Admin" },
    );
    database.replaceAlbumsForRoot("music", [
      source,
      target,
      {
        ...albumInput("alias-new-version", []),
        title: "Alias Source",
        albumArtist: "Artist",
      },
    ]);
    const newGroupId = database.getAlbumSummary("alias-new-version")!.id;
    expect(newGroupId).not.toBe(sourceId);
    expect(database.getAlbumSummary(sourceId)!.id).toBe(targetId);
    expect(() =>
      database.raw
        .prepare(
          "INSERT INTO library_albums(id,identity_key,title,album_artist,primary_version_id,decision_source,primary_version_source,revision,created_at,updated_at) VALUES (?,?,?,?,?,'AUTOMATIC','AUTOMATIC',0,?,?)",
        )
        .run(
          sourceId,
          "conflict",
          "Conflict",
          "Artist",
          "alias-new-version",
          "now",
          "now",
        ),
    ).toThrow(/conflicts with an alias/);
    expect(() =>
      database.raw
        .prepare(
          "INSERT INTO library_album_aliases(alias_id,library_album_id,created_at) VALUES (?,?,?)",
        )
        .run(newGroupId, targetId, "now"),
    ).toThrow(/conflicts with a current id/);
  });

  it("inherits audit history through merge and split and successfully compensates a merge", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const actor = { id: "admin", displayName: "Admin" };
    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("audit-source", []),
        title: "Audit Source",
        albumArtist: "Artist",
      },
      {
        ...albumInput("audit-target", []),
        title: "Audit Target",
        albumArtist: "Artist",
      },
    ]);
    const sourceId = database.getAlbumSummary("audit-source")!.id;
    const targetId = database.getAlbumSummary("audit-target")!.id;
    const sourcePrior = database.applyLibraryIdentityDecision(
      sourceId,
      {
        type: "SET_PRIMARY",
        requestId: "audit-source-prior",
        revision: 0,
        primaryVersionId: "audit-source",
      },
      actor,
    );
    const targetPrior = database.applyLibraryIdentityDecision(
      targetId,
      {
        type: "CONFIRM",
        requestId: "audit-target-prior",
        revision: 0,
      },
      actor,
    );
    const merged = database.applyLibraryIdentityDecision(
      sourceId,
      {
        type: "MERGE",
        requestId: "audit-merge",
        revision: 1,
        targetLibraryAlbumId: targetId,
        targetRevision: 1,
        primaryVersionId: "audit-target",
      },
      actor,
    );
    expect(merged.affectedLibraryAlbumIds).toEqual(
      merged.decision.affectedLibraryAlbumIds,
    );
    expect(merged.affectedLibraryAlbumIds).toEqual(
      expect.arrayContaining([sourceId, targetId]),
    );
    expect(merged.decision.details).toEqual(
      expect.objectContaining({
        targetLibraryAlbumId: targetId,
        primaryVersionId: "audit-target",
      }),
    );
    expect(
      database
        .listLibraryIdentityDecisionHistory(targetId)
        .map((item) => item.id),
    ).toEqual([
      merged.decision.id,
      targetPrior.decision.id,
      sourcePrior.decision.id,
    ]);
    const sourceReplay = database.applyLibraryIdentityDecision(
      sourceId,
      {
        type: "SET_PRIMARY",
        requestId: "audit-source-prior",
        revision: 0,
        primaryVersionId: "audit-source",
      },
      actor,
    );
    expect(sourceReplay.affectedLibraryAlbumIds).toEqual(
      sourceReplay.decision.affectedLibraryAlbumIds,
    );
    expect(sourceReplay.affectedLibraryAlbumIds).toEqual([sourceId]);

    const undone = database.undoLibraryIdentityDecision(
      targetId,
      merged.decision.id,
      "audit-merge-undo",
      2,
      actor,
    );
    expect(undone.affectedLibraryAlbumIds).toEqual(
      expect.arrayContaining([sourceId, targetId]),
    );
    expect(database.getAlbumSummary(sourceId)).toEqual(
      expect.objectContaining({
        id: sourceId,
        primaryVersionId: "audit-source",
      }),
    );
    expect(database.getAlbumSummary(targetId)).toEqual(
      expect.objectContaining({
        id: targetId,
        primaryVersionId: "audit-target",
      }),
    );
    expect(
      database.getAlbum(sourceId)?.localVersions.map((item) => item.id),
    ).toEqual(["audit-source"]);
    expect(
      database.getAlbum(targetId)?.localVersions.map((item) => item.id),
    ).toEqual(["audit-target"]);

    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("split-history-a", []),
        title: "Split History",
        albumArtist: "Artist",
      },
      {
        ...albumInput("split-history-b", []),
        title: "Split History",
        albumArtist: "Artist",
      },
    ]);
    const splitParent = database.getAlbumSummary("split-history-a")!.id;
    const parentDecision = database.applyLibraryIdentityDecision(
      splitParent,
      { type: "CONFIRM", requestId: "split-history-confirm", revision: 0 },
      actor,
    );
    database.applyLibraryIdentityDecision(
      splitParent,
      {
        type: "SPLIT",
        requestId: "split-history-split",
        revision: 1,
        partitions: [
          { versionIds: ["split-history-a"] },
          { versionIds: ["split-history-b"] },
        ],
      },
      actor,
    );
    const childId = database.getAlbumSummary("split-history-b")!.id;
    expect(
      database
        .listLibraryIdentityDecisionHistory(childId)
        .map((item) => item.id),
    ).toContain(parentDecision.decision.id);
  });

  it("orders audit history by insertion causality and caps it at the latest 100 events", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("history-cap", []),
        title: "History",
        albumArtist: "Artist",
      },
    ]);
    const groupId = database.getAlbumSummary("history-cap")!.id;
    const ids: string[] = [];
    for (let revision = 0; revision < 105; revision += 1) {
      const result = database.applyLibraryIdentityDecision(
        groupId,
        {
          type: "SET_PRIMARY",
          requestId: `history-cap-${revision}`,
          revision,
          primaryVersionId: "history-cap",
        },
        { id: "admin", displayName: "Admin" },
      );
      ids.push(result.decision.id);
    }
    expect(
      database
        .listLibraryIdentityDecisionHistory(groupId)
        .map((item) => item.id),
    ).toEqual(ids.slice(-100).reverse());
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

  it("builds an authoritative mutually-exclusive inventory partition from explicit facts", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    createRunningScan(database, "inventory-scan");
    const file = observedFile("Artist/Digital/01.flac", 10);
    database.recordScanDiscovery({
      scanJobId: "inventory-scan",
      rulesVersion: "inventory-test/1",
      candidates: 1,
      regularFiles: 1,
      auxiliaryFiles: 0,
      ignoredFiles: 0,
      skippedSymlinks: 0,
      traversalErrors: 0,
    });
    database.recordScanFileResult({
      scanJobId: "inventory-scan",
      rootId: "music",
      relativePath: file.relativePath,
      extension: ".flac",
      candidateKind: "SUPPORTED_AUDIO",
      outcome: "PARSED",
      mediaFileId: "inventory-file",
      sizeBytes: file.sizeBytes,
      modifiedAtMs: file.modifiedAtMs,
      errorCode: null,
      errorStage: null,
      warningCodes: [],
    });
    database.finalizeSuccessfulScan({
      scanJobId: "inventory-scan",
      rootId: "music",
      stagedFiles: [{ id: "inventory-file", file }],
      seenRelativePaths: [file.relativePath],
      albums: [albumInput("digital-version", ["inventory-file"])],
      withWarnings: false,
    });
    const now = "2026-08-16T00:00:00.000Z";
    database.createPhysicalCopy({
      id: "digital-copy",
      albumId: "digital-version",
      medium: "CD",
      label: null,
      catalogNumber: null,
      barcode: null,
      country: null,
      releaseYear: null,
      quantity: 2,
      conditionNote: null,
      storageLocation: null,
      createdAt: now,
      updatedAt: now,
    });
    database.createPhysicalOnlyAlbum({
      id: "physical-version",
      groupKey: "physical-version",
      title: "Physical",
      albumArtist: "Artist",
      year: null,
    });
    database.createPhysicalCopy({
      id: "physical-copy",
      albumId: "physical-version",
      medium: "VINYL",
      label: null,
      catalogNumber: null,
      barcode: null,
      country: null,
      releaseYear: null,
      quantity: 1,
      conditionNote: null,
      storageLocation: null,
      createdAt: now,
      updatedAt: now,
    });
    database.createPhysicalOnlyAlbum({
      id: "history-version",
      groupKey: "history-version",
      title: "History",
      albumArtist: "Artist",
      year: null,
    });
    database.raw
      .prepare(
        `INSERT INTO album_introductions
         (album_id,content,model,factual_basis_json,source_hash,generated_at)
         VALUES ('history-version','history','local','{}',?,?)`,
      )
      .run("a".repeat(64), now);
    const historyLibraryAlbumId =
      database.getAlbumSummary("history-version")!.id;
    database.raw
      .prepare("UPDATE library_albums SET visibility='HIDDEN' WHERE id=?")
      .run(historyLibraryAlbumId);

    const report = database.getLibraryInventoryReport("inventory-scan");
    const independentAlbumBase = Number(
      (
        database.raw.prepare("SELECT COUNT(*) AS count FROM albums").get() as {
          count: number;
        }
      ).count,
    );
    expect(report.findings).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.counts.localVersions).toBe(independentAlbumBase);
    expect(
      report.counts.currentDigital +
        report.counts.physicalOnly +
        report.counts.referencedHistory +
        report.counts.orphan,
    ).toBe(independentAlbumBase);
    expect(report.counts).toEqual(
      expect.objectContaining({
        localVersions: 3,
        currentDigital: 1,
        physicalOnly: 1,
        referencedHistory: 1,
        orphan: 0,
        physicalVersions: 2,
        digitalPhysicalOverlap: 1,
        physicalCopies: 2,
        physicalQuantity: 3,
        scanAlbumCount: 1,
        scanParsedFiles: 1,
      }),
    );
    expect(report.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          localVersionId: "digital-version",
          classification: "CURRENT_DIGITAL",
          reasons: ["CURRENT_FILES"],
        }),
        expect.objectContaining({
          localVersionId: "physical-version",
          classification: "PHYSICAL_ONLY",
          reasons: ["PHYSICAL_COPY"],
        }),
        expect.objectContaining({
          localVersionId: "history-version",
          classification: "REFERENCED_HISTORY",
          reasons: expect.arrayContaining(["ALBUM_INTRODUCTION"]),
        }),
      ]),
    );
    expect(report.scanParsedMediaIds).toEqual(["inventory-file"]);
    expect(report.currentRootMediaIds).toEqual(["inventory-file"]);
    expect(JSON.stringify(report)).not.toContain("/library/music");
  });

  it("fails inventory closed when a visible LibraryAlbum has no primary version", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    finalizeEmptyInventoryScan(database, "missing-primary-scan");
    database.createPhysicalOnlyAlbum({
      id: "missing-primary-version",
      groupKey: "missing-primary-version",
      title: "Missing Primary",
      albumArtist: "Artist",
      year: null,
    });
    const libraryAlbumId = database.getAlbumSummary(
      "missing-primary-version",
    )!.id;
    database.raw
      .prepare("UPDATE library_albums SET primary_version_id=NULL WHERE id=?")
      .run(libraryAlbumId);

    const report = database.getLibraryInventoryReport("missing-primary-scan");
    expect(
      report.libraryAlbums.find(
        (album) => album.libraryAlbumId === libraryAlbumId,
      ),
    ).toEqual(
      expect.objectContaining({ visible: true, primaryVersionId: null }),
    );
    expect(report.findings).toContainEqual({
      code: "LIBRARY_ALBUM_WITHOUT_PRIMARY_VERSION",
      localVersionId: null,
      libraryAlbumId,
      mediaFileId: null,
    });
    expect(report.valid).toBe(false);
  });

  it("fails inventory closed when a visible LibraryAlbum points at another group's member", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    finalizeEmptyInventoryScan(database, "cross-group-primary-scan");
    for (const id of ["primary-group-a", "primary-group-b"])
      database.createPhysicalOnlyAlbum({
        id,
        groupKey: id,
        title: id,
        albumArtist: "Artist",
        year: null,
      });
    const firstGroupId = database.getAlbumSummary("primary-group-a")!.id;
    const secondGroupId = database.getAlbumSummary("primary-group-b")!.id;
    expect(firstGroupId).not.toBe(secondGroupId);
    database.raw
      .prepare(
        "UPDATE library_albums SET primary_version_id='primary-group-b' WHERE id=?",
      )
      .run(firstGroupId);

    const report = database.getLibraryInventoryReport(
      "cross-group-primary-scan",
    );
    expect(
      report.libraryAlbums.find(
        (album) => album.libraryAlbumId === firstGroupId,
      ),
    ).toEqual(
      expect.objectContaining({
        visible: true,
        primaryVersionId: "primary-group-b",
      }),
    );
    expect(report.findings).toContainEqual({
      code: "PRIMARY_VERSION_NOT_MEMBER",
      localVersionId: "primary-group-b",
      libraryAlbumId: firstGroupId,
      mediaFileId: null,
    });
    expect(report.valid).toBe(false);
  });

  it("fails inventory closed for a visible all-history LibraryAlbum", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    finalizeEmptyInventoryScan(database, "visible-history-scan");
    database.createPhysicalOnlyAlbum({
      id: "visible-history-version",
      groupKey: "visible-history-version",
      title: "Visible History",
      albumArtist: "Artist",
      year: null,
    });
    database.raw
      .prepare(
        `INSERT INTO album_introductions
         (album_id,content,model,factual_basis_json,source_hash,generated_at)
         VALUES ('visible-history-version','history','local','{}',?,?)`,
      )
      .run("b".repeat(64), "2026-08-16T00:00:00.000Z");
    const libraryAlbumId = database.getAlbumSummary(
      "visible-history-version",
    )!.id;

    const report = database.getLibraryInventoryReport("visible-history-scan");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "VISIBLE_ALBUM_WITHOUT_CURRENT_MEMBER",
          libraryAlbumId,
        }),
        expect.objectContaining({
          code: "PRIMARY_VERSION_WITHOUT_FILES",
          localVersionId: "visible-history-version",
          libraryAlbumId,
        }),
      ]),
    );
    expect(report.valid).toBe(false);
  });

  it("fails inventory closed for an ungrouped local version", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    finalizeSingleFileInventoryScan(database, "ungrouped-version-scan");
    database.raw
      .prepare(
        "DELETE FROM library_album_members WHERE album_id='ungrouped-version-scan-version'",
      )
      .run();

    const report = database.getLibraryInventoryReport("ungrouped-version-scan");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "LOCAL_VERSION_WITHOUT_LIBRARY_ALBUM",
          localVersionId: "ungrouped-version-scan-version",
        }),
      ]),
    );
    expect(report.valid).toBe(false);
  });

  it("fails inventory closed when Album, media, and scan roots diverge", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    finalizeSingleFileInventoryScan(database, "cross-root-scan");
    database.raw
      .prepare("UPDATE media_files SET root_id='physical' WHERE id=?")
      .run("cross-root-scan-file");

    const report = database.getLibraryInventoryReport("cross-root-scan");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MEDIA_FILE_ROOT_MISMATCH",
          localVersionId: "cross-root-scan-version",
          mediaFileId: "cross-root-scan-file",
        }),
        expect.objectContaining({
          code: "SCAN_MEDIA_ROOT_MISMATCH",
          mediaFileId: "cross-root-scan-file",
        }),
      ]),
    );
    expect(report.valid).toBe(false);
  });

  it("fails inventory closed when frozen PARSED media identifiers repeat", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    finalizeSingleFileInventoryScan(database, "duplicate-parsed-scan");
    database.raw.exec("DROP TRIGGER scan_file_results_no_late_insert");
    database.raw
      .prepare(
        `INSERT INTO scan_file_results
         (scan_job_id,root_id,relative_path,extension,candidate_kind,outcome,
          media_file_id,size_bytes,modified_at_ms,error_code,error_stage,
          warning_codes_json,created_at)
         SELECT scan_job_id,root_id,'Artist/Duplicate/02.flac',extension,
                candidate_kind,outcome,media_file_id,size_bytes,modified_at_ms,
                error_code,error_stage,warning_codes_json,created_at
         FROM scan_file_results WHERE scan_job_id=? AND outcome='PARSED' LIMIT 1`,
      )
      .run("duplicate-parsed-scan");

    const report = database.getLibraryInventoryReport("duplicate-parsed-scan");
    expect(report.scanParsedMediaIds).toEqual([
      "duplicate-parsed-scan-file",
      "duplicate-parsed-scan-file",
    ]);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SCAN_PARSED_MEDIA_ID_DUPLICATE" }),
        expect.objectContaining({ code: "SCAN_PARSED_FILE_COUNT_MISMATCH" }),
      ]),
    );
    expect(report.valid).toBe(false);
  });

  it("fails inventory closed when the frozen scan album count drifts from current state", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    finalizeSingleFileInventoryScan(database, "album-count-drift-scan");
    database.raw.exec("DROP TRIGGER scan_reports_immutable_update");
    database.raw
      .prepare(
        "UPDATE scan_reports SET album_count=album_count+1 WHERE scan_job_id=?",
      )
      .run("album-count-drift-scan");

    const report = database.getLibraryInventoryReport("album-count-drift-scan");
    expect(report.counts.scanAlbumCount).toBe(2);
    expect(report.counts.currentDigital).toBe(1);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SCAN_ALBUM_COUNT_MISMATCH" }),
      ]),
    );
    expect(report.valid).toBe(false);
  });

  it("fails inventory closed when the frozen PARSED media set drifts from current state", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    finalizeSingleFileInventoryScan(database, "parsed-media-drift-scan");
    database.raw.exec("DROP TRIGGER scan_file_results_immutable_update");
    database.raw
      .prepare(
        `UPDATE scan_file_results SET media_file_id='different-parsed-media'
         WHERE scan_job_id=? AND outcome='PARSED'`,
      )
      .run("parsed-media-drift-scan");

    const report = database.getLibraryInventoryReport(
      "parsed-media-drift-scan",
    );
    expect(report.scanParsedMediaIds).toEqual(["different-parsed-media"]);
    expect(report.currentRootMediaIds).toEqual([
      "parsed-media-drift-scan-file",
    ]);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SCAN_MEDIA_ID_MISMATCH" }),
      ]),
    );
    expect(report.valid).toBe(false);
  });

  it("fails inventory closed for an orphan and an unplayable visible primary", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    createRunningScan(database, "invalid-inventory-scan");
    const file = observedFile("Artist/Valid/01.flac", 10);
    database.recordScanDiscovery({
      scanJobId: "invalid-inventory-scan",
      rulesVersion: "inventory-test/1",
      candidates: 1,
      regularFiles: 1,
      auxiliaryFiles: 0,
      ignoredFiles: 0,
      skippedSymlinks: 0,
      traversalErrors: 0,
    });
    database.recordScanFileResult({
      scanJobId: "invalid-inventory-scan",
      rootId: "music",
      relativePath: file.relativePath,
      extension: ".flac",
      candidateKind: "SUPPORTED_AUDIO",
      outcome: "PARSED",
      mediaFileId: "valid-file",
      sizeBytes: file.sizeBytes,
      modifiedAtMs: file.modifiedAtMs,
      errorCode: null,
      errorStage: null,
      warningCodes: [],
    });
    database.finalizeSuccessfulScan({
      scanJobId: "invalid-inventory-scan",
      rootId: "music",
      stagedFiles: [{ id: "valid-file", file }],
      seenRelativePaths: [file.relativePath],
      albums: [
        { ...albumInput("valid-version", ["valid-file"]), title: "Grouped" },
        { ...albumInput("stale-version", []), title: "Grouped" },
      ],
      withWarnings: false,
    });
    const groupId = database.getAlbumSummary("valid-version")!.id;
    database.createPhysicalOnlyAlbum({
      id: "orphan-version",
      groupKey: "orphan-version",
      title: "Orphan",
      albumArtist: "Nobody",
      year: null,
    });
    database.raw
      .prepare("DELETE FROM library_issues WHERE album_id='orphan-version'")
      .run();
    database.raw
      .prepare(
        `UPDATE library_albums SET primary_version_id='stale-version'
         WHERE id=?`,
      )
      .run(groupId);

    const report = database.getLibraryInventoryReport("invalid-inventory-scan");
    expect(report.valid).toBe(false);
    expect(report.counts.orphan).toBeGreaterThan(0);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PRIMARY_VERSION_WITHOUT_FILES",
          localVersionId: "stale-version",
        }),
      ]),
    );
  });

  it("previews and atomically detaches an orphan from a playable sibling without file lifecycle work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-orphan-detach-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "cocean.sqlite");
    const database = new CoceanDatabase(path);
    open.push(database);
    finalizeSingleFileInventoryScan(database, "orphan-detach-scan");
    finalizeEmptyInventoryScan(
      database,
      "orphan-detach-physical-scan",
      "physical",
    );
    seedPassiveOrphanSideEffectRows(database, "detach");
    database.raw
      .prepare(
        `UPDATE albums SET title='Governed',album_artist='Artist'
         WHERE id='orphan-detach-scan-version'`,
      )
      .run();
    database.createPhysicalOnlyAlbum({
      id: "orphan-detach-target",
      groupKey: "orphan-detach-target",
      title: "Governed",
      albumArtist: "Artist",
      year: null,
    });
    database.raw
      .prepare("DELETE FROM library_issues WHERE album_id=?")
      .run("orphan-detach-target");
    const orphanMemberAddedAt = "2025-06-07T08:09:10.000Z";
    database.raw
      .prepare("UPDATE albums SET created_at=? WHERE id=?")
      .run(orphanMemberAddedAt, "orphan-detach-target");
    database.raw
      .prepare(
        `UPDATE library_album_members SET library_album_id=(
           SELECT library_album_id FROM library_album_members WHERE album_id='orphan-detach-scan-version'
         ) WHERE album_id='orphan-detach-target'`,
      )
      .run();
    const sourceId = database.getAlbumSummary("orphan-detach-scan-version")!.id;
    const sourceAddedAt = "2024-03-04T05:06:07.000Z";
    database.raw
      .prepare("UPDATE library_albums SET created_at=? WHERE id=?")
      .run(sourceAddedAt, sourceId);
    const businessBefore = {
      albums: Number(
        (
          database.raw
            .prepare("SELECT COUNT(*) AS count FROM albums")
            .get() as {
            count: number;
          }
        ).count,
      ),
      files: Number(
        (
          database.raw
            .prepare("SELECT COUNT(*) AS count FROM media_files")
            .get() as { count: number }
        ).count,
      ),
      lifecycle: Number(
        (
          database.raw
            .prepare("SELECT COUNT(*) AS count FROM library_change_plans")
            .get() as { count: number }
        ).count,
      ),
      lifecycleEvents: Number(
        (
          database.raw
            .prepare("SELECT COUNT(*) AS count FROM library_change_events")
            .get() as { count: number }
        ).count,
      ),
      deliveryJobs: Number(
        (
          database.raw
            .prepare("SELECT COUNT(*) AS count FROM delivery_jobs")
            .get() as { count: number }
        ).count,
      ),
      deliveryRecords: Number(
        (
          database.raw
            .prepare("SELECT COUNT(*) AS count FROM delivery_records")
            .get() as { count: number }
        ).count,
      ),
    };

    const preview = database.previewOrphanGovernance("orphan-detach-target", {
      localVersionId: "orphan-detach-target",
    });
    expect(preview).toEqual(
      expect.objectContaining({
        action: "DETACH_TO_HIDDEN_HISTORY",
        executable: true,
        replacementPrimaryVersionId: "orphan-detach-scan-version",
        blockers: [],
      }),
    );
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM library_orphan_governance_events",
        )
        .get(),
    ).toEqual({ count: 0 });

    const command = {
      requestId: "orphan-detach-request",
      action: "DETACH_TO_HIDDEN_HISTORY" as const,
      expectedFingerprint: preview.expectedFingerprint,
      scanJobId: preview.expected.scanJobId,
      localVersionId: preview.expected.localVersionId,
      expected: preview.expected,
    };
    const result = database.confirmOrphanGovernance(
      "orphan-detach-target",
      command,
      {
        id: "admin",
        displayName: "Admin",
      },
    );
    expect(
      database.confirmOrphanGovernance("orphan-detach-target", command, {
        id: "admin",
        displayName: "Admin",
      }),
    ).toEqual(result);
    expect(result).toEqual(
      expect.objectContaining({
        status: "APPLIED",
        action: "DETACH_TO_HIDDEN_HISTORY",
      }),
    );
    expect(result.resultingLibraryAlbumId).not.toBe(sourceId);
    expect(database.getAlbumSummary(sourceId)).toEqual(
      expect.objectContaining({
        addedAt: sourceAddedAt,
        primaryVersionId: "orphan-detach-scan-version",
        visibility: "VISIBLE",
      }),
    );
    expect(database.getAlbumSummary(result.resultingLibraryAlbumId!)).toEqual(
      expect.objectContaining({
        addedAt: orphanMemberAddedAt,
        primaryVersionId: "orphan-detach-target",
        visibility: "HIDDEN",
      }),
    );
    finalizeEmptyInventoryScan(database, "post-detach-rescan", "physical");
    expect(
      database
        .getLibraryInventoryReport("post-detach-rescan")
        .versions.find(
          (version) => version.localVersionId === "orphan-detach-target",
        ),
    ).toEqual(
      expect.objectContaining({
        classification: "REFERENCED_HISTORY",
        reasons: expect.arrayContaining(["ORPHAN_GOVERNANCE"]),
      }),
    );
    expect(
      database.raw.prepare("SELECT COUNT(*) AS count FROM albums").get(),
    ).toEqual({ count: businessBefore.albums });
    expect(
      database.raw.prepare("SELECT COUNT(*) AS count FROM media_files").get(),
    ).toEqual({ count: businessBefore.files });
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM library_change_plans")
        .get(),
    ).toEqual({ count: businessBefore.lifecycle });
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM library_change_events")
        .get(),
    ).toEqual({ count: businessBefore.lifecycleEvents });
    expect(
      database.raw.prepare("SELECT COUNT(*) AS count FROM delivery_jobs").get(),
    ).toEqual({ count: businessBefore.deliveryJobs });
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM delivery_records")
        .get(),
    ).toEqual({ count: businessBefore.deliveryRecords });
    const resultingLibraryAlbumId = result.resultingLibraryAlbumId!;
    open.splice(open.indexOf(database), 1);
    database.close();
    const reopened = new CoceanDatabase(path);
    open.push(reopened);
    expect(reopened.getAlbumSummary(sourceId)?.primaryVersionId).toBe(
      "orphan-detach-scan-version",
    );
    expect(reopened.getAlbumSummary(sourceId)?.addedAt).toBe(sourceAddedAt);
    expect(reopened.getAlbumSummary(resultingLibraryAlbumId)).toEqual(
      expect.objectContaining({
        addedAt: orphanMemberAddedAt,
        visibility: "HIDDEN",
        primaryVersionId: "orphan-detach-target",
      }),
    );
    expect(
      reopened.listOrphanGovernanceHistory("orphan-detach-target"),
    ).toEqual([expect.objectContaining({ status: "APPLIED" })]);
  });

  it("hides an all-history group and closes a standalone orphan with append-only audit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-orphan-close-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "cocean.sqlite");
    const database = new CoceanDatabase(path);
    open.push(database);
    finalizeEmptyInventoryScan(database, "orphan-history-scan", "physical");
    seedPassiveOrphanSideEffectRows(database, "close");
    const sideEffectsBefore = {
      deliveries: database
        .listDeliveryJobs()
        .map((job) => [job.id, job.status]),
      lifecycle: database
        .listLibraryChangePlans()
        .map((plan) => [plan.id, plan.status]),
    };
    const now = "2026-08-16T00:00:00.000Z";
    database.createPhysicalOnlyAlbum({
      id: "history-govern-target",
      groupKey: "history-govern-target",
      title: "History",
      albumArtist: "Artist",
      year: null,
    });
    database.raw
      .prepare("DELETE FROM library_issues WHERE album_id=?")
      .run("history-govern-target");
    database.raw
      .prepare(
        `INSERT INTO album_introductions
         (album_id,content,model,factual_basis_json,source_hash,generated_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        "history-govern-target",
        "history",
        "local",
        "{}",
        "c".repeat(64),
        now,
      );
    const historyGroup = database.getAlbumSummary("history-govern-target")!.id;
    const historyAddedAt = "2024-04-05T06:07:08.000Z";
    database.raw
      .prepare("UPDATE library_albums SET created_at=? WHERE id=?")
      .run(historyAddedAt, historyGroup);
    const historyPreview = database.previewOrphanGovernance(
      "history-govern-target",
      {
        localVersionId: "history-govern-target",
      },
    );
    expect(historyPreview.action).toBe("HIDE_HISTORY_GROUP");
    database.confirmOrphanGovernance(
      "history-govern-target",
      {
        requestId: "hide-history-request",
        action: "HIDE_HISTORY_GROUP",
        expectedFingerprint: historyPreview.expectedFingerprint,
        scanJobId: historyPreview.expected.scanJobId,
        localVersionId: "history-govern-target",
        expected: historyPreview.expected,
      },
      { id: "admin", displayName: "Admin" },
    );
    expect(database.getAlbumSummary(historyGroup)).toEqual(
      expect.objectContaining({
        addedAt: historyAddedAt,
        visibility: "HIDDEN",
      }),
    );
    expect(
      database.previewOrphanGovernance("history-govern-target", {
        localVersionId: "history-govern-target",
      }),
    ).toEqual(
      expect.objectContaining({
        executable: false,
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: "ALREADY_GOVERNED" }),
        ]),
      }),
    );

    database.createPhysicalOnlyAlbum({
      id: "standalone-orphan",
      groupKey: "standalone-orphan",
      title: "Orphan",
      albumArtist: "Artist",
      year: null,
    });
    database.raw
      .prepare("DELETE FROM library_issues WHERE album_id=?")
      .run("standalone-orphan");
    const orphanGroup = database.getAlbumSummary("standalone-orphan")!.id;
    const orphanAddedAt = "2024-06-07T08:09:10.000Z";
    database.raw
      .prepare("UPDATE library_albums SET created_at=? WHERE id=?")
      .run(orphanAddedAt, orphanGroup);
    const orphanPreview = database.previewOrphanGovernance(
      "standalone-orphan",
      {
        localVersionId: "standalone-orphan",
      },
    );
    expect(orphanPreview.action).toBe("CLOSE_ORPHAN_IDENTITY");
    const orphanResult = database.confirmOrphanGovernance(
      "standalone-orphan",
      {
        requestId: "close-orphan-request",
        action: "CLOSE_ORPHAN_IDENTITY",
        expectedFingerprint: orphanPreview.expectedFingerprint,
        scanJobId: orphanPreview.expected.scanJobId,
        localVersionId: "standalone-orphan",
        expected: orphanPreview.expected,
      },
      { id: "admin", displayName: "Admin" },
    );
    expect(orphanResult.resultingLibraryAlbumId).toBe(orphanGroup);
    expect(database.getAlbumSummary(orphanGroup)).toEqual(
      expect.objectContaining({
        addedAt: orphanAddedAt,
        visibility: "HIDDEN",
      }),
    );
    finalizeEmptyInventoryScan(database, "post-governance-rescan", "physical");
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM albums WHERE id=?")
        .get("standalone-orphan"),
    ).toEqual({ count: 1 });
    expect(
      database
        .getLibraryInventoryReport("post-governance-rescan")
        .versions.find(
          (version) => version.localVersionId === "standalone-orphan",
        ),
    ).toEqual(
      expect.objectContaining({
        classification: "REFERENCED_HISTORY",
        reasons: expect.arrayContaining(["ORPHAN_GOVERNANCE"]),
      }),
    );
    expect(() =>
      database.raw
        .prepare(
          "UPDATE library_orphan_governance_events SET actor_display_name='tampered'",
        )
        .run(),
    ).toThrow(/append-only/);
    expect(() =>
      database.raw
        .prepare("DELETE FROM library_orphan_governance_events")
        .run(),
    ).toThrow(/append-only/);
    open.splice(open.indexOf(database), 1);
    database.close();
    const reopened = new CoceanDatabase(path);
    open.push(reopened);
    expect(reopened.getAlbumSummary(historyGroup)).toEqual(
      expect.objectContaining({
        addedAt: historyAddedAt,
        visibility: "HIDDEN",
      }),
    );
    expect(reopened.getAlbumSummary(orphanGroup)).toEqual(
      expect.objectContaining({
        addedAt: orphanAddedAt,
        visibility: "HIDDEN",
      }),
    );
    expect(
      reopened.listOrphanGovernanceHistory("history-govern-target"),
    ).toEqual([
      expect.objectContaining({
        status: "APPLIED",
        action: "HIDE_HISTORY_GROUP",
      }),
    ]);
    expect(reopened.listOrphanGovernanceHistory("standalone-orphan")).toEqual([
      expect.objectContaining({
        status: "APPLIED",
        action: "CLOSE_ORPHAN_IDENTITY",
      }),
    ]);
    expect(
      reopened.listDeliveryJobs().map((job) => [job.id, job.status]),
    ).toEqual(sideEffectsBefore.deliveries);
    expect(
      reopened.listLibraryChangePlans().map((plan) => [plan.id, plan.status]),
    ).toEqual(sideEffectsBefore.lifecycle);
    expect(reopened.claimNextLibraryChangePlan()).toBeNull();
  });

  it("rejects drift atomically, records one rejection, and binds requestId to exact input", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    finalizeEmptyInventoryScan(database, "orphan-drift-scan", "physical");
    database.createPhysicalOnlyAlbum({
      id: "orphan-drift-target",
      groupKey: "orphan-drift-target",
      title: "Drift",
      albumArtist: "Artist",
      year: null,
    });
    database.raw
      .prepare("DELETE FROM library_issues WHERE album_id=?")
      .run("orphan-drift-target");
    const groupId = database.getAlbumSummary("orphan-drift-target")!.id;
    const preview = database.previewOrphanGovernance("orphan-drift-target", {
      localVersionId: "orphan-drift-target",
    });
    database.raw
      .prepare("UPDATE library_albums SET revision=revision+1 WHERE id=?")
      .run(groupId);
    const command = {
      requestId: "orphan-drift-request",
      action: "CLOSE_ORPHAN_IDENTITY" as const,
      expectedFingerprint: preview.expectedFingerprint,
      scanJobId: preview.expected.scanJobId,
      localVersionId: "orphan-drift-target",
      expected: preview.expected,
    };
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect(() =>
        database.confirmOrphanGovernance("orphan-drift-target", command, {
          id: "admin",
          displayName: "Admin",
        }),
      ).toThrow(OrphanGovernanceError);
    expect(database.getAlbumSummary(groupId)!.visibility).toBe("VISIBLE");
    expect(
      database.raw
        .prepare(
          `SELECT COUNT(*) AS count FROM library_orphan_governance_events
           WHERE request_id='orphan-drift-request' AND status='REJECTED'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(() =>
      database.confirmOrphanGovernance(
        "orphan-drift-target",
        { ...command, expectedFingerprint: "f".repeat(64) },
        { id: "admin", displayName: "Admin" },
      ),
    ).toThrow(/requestId 已用于不同/);
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM library_orphan_governance_events",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("audits a rejected confirmation when its authoritative scan is superseded", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    finalizeEmptyInventoryScan(database, "orphan-old-scan", "physical");
    database.createPhysicalOnlyAlbum({
      id: "orphan-scan-drift-target",
      groupKey: "orphan-scan-drift-target",
      title: "Scan Drift",
      albumArtist: "Artist",
      year: null,
    });
    database.raw
      .prepare("DELETE FROM library_issues WHERE album_id=?")
      .run("orphan-scan-drift-target");
    const groupId = database.getAlbumSummary("orphan-scan-drift-target")!.id;
    const preview = database.previewOrphanGovernance(
      "orphan-scan-drift-target",
      {
        localVersionId: "orphan-scan-drift-target",
      },
    );
    database.raw
      .prepare(
        `INSERT INTO album_introductions
         (album_id,content,model,factual_basis_json,source_hash,generated_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        "orphan-scan-drift-target",
        "retained",
        "local",
        "{}",
        "d".repeat(64),
        "2026-08-16T00:00:00.000Z",
      );
    finalizeEmptyInventoryScan(database, "orphan-new-scan", "physical");
    expect(() =>
      database.confirmOrphanGovernance(
        "orphan-scan-drift-target",
        {
          requestId: "orphan-scan-drift-request",
          action: "CLOSE_ORPHAN_IDENTITY",
          expectedFingerprint: preview.expectedFingerprint,
          scanJobId: "orphan-old-scan",
          localVersionId: "orphan-scan-drift-target",
          expected: preview.expected,
        },
        { id: "admin", displayName: "Admin" },
      ),
    ).toThrow(/重新预览/);
    expect(
      database.raw
        .prepare(
          `SELECT status,error_code FROM library_orphan_governance_events
           WHERE request_id='orphan-scan-drift-request'`,
        )
        .get(),
    ).toEqual({
      status: "REJECTED",
      error_code: "ORPHAN_GOVERNANCE_CONFLICT",
    });
  });

  it("scopes an ungrouped preview to only its target and never falls back across roots", () => {
    const noPhysicalScan = new CoceanDatabase(":memory:");
    open.push(noPhysicalScan);
    finalizeEmptyInventoryScan(noPhysicalScan, "music-only-authority");
    noPhysicalScan.createPhysicalOnlyAlbum({
      id: "no-authority-target",
      groupKey: "no-authority-target",
      title: "No Authority",
      albumArtist: "Artist",
      year: null,
    });
    expect(() =>
      noPhysicalScan.previewOrphanGovernance("no-authority-target", {
        localVersionId: "no-authority-target",
      }),
    ).toThrowError(expect.objectContaining({ code: "NO_AUTHORITATIVE_SCAN" }));

    const database = new CoceanDatabase(":memory:");
    open.push(database);
    finalizeEmptyInventoryScan(database, "physical-authority", "physical");
    for (const id of ["ungrouped-target", "ungrouped-neighbor"])
      database.createPhysicalOnlyAlbum({
        id,
        groupKey: id,
        title: id,
        albumArtist: "Artist",
        year: null,
      });
    database.raw
      .prepare(
        `DELETE FROM library_album_members
         WHERE album_id IN ('ungrouped-target','ungrouped-neighbor')`,
      )
      .run();
    const preview = database.previewOrphanGovernance("ungrouped-target", {
      localVersionId: "ungrouped-target",
    });
    expect(preview.expected.libraryAlbumId).toBeNull();
    expect(preview.expected.memberVersionIds).toEqual(["ungrouped-target"]);
    expect(
      preview.expected.memberFacts.map((fact) => fact.localVersionId),
    ).toEqual(["ungrouped-target"]);
    expect(() =>
      database.previewOrphanGovernance("ungrouped-neighbor", {
        localVersionId: "ungrouped-target",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "ORPHAN_RESOURCE_MISMATCH" }),
    );
  });

  it("records exactly one stable rejection when the target disappears", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    finalizeEmptyInventoryScan(database, "disappearing-authority", "physical");
    database.createPhysicalOnlyAlbum({
      id: "disappearing-target",
      groupKey: "disappearing-target",
      title: "Disappearing",
      albumArtist: "Artist",
      year: null,
    });
    database.raw
      .prepare(
        "DELETE FROM library_issues WHERE album_id='disappearing-target'",
      )
      .run();
    const preview = database.previewOrphanGovernance("disappearing-target", {
      localVersionId: "disappearing-target",
    });
    database.raw
      .prepare(
        "DELETE FROM library_album_members WHERE album_id='disappearing-target'",
      )
      .run();
    database.raw
      .prepare("DELETE FROM albums WHERE id='disappearing-target'")
      .run();
    const command = {
      requestId: "disappearing-request",
      action: "CLOSE_ORPHAN_IDENTITY" as const,
      expectedFingerprint: preview.expectedFingerprint,
      scanJobId: preview.expected.scanJobId,
      localVersionId: "disappearing-target",
      expected: preview.expected,
    };
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect(() =>
        database.confirmOrphanGovernance("disappearing-target", command, {
          id: "admin",
          displayName: "Admin",
        }),
      ).toThrowError(
        expect.objectContaining({ code: "ORPHAN_TARGET_NOT_FOUND" }),
      );
    const events = database.listOrphanGovernanceHistory("disappearing-target");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        status: "REJECTED",
        errorCode: "ORPHAN_TARGET_NOT_FOUND",
        expected: preview.expected,
        before: null,
      }),
    );
  });

  it("does not let a rejected event retain a target through a later scan", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    finalizeEmptyInventoryScan(database, "rejected-authority", "physical");
    database.createPhysicalOnlyAlbum({
      id: "rejected-rescan-target",
      groupKey: "rejected-rescan-target",
      title: "Rejected",
      albumArtist: "Artist",
      year: null,
    });
    database.raw
      .prepare(
        "DELETE FROM library_issues WHERE album_id='rejected-rescan-target'",
      )
      .run();
    const preview = database.previewOrphanGovernance("rejected-rescan-target", {
      localVersionId: "rejected-rescan-target",
    });
    database.raw
      .prepare("UPDATE library_albums SET revision=revision+1 WHERE id=?")
      .run(preview.expected.libraryAlbumId);
    expect(() =>
      database.confirmOrphanGovernance(
        "rejected-rescan-target",
        {
          requestId: "rejected-rescan-request",
          action: "CLOSE_ORPHAN_IDENTITY",
          expectedFingerprint: preview.expectedFingerprint,
          scanJobId: preview.expected.scanJobId,
          localVersionId: "rejected-rescan-target",
          expected: preview.expected,
        },
        { id: "admin", displayName: "Admin" },
      ),
    ).toThrow(OrphanGovernanceError);
    finalizeEmptyInventoryScan(database, "after-rejected-rescan", "physical");
    expect(database.getAlbum("rejected-rescan-target")).toBeNull();
    expect(
      database.listOrphanGovernanceHistory("rejected-rescan-target"),
    ).toEqual([expect.objectContaining({ status: "REJECTED" })]);
  });

  it("blocks and rejects governance while a formally produced lifecycle plan is active", () => {
    const database = new CoceanDatabase(":memory:", {
      musicRootPolicy: "MANAGED",
    });
    open.push(database);
    finalizeSingleFileInventoryScan(database, "lifecycle-blocker-source");
    const album = database.getAlbumSummary("lifecycle-blocker-source-version")!;
    const actor = { id: "admin", displayName: "Admin" };
    const plan = database.createQuarantinePlan(
      album.id,
      {
        requestId: "lifecycle-blocker-preview",
        expectedLibraryRevision: album.revision,
        localVersionId: "lifecycle-blocker-source-version",
      },
      actor,
    );
    finalizeEmptyInventoryScan(database, "lifecycle-blocker-empty");
    const preview = database.previewOrphanGovernance(
      "lifecycle-blocker-source-version",
      { localVersionId: "lifecycle-blocker-source-version" },
    );
    expect(preview.blockers).toContainEqual(
      expect.objectContaining({ code: "ACTIVE_LIFECYCLE_PLAN" }),
    );
    expect(() =>
      database.confirmOrphanGovernance(
        "lifecycle-blocker-source-version",
        {
          requestId: "lifecycle-blocker-confirm",
          action: "HIDE_HISTORY_GROUP",
          expectedFingerprint: preview.expectedFingerprint,
          scanJobId: preview.expected.scanJobId,
          localVersionId: "lifecycle-blocker-source-version",
          expected: preview.expected,
        },
        actor,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "ORPHAN_GOVERNANCE_NOT_EXECUTABLE" }),
    );
    expect(database.getLibraryChangePlan(plan.id)?.status).toBe("PREVIEWED");
    expect(database.claimNextLibraryChangePlan()).toBeNull();
  });

  it("uses an independent visibility-event request namespace", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    finalizeEmptyInventoryScan(
      database,
      "visibility-namespace-scan",
      "physical",
    );
    for (const id of [
      "visibility-collision-source",
      "visibility-collision-target",
    ])
      database.createPhysicalOnlyAlbum({
        id,
        groupKey: id,
        title: id,
        albumArtist: "Artist",
        year: null,
      });
    database.raw
      .prepare("DELETE FROM library_issues WHERE album_id=?")
      .run("visibility-collision-target");
    const source = database.getAlbumSummary("visibility-collision-source")!;
    database.applyAlbumVisibility(
      source.id,
      {
        action: "HIDE",
        requestId: "orphan:visibility-collision",
        expectedVisibilityRevision: source.visibilityRevision,
      },
      { id: "admin", displayName: "Admin" },
    );
    const preview = database.previewOrphanGovernance(
      "visibility-collision-target",
      { localVersionId: "visibility-collision-target" },
    );
    const result = database.confirmOrphanGovernance(
      "visibility-collision-target",
      {
        requestId: "visibility-collision",
        action: "CLOSE_ORPHAN_IDENTITY",
        expectedFingerprint: preview.expectedFingerprint,
        scanJobId: preview.expected.scanJobId,
        localVersionId: "visibility-collision-target",
        expected: preview.expected,
      },
      { id: "admin", displayName: "Admin" },
    );
    expect(result.status).toBe("APPLIED");
    expect(
      database.raw
        .prepare(
          `SELECT request_id FROM library_visibility_events
           WHERE library_album_id=? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(result.resultingLibraryAlbumId),
    ).toEqual({ request_id: expect.stringMatching(/^orphan-visibility:/) });
  });

  it("replays exact input and rejects different input across two database connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-orphan-race-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "cocean.sqlite");
    const first = new CoceanDatabase(path);
    const second = new CoceanDatabase(path);
    open.push(first, second);
    finalizeEmptyInventoryScan(first, "dual-connection-scan", "physical");
    first.createPhysicalOnlyAlbum({
      id: "dual-connection-target",
      groupKey: "dual-connection-target",
      title: "Dual",
      albumArtist: "Artist",
      year: null,
    });
    first.raw
      .prepare(
        "DELETE FROM library_issues WHERE album_id='dual-connection-target'",
      )
      .run();
    const preview = first.previewOrphanGovernance("dual-connection-target", {
      localVersionId: "dual-connection-target",
    });
    const command = {
      requestId: "dual-connection-request",
      action: "CLOSE_ORPHAN_IDENTITY" as const,
      expectedFingerprint: preview.expectedFingerprint,
      scanJobId: preview.expected.scanJobId,
      localVersionId: "dual-connection-target",
      expected: preview.expected,
    };
    const applied = first.confirmOrphanGovernance(
      "dual-connection-target",
      command,
      { id: "admin", displayName: "Admin" },
    );
    const replay = second.confirmOrphanGovernance(
      "dual-connection-target",
      command,
      { id: "admin", displayName: "Admin" },
    );
    expect(replay).toEqual(applied);
    expect(() =>
      second.confirmOrphanGovernance(
        "dual-connection-target",
        { ...command, action: "HIDE_HISTORY_GROUP" },
        { id: "admin", displayName: "Admin" },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "ORPHAN_REQUEST_ID_CONFLICT" }),
    );
    expect(
      first.listOrphanGovernanceHistory("dual-connection-target"),
    ).toHaveLength(1);
  });

  it("accepts only known structured audit references and never fuzzy JSON text", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    createRunningScan(database, "audit-inventory-scan");
    database.recordScanDiscovery({
      scanJobId: "audit-inventory-scan",
      rulesVersion: "inventory-test/1",
      candidates: 0,
      regularFiles: 0,
      auxiliaryFiles: 0,
      ignoredFiles: 0,
      skippedSymlinks: 0,
      traversalErrors: 0,
    });
    database.finalizeSuccessfulScan({
      scanJobId: "audit-inventory-scan",
      rootId: "music",
      stagedFiles: [],
      seenRelativePaths: [],
      albums: [],
      withWarnings: false,
    });
    for (const id of ["audit-version", "fuzzy-version"])
      database.createPhysicalOnlyAlbum({
        id,
        groupKey: id,
        title: id,
        albumArtist: "Audit",
        year: null,
      });
    database.raw
      .prepare(
        `DELETE FROM library_issues
         WHERE album_id IN ('audit-version','fuzzy-version')`,
      )
      .run();
    database.raw
      .prepare(
        `INSERT INTO library_identity_decisions
         (id,request_id,library_album_id,decision_type,actor_id,actor_display_name,
          expected_revision,resulting_revision,input_json,details_json,
          before_state_json,after_state_json,result_json,created_at)
         VALUES ('audit-decision','audit-request','retired-group','CONFIRM','admin','Admin',
                 0,1,?, '{}', ?, ?, ?, ?)`,
      )
      .run(
        JSON.stringify({ note: "fuzzy-version" }),
        JSON.stringify({
          groups: [
            {
              primaryVersionId: "audit-version",
              members: [{ albumId: "audit-version" }],
            },
          ],
        }),
        "{}",
        "{}",
        "2026-08-16T00:00:00.000Z",
      );

    const report = database.getLibraryInventoryReport("audit-inventory-scan");
    expect(report.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          localVersionId: "audit-version",
          classification: "REFERENCED_HISTORY",
          reasons: expect.arrayContaining(["USER_IDENTITY"]),
        }),
        expect.objectContaining({
          localVersionId: "fuzzy-version",
          classification: "ORPHAN",
          reasons: ["NO_CURRENT_FACT"],
        }),
      ]),
    );
  });

  it("retains exact structured audit history through an isolated rescan but deletes fuzzy text", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      albumInput("retained-audit-version", []),
      albumInput("fuzzy-audit-version", []),
    ]);
    database.raw
      .prepare(
        `DELETE FROM library_issues
         WHERE album_id IN ('retained-audit-version','fuzzy-audit-version')`,
      )
      .run();
    const libraryAlbumId = database.getAlbumSummary(
      "retained-audit-version",
    )!.id;
    database.raw
      .prepare(
        `INSERT INTO library_identity_decisions
         (id,request_id,library_album_id,decision_type,actor_id,actor_display_name,
          expected_revision,resulting_revision,input_json,details_json,
          before_state_json,after_state_json,result_json,created_at)
         VALUES ('retention-audit-decision','retention-audit-request',?,'CONFIRM',
                 'admin','Admin',0,1,?,'{}','{}',?,'{}',?)`,
      )
      .run(
        libraryAlbumId,
        JSON.stringify({ note: "fuzzy-audit-version" }),
        JSON.stringify({
          groups: [
            {
              primaryVersionId: "retained-audit-version",
              members: [{ albumId: "retained-audit-version" }],
            },
          ],
        }),
        "2026-08-16T00:00:00.000Z",
      );

    finalizeEmptyInventoryScan(database, "audit-retention-rescan");
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM albums WHERE id=?")
        .get("retained-audit-version"),
    ).toEqual({ count: 1 });
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM albums WHERE id=?")
        .get("fuzzy-audit-version"),
    ).toEqual({ count: 0 });
    expect(
      database
        .getLibraryInventoryReport("audit-retention-rescan")
        .versions.find(
          (version) => version.localVersionId === "retained-audit-version",
        ),
    ).toEqual(
      expect.objectContaining({
        classification: "REFERENCED_HISTORY",
        reasons: expect.arrayContaining(["USER_IDENTITY"]),
      }),
    );
  });

  it("uses the last successful published snapshot and rejects superseded success", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    const completeEmpty = (id: string) => {
      createRunningScan(database, id);
      database.recordScanDiscovery({
        scanJobId: id,
        rulesVersion: "inventory-test/1",
        candidates: 0,
        regularFiles: 0,
        auxiliaryFiles: 0,
        ignoredFiles: 0,
        skippedSymlinks: 0,
        traversalErrors: 0,
      });
      database.finalizeSuccessfulScan({
        scanJobId: id,
        rootId: "music",
        stagedFiles: [],
        seenRelativePaths: [],
        albums: [],
        withWarnings: false,
      });
    };
    completeEmpty("last-good-one");
    createRunningScan(database, "later-failed");
    database.recordScanDiscovery({
      scanJobId: "later-failed",
      rulesVersion: "inventory-test/1",
      candidates: 0,
      regularFiles: 0,
      auxiliaryFiles: 0,
      ignoredFiles: 0,
      skippedSymlinks: 0,
      traversalErrors: 0,
    });
    database.finalizeFailedScan("later-failed", "failed");
    expect(database.getLibraryInventoryReport("last-good-one").scanJobId).toBe(
      "last-good-one",
    );
    completeEmpty("last-good-two");
    expect(() => database.getLibraryInventoryReport("last-good-one")).toThrow(
      /latest published snapshot/,
    );
  });

  it("uses scan report row order when successful snapshots share one timestamp", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    finalizeEmptyInventoryScan(database, "z-older-same-millisecond");
    finalizeEmptyInventoryScan(database, "a-newer-same-millisecond");
    database.raw.exec("DROP TRIGGER scan_reports_immutable_update");
    database.raw
      .prepare(
        "UPDATE scan_reports SET created_at=? WHERE scan_job_id IN (?,?)",
      )
      .run(
        "2026-08-16T00:00:00.000Z",
        "z-older-same-millisecond",
        "a-newer-same-millisecond",
      );

    expect(
      database.getLibraryInventoryReport("a-newer-same-millisecond").scanJobId,
    ).toBe("a-newer-same-millisecond");
    expect(() =>
      database.getLibraryInventoryReport("z-older-same-millisecond"),
    ).toThrow(/latest published snapshot/);
  });

  it("fails closed when one media file is assigned to multiple local versions", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    createRunningScan(database, "duplicate-owner-scan");
    const file = observedFile("Artist/Album/01.flac", 10);
    database.recordScanDiscovery({
      scanJobId: "duplicate-owner-scan",
      rulesVersion: "inventory-test/1",
      candidates: 1,
      regularFiles: 1,
      auxiliaryFiles: 0,
      ignoredFiles: 0,
      skippedSymlinks: 0,
      traversalErrors: 0,
    });
    database.recordScanFileResult({
      scanJobId: "duplicate-owner-scan",
      rootId: "music",
      relativePath: file.relativePath,
      extension: ".flac",
      candidateKind: "SUPPORTED_AUDIO",
      outcome: "PARSED",
      mediaFileId: "shared-file",
      sizeBytes: file.sizeBytes,
      modifiedAtMs: file.modifiedAtMs,
      errorCode: null,
      errorStage: null,
      warningCodes: [],
    });
    database.finalizeSuccessfulScan({
      scanJobId: "duplicate-owner-scan",
      rootId: "music",
      stagedFiles: [{ id: "shared-file", file }],
      seenRelativePaths: [file.relativePath],
      albums: [albumInput("first-owner", ["shared-file"])],
      withWarnings: false,
    });
    database.createPhysicalOnlyAlbum({
      id: "second-owner",
      groupKey: "second-owner",
      title: "Second",
      albumArtist: "Owner",
      year: null,
    });
    database.raw
      .prepare("UPDATE albums SET root_id='music' WHERE id='second-owner'")
      .run();
    database.raw.exec("DROP INDEX album_files_one_album_per_media_idx");
    database.raw
      .prepare(
        `INSERT INTO album_files(album_id,media_file_id,is_primary,disc_number_override)
         VALUES ('second-owner','shared-file',1,NULL)`,
      )
      .run();

    const report = database.getLibraryInventoryReport("duplicate-owner-scan");
    expect(report.valid).toBe(false);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MEDIA_FILE_MULTIPLE_OWNERS",
          mediaFileId: "shared-file",
        }),
        expect.objectContaining({ code: "CURRENT_ROOT_MEDIA_ID_DUPLICATE" }),
      ]),
    );
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

  it("governs content-addressed artwork with independent revision, idempotency and undo", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [albumInput("artwork-version", [])]);
    const group = database.getAlbumSummary("artwork-version")!;
    const sha256 = "a".repeat(64);
    const candidateId = database.upsertArtworkCandidate(group.id, {
      sha256,
      mimeType: "image/jpeg",
      width: 1200,
      height: 1200,
      sizeBytes: 32_000,
      extension: ".jpg",
      source: "OBSERVED_EMBEDDED",
      localVersionId: "artwork-version",
      relativePath: "Artist/Album/01 Track.flac",
      kind: "Front Cover",
      evidence: { test: true },
    });
    expect(() =>
      database.upsertArtworkCandidate(group.id, {
        sha256,
        mimeType: "image/png",
        width: 800,
        height: 800,
        sizeBytes: 31_000,
        extension: ".png",
        source: "USER_UPLOAD",
        localVersionId: null,
        relativePath: null,
        kind: "FRONT",
        evidence: {},
      }),
    ).toThrow(/资产事实不一致/);
    expect(database.getAlbumArtworkGovernance(group.id)).toEqual(
      expect.objectContaining({
        artworkRevision: 1,
        selectionSource: "AUTOMATIC_PRIMARY",
        effectiveArtwork: expect.objectContaining({
          source: "EMBEDDED",
          url: `/api/v1/artwork/${sha256}`,
        }),
      }),
    );
    expect(
      database.raw
        .prepare(
          "SELECT resolution_status FROM library_issues WHERE library_album_id=? AND code='MISSING_ARTWORK'",
        )
        .get(group.id),
    ).toEqual({ resolution_status: "RESOLVED_BY_ARTWORK" });

    const select = {
      action: "SELECT" as const,
      requestId: "artwork-select",
      expectedArtworkRevision: 1,
      candidateId,
    };
    const selected = database.applyAlbumArtworkDecision(group.id, select, {
      id: "admin",
      displayName: "Admin",
    });
    expect(selected.artwork).toEqual(
      expect.objectContaining({
        artworkRevision: 2,
        selectionSource: "USER_SELECTED",
        selectedAssetSha256: sha256,
      }),
    );
    expect(database.getAlbumDeliveryBundle(group.id)?.artwork.url).toBe(
      `/api/v1/artwork/${sha256}`,
    );
    expect(
      database.applyAlbumArtworkDecision(group.id, select, {
        id: "admin",
        displayName: "Admin",
      }).event.id,
    ).toBe(selected.event.id);
    expect(() =>
      database.applyAlbumArtworkDecision(
        group.id,
        {
          action: "HIDE",
          requestId: "artwork-select",
          expectedArtworkRevision: 2,
        },
        { id: "admin", displayName: "Admin" },
      ),
    ).toThrow(AlbumArtworkDecisionError);

    const hidden = database.applyAlbumArtworkDecision(
      group.id,
      {
        action: "HIDE",
        requestId: "artwork-hide",
        expectedArtworkRevision: 2,
      },
      { id: "admin", displayName: "Admin" },
    );
    expect(hidden.artwork.selectionSource).toBe("USER_HIDDEN");
    expect(hidden.artwork.effectiveArtwork.source).toBe("NONE");
    expect(database.getAlbumDeliveryBundle(group.id)?.artwork.source).toBe(
      "NONE",
    );
    const reset = database.applyAlbumArtworkDecision(
      group.id,
      {
        action: "RESET",
        requestId: "artwork-reset",
        expectedArtworkRevision: 3,
      },
      { id: "admin", displayName: "Admin" },
    );
    expect(reset.artwork.selectionSource).toBe("AUTOMATIC_PRIMARY");
    const undone = database.undoAlbumArtworkEvent(
      group.id,
      reset.event.id,
      "artwork-reset-undo",
      4,
      { id: "admin", displayName: "Admin" },
    );
    expect(undone.artwork.selectionSource).toBe("USER_HIDDEN");
    expect(database.listAlbumArtworkHistory(group.id)).toHaveLength(4);

    database.replaceAlbumsForRoot("music", [
      { ...albumInput("artwork-version", []), title: "Rescanned" },
    ]);
    expect(database.getAlbumArtworkGovernance(group.id)).toEqual(
      expect.objectContaining({
        artworkRevision: 5,
        selectionSource: "USER_HIDDEN",
      }),
    );
    expect(() =>
      database.raw
        .prepare("UPDATE library_artwork_events SET event_type='RESET'")
        .run(),
    ).toThrow(/append-only/);
  });

  it("detects merge artwork conflicts, inherits one human choice and restores it on identity undo", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      { ...albumInput("art-merge-source", []), title: "Source" },
      { ...albumInput("art-merge-target", []), title: "Target" },
    ]);
    const sourceId = database.getAlbumSummary("art-merge-source")!.id;
    const targetId = database.getAlbumSummary("art-merge-target")!.id;
    const actor = { id: "admin", displayName: "Admin" };
    const sourceCandidate = database.upsertArtworkCandidate(sourceId, {
      sha256: "b".repeat(64),
      mimeType: "image/jpeg",
      width: 1000,
      height: 1000,
      sizeBytes: 10,
      extension: ".jpg",
      source: "USER_UPLOAD",
      localVersionId: null,
      relativePath: null,
      kind: "FRONT",
      evidence: {},
    });
    const targetCandidate = database.upsertArtworkCandidate(targetId, {
      sha256: "c".repeat(64),
      mimeType: "image/png",
      width: 900,
      height: 900,
      sizeBytes: 11,
      extension: ".png",
      source: "USER_UPLOAD",
      localVersionId: null,
      relativePath: null,
      kind: "FRONT",
      evidence: {},
    });
    database.applyAlbumArtworkDecision(
      sourceId,
      {
        action: "SELECT",
        candidateId: sourceCandidate,
        requestId: "merge-source-art",
        expectedArtworkRevision: 0,
      },
      actor,
    );
    database.applyAlbumArtworkDecision(
      targetId,
      {
        action: "SELECT",
        candidateId: targetCandidate,
        requestId: "merge-target-art",
        expectedArtworkRevision: 0,
      },
      actor,
    );
    expect(() =>
      database.applyLibraryIdentityDecision(
        sourceId,
        {
          type: "MERGE",
          requestId: "merge-art-conflict",
          revision: 0,
          targetLibraryAlbumId: targetId,
          targetRevision: 0,
          primaryVersionId: "art-merge-target",
        },
        actor,
      ),
    ).toThrow(/封面决定冲突/);
    database.applyAlbumArtworkDecision(
      targetId,
      {
        action: "RESET",
        requestId: "merge-target-reset",
        expectedArtworkRevision: 1,
      },
      actor,
    );
    const merged = database.applyLibraryIdentityDecision(
      sourceId,
      {
        type: "MERGE",
        requestId: "merge-art-success",
        revision: 0,
        targetLibraryAlbumId: targetId,
        targetRevision: 0,
        primaryVersionId: "art-merge-target",
      },
      actor,
    );
    expect(database.getAlbumArtworkGovernance(targetId)).toEqual(
      expect.objectContaining({
        selectionSource: "USER_SELECTED",
        selectedAssetSha256: "b".repeat(64),
      }),
    );
    expect(
      database.listAlbumArtworkHistory(targetId).map((event) => event.type),
    ).toContain("SELECT");
    database.undoLibraryIdentityDecision(
      targetId,
      merged.decision.id,
      "merge-art-undo",
      1,
      actor,
    );
    expect(database.getAlbumArtworkGovernance(sourceId)).toEqual(
      expect.objectContaining({
        selectionSource: "USER_SELECTED",
        selectedAssetSha256: "b".repeat(64),
      }),
    );
    expect(
      database.getAlbumArtworkGovernance(targetId)?.selectionSource,
    ).not.toBe("USER_SELECTED");
  });

  it("keeps a split human artwork choice only on the old-primary partition", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    database.replaceAlbumsForRoot("music", [
      {
        ...albumInput("art-split-a", []),
        title: "Split",
        albumArtist: "Artist",
      },
      {
        ...albumInput("art-split-b", []),
        title: "Split",
        albumArtist: "Artist",
      },
    ]);
    const sourceId = database.getAlbumSummary("art-split-a")!.id;
    const actor = { id: "admin", displayName: "Admin" };
    const candidate = database.upsertArtworkCandidate(sourceId, {
      sha256: "d".repeat(64),
      mimeType: "image/webp",
      width: 800,
      height: 800,
      sizeBytes: 12,
      extension: ".webp",
      source: "OBSERVED_EMBEDDED",
      localVersionId: "art-split-b",
      relativePath: "Split B/01.flac",
      kind: "Front Cover",
      evidence: {},
    });
    database.applyAlbumArtworkDecision(
      sourceId,
      {
        action: "SELECT",
        candidateId: candidate,
        requestId: "split-select-art",
        expectedArtworkRevision: 1,
      },
      actor,
    );
    database.applyLibraryIdentityDecision(
      sourceId,
      {
        type: "SPLIT",
        requestId: "split-art",
        revision: 0,
        partitions: [
          { versionIds: ["art-split-a"] },
          { versionIds: ["art-split-b"] },
        ],
      },
      actor,
    );
    const childId = database.getAlbumSummary("art-split-b")!.id;
    expect(database.getAlbumArtworkGovernance(sourceId)).toEqual(
      expect.objectContaining({
        selectionSource: "USER_SELECTED",
        selectedAssetSha256: "d".repeat(64),
      }),
    );
    expect(database.getAlbumArtworkGovernance(childId)).toEqual(
      expect.objectContaining({ selectionSource: "AUTOMATIC_PRIMARY" }),
    );
    expect(database.listAlbumArtworkHistory(childId)).toEqual([]);
  });

  it("keeps hidden albums out of normal browsing with an immutable idempotent ledger", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    seedLifecycleVersion(database, "hidden-version");
    const albumId = database.getAlbumSummary("hidden-version")!.id;
    const actor = { id: "admin", displayName: "Admin" };
    const command = {
      action: "HIDE" as const,
      requestId: "hide-once",
      expectedVisibilityRevision: 0,
    };
    const hidden = database.applyAlbumVisibility(albumId, command, actor);
    expect(hidden).toEqual(
      expect.objectContaining({ visibility: "HIDDEN", visibilityRevision: 1 }),
    );
    expect(database.applyAlbumVisibility(albumId, command, actor)).toEqual(
      hidden,
    );
    expect(database.listAlbums()).toEqual([]);
    expect(database.listAlbums({ visibility: "HIDDEN" })).toEqual([
      expect.objectContaining({ id: albumId, visibility: "HIDDEN" }),
    ]);
    expect(() =>
      database.applyAlbumVisibility(
        albumId,
        { ...command, action: "RESTORE" },
        actor,
      ),
    ).toThrow(LibraryLifecycleError);
    expect(() =>
      database.raw.prepare("DELETE FROM library_visibility_events").run(),
    ).toThrow(/append-only/);
    database.replaceAlbumsForRoot("music", [
      albumInput("hidden-version", ["hidden-version-file"]),
    ]);
    expect(database.getAlbumSummary(albumId)).toEqual(
      expect.objectContaining({ visibility: "HIDDEN", visibilityRevision: 1 }),
    );
    database.replaceAlbumsForRoot("music", []);
    database.replaceAlbumsForRoot("music", [
      albumInput("hidden-version", ["hidden-version-file"]),
    ]);
    expect(database.getAlbumSummary("hidden-version")?.id).toBe(albumId);
    expect(
      database.applyAlbumVisibility(
        albumId,
        {
          action: "RESTORE",
          requestId: "restore-visible",
          expectedVisibilityRevision: 1,
        },
        actor,
      ),
    ).toEqual(expect.objectContaining({ visibility: "VISIBLE" }));
  });

  it("previews but never queues quarantine for a WATCH_ONLY root", () => {
    const database = new CoceanDatabase(":memory:");
    open.push(database);
    seedLifecycleVersion(database, "watch-version");
    const album = database.getAlbumSummary("watch-version")!;
    const actor = { id: "admin", displayName: "Admin" };
    const plan = database.createQuarantinePlan(
      album.id,
      {
        requestId: "watch-preview",
        expectedLibraryRevision: album.revision,
        localVersionId: "watch-version",
      },
      actor,
    );
    expect(plan).toEqual(
      expect.objectContaining({
        status: "PREVIEWED",
        executable: false,
        blockers: [expect.objectContaining({ code: "WATCH_ONLY_ROOT" })],
        fileCount: 1,
      }),
    );
    expect(plan.items[0]).toEqual(
      expect.objectContaining({
        sourceRelativePath: "Artist/watch-version/01 Track.flac",
        quarantineRelativePath: `${plan.id}/Artist/watch-version/01 Track.flac`,
        sha256: "a".repeat(64),
      }),
    );
    expect(() =>
      database.confirmLibraryChangePlan(plan.id, "watch-confirm", actor),
    ).toThrow(/只读观察目录/);
    expect(
      database.cancelLibraryChangePlan(plan.id, "watch-cancel", actor).status,
    ).toBe("CANCELLED");
    expect(database.claimNextLibraryChangePlan()).toBeNull();
  });

  it("keeps every split partition hidden", () => {
    const database = new CoceanDatabase(":memory:", {
      musicRootPolicy: "MANAGED",
    });
    open.push(database);
    const first = albumInput("hidden-split-a", []);
    const second = albumInput("hidden-split-b", []);
    database.replaceAlbumsForRoot("music", [first, second]);
    const album = database.getAlbumSummary("hidden-split-a")!;
    const actor = { id: "admin", displayName: "Admin" };
    database.applyAlbumVisibility(
      album.id,
      {
        action: "HIDE",
        requestId: "hide-before-split",
        expectedVisibilityRevision: 0,
      },
      actor,
    );
    database.applyLibraryIdentityDecision(
      album.id,
      {
        type: "SPLIT",
        requestId: "split-hidden",
        revision: album.revision,
        partitions: [
          { versionIds: ["hidden-split-a"] },
          { versionIds: ["hidden-split-b"] },
        ],
      },
      actor,
    );
    expect(database.getAlbumSummary("hidden-split-a")?.visibility).toBe(
      "HIDDEN",
    );
    expect(database.getAlbumSummary("hidden-split-b")?.visibility).toBe(
      "HIDDEN",
    );
  });

  it("runs frozen MANAGED quarantine and restore plans and recovers interrupted work", () => {
    const database = new CoceanDatabase(":memory:", {
      musicRootPolicy: "MANAGED",
    });
    open.push(database);
    seedLifecycleVersion(database, "managed-version");
    const album = database.getAlbumSummary("managed-version")!;
    const actor = { id: "admin", displayName: "Admin" };
    const preview = database.createQuarantinePlan(
      album.id,
      {
        requestId: "managed-preview",
        expectedLibraryRevision: album.revision,
        localVersionId: "managed-version",
      },
      actor,
    );
    expect(preview.executable).toBe(true);
    expect(
      database.createQuarantinePlan(
        album.id,
        {
          requestId: "managed-preview",
          expectedLibraryRevision: album.revision,
          localVersionId: "managed-version",
        },
        actor,
      ),
    ).toEqual(preview);
    expect(
      database.confirmLibraryChangePlan(preview.id, "managed-confirm", actor)
        .status,
    ).toBe("QUEUED");
    expect(database.claimNextLibraryChangePlan()?.status).toBe("RUNNING");
    expect(database.recoverRunningLibraryChangePlans()).toBe(1);
    const running = database.claimNextLibraryChangePlan()!;
    expect(running.id).toBe(preview.id);
    database.updateLibraryChangePlanItem(running.id, 0, {
      status: "QUARANTINED",
      finalSizeBytes: 100,
      finalSha256: "a".repeat(64),
    });
    expect(
      database.finishLibraryChangePlan(running.id, "SUCCEEDED").status,
    ).toBe("SUCCEEDED");
    const scan = database.claimNextScanJob();
    expect(scan).toEqual(
      expect.objectContaining({ mode: "INCREMENTAL", triggerSource: "MANUAL" }),
    );
    database.finishScanJob(scan!.id);
    const stableAlbumId = album.id;
    database.replaceAlbumsForRoot("music", []);
    expect(database.getLibraryChangePlan(running.id)?.libraryAlbumId).toBe(
      stableAlbumId,
    );
    const restore = database.createRestorePlan(
      running.id,
      "restore-preview",
      actor,
    );
    expect(restore).toEqual(
      expect.objectContaining({
        action: "RESTORE_VERSION",
        sourcePlanId: running.id,
        executable: true,
      }),
    );
    database.confirmLibraryChangePlan(restore.id, "restore-confirm", actor);
    database.claimNextLibraryChangePlan();
    database.updateLibraryChangePlanItem(restore.id, 0, {
      status: "RESTORED",
      finalSizeBytes: 100,
      finalSha256: "a".repeat(64),
    });
    expect(database.finishLibraryChangePlan(restore.id, "SUCCEEDED")).toEqual(
      expect.objectContaining({ status: "SUCCEEDED" }),
    );
    database.replaceAlbumsForRoot("music", [
      albumInput("managed-version", ["managed-version-file"]),
    ]);
    expect(database.getAlbumSummary("managed-version")?.id).toBe(stableAlbumId);
    expect(database.listQuarantinedLibraryVersions()).toEqual([]);
    expect(() =>
      database.raw.prepare("DELETE FROM library_change_plans").run(),
    ).toThrow(/cannot be deleted/);
  });

  it("counts the complete current recently-deleted projection beyond the 100-row view", () => {
    const database = new CoceanDatabase(":memory:", {
      musicRootPolicy: "MANAGED",
    });
    open.push(database);
    seedLifecycleVersion(database, "recent-count-version");
    const album = database.getAlbumSummary("recent-count-version")!;
    const insert = database.raw.prepare(
      `INSERT INTO library_change_plans
       (id,request_id,action,status,library_album_id,local_version_id,root_id,
        root_container_path,quarantine_root_path,source_plan_id,
        expected_library_revision,input_json,executable,blockers_json,
        file_count,total_bytes,actor_id,actor_display_name,created_at,finished_at)
       VALUES (?,?,?,'SUCCEEDED',?,?,'music','/library/music','/library/quarantine',
               ?,0,'{}',1,'[]',1,100,'admin','Admin',?,?)`,
    );
    for (let index = 0; index < 102; index += 1) {
      const id = `recent-count-${String(index).padStart(3, "0")}`;
      const createdAt = new Date(Date.UTC(2026, 7, 16, 0, index)).toISOString();
      insert.run(
        id,
        `request-${id}`,
        "QUARANTINE_VERSION",
        album.id,
        `version-${index}`,
        null,
        createdAt,
        createdAt,
      );
    }
    insert.run(
      "recent-count-restored",
      "request-recent-count-restored",
      "RESTORE_VERSION",
      album.id,
      "version-0",
      "recent-count-000",
      "2026-08-16T03:00:00.000Z",
      "2026-08-16T03:00:00.000Z",
    );
    insert.run(
      "recent-count-active-restore",
      "request-recent-count-active-restore",
      "RESTORE_VERSION",
      album.id,
      "version-1",
      "recent-count-001",
      "2026-08-16T03:01:00.000Z",
      null,
    );
    database.raw
      .prepare("UPDATE library_change_plans SET status='PREVIEWED' WHERE id=?")
      .run("recent-count-active-restore");

    const first = database.listRecentlyDeletedLibraryVersions({ limit: 100 });
    expect(first).toEqual(
      expect.objectContaining({ total: 101, limit: 100, offset: 0 }),
    );
    expect(first.items).toHaveLength(100);
    expect(
      first.items.some((item) => item.source.id === "recent-count-001"),
    ).toBe(false);
    const second = database.listRecentlyDeletedLibraryVersions({
      limit: 100,
      offset: 100,
    });
    expect(second).toEqual(
      expect.objectContaining({ total: 101, limit: 100, offset: 100 }),
    );
    expect(second.items.map((item) => item.source.id)).toEqual([
      "recent-count-001",
    ]);
    expect(second.items[0]?.latestRestore?.id).toBe(
      "recent-count-active-restore",
    );
    expect(second.items[0]?.object).toEqual({
      title: "Album",
      albumArtist: "Artist",
    });
    expect(
      database.getRecentlyDeletedLibraryVersion("recent-count-001")
        ?.latestRestore?.status,
    ).toBe("PREVIEWED");
    expect(
      database.getRecentlyDeletedLibraryVersion("recent-count-000"),
    ).toBeNull();
  });

  it("cancels a queued plan and never replays a confirm event as cancellation", () => {
    const database = new CoceanDatabase(":memory:", {
      musicRootPolicy: "MANAGED",
    });
    open.push(database);
    seedLifecycleVersion(database, "cancel-queued-version");
    const album = database.getAlbumSummary("cancel-queued-version")!;
    const actor = { id: "admin", displayName: "Admin" };
    const preview = database.createQuarantinePlan(
      album.id,
      {
        requestId: "cancel-queued-preview",
        expectedLibraryRevision: album.revision,
        localVersionId: "cancel-queued-version",
      },
      actor,
    );
    database.confirmLibraryChangePlan(preview.id, "same-request", actor);
    expect(() =>
      database.cancelLibraryChangePlan(preview.id, "same-request", actor),
    ).toThrow(/不同的取消请求/);
    expect(database.getLibraryChangePlan(preview.id)?.status).toBe("QUEUED");
    expect(
      database.cancelLibraryChangePlan(
        preview.id,
        "cancel-after-confirm",
        actor,
      ).status,
    ).toBe("CANCELLED");
    expect(database.claimNextLibraryChangePlan()).toBeNull();
  });
});

function seedPassiveOrphanSideEffectRows(
  database: CoceanDatabase,
  prefix: string,
): void {
  const localVersionId = `${prefix}-side-effect-version`;
  database.createPhysicalOnlyAlbum({
    id: localVersionId,
    groupKey: localVersionId,
    title: "Passive Side Effect",
    albumArtist: "Artist",
    year: null,
  });
  const libraryAlbumId = database.getAlbumSummary(localVersionId)!.id;
  const targetId = `${prefix}-side-effect-target`;
  createDeliveryTarget(database, targetId);
  database.createDeliveryJob({
    id: `${prefix}-side-effect-delivery`,
    albumId: localVersionId,
    targetId,
    targetName: "Target",
    transport: "AK_FILE_DROP",
    status: "COMPLETED",
    fileCount: 0,
    completedFileCount: 0,
    totalBytes: 0,
    transferredBytes: 0,
    verified: true,
    error: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    startedAt: "2026-08-16T00:00:00.000Z",
    finishedAt: "2026-08-16T00:00:00.000Z",
    planId: null,
  });
  database.raw
    .prepare(
      `INSERT INTO library_change_plans
       (id,request_id,action,status,library_album_id,local_version_id,root_id,
        root_container_path,quarantine_root_path,expected_library_revision,
        input_json,executable,blockers_json,file_count,total_bytes,actor_id,
        actor_display_name,created_at,finished_at)
       VALUES (?,?,?,'CANCELLED',?,?,'physical','/library/physical',
               '/library/quarantine',0,'{}',1,'[]',0,0,'admin','Admin',?,?)`,
    )
    .run(
      `${prefix}-side-effect-plan`,
      `${prefix}-side-effect-plan-request`,
      "QUARANTINE_VERSION",
      libraryAlbumId,
      localVersionId,
      "2026-08-16T00:00:00.000Z",
      "2026-08-16T00:00:00.000Z",
    );
}

function createRunningScan(
  database: CoceanDatabase,
  id: string,
  rootId = "music",
): void {
  database.createScanJob({
    id,
    rootId,
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

function finalizeEmptyInventoryScan(
  database: CoceanDatabase,
  scanJobId: string,
  rootId = "music",
): void {
  createRunningScan(database, scanJobId, rootId);
  database.recordScanDiscovery({
    scanJobId,
    rulesVersion: "inventory-test/1",
    candidates: 0,
    regularFiles: 0,
    auxiliaryFiles: 0,
    ignoredFiles: 0,
    skippedSymlinks: 0,
    traversalErrors: 0,
  });
  database.finalizeSuccessfulScan({
    scanJobId,
    rootId,
    stagedFiles: [],
    seenRelativePaths: [],
    albums: [],
    withWarnings: false,
  });
}

function finalizeSingleFileInventoryScan(
  database: CoceanDatabase,
  scanJobId: string,
): void {
  createRunningScan(database, scanJobId);
  const mediaFileId = `${scanJobId}-file`;
  const file = observedFile(`Artist/${scanJobId}/01.flac`, 10);
  database.recordScanDiscovery({
    scanJobId,
    rulesVersion: "inventory-test/1",
    candidates: 1,
    regularFiles: 1,
    auxiliaryFiles: 0,
    ignoredFiles: 0,
    skippedSymlinks: 0,
    traversalErrors: 0,
  });
  database.recordScanFileResult({
    scanJobId,
    rootId: "music",
    relativePath: file.relativePath,
    extension: ".flac",
    candidateKind: "SUPPORTED_AUDIO",
    outcome: "PARSED",
    mediaFileId,
    sizeBytes: file.sizeBytes,
    modifiedAtMs: file.modifiedAtMs,
    errorCode: null,
    errorStage: null,
    warningCodes: [],
  });
  database.finalizeSuccessfulScan({
    scanJobId,
    rootId: "music",
    stagedFiles: [{ id: mediaFileId, file }],
    seenRelativePaths: [file.relativePath],
    albums: [albumInput(`${scanJobId}-version`, [mediaFileId])],
    withWarnings: false,
  });
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

function seedLifecycleVersion(
  database: CoceanDatabase,
  versionId: string,
): void {
  if (!database.getUser("admin")) {
    const now = new Date().toISOString();
    database.createUser(
      {
        id: "admin",
        username: "admin",
        displayName: "Admin",
        role: "ADMIN",
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      },
      "unused-test-password-hash",
    );
  }
  const scanId = `${versionId}-scan`;
  createRunningScan(database, scanId);
  const fileId = `${versionId}-file`;
  database.upsertMediaFile(fileId, "music", scanId, {
    ...observedFile(`Artist/${versionId}/01 Track.flac`, 100),
    fileSha256: "a".repeat(64),
    rawTags: [],
  });
  database.replaceAlbumsForRoot("music", [albumInput(versionId, [fileId])]);
  database.finishScanJob(scanId);
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
