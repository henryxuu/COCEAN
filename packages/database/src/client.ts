import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import type {
  AlbumAggregationIssue,
  AlbumDetail,
  AlbumIntroduction,
  AlbumSummary,
  AuthSession,
  AuthUser,
  CoceanSettings,
  DeliveryJob,
  DeliveryTarget,
  LibraryRoot,
  LibraryIssue,
  LibraryIssueCode,
  LibraryIdentityDecision,
  LibraryIdentityDecisionCommand,
  LibraryIdentityDecisionResult,
  LibraryStats,
  ModelConfiguration,
  ModelVerificationStatus,
  ObservedMediaFile,
  OwnedDevice,
  PhysicalCopy,
  PhysicalMedium,
  ReleaseCandidate,
  ScanFailure,
  ScanFileOutcome,
  ScanFileResult,
  ScanJob,
  ScanReport,
  StillCatalogAlbum,
  StillRuntimeCatalog,
} from "@cocean/contracts";
import {
  formatCompactAudioSpec,
  releaseCandidateSchema,
  stillRuntimeCatalogSchema,
} from "@cocean/contracts";
import { migrations } from "./migrations.js";

type Sqlite = BetterSqlite3.Database;

export interface AlbumRecordInput {
  id: string;
  rootId: string;
  groupKey: string;
  title: string;
  albumArtist: string;
  year: number | null;
  discCount: number;
  fileIds: string[];
  primaryFileIds?: string[];
  fileDiscNumbers?: Record<string, number>;
  sourceVersionCount?: number;
  duplicateFileCount?: number;
  audioSummary: AlbumSummary["audioSummary"];
  mixedAudioSpecs: boolean;
  artwork: AlbumSummary["artwork"];
  matchStatus?: AlbumSummary["matchStatus"];
  label?: string | null;
  catalogNumber?: string | null;
  barcode?: string | null;
  musicBrainzReleaseId?: string | null;
  aggregationIssues?: AlbumAggregationIssue[];
}

export type ScanFileResultInput = Omit<ScanFileResult, "id" | "createdAt">;

export interface ScanDiscoveryInput {
  scanJobId: string;
  rulesVersion: string;
  candidates: number;
  regularFiles: number;
  auxiliaryFiles: number;
  ignoredFiles: number;
  skippedSymlinks: number;
  traversalErrors: number;
}

export interface StagedMediaFile {
  id: string;
  file: ObservedMediaFile;
}

export interface FinalizeSuccessfulScanInput {
  scanJobId: string;
  rootId: string;
  stagedFiles: StagedMediaFile[];
  seenRelativePaths: string[];
  albums: AlbumRecordInput[];
  withWarnings: boolean;
}

export interface AlbumIdentityHint {
  id: string;
  groupKey: string;
  fileIds: string[];
}

export interface LibraryIdentityActor {
  id: string;
  displayName: string;
}

export class LibraryIdentityDecisionError extends Error {
  constructor(
    public readonly code:
      "INVALID_IDENTITY_DECISION" | "IDENTITY_DECISION_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "LibraryIdentityDecisionError";
  }
}

interface LibraryIdentitySnapshot {
  groups: Array<{
    id: string;
    identityKey: string;
    title: string;
    albumArtist: string;
    primaryVersionId: string;
    decisionSource: "AUTOMATIC" | "USER";
    primaryVersionSource: "AUTOMATIC" | "USER";
    revision: number;
    createdAt: string;
    updatedAt: string;
    members: Array<{
      albumId: string;
      relationshipStatus: "AUTO_CANDIDATE" | "USER_CONFIRMED" | "USER_SEPARATE";
      createdAt: string;
      updatedAt: string;
    }>;
    issues: Array<{
      albumId: string | null;
      code: LibraryIssueCode;
      evidenceJson: string;
      createdAt: string;
      updatedAt: string;
    }>;
  }>;
  aliases: Array<{
    aliasId: string;
    libraryAlbumId: string;
    createdAt: string;
  }>;
}

interface AutomaticIdentityBaseline {
  members: Map<string, string[]>;
  primaryVersions: Map<string, string | null>;
}

interface LibraryIdentityGovernanceState {
  groups: Array<{
    id: string;
    primaryVersionId: string;
    decisionSource: "AUTOMATIC" | "USER";
    primaryVersionSource: "AUTOMATIC" | "USER";
    revision: number;
    members: Array<{
      albumId: string;
      relationshipStatus: "AUTO_CANDIDATE" | "USER_CONFIRMED" | "USER_SEPARATE";
    }>;
  }>;
  aliases: Array<{ aliasId: string; libraryAlbumId: string }>;
}

interface StoredScanDiscovery {
  rulesVersion: string;
  candidates: number;
  regularFiles: number;
  auxiliaryFiles: number;
  ignoredFiles: number;
  skippedSymlinks: number;
  traversalErrors: number;
  boundaryStatePresent: boolean;
}

interface ScanEvidenceCounts {
  candidates: number;
  processed: number;
  parsed: number;
  unsupported: number;
  failed: number;
  unprocessed: number;
}

export interface DatabaseOptions {
  musicRoot?: string;
}

export interface AlbumDirectoryFingerprint {
  relativeDirectory: string;
  fingerprint: string;
}

export interface AlbumStabilityResult {
  stableDirectories: string[];
  deferredDirectories: string[];
}

export interface AutoDiscoveryProbeRoot extends LibraryRoot {
  scheduledScanAt: string;
}

export type ScanJobInput = Omit<
  ScanJob,
  | "triggerSource"
  | "retryOfScanJobId"
  | "stableAlbumDirectories"
  | "deferredAlbumDirectories"
> &
  Partial<
    Pick<
      ScanJob,
      | "triggerSource"
      | "retryOfScanJobId"
      | "stableAlbumDirectories"
      | "deferredAlbumDirectories"
    >
  >;

export interface StoredAuthUser extends AuthUser {
  passwordHash: string;
}

export interface StoredDeliveryTarget {
  target: DeliveryTarget;
  credentialJson: string | null;
}

export interface DeliveryFileLocation {
  id: string;
  relativePath: string;
  rootPath: string;
  sizeBytes: number;
  sha256: string | null;
  extension: string;
  container: string | null;
  album: string | null;
  albumArtist: string | null;
  title: string | null;
  artists: string[];
  discNumber: number | null;
  discTotal: number | null;
  discNumberOverride: number | null;
  trackNumber: number | null;
  trackTotal: number | null;
}

export interface AlbumDeliveryBundle {
  albumId: string;
  title: string;
  albumArtist: string;
  year: number | null;
  artwork: AlbumSummary["artwork"];
  files: DeliveryFileLocation[];
}

export interface FrozenDeliveryArtwork {
  sourceIdentity: AlbumSummary["artwork"];
  preparedPath: string;
  sizeBytes: number;
  sha256: string;
  targetRelativePath?: string;
  conversionType?: "ARTWORK_JPEG";
}

export type DeliveryConversionType = "COPY" | "FLAC_REMUX" | "APE_TO_FLAC";

export interface FrozenDeliveryFile extends DeliveryFileLocation {
  preparedPath?: string;
  outputSizeBytes?: number;
  outputSha256?: string;
  conversionType?: DeliveryConversionType;
  targetRelativePath?: string;
}

export interface FrozenAlbumDeliveryBundle extends Omit<
  AlbumDeliveryBundle,
  "files"
> {
  deliveryProfileVersion?: "organized-v2";
  targetAlbumPath?: string;
  files: FrozenDeliveryFile[];
  preparedArtwork: FrozenDeliveryArtwork | null;
}

export class CoceanDatabase {
  readonly raw: Sqlite;
  private readonly musicRoot: string;

  constructor(databasePath: string, options: DatabaseOptions = {}) {
    this.musicRoot = options.musicRoot ?? "/library/music";
    if (databasePath !== ":memory:")
      mkdirSync(dirname(databasePath), { recursive: true });
    this.raw = new BetterSqlite3(databasePath);
    try {
      this.assertSchemaCompatibility();
      this.raw.pragma("journal_mode = WAL");
      this.raw.pragma("foreign_keys = ON");
      this.raw.pragma("busy_timeout = 5000");
      this.migrate();
      this.ensureDefaults();
      this.rebuildAutomaticLibraryAlbums();
    } catch (error) {
      this.raw.close();
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }

  private migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const appliedRows = this.assertSchemaCompatibility();
    const applied = new Set(appliedRows.map((row) => Number(row.version)));
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.raw.transaction(() => {
        this.raw.exec(migration.sql);
        this.raw
          .prepare(
            "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.name, new Date().toISOString());
      })();
    }
  }

  private assertSchemaCompatibility(): Array<{
    version: number;
    name: string;
  }> {
    const table = this.raw
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get();
    if (!table) return [];
    const known = new Map<number, string>(
      migrations.map((migration) => [migration.version, migration.name]),
    );
    const appliedRows = this.raw
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number; name: string }>;
    for (const row of appliedRows) {
      const expectedName = known.get(Number(row.version));
      if (!expectedName) {
        throw new Error(
          `COCEAN database schema ${row.version} is newer than or unsupported by this application`,
        );
      }
      if (row.name !== expectedName) {
        throw new Error(
          `COCEAN database migration ${row.version} identity does not match this application`,
        );
      }
    }
    return appliedRows;
  }

  private ensureDefaults(): void {
    const now = new Date().toISOString();
    this.raw
      .prepare(
        `INSERT OR IGNORE INTO library_roots
          (id, name, host_path_hint, container_path, policy, enabled, created_at, updated_at)
         VALUES ('music', 'Music', NULL, ?, 'WATCH_ONLY', 1, ?, ?)`,
      )
      .run(this.musicRoot, now, now);
    if (
      !this.raw.prepare("SELECT 1 FROM app_settings WHERE key = 'main'").get()
    ) {
      this.saveSettings({
        libraryRoots: this.listLibraryRoots(),
        scanOnStart: false,
        sourceWritebackEnabled: false,
        deviceCopyMetadataEnabled: false,
        naturalLanguageDiscoveryEnabled: false,
        evidenceSummaryEnabled: false,
        qobuzEnabled: false,
        theme: "SYSTEM",
      });
    }
  }

  listLibraryRoots(): LibraryRoot[] {
    return this.raw
      .prepare(
        `SELECT id, name, host_path_hint, container_path, policy, enabled,
                auto_discovery_enabled, auto_discovery_interval_minutes
         FROM library_roots WHERE system = 0 ORDER BY created_at`,
      )
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: String(r.id),
          name: String(r.name),
          hostPathHint: nullableString(r.host_path_hint),
          containerPath: String(r.container_path),
          policy: r.policy as LibraryRoot["policy"],
          enabled: Boolean(r.enabled),
          autoDiscoveryEnabled: Boolean(r.auto_discovery_enabled),
          autoDiscoveryIntervalMinutes: Number(
            r.auto_discovery_interval_minutes ?? 5,
          ),
        };
      });
  }

  getLibraryRoot(id: string): LibraryRoot | null {
    return this.listLibraryRoots().find((root) => root.id === id) ?? null;
  }

  private getAnyLibraryRoot(
    id: string,
  ): (LibraryRoot & { system: boolean }) | null {
    const row = this.raw
      .prepare(
        `SELECT id, name, host_path_hint, container_path, policy, enabled, system,
                auto_discovery_enabled, auto_discovery_interval_minutes
         FROM library_roots WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row
      ? {
          id: String(row.id),
          name: String(row.name),
          hostPathHint: nullableString(row.host_path_hint),
          containerPath: String(row.container_path),
          policy: row.policy as LibraryRoot["policy"],
          enabled: Boolean(row.enabled),
          autoDiscoveryEnabled: Boolean(row.auto_discovery_enabled),
          autoDiscoveryIntervalMinutes: Number(
            row.auto_discovery_interval_minutes ?? 5,
          ),
          system: Boolean(row.system),
        }
      : null;
  }

  getSettings(): CoceanSettings {
    const row = this.raw
      .prepare("SELECT value_json FROM app_settings WHERE key = 'main'")
      .get() as { value_json: string } | undefined;
    if (!row) throw new Error("COCEAN settings are not initialized");
    return {
      ...(JSON.parse(row.value_json) as CoceanSettings),
      libraryRoots: this.listLibraryRoots(),
    };
  }

  saveSettings(settings: CoceanSettings): void {
    const now = new Date().toISOString();
    const deploymentRoots = this.listLibraryRoots();
    if (
      JSON.stringify(settings.libraryRoots.map(deploymentRootFields)) !==
      JSON.stringify(deploymentRoots.map(deploymentRootFields))
    )
      throw new Error("library roots are deployment-managed");
    for (const root of settings.libraryRoots) {
      if (
        !Number.isInteger(root.autoDiscoveryIntervalMinutes) ||
        root.autoDiscoveryIntervalMinutes < 1 ||
        root.autoDiscoveryIntervalMinutes > 1440
      )
        throw new Error("auto discovery interval must be 1-1440 minutes");
    }
    this.raw.transaction(() => {
      const updateRoot = this.raw.prepare(
        `UPDATE library_roots SET
           auto_discovery_enabled=@autoDiscoveryEnabled,
           auto_discovery_interval_minutes=@autoDiscoveryIntervalMinutes,
           next_auto_scan_at=CASE
             WHEN @autoDiscoveryEnabled=0 THEN NULL
             WHEN auto_discovery_enabled=0
               OR auto_discovery_interval_minutes<>@autoDiscoveryIntervalMinutes
               THEN @now
             ELSE COALESCE(next_auto_scan_at, @now)
           END,
           auto_discovery_probe_for_scan_at=CASE
             WHEN @autoDiscoveryEnabled=0 THEN NULL
             WHEN auto_discovery_enabled=0
               OR auto_discovery_interval_minutes<>@autoDiscoveryIntervalMinutes
               THEN NULL
             ELSE auto_discovery_probe_for_scan_at
           END,
           updated_at=@now
         WHERE id=@id AND system=0`,
      );
      for (const root of settings.libraryRoots)
        updateRoot.run({
          id: root.id,
          autoDiscoveryEnabled: root.autoDiscoveryEnabled ? 1 : 0,
          autoDiscoveryIntervalMinutes: root.autoDiscoveryIntervalMinutes,
          now,
        });
      const stored = { ...settings, libraryRoots: undefined };
      this.raw
        .prepare(
          `INSERT INTO app_settings(key, value_json, updated_at) VALUES ('main', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
        )
        .run(JSON.stringify(stored), now);
    })();
  }

  countUsers(): number {
    const row = this.raw
      .prepare("SELECT COUNT(*) AS count FROM app_users")
      .get() as { count: number };
    return Number(row.count);
  }

  listUsers(): AuthUser[] {
    return this.raw
      .prepare(
        `SELECT * FROM app_users
         ORDER BY CASE role WHEN 'ADMIN' THEN 0 ELSE 1 END, username COLLATE NOCASE`,
      )
      .all()
      .map((row) => mapAuthUser(row as Record<string, unknown>));
  }

  getUser(id: string): AuthUser | null {
    const row = this.raw
      .prepare("SELECT * FROM app_users WHERE id=?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapAuthUser(row) : null;
  }

  getUserByUsername(username: string): StoredAuthUser | null {
    const row = this.raw
      .prepare("SELECT * FROM app_users WHERE username=? COLLATE NOCASE")
      .get(username) as Record<string, unknown> | undefined;
    return row
      ? { ...mapAuthUser(row), passwordHash: String(row.password_hash) }
      : null;
  }

  createUser(user: AuthUser, passwordHash: string): void {
    this.raw
      .prepare(
        `INSERT INTO app_users (
          id, username, display_name, password_hash, role, enabled, created_at,
          updated_at, last_login_at
        ) VALUES (
          @id, @username, @displayName, @passwordHash, @role, @enabled,
          @createdAt, @updatedAt, @lastLoginAt
        )`,
      )
      .run({ ...user, passwordHash, enabled: user.enabled ? 1 : 0 });
  }

  updateUser(
    id: string,
    input: {
      displayName?: string;
      role?: AuthUser["role"];
      enabled?: boolean;
      passwordHash?: string;
    },
  ): AuthUser | null {
    const existing = this.getUser(id);
    if (!existing) return null;
    const next = {
      displayName: input.displayName ?? existing.displayName,
      role: input.role ?? existing.role,
      enabled: input.enabled ?? existing.enabled,
      updatedAt: new Date().toISOString(),
      passwordHash: input.passwordHash,
    };
    this.raw
      .prepare(
        `UPDATE app_users SET display_name=@displayName, role=@role,
          enabled=@enabled, updated_at=@updatedAt,
          password_hash=COALESCE(@passwordHash, password_hash)
         WHERE id=@id`,
      )
      .run({ id, ...next, enabled: next.enabled ? 1 : 0 });
    if (!next.enabled)
      this.raw.prepare("DELETE FROM app_sessions WHERE user_id=?").run(id);
    return this.getUser(id);
  }

  countEnabledAdmins(): number {
    const row = this.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM app_users WHERE role='ADMIN' AND enabled=1",
      )
      .get() as { count: number };
    return Number(row.count);
  }

  touchUserLogin(id: string): void {
    this.raw
      .prepare("UPDATE app_users SET last_login_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
  }

  createSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }): void {
    const now = new Date().toISOString();
    this.raw
      .prepare(
        `INSERT INTO app_sessions
          (id, user_id, token_hash, expires_at, created_at, last_seen_at)
         VALUES (@id, @userId, @tokenHash, @expiresAt, @now, @now)`,
      )
      .run({ ...input, now });
  }

  getSessionByTokenHash(tokenHash: string): AuthSession | null {
    const row = this.raw
      .prepare(
        `SELECT app_sessions.expires_at, app_users.*
         FROM app_sessions
         JOIN app_users ON app_users.id=app_sessions.user_id
         WHERE app_sessions.token_hash=? AND app_sessions.expires_at>?
           AND app_users.enabled=1`,
      )
      .get(tokenHash, new Date().toISOString()) as
      Record<string, unknown> | undefined;
    return row
      ? { user: mapAuthUser(row), expiresAt: String(row.expires_at) }
      : null;
  }

  deleteSessionByTokenHash(tokenHash: string): void {
    this.raw
      .prepare("DELETE FROM app_sessions WHERE token_hash=?")
      .run(tokenHash);
  }

  pruneExpiredSessions(): number {
    return this.raw
      .prepare("DELETE FROM app_sessions WHERE expires_at<=?")
      .run(new Date().toISOString()).changes;
  }

  createScanJob(job: ScanJobInput): void {
    this.raw
      .prepare(
        `INSERT INTO scan_jobs
          (id, root_id, mode, trigger_source, retry_of_scan_job_id, status,
           total_files, processed_files, parsed_files, failed_files, reused_files,
           stable_album_directories, deferred_album_directories, created_at,
           started_at, finished_at, error, cancel_requested_at)
         VALUES (@id, @rootId, @mode, @triggerSource, @retryOfScanJobId, @status,
           @totalFiles, @processedFiles, @parsedFiles, @failedFiles, @reusedFiles,
           @stableAlbumDirectories, @deferredAlbumDirectories, @createdAt,
           @startedAt, @finishedAt, @error, @cancelRequestedAt)`,
      )
      .run({
        ...job,
        triggerSource: job.triggerSource ?? "MANUAL",
        retryOfScanJobId: job.retryOfScanJobId ?? null,
        stableAlbumDirectories: job.stableAlbumDirectories ?? 0,
        deferredAlbumDirectories: job.deferredAlbumDirectories ?? 0,
      });
  }

  tryCreateScanJob(job: ScanJobInput): boolean {
    try {
      this.createScanJob(job);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("scan_jobs.root_id") ||
          error.message.includes("scan_jobs_one_active_per_root_idx"))
      )
        return false;
      throw error;
    }
  }

  enqueueDueAutoDiscoveryJobs(now = new Date()): ScanJob[] {
    return this.raw.transaction(() => {
      const nowIso = now.toISOString();
      const due = this.raw
        .prepare(
          `SELECT id, auto_discovery_interval_minutes
           FROM library_roots
           WHERE system=0 AND enabled=1 AND auto_discovery_enabled=1
             AND (next_auto_scan_at IS NULL OR next_auto_scan_at<=?)
           ORDER BY created_at`,
        )
        .all(nowIso) as Array<{
        id: string;
        auto_discovery_interval_minutes: number;
      }>;
      const created: ScanJob[] = [];
      for (const root of due) {
        const nextAt = new Date(
          now.getTime() + Number(root.auto_discovery_interval_minutes) * 60_000,
        ).toISOString();
        const job = emptyScanJob(
          randomUUID(),
          root.id,
          "INCREMENTAL",
          "AUTO_DISCOVERY",
          nowIso,
        );
        if (this.tryCreateScanJob(job)) {
          this.raw
            .prepare(
              `UPDATE library_roots SET next_auto_scan_at=?,
                 auto_discovery_probe_for_scan_at=NULL, updated_at=?
               WHERE id=? AND auto_discovery_enabled=1
                 AND (next_auto_scan_at IS NULL OR next_auto_scan_at<=?)`,
            )
            .run(nextAt, nowIso, root.id, nowIso);
          created.push(job);
        }
      }
      return created;
    })();
  }

  scheduleAutoDiscoveryStabilityCheck(
    rootId: string,
    now = new Date(),
    delayMs = 60_000,
  ): void {
    const nextAt = new Date(
      now.getTime() + Math.max(delayMs, 60_000),
    ).toISOString();
    this.raw
      .prepare(
        `UPDATE library_roots SET
           next_auto_scan_at=CASE
             WHEN next_auto_scan_at IS NULL OR next_auto_scan_at>? THEN ?
             ELSE next_auto_scan_at
           END,
           auto_discovery_probe_for_scan_at=CASE
             WHEN next_auto_scan_at IS NULL OR next_auto_scan_at>? THEN ?
             ELSE auto_discovery_probe_for_scan_at
           END,
           updated_at=?
         WHERE id=? AND system=0 AND enabled=1 AND auto_discovery_enabled=1`,
      )
      .run(nextAt, nextAt, nextAt, nextAt, now.toISOString(), rootId);
  }

  listDueAutoDiscoveryProbes(
    now = new Date(),
    leadMs = 120_000,
  ): AutoDiscoveryProbeRoot[] {
    const nowIso = now.toISOString();
    const cutoffIso = new Date(
      now.getTime() + Math.max(leadMs, 60_000),
    ).toISOString();
    return this.raw
      .prepare(
        `SELECT id, name, host_path_hint, container_path, policy, enabled,
                auto_discovery_enabled, auto_discovery_interval_minutes,
                next_auto_scan_at
         FROM library_roots
         WHERE system=0 AND enabled=1 AND auto_discovery_enabled=1
           AND next_auto_scan_at>? AND next_auto_scan_at<=?
           AND (auto_discovery_probe_for_scan_at IS NULL
             OR auto_discovery_probe_for_scan_at<>next_auto_scan_at)
         ORDER BY created_at`,
      )
      .all(nowIso, cutoffIso)
      .map((row) => {
        const value = row as Record<string, unknown>;
        return {
          id: String(value.id),
          name: String(value.name),
          hostPathHint: nullableString(value.host_path_hint),
          containerPath: String(value.container_path),
          policy: value.policy as LibraryRoot["policy"],
          enabled: Boolean(value.enabled),
          autoDiscoveryEnabled: Boolean(value.auto_discovery_enabled),
          autoDiscoveryIntervalMinutes: Number(
            value.auto_discovery_interval_minutes,
          ),
          scheduledScanAt: String(value.next_auto_scan_at),
        };
      });
  }

  markAutoDiscoveryProbeCompleted(
    rootId: string,
    scheduledScanAt: string,
  ): boolean {
    return (
      this.raw
        .prepare(
          `UPDATE library_roots SET auto_discovery_probe_for_scan_at=?, updated_at=?
           WHERE id=? AND next_auto_scan_at=? AND auto_discovery_enabled=1`,
        )
        .run(scheduledScanAt, new Date().toISOString(), rootId, scheduledScanAt)
        .changes === 1
    );
  }

  scanRequiresAlbumStability(scanJobId: string): boolean {
    const row = this.raw
      .prepare(
        `WITH RECURSIVE scan_ancestry(id, trigger_source, retry_of_scan_job_id) AS (
           SELECT id, trigger_source, retry_of_scan_job_id
           FROM scan_jobs WHERE id=?
           UNION
           SELECT parent.id, parent.trigger_source, parent.retry_of_scan_job_id
           FROM scan_jobs parent
           JOIN scan_ancestry child ON parent.id=child.retry_of_scan_job_id
         )
         SELECT 1 FROM scan_ancestry WHERE trigger_source='AUTO_DISCOVERY' LIMIT 1`,
      )
      .get(scanJobId);
    return Boolean(row);
  }

  observeAlbumDirectories(
    rootId: string,
    candidates: readonly AlbumDirectoryFingerprint[],
    now = new Date(),
    stableAfterMs = 60_000,
  ): AlbumStabilityResult {
    return this.raw.transaction(() => {
      const nowIso = now.toISOString();
      const stored = new Map(
        (
          this.raw
            .prepare(
              `SELECT relative_directory, fingerprint, first_observed_at
               FROM album_stability_observations WHERE root_id=?`,
            )
            .all(rootId) as Array<{
            relative_directory: string;
            fingerprint: string;
            first_observed_at: string;
          }>
        ).map((row) => [row.relative_directory, row]),
      );
      const stableDirectories: string[] = [];
      const deferredDirectories: string[] = [];
      const observed = new Set<string>();
      const upsert = this.raw.prepare(
        `INSERT INTO album_stability_observations
           (root_id, relative_directory, fingerprint, first_observed_at, last_observed_at)
         VALUES (@rootId, @relativeDirectory, @fingerprint, @firstObservedAt, @now)
         ON CONFLICT(root_id, relative_directory) DO UPDATE SET
           fingerprint=excluded.fingerprint,
           first_observed_at=excluded.first_observed_at,
           last_observed_at=excluded.last_observed_at`,
      );
      for (const candidate of candidates) {
        observed.add(candidate.relativeDirectory);
        const previous = stored.get(candidate.relativeDirectory);
        const unchanged = previous?.fingerprint === candidate.fingerprint;
        const firstObservedAt = unchanged ? previous.first_observed_at : nowIso;
        if (
          unchanged &&
          now.getTime() - new Date(firstObservedAt).getTime() >= stableAfterMs
        )
          stableDirectories.push(candidate.relativeDirectory);
        else deferredDirectories.push(candidate.relativeDirectory);
        upsert.run({
          rootId,
          relativeDirectory: candidate.relativeDirectory,
          fingerprint: candidate.fingerprint,
          firstObservedAt,
          now: nowIso,
        });
      }
      const remove = this.raw.prepare(
        `DELETE FROM album_stability_observations
         WHERE root_id=? AND relative_directory=?`,
      );
      for (const relativeDirectory of stored.keys())
        if (!observed.has(relativeDirectory))
          remove.run(rootId, relativeDirectory);
      return {
        stableDirectories: stableDirectories.sort(),
        deferredDirectories: deferredDirectories.sort(),
      };
    })();
  }

  updateScanStability(
    id: string,
    stableAlbumDirectories: number,
    deferredAlbumDirectories: number,
  ): void {
    this.raw
      .prepare(
        `UPDATE scan_jobs SET stable_album_directories=?, deferred_album_directories=?
         WHERE id=? AND status='RUNNING'`,
      )
      .run(stableAlbumDirectories, deferredAlbumDirectories, id);
  }

  getScanJob(id: string): ScanJob | null {
    const row = this.raw
      .prepare("SELECT * FROM scan_jobs WHERE id = ?")
      .get(id);
    return row ? mapScanJob(row as Record<string, unknown>) : null;
  }

  listScanJobs(limit = 20): ScanJob[] {
    return this.raw
      .prepare("SELECT * FROM scan_jobs ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map((row) => mapScanJob(row as Record<string, unknown>));
  }

  claimNextScanJob(): ScanJob | null {
    return this.raw.transaction(() => {
      const row = this.raw
        .prepare(
          "SELECT id FROM scan_jobs WHERE status = 'QUEUED' ORDER BY created_at LIMIT 1",
        )
        .get() as { id: string } | undefined;
      if (!row) return null;
      const startedAt = new Date().toISOString();
      const result = this.raw
        .prepare(
          "UPDATE scan_jobs SET status='RUNNING', started_at=? WHERE id=? AND status='QUEUED'",
        )
        .run(startedAt, row.id);
      return result.changes === 1 ? this.getScanJob(row.id) : null;
    })();
  }

  updateScanProgress(
    id: string,
    progress: Pick<
      ScanJob,
      | "totalFiles"
      | "processedFiles"
      | "parsedFiles"
      | "failedFiles"
      | "reusedFiles"
    >,
  ): void {
    this.raw
      .prepare(
        `UPDATE scan_jobs SET total_files=@totalFiles, processed_files=@processedFiles,
          parsed_files=@parsedFiles, failed_files=@failedFiles,
          reused_files=@reusedFiles WHERE id=@id`,
      )
      .run({ id, ...progress });
  }

  requestScanCancellation(id: string): ScanJob | null {
    return this.raw.transaction(() => {
      const job = this.getScanJob(id);
      if (!job) return null;
      if (job.status === "QUEUED") {
        this.raw
          .prepare(
            `UPDATE scan_jobs SET status='CANCELLED', cancel_requested_at=?,
             finished_at=?, error=NULL WHERE id=? AND status='QUEUED'`,
          )
          .run(new Date().toISOString(), new Date().toISOString(), id);
      } else if (job.status === "RUNNING" && !job.cancelRequestedAt) {
        this.raw
          .prepare(
            "UPDATE scan_jobs SET cancel_requested_at=? WHERE id=? AND status='RUNNING'",
          )
          .run(new Date().toISOString(), id);
      }
      return this.getScanJob(id);
    })();
  }

  isScanCancellationRequested(id: string): boolean {
    const row = this.raw
      .prepare(
        "SELECT cancel_requested_at FROM scan_jobs WHERE id=? AND status='RUNNING'",
      )
      .get(id) as { cancel_requested_at: string | null } | undefined;
    return Boolean(row?.cancel_requested_at);
  }

  finishScanJob(
    id: string,
    error: string | null = null,
    withWarnings = false,
  ): void {
    this.raw
      .prepare(
        "UPDATE scan_jobs SET status=?, error=?, finished_at=? WHERE id=?",
      )
      .run(
        error
          ? "FAILED"
          : withWarnings
            ? "COMPLETED_WITH_WARNINGS"
            : "COMPLETED",
        error,
        new Date().toISOString(),
        id,
      );
  }

  recordScanFailure(input: Omit<ScanFailure, "id" | "createdAt">): void {
    this.raw
      .prepare(
        `INSERT INTO scan_failures
          (scan_job_id, root_id, relative_path, code, stage, message, recoverable, created_at)
         VALUES (@scanJobId, @rootId, @relativePath, @code, @stage, @message, @recoverable, @createdAt)`,
      )
      .run({
        ...input,
        recoverable: input.recoverable ? 1 : 0,
        createdAt: new Date().toISOString(),
      });
  }

  listScanFailures(scanJobId: string, limit = 500, offset = 0): ScanFailure[] {
    return this.raw
      .prepare(
        "SELECT * FROM scan_failures WHERE scan_job_id = ? ORDER BY id LIMIT ? OFFSET ?",
      )
      .all(scanJobId, Math.min(Math.max(limit, 1), 5000), Math.max(offset, 0))
      .map((row) => {
        const value = row as Record<string, unknown>;
        return {
          id: Number(value.id),
          scanJobId: String(value.scan_job_id),
          rootId: String(value.root_id),
          relativePath: String(value.relative_path),
          code: String(value.code),
          stage: String(value.stage),
          message: String(value.message),
          recoverable: Boolean(value.recoverable),
          createdAt: String(value.created_at),
        };
      });
  }

  countScanFailures(scanJobId: string): number {
    const row = this.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM scan_failures WHERE scan_job_id = ?",
      )
      .get(scanJobId) as { count: number };
    return Number(row.count);
  }

  recordScanDiscovery(input: ScanDiscoveryInput): void {
    if (
      input.regularFiles !==
      input.candidates + input.auxiliaryFiles + input.ignoredFiles
    ) {
      throw new Error(
        "scan discovery invariant failed: regularFiles must equal candidates + auxiliaryFiles + ignoredFiles",
      );
    }
    this.raw
      .prepare(
        `INSERT INTO scan_discovery_state (
          scan_job_id, rules_version, candidates, regular_files, auxiliary_files,
          ignored_files, skipped_symlinks, traversal_errors, created_at
        ) VALUES (
          @scanJobId, @rulesVersion, @candidates, @regularFiles, @auxiliaryFiles,
          @ignoredFiles, @skippedSymlinks, @traversalErrors, @createdAt
        )`,
      )
      .run({ ...input, createdAt: new Date().toISOString() });
  }

  recordScanFileResult(input: ScanFileResultInput): void {
    assertEvidenceRelativePath(input.relativePath);
    this.raw
      .prepare(
        `INSERT INTO scan_file_results (
          scan_job_id, root_id, relative_path, extension, candidate_kind, outcome,
          media_file_id, size_bytes, modified_at_ms, error_code, error_stage,
          warning_codes_json, created_at
        ) VALUES (
          @scanJobId, @rootId, @relativePath, @extension, @candidateKind, @outcome,
          @mediaFileId, @sizeBytes, @modifiedAtMs, @errorCode, @errorStage,
          @warningCodesJson, @createdAt
        )`,
      )
      .run({
        ...input,
        warningCodesJson: JSON.stringify(input.warningCodes),
        createdAt: new Date().toISOString(),
      });
  }

  listScanFileResults(
    scanJobId: string,
    options: {
      limit?: number;
      offset?: number;
      outcome?: ScanFileOutcome;
    } = {},
  ): ScanFileResult[] {
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 5000);
    const offset = Math.max(options.offset ?? 0, 0);
    const rows = options.outcome
      ? this.raw
          .prepare(
            `SELECT * FROM scan_file_results
             WHERE scan_job_id = ? AND outcome = ? ORDER BY id LIMIT ? OFFSET ?`,
          )
          .all(scanJobId, options.outcome, limit, offset)
      : this.raw
          .prepare(
            `SELECT * FROM scan_file_results
             WHERE scan_job_id = ? ORDER BY id LIMIT ? OFFSET ?`,
          )
          .all(scanJobId, limit, offset);
    return rows.map((row) => mapScanFileResult(row as Record<string, unknown>));
  }

  countScanFileResults(scanJobId: string, outcome?: ScanFileOutcome): number {
    const row = outcome
      ? this.raw
          .prepare(
            `SELECT COUNT(*) AS count FROM scan_file_results
             WHERE scan_job_id = ? AND outcome = ?`,
          )
          .get(scanJobId, outcome)
      : this.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM scan_file_results WHERE scan_job_id = ?",
          )
          .get(scanJobId);
    return Number((row as { count: number }).count);
  }

  getScanReport(scanJobId: string): ScanReport | null {
    const row = this.raw
      .prepare(
        `SELECT scan_reports.*, scan_jobs.status, scan_jobs.started_at, scan_jobs.finished_at
         FROM scan_reports
         JOIN scan_jobs ON scan_jobs.id = scan_reports.scan_job_id
         WHERE scan_reports.scan_job_id = ?`,
      )
      .get(scanJobId) as Record<string, unknown> | undefined;
    return row ? mapScanReport(row) : null;
  }

  finalizeSuccessfulScan(input: FinalizeSuccessfulScanInput): ScanReport {
    this.raw.transaction(() => {
      const job = this.requireRunningScanJob(input.scanJobId, input.rootId);
      const discovery = this.scanDiscovery(input.scanJobId, job);
      if (discovery.traversalErrors > 0)
        throw new Error(
          "cannot finalize an authoritative library snapshot with traversal errors",
        );
      for (const staged of input.stagedFiles)
        this.alignMediaFileIdentity(input.rootId, staged.id, staged.file);
      for (const staged of input.stagedFiles)
        this.upsertMediaFile(
          staged.id,
          input.rootId,
          input.scanJobId,
          staged.file,
        );
      this.deleteMediaFilesNotDiscovered(input.rootId, input.seenRelativePaths);
      this.replaceAlbumsForRootInTransaction(input.rootId, input.albums);
      const evidence = this.scanEvidence(input.scanJobId, discovery);
      this.updateTerminalScanJob(
        input.scanJobId,
        input.withWarnings ||
          evidence.unsupported > 0 ||
          evidence.failed > 0 ||
          discovery.skippedSymlinks > 0,
        null,
        evidence,
      );
      this.insertScanReport(
        input.scanJobId,
        input.albums.length,
        input.albums.reduce(
          (total, album) => total + (album.aggregationIssues?.length ?? 0),
          0,
        ),
      );
    })();
    const report = this.getScanReport(input.scanJobId);
    if (!report) throw new Error("scan report was not committed");
    return report;
  }

  finalizeFailedScan(
    scanJobId: string,
    error: string,
    rulesVersion = "cocean-library-scan/unknown",
  ): ScanReport {
    const existing = this.getScanReport(scanJobId);
    if (existing) return existing;
    this.raw.transaction(() => {
      const job = this.getScanJob(scanJobId);
      if (!job) throw new Error(`Scan job ${scanJobId} does not exist`);
      const discovery = this.scanDiscovery(scanJobId, job, rulesVersion);
      const evidence = this.scanEvidence(scanJobId, discovery);
      this.updateTerminalScanJob(scanJobId, false, error, evidence);
      this.insertScanReport(scanJobId, null, null, rulesVersion);
    })();
    const report = this.getScanReport(scanJobId);
    if (!report) throw new Error("failed scan report was not committed");
    return report;
  }

  finalizeCancelledScan(
    scanJobId: string,
    rulesVersion = "cocean-library-scan/unknown",
  ): ScanReport {
    const existing = this.getScanReport(scanJobId);
    if (existing) return existing;
    this.raw.transaction(() => {
      const job = this.getScanJob(scanJobId);
      if (!job) throw new Error(`Scan job ${scanJobId} does not exist`);
      if (job.status !== "RUNNING")
        throw new Error(`Scan job ${scanJobId} is not running`);
      const discovery = this.scanDiscovery(scanJobId, job, rulesVersion);
      const evidence = this.scanEvidence(scanJobId, discovery);
      this.updateTerminalScanJob(scanJobId, false, null, evidence, "CANCELLED");
      this.insertScanReport(scanJobId, null, null, rulesVersion);
    })();
    const report = this.getScanReport(scanJobId);
    if (!report) throw new Error("cancelled scan report was not committed");
    return report;
  }

  recoverRunningScanJobs(
    error: string,
    rulesVersion = "cocean-library-scan/unknown",
  ): ScanReport[] {
    const jobIds = this.raw
      .prepare(
        "SELECT id FROM scan_jobs WHERE status = 'RUNNING' ORDER BY created_at",
      )
      .all()
      .map((row) => String((row as { id: string }).id));
    return jobIds.map((jobId) =>
      this.finalizeFailedScan(jobId, error, rulesVersion),
    );
  }

  touchWorkerHeartbeat(role: string, processId: number, state: string): void {
    this.raw
      .prepare(
        `INSERT INTO worker_heartbeats(role, process_id, state, last_seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(role) DO UPDATE SET process_id=excluded.process_id, state=excluded.state,
           last_seen_at=excluded.last_seen_at`,
      )
      .run(role, processId, state, new Date().toISOString());
  }

  getWorkerHeartbeat(role: string): {
    role: string;
    processId: number;
    state: string;
    lastSeenAt: string;
  } | null {
    const row = this.raw
      .prepare("SELECT * FROM worker_heartbeats WHERE role = ?")
      .get(role) as Record<string, unknown> | undefined;
    return row
      ? {
          role: String(row.role),
          processId: Number(row.process_id),
          state: String(row.state),
          lastSeenAt: String(row.last_seen_at),
        }
      : null;
  }

  upsertMediaFile(
    id: string,
    rootId: string,
    jobId: string,
    file: ObservedMediaFile,
  ): void {
    this.raw
      .prepare(
        `INSERT INTO media_files (
          id, root_id, relative_path, absolute_path, extension, size_bytes, modified_at_ms, file_sha256,
          container, codec, audio_kind, lossless, bit_depth, sample_rate, bitrate, channels, dsd_rate,
          duration_seconds, album, album_artist, title, artists_json, year, date_text, genre_json,
          composer_json, label_json, catalog_number, barcode, musicbrainz_release_id,
          disc_number, disc_total, track_number, track_total, raw_tags_json, artwork_json, warnings_json, scan_job_id, scanned_at
        ) VALUES (
          @id, @rootId, @relativePath, @absolutePath, @extension, @sizeBytes, @modifiedAtMs, @fileSha256,
          @container, @codec, @audioKind, @lossless, @bitDepth, @sampleRate, @bitrate, @channels, @dsdRate,
          @durationSeconds, @album, @albumArtist, @title, @artistsJson, @year, @dateText, @genreJson,
          @composerJson, @labelJson, @catalogNumber, @barcode, @musicBrainzReleaseId,
          @discNumber, @discTotal, @trackNumber, @trackTotal, @rawTagsJson, @artworkJson, @warningsJson, @jobId, @scannedAt
        ) ON CONFLICT(root_id, relative_path) DO UPDATE SET
          id=excluded.id, absolute_path=excluded.absolute_path, extension=excluded.extension,
          size_bytes=excluded.size_bytes, modified_at_ms=excluded.modified_at_ms,
          file_sha256=excluded.file_sha256, container=excluded.container,
          codec=excluded.codec, audio_kind=excluded.audio_kind, lossless=excluded.lossless,
          bit_depth=excluded.bit_depth, sample_rate=excluded.sample_rate, bitrate=excluded.bitrate,
          channels=excluded.channels, dsd_rate=excluded.dsd_rate, duration_seconds=excluded.duration_seconds,
          album=excluded.album, album_artist=excluded.album_artist, title=excluded.title,
          artists_json=excluded.artists_json, year=excluded.year, date_text=excluded.date_text,
          genre_json=excluded.genre_json, composer_json=excluded.composer_json, label_json=excluded.label_json,
          catalog_number=excluded.catalog_number, barcode=excluded.barcode,
          musicbrainz_release_id=excluded.musicbrainz_release_id, disc_number=excluded.disc_number,
          disc_total=excluded.disc_total, track_number=excluded.track_number, track_total=excluded.track_total,
          raw_tags_json=excluded.raw_tags_json, artwork_json=excluded.artwork_json,
          warnings_json=excluded.warnings_json,
          scan_job_id=excluded.scan_job_id, scanned_at=excluded.scanned_at`,
      )
      .run({
        id,
        rootId,
        jobId,
        relativePath: file.relativePath,
        absolutePath: file.absolutePath,
        extension: file.extension,
        sizeBytes: file.sizeBytes,
        modifiedAtMs: file.modifiedAtMs,
        fileSha256: file.fileSha256 ?? null,
        container: file.audio.container,
        codec: file.audio.codec,
        audioKind: file.audio.kind,
        lossless:
          file.audio.lossless === null ? null : file.audio.lossless ? 1 : 0,
        bitDepth: file.audio.bitDepth,
        sampleRate: file.audio.sampleRate,
        bitrate: file.audio.bitrate,
        channels: file.audio.channels,
        dsdRate: file.audio.dsdRate,
        durationSeconds: file.durationSeconds,
        album: file.tags.album,
        albumArtist: file.tags.albumArtist,
        title: file.tags.title,
        artistsJson: JSON.stringify(file.tags.artists),
        year: file.tags.year,
        dateText: file.tags.date,
        genreJson: JSON.stringify(file.tags.genre),
        composerJson: JSON.stringify(file.tags.composer),
        labelJson: JSON.stringify(file.tags.label),
        catalogNumber: file.tags.catalogNumber,
        barcode: file.tags.barcode,
        musicBrainzReleaseId: file.tags.musicBrainzReleaseId,
        discNumber: file.tags.discNumber,
        discTotal: file.tags.discTotal,
        trackNumber: file.tags.trackNumber,
        trackTotal: file.tags.trackTotal,
        rawTagsJson: JSON.stringify(file.rawTags ?? []),
        artworkJson: JSON.stringify(file.artwork),
        warningsJson: JSON.stringify(file.warnings),
        scannedAt: new Date().toISOString(),
      });
  }

  deleteMediaFilesNotSeen(rootId: string, scanJobId: string): number {
    return this.raw
      .prepare(
        "DELETE FROM media_files WHERE root_id = ? AND (scan_job_id IS NULL OR scan_job_id <> ?)",
      )
      .run(rootId, scanJobId).changes;
  }

  listMediaFilesForRoot(
    rootId: string,
  ): Array<{ id: string; file: ObservedMediaFile }> {
    return this.raw
      .prepare(
        "SELECT * FROM media_files WHERE root_id = ? ORDER BY relative_path",
      )
      .all(rootId)
      .map((row) => mapObservedMediaFile(row as Record<string, unknown>));
  }

  listAlbumIdentityHints(rootId: string): AlbumIdentityHint[] {
    const rows = this.raw
      .prepare(
        `SELECT albums.id AS album_id, albums.group_key, album_files.media_file_id
         FROM albums
         LEFT JOIN album_files ON album_files.album_id = albums.id
         WHERE albums.root_id = ?
         ORDER BY albums.id, album_files.media_file_id`,
      )
      .all(rootId) as Array<Record<string, unknown>>;
    const grouped = new Map<string, AlbumIdentityHint>();
    for (const row of rows) {
      const id = String(row.album_id);
      const hint = grouped.get(id) ?? {
        id,
        groupKey: String(row.group_key),
        fileIds: [],
      };
      const fileId = nullableString(row.media_file_id);
      if (fileId) hint.fileIds.push(fileId);
      grouped.set(id, hint);
    }
    return [...grouped.values()];
  }

  listAlbumIds(): string[] {
    return (
      this.raw.prepare("SELECT id FROM albums ORDER BY id").all() as Array<{
        id: string;
      }>
    ).map((row) => row.id);
  }

  private alignMediaFileIdentity(
    rootId: string,
    id: string,
    file: ObservedMediaFile,
  ): void {
    const existing = this.raw
      .prepare("SELECT root_id, relative_path FROM media_files WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!existing) return;
    if (String(existing.root_id) !== rootId)
      throw new Error("media identity cannot move between library roots");
    if (String(existing.relative_path) === file.relativePath) return;
    const pathOwner = this.raw
      .prepare(
        "SELECT id FROM media_files WHERE root_id = ? AND relative_path = ?",
      )
      .get(rootId, file.relativePath) as { id: string } | undefined;
    if (pathOwner && pathOwner.id !== id)
      throw new Error("media identity target path is already occupied");
    this.raw
      .prepare(
        `UPDATE media_files
         SET relative_path = ?, absolute_path = ?
         WHERE id = ? AND root_id = ?`,
      )
      .run(file.relativePath, file.absolutePath, id, rootId);
  }

  private deleteMediaFilesNotDiscovered(
    rootId: string,
    seenRelativePaths: string[],
  ): number {
    this.raw.exec(
      "CREATE TEMP TABLE IF NOT EXISTS cocean_seen_media_paths(relative_path TEXT PRIMARY KEY); DELETE FROM cocean_seen_media_paths;",
    );
    const remember = this.raw.prepare(
      "INSERT OR IGNORE INTO cocean_seen_media_paths(relative_path) VALUES (?)",
    );
    for (const path of seenRelativePaths) {
      assertEvidenceRelativePath(path);
      remember.run(path);
    }
    return this.raw
      .prepare(
        `DELETE FROM media_files
         WHERE root_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM cocean_seen_media_paths
             WHERE cocean_seen_media_paths.relative_path = media_files.relative_path
           )`,
      )
      .run(rootId).changes;
  }

  getMediaFileLocation(
    id: string,
  ): { id: string; relativePath: string; rootPath: string } | null {
    const row = this.raw
      .prepare(
        `SELECT media_files.id, media_files.relative_path, library_roots.container_path
         FROM media_files
         JOIN library_roots ON library_roots.id = media_files.root_id
         WHERE media_files.id = ? AND library_roots.enabled = 1`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row
      ? {
          id: String(row.id),
          relativePath: String(row.relative_path),
          rootPath: String(row.container_path),
        }
      : null;
  }

  replaceAlbumsForRoot(rootId: string, albums: AlbumRecordInput[]): void {
    this.raw.transaction(() =>
      this.replaceAlbumsForRootInTransaction(rootId, albums),
    )();
  }

  private replaceAlbumsForRootInTransaction(
    rootId: string,
    albums: AlbumRecordInput[],
  ): void {
    const now = new Date().toISOString();
    const automaticIdentityBaseline = this.captureAutomaticIdentityBaseline();
    const previousMembership = this.raw
      .prepare(
        `SELECT album_files.album_id, album_files.media_file_id
         FROM album_files
         JOIN albums ON albums.id = album_files.album_id
         WHERE albums.root_id = ?`,
      )
      .all(rootId) as Array<{
      album_id: string;
      media_file_id: string;
    }>;
    const upsertAlbum = this.raw.prepare(
      `INSERT INTO albums (
        id, root_id, group_key, title, album_artist, year, disc_count, track_count,
        audio_summary_json, audio_badge, mixed_audio_specs, artwork_json, match_status,
        label, catalog_number, barcode, musicbrainz_release_id, aggregation_issues_json,
        source_version_count, duplicate_file_count, created_at, updated_at
      ) VALUES (
        @id, @rootId, @groupKey, @title, @albumArtist, @year, @discCount, @trackCount,
        @audioSummaryJson, @audioBadge, @mixedAudioSpecs, @artworkJson, @matchStatus,
        @label, @catalogNumber, @barcode, @musicBrainzReleaseId, @aggregationIssuesJson,
        @sourceVersionCount, @duplicateFileCount, @now, @now
      ) ON CONFLICT(id) DO UPDATE SET
        group_key=excluded.group_key, title=excluded.title, album_artist=excluded.album_artist,
        year=excluded.year, disc_count=excluded.disc_count, track_count=excluded.track_count,
        source_version_count=excluded.source_version_count,
        duplicate_file_count=excluded.duplicate_file_count,
        audio_summary_json=excluded.audio_summary_json, audio_badge=excluded.audio_badge,
        mixed_audio_specs=excluded.mixed_audio_specs, artwork_json=excluded.artwork_json,
        aggregation_issues_json=excluded.aggregation_issues_json,
        match_status=CASE
          WHEN albums.match_status IN ('SOURCE_MATCHED','USER_CONFIRMED') THEN albums.match_status
          ELSE excluded.match_status
        END,
        label=COALESCE(albums.label, excluded.label),
        catalog_number=COALESCE(albums.catalog_number, excluded.catalog_number),
        barcode=COALESCE(albums.barcode, excluded.barcode),
        musicbrainz_release_id=COALESCE(albums.musicbrainz_release_id, excluded.musicbrainz_release_id),
        updated_at=excluded.updated_at`,
    );
    const link = this.raw.prepare(
      `INSERT INTO album_files(
        album_id, media_file_id, is_primary, disc_number_override
      ) VALUES (?, ?, ?, ?)`,
    );
    this.raw.exec(
      "CREATE TEMP TABLE IF NOT EXISTS cocean_current_album_ids(id TEXT PRIMARY KEY); DELETE FROM cocean_current_album_ids;",
    );
    const rememberAlbum = this.raw.prepare(
      "INSERT OR IGNORE INTO cocean_current_album_ids(id) VALUES (?)",
    );
    this.raw
      .prepare(
        "DELETE FROM album_files WHERE album_id IN (SELECT id FROM albums WHERE root_id = ?)",
      )
      .run(rootId);
    for (const album of albums) {
      rememberAlbum.run(album.id);
      const primaryFileIds = new Set(album.primaryFileIds ?? album.fileIds);
      upsertAlbum.run({
        ...album,
        trackCount: primaryFileIds.size,
        sourceVersionCount: album.sourceVersionCount ?? 1,
        duplicateFileCount:
          album.duplicateFileCount ??
          album.fileIds.length - primaryFileIds.size,
        audioSummaryJson: album.audioSummary
          ? JSON.stringify(album.audioSummary)
          : null,
        audioBadge: album.audioSummary
          ? formatCompactAudioSpec(album.audioSummary)
          : null,
        mixedAudioSpecs: album.mixedAudioSpecs ? 1 : 0,
        artworkJson: JSON.stringify(album.artwork),
        aggregationIssuesJson: JSON.stringify(album.aggregationIssues ?? []),
        matchStatus: album.matchStatus ?? "UNMATCHED",
        label: album.label ?? null,
        catalogNumber: album.catalogNumber ?? null,
        barcode: album.barcode ?? null,
        musicBrainzReleaseId: album.musicBrainzReleaseId ?? null,
        now,
      });
      for (const fileId of album.fileIds) {
        link.run(
          album.id,
          fileId,
          primaryFileIds.has(fileId) ? 1 : 0,
          album.fileDiscNumbers?.[fileId] ?? null,
        );
      }
    }
    this.remapMergedAlbumDependencies(albums, previousMembership, now);
    this.raw
      .prepare(
        `DELETE FROM albums
         WHERE root_id = ?
           AND id NOT IN (SELECT id FROM cocean_current_album_ids)
           AND NOT EXISTS (
             SELECT 1 FROM library_album_members lm
             JOIN library_albums la ON la.id=lm.library_album_id
             WHERE lm.album_id=albums.id
               AND (lm.relationship_status<>'AUTO_CANDIDATE'
                 OR (la.primary_version_id=albums.id AND la.primary_version_source='USER'))
           )
           AND NOT EXISTS (SELECT 1 FROM physical_copies WHERE physical_copies.album_id = albums.id)
           AND NOT EXISTS (SELECT 1 FROM release_match_candidates WHERE release_match_candidates.album_id = albums.id)
           AND NOT EXISTS (SELECT 1 FROM delivery_records WHERE delivery_records.album_id = albums.id)
           AND NOT EXISTS (SELECT 1 FROM delivery_jobs WHERE delivery_jobs.album_id = albums.id)
           AND NOT EXISTS (SELECT 1 FROM album_introductions WHERE album_introductions.album_id = albums.id)`,
      )
      .run(rootId);
    this.raw
      .prepare(
        `UPDATE albums SET track_count=0, audio_summary_json=NULL, audio_badge=NULL,
           mixed_audio_specs=0, aggregation_issues_json='[]',
           source_version_count=1, duplicate_file_count=0, updated_at=?
         WHERE root_id=? AND id NOT IN (SELECT id FROM cocean_current_album_ids)`,
      )
      .run(now, rootId);
    this.rebuildAutomaticLibraryAlbums(automaticIdentityBaseline);
  }

  private remapMergedAlbumDependencies(
    albums: AlbumRecordInput[],
    previousMembership: Array<{
      album_id: string;
      media_file_id: string;
    }>,
    now: string,
  ): void {
    const currentAlbumIds = new Set(albums.map((album) => album.id));
    const currentOwnerByFile = new Map<string, string>();
    for (const album of albums)
      for (const fileId of album.fileIds)
        currentOwnerByFile.set(fileId, album.id);
    const oldFilesByAlbum = new Map<string, string[]>();
    for (const row of previousMembership) {
      const files = oldFilesByAlbum.get(row.album_id) ?? [];
      files.push(row.media_file_id);
      oldFilesByAlbum.set(row.album_id, files);
    }

    for (const [oldAlbumId, fileIds] of oldFilesByAlbum) {
      if (currentAlbumIds.has(oldAlbumId) || !fileIds.length) continue;
      const owners = new Set(
        fileIds
          .map((fileId) => currentOwnerByFile.get(fileId))
          .filter((id): id is string => Boolean(id)),
      );
      if (
        owners.size !== 1 ||
        fileIds.some((id) => !currentOwnerByFile.has(id))
      )
        continue;
      const [newAlbumId] = owners;
      if (!newAlbumId || newAlbumId === oldAlbumId) continue;

      for (const table of [
        "physical_copies",
        "delivery_records",
        "delivery_jobs",
      ])
        this.raw
          .prepare(`UPDATE ${table} SET album_id=? WHERE album_id=?`)
          .run(newAlbumId, oldAlbumId);

      this.raw
        .prepare(
          "UPDATE OR IGNORE release_match_candidates SET album_id=? WHERE album_id=?",
        )
        .run(newAlbumId, oldAlbumId);
      this.raw
        .prepare("DELETE FROM release_match_candidates WHERE album_id=?")
        .run(oldAlbumId);
      this.raw
        .prepare(
          "UPDATE OR IGNORE album_introductions SET album_id=? WHERE album_id=?",
        )
        .run(newAlbumId, oldAlbumId);
      this.raw
        .prepare("DELETE FROM album_introductions WHERE album_id=?")
        .run(oldAlbumId);
      this.raw
        .prepare(
          `UPDATE albums
           SET match_status = CASE
                 WHEN (SELECT match_status FROM albums WHERE id=?) = 'USER_CONFIRMED'
                   THEN 'USER_CONFIRMED'
                 WHEN match_status = 'UNMATCHED'
                   THEN (SELECT match_status FROM albums WHERE id=?)
                 ELSE match_status
               END,
               label = COALESCE(label, (SELECT label FROM albums WHERE id=?)),
               catalog_number = COALESCE(catalog_number, (SELECT catalog_number FROM albums WHERE id=?)),
               barcode = COALESCE(barcode, (SELECT barcode FROM albums WHERE id=?)),
               musicbrainz_release_id = COALESCE(
                 musicbrainz_release_id,
                 (SELECT musicbrainz_release_id FROM albums WHERE id=? )
               ),
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          oldAlbumId,
          oldAlbumId,
          oldAlbumId,
          oldAlbumId,
          oldAlbumId,
          oldAlbumId,
          now,
          newAlbumId,
        );
    }
  }

  private requireRunningScanJob(scanJobId: string, rootId: string): ScanJob {
    const job = this.getScanJob(scanJobId);
    if (!job) throw new Error(`Scan job ${scanJobId} does not exist`);
    if (job.rootId !== rootId)
      throw new Error(`Scan job ${scanJobId} belongs to a different root`);
    if (job.status !== "RUNNING")
      throw new Error(`Scan job ${scanJobId} is not running`);
    return job;
  }

  private scanDiscovery(
    scanJobId: string,
    job: ScanJob,
    fallbackRulesVersion = "cocean-library-scan/unknown",
  ): StoredScanDiscovery {
    const row = this.raw
      .prepare("SELECT * FROM scan_discovery_state WHERE scan_job_id = ?")
      .get(scanJobId) as Record<string, unknown> | undefined;
    if (row) {
      return {
        rulesVersion: String(row.rules_version),
        candidates: Number(row.candidates),
        regularFiles: Number(row.regular_files),
        auxiliaryFiles: Number(row.auxiliary_files),
        ignoredFiles: Number(row.ignored_files),
        skippedSymlinks: Number(row.skipped_symlinks),
        traversalErrors: Number(row.traversal_errors),
        boundaryStatePresent: true,
      };
    }
    const observed = this.raw
      .prepare(
        `SELECT
          SUM(CASE WHEN candidate_kind IN ('SUPPORTED_AUDIO','KNOWN_UNSUPPORTED_AUDIO') THEN 1 ELSE 0 END) AS processed,
          SUM(CASE WHEN candidate_kind = 'SYMLINK' THEN 1 ELSE 0 END) AS symlinks,
          SUM(CASE WHEN candidate_kind = 'TRAVERSAL_ERROR' THEN 1 ELSE 0 END) AS traversal
         FROM scan_file_results WHERE scan_job_id = ?`,
      )
      .get(scanJobId) as Record<string, unknown>;
    const processed = Number(observed.processed ?? 0);
    const candidates = Math.max(job.totalFiles, processed);
    return {
      rulesVersion: fallbackRulesVersion,
      candidates,
      regularFiles: candidates,
      auxiliaryFiles: 0,
      ignoredFiles: 0,
      skippedSymlinks: Number(observed.symlinks ?? 0),
      traversalErrors: Number(observed.traversal ?? 0),
      boundaryStatePresent: false,
    };
  }

  private scanEvidence(
    scanJobId: string,
    discovery: StoredScanDiscovery,
  ): ScanEvidenceCounts {
    const row = this.raw
      .prepare(
        `SELECT
          SUM(CASE WHEN candidate_kind IN ('SUPPORTED_AUDIO','KNOWN_UNSUPPORTED_AUDIO') THEN 1 ELSE 0 END) AS processed,
          SUM(CASE WHEN candidate_kind IN ('SUPPORTED_AUDIO','KNOWN_UNSUPPORTED_AUDIO') AND outcome = 'PARSED' THEN 1 ELSE 0 END) AS parsed,
          SUM(CASE WHEN candidate_kind IN ('SUPPORTED_AUDIO','KNOWN_UNSUPPORTED_AUDIO') AND outcome = 'UNSUPPORTED' THEN 1 ELSE 0 END) AS unsupported,
          SUM(CASE WHEN candidate_kind IN ('SUPPORTED_AUDIO','KNOWN_UNSUPPORTED_AUDIO') AND outcome = 'FAILED' THEN 1 ELSE 0 END) AS failed
         FROM scan_file_results WHERE scan_job_id = ?`,
      )
      .get(scanJobId) as Record<string, unknown>;
    const processed = Number(row.processed ?? 0);
    const parsed = Number(row.parsed ?? 0);
    const unsupported = Number(row.unsupported ?? 0);
    const failed = Number(row.failed ?? 0);
    if (processed !== parsed + unsupported + failed)
      throw new Error("scan outcome invariant failed");
    if (processed > discovery.candidates)
      throw new Error(
        "scan processed more audio candidates than were discovered",
      );
    return {
      candidates: discovery.candidates,
      processed,
      parsed,
      unsupported,
      failed,
      unprocessed: discovery.candidates - processed,
    };
  }

  private updateTerminalScanJob(
    scanJobId: string,
    withWarnings: boolean,
    error: string | null,
    evidence: ScanEvidenceCounts,
    forcedStatus?: "CANCELLED",
  ): void {
    const status =
      forcedStatus ??
      (error
        ? "FAILED"
        : withWarnings
          ? "COMPLETED_WITH_WARNINGS"
          : "COMPLETED");
    this.raw
      .prepare(
        `UPDATE scan_jobs SET
          status=@status, total_files=@candidates, processed_files=@processed,
          parsed_files=@parsed, failed_files=@legacyFailed,
          error=@error, finished_at=@finishedAt
         WHERE id=@scanJobId`,
      )
      .run({
        scanJobId,
        status,
        ...evidence,
        legacyFailed: evidence.unsupported + evidence.failed,
        error,
        finishedAt: new Date().toISOString(),
      });
  }

  private insertScanReport(
    scanJobId: string,
    albumCount: number | null,
    albumIssueCount: number | null,
    fallbackRulesVersion = "cocean-library-scan/unknown",
  ): void {
    const job = this.getScanJob(scanJobId);
    if (!job) throw new Error(`Scan job ${scanJobId} does not exist`);
    const discovery = this.scanDiscovery(scanJobId, job, fallbackRulesVersion);
    const evidence = this.scanEvidence(scanJobId, discovery);
    const boundaryRows = this.raw
      .prepare(
        `SELECT
          SUM(CASE WHEN candidate_kind = 'SYMLINK' AND outcome = 'SKIPPED' THEN 1 ELSE 0 END) AS symlinks,
          SUM(CASE WHEN candidate_kind = 'TRAVERSAL_ERROR' AND outcome = 'FAILED' THEN 1 ELSE 0 END) AS traversal
         FROM scan_file_results WHERE scan_job_id = ?`,
      )
      .get(scanJobId) as Record<string, unknown>;
    const boundaryEvidence =
      discovery.boundaryStatePresent &&
      Number(boundaryRows.symlinks ?? 0) === discovery.skippedSymlinks &&
      Number(boundaryRows.traversal ?? 0) === discovery.traversalErrors;
    const createdAt = new Date().toISOString();
    const summary = {
      scanJobId,
      rootId: job.rootId,
      status: job.status,
      rulesVersion: discovery.rulesVersion,
      ...evidence,
      regularFiles: discovery.regularFiles,
      auxiliaryFiles: discovery.auxiliaryFiles,
      ignoredFiles: discovery.ignoredFiles,
      skippedSymlinks: discovery.skippedSymlinks,
      traversalErrors: discovery.traversalErrors,
      boundaryEvidence,
      albumCount,
      albumIssueCount,
    };
    const summaryHash = this.hashScanReport(summary);
    this.raw
      .prepare(
        `INSERT INTO scan_reports (
          scan_job_id, root_id, rules_version, summary_hash,
          candidates, processed, parsed, unsupported, failed, unprocessed,
          regular_files, auxiliary_files, ignored_files, skipped_symlinks,
          traversal_errors, boundary_evidence, album_count, album_issue_count,
          created_at
        ) VALUES (
          @scanJobId, @rootId, @rulesVersion, @summaryHash,
          @candidates, @processed, @parsed, @unsupported, @failed, @unprocessed,
          @regularFiles, @auxiliaryFiles, @ignoredFiles, @skippedSymlinks,
          @traversalErrors, @boundaryEvidence, @albumCount, @albumIssueCount,
          @createdAt
        )`,
      )
      .run({
        ...summary,
        summaryHash,
        boundaryEvidence: boundaryEvidence ? 1 : 0,
        createdAt,
      });
  }

  private hashScanReport(summary: Record<string, unknown>): string {
    const hash = createHash("sha256");
    hash.update(JSON.stringify(summary));
    const rows = this.raw
      .prepare(
        `SELECT relative_path, extension, candidate_kind, outcome, media_file_id,
                size_bytes, modified_at_ms, error_code, error_stage, warning_codes_json
         FROM scan_file_results WHERE scan_job_id = ?
         ORDER BY candidate_kind, relative_path, id`,
      )
      .iterate(String(summary.scanJobId));
    for (const row of rows) {
      const value = row as Record<string, unknown>;
      hash.update("\n");
      hash.update(
        JSON.stringify([
          value.relative_path,
          value.extension,
          value.candidate_kind,
          value.outcome,
          value.media_file_id,
          value.size_bytes,
          value.modified_at_ms,
          value.error_code,
          value.error_stage,
          value.warning_codes_json,
        ]),
      );
    }
    return hash.digest("hex");
  }

  private rebuildAutomaticLibraryAlbums(
    baseline = this.captureAutomaticIdentityBaseline(),
  ): void {
    this.raw.transaction(() =>
      this.rebuildAutomaticLibraryAlbumsInTransaction(baseline),
    )();
  }

  private captureAutomaticIdentityBaseline(): AutomaticIdentityBaseline {
    const groups = this.raw
      .prepare(
        "SELECT id,primary_version_id FROM library_albums WHERE decision_source='AUTOMATIC'",
      )
      .all() as Array<{ id: string; primary_version_id: string | null }>;
    return {
      members: new Map(
        groups.map((group) => [
          group.id,
          this.libraryIdentityMemberIds([group.id]),
        ]),
      ),
      primaryVersions: new Map(
        groups.map((group) => [group.id, group.primary_version_id]),
      ),
    };
  }

  private rebuildAutomaticLibraryAlbumsInTransaction(
    baseline: AutomaticIdentityBaseline,
  ): void {
    const now = new Date().toISOString();
    const albums = this.raw
      .prepare(
        `SELECT a.*,
      (SELECT MIN(mf.relative_path) FROM album_files af JOIN media_files mf ON mf.id=af.media_file_id WHERE af.album_id=a.id) AS stable_path
      FROM albums a`,
      )
      .all() as Record<string, unknown>[];
    const albumById = new Map(albums.map((album) => [String(album.id), album]));
    const protectedGroups = this.raw
      .prepare(
        `SELECT * FROM library_albums
         WHERE decision_source='USER' OR primary_version_source='USER'`,
      )
      .all() as Record<string, unknown>[];
    const protectedGroupIds = new Set(
      protectedGroups.map((group) => String(group.id)),
    );
    const protectedAlbumIds = new Set(
      (
        this.raw
          .prepare(
            `SELECT album_id FROM library_album_members
             WHERE library_album_id IN (
               SELECT id FROM library_albums
               WHERE decision_source='USER' OR primary_version_source='USER'
             )`,
          )
          .all() as Array<{ album_id: string }>
      ).map((row) => row.album_id),
    );
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const album of albums.filter(
      (candidate) => !protectedAlbumIds.has(String(candidate.id)),
    )) {
      const key = normalizeLibraryIdentity(
        String(album.album_artist),
        String(album.title),
      );
      const members = groups.get(key) ?? [];
      members.push(album);
      groups.set(key, members);
    }
    const existingAutomaticGroups = this.raw
      .prepare("SELECT * FROM library_albums WHERE decision_source='AUTOMATIC'")
      .all() as Record<string, unknown>[];
    const existingByKey = new Map(
      existingAutomaticGroups.map((group) => [
        String(group.identity_key),
        group,
      ]),
    );
    const previousMembers = baseline.members;
    const addMember = this.raw.prepare(`INSERT INTO library_album_members
      (library_album_id,album_id,relationship_status,created_at,updated_at)
      VALUES (?,?,'AUTO_CANDIDATE',?,?)
      ON CONFLICT(album_id) DO UPDATE SET
        library_album_id=CASE WHEN library_album_members.relationship_status='AUTO_CANDIDATE' THEN excluded.library_album_id ELSE library_album_members.library_album_id END,
        updated_at=excluded.updated_at`);
    this.raw
      .prepare(
        `DELETE FROM library_album_members
         WHERE relationship_status='AUTO_CANDIDATE'
           AND library_album_id NOT IN (
             SELECT id FROM library_albums WHERE primary_version_source='USER'
           )`,
      )
      .run();
    for (const protectedGroup of protectedGroups.filter(
      (group) => group.decision_source === "AUTOMATIC",
    )) {
      const key = String(protectedGroup.identity_key);
      const additions = groups.get(key) ?? [];
      if (!additions.length) continue;
      const groupId = String(protectedGroup.id);
      for (const member of additions)
        addMember.run(groupId, member.id, now, now);
      groups.delete(key);
    }
    for (const [key, members] of groups) {
      const ranked = [...members].sort(comparePrimaryVersions);
      const primary = ranked[0]!;
      const existing = existingByKey.get(key);
      const groupId = existing
        ? String(existing.id)
        : this.collisionSafeAutomaticLibraryAlbumId(key);
      const nextMemberIds = members.map((member) => String(member.id)).sort();
      const oldMemberIds = previousMembers.get(groupId) ?? [];
      const oldPrimary = existing
        ? (baseline.primaryVersions.get(groupId) ??
          nullableString(existing.primary_version_id))
        : null;
      const primaryId = String(primary.id);
      const changed =
        Boolean(existing) &&
        (oldPrimary !== primaryId ||
          oldMemberIds.length !== nextMemberIds.length ||
          oldMemberIds.some((id, index) => id !== nextMemberIds[index]));
      const createdAt =
        members.map((member) => String(member.created_at)).sort()[0] ?? now;
      if (existing)
        this.raw
          .prepare(
            `UPDATE library_albums SET title=?,album_artist=?,primary_version_id=?,
               primary_version_source='AUTOMATIC',revision=revision+?,updated_at=?
             WHERE id=?`,
          )
          .run(
            primary.title,
            primary.album_artist,
            primaryId,
            changed ? 1 : 0,
            now,
            groupId,
          );
      else
        this.raw
          .prepare(
            `INSERT INTO library_albums
               (id,identity_key,title,album_artist,primary_version_id,decision_source,
                primary_version_source,revision,created_at,updated_at)
             VALUES (?,?,?,?,?,'AUTOMATIC','AUTOMATIC',0,?,?)`,
          )
          .run(
            groupId,
            key,
            primary.title,
            primary.album_artist,
            primaryId,
            createdAt,
            now,
          );
      for (const member of members) addMember.run(groupId, member.id, now, now);
      this.rebuildLibraryIssuesForGroup(groupId, members, true, now);
    }
    for (const group of protectedGroups) {
      const groupId = String(group.id);
      const memberIds = this.libraryIdentityMemberIds([groupId]);
      const members = memberIds
        .map((id) => albumById.get(id))
        .filter((album): album is Record<string, unknown> => Boolean(album));
      const primaryId = String(group.primary_version_id);
      if (!memberIds.includes(primaryId))
        throw new LibraryIdentityDecisionError(
          "IDENTITY_DECISION_CONFLICT",
          "人工主版本必须始终属于其稳定唱片",
        );
      const oldMemberIds = baseline.members.get(groupId) ?? memberIds;
      if (
        oldMemberIds.length !== memberIds.length ||
        oldMemberIds.some((id, index) => id !== memberIds[index])
      )
        this.raw
          .prepare(
            `UPDATE library_albums SET revision=revision+1,updated_at=? WHERE id=?`,
          )
          .run(now, groupId);
      this.rebuildLibraryIssuesForGroup(
        groupId,
        members,
        group.decision_source === "AUTOMATIC" && members.length > 1,
        now,
      );
    }
    this.raw
      .prepare(
        `DELETE FROM library_albums WHERE decision_source='AUTOMATIC'
      AND primary_version_source='AUTOMATIC'
      AND NOT EXISTS (SELECT 1 FROM library_album_members lm WHERE lm.library_album_id=library_albums.id)`,
      )
      .run();
  }

  private collisionSafeAutomaticLibraryAlbumId(identityKey: string): string {
    const digest = createHash("sha256").update(identityKey).digest("hex");
    for (let attempt = 0; ; attempt += 1) {
      const suffix =
        attempt === 0
          ? digest.slice(0, 24)
          : `${digest.slice(0, 15)}-${createHash("sha256")
              .update(`${identityKey}\0${attempt}`)
              .digest("hex")
              .slice(0, 8)}`;
      const id = `library-${suffix}`;
      const collision = this.raw
        .prepare(
          `SELECT 1 FROM library_albums WHERE id=?
           UNION ALL SELECT 1 FROM library_album_aliases WHERE alias_id=? LIMIT 1`,
        )
        .get(id, id);
      if (!collision) return id;
    }
  }

  private rebuildLibraryIssuesForGroup(
    groupId: string,
    members: Record<string, unknown>[],
    includeIdentityOverlap: boolean,
    now: string,
  ): void {
    const previousCreatedAt = new Map<string, string>(
      (
        this.raw
          .prepare(
            `SELECT album_id,code,created_at FROM library_issues
             WHERE library_album_id=?`,
          )
          .all(groupId) as Record<string, unknown>[]
      ).map((row) => [
        issueIdentity(groupId, nullableString(row.album_id), String(row.code)),
        String(row.created_at),
      ]),
    );
    this.raw
      .prepare("DELETE FROM library_issues WHERE library_album_id=?")
      .run(groupId);
    const addIssue = this.raw.prepare(
      `INSERT INTO library_issues
       (library_album_id,album_id,code,evidence_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?)`,
    );
    const insertIssue = (
      albumId: string | null,
      code: LibraryIssueCode,
      evidence: Record<string, unknown>,
    ) =>
      addIssue.run(
        groupId,
        albumId,
        code,
        JSON.stringify(evidence),
        previousCreatedAt.get(issueIdentity(groupId, albumId, code)) ?? now,
        now,
      );
    if (includeIdentityOverlap && members.length > 1)
      insertIssue(null, "IDENTITY_OVERLAP", {
        versionCount: members.length,
        basis: "NORMALIZED_TITLE_ARTIST",
      });
    for (const member of members) {
      const memberId = String(member.id);
      const aggregation = parseJson<AlbumAggregationIssue[]>(
        member.aggregation_issues_json,
        [],
      );
      if (aggregation.length || member.match_status === "TRACKS_INCOMPLETE")
        insertIssue(memberId, "INCOMPLETE_TRACKS", {
          trackCount: Number(member.track_count),
          aggregationIssues: aggregation,
          legacyMatchStatus: member.match_status === "TRACKS_INCOMPLETE",
        });
      const artwork = parseJson<AlbumSummary["artwork"]>(member.artwork_json, {
        source: "NONE",
        url: null,
        mimeType: null,
        width: null,
        height: null,
      });
      if (artwork.source === "NONE")
        insertIssue(memberId, "MISSING_ARTWORK", { source: "NONE" });
      else if (
        (artwork.width != null && artwork.width < 600) ||
        (artwork.height != null && artwork.height < 600)
      )
        insertIssue(memberId, "LOW_RES_ARTWORK", {
          width: artwork.width,
          height: artwork.height,
          minimum: 600,
        });
      if (Boolean(member.mixed_audio_specs))
        insertIssue(memberId, "MIXED_AUDIO_SPECS", { mixed: true });
      const brokenFields = [
        ...(hasBrokenText(String(member.title)) ? ["title"] : []),
        ...(hasBrokenText(String(member.album_artist)) ? ["albumArtist"] : []),
      ];
      if (brokenFields.length)
        insertIssue(memberId, "BROKEN_TEXT", { fields: brokenFields });
      if (this.versionUsesFallbackIdentity(memberId))
        insertIssue(memberId, "MISSING_IDENTITY", { fallback: true });
    }
  }

  private versionUsesFallbackIdentity(albumId: string): boolean {
    const row = this.raw
      .prepare(
        `SELECT COUNT(*) AS file_count,
                SUM(CASE WHEN trim(COALESCE(media_files.album, '')) <> '' THEN 1 ELSE 0 END) AS album_tags,
                SUM(CASE
                  WHEN trim(COALESCE(media_files.album_artist, '')) <> ''
                    OR json_array_length(media_files.artists_json) > 0
                  THEN 1 ELSE 0
                END) AS artist_tags
         FROM album_files
         JOIN media_files ON media_files.id=album_files.media_file_id
         WHERE album_files.album_id=? AND album_files.is_primary=1`,
      )
      .get(albumId) as Record<string, unknown>;
    const fileCount = Number(row.file_count);
    return (
      fileCount > 0 &&
      (Number(row.album_tags) === 0 || Number(row.artist_tags) === 0)
    );
  }

  applyLibraryIdentityDecision(
    albumId: string,
    command: LibraryIdentityDecisionCommand,
    actor: LibraryIdentityActor,
  ): LibraryIdentityDecisionResult {
    return this.raw.transaction(() => {
      const inputJson = canonicalLibraryIdentityDecisionInput(albumId, command);
      const replay = this.identityDecisionResultByRequestId(
        command.requestId,
        inputJson,
      );
      if (replay) return replay;
      const sourceId = this.resolveLibraryAlbumId(albumId);
      if (!sourceId)
        throw new LibraryIdentityDecisionError(
          "IDENTITY_DECISION_CONFLICT",
          "唱片身份已经不存在或无法解析",
        );
      const source = this.libraryIdentityGroup(sourceId);
      this.assertIdentityRevision(source, command.revision);
      const now = new Date().toISOString();
      let scope = [sourceId];
      let before = this.captureLibraryIdentitySnapshot(scope);
      let currentLibraryAlbumId = sourceId;
      let inheritedDecisionIds: string[] = [];
      let inheritedHistoryTargets: string[] = [];

      if (command.type === "CONFIRM") {
        if (command.primaryVersionId)
          this.assertVersionMember(sourceId, command.primaryVersionId);
        this.raw
          .prepare(
            `UPDATE library_albums SET
               decision_source='USER',
               primary_version_id=COALESCE(?, primary_version_id),
               primary_version_source=CASE WHEN ? IS NULL THEN primary_version_source ELSE 'USER' END,
               revision=revision+1, updated_at=?
             WHERE id=?`,
          )
          .run(
            command.primaryVersionId ?? null,
            command.primaryVersionId ?? null,
            now,
            sourceId,
          );
        this.raw
          .prepare(
            `UPDATE library_album_members SET relationship_status='USER_CONFIRMED', updated_at=?
             WHERE library_album_id=?`,
          )
          .run(now, sourceId);
        this.raw
          .prepare(
            "DELETE FROM library_issues WHERE library_album_id=? AND code='IDENTITY_OVERLAP'",
          )
          .run(sourceId);
      } else if (command.type === "SET_PRIMARY") {
        this.assertVersionMember(sourceId, command.primaryVersionId);
        this.raw
          .prepare(
            `UPDATE library_albums SET primary_version_id=?, primary_version_source='USER',
               revision=revision+1, updated_at=? WHERE id=?`,
          )
          .run(command.primaryVersionId, now, sourceId);
      } else if (command.type === "MERGE") {
        const targetId = this.resolveLibraryAlbumId(
          command.targetLibraryAlbumId,
        );
        if (!targetId || targetId === sourceId)
          throw new LibraryIdentityDecisionError(
            "INVALID_IDENTITY_DECISION",
            "请选择另一个稳定唱片作为合并目标",
          );
        const target = this.libraryIdentityGroup(targetId);
        this.assertIdentityRevision(target, command.targetRevision);
        const mergedVersionIds = this.libraryIdentityMemberIds([
          sourceId,
          targetId,
        ]);
        if (!mergedVersionIds.includes(command.primaryVersionId))
          throw new LibraryIdentityDecisionError(
            "IDENTITY_DECISION_CONFLICT",
            "主版本必须属于待合并的唱片",
          );
        const activeConflict = this.raw
          .prepare(
            `SELECT target_id FROM delivery_jobs
             WHERE status IN ('QUEUED','RUNNING')
               AND album_id IN (
                 SELECT album_id FROM library_album_members
                 WHERE library_album_id IN (?, ?)
               )
             GROUP BY target_id HAVING COUNT(DISTINCT album_id)>1 LIMIT 1`,
          )
          .get(sourceId, targetId);
        if (activeConflict)
          throw new LibraryIdentityDecisionError(
            "IDENTITY_DECISION_CONFLICT",
            "合并会让同一投送目标出现重复活动任务，请等待任务结束",
          );
        scope = [sourceId, targetId];
        before = this.captureLibraryIdentitySnapshot(scope);
        inheritedDecisionIds =
          this.libraryIdentityDecisionIdsForGroup(sourceId);
        inheritedHistoryTargets = [targetId];
        this.raw
          .prepare(
            `INSERT OR IGNORE INTO library_issues
               (library_album_id,album_id,code,evidence_json,created_at,updated_at)
             SELECT ?,album_id,code,evidence_json,created_at,updated_at
             FROM library_issues WHERE library_album_id=? AND album_id IS NOT NULL`,
          )
          .run(targetId, sourceId);
        this.raw
          .prepare(
            `UPDATE library_album_members SET library_album_id=?,
               relationship_status='USER_CONFIRMED', updated_at=?
             WHERE library_album_id=?`,
          )
          .run(targetId, now, sourceId);
        this.raw
          .prepare(
            `UPDATE library_album_members SET relationship_status='USER_CONFIRMED', updated_at=?
             WHERE library_album_id=?`,
          )
          .run(now, targetId);
        this.raw
          .prepare(
            "UPDATE library_album_aliases SET library_album_id=? WHERE library_album_id=?",
          )
          .run(targetId, sourceId);
        this.raw.prepare("DELETE FROM library_albums WHERE id=?").run(sourceId);
        this.raw
          .prepare(
            `INSERT INTO library_album_aliases(alias_id,library_album_id,created_at)
             VALUES (?,?,?) ON CONFLICT(alias_id) DO UPDATE SET library_album_id=excluded.library_album_id`,
          )
          .run(sourceId, targetId, now);
        this.raw
          .prepare(
            `UPDATE library_albums SET decision_source='USER', primary_version_id=?,
               primary_version_source='USER', revision=revision+1, updated_at=? WHERE id=?`,
          )
          .run(command.primaryVersionId, now, targetId);
        this.raw
          .prepare(
            "DELETE FROM library_issues WHERE library_album_id=? AND code='IDENTITY_OVERLAP'",
          )
          .run(targetId);
        currentLibraryAlbumId = targetId;
      } else {
        const memberIds = this.libraryIdentityMemberIds([sourceId]);
        inheritedDecisionIds =
          this.libraryIdentityDecisionIdsForGroup(sourceId);
        const partitionIds = command.partitions.flatMap(
          (partition) => partition.versionIds,
        );
        if (
          new Set(partitionIds).size !== partitionIds.length ||
          memberIds.length !== partitionIds.length ||
          memberIds.some((id) => !partitionIds.includes(id))
        )
          throw new LibraryIdentityDecisionError(
            "INVALID_IDENTITY_DECISION",
            "拆分分区必须无重复、无遗漏地覆盖全部本地版本",
          );
        for (const partition of command.partitions)
          if (
            partition.primaryVersionId &&
            !partition.versionIds.includes(partition.primaryVersionId)
          )
            throw new LibraryIdentityDecisionError(
              "INVALID_IDENTITY_DECISION",
              "每个分区的主版本必须属于该分区",
            );
        const primaryPartitionIndex = command.partitions.findIndex(
          (partition) => partition.versionIds.includes(source.primaryVersionId),
        );
        const existingIssues = before.groups[0]?.issues ?? [];
        this.raw
          .prepare("DELETE FROM library_issues WHERE library_album_id=?")
          .run(sourceId);
        this.raw
          .prepare("DELETE FROM library_album_members WHERE library_album_id=?")
          .run(sourceId);
        const createdIds: string[] = [];
        for (const [index, partition] of command.partitions.entries()) {
          const groupId: string =
            index === primaryPartitionIndex
              ? sourceId
              : `library-${randomUUID()}`;
          const primaryVersionId =
            partition.primaryVersionId ??
            (partition.versionIds.includes(source.primaryVersionId)
              ? source.primaryVersionId
              : this.preferredPrimaryVersion(partition.versionIds));
          const primary = this.raw
            .prepare("SELECT title, album_artist FROM albums WHERE id=?")
            .get(primaryVersionId) as
            { title: string; album_artist: string } | undefined;
          if (!primary)
            throw new LibraryIdentityDecisionError(
              "IDENTITY_DECISION_CONFLICT",
              "拆分分区包含已不存在的本地版本",
            );
          if (groupId === sourceId) {
            this.raw
              .prepare(
                `UPDATE library_albums SET title=?, album_artist=?, primary_version_id=?,
                   decision_source='USER', primary_version_source=?, revision=revision+1,
                   updated_at=? WHERE id=?`,
              )
              .run(
                primary.title,
                primary.album_artist,
                primaryVersionId,
                partition.primaryVersionId ? "USER" : "AUTOMATIC",
                now,
                groupId,
              );
          } else {
            this.raw
              .prepare(
                `INSERT INTO library_albums
                   (id,identity_key,title,album_artist,primary_version_id,decision_source,
                    primary_version_source,revision,created_at,updated_at)
                 VALUES (?,?,?,?,?,'USER',?,1,?,?)`,
              )
              .run(
                groupId,
                source.identityKey,
                primary.title,
                primary.album_artist,
                primaryVersionId,
                partition.primaryVersionId ? "USER" : "AUTOMATIC",
                now,
                now,
              );
          }
          for (const versionId of partition.versionIds) {
            this.raw
              .prepare(
                `INSERT INTO library_album_members
                   (library_album_id,album_id,relationship_status,created_at,updated_at)
                 VALUES (?,?,'USER_SEPARATE',?,?)`,
              )
              .run(groupId, versionId, now, now);
            for (const issue of existingIssues.filter(
              (item) => item.albumId === versionId,
            ))
              this.raw
                .prepare(
                  `INSERT INTO library_issues
                     (library_album_id,album_id,code,evidence_json,created_at,updated_at)
                   VALUES (?,?,?,?,?,?)`,
                )
                .run(
                  groupId,
                  issue.albumId,
                  issue.code,
                  issue.evidenceJson,
                  issue.createdAt,
                  issue.updatedAt,
                );
          }
          createdIds.push(groupId);
        }
        scope = [...new Set([...scope, ...createdIds])];
        inheritedHistoryTargets = createdIds.filter((id) => id !== sourceId);
      }

      const after = this.captureLibraryIdentitySnapshot(scope);
      this.linkLibraryIdentityDecisionHistory(
        inheritedDecisionIds,
        inheritedHistoryTargets,
      );
      const result = this.recordLibraryIdentityDecision({
        requestId: command.requestId,
        inputJson,
        libraryAlbumId: currentLibraryAlbumId,
        type: command.type,
        actor,
        expectedRevision: command.revision,
        resultingRevision: this.libraryIdentityGroup(currentLibraryAlbumId)
          .revision,
        before,
        after,
        scope,
        currentLibraryAlbumId,
        details: libraryIdentityDecisionDetails(command),
        compensatesDecisionId: null,
        createdAt: now,
      });
      return result;
    })();
  }

  listLibraryIdentityDecisionHistory(
    albumId: string,
  ): LibraryIdentityDecision[] {
    const currentId = this.resolveLibraryAlbumId(albumId);
    if (!currentId) return [];
    return (
      this.raw
        .prepare(
          `SELECT d.* FROM library_identity_decisions d
           WHERE EXISTS (
             SELECT 1 FROM library_identity_decision_groups g
             WHERE g.decision_id=d.id AND g.library_album_id=?
           )
           ORDER BY d.rowid DESC LIMIT 100`,
        )
        .all(currentId) as Record<string, unknown>[]
    ).map((row) => this.mapLibraryIdentityDecision(row));
  }

  undoLibraryIdentityDecision(
    albumId: string,
    decisionId: string,
    requestId: string,
    revision: number,
    actor: LibraryIdentityActor,
  ): LibraryIdentityDecisionResult {
    return this.raw.transaction(() => {
      const inputJson = canonicalLibraryIdentityDecisionInput(albumId, {
        type: "UNDO",
        decisionId,
        requestId,
        revision,
      });
      const replay = this.identityDecisionResultByRequestId(
        requestId,
        inputJson,
      );
      if (replay) return replay;
      const currentId = this.resolveLibraryAlbumId(albumId);
      if (!currentId)
        throw new LibraryIdentityDecisionError(
          "IDENTITY_DECISION_CONFLICT",
          "唱片身份已经不存在或无法解析",
        );
      this.assertIdentityRevision(
        this.libraryIdentityGroup(currentId),
        revision,
      );
      const row = this.raw
        .prepare("SELECT * FROM library_identity_decisions WHERE id=?")
        .get(decisionId) as Record<string, unknown> | undefined;
      if (!row || row.decision_type === "UNDO")
        throw new LibraryIdentityDecisionError(
          "IDENTITY_DECISION_CONFLICT",
          "只能撤销仍有效的身份治理决定",
        );
      const scope = (
        this.raw
          .prepare(
            `SELECT library_album_id FROM library_identity_decision_groups
             WHERE decision_id=? AND association_kind='AFFECTED'
             ORDER BY library_album_id`,
          )
          .all(decisionId) as Array<{ library_album_id: string }>
      ).map((item) => item.library_album_id);
      if (!scope.includes(currentId))
        throw new LibraryIdentityDecisionError(
          "IDENTITY_DECISION_CONFLICT",
          "该决定不属于当前唱片",
        );
      if (
        this.raw
          .prepare(
            "SELECT 1 FROM library_identity_decisions WHERE compensates_decision_id=?",
          )
          .get(decisionId)
      )
        throw new LibraryIdentityDecisionError(
          "IDENTITY_DECISION_CONFLICT",
          "该决定已经撤销",
        );
      const expectedAfter = parseJson<LibraryIdentitySnapshot>(
        row.after_state_json,
        { groups: [], aliases: [] },
      );
      const beforeUndo = this.captureLibraryIdentitySnapshot(scope);
      if (!sameLibraryIdentityGovernance(beforeUndo, expectedAfter))
        throw new LibraryIdentityDecisionError(
          "IDENTITY_DECISION_CONFLICT",
          "唱片身份状态已被后续决定覆盖，不能静默撤销",
        );
      const restore = parseJson<LibraryIdentitySnapshot>(
        row.before_state_json,
        { groups: [], aliases: [] },
      );
      const now = new Date().toISOString();
      const nextRevision =
        Math.max(
          revision,
          ...beforeUndo.groups.map((group) => group.revision),
          Number(row.resulting_revision),
        ) + 1;
      this.restoreLibraryIdentitySnapshot(
        restore,
        scope,
        nextRevision,
        now,
        beforeUndo,
      );
      const restoredFallbackId =
        this.resolveLibraryAlbumId(albumId) ?? restore.groups[0]?.id ?? null;
      if (restoredFallbackId) {
        for (const historicalId of scope) {
          const exists = this.raw
            .prepare(
              `SELECT 1 FROM library_albums WHERE id=?
               UNION ALL SELECT 1 FROM library_album_aliases WHERE alias_id=? LIMIT 1`,
            )
            .get(historicalId, historicalId);
          if (!exists && historicalId !== restoredFallbackId)
            this.raw
              .prepare(
                `INSERT INTO library_album_aliases(alias_id,library_album_id,created_at)
                 VALUES (?,?,?)`,
              )
              .run(historicalId, restoredFallbackId, now);
        }
      }
      const afterUndo = this.captureLibraryIdentitySnapshot(scope);
      const restoredCurrentId = this.resolveLibraryAlbumId(albumId);
      if (!restoredCurrentId)
        throw new LibraryIdentityDecisionError(
          "IDENTITY_DECISION_CONFLICT",
          "撤销后无法恢复稳定唱片入口",
        );
      return this.recordLibraryIdentityDecision({
        requestId,
        inputJson,
        libraryAlbumId: restoredCurrentId,
        type: "UNDO",
        actor,
        expectedRevision: revision,
        resultingRevision:
          this.libraryIdentityGroup(restoredCurrentId).revision,
        before: beforeUndo,
        after: afterUndo,
        scope,
        currentLibraryAlbumId: restoredCurrentId,
        details: {
          targetLibraryAlbumId: null,
          primaryVersionId: null,
          partitions: [],
          compensatedDecisionId: decisionId,
        },
        compensatesDecisionId: decisionId,
        createdAt: now,
      });
    })();
  }

  private libraryIdentityGroup(id: string): {
    id: string;
    identityKey: string;
    primaryVersionId: string;
    revision: number;
  } {
    const row = this.raw
      .prepare(
        "SELECT id,identity_key,primary_version_id,revision FROM library_albums WHERE id=?",
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row || !row.primary_version_id)
      throw new LibraryIdentityDecisionError(
        "IDENTITY_DECISION_CONFLICT",
        "稳定唱片缺少有效主版本",
      );
    return {
      id: String(row.id),
      identityKey: String(row.identity_key),
      primaryVersionId: String(row.primary_version_id),
      revision: Number(row.revision),
    };
  }

  private assertIdentityRevision(
    group: { revision: number },
    expectedRevision: number,
  ): void {
    if (group.revision !== expectedRevision)
      throw new LibraryIdentityDecisionError(
        "IDENTITY_DECISION_CONFLICT",
        "唱片身份已被其他操作更新，请刷新后重试",
      );
  }

  private assertVersionMember(groupId: string, versionId: string): void {
    if (
      !this.raw
        .prepare(
          "SELECT 1 FROM library_album_members WHERE library_album_id=? AND album_id=?",
        )
        .get(groupId, versionId)
    )
      throw new LibraryIdentityDecisionError(
        "IDENTITY_DECISION_CONFLICT",
        "主版本必须属于当前唱片",
      );
  }

  private libraryIdentityMemberIds(groupIds: string[]): string[] {
    if (!groupIds.length) return [];
    const placeholders = groupIds.map(() => "?").join(",");
    return (
      this.raw
        .prepare(
          `SELECT album_id FROM library_album_members
           WHERE library_album_id IN (${placeholders}) ORDER BY album_id`,
        )
        .all(...groupIds) as Array<{ album_id: string }>
    ).map((row) => row.album_id);
  }

  private libraryIdentityDecisionIdsForGroup(groupId: string): string[] {
    return (
      this.raw
        .prepare(
          `SELECT decision_id FROM library_identity_decision_groups
           WHERE library_album_id=? ORDER BY rowid`,
        )
        .all(groupId) as Array<{ decision_id: string }>
    ).map((row) => row.decision_id);
  }

  private linkLibraryIdentityDecisionHistory(
    decisionIds: string[],
    groupIds: string[],
  ): void {
    const insert = this.raw.prepare(
      `INSERT OR IGNORE INTO library_identity_decision_groups
       (decision_id,library_album_id,association_kind) VALUES (?,?,'HISTORY')`,
    );
    for (const decisionId of decisionIds)
      for (const groupId of groupIds) insert.run(decisionId, groupId);
  }

  private preferredPrimaryVersion(versionIds: string[]): string {
    const placeholders = versionIds.map(() => "?").join(",");
    const rows = this.raw
      .prepare(
        `SELECT a.*,
          (SELECT MIN(mf.relative_path) FROM album_files af
           JOIN media_files mf ON mf.id=af.media_file_id WHERE af.album_id=a.id) AS stable_path
         FROM albums a WHERE a.id IN (${placeholders})`,
      )
      .all(...versionIds) as Record<string, unknown>[];
    if (rows.length !== versionIds.length)
      throw new LibraryIdentityDecisionError(
        "IDENTITY_DECISION_CONFLICT",
        "本地版本已变化，请刷新后重试",
      );
    return String([...rows].sort(comparePrimaryVersions)[0]!.id);
  }

  private captureLibraryIdentitySnapshot(
    scope: string[],
  ): LibraryIdentitySnapshot {
    if (!scope.length) return { groups: [], aliases: [] };
    const placeholders = scope.map(() => "?").join(",");
    const groupRows = this.raw
      .prepare(
        `SELECT DISTINCT la.* FROM library_albums la
         LEFT JOIN library_album_aliases alias ON alias.library_album_id=la.id
         WHERE la.id IN (${placeholders}) OR alias.alias_id IN (${placeholders})
         ORDER BY la.id`,
      )
      .all(...scope, ...scope) as Record<string, unknown>[];
    const groupIds = groupRows.map((row) => String(row.id));
    const groups = groupRows.map((row) => {
      const members = (
        this.raw
          .prepare(
            `SELECT * FROM library_album_members WHERE library_album_id=?
             ORDER BY album_id`,
          )
          .all(String(row.id)) as Record<string, unknown>[]
      ).map((member) => ({
        albumId: String(member.album_id),
        relationshipStatus: member.relationship_status as
          "AUTO_CANDIDATE" | "USER_CONFIRMED" | "USER_SEPARATE",
        createdAt: String(member.created_at),
        updatedAt: String(member.updated_at),
      }));
      const issues = (
        this.raw
          .prepare(
            `SELECT * FROM library_issues WHERE library_album_id=?
             ORDER BY code, album_id`,
          )
          .all(String(row.id)) as Record<string, unknown>[]
      ).map((issue) => ({
        albumId: nullableString(issue.album_id),
        code: issue.code as LibraryIssueCode,
        evidenceJson: String(issue.evidence_json),
        createdAt: String(issue.created_at),
        updatedAt: String(issue.updated_at),
      }));
      return {
        id: String(row.id),
        identityKey: String(row.identity_key),
        title: String(row.title),
        albumArtist: String(row.album_artist),
        primaryVersionId: String(row.primary_version_id),
        decisionSource: row.decision_source as "AUTOMATIC" | "USER",
        primaryVersionSource: row.primary_version_source as
          "AUTOMATIC" | "USER",
        revision: Number(row.revision),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        members,
        issues,
      };
    });
    const aliasScope = [...new Set([...scope, ...groupIds])];
    const aliasPlaceholders = aliasScope.map(() => "?").join(",");
    const aliases = (
      this.raw
        .prepare(
          `SELECT * FROM library_album_aliases
           WHERE alias_id IN (${aliasPlaceholders})
              OR library_album_id IN (${aliasPlaceholders})
           ORDER BY alias_id`,
        )
        .all(...aliasScope, ...aliasScope) as Record<string, unknown>[]
    ).map((alias) => ({
      aliasId: String(alias.alias_id),
      libraryAlbumId: String(alias.library_album_id),
      createdAt: String(alias.created_at),
    }));
    return { groups, aliases };
  }

  private restoreLibraryIdentitySnapshot(
    snapshot: LibraryIdentitySnapshot,
    scope: string[],
    revision: number,
    now: string,
    currentFacts: LibraryIdentitySnapshot,
  ): void {
    const current = this.captureLibraryIdentitySnapshot(scope);
    const groupIds = current.groups.map((group) => group.id);
    if (groupIds.length) {
      const placeholders = groupIds.map(() => "?").join(",");
      this.raw
        .prepare(
          `DELETE FROM library_album_aliases WHERE library_album_id IN (${placeholders})`,
        )
        .run(...groupIds);
      this.raw
        .prepare(`DELETE FROM library_albums WHERE id IN (${placeholders})`)
        .run(...groupIds);
    }
    if (scope.length) {
      const placeholders = scope.map(() => "?").join(",");
      this.raw
        .prepare(
          `DELETE FROM library_album_aliases WHERE alias_id IN (${placeholders})`,
        )
        .run(...scope);
    }
    for (const group of snapshot.groups) {
      const currentGroup = current.groups.find(
        (candidate) => candidate.id === group.id,
      );
      this.raw
        .prepare(
          `INSERT INTO library_albums
             (id,identity_key,title,album_artist,primary_version_id,decision_source,
              primary_version_source,revision,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          group.id,
          currentGroup?.identityKey ?? group.identityKey,
          currentGroup?.title ?? group.title,
          currentGroup?.albumArtist ?? group.albumArtist,
          group.primaryVersionId,
          group.decisionSource,
          group.primaryVersionSource,
          revision,
          currentGroup?.createdAt ?? group.createdAt,
          now,
        );
      for (const member of group.members)
        this.raw
          .prepare(
            `INSERT INTO library_album_members
               (library_album_id,album_id,relationship_status,created_at,updated_at)
             VALUES (?,?,?,?,?)`,
          )
          .run(
            group.id,
            member.albumId,
            member.relationshipStatus,
            member.createdAt,
            now,
          );
      const currentVersionIssues = currentFacts.groups.flatMap((currentGroup) =>
        currentGroup.issues.filter((issue) => issue.albumId !== null),
      );
      for (const issue of currentVersionIssues.filter(
        (issue) =>
          issue.albumId !== null &&
          group.members.some((member) => member.albumId === issue.albumId),
      ))
        this.raw
          .prepare(
            `INSERT INTO library_issues
               (library_album_id,album_id,code,evidence_json,created_at,updated_at)
             VALUES (?,?,?,?,?,?)`,
          )
          .run(
            group.id,
            issue.albumId,
            issue.code,
            issue.evidenceJson,
            issue.createdAt,
            issue.updatedAt,
          );
      const currentGroupIssues =
        currentFacts.groups
          .find((currentGroup) => currentGroup.id === group.id)
          ?.issues.filter(
            (issue) =>
              issue.albumId === null && issue.code !== "IDENTITY_OVERLAP",
          ) ?? [];
      for (const issue of currentGroupIssues)
        this.raw
          .prepare(
            `INSERT INTO library_issues
               (library_album_id,album_id,code,evidence_json,created_at,updated_at)
             VALUES (?,NULL,?,?,?,?)`,
          )
          .run(
            group.id,
            issue.code,
            issue.evidenceJson,
            issue.createdAt,
            issue.updatedAt,
          );
      if (
        group.members.length > 1 &&
        group.members.some(
          (member) => member.relationshipStatus === "AUTO_CANDIDATE",
        )
      ) {
        const currentOverlap = currentFacts.groups
          .find((currentGroup) => currentGroup.id === group.id)
          ?.issues.find(
            (issue) =>
              issue.albumId === null && issue.code === "IDENTITY_OVERLAP",
          );
        this.raw
          .prepare(
            `INSERT INTO library_issues
               (library_album_id,album_id,code,evidence_json,created_at,updated_at)
             VALUES (?,NULL,'IDENTITY_OVERLAP',?,?,?)`,
          )
          .run(
            group.id,
            currentOverlap?.evidenceJson ??
              JSON.stringify({
                versionCount: group.members.length,
                basis: "NORMALIZED_TITLE_ARTIST",
              }),
            currentOverlap?.createdAt ?? now,
            currentOverlap?.updatedAt ?? now,
          );
      }
    }
    for (const alias of snapshot.aliases)
      this.raw
        .prepare(
          `INSERT INTO library_album_aliases(alias_id,library_album_id,created_at)
           VALUES (?,?,?)`,
        )
        .run(alias.aliasId, alias.libraryAlbumId, alias.createdAt);
  }

  private recordLibraryIdentityDecision(input: {
    requestId: string;
    inputJson: string;
    libraryAlbumId: string;
    type: LibraryIdentityDecision["type"];
    actor: LibraryIdentityActor;
    expectedRevision: number;
    resultingRevision: number;
    before: LibraryIdentitySnapshot;
    after: LibraryIdentitySnapshot;
    scope: string[];
    currentLibraryAlbumId: string;
    details: LibraryIdentityDecision["details"];
    compensatesDecisionId: string | null;
    createdAt: string;
  }): LibraryIdentityDecisionResult {
    const id = randomUUID();
    const scope = [
      ...new Set([
        ...input.scope,
        ...input.before.groups.map((group) => group.id),
        ...input.after.groups.map((group) => group.id),
      ]),
    ].sort();
    const affectedLibraryAlbumIds = scope;
    this.raw
      .prepare(
        `INSERT INTO library_identity_decisions
           (id,request_id,library_album_id,decision_type,actor_id,actor_display_name,
            expected_revision,resulting_revision,input_json,before_state_json,
            details_json,after_state_json,result_json,compensates_decision_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.requestId,
        input.libraryAlbumId,
        input.type,
        input.actor.id,
        input.actor.displayName,
        input.expectedRevision,
        input.resultingRevision,
        input.inputJson,
        JSON.stringify(input.before),
        JSON.stringify(input.details),
        JSON.stringify(input.after),
        JSON.stringify({
          currentLibraryAlbumId: input.currentLibraryAlbumId,
          affectedLibraryAlbumIds,
        }),
        input.compensatesDecisionId,
        input.createdAt,
      );
    for (const groupId of scope)
      this.raw
        .prepare(
          `INSERT INTO library_identity_decision_groups(decision_id,library_album_id)
           VALUES (?,?)`,
        )
        .run(id, groupId);
    return this.identityDecisionResultByRequestId(
      input.requestId,
      input.inputJson,
    )!;
  }

  private identityDecisionResultByRequestId(
    requestId: string,
    inputJson: string,
  ): LibraryIdentityDecisionResult | null {
    const row = this.raw
      .prepare("SELECT * FROM library_identity_decisions WHERE request_id=?")
      .get(requestId) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (String(row.input_json) !== inputJson)
      throw new LibraryIdentityDecisionError(
        "IDENTITY_DECISION_CONFLICT",
        "requestId 已用于不同的身份治理请求",
      );
    const stored = parseJson<{
      currentLibraryAlbumId: string;
      affectedLibraryAlbumIds: string[];
    }>(row.result_json, {
      currentLibraryAlbumId: String(row.library_album_id),
      affectedLibraryAlbumIds: [String(row.library_album_id)],
    });
    return {
      decision: this.mapLibraryIdentityDecision(row),
      currentLibraryAlbumId: stored.currentLibraryAlbumId,
      affectedLibraryAlbumIds: stored.affectedLibraryAlbumIds,
    };
  }

  private mapLibraryIdentityDecision(
    row: Record<string, unknown>,
  ): LibraryIdentityDecision {
    const affectedLibraryAlbumIds = (
      this.raw
        .prepare(
          `SELECT library_album_id FROM library_identity_decision_groups
           WHERE decision_id=? AND association_kind='AFFECTED'
           ORDER BY library_album_id`,
        )
        .all(String(row.id)) as Array<{ library_album_id: string }>
    ).map((item) => item.library_album_id);
    const compensated = Boolean(
      this.raw
        .prepare(
          "SELECT 1 FROM library_identity_decisions WHERE compensates_decision_id=?",
        )
        .get(String(row.id)),
    );
    let canUndo = false;
    if (!compensated && row.decision_type !== "UNDO") {
      const expected = parseJson<LibraryIdentitySnapshot>(
        row.after_state_json,
        { groups: [], aliases: [] },
      );
      canUndo = sameLibraryIdentityGovernance(
        this.captureLibraryIdentitySnapshot(affectedLibraryAlbumIds),
        expected,
      );
    }
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      libraryAlbumId: String(row.library_album_id),
      type: row.decision_type as LibraryIdentityDecision["type"],
      actor: {
        id: String(row.actor_id),
        displayName: String(row.actor_display_name),
      },
      expectedRevision: Number(row.expected_revision),
      resultingRevision: Number(row.resulting_revision),
      details: parseJson<LibraryIdentityDecision["details"]>(row.details_json, {
        targetLibraryAlbumId: null,
        primaryVersionId: null,
        partitions: [],
        compensatedDecisionId: nullableString(row.compensates_decision_id),
      }),
      affectedLibraryAlbumIds,
      compensatesDecisionId: nullableString(row.compensates_decision_id),
      canUndo,
      createdAt: String(row.created_at),
    };
  }

  listAlbums(
    options: {
      search?: string;
      filter?: "ALL" | "DIGITAL" | PhysicalMedium;
      issue?: LibraryIssueCode | "ALL";
      sort?: "ARTIST" | "TITLE" | "YEAR_DESC";
      limit?: number;
      offset?: number;
    } = {},
  ): AlbumSummary[] {
    const search = options.search?.trim();
    const filter = options.filter ?? "ALL";
    const sort = options.sort ?? "ARTIST";
    const issue = options.issue ?? "ALL";
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const conditions: string[] = [];
    const parameters: Record<string, string | number> = { limit, offset };
    if (search) {
      conditions.push(
        "(a.title LIKE @query ESCAPE '\\' OR a.album_artist LIKE @query ESCAPE '\\')",
      );
      parameters.query = `%${escapeLike(search)}%`;
    }
    if (filter === "DIGITAL") {
      conditions.push(
        "EXISTS (SELECT 1 FROM library_album_members lm JOIN album_files af ON af.album_id=lm.album_id WHERE lm.library_album_id=la.id)",
      );
    } else if (filter !== "ALL") {
      conditions.push(
        "EXISTS (SELECT 1 FROM library_album_members lm JOIN physical_copies pc ON pc.album_id=lm.album_id WHERE lm.library_album_id=la.id AND pc.medium = @medium)",
      );
      parameters.medium = filter;
    }
    if (issue !== "ALL") {
      conditions.push(
        "EXISTS (SELECT 1 FROM library_issues li WHERE li.library_album_id=la.id AND li.code=@issue)",
      );
      parameters.issue = issue;
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order =
      sort === "TITLE"
        ? "a.title COLLATE NOCASE, a.album_artist COLLATE NOCASE, a.year"
        : sort === "YEAR_DESC"
          ? "a.year IS NULL, a.year DESC, a.title COLLATE NOCASE, a.album_artist COLLATE NOCASE"
          : "a.album_artist COLLATE NOCASE, a.year, a.title COLLATE NOCASE";
    const rows = this.raw
      .prepare(
        `SELECT a.*, la.id AS library_album_id, la.primary_version_id,
                la.primary_version_source, la.revision,
                (SELECT COUNT(*) FROM library_album_members WHERE library_album_id=la.id) AS version_count
         FROM library_albums la JOIN albums a ON a.id=la.primary_version_id
         ${where} ORDER BY ${order}, la.id LIMIT @limit OFFSET @offset`,
      )
      .all(parameters);
    return rows.map((row) =>
      this.mapLibraryAlbumSummary(row as Record<string, unknown>),
    );
  }

  countAlbums(
    options: {
      search?: string;
      filter?: "ALL" | "DIGITAL" | PhysicalMedium;
      issue?: LibraryIssueCode | "ALL";
    } = {},
  ): number {
    const search = options.search?.trim();
    const filter = options.filter ?? "ALL";
    const issue = options.issue ?? "ALL";
    const conditions: string[] = [];
    const parameters: Record<string, string> = {};
    if (search) {
      conditions.push(
        "(a.title LIKE @query ESCAPE '\\' OR a.album_artist LIKE @query ESCAPE '\\')",
      );
      parameters.query = `%${escapeLike(search)}%`;
    }
    if (filter === "DIGITAL") {
      conditions.push(
        "EXISTS (SELECT 1 FROM library_album_members lm JOIN album_files af ON af.album_id=lm.album_id WHERE lm.library_album_id=la.id)",
      );
    } else if (filter !== "ALL") {
      conditions.push(
        "EXISTS (SELECT 1 FROM library_album_members lm JOIN physical_copies pc ON pc.album_id=lm.album_id WHERE lm.library_album_id=la.id AND pc.medium = @medium)",
      );
      parameters.medium = filter;
    }
    if (issue !== "ALL") {
      conditions.push(
        "EXISTS (SELECT 1 FROM library_issues li WHERE li.library_album_id=la.id AND li.code=@issue)",
      );
      parameters.issue = issue;
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.raw
      .prepare(
        `SELECT COUNT(*) AS count FROM library_albums la JOIN albums a ON a.id=la.primary_version_id ${where}`,
      )
      .get(parameters);
    return Number((row as { count: number }).count);
  }

  getAlbumSummary(id: string): AlbumSummary | null {
    const row = this.raw
      .prepare(
        `SELECT a.*, la.id AS library_album_id, la.primary_version_id,
        la.primary_version_source, la.revision,
        (SELECT COUNT(*) FROM library_album_members WHERE library_album_id=la.id) AS version_count
        FROM library_albums la JOIN albums a ON a.id=la.primary_version_id
        WHERE la.id=COALESCE(
          (SELECT library_album_id FROM library_album_aliases WHERE alias_id=?), ?
        ) OR EXISTS (
          SELECT 1 FROM library_album_members lm
          WHERE lm.library_album_id=la.id AND lm.album_id=?
        )`,
      )
      .get(id, id, id) as Record<string, unknown> | undefined;
    return row ? this.mapLibraryAlbumSummary(row) : null;
  }

  resolveLibraryAlbumId(id: string): string | null {
    const row = this.raw
      .prepare(
        `SELECT la.id FROM library_albums la
         WHERE la.id=COALESCE(
           (SELECT library_album_id FROM library_album_aliases WHERE alias_id=?), ?
         ) OR EXISTS (
           SELECT 1 FROM library_album_members lm
           WHERE lm.library_album_id=la.id AND lm.album_id=?
         )
         LIMIT 1`,
      )
      .get(id, id, id) as { id: string } | undefined;
    return row?.id ?? null;
  }

  resolveLocalVersionId(id: string): string | null {
    const row = this.raw
      .prepare(
        `SELECT library_albums.primary_version_id
         FROM library_albums
         WHERE library_albums.id=COALESCE(
           (SELECT library_album_id FROM library_album_aliases WHERE alias_id=?), ?
         ) OR EXISTS (
           SELECT 1 FROM library_album_members
           WHERE library_album_members.library_album_id=library_albums.id
             AND library_album_members.album_id=?
         )
         LIMIT 1`,
      )
      .get(id, id, id) as { primary_version_id: string | null } | undefined;
    if (row?.primary_version_id) return row.primary_version_id;
    return this.raw.prepare("SELECT id FROM albums WHERE id=?").get(id)
      ? id
      : null;
  }

  private listLibraryPhysicalCopies(libraryAlbumId: string): PhysicalCopy[] {
    return this.raw
      .prepare(
        `SELECT pc.* FROM physical_copies pc
        JOIN library_album_members lm ON lm.album_id=pc.album_id
        WHERE lm.library_album_id=? ORDER BY pc.created_at, pc.id`,
      )
      .all(libraryAlbumId)
      .map((row) => ({
        ...mapPhysicalCopy(row as Record<string, unknown>),
        albumId: libraryAlbumId,
      }));
  }

  private listLocalVersions(libraryAlbumId: string) {
    const rows = this.raw
      .prepare(
        `SELECT a.*, lm.relationship_status,
      la.primary_version_id, lr.name AS root_name, lr.container_path, lr.policy, lr.system,
      (SELECT MIN(mf.relative_path) FROM album_files af JOIN media_files mf ON mf.id=af.media_file_id WHERE af.album_id=a.id) AS relative_path,
      (SELECT COUNT(*) FROM album_files af WHERE af.album_id=a.id) AS file_count,
      COALESCE((SELECT SUM(mf.size_bytes) FROM album_files af JOIN media_files mf ON mf.id=af.media_file_id WHERE af.album_id=a.id),0) AS size_bytes
      FROM library_album_members lm
      JOIN library_albums la ON la.id=lm.library_album_id
      JOIN albums a ON a.id=lm.album_id
      JOIN library_roots lr ON lr.id=a.root_id
      WHERE lm.library_album_id=? ORDER BY a.id`,
      )
      .all(libraryAlbumId) as Record<string, unknown>[];
    return rows.map((row) => {
      const issues = this.listLibraryIssues(libraryAlbumId, String(row.id));
      return {
        id: String(row.id),
        title: String(row.title),
        albumArtist: String(row.album_artist),
        year: nullableNumber(row.year),
        isPrimary: row.primary_version_id === row.id,
        relationshipStatus: row.relationship_status as
          "AUTO_CANDIDATE" | "USER_CONFIRMED" | "USER_SEPARATE",
        sourceRoot: Boolean(row.system)
          ? null
          : {
              id: String(row.root_id),
              name: String(row.root_name),
              containerPath: String(row.container_path),
              readOnly: row.policy === "WATCH_ONLY",
            },
        relativePath: nullableString(row.relative_path),
        audioBadge: nullableString(row.audio_badge),
        mixedAudioSpecs: Boolean(row.mixed_audio_specs),
        trackCount: Number(row.track_count),
        fileCount: Number(row.file_count),
        sourceVersionCount: Number(row.source_version_count ?? 1),
        duplicateFileCount: Number(row.duplicate_file_count ?? 0),
        sizeBytes: Number(row.size_bytes),
        completeness: issues.some((issue) => issue.code === "INCOMPLETE_TRACKS")
          ? ("INCOMPLETE" as const)
          : ("COMPLETE" as const),
        issues,
      };
    });
  }

  private listLibraryIssues(
    libraryAlbumId: string,
    albumId?: string,
  ): LibraryIssue[] {
    const rows = albumId
      ? this.raw
          .prepare(
            "SELECT * FROM library_issues WHERE library_album_id=? AND album_id=? ORDER BY code, album_id",
          )
          .all(libraryAlbumId, albumId)
      : this.raw
          .prepare(
            "SELECT * FROM library_issues WHERE library_album_id=? ORDER BY code, album_id",
          )
          .all(libraryAlbumId);
    return (rows as Record<string, unknown>[]).map((row) => ({
      code: row.code as LibraryIssueCode,
      versionId: nullableString(row.album_id),
      evidence: parseJson<Record<string, unknown>>(row.evidence_json, {}),
    }));
  }

  findAlbumSummaryByIdentity(
    title: string,
    albumArtist: string,
  ): AlbumSummary | null {
    const row = this.raw
      .prepare(
        `SELECT albums.* FROM albums
         WHERE title = ? COLLATE NOCASE AND album_artist = ? COLLATE NOCASE
         ORDER BY EXISTS(
           SELECT 1 FROM album_files WHERE album_files.album_id = albums.id
         ) DESC, albums.updated_at DESC, albums.id
         LIMIT 1`,
      )
      .get(title, albumArtist) as Record<string, unknown> | undefined;
    return row ? this.getAlbumSummary(String(row.id)) : null;
  }

  getAlbum(id: string): AlbumDetail | null {
    const librarySummary = this.getAlbumSummary(id);
    if (!librarySummary) return null;
    const localId = librarySummary.primaryVersionId ?? id;
    const row = this.raw
      .prepare("SELECT * FROM albums WHERE id = ?")
      .get(localId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const summary = librarySummary;
    const root = this.getAnyLibraryRoot(String(row.root_id));
    if (!root)
      throw new Error(`Library root ${String(row.root_id)} is missing`);
    const tracks = this.raw
      .prepare(
        `SELECT media_files.*, album_files.disc_number_override FROM media_files
         JOIN album_files ON album_files.media_file_id = media_files.id
         WHERE album_files.album_id = ? AND album_files.is_primary = 1
         ORDER BY COALESCE(album_files.disc_number_override, media_files.disc_number, 1),
                  COALESCE(media_files.track_number, 9999), media_files.relative_path`,
      )
      .all(localId)
      .map((track) => {
        const t = track as Record<string, unknown>;
        const artists = parseJson<string[]>(t.artists_json, []);
        return {
          id: String(t.id),
          title:
            nullableString(t.title) ??
            basenameWithoutExtension(String(t.relative_path)),
          artist: artists[0] ?? nullableString(t.album_artist) ?? "未知艺术家",
          discNumber:
            nullableNumber(t.disc_number_override) ??
            nullableNumber(t.disc_number),
          trackNumber: nullableNumber(t.track_number),
          durationSeconds: nullableNumber(t.duration_seconds),
          sizeBytes: Number(t.size_bytes),
          audioSpec: mapAudioSpec(t),
          relativePath: String(t.relative_path),
          warningCodes: [
            ...new Set(
              parseJson<Array<{ code: string }>>(t.warnings_json, []).map(
                (warning) => warning.code,
              ),
            ),
          ],
        };
      });
    return {
      ...summary,
      release: {
        label: nullableString(row.label),
        catalogNumber: nullableString(row.catalog_number),
        barcode: nullableString(row.barcode),
        country: nullableString(row.country),
        releaseDate: nullableString(row.release_date),
        musicBrainzReleaseId: nullableString(row.musicbrainz_release_id),
      },
      tracks,
      physicalCopies: this.listLibraryPhysicalCopies(summary.id),
      sourceRoot: root.system
        ? null
        : {
            id: root.id,
            name: root.name,
            containerPath: root.containerPath,
            readOnly: root.policy === "WATCH_ONLY",
          },
      localVersions: this.listLocalVersions(summary.id),
    };
  }

  listPhysicalCopies(albumId: string): PhysicalCopy[] {
    const summary = this.getAlbumSummary(albumId);
    return summary ? this.listLibraryPhysicalCopies(summary.id) : [];
  }

  createPhysicalCopy(copy: PhysicalCopy): void {
    const localVersionId = this.resolveLocalVersionId(copy.albumId);
    if (!localVersionId)
      throw new Error(`Album ${copy.albumId} does not exist`);
    this.raw
      .prepare(
        `INSERT INTO physical_copies (
          id, album_id, medium, label, catalog_number, barcode, country, release_year,
          quantity, condition_note, storage_location, created_at, updated_at
        ) VALUES (
          @id, @albumId, @medium, @label, @catalogNumber, @barcode, @country, @releaseYear,
          @quantity, @conditionNote, @storageLocation, @createdAt, @updatedAt
        )`,
      )
      .run({ ...copy, albumId: localVersionId });
  }

  findPhysicalOnlyAlbum(groupKey: string): AlbumDetail | null {
    const row = this.raw
      .prepare(
        "SELECT id FROM albums WHERE root_id = 'physical' AND group_key = ?",
      )
      .get(groupKey) as { id: string } | undefined;
    return row ? this.getAlbum(row.id) : null;
  }

  createPhysicalOnlyAlbum(input: {
    id: string;
    groupKey: string;
    title: string;
    albumArtist: string;
    year: number | null;
  }): AlbumDetail {
    const now = new Date().toISOString();
    this.raw
      .prepare(
        `INSERT INTO albums (
          id, root_id, group_key, title, album_artist, year, disc_count, track_count,
          audio_summary_json, audio_badge, mixed_audio_specs, artwork_json, match_status,
          created_at, updated_at
        ) VALUES (?, 'physical', ?, ?, ?, ?, 1, 0, NULL, NULL, 0, ?, 'UNMATCHED', ?, ?)`,
      )
      .run(
        input.id,
        input.groupKey,
        input.title,
        input.albumArtist,
        input.year,
        JSON.stringify({
          source: "NONE",
          url: null,
          mimeType: null,
          width: null,
          height: null,
        }),
        now,
        now,
      );
    this.rebuildAutomaticLibraryAlbums();
    const album = this.getAlbum(input.id);
    if (!album) throw new Error("Physical collection album was not created");
    return album;
  }

  deletePhysicalCopy(albumId: string, copyId: string): boolean {
    const summary = this.getAlbumSummary(albumId);
    if (!summary) return false;
    return (
      this.raw
        .prepare(
          `DELETE FROM physical_copies
           WHERE id=? AND album_id IN (
             SELECT album_id FROM library_album_members
             WHERE library_album_id=?
           )`,
        )
        .run(copyId, summary.id).changes === 1
    );
  }

  replaceReleaseCandidates(
    albumId: string,
    candidates: ReleaseCandidate[],
  ): void {
    const localVersionId = this.resolveLocalVersionId(albumId);
    if (!localVersionId) throw new Error(`Album ${albumId} does not exist`);
    if (
      candidates.some(
        (candidate) =>
          candidate.albumId !== albumId && candidate.albumId !== localVersionId,
      )
    ) {
      throw new Error(
        "Release candidate album does not match the requested album",
      );
    }
    const album = this.raw
      .prepare("SELECT match_status FROM albums WHERE id = ?")
      .get(localVersionId) as { match_status: string } | undefined;
    if (!album) throw new Error(`Album ${localVersionId} does not exist`);
    const now = new Date().toISOString();
    const insert = this.raw.prepare(
      `INSERT INTO release_match_candidates
        (id, album_id, source, source_id, payload_json, fetched_at, created_at)
       VALUES (@id, @albumId, @source, @sourceId, @payloadJson, @fetchedAt, @createdAt)`,
    );
    this.raw.transaction(() => {
      this.raw
        .prepare(
          "DELETE FROM release_match_candidates WHERE album_id = ? AND source = 'MUSICBRAINZ'",
        )
        .run(localVersionId);
      for (const candidate of candidates) {
        const validated = releaseCandidateSchema.parse({
          ...candidate,
          albumId: localVersionId,
        });
        insert.run({
          id: validated.id,
          albumId: localVersionId,
          source: validated.source,
          sourceId: validated.sourceId,
          payloadJson: JSON.stringify(validated),
          fetchedAt: validated.fetchedAt,
          createdAt: now,
        });
      }
      if (album.match_status === "UNMATCHED" && candidates.length > 0) {
        this.raw
          .prepare(
            "UPDATE albums SET match_status='NEEDS_REVIEW', updated_at=? WHERE id=?",
          )
          .run(now, localVersionId);
      }
    })();
  }

  listReleaseCandidates(albumId: string): ReleaseCandidate[] {
    const localVersionId = this.resolveLocalVersionId(albumId);
    if (!localVersionId) return [];
    return this.raw
      .prepare(
        "SELECT payload_json FROM release_match_candidates WHERE album_id = ? ORDER BY fetched_at DESC, id",
      )
      .all(localVersionId)
      .map((row) =>
        releaseCandidateSchema.parse(
          JSON.parse(String((row as { payload_json: string }).payload_json)),
        ),
      );
  }

  confirmReleaseCandidate(
    albumId: string,
    candidateId: string,
  ): ReleaseCandidate | null {
    const localVersionId = this.resolveLocalVersionId(albumId);
    if (!localVersionId) return null;
    const row = this.raw
      .prepare(
        "SELECT payload_json FROM release_match_candidates WHERE id = ? AND album_id = ?",
      )
      .get(candidateId, localVersionId) as { payload_json: string } | undefined;
    if (!row) return null;
    const candidate = releaseCandidateSchema.parse(
      JSON.parse(row.payload_json),
    );
    const now = new Date().toISOString();
    this.raw
      .prepare(
        `UPDATE albums SET
          match_status='USER_CONFIRMED',
          label=COALESCE(@label, label),
          catalog_number=COALESCE(@catalogNumber, catalog_number),
          barcode=COALESCE(@barcode, barcode),
          country=COALESCE(@country, country),
          release_date=COALESCE(@releaseDate, release_date),
          musicbrainz_release_id=@musicBrainzReleaseId,
          updated_at=@updatedAt
         WHERE id=@albumId`,
      )
      .run({
        albumId: localVersionId,
        label: candidate.labels[0] ?? null,
        catalogNumber: candidate.catalogNumbers[0] ?? null,
        barcode: candidate.barcode,
        country: candidate.country,
        releaseDate: candidate.releaseDate,
        musicBrainzReleaseId: candidate.sourceId,
        updatedAt: now,
      });
    return candidate;
  }

  installStillCatalog(input: StillRuntimeCatalog): void {
    const catalog = stillRuntimeCatalogSchema.parse(input);
    const existing = this.raw
      .prepare(
        "SELECT runtime_checksum FROM still_catalog_versions WHERE content_version = ?",
      )
      .get(catalog.source.contentVersion) as
      { runtime_checksum: string } | undefined;
    if (existing && existing.runtime_checksum !== catalog.runtimeChecksum) {
      throw new Error(
        `Still catalog version ${catalog.source.contentVersion} already exists with different content`,
      );
    }
    const now = new Date().toISOString();
    const insertAlbum = this.raw.prepare(
      `INSERT INTO still_catalog_albums (
        content_version, still_album_id, title, artist, recording_family_id, release_family_id,
        domains_json, features_json, source_kind, source_ref, verified_at
      ) VALUES (
        @contentVersion, @id, @title, @artist, @recordingFamilyId, @releaseFamilyId,
        @domainsJson, @featuresJson, @sourceKind, @sourceRef, @verifiedAt
      )`,
    );
    this.raw.transaction(() => {
      if (!existing) {
        this.raw
          .prepare(
            `INSERT INTO still_catalog_versions (
              content_version, source_schema_id, source_schema_version, source_content_checksum,
              runtime_checksum, record_count, rejected_record_count, installed_at, active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          )
          .run(
            catalog.source.contentVersion,
            catalog.source.schemaId,
            catalog.source.schemaVersion,
            catalog.source.contentChecksum,
            catalog.runtimeChecksum,
            catalog.recordCount,
            catalog.rejectedRecordCount,
            now,
          );
        for (const album of catalog.records) {
          insertAlbum.run({
            ...album,
            domainsJson: JSON.stringify(album.domains),
            featuresJson: JSON.stringify(album.features),
          });
        }
      }
      this.raw
        .prepare(
          "UPDATE still_catalog_versions SET active = 0 WHERE active = 1",
        )
        .run();
      this.raw
        .prepare(
          "UPDATE still_catalog_versions SET active = 1 WHERE content_version = ?",
        )
        .run(catalog.source.contentVersion);
    })();
  }

  activateStillCatalogVersion(contentVersion: string): boolean {
    return this.raw.transaction(() => {
      const exists = this.raw
        .prepare(
          "SELECT 1 FROM still_catalog_versions WHERE content_version = ?",
        )
        .get(contentVersion);
      if (!exists) return false;
      this.raw
        .prepare(
          "UPDATE still_catalog_versions SET active = 0 WHERE active = 1",
        )
        .run();
      this.raw
        .prepare(
          "UPDATE still_catalog_versions SET active = 1 WHERE content_version = ?",
        )
        .run(contentVersion);
      return true;
    })();
  }

  getStillCatalogStatus(): {
    activeContentVersion: string | null;
    sourceSchemaId: string | null;
    sourceSchemaVersion: string | null;
    recordCount: number;
    runtimeChecksum: string | null;
    installedAt: string | null;
  } {
    const row = this.raw
      .prepare("SELECT * FROM still_catalog_versions WHERE active = 1")
      .get() as Record<string, unknown> | undefined;
    return row
      ? {
          activeContentVersion: String(row.content_version),
          sourceSchemaId: String(row.source_schema_id),
          sourceSchemaVersion: String(row.source_schema_version),
          recordCount: Number(row.record_count),
          runtimeChecksum: String(row.runtime_checksum),
          installedAt: String(row.installed_at),
        }
      : {
          activeContentVersion: null,
          sourceSchemaId: null,
          sourceSchemaVersion: null,
          recordCount: 0,
          runtimeChecksum: null,
          installedAt: null,
        };
  }

  listActiveStillCatalogAlbums(): StillCatalogAlbum[] {
    return this.raw
      .prepare(
        `SELECT albums.*, versions.content_version
         FROM still_catalog_albums AS albums
         JOIN still_catalog_versions AS versions ON versions.content_version = albums.content_version
         WHERE versions.active = 1
         ORDER BY albums.still_album_id`,
      )
      .all()
      .map((row) => {
        const value = row as Record<string, unknown>;
        return {
          id: String(value.still_album_id),
          title: String(value.title),
          artist: String(value.artist),
          recordingFamilyId: nullableString(value.recording_family_id),
          releaseFamilyId: nullableString(value.release_family_id),
          domains: parseJson(value.domains_json, []),
          features: parseJson(value.features_json, []),
          sourceKind: String(value.source_kind),
          sourceRef: String(value.source_ref),
          verifiedAt: String(value.verified_at),
          contentVersion: String(value.content_version),
        };
      });
  }

  listOwnedDevices(): OwnedDevice[] {
    return this.raw
      .prepare(
        "SELECT * FROM owned_devices ORDER BY CASE ownership WHEN 'OWNED' THEN 0 WHEN 'BORROWED' THEN 1 WHEN 'WISHLIST' THEN 2 ELSE 3 END, manufacturer, model",
      )
      .all()
      .map((row) => mapOwnedDevice(row as Record<string, unknown>));
  }

  createOwnedDevice(device: OwnedDevice): void {
    this.raw
      .prepare(
        `INSERT INTO owned_devices (
          id, manufacturer, model, category, ownership, nickname, serial_number,
          notes, capabilities_json, created_at, updated_at
        ) VALUES (
          @id, @manufacturer, @model, @category, @ownership, @nickname, @serialNumber,
          @notes, @capabilitiesJson, @createdAt, @updatedAt
        )`,
      )
      .run({
        ...device,
        capabilitiesJson: JSON.stringify(device.capabilities),
      });
  }

  deleteOwnedDevice(id: string): boolean {
    return (
      this.raw.prepare("DELETE FROM owned_devices WHERE id = ?").run(id)
        .changes === 1
    );
  }

  listDeliveryTargets(): DeliveryTarget[] {
    return this.raw
      .prepare(
        "SELECT * FROM delivery_targets ORDER BY enabled DESC, created_at, name",
      )
      .all()
      .map((row) => mapDeliveryTarget(row as Record<string, unknown>));
  }

  getStoredDeliveryTarget(id: string): StoredDeliveryTarget | null {
    const row = this.raw
      .prepare("SELECT * FROM delivery_targets WHERE id=?")
      .get(id) as Record<string, unknown> | undefined;
    return row
      ? {
          target: mapDeliveryTarget(row),
          credentialJson: nullableString(row.credential_json),
        }
      : null;
  }

  createDeliveryTarget(
    target: DeliveryTarget,
    credentialJson: string | null = null,
  ): void {
    this.raw
      .prepare(
        `INSERT INTO delivery_targets (
          id, device_id, name, kind, transport, location, username,
          credential_json, enabled, verified_at, created_at, updated_at
        ) VALUES (
          @id, @deviceId, @name, @kind, @transport, @location, @username,
          @credentialJson, @enabled, @verifiedAt, @createdAt, @updatedAt
        )`,
      )
      .run({
        ...target,
        credentialJson,
        enabled: target.enabled ? 1 : 0,
      });
  }

  updateDeliveryTarget(
    target: DeliveryTarget,
    credentialJson: string | null,
  ): boolean {
    return (
      this.raw
        .prepare(
          `UPDATE delivery_targets SET
            device_id=@deviceId,
            name=@name,
            kind=@kind,
            transport=@transport,
            location=@location,
            username=@username,
            credential_json=@credentialJson,
            enabled=@enabled,
            verified_at=@verifiedAt,
            updated_at=@updatedAt
          WHERE id=@id`,
        )
        .run({
          ...target,
          credentialJson,
          enabled: target.enabled ? 1 : 0,
        }).changes === 1
    );
  }

  listAlbumDeliveryJobs(albumId: string): DeliveryJob[] {
    const summary = this.getAlbumSummary(albumId);
    if (!summary) return [];
    return this.raw
      .prepare(
        `SELECT delivery_jobs.*, albums.title AS album_title
         FROM delivery_jobs
         LEFT JOIN albums ON albums.id=delivery_jobs.album_id
         WHERE delivery_jobs.album_id IN (
           SELECT album_id FROM library_album_members
           WHERE library_album_id=?
         )
         ORDER BY delivery_jobs.created_at DESC`,
      )
      .all(summary.id)
      .map((row) => mapDeliveryJob(row as Record<string, unknown>));
  }

  listPendingDeliveryJobs(): DeliveryJob[] {
    return this.raw
      .prepare(
        "SELECT * FROM delivery_jobs WHERE status IN ('QUEUED','RUNNING') ORDER BY created_at",
      )
      .all()
      .map((row) => mapDeliveryJob(row as Record<string, unknown>));
  }

  listDeliveryJobs(limit = 100): DeliveryJob[] {
    return this.raw
      .prepare(
        `WITH head AS (
           SELECT id, plan_id FROM delivery_jobs
           ORDER BY created_at DESC, id DESC LIMIT ?
         ), selected_plans AS (
           SELECT DISTINCT plan_id FROM head WHERE plan_id IS NOT NULL
         )
         SELECT delivery_jobs.*, albums.title AS album_title
         FROM delivery_jobs
         LEFT JOIN albums ON albums.id=delivery_jobs.album_id
         WHERE delivery_jobs.id IN (SELECT id FROM head)
            OR delivery_jobs.plan_id IN (SELECT plan_id FROM selected_plans)
         ORDER BY delivery_jobs.created_at DESC, delivery_jobs.id DESC`,
      )
      .all(Math.min(Math.max(limit, 1), 500))
      .map((row) => mapDeliveryJob(row as Record<string, unknown>));
  }

  createDeliveryJob(
    job: DeliveryJob,
    sourceBundle: FrozenAlbumDeliveryBundle | null = null,
  ): void {
    this.raw
      .prepare(
        `INSERT INTO delivery_jobs (
          id, album_id, target_id, target_name, transport, status, file_count,
          total_bytes, transferred_bytes, manifest_json, verified, error,
          created_at, started_at, finished_at, plan_id, source_bundle_json
        ) VALUES (
          @id, @albumId, @targetId, @targetName, @transport, @status,
          @fileCount, @totalBytes, @transferredBytes, '[]', @verified, @error,
          @createdAt, @startedAt, @finishedAt, @planId, @sourceBundleJson
        )`,
      )
      .run({
        ...job,
        planId: job.planId ?? null,
        sourceBundleJson: sourceBundle ? JSON.stringify(sourceBundle) : null,
        verified: job.verified ? 1 : 0,
      });
  }

  findActiveDeliveryJob(albumId: string, targetId: string): DeliveryJob | null {
    const summary = this.getAlbumSummary(albumId);
    if (!summary) return null;
    const row = this.raw
      .prepare(
        `SELECT delivery_jobs.*, albums.title AS album_title
         FROM delivery_jobs
         LEFT JOIN albums ON albums.id=delivery_jobs.album_id
         WHERE delivery_jobs.album_id IN (
           SELECT album_id FROM library_album_members WHERE library_album_id=?
         ) AND delivery_jobs.target_id=?
           AND delivery_jobs.status IN ('QUEUED','RUNNING')
         ORDER BY delivery_jobs.created_at DESC, delivery_jobs.id DESC LIMIT 1`,
      )
      .get(summary.id, targetId) as Record<string, unknown> | undefined;
    return row ? mapDeliveryJob(row) : null;
  }

  resolveDeliveryPlanId(
    targetId: string,
    requestedPlanId: string | null,
    now = Date.now(),
    windowMs = 15 * 60 * 1000,
  ): string | null {
    const fresh = (createdAt: unknown) => {
      const value = Date.parse(String(createdAt));
      return (
        Number.isFinite(value) && now - value >= 0 && now - value <= windowMs
      );
    };
    if (requestedPlanId) {
      const requested = this.raw
        .prepare(
          `SELECT target_id, created_at FROM delivery_jobs
           WHERE plan_id=? ORDER BY created_at DESC, id DESC`,
        )
        .all(requestedPlanId) as Array<Record<string, unknown>>;
      if (requested.length) {
        return requested.every((row) => String(row.target_id) === targetId) &&
          fresh(requested[0]!.created_at)
          ? requestedPlanId
          : null;
      }
    }
    const recent = this.raw
      .prepare(
        `SELECT plan_id, created_at FROM delivery_jobs
         WHERE target_id=? AND plan_id IS NOT NULL
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(targetId) as Record<string, unknown> | undefined;
    if (recent && fresh(recent.created_at)) return String(recent.plan_id);
    return requestedPlanId;
  }

  claimDeliveryJob(id: string): DeliveryJob | null {
    const result = this.raw
      .prepare(
        `UPDATE delivery_jobs SET status='RUNNING', started_at=?
         WHERE id=? AND status='QUEUED'`,
      )
      .run(new Date().toISOString(), id);
    if (result.changes !== 1) return null;
    return this.getDeliveryJob(id);
  }

  getDeliveryJob(id: string): DeliveryJob | null {
    const row = this.raw
      .prepare("SELECT * FROM delivery_jobs WHERE id=?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapDeliveryJob(row) : null;
  }

  getDeliveryJobSourceBundle(id: string): FrozenAlbumDeliveryBundle | null {
    const row = this.raw
      .prepare("SELECT source_bundle_json FROM delivery_jobs WHERE id=?")
      .get(id) as Record<string, unknown> | undefined;
    return row?.source_bundle_json
      ? parseJson<FrozenAlbumDeliveryBundle | null>(
          row.source_bundle_json,
          null,
        )
      : null;
  }

  updateDeliveryProgress(
    id: string,
    input: { fileCount: number; totalBytes: number; transferredBytes: number },
  ): void {
    this.raw
      .prepare(
        `UPDATE delivery_jobs SET file_count=@fileCount, total_bytes=@totalBytes,
          transferred_bytes=@transferredBytes WHERE id=@id AND status='RUNNING'`,
      )
      .run({ id, ...input });
  }

  finishDeliveryJob(
    id: string,
    input: {
      status: "COMPLETED" | "FAILED" | "CANCELLED";
      fileCount: number;
      totalBytes: number;
      transferredBytes: number;
      manifest: unknown[];
      verified: boolean;
      error: string | null;
    },
  ): DeliveryJob {
    const finishedAt = new Date().toISOString();
    this.raw
      .prepare(
        `UPDATE delivery_jobs SET status=@status, file_count=@fileCount,
          total_bytes=@totalBytes, transferred_bytes=@transferredBytes,
          manifest_json=@manifestJson, verified=@verified, error=@error,
          finished_at=@finishedAt WHERE id=@id AND status='RUNNING'`,
      )
      .run({
        id,
        ...input,
        manifestJson: JSON.stringify(input.manifest),
        verified: input.verified ? 1 : 0,
        finishedAt,
      });
    if (input.status === "COMPLETED" && input.verified) {
      const targetId = this.getDeliveryJob(id)?.targetId;
      if (targetId) this.markDeliveryTargetVerified(targetId, finishedAt);
    }
    const job = this.getDeliveryJob(id);
    if (!job) throw new Error(`Delivery job ${id} does not exist`);
    return job;
  }

  markDeliveryTargetVerified(id: string, verifiedAt: string): void {
    this.raw
      .prepare(
        `UPDATE delivery_targets
         SET verified_at=?, updated_at=?
         WHERE id=?`,
      )
      .run(verifiedAt, verifiedAt, id);
  }

  recoverInterruptedDeliveries(): number {
    return this.raw
      .prepare(
        `UPDATE delivery_jobs SET status='FAILED', error=?, finished_at=?
         WHERE status='RUNNING'`,
      )
      .run("服务重启中断了投送；请重新发起", new Date().toISOString()).changes;
  }

  listAlbumDeliveryFiles(albumId: string): DeliveryFileLocation[] {
    const localVersionId = this.resolveLocalVersionId(albumId);
    if (!localVersionId) return [];
    return this.raw
      .prepare(
        `SELECT media_files.id, media_files.relative_path, media_files.size_bytes,
                media_files.file_sha256, media_files.extension,
                media_files.container, media_files.album, media_files.album_artist,
                media_files.title, media_files.artists_json,
                media_files.disc_number, media_files.disc_total,
                media_files.track_number, media_files.track_total,
                album_files.disc_number_override,
                library_roots.container_path AS root_path
         FROM album_files
         JOIN media_files ON media_files.id=album_files.media_file_id
         JOIN library_roots ON library_roots.id=media_files.root_id
         WHERE album_files.album_id=? AND album_files.is_primary = 1
         ORDER BY COALESCE(album_files.disc_number_override, media_files.disc_number, 1),
                  COALESCE(media_files.track_number, 2147483647),
                  media_files.relative_path`,
      )
      .all(localVersionId)
      .map((row) => {
        const value = row as Record<string, unknown>;
        return {
          id: String(value.id),
          relativePath: String(value.relative_path),
          rootPath: String(value.root_path),
          sizeBytes: Number(value.size_bytes),
          sha256: nullableString(value.file_sha256),
          extension: String(value.extension),
          container: nullableString(value.container),
          album: nullableString(value.album),
          albumArtist: nullableString(value.album_artist),
          title: nullableString(value.title),
          artists: normalizedStringArray(value.artists_json),
          discNumber: nullableNumber(value.disc_number),
          discTotal: nullableNumber(value.disc_total),
          discNumberOverride: nullableNumber(value.disc_number_override),
          trackNumber: nullableNumber(value.track_number),
          trackTotal: nullableNumber(value.track_total),
        };
      });
  }

  getAlbumDeliveryBundle(albumId: string): AlbumDeliveryBundle | null {
    const album = this.getAlbumSummary(albumId);
    const localVersionId = this.resolveLocalVersionId(albumId);
    if (!album || !localVersionId) return null;
    return {
      albumId: localVersionId,
      title: album.title,
      albumArtist: album.albumArtist,
      year: album.year,
      artwork: album.artwork,
      files: this.listAlbumDeliveryFiles(localVersionId),
    };
  }

  getStoredModelConfiguration(): {
    configuration: ModelConfiguration;
    credentialJson: string | null;
  } {
    const row = this.raw
      .prepare("SELECT * FROM model_configuration WHERE id=1")
      .get() as Record<string, unknown> | undefined;
    if (!row) {
      return {
        configuration: {
          enabled: false,
          baseUrl: "https://api.openai.com/v1",
          model: "",
          apiKeyConfigured: false,
          verificationStatus: "UNVERIFIED",
          lastCheckedAt: null,
          verificationMessage: null,
          updatedAt: null,
        },
        credentialJson: null,
      };
    }
    const credentialJson = nullableString(row.credential_json);
    return {
      configuration: {
        enabled: Boolean(row.enabled),
        baseUrl: String(row.base_url),
        model: String(row.model),
        apiKeyConfigured: Boolean(credentialJson),
        verificationStatus:
          (nullableString(
            row.verification_status,
          ) as ModelVerificationStatus) ?? "UNVERIFIED",
        lastCheckedAt: nullableString(row.last_checked_at),
        verificationMessage: nullableString(row.verification_message),
        updatedAt: String(row.updated_at),
      },
      credentialJson,
    };
  }

  saveModelConfiguration(input: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    credentialJson: string | null;
  }): ModelConfiguration {
    const updatedAt = new Date().toISOString();
    this.raw
      .prepare(
        `INSERT INTO model_configuration
          (id, enabled, base_url, model, credential_json, updated_at)
         VALUES (1, @enabled, @baseUrl, @model, @credentialJson, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,
           base_url=excluded.base_url, model=excluded.model,
           credential_json=excluded.credential_json,
           verification_status='UNVERIFIED', last_checked_at=NULL,
           verification_message=NULL, updated_at=excluded.updated_at`,
      )
      .run({ ...input, enabled: input.enabled ? 1 : 0, updatedAt });
    return this.getStoredModelConfiguration().configuration;
  }

  recordModelVerification(
    status: Exclude<ModelVerificationStatus, "UNVERIFIED">,
    message: string,
  ): ModelConfiguration {
    this.raw
      .prepare(
        `UPDATE model_configuration
         SET verification_status=?, last_checked_at=?, verification_message=?
         WHERE id=1`,
      )
      .run(status, new Date().toISOString(), message.slice(0, 500));
    return this.getStoredModelConfiguration().configuration;
  }

  getAlbumIntroduction(albumId: string): AlbumIntroduction | null {
    const localVersionId = this.resolveLocalVersionId(albumId);
    if (!localVersionId) return null;
    const row = this.raw
      .prepare("SELECT * FROM album_introductions WHERE album_id=?")
      .get(localVersionId) as Record<string, unknown> | undefined;
    return row
      ? {
          albumId: String(row.album_id),
          content: String(row.content),
          model: String(row.model),
          generatedAt: String(row.generated_at),
          factualBasis: parseJson(row.factual_basis_json, []),
        }
      : null;
  }

  saveAlbumIntroduction(
    introduction: AlbumIntroduction,
    sourceHash: string,
  ): void {
    const localVersionId = this.resolveLocalVersionId(introduction.albumId);
    if (!localVersionId)
      throw new Error(`Album ${introduction.albumId} does not exist`);
    this.raw
      .prepare(
        `INSERT INTO album_introductions
          (album_id, content, model, factual_basis_json, source_hash, generated_at)
         VALUES (@albumId, @content, @model, @factualBasisJson, @sourceHash, @generatedAt)
         ON CONFLICT(album_id) DO UPDATE SET content=excluded.content,
           model=excluded.model, factual_basis_json=excluded.factual_basis_json,
           source_hash=excluded.source_hash, generated_at=excluded.generated_at`,
      )
      .run({
        ...introduction,
        albumId: localVersionId,
        factualBasisJson: JSON.stringify(introduction.factualBasis),
        sourceHash,
      });
  }

  getLibraryStats(): LibraryStats {
    const row = this.raw
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM library_albums WHERE primary_version_id IS NOT NULL) AS albums,
          (SELECT COUNT(*) FROM album_files WHERE is_primary = 1) AS tracks,
          (SELECT COUNT(*) FROM media_files) AS files,
          (SELECT COUNT(DISTINCT library_album_id) FROM library_issues) AS needs_review,
          (SELECT COUNT(DISTINCT library_album_id) FROM library_issues WHERE code='MISSING_ARTWORK') AS missing_artwork,
          (SELECT COUNT(DISTINCT library_album_id) FROM library_issues WHERE code='IDENTITY_OVERLAP') AS pending_groups,
          (SELECT COUNT(DISTINCT library_album_id) FROM library_issues WHERE code='INCOMPLETE_TRACKS') AS incomplete_albums,
          (SELECT COUNT(DISTINCT library_album_id) FROM library_issues WHERE code='LOW_RES_ARTWORK') AS low_resolution_artwork,
          (SELECT COUNT(DISTINCT library_album_id) FROM library_issues WHERE code IN ('BROKEN_TEXT','MISSING_IDENTITY')) AS broken_identity,
          (SELECT COUNT(*) FROM library_albums
           WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')) AS recently_added,
          COALESCE((SELECT failed_files FROM scan_jobs
                    WHERE status IN ('COMPLETED','COMPLETED_WITH_WARNINGS','FAILED')
                    ORDER BY created_at DESC LIMIT 1), 0) AS parse_failures,
          (SELECT MAX(finished_at) FROM scan_jobs WHERE status IN ('COMPLETED','COMPLETED_WITH_WARNINGS')) AS last_scan_at`,
      )
      .get() as Record<string, unknown>;
    return {
      albums: Number(row.albums),
      tracks: Number(row.tracks),
      files: Number(row.files),
      needsReview: Number(row.needs_review),
      missingArtwork: Number(row.missing_artwork),
      parseFailures: Number(row.parse_failures),
      lastScanAt: nullableString(row.last_scan_at),
      pendingGroups: Number(row.pending_groups),
      incompleteAlbums: Number(row.incomplete_albums),
      lowResolutionArtwork: Number(row.low_resolution_artwork),
      brokenIdentity: Number(row.broken_identity),
      recentlyAdded: Number(row.recently_added),
    };
  }

  private mapLibraryAlbumSummary(row: Record<string, unknown>): AlbumSummary {
    const summary = this.mapAlbumSummary(row);
    const id = String(row.library_album_id);
    const physicalMedia = this.raw
      .prepare(
        `SELECT DISTINCT pc.medium FROM physical_copies pc
      JOIN library_album_members lm ON lm.album_id=pc.album_id
      WHERE lm.library_album_id=? ORDER BY pc.medium`,
      )
      .all(id)
      .map(
        (item) => String((item as { medium: string }).medium) as PhysicalMedium,
      );
    const hasDigital = Boolean(
      this.raw
        .prepare(
          `SELECT 1 FROM library_album_members lm
      JOIN album_files af ON af.album_id=lm.album_id WHERE lm.library_album_id=? LIMIT 1`,
        )
        .get(id),
    );
    return {
      ...summary,
      id,
      hasDigital,
      physicalMedia,
      primaryVersionId: String(row.primary_version_id),
      primaryVersionSource: row.primary_version_source as "AUTOMATIC" | "USER",
      revision: Number(row.revision),
      versionCount: Number(row.version_count),
      issues: this.listLibraryIssues(id),
    };
  }

  private mapAlbumSummary(row: Record<string, unknown>): AlbumSummary {
    const media = this.raw
      .prepare(
        "SELECT DISTINCT medium FROM physical_copies WHERE album_id = ? ORDER BY medium",
      )
      .all(String(row.id))
      .map(
        (copy) => String((copy as { medium: string }).medium) as PhysicalMedium,
      );
    const hasDigital = Boolean(
      this.raw
        .prepare("SELECT 1 FROM album_files WHERE album_id = ? LIMIT 1")
        .get(String(row.id)) as unknown,
    );
    return {
      id: String(row.id),
      title: String(row.title),
      albumArtist: String(row.album_artist),
      year: nullableNumber(row.year),
      artwork: parseJson<AlbumSummary["artwork"]>(row.artwork_json, {
        source: "NONE",
        url: null,
        mimeType: null,
        width: null,
        height: null,
      }),
      audioBadge: nullableString(row.audio_badge),
      audioSummary: row.audio_summary_json
        ? parseJson(row.audio_summary_json, null)
        : null,
      mixedAudioSpecs: Boolean(row.mixed_audio_specs),
      hasDigital,
      physicalMedia: media,
      matchStatus: row.match_status as AlbumSummary["matchStatus"],
      primaryVersionSource: "AUTOMATIC",
      revision: 0,
      trackCount: Number(row.track_count),
      discCount: Number(row.disc_count),
      sourceVersionCount: Number(row.source_version_count ?? 1),
      duplicateFileCount: Number(row.duplicate_file_count ?? 0),
      aggregationIssues: parseJson<AlbumAggregationIssue[]>(
        row.aggregation_issues_json,
        [],
      ),
    };
  }
}

function canonicalLibraryIdentityDecisionInput(
  albumId: string,
  command: Record<string, unknown> | LibraryIdentityDecisionCommand,
): string {
  return JSON.stringify(sortJsonValue({ albumId, command }));
}

function libraryIdentityDecisionDetails(
  command: LibraryIdentityDecisionCommand,
): LibraryIdentityDecision["details"] {
  return {
    targetLibraryAlbumId:
      command.type === "MERGE" ? command.targetLibraryAlbumId : null,
    primaryVersionId:
      command.type === "SPLIT"
        ? null
        : "primaryVersionId" in command
          ? (command.primaryVersionId ?? null)
          : null,
    partitions:
      command.type === "SPLIT"
        ? command.partitions.map((partition) => ({
            versionIds: [...partition.versionIds],
            primaryVersionId: partition.primaryVersionId ?? null,
          }))
        : [],
    compensatedDecisionId: null,
  };
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  );
}

function libraryIdentityGovernanceState(
  snapshot: LibraryIdentitySnapshot,
): LibraryIdentityGovernanceState {
  return {
    groups: snapshot.groups
      .map((group) => ({
        id: group.id,
        primaryVersionId: group.primaryVersionId,
        decisionSource: group.decisionSource,
        primaryVersionSource: group.primaryVersionSource,
        revision: group.revision,
        members: group.members
          .map((member) => ({
            albumId: member.albumId,
            relationshipStatus: member.relationshipStatus,
          }))
          .sort((left, right) => left.albumId.localeCompare(right.albumId)),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    aliases: snapshot.aliases
      .map((alias) => ({
        aliasId: alias.aliasId,
        libraryAlbumId: alias.libraryAlbumId,
      }))
      .sort((left, right) => left.aliasId.localeCompare(right.aliasId)),
  };
}

function sameLibraryIdentityGovernance(
  left: LibraryIdentitySnapshot,
  right: LibraryIdentitySnapshot,
): boolean {
  return (
    JSON.stringify(libraryIdentityGovernanceState(left)) ===
    JSON.stringify(libraryIdentityGovernanceState(right))
  );
}

function normalizeLibraryIdentity(artist: string, title: string): string {
  return [artist, title]
    .map((value) =>
      value
        .normalize("NFKC")
        .trim()
        .toLocaleLowerCase("en-US")
        .replace(/\s+/g, " "),
    )
    .join("\0");
}

function comparePrimaryVersions(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  const issueCount = (row: Record<string, unknown>) => {
    const artwork = parseJson<AlbumSummary["artwork"]>(row.artwork_json, {
      source: "NONE",
      url: null,
      mimeType: null,
      width: null,
      height: null,
    });
    const artworkPenalty =
      artwork.source === "NONE"
        ? 2
        : (artwork.width != null && artwork.width < 600) ||
            (artwork.height != null && artwork.height < 600)
          ? 1
          : 0;
    const textPenalty =
      hasBrokenText(String(row.title)) ||
      hasBrokenText(String(row.album_artist))
        ? 2
        : 0;
    return (
      parseJson<unknown[]>(row.aggregation_issues_json, []).length +
      (row.match_status === "TRACKS_INCOMPLETE" ? 1 : 0) +
      (row.mixed_audio_specs ? 1 : 0) +
      artworkPenalty +
      textPenalty
    );
  };
  const metadataCount = (row: Record<string, unknown>) =>
    [
      row.year,
      row.label,
      row.catalog_number,
      row.barcode,
      row.musicbrainz_release_id,
    ].filter((value) => value != null && String(value).trim()).length;
  return (
    issueCount(a) - issueCount(b) ||
    Number(b.track_count) - Number(a.track_count) ||
    metadataCount(b) - metadataCount(a) ||
    String(a.stable_path ?? "").localeCompare(String(b.stable_path ?? "")) ||
    String(a.id).localeCompare(String(b.id))
  );
}

function hasBrokenText(value: string): boolean {
  return (
    value.includes("\uFFFD") ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value) ||
    /(?:Ã[\u0080-\u00BF]|Â[\u0080-\u00BF]|â(?:€|€™|€œ|€œ|€“|€”))/u.test(
      value,
    ) ||
    value.includes("ï¿½") ||
    value.includes("锟斤拷")
  );
}

function issueIdentity(
  groupId: string,
  albumId: string | null,
  code: string,
): string {
  return `${groupId}\0${albumId ?? ""}\0${code}`;
}

function mapScanJob(row: Record<string, unknown>): ScanJob {
  return {
    id: String(row.id),
    rootId: String(row.root_id),
    mode: (nullableString(row.mode) ?? "FULL") as ScanJob["mode"],
    triggerSource: (nullableString(row.trigger_source) ??
      "MANUAL") as ScanJob["triggerSource"],
    retryOfScanJobId: nullableString(row.retry_of_scan_job_id),
    status: row.status as ScanJob["status"],
    totalFiles: Number(row.total_files),
    processedFiles: Number(row.processed_files),
    parsedFiles: Number(row.parsed_files),
    failedFiles: Number(row.failed_files),
    reusedFiles: Number(row.reused_files ?? 0),
    stableAlbumDirectories: Number(row.stable_album_directories ?? 0),
    deferredAlbumDirectories: Number(row.deferred_album_directories ?? 0),
    createdAt: String(row.created_at),
    startedAt: nullableString(row.started_at),
    finishedAt: nullableString(row.finished_at),
    error: nullableString(row.error),
    cancelRequestedAt: nullableString(row.cancel_requested_at),
  };
}

function emptyScanJob(
  id: string,
  rootId: string,
  mode: ScanJob["mode"],
  triggerSource: ScanJob["triggerSource"],
  createdAt: string,
  retryOfScanJobId: string | null = null,
): ScanJob {
  return {
    id,
    rootId,
    mode,
    triggerSource,
    retryOfScanJobId,
    status: "QUEUED",
    totalFiles: 0,
    processedFiles: 0,
    parsedFiles: 0,
    failedFiles: 0,
    reusedFiles: 0,
    stableAlbumDirectories: 0,
    deferredAlbumDirectories: 0,
    createdAt,
    startedAt: null,
    finishedAt: null,
    error: null,
    cancelRequestedAt: null,
  };
}

function deploymentRootFields(root: LibraryRoot) {
  return {
    id: root.id,
    name: root.name,
    hostPathHint: root.hostPathHint,
    containerPath: root.containerPath,
    policy: root.policy,
    enabled: root.enabled,
  };
}

function mapScanFileResult(row: Record<string, unknown>): ScanFileResult {
  return {
    id: Number(row.id),
    scanJobId: String(row.scan_job_id),
    rootId: String(row.root_id),
    relativePath: String(row.relative_path),
    extension: String(row.extension),
    candidateKind: row.candidate_kind as ScanFileResult["candidateKind"],
    outcome: row.outcome as ScanFileResult["outcome"],
    mediaFileId: nullableString(row.media_file_id),
    sizeBytes: nullableNumber(row.size_bytes),
    modifiedAtMs: nullableNumber(row.modified_at_ms),
    errorCode: nullableString(row.error_code),
    errorStage: nullableString(row.error_stage),
    warningCodes: parseJson(row.warning_codes_json, []),
    createdAt: String(row.created_at),
  };
}

function mapScanReport(row: Record<string, unknown>): ScanReport {
  const candidates = Number(row.candidates);
  const processed = Number(row.processed);
  const parsed = Number(row.parsed);
  const unsupported = Number(row.unsupported);
  const failed = Number(row.failed);
  const unprocessed = Number(row.unprocessed);
  const regularFiles = Number(row.regular_files);
  const auxiliaryFiles = Number(row.auxiliary_files);
  const ignoredFiles = Number(row.ignored_files);
  const boundaryEvidence = Boolean(row.boundary_evidence);
  const candidateBalance = candidates === processed + unprocessed;
  const outcomeBalance = processed === parsed + unsupported + failed;
  const regularFileBalance =
    regularFiles === candidates + auxiliaryFiles + ignoredFiles;
  const startedAt = nullableString(row.started_at);
  const finishedAt = nullableString(row.finished_at);
  const durationMs =
    startedAt && finishedAt
      ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
      : null;
  return {
    scanJobId: String(row.scan_job_id),
    rootId: String(row.root_id),
    status: row.status as ScanReport["status"],
    rulesVersion: String(row.rules_version),
    summaryHash: String(row.summary_hash),
    candidateScope: "SUPPORTED_AND_KNOWN_UNSUPPORTED_AUDIO",
    candidates,
    processed,
    parsed,
    unsupported,
    failed,
    unprocessed,
    regularFiles,
    auxiliaryFiles,
    ignoredFiles,
    skippedSymlinks: Number(row.skipped_symlinks),
    traversalErrors: Number(row.traversal_errors),
    albumCount: nullableNumber(row.album_count),
    albumIssueCount: nullableNumber(row.album_issue_count),
    trackSemantics: "ONE_AUDIO_FILE_ONE_TRACK",
    cueSheetSupport: "AUXILIARY_ONLY",
    invariants: {
      candidateBalance,
      outcomeBalance,
      regularFileBalance,
      boundaryEvidence,
      valid:
        candidateBalance &&
        outcomeBalance &&
        regularFileBalance &&
        boundaryEvidence,
    },
    startedAt,
    finishedAt,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    createdAt: String(row.created_at),
  };
}

function mapObservedMediaFile(row: Record<string, unknown>): {
  id: string;
  file: ObservedMediaFile;
} {
  return {
    id: String(row.id),
    file: {
      absolutePath: String(row.absolute_path),
      relativePath: String(row.relative_path),
      extension: String(row.extension),
      sizeBytes: Number(row.size_bytes),
      modifiedAtMs: Number(row.modified_at_ms),
      fileSha256: nullableString(row.file_sha256),
      audio: mapAudioSpec(row),
      durationSeconds: nullableNumber(row.duration_seconds),
      tags: {
        album: nullableString(row.album),
        albumArtist: nullableString(row.album_artist),
        title: nullableString(row.title),
        artists: parseJson(row.artists_json, []),
        year: nullableNumber(row.year),
        date: nullableString(row.date_text),
        genre: parseJson(row.genre_json, []),
        composer: parseJson(row.composer_json, []),
        label: parseJson(row.label_json, []),
        catalogNumber: nullableString(row.catalog_number),
        barcode: nullableString(row.barcode),
        musicBrainzReleaseId: nullableString(row.musicbrainz_release_id),
        discNumber: nullableNumber(row.disc_number),
        discTotal: nullableNumber(row.disc_total),
        trackNumber: nullableNumber(row.track_number),
        trackTotal: nullableNumber(row.track_total),
      },
      rawTags: parseJson(row.raw_tags_json, []),
      artwork: parseJson(row.artwork_json, []),
      warnings: parseJson(row.warnings_json, []),
    },
  };
}

function mapPhysicalCopy(row: Record<string, unknown>): PhysicalCopy {
  return {
    id: String(row.id),
    albumId: String(row.album_id),
    medium: row.medium as PhysicalMedium,
    label: nullableString(row.label),
    catalogNumber: nullableString(row.catalog_number),
    barcode: nullableString(row.barcode),
    country: nullableString(row.country),
    releaseYear: nullableNumber(row.release_year),
    quantity: Number(row.quantity),
    conditionNote: nullableString(row.condition_note),
    storageLocation: nullableString(row.storage_location),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapAuthUser(row: Record<string, unknown>): AuthUser {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: row.role as AuthUser["role"],
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastLoginAt: nullableString(row.last_login_at),
  };
}

function mapOwnedDevice(row: Record<string, unknown>): OwnedDevice {
  return {
    id: String(row.id),
    manufacturer: String(row.manufacturer),
    model: String(row.model),
    category: row.category as OwnedDevice["category"],
    ownership: row.ownership as OwnedDevice["ownership"],
    nickname: nullableString(row.nickname),
    serialNumber: nullableString(row.serial_number),
    notes: nullableString(row.notes),
    capabilities: parseJson(row.capabilities_json, {
      maxPcmSampleRate: null,
      maxPcmBitDepth: null,
      maxDsdRate: null,
      supportedFormats: [],
      source: null,
      verifiedAt: null,
    }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapDeliveryTarget(row: Record<string, unknown>): DeliveryTarget {
  return {
    id: String(row.id),
    deviceId: nullableString(row.device_id),
    name: String(row.name),
    kind: row.kind as DeliveryTarget["kind"],
    transport: row.transport as DeliveryTarget["transport"],
    location: String(row.location),
    username: nullableString(row.username),
    credentialConfigured: Boolean(nullableString(row.credential_json)),
    enabled: Boolean(row.enabled),
    verifiedAt: nullableString(row.verified_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapDeliveryJob(row: Record<string, unknown>): DeliveryJob {
  const manifest = parseJson<unknown[]>(row.manifest_json, []);
  return {
    id: String(row.id),
    albumId: String(row.album_id),
    albumTitle: nullableString(row.album_title),
    targetId: String(row.target_id),
    targetName: String(row.target_name),
    transport: row.transport as DeliveryJob["transport"],
    status: row.status as DeliveryJob["status"],
    fileCount: Number(row.file_count),
    completedFileCount: manifest.length,
    totalBytes: Number(row.total_bytes),
    transferredBytes: Number(row.transferred_bytes),
    verified: Boolean(row.verified),
    error: nullableString(row.error),
    createdAt: String(row.created_at),
    startedAt: nullableString(row.started_at),
    finishedAt: nullableString(row.finished_at),
    planId: nullableString(row.plan_id),
  };
}

function mapAudioSpec(
  row: Record<string, unknown>,
): AlbumSummary["audioSummary"] extends infer T ? Exclude<T, null> : never {
  return {
    kind: row.audio_kind as "PCM" | "DSD" | "DXD" | "LOSSY" | "UNKNOWN",
    codec: nullableString(row.codec),
    container: nullableString(row.container),
    lossless:
      row.lossless === null || row.lossless === undefined
        ? null
        : Boolean(row.lossless),
    bitDepth: nullableNumber(row.bit_depth),
    sampleRate: nullableNumber(row.sample_rate),
    bitrate: nullableNumber(row.bitrate),
    channels: nullableNumber(row.channels),
    dsdRate:
      (nullableString(row.dsd_rate) as
        "DSD64" | "DSD128" | "DSD256" | "DSD512" | null) ?? null,
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizedStringArray(value: unknown): string[] {
  const parsed = parseJson<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return [
    ...new Set(
      parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.normalize("NFC").trim())
        .filter(Boolean),
    ),
  ];
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined || value === ""
    ? null
    : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined || value === ""
    ? null
    : Number(value);
}

function assertEvidenceRelativePath(value: string): void {
  if (
    !value ||
    value.includes("\0") ||
    /^(?:[A-Za-z]:[\\/]|[\\/])/.test(value) ||
    value.split(/[\\/]/).includes("..")
  ) {
    throw new Error("scan evidence paths must be relative to the library root");
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function basenameWithoutExtension(value: string): string {
  const name = value.split(/[\\/]/).at(-1) ?? value;
  return name.replace(/\.[^.]+$/, "");
}
