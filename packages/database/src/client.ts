import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import type {
  AlbumArtworkEvent,
  AlbumArtworkGovernance,
  AlbumArtworkMutationResult,
  AlbumAggregationIssue,
  AlbumDetail,
  AlbumIntroduction,
  AlbumMetadata,
  AlbumMetadataEvent,
  AlbumMetadataMutationResult,
  AlbumVisibilityCommand,
  AlbumVisibilityEvent,
  AlbumVisibilityMutationResult,
  AlbumSummary,
  Artwork,
  ArtworkDecisionCommand,
  AuthSession,
  AuthUser,
  CoceanSettings,
  DeliveryJob,
  DeliveryTarget,
  LibraryRoot,
  LibraryIssue,
  LibraryIssueCode,
  LibraryInventoryReport,
  InventoryFinding,
  InventoryReason,
  LibraryIdentityDecision,
  LibraryIdentityDecisionCommand,
  LibraryIdentityDecisionResult,
  LibraryStats,
  LibraryChangeBlocker,
  LibraryChangePlan,
  LibraryChangePlanItem,
  LibraryChangePlanStatus,
  MetadataCommand,
  MetadataField,
  MetadataFieldState,
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
  UpdateAlbumMetadataCommand,
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

export class AlbumMetadataDecisionError extends Error {
  constructor(
    public readonly code:
      "INVALID_METADATA_DECISION" | "METADATA_DECISION_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "AlbumMetadataDecisionError";
  }
}

export class AlbumArtworkDecisionError extends Error {
  constructor(
    public readonly code:
      "INVALID_ARTWORK_DECISION" | "ARTWORK_DECISION_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "AlbumArtworkDecisionError";
  }
}

export class LibraryLifecycleError extends Error {
  constructor(
    public readonly code:
      | "INVALID_LIFECYCLE_COMMAND"
      | "LIFECYCLE_CONFLICT"
      | "LIFECYCLE_NOT_EXECUTABLE",
    message: string,
  ) {
    super(message);
    this.name = "LibraryLifecycleError";
  }
}

export class LibraryInventoryReportError extends Error {
  constructor(
    public readonly code: "SCAN_NOT_FOUND" | "SCAN_NOT_AUTHORITATIVE",
    message: string,
  ) {
    super(message);
    this.name = "LibraryInventoryReportError";
  }
}

export function countClosedInventoryPartitionEntries(
  classifications: readonly string[],
): number {
  const closed = new Set([
    "CURRENT_DIGITAL",
    "PHYSICAL_ONLY",
    "REFERENCED_HISTORY",
    "ORPHAN",
  ]);
  return classifications.filter((classification) => closed.has(classification))
    .length;
}

export interface ArtworkAssetInput {
  sha256: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  sizeBytes: number;
  extension: ".jpg" | ".png" | ".webp";
}

export interface ArtworkCandidateInput extends ArtworkAssetInput {
  source:
    | "OBSERVED_EMBEDDED"
    | "OBSERVED_SIDECAR"
    | "USER_UPLOAD"
    | "MUSICBRAINZ_CAA";
  localVersionId: string | null;
  relativePath: string | null;
  kind: string | null;
  evidence: Record<string, unknown>;
}

interface StoredMetadataValue {
  scopeType: "ALBUM" | "VERSION";
  ownerId: string;
  fieldName: MetadataField;
  sourceType: "USER_OVERRIDE" | "CONFIRMED_EXTERNAL";
  valueJson: string | null;
  evidenceJson: string;
  actorId: string | null;
  actorDisplayName: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AlbumMetadataSnapshot {
  libraryAlbumId: string;
  memberVersionIds: string[];
  values: StoredMetadataValue[];
  releaseMatchStates?: Array<{
    versionId: string;
    matchStatus: AlbumSummary["matchStatus"];
    musicBrainzReleaseId: string | null;
  }>;
}

interface ArtworkSelectionSnapshot {
  libraryAlbumId: string;
  state: "SELECTED" | "HIDDEN" | null;
  assetSha256: string | null;
  candidateId: string | null;
  actorId: string | null;
  actorDisplayName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
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
    metadataRevision: number;
    artworkRevision?: number;
    effectiveArtworkJson?: string;
    effectiveArtworkSource?: AlbumArtworkGovernance["selectionSource"];
    artworkSelection?: ArtworkSelectionSnapshot;
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
  albumMetadataValues: StoredMetadataValue[];
}

interface AutomaticIdentityBaseline {
  members: Map<string, string[]>;
  primaryVersions: Map<string, string | null>;
  metadataSignatures: Map<string, string>;
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
  musicRootPolicy?: "WATCH_ONLY" | "MANAGED";
  quarantineRoot?: string;
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
  private readonly musicRootPolicy: "WATCH_ONLY" | "MANAGED";
  private readonly quarantineRoot: string;

  constructor(databasePath: string, options: DatabaseOptions = {}) {
    this.musicRoot = options.musicRoot ?? "/library/music";
    this.musicRootPolicy = options.musicRootPolicy ?? "WATCH_ONLY";
    this.quarantineRoot = options.quarantineRoot ?? "/library/quarantine";
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
         VALUES ('music', 'Music', NULL, ?, ?, 1, ?, ?)`,
      )
      .run(this.musicRoot, this.musicRootPolicy, now, now);
    this.raw
      .prepare(
        `UPDATE library_roots SET container_path=?, policy=?, updated_at=?
         WHERE id='music' AND system=0`,
      )
      .run(this.musicRoot, this.musicRootPolicy, now);
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

  getLibraryInventoryReport(scanJobId: string): LibraryInventoryReport {
    return this.raw.transaction(() => {
      const scan = this.raw
        .prepare(
          `SELECT sj.id,sj.root_id,sj.status,sr.album_count,sr.parsed,sr.created_at
           FROM scan_jobs sj LEFT JOIN scan_reports sr ON sr.scan_job_id=sj.id
           WHERE sj.id=?`,
        )
        .get(scanJobId) as Record<string, unknown> | undefined;
      if (!scan)
        throw new LibraryInventoryReportError(
          "SCAN_NOT_FOUND",
          "scan job does not exist",
        );
      if (
        !scan.created_at ||
        !["COMPLETED", "COMPLETED_WITH_WARNINGS"].includes(
          String(scan.status),
        ) ||
        scan.album_count == null
      )
        throw new LibraryInventoryReportError(
          "SCAN_NOT_AUTHORITATIVE",
          "scan does not have an authoritative published snapshot",
        );
      const latest = this.raw
        .prepare(
          `SELECT sr.scan_job_id FROM scan_reports sr
           JOIN scan_jobs sj ON sj.id=sr.scan_job_id
           WHERE sr.root_id=? AND sj.status IN ('COMPLETED','COMPLETED_WITH_WARNINGS')
             AND sr.album_count IS NOT NULL
           ORDER BY sr.created_at DESC,sr.rowid DESC LIMIT 1`,
        )
        .get(String(scan.root_id)) as { scan_job_id: string } | undefined;
      if (latest?.scan_job_id !== scanJobId)
        throw new LibraryInventoryReportError(
          "SCAN_NOT_AUTHORITATIVE",
          "scan is not the latest published snapshot for its root",
        );

      const auditReferences = readInventoryAuditVersionReferences(this.raw);

      const localVersionBaseCount = Number(
        (
          this.raw.prepare("SELECT COUNT(*) AS count FROM albums").get() as {
            count: number;
          }
        ).count,
      );

      const rows = readInventoryVersionFactRows(this.raw);
      const mediaRows = this.raw
        .prepare(
          `SELECT af.album_id,af.media_file_id,
                  a.root_id AS album_root_id,mf.root_id AS media_root_id
           FROM album_files af
           JOIN albums a ON a.id=af.album_id
           JOIN media_files mf ON mf.id=af.media_file_id
           ORDER BY af.album_id,af.media_file_id`,
        )
        .all() as Array<{
        album_id: string;
        media_file_id: string;
        album_root_id: string;
        media_root_id: string;
      }>;
      const mediaByVersion = new Map<string, string[]>();
      const ownersByMedia = new Map<string, string[]>();
      for (const item of mediaRows) {
        const versionMedia = mediaByVersion.get(item.album_id) ?? [];
        versionMedia.push(item.media_file_id);
        mediaByVersion.set(item.album_id, versionMedia);
        const owners = ownersByMedia.get(item.media_file_id) ?? [];
        owners.push(item.album_id);
        ownersByMedia.set(item.media_file_id, owners);
      }
      const findings: InventoryFinding[] = [];
      const addFinding = (
        code: InventoryFinding["code"],
        localVersionId: string | null = null,
        libraryAlbumId: string | null = null,
        mediaFileId: string | null = null,
      ) => {
        if (
          !findings.some(
            (finding) =>
              finding.code === code &&
              finding.localVersionId === localVersionId &&
              finding.libraryAlbumId === libraryAlbumId &&
              finding.mediaFileId === mediaFileId,
          )
        )
          findings.push({ code, localVersionId, libraryAlbumId, mediaFileId });
      };
      const versions = rows.map((row) => {
        const localVersionId = String(row.id);
        const rootId = String(row.root_id);
        const libraryAlbumId = row.library_album_id
          ? String(row.library_album_id)
          : null;
        const mediaFileIds = mediaByVersion.get(localVersionId) ?? [];
        const physicalCopyCount = Number(row.physical_copy_count);
        const reasons: InventoryReason[] = [];
        let classification: LibraryInventoryReport["versions"][number]["classification"];
        if (mediaFileIds.length > 0) {
          classification = "CURRENT_DIGITAL";
          reasons.push("CURRENT_FILES");
        } else if (physicalCopyCount > 0) {
          classification = "PHYSICAL_ONLY";
          reasons.push("PHYSICAL_COPY");
        } else {
          reasons.push(
            ...zeroFileRetentionReasons(row, localVersionId, auditReferences),
          );
          if (reasons.length > 0) classification = "REFERENCED_HISTORY";
          else {
            classification = "ORPHAN";
            reasons.push("NO_CURRENT_FACT");
          }
        }
        if (!localVersionId || !rootId)
          addFinding(
            "EMPTY_IDENTIFIER",
            localVersionId || null,
            libraryAlbumId,
          );
        if (!libraryAlbumId)
          addFinding("LOCAL_VERSION_WITHOUT_LIBRARY_ALBUM", localVersionId);
        return {
          localVersionId,
          libraryAlbumId,
          rootId,
          classification,
          reasons,
          mediaFileIds,
          fileCount: mediaFileIds.length,
          physicalCopyCount,
          physicalQuantity: Number(row.physical_quantity),
          isPrimary: Boolean(row.is_primary),
        };
      });

      for (const [mediaFileId, owners] of ownersByMedia)
        if (owners.length !== 1)
          addFinding(
            "MEDIA_FILE_MULTIPLE_OWNERS",
            owners[0] ?? null,
            null,
            mediaFileId,
          );
      for (const item of mediaRows)
        if (item.album_root_id !== item.media_root_id)
          addFinding(
            "MEDIA_FILE_ROOT_MISMATCH",
            item.album_id,
            null,
            item.media_file_id,
          );
      const groupRows = this.raw
        .prepare(
          `SELECT la.id,la.primary_version_id,la.visibility,
                  EXISTS(SELECT 1 FROM library_album_members lm WHERE lm.library_album_id=la.id AND lm.album_id=la.primary_version_id) AS primary_is_member
           FROM library_albums la ORDER BY la.id`,
        )
        .all() as Record<string, unknown>[];
      const libraryAlbums = groupRows.map((group) => {
        const libraryAlbumId = String(group.id);
        const primary = group.primary_version_id
          ? String(group.primary_version_id)
          : null;
        const memberVersionIds = versions
          .filter((version) => version.libraryAlbumId === libraryAlbumId)
          .map((version) => version.localVersionId)
          .sort();
        const currentMembers = versions.filter(
          (version) =>
            version.libraryAlbumId === libraryAlbumId &&
            ["CURRENT_DIGITAL", "PHYSICAL_ONLY"].includes(
              version.classification,
            ),
        );
        const primaryVersion = primary
          ? versions.find(
              (version) =>
                version.localVersionId === primary &&
                version.libraryAlbumId === libraryAlbumId,
            )
          : undefined;
        const visible = group.visibility === "VISIBLE";
        if (visible && currentMembers.length === 0)
          addFinding(
            "VISIBLE_ALBUM_WITHOUT_CURRENT_MEMBER",
            null,
            libraryAlbumId,
          );
        if (!primary)
          addFinding(
            "LIBRARY_ALBUM_WITHOUT_PRIMARY_VERSION",
            null,
            libraryAlbumId,
          );
        else if (!Boolean(group.primary_is_member))
          addFinding("PRIMARY_VERSION_NOT_MEMBER", primary, libraryAlbumId);
        else if (
          visible &&
          primaryVersion &&
          !["CURRENT_DIGITAL", "PHYSICAL_ONLY"].includes(
            primaryVersion.classification,
          )
        )
          addFinding("PRIMARY_VERSION_WITHOUT_FILES", primary, libraryAlbumId);
        return {
          libraryAlbumId,
          primaryVersionId: primary,
          memberVersionIds,
          visible,
          displayed:
            visible &&
            primaryVersion !== undefined &&
            ["CURRENT_DIGITAL", "PHYSICAL_ONLY"].includes(
              primaryVersion.classification,
            ),
        };
      });

      const scanParsedRows = this.raw
        .prepare(
          `SELECT sfr.media_file_id,sfr.root_id AS scan_file_root_id,
                  mf.root_id AS media_root_id
           FROM scan_file_results sfr
           LEFT JOIN media_files mf ON mf.id=sfr.media_file_id
           WHERE sfr.scan_job_id=? AND sfr.outcome='PARSED'
           ORDER BY sfr.media_file_id`,
        )
        .all(scanJobId) as Array<{
        media_file_id: string;
        scan_file_root_id: string;
        media_root_id: string | null;
      }>;
      const scanParsedMediaIds = scanParsedRows.map((row) => row.media_file_id);
      const currentRootMediaIds = versions
        .filter((version) => version.rootId === String(scan.root_id))
        .flatMap((version) => version.mediaFileIds)
        .sort();
      if (new Set(scanParsedMediaIds).size !== scanParsedMediaIds.length)
        addFinding("SCAN_PARSED_MEDIA_ID_DUPLICATE");
      if (new Set(currentRootMediaIds).size !== currentRootMediaIds.length)
        addFinding("CURRENT_ROOT_MEDIA_ID_DUPLICATE");
      for (const row of scanParsedRows)
        if (
          row.scan_file_root_id !== String(scan.root_id) ||
          row.media_root_id !== String(scan.root_id)
        )
          addFinding("SCAN_MEDIA_ROOT_MISMATCH", null, null, row.media_file_id);
      const currentRootDigital = versions.filter(
        (version) =>
          version.rootId === String(scan.root_id) &&
          version.classification === "CURRENT_DIGITAL",
      ).length;
      if (Number(scan.album_count) !== currentRootDigital)
        addFinding("SCAN_ALBUM_COUNT_MISMATCH");
      if (Number(scan.parsed) !== scanParsedMediaIds.length)
        addFinding("SCAN_PARSED_FILE_COUNT_MISMATCH");
      if (
        scanParsedMediaIds.length !== currentRootMediaIds.length ||
        scanParsedMediaIds.some(
          (id, index) => id !== currentRootMediaIds[index],
        )
      )
        addFinding("SCAN_MEDIA_ID_MISMATCH");
      const partitionCount = countClosedInventoryPartitionEntries(
        versions.map((version) => version.classification),
      );
      if (partitionCount !== localVersionBaseCount)
        addFinding("PARTITION_COUNT_MISMATCH");

      const count = (
        classification: (typeof versions)[number]["classification"],
      ) =>
        versions.filter((version) => version.classification === classification)
          .length;
      const counts = {
        localVersions: localVersionBaseCount,
        currentDigital: count("CURRENT_DIGITAL"),
        physicalOnly: count("PHYSICAL_ONLY"),
        referencedHistory: count("REFERENCED_HISTORY"),
        orphan: count("ORPHAN"),
        physicalVersions: versions.filter(
          (version) => version.physicalCopyCount > 0,
        ).length,
        digitalPhysicalOverlap: versions.filter(
          (version) =>
            version.classification === "CURRENT_DIGITAL" &&
            version.physicalCopyCount > 0,
        ).length,
        physicalCopies: versions.reduce(
          (sum, version) => sum + version.physicalCopyCount,
          0,
        ),
        physicalQuantity: versions.reduce(
          (sum, version) => sum + version.physicalQuantity,
          0,
        ),
        libraryAlbums: libraryAlbums.length,
        displayedAlbums: libraryAlbums.filter((album) => album.displayed)
          .length,
        scanAlbumCount: Number(scan.album_count),
        scanParsedFiles: Number(scan.parsed),
      };
      return {
        schema: "cocean.library-inventory/v1" as const,
        scanJobId,
        rootId: String(scan.root_id),
        generatedAt: new Date().toISOString(),
        versions,
        libraryAlbums,
        scanParsedMediaIds,
        currentRootMediaIds,
        counts,
        findings,
        valid: findings.length === 0 && counts.orphan === 0,
      };
    })();
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
        label=excluded.label,
        catalog_number=excluded.catalog_number,
        barcode=excluded.barcode,
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
    this.raw.exec(
      "CREATE TEMP TABLE IF NOT EXISTS cocean_retained_album_ids(id TEXT PRIMARY KEY); DELETE FROM cocean_retained_album_ids;",
    );
    const rememberRetainedAlbum = this.raw.prepare(
      "INSERT OR IGNORE INTO cocean_retained_album_ids(id) VALUES (?)",
    );
    const auditReferences = readInventoryAuditVersionReferences(this.raw);
    for (const row of readInventoryVersionFactRows(this.raw)) {
      const localVersionId = String(row.id);
      if (
        zeroFileRetentionReasons(row, localVersionId, auditReferences).length >
        0
      )
        rememberRetainedAlbum.run(localVersionId);
    }
    this.raw
      .prepare(
        `DELETE FROM albums
         WHERE root_id = ?
           AND id NOT IN (SELECT id FROM cocean_current_album_ids)
           AND id NOT IN (SELECT id FROM cocean_retained_album_ids)
           AND NOT EXISTS (SELECT 1 FROM physical_copies WHERE physical_copies.album_id = albums.id)
          `,
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
      .prepare("SELECT id,primary_version_id FROM library_albums")
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
      metadataSignatures: new Map(
        groups.map((group) => [
          group.id,
          this.albumMetadataEffectiveSignature(group.id),
        ]),
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
         WHERE decision_source='USER' OR primary_version_source='USER'
            OR visibility='HIDDEN'
            OR EXISTS (SELECT 1 FROM library_change_plans lcp
                       WHERE lcp.library_album_id=library_albums.id)
            OR EXISTS (SELECT 1 FROM library_metadata_values mv
                       WHERE mv.scope_type='ALBUM' AND mv.owner_id=library_albums.id)
            OR EXISTS (SELECT 1 FROM library_metadata_event_groups meg
                       WHERE meg.library_album_id=library_albums.id)
            OR EXISTS (SELECT 1 FROM library_artwork_selections aws
                       WHERE aws.library_album_id=library_albums.id)
            OR EXISTS (SELECT 1 FROM library_artwork_event_groups aeg
                       WHERE aeg.library_album_id=library_albums.id)`,
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
                  OR visibility='HIDDEN'
                  OR EXISTS (SELECT 1 FROM library_change_plans lcp
                             WHERE lcp.library_album_id=library_albums.id)
                  OR EXISTS (SELECT 1 FROM library_metadata_values mv
                             WHERE mv.scope_type='ALBUM' AND mv.owner_id=library_albums.id)
                  OR EXISTS (SELECT 1 FROM library_metadata_event_groups meg
                             WHERE meg.library_album_id=library_albums.id)
                  OR EXISTS (SELECT 1 FROM library_artwork_selections aws
                             WHERE aws.library_album_id=library_albums.id)
                  OR EXISTS (SELECT 1 FROM library_artwork_event_groups aeg
                             WHERE aeg.library_album_id=library_albums.id)
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
             SELECT id FROM library_albums
             WHERE primary_version_source='USER' OR decision_source='USER'
                OR visibility='HIDDEN'
                OR EXISTS (SELECT 1 FROM library_change_plans lcp
                           WHERE lcp.library_album_id=library_albums.id)
                OR EXISTS (SELECT 1 FROM library_metadata_values mv
                           WHERE mv.scope_type='ALBUM' AND mv.owner_id=library_albums.id)
                OR EXISTS (SELECT 1 FROM library_metadata_event_groups meg
                           WHERE meg.library_album_id=library_albums.id)
                OR EXISTS (SELECT 1 FROM library_artwork_selections aws
                           WHERE aws.library_album_id=library_albums.id)
                OR EXISTS (SELECT 1 FROM library_artwork_event_groups aeg
                           WHERE aeg.library_album_id=library_albums.id)
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
      const currentPrimary = nullableString(protectedGroup.primary_version_id);
      if (!currentPrimary || !albumById.has(currentPrimary)) {
        const primary = [...additions].sort(comparePrimaryVersions)[0];
        if (primary)
          this.raw
            .prepare(
              `UPDATE library_albums
               SET title=?,album_artist=?,primary_version_id=?,revision=revision+1,updated_at=?
               WHERE id=?`,
            )
            .run(primary.title, primary.album_artist, primary.id, now, groupId);
      }
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
      this.bumpMetadataRevisionForEffectiveChange(
        groupId,
        baseline.metadataSignatures.get(groupId),
        now,
      );
      this.refreshEffectiveArtwork(groupId, Boolean(existing), now);
    }
    for (const group of protectedGroups) {
      const groupId = String(group.id);
      const memberIds = this.libraryIdentityMemberIds([groupId]);
      const members = memberIds
        .map((id) => albumById.get(id))
        .filter((album): album is Record<string, unknown> => Boolean(album));
      let primaryId = nullableString(
        (
          this.raw
            .prepare("SELECT primary_version_id FROM library_albums WHERE id=?")
            .get(groupId) as { primary_version_id: string | null }
        ).primary_version_id,
      );
      if (!memberIds.length) {
        const governedByLifecycle = Boolean(
          this.raw
            .prepare(
              "SELECT 1 FROM library_change_plans WHERE library_album_id=? LIMIT 1",
            )
            .get(groupId),
        );
        if (governedByLifecycle || group.visibility === "HIDDEN") {
          const previousMemberIds = baseline.members.get(groupId) ?? [];
          if (previousMemberIds.length || primaryId)
            this.raw
              .prepare(
                `UPDATE library_albums SET primary_version_id=NULL,
                   revision=revision+1,updated_at=? WHERE id=?`,
              )
              .run(now, groupId);
          this.raw
            .prepare("DELETE FROM library_issues WHERE library_album_id=?")
            .run(groupId);
          continue;
        }
      }
      if (!primaryId || !memberIds.includes(primaryId)) {
        if (group.decision_source === "AUTOMATIC" && members.length) {
          primaryId = String([...members].sort(comparePrimaryVersions)[0]!.id);
          this.raw
            .prepare(
              `UPDATE library_albums SET primary_version_id=?,revision=revision+1,updated_at=?
               WHERE id=?`,
            )
            .run(primaryId, now, groupId);
        } else
          throw new LibraryIdentityDecisionError(
            "IDENTITY_DECISION_CONFLICT",
            "人工主版本必须始终属于其稳定唱片",
          );
      }
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
      this.bumpMetadataRevisionForEffectiveChange(
        groupId,
        baseline.metadataSignatures.get(groupId),
        now,
      );
      this.refreshEffectiveArtwork(groupId, true, now);
    }
    this.raw
      .prepare(
        `DELETE FROM library_albums WHERE decision_source='AUTOMATIC'
      AND primary_version_source='AUTOMATIC'
      AND visibility='VISIBLE'
      AND NOT EXISTS (SELECT 1 FROM library_change_plans lcp
                      WHERE lcp.library_album_id=library_albums.id)
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

  private albumMetadataEffectiveSignature(libraryAlbumId: string): string {
    const metadata = this.getAlbumMetadata(libraryAlbumId);
    if (!metadata) return "";
    return JSON.stringify({
      title: [
        metadata.album.title.effectiveSource,
        metadata.album.title.effectiveValue,
      ],
      albumArtist: [
        metadata.album.albumArtist.effectiveSource,
        metadata.album.albumArtist.effectiveValue,
      ],
      year: [
        metadata.album.year.effectiveSource,
        metadata.album.year.effectiveValue,
      ],
      versions: metadata.versions.map((version) => ({
        versionId: version.versionId,
        fields: Object.fromEntries(
          Object.entries(version.fields).map(([field, value]) => [
            field,
            [value.effectiveSource, value.effectiveValue],
          ]),
        ),
      })),
    });
  }

  private bumpMetadataRevisionForEffectiveChange(
    libraryAlbumId: string,
    previousSignature: string | undefined,
    now: string,
  ): void {
    if (
      previousSignature !== undefined &&
      previousSignature !== this.albumMetadataEffectiveSignature(libraryAlbumId)
    )
      this.raw
        .prepare(
          "UPDATE library_albums SET metadata_revision=metadata_revision+1,updated_at=? WHERE id=?",
        )
        .run(now, libraryAlbumId);
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
    this.refreshMetadataIssueStatus(groupId);
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
      if (
        (command.type === "MERGE" || command.type === "SPLIT") &&
        this.groupsHaveActiveLifecyclePlans([sourceId])
      )
        throw new LibraryIdentityDecisionError(
          "IDENTITY_DECISION_CONFLICT",
          "唱片正在执行文件管理操作，请完成或处理后再调整版本关系",
        );
      const now = new Date().toISOString();
      const sourceMetadataSignature =
        this.albumMetadataEffectiveSignature(sourceId);
      let scope = [sourceId];
      let before = this.captureLibraryIdentitySnapshot(scope);
      let currentLibraryAlbumId = sourceId;
      let inheritedDecisionIds: string[] = [];
      let inheritedHistoryTargets: string[] = [];
      let mergeTargetMetadataSignature: string | null = null;

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
        if (this.groupsHaveActiveLifecyclePlans([targetId]))
          throw new LibraryIdentityDecisionError(
            "IDENTITY_DECISION_CONFLICT",
            "合并目标正在执行文件管理操作，请稍后再试",
          );
        const visibilityRows = this.raw
          .prepare(
            "SELECT id,visibility FROM library_albums WHERE id IN (?,?) ORDER BY id",
          )
          .all(sourceId, targetId) as Array<{
          id: string;
          visibility: "VISIBLE" | "HIDDEN";
        }>;
        if (
          visibilityRows.length !== 2 ||
          visibilityRows[0]!.visibility !== visibilityRows[1]!.visibility
        )
          throw new LibraryIdentityDecisionError(
            "IDENTITY_DECISION_CONFLICT",
            "两张唱片的显示状态不同，请先统一显示状态再合并",
          );
        mergeTargetMetadataSignature =
          this.albumMetadataEffectiveSignature(targetId);
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
        this.mergeAlbumMetadataOwnership(sourceId, targetId, now);
        this.mergeAlbumArtworkOwnership(sourceId, targetId, now);
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
        const sourceVisibility = this.raw
          .prepare(
            `SELECT visibility,visibility_revision,visibility_updated_at
             FROM library_albums WHERE id=?`,
          )
          .get(sourceId) as {
          visibility: "VISIBLE" | "HIDDEN";
          visibility_revision: number;
          visibility_updated_at: string | null;
        };
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
                    primary_version_source,revision,visibility,visibility_revision,
                    visibility_updated_at,created_at,updated_at)
                 VALUES (?,?,?,?,?,'USER',?,1,?,?,?,?,?)`,
              )
              .run(
                groupId,
                source.identityKey,
                primary.title,
                primary.album_artist,
                primaryVersionId,
                partition.primaryVersionId ? "USER" : "AUTOMATIC",
                sourceVisibility.visibility,
                sourceVisibility.visibility_revision,
                sourceVisibility.visibility_updated_at,
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
        this.inheritSplitAlbumMetadata(
          sourceId,
          createdIds.filter((id) => id !== sourceId),
          now,
        );
        this.inheritSplitAlbumArtwork(
          sourceId,
          createdIds.filter((id) => id !== sourceId),
          now,
        );
      }

      if (command.type === "SET_PRIMARY" || command.type === "SPLIT") {
        this.bumpMetadataRevisionForEffectiveChange(
          sourceId,
          sourceMetadataSignature,
          now,
        );
        this.refreshMetadataIssueStatus(sourceId);
        this.refreshEffectiveArtwork(sourceId, true, now);
      }
      if (command.type === "MERGE" && mergeTargetMetadataSignature !== null) {
        this.bumpMetadataRevisionForEffectiveChange(
          currentLibraryAlbumId,
          mergeTargetMetadataSignature,
          now,
        );
        this.refreshMetadataIssueStatus(currentLibraryAlbumId);
        this.refreshEffectiveArtwork(currentLibraryAlbumId, true, now);
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

  private mergeAlbumMetadataOwnership(
    sourceId: string,
    targetId: string,
    now: string,
  ): void {
    const rows = this.raw
      .prepare(
        `SELECT * FROM library_metadata_values
         WHERE scope_type='ALBUM' AND owner_id IN (?,?)
         ORDER BY field_name,source_type,owner_id`,
      )
      .all(sourceId, targetId) as Record<string, unknown>[];
    const sourceRows = rows.filter((row) => row.owner_id === sourceId);
    const targetRows = rows.filter((row) => row.owner_id === targetId);
    for (const source of sourceRows) {
      const target = targetRows.find(
        (row) =>
          row.field_name === source.field_name &&
          row.source_type === source.source_type,
      );
      if (target && target.value_json !== source.value_json)
        throw new LibraryIdentityDecisionError(
          "IDENTITY_DECISION_CONFLICT",
          `合并唱片的 ${String(source.field_name)} 人工或外部确认值冲突，请先处理字段冲突`,
        );
    }
    this.raw
      .prepare(
        `INSERT OR IGNORE INTO library_metadata_values
         (scope_type,owner_id,field_name,source_type,value_json,evidence_json,
          actor_id,actor_display_name,created_at,updated_at)
         SELECT scope_type,?,field_name,source_type,value_json,evidence_json,
                actor_id,actor_display_name,created_at,updated_at
         FROM library_metadata_values WHERE scope_type='ALBUM' AND owner_id=?`,
      )
      .run(targetId, sourceId);
    this.raw
      .prepare(
        "DELETE FROM library_metadata_values WHERE scope_type='ALBUM' AND owner_id=?",
      )
      .run(sourceId);
    this.raw
      .prepare(
        `INSERT OR IGNORE INTO library_metadata_event_groups(event_id,library_album_id)
         SELECT event_id,? FROM library_metadata_event_groups WHERE library_album_id=?`,
      )
      .run(targetId, sourceId);
  }

  private mergeAlbumArtworkOwnership(
    sourceId: string,
    targetId: string,
    now: string,
  ): void {
    const sourceSelection = this.captureArtworkSelection(sourceId);
    const targetSelection = this.captureArtworkSelection(targetId);
    if (
      sourceSelection.state &&
      targetSelection.state &&
      (sourceSelection.state !== targetSelection.state ||
        sourceSelection.assetSha256 !== targetSelection.assetSha256)
    )
      throw new LibraryIdentityDecisionError(
        "IDENTITY_DECISION_CONFLICT",
        "合并唱片的人工封面决定冲突，请先保留、隐藏或重置其中一张唱片的封面",
      );

    const candidates = this.raw
      .prepare(
        `SELECT c.*,a.mime_type,a.width,a.height,a.size_bytes,a.extension
         FROM library_artwork_candidates c
         JOIN library_artwork_assets a ON a.sha256=c.asset_sha256
         WHERE c.library_album_id=? ORDER BY c.id`,
      )
      .all(sourceId) as Record<string, unknown>[];
    const candidateIds = new Map<string, string>();
    for (const candidate of candidates) {
      const nextId = this.upsertArtworkCandidateInTransaction(
        targetId,
        {
          sha256: String(candidate.asset_sha256),
          mimeType: candidate.mime_type as ArtworkAssetInput["mimeType"],
          width: Number(candidate.width),
          height: Number(candidate.height),
          sizeBytes: Number(candidate.size_bytes),
          extension: candidate.extension as ArtworkAssetInput["extension"],
          source: candidate.source_type as ArtworkCandidateInput["source"],
          localVersionId: nullableString(candidate.local_version_id),
          relativePath: nullableString(candidate.relative_path),
          kind: nullableString(candidate.kind),
          evidence: {
            ...parseJson<Record<string, unknown>>(candidate.evidence_json, {}),
            inheritedFromLibraryAlbumId: sourceId,
          },
        },
        now,
      );
      candidateIds.set(String(candidate.id), nextId);
      if (!Boolean(candidate.is_current))
        this.raw
          .prepare(
            "UPDATE library_artwork_candidates SET is_current=0 WHERE id=?",
          )
          .run(nextId);
    }
    if (!targetSelection.state && sourceSelection.state) {
      this.restoreArtworkSelection({
        ...sourceSelection,
        libraryAlbumId: targetId,
        candidateId: sourceSelection.candidateId
          ? (candidateIds.get(sourceSelection.candidateId) ?? null)
          : null,
        updatedAt: now,
      });
    }
    this.raw
      .prepare(
        `INSERT OR IGNORE INTO library_artwork_event_groups(event_id,library_album_id)
         SELECT event_id,? FROM library_artwork_event_groups WHERE library_album_id=?`,
      )
      .run(targetId, sourceId);
  }

  private inheritSplitAlbumArtwork(
    sourceId: string,
    createdIds: string[],
    now: string,
  ): void {
    const selectedCandidateId =
      this.captureArtworkSelection(sourceId).candidateId;
    const candidates = this.raw
      .prepare(
        `SELECT c.*,a.mime_type,a.width,a.height,a.size_bytes,a.extension
         FROM library_artwork_candidates c
         JOIN library_artwork_assets a ON a.sha256=c.asset_sha256
         WHERE c.library_album_id=? AND c.local_version_id IS NOT NULL
         ORDER BY c.id`,
      )
      .all(sourceId) as Record<string, unknown>[];
    for (const createdId of createdIds) {
      const members = new Set(this.libraryIdentityMemberIds([createdId]));
      for (const candidate of candidates) {
        if (!members.has(String(candidate.local_version_id))) continue;
        const nextId = this.upsertArtworkCandidateInTransaction(
          createdId,
          {
            sha256: String(candidate.asset_sha256),
            mimeType: candidate.mime_type as ArtworkAssetInput["mimeType"],
            width: Number(candidate.width),
            height: Number(candidate.height),
            sizeBytes: Number(candidate.size_bytes),
            extension: candidate.extension as ArtworkAssetInput["extension"],
            source: candidate.source_type as ArtworkCandidateInput["source"],
            localVersionId: String(candidate.local_version_id),
            relativePath: nullableString(candidate.relative_path),
            kind: nullableString(candidate.kind),
            evidence: parseJson<Record<string, unknown>>(
              candidate.evidence_json,
              {},
            ),
          },
          now,
        );
        if (!Boolean(candidate.is_current))
          this.raw
            .prepare(
              "UPDATE library_artwork_candidates SET is_current=0 WHERE id=?",
            )
            .run(nextId);
        if (String(candidate.id) !== selectedCandidateId)
          this.raw
            .prepare(
              `UPDATE library_artwork_candidates SET is_current=0,updated_at=?
               WHERE id=?`,
            )
            .run(now, String(candidate.id));
      }
      this.refreshEffectiveArtwork(createdId, false, now);
    }
  }

  private inheritSplitAlbumMetadata(
    sourceId: string,
    createdIds: string[],
    now: string,
  ): void {
    const external = this.raw
      .prepare(
        `SELECT * FROM library_metadata_values
         WHERE scope_type='ALBUM' AND owner_id=? AND source_type='CONFIRMED_EXTERNAL'`,
      )
      .all(sourceId) as Record<string, unknown>[];
    for (const createdId of createdIds) {
      const metadata = this.getAlbumMetadata(createdId);
      if (!metadata) continue;
      const before = this.albumMetadataEffectiveSignature(createdId);
      const memberIds = new Set(
        metadata.versions.map((version) => version.versionId),
      );
      for (const row of external) {
        const evidence = parseJson<Record<string, unknown>>(
          row.evidence_json,
          {},
        );
        if (!memberIds.has(String(evidence.localVersionId ?? ""))) continue;
        this.raw
          .prepare(
            `INSERT INTO library_metadata_values
             (scope_type,owner_id,field_name,source_type,value_json,evidence_json,
              actor_id,actor_display_name,created_at,updated_at)
             VALUES ('ALBUM',?,?, 'CONFIRMED_EXTERNAL',?,?,?,?,?,?)`,
          )
          .run(
            createdId,
            row.field_name,
            row.value_json,
            row.evidence_json,
            row.actor_id,
            row.actor_display_name,
            row.created_at,
            row.updated_at,
          );
      }
      const events = this.raw
        .prepare(
          `SELECT e.id,e.input_json,e.commands_json FROM library_metadata_events e
           JOIN library_metadata_event_groups g ON g.event_id=e.id
           WHERE g.library_album_id=? ORDER BY e.rowid`,
        )
        .all(sourceId) as Record<string, unknown>[];
      const associate = this.raw.prepare(
        `INSERT OR IGNORE INTO library_metadata_event_groups(event_id,library_album_id)
         VALUES (?,?)`,
      );
      for (const event of events) {
        const commands = parseJson<MetadataCommand[]>(event.commands_json, []);
        const input = parseJson<{
          commands?: Array<{ localVersionId?: string }>;
        }>(event.input_json, {});
        const applies =
          commands.some(
            (command) => command.versionId && memberIds.has(command.versionId),
          ) ||
          input.commands?.some(
            (item) => item.localVersionId && memberIds.has(item.localVersionId),
          );
        if (applies) associate.run(event.id, createdId);
      }
      this.bumpMetadataRevisionForEffectiveChange(createdId, before, now);
      this.refreshMetadataIssueStatus(createdId);
    }
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
        { groups: [], aliases: [], albumMetadataValues: [] },
      );
      const beforeUndo = this.captureLibraryIdentitySnapshot(scope);
      if (!sameLibraryIdentityGovernance(beforeUndo, expectedAfter))
        throw new LibraryIdentityDecisionError(
          "IDENTITY_DECISION_CONFLICT",
          "唱片身份状态已被后续决定覆盖，不能静默撤销",
        );
      const restore = parseJson<LibraryIdentitySnapshot>(
        row.before_state_json,
        { groups: [], aliases: [], albumMetadataValues: [] },
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
        expectedAfter,
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
    if (!scope.length)
      return { groups: [], aliases: [], albumMetadataValues: [] };
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
        metadataRevision: Number(row.metadata_revision ?? 0),
        artworkRevision: Number(row.artwork_revision ?? 0),
        effectiveArtworkJson: String(
          row.effective_artwork_json ?? JSON.stringify(emptyArtworkValue()),
        ),
        effectiveArtworkSource: String(
          row.effective_artwork_source ?? "NONE",
        ) as AlbumArtworkGovernance["selectionSource"],
        artworkSelection: this.captureArtworkSelection(String(row.id)),
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
    const albumMetadataValues = groupIds.length
      ? (
          this.raw
            .prepare(
              `SELECT * FROM library_metadata_values
               WHERE scope_type='ALBUM' AND owner_id IN (${groupIds.map(() => "?").join(",")})
               ORDER BY owner_id,field_name,source_type`,
            )
            .all(...groupIds) as Record<string, unknown>[]
        ).map(mapStoredMetadataValue)
      : [];
    return { groups, aliases, albumMetadataValues };
  }

  private restoreLibraryIdentitySnapshot(
    snapshot: LibraryIdentitySnapshot,
    scope: string[],
    revision: number,
    now: string,
    currentFacts: LibraryIdentitySnapshot,
    expectedAfter: LibraryIdentitySnapshot,
  ): void {
    const current = this.captureLibraryIdentitySnapshot(scope);
    const groupIds = current.groups.map((group) => group.id);
    const preservedArtworkCandidates = groupIds.length
      ? (this.raw
          .prepare(
            `SELECT * FROM library_artwork_candidates
             WHERE library_album_id IN (${groupIds.map(() => "?").join(",")})
             ORDER BY id`,
          )
          .all(...groupIds) as Record<string, unknown>[])
      : [];
    const selectionChangedSinceDecision = !sameArtworkSelections(
      current,
      expectedAfter,
    );
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
              primary_version_source,revision,metadata_revision,artwork_revision,
              effective_artwork_json,effective_artwork_source,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          Math.max(
            currentGroup?.metadataRevision ?? group.metadataRevision,
            group.metadataRevision,
          ),
          Math.max(
            currentGroup?.artworkRevision ?? group.artworkRevision ?? 0,
            group.artworkRevision ?? 0,
          ),
          currentGroup?.effectiveArtworkJson ??
            group.effectiveArtworkJson ??
            JSON.stringify(emptyArtworkValue()),
          currentGroup?.effectiveArtworkSource ??
            group.effectiveArtworkSource ??
            "NONE",
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
    const restoredIds = new Set(snapshot.groups.map((group) => group.id));
    const memberOwner = new Map<string, string>();
    for (const group of snapshot.groups)
      for (const member of group.members)
        memberOwner.set(member.albumId, group.id);
    for (const candidate of preservedArtworkCandidates) {
      let ownerId = String(candidate.library_album_id);
      const localVersionId = nullableString(candidate.local_version_id);
      if (localVersionId && memberOwner.has(localVersionId))
        ownerId = memberOwner.get(localVersionId)!;
      else if (!restoredIds.has(ownerId)) {
        if (restoredIds.size !== 1)
          throw new LibraryIdentityDecisionError(
            "IDENTITY_DECISION_CONFLICT",
            "身份撤销后无法确定后续封面候选的归属",
          );
        ownerId = [...restoredIds][0]!;
      }
      this.raw
        .prepare(
          `INSERT INTO library_artwork_candidates
           (id,library_album_id,local_version_id,asset_sha256,source_type,
            relative_path,kind,evidence_json,is_current,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          candidate.id,
          ownerId,
          candidate.local_version_id,
          candidate.asset_sha256,
          candidate.source_type,
          candidate.relative_path,
          candidate.kind,
          candidate.evidence_json,
          candidate.is_current,
          candidate.created_at,
          candidate.updated_at,
        );
    }
    const selections = selectionChangedSinceDecision
      ? current.groups
          .map((group) => group.artworkSelection)
          .filter((selection): selection is ArtworkSelectionSnapshot =>
            Boolean(selection?.state),
          )
      : snapshot.groups
          .map((group) => group.artworkSelection)
          .filter((selection): selection is ArtworkSelectionSnapshot =>
            Boolean(selection?.state),
          );
    for (const selection of selections) {
      let ownerId = selection.libraryAlbumId;
      if (!restoredIds.has(ownerId)) {
        if (restoredIds.size !== 1)
          throw new LibraryIdentityDecisionError(
            "IDENTITY_DECISION_CONFLICT",
            "身份撤销会让后续人工封面决定失去唯一归属",
          );
        ownerId = [...restoredIds][0]!;
      }
      this.restoreArtworkSelection({
        ...selection,
        libraryAlbumId: ownerId,
        updatedAt: now,
      });
    }
    for (const group of snapshot.groups)
      this.refreshEffectiveArtwork(group.id, false, now);
    for (const alias of snapshot.aliases)
      this.raw
        .prepare(
          `INSERT INTO library_album_aliases(alias_id,library_album_id,created_at)
           VALUES (?,?,?)`,
        )
        .run(alias.aliasId, alias.libraryAlbumId, alias.createdAt);
    this.reconcileAlbumMetadataAfterIdentityUndo(
      snapshot,
      expectedAfter,
      currentFacts,
      now,
    );
  }

  private reconcileAlbumMetadataAfterIdentityUndo(
    restore: LibraryIdentitySnapshot,
    expectedAfter: LibraryIdentitySnapshot,
    current: LibraryIdentitySnapshot,
    now: string,
  ): void {
    const restoredIds = new Set(restore.groups.map((group) => group.id));
    const key = (value: StoredMetadataValue) =>
      `${value.ownerId}\0${value.fieldName}\0${value.sourceType}`;
    const same = (left: StoredMetadataValue, right: StoredMetadataValue) =>
      left.valueJson === right.valueJson &&
      left.evidenceJson === right.evidenceJson &&
      left.actorId === right.actorId &&
      left.actorDisplayName === right.actorDisplayName &&
      left.updatedAt === right.updatedAt;
    const expected = new Map(
      (expectedAfter.albumMetadataValues ?? []).map((value) => [
        key(value),
        value,
      ]),
    );
    const preserved = (current.albumMetadataValues ?? []).filter((value) => {
      const prior = expected.get(key(value));
      return !prior || !same(value, prior);
    });
    const final = new Map(
      (restore.albumMetadataValues ?? []).map((value) => [key(value), value]),
    );
    const currentKeys = new Set(
      (current.albumMetadataValues ?? []).map((value) => key(value)),
    );
    for (const removed of expected.values()) {
      if (currentKeys.has(key(removed))) continue;
      for (const [candidateKey, candidate] of final)
        if (
          candidate.fieldName === removed.fieldName &&
          candidate.sourceType === removed.sourceType
        )
          final.delete(candidateKey);
    }
    for (const value of preserved) {
      let next = value;
      if (!restoredIds.has(value.ownerId)) {
        if (restoredIds.size !== 1)
          throw new LibraryIdentityDecisionError(
            "IDENTITY_DECISION_CONFLICT",
            "身份撤销后无法确定后续元数据事件的归属",
          );
        const ownerId = [...restoredIds][0]!;
        next = { ...value, ownerId };
        const collision = final.get(key(next));
        if (collision && !same(collision, next))
          throw new LibraryIdentityDecisionError(
            "IDENTITY_DECISION_CONFLICT",
            "身份撤销会造成后续元数据字段冲突",
          );
        this.raw
          .prepare(
            `INSERT OR IGNORE INTO library_metadata_event_groups(event_id,library_album_id)
             SELECT event_id,? FROM library_metadata_event_groups WHERE library_album_id=?`,
          )
          .run(ownerId, value.ownerId);
      }
      final.set(key(next), next);
    }
    const owners = [
      ...new Set([
        ...(restore.albumMetadataValues ?? []).map((value) => value.ownerId),
        ...(expectedAfter.albumMetadataValues ?? []).map(
          (value) => value.ownerId,
        ),
        ...(current.albumMetadataValues ?? []).map((value) => value.ownerId),
      ]),
    ];
    if (owners.length)
      this.raw
        .prepare(
          `DELETE FROM library_metadata_values
           WHERE scope_type='ALBUM' AND owner_id IN (${owners.map(() => "?").join(",")})`,
        )
        .run(...owners);
    const insert = this.raw.prepare(
      `INSERT INTO library_metadata_values
       (scope_type,owner_id,field_name,source_type,value_json,evidence_json,
        actor_id,actor_display_name,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const value of final.values())
      insert.run(
        value.scopeType,
        value.ownerId,
        value.fieldName,
        value.sourceType,
        value.valueJson,
        value.evidenceJson,
        value.actorId,
        value.actorDisplayName,
        value.createdAt,
        value.updatedAt,
      );
    for (const groupId of restoredIds) {
      this.raw
        .prepare(
          "UPDATE library_albums SET metadata_revision=metadata_revision+1,updated_at=? WHERE id=?",
        )
        .run(now, groupId);
      this.refreshMetadataIssueStatus(groupId);
      const members = new Set(this.libraryIdentityMemberIds([groupId]));
      const events = this.raw
        .prepare(
          "SELECT id,input_json,commands_json FROM library_metadata_events ORDER BY rowid",
        )
        .all() as Record<string, unknown>[];
      const associate = this.raw.prepare(
        `INSERT OR IGNORE INTO library_metadata_event_groups(event_id,library_album_id)
         VALUES (?,?)`,
      );
      for (const event of events) {
        const commands = parseJson<MetadataCommand[]>(event.commands_json, []);
        const input = parseJson<{
          commands?: Array<{ localVersionId?: string }>;
        }>(event.input_json, {});
        if (
          commands.some(
            (command) => command.versionId && members.has(command.versionId),
          ) ||
          input.commands?.some(
            (item) => item.localVersionId && members.has(item.localVersionId),
          )
        )
          associate.run(event.id, groupId);
      }
    }
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
        { groups: [], aliases: [], albumMetadataValues: [] },
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

  getAlbumMetadata(albumId: string): AlbumMetadata | null {
    const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
    if (!libraryAlbumId) return null;
    const group = this.raw
      .prepare(
        "SELECT primary_version_id,metadata_revision FROM library_albums WHERE id=?",
      )
      .get(libraryAlbumId) as
      { primary_version_id: string; metadata_revision: number } | undefined;
    if (!group?.primary_version_id) return null;
    const versionIds = this.libraryIdentityMemberIds([libraryAlbumId]);
    const versions = this.raw
      .prepare(
        `SELECT a.id,a.title,a.album_artist,a.year,a.label,a.catalog_number,a.barcode,
                NULL AS observed_country,
                (SELECT MIN(NULLIF(trim(mf.date_text),''))
                 FROM album_files af JOIN media_files mf ON mf.id=af.media_file_id
                 WHERE af.album_id=a.id AND af.is_primary=1) AS observed_release_date
         FROM albums a WHERE a.id IN (${versionIds.map(() => "?").join(",")}) ORDER BY a.id`,
      )
      .all(...versionIds) as Record<string, unknown>[];
    const primary = versions.find(
      (version) => String(version.id) === group.primary_version_id,
    );
    if (!primary) return null;
    const stored = this.metadataValuesFor(libraryAlbumId, versionIds);
    const state = (
      scopeType: "ALBUM" | "VERSION",
      ownerId: string,
      fieldName: MetadataField,
      observedValue: string | number | null,
      observedSource: "OBSERVED_TAG" | "PATH_FALLBACK",
      versionId: string,
    ): MetadataFieldState => {
      const rows = stored.filter(
        (row) =>
          row.scopeType === scopeType &&
          row.ownerId === ownerId &&
          row.fieldName === fieldName,
      );
      const external = rows.find(
        (row) => row.sourceType === "CONFIRMED_EXTERNAL",
      );
      const override = rows.find((row) => row.sourceType === "USER_OVERRIDE");
      const externalEvidence = external
        ? parseJson<Record<string, unknown>>(external.evidenceJson, {})
        : {};
      const externalValue = external
        ? parseMetadataJson(external.valueJson)
        : null;
      const overrideValue = override
        ? parseMetadataJson(override.valueJson)
        : null;
      return {
        observed: {
          value: observedValue,
          source: observedSource,
          versionId,
        },
        confirmedExternal: external
          ? {
              value: externalValue,
              provider: String(externalEvidence.provider ?? "UNKNOWN"),
              candidateId: String(externalEvidence.candidateId ?? ""),
              confirmedAt: external.updatedAt,
            }
          : null,
        userOverride: override
          ? {
              value: overrideValue,
              actor: {
                id: override.actorId ?? "system",
                displayName: override.actorDisplayName ?? "系统迁移",
              },
              updatedAt: override.updatedAt,
            }
          : null,
        effectiveValue: override
          ? overrideValue
          : external
            ? externalValue
            : observedValue,
        effectiveSource: override
          ? "USER_OVERRIDE"
          : external
            ? "CONFIRMED_EXTERNAL"
            : observedSource,
      };
    };
    const albumObservedSource = (field: "title" | "albumArtist" | "year") =>
      field === "year"
        ? ("OBSERVED_TAG" as const)
        : this.observedIdentitySource(group.primary_version_id, field);
    return {
      libraryAlbumId,
      metadataRevision: Number(group.metadata_revision),
      album: {
        title: state(
          "ALBUM",
          libraryAlbumId,
          "title",
          String(primary.title),
          albumObservedSource("title"),
          group.primary_version_id,
        ),
        albumArtist: state(
          "ALBUM",
          libraryAlbumId,
          "albumArtist",
          String(primary.album_artist),
          albumObservedSource("albumArtist"),
          group.primary_version_id,
        ),
        year: state(
          "ALBUM",
          libraryAlbumId,
          "year",
          nullableNumber(primary.year),
          albumObservedSource("year"),
          group.primary_version_id,
        ),
      },
      versions: versions.map((version) => {
        const versionId = String(version.id);
        const versionState = (
          field: MetadataField,
          column: keyof typeof version,
        ) =>
          state(
            "VERSION",
            versionId,
            field,
            nullableString(version[column]),
            "OBSERVED_TAG",
            versionId,
          );
        return {
          versionId,
          fields: {
            label: versionState("label", "label"),
            catalogNumber: versionState("catalogNumber", "catalog_number"),
            barcode: versionState("barcode", "barcode"),
            country: versionState("country", "observed_country"),
            releaseDate: versionState("releaseDate", "observed_release_date"),
          },
        };
      }),
      observedIssues: this.listLibraryIssues(libraryAlbumId, undefined, true),
    };
  }

  applyAlbumMetadata(
    albumId: string,
    command: UpdateAlbumMetadataCommand,
    actor: LibraryIdentityActor,
  ): AlbumMetadataMutationResult {
    return this.raw.transaction(() => {
      const inputJson = canonicalMetadataInput(
        albumId,
        command.expectedMetadataRevision,
        command.commands,
      );
      const replay = this.metadataResultByRequestId(
        command.requestId,
        inputJson,
      );
      if (replay) return replay;
      const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
      if (!libraryAlbumId)
        throw new AlbumMetadataDecisionError(
          "METADATA_DECISION_CONFLICT",
          "唱片已经不存在或无法解析",
        );
      const normalized = this.normalizeMetadataCommands(
        libraryAlbumId,
        command.commands,
      );
      this.assertMetadataRevision(
        libraryAlbumId,
        command.expectedMetadataRevision,
      );
      const before = this.captureAlbumMetadataSnapshot(libraryAlbumId);
      const now = new Date().toISOString();
      for (const item of normalized) {
        const scopeType = isAlbumMetadataField(item.field)
          ? "ALBUM"
          : "VERSION";
        const ownerId =
          scopeType === "ALBUM" ? libraryAlbumId : item.versionId!;
        if (item.action === "RESET") {
          this.raw
            .prepare(
              `DELETE FROM library_metadata_values
               WHERE scope_type=? AND owner_id=? AND field_name=? AND source_type='USER_OVERRIDE'`,
            )
            .run(scopeType, ownerId, item.field);
        } else {
          this.raw
            .prepare(
              `INSERT INTO library_metadata_values
                 (scope_type,owner_id,field_name,source_type,value_json,evidence_json,
                  actor_id,actor_display_name,created_at,updated_at)
               VALUES (?,?,?,'USER_OVERRIDE',?,'{}',?,?,?,?)
               ON CONFLICT(scope_type,owner_id,field_name,source_type) DO UPDATE SET
                 value_json=excluded.value_json,actor_id=excluded.actor_id,
                 actor_display_name=excluded.actor_display_name,updated_at=excluded.updated_at`,
            )
            .run(
              scopeType,
              ownerId,
              item.field,
              item.action === "CLEAR" ? null : JSON.stringify(item.value),
              actor.id,
              actor.displayName,
              now,
              now,
            );
        }
      }
      this.raw
        .prepare(
          "UPDATE library_albums SET metadata_revision=metadata_revision+1,updated_at=? WHERE id=?",
        )
        .run(now, libraryAlbumId);
      this.refreshMetadataIssueStatus(libraryAlbumId);
      const after = this.captureAlbumMetadataSnapshot(libraryAlbumId);
      return this.recordAlbumMetadataEvent({
        requestId: command.requestId,
        inputJson,
        libraryAlbumId,
        type: "UPDATE",
        actor,
        expectedMetadataRevision: command.expectedMetadataRevision,
        commands: normalized,
        before,
        after,
        compensatesEventId: null,
        createdAt: now,
      });
    })();
  }

  listAlbumMetadataHistory(albumId: string): AlbumMetadataEvent[] {
    const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
    if (!libraryAlbumId) return [];
    return (
      this.raw
        .prepare(
          `SELECT * FROM library_metadata_events
           WHERE EXISTS (
             SELECT 1 FROM library_metadata_event_groups g
             WHERE g.event_id=library_metadata_events.id AND g.library_album_id=?
           ) ORDER BY rowid DESC LIMIT 100`,
        )
        .all(libraryAlbumId) as Record<string, unknown>[]
    ).map((row) => this.mapAlbumMetadataEvent(row, libraryAlbumId));
  }

  undoAlbumMetadataEvent(
    albumId: string,
    eventId: string,
    requestId: string,
    expectedMetadataRevision: number,
    actor: LibraryIdentityActor,
  ): AlbumMetadataMutationResult {
    return this.raw.transaction(() => {
      const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
      if (!libraryAlbumId)
        throw new AlbumMetadataDecisionError(
          "METADATA_DECISION_CONFLICT",
          "唱片已经不存在或无法解析",
        );
      const inputJson = canonicalMetadataInput(
        albumId,
        expectedMetadataRevision,
        [{ action: "RESET", field: "title", eventId }],
      );
      const replay = this.metadataResultByRequestId(requestId, inputJson);
      if (replay) return replay;
      this.assertMetadataRevision(libraryAlbumId, expectedMetadataRevision);
      const row = this.raw
        .prepare("SELECT * FROM library_metadata_events WHERE id=?")
        .get(eventId) as Record<string, unknown> | undefined;
      if (
        !row ||
        !this.raw
          .prepare(
            "SELECT 1 FROM library_metadata_event_groups WHERE event_id=? AND library_album_id=?",
          )
          .get(eventId, libraryAlbumId) ||
        row.event_type === "UNDO" ||
        this.raw
          .prepare(
            "SELECT 1 FROM library_metadata_events WHERE compensates_event_id=?",
          )
          .get(eventId)
      )
        throw new AlbumMetadataDecisionError(
          "METADATA_DECISION_CONFLICT",
          "只能撤销当前唱片最新且仍有效的元数据事件",
        );
      const before = this.captureAlbumMetadataSnapshot(libraryAlbumId);
      const expectedAfter = parseJson<AlbumMetadataSnapshot>(
        row.after_state_json,
        { libraryAlbumId, memberVersionIds: [], values: [] },
      );
      if (
        Number(row.resulting_metadata_revision) !== expectedMetadataRevision ||
        JSON.stringify(before) !== JSON.stringify(expectedAfter)
      )
        throw new AlbumMetadataDecisionError(
          "METADATA_DECISION_CONFLICT",
          "元数据状态已被后续事件或身份变化覆盖，不能静默撤销",
        );
      const restore = parseJson<AlbumMetadataSnapshot>(row.before_state_json, {
        libraryAlbumId,
        memberVersionIds: [],
        values: [],
      });
      if (
        restore.libraryAlbumId !== libraryAlbumId ||
        JSON.stringify(restore.memberVersionIds) !==
          JSON.stringify(before.memberVersionIds)
      )
        throw new AlbumMetadataDecisionError(
          "METADATA_DECISION_CONFLICT",
          "唱片成员已经变化，无法无冲突恢复字段归属",
        );
      this.restoreAlbumMetadataSnapshot(restore);
      const now = new Date().toISOString();
      this.raw
        .prepare(
          "UPDATE library_albums SET metadata_revision=metadata_revision+1,updated_at=? WHERE id=?",
        )
        .run(now, libraryAlbumId);
      this.refreshMetadataIssueStatus(libraryAlbumId);
      const after = this.captureAlbumMetadataSnapshot(libraryAlbumId);
      return this.recordAlbumMetadataEvent({
        requestId,
        inputJson,
        libraryAlbumId,
        type: "UNDO",
        actor,
        expectedMetadataRevision,
        commands: parseJson<MetadataCommand[]>(row.commands_json, []),
        before,
        after,
        compensatesEventId: eventId,
        createdAt: now,
      });
    })();
  }

  private normalizeMetadataCommands(
    libraryAlbumId: string,
    commands: MetadataCommand[],
  ): MetadataCommand[] {
    const members = new Set(this.libraryIdentityMemberIds([libraryAlbumId]));
    const seen = new Set<string>();
    return commands.map((command) => {
      const albumField = isAlbumMetadataField(command.field);
      if (albumField && command.versionId)
        throw new AlbumMetadataDecisionError(
          "INVALID_METADATA_DECISION",
          `${command.field} 是唱片级字段，不能指定本地版本`,
        );
      if (
        !albumField &&
        (!command.versionId || !members.has(command.versionId))
      )
        throw new AlbumMetadataDecisionError(
          "METADATA_DECISION_CONFLICT",
          `${command.field} 的目标版本已不属于当前唱片`,
        );
      const key = `${command.versionId ?? libraryAlbumId}\0${command.field}`;
      if (seen.has(key))
        throw new AlbumMetadataDecisionError(
          "INVALID_METADATA_DECISION",
          "同一请求不能重复修改同一个字段",
        );
      seen.add(key);
      if (
        command.action === "CLEAR" &&
        (command.field === "title" || command.field === "albumArtist")
      )
        throw new AlbumMetadataDecisionError(
          "INVALID_METADATA_DECISION",
          "标题和专辑艺术家不能显式清空",
        );
      if (command.action !== "SET") return command;
      return {
        ...command,
        value: normalizeMetadataValue(command.field, command.value),
      };
    });
  }

  private assertMetadataRevision(
    libraryAlbumId: string,
    expected: number,
  ): void {
    const row = this.raw
      .prepare("SELECT metadata_revision FROM library_albums WHERE id=?")
      .get(libraryAlbumId) as { metadata_revision: number } | undefined;
    if (!row || Number(row.metadata_revision) !== expected)
      throw new AlbumMetadataDecisionError(
        "METADATA_DECISION_CONFLICT",
        "元数据 revision 已变化，请刷新后重试",
      );
  }

  private metadataValuesFor(
    libraryAlbumId: string,
    versionIds: string[],
  ): StoredMetadataValue[] {
    const placeholders = versionIds.map(() => "?").join(",");
    const rows = this.raw
      .prepare(
        `SELECT * FROM library_metadata_values
         WHERE (scope_type='ALBUM' AND owner_id=?)
            OR (scope_type='VERSION' AND owner_id IN (${placeholders}))
         ORDER BY scope_type,owner_id,field_name,source_type`,
      )
      .all(libraryAlbumId, ...versionIds) as Record<string, unknown>[];
    return rows.map(mapStoredMetadataValue);
  }

  private captureAlbumMetadataSnapshot(
    libraryAlbumId: string,
  ): AlbumMetadataSnapshot {
    const memberVersionIds = this.libraryIdentityMemberIds([libraryAlbumId]);
    return {
      libraryAlbumId,
      memberVersionIds,
      values: this.metadataValuesFor(libraryAlbumId, memberVersionIds),
      releaseMatchStates: memberVersionIds.map((versionId) => {
        const row = this.raw
          .prepare(
            "SELECT match_status,musicbrainz_release_id FROM albums WHERE id=?",
          )
          .get(versionId) as Record<string, unknown>;
        return {
          versionId,
          matchStatus: row.match_status as AlbumSummary["matchStatus"],
          musicBrainzReleaseId: nullableString(row.musicbrainz_release_id),
        };
      }),
    };
  }

  private restoreAlbumMetadataSnapshot(snapshot: AlbumMetadataSnapshot): void {
    const placeholders = snapshot.memberVersionIds.map(() => "?").join(",");
    this.raw
      .prepare(
        `DELETE FROM library_metadata_values
         WHERE (scope_type='ALBUM' AND owner_id=?)
            OR (scope_type='VERSION' AND owner_id IN (${placeholders}))`,
      )
      .run(snapshot.libraryAlbumId, ...snapshot.memberVersionIds);
    const insert = this.raw.prepare(
      `INSERT INTO library_metadata_values
       (scope_type,owner_id,field_name,source_type,value_json,evidence_json,
        actor_id,actor_display_name,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const value of snapshot.values)
      insert.run(
        value.scopeType,
        value.ownerId,
        value.fieldName,
        value.sourceType,
        value.valueJson,
        value.evidenceJson,
        value.actorId,
        value.actorDisplayName,
        value.createdAt,
        value.updatedAt,
      );
    for (const state of snapshot.releaseMatchStates ?? [])
      this.raw
        .prepare(
          "UPDATE albums SET match_status=?,musicbrainz_release_id=? WHERE id=?",
        )
        .run(state.matchStatus, state.musicBrainzReleaseId, state.versionId);
  }

  private recordAlbumMetadataEvent(input: {
    requestId: string;
    inputJson: string;
    libraryAlbumId: string;
    type: AlbumMetadataEvent["type"];
    actor: LibraryIdentityActor;
    expectedMetadataRevision: number;
    commands: MetadataCommand[];
    before: AlbumMetadataSnapshot;
    after: AlbumMetadataSnapshot;
    compensatesEventId: string | null;
    createdAt: string;
    resultExtra?: Record<string, unknown>;
  }): AlbumMetadataMutationResult {
    const id = randomUUID();
    const metadata = this.getAlbumMetadata(input.libraryAlbumId)!;
    this.raw
      .prepare(
        `INSERT INTO library_metadata_events
         (id,request_id,library_album_id,event_type,actor_id,actor_display_name,
          expected_metadata_revision,resulting_metadata_revision,input_json,commands_json,
          before_state_json,after_state_json,result_json,compensates_event_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.requestId,
        input.libraryAlbumId,
        input.type,
        input.actor.id,
        input.actor.displayName,
        input.expectedMetadataRevision,
        metadata.metadataRevision,
        input.inputJson,
        JSON.stringify(input.commands),
        JSON.stringify(input.before),
        JSON.stringify(input.after),
        JSON.stringify({ metadata, ...input.resultExtra }),
        input.compensatesEventId,
        input.createdAt,
      );
    this.raw
      .prepare(
        "INSERT INTO library_metadata_event_groups(event_id,library_album_id) VALUES (?,?)",
      )
      .run(id, input.libraryAlbumId);
    return {
      metadata,
      event: this.mapAlbumMetadataEvent(
        this.raw
          .prepare("SELECT * FROM library_metadata_events WHERE id=?")
          .get(id) as Record<string, unknown>,
        input.libraryAlbumId,
      ),
    };
  }

  private metadataResultByRequestId(
    requestId: string,
    inputJson: string,
  ): AlbumMetadataMutationResult | null {
    const row = this.raw
      .prepare("SELECT * FROM library_metadata_events WHERE request_id=?")
      .get(requestId) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (String(row.input_json) !== inputJson)
      throw new AlbumMetadataDecisionError(
        "METADATA_DECISION_CONFLICT",
        "requestId 已用于不同的元数据请求",
      );
    const stored = parseJson<{ metadata: AlbumMetadata }>(row.result_json, {
      metadata: this.getAlbumMetadata(String(row.library_album_id))!,
    });
    return {
      metadata: stored.metadata,
      event: this.mapAlbumMetadataEvent(
        row,
        this.resolveLibraryAlbumId(String(row.library_album_id)) ??
          String(row.library_album_id),
      ),
    };
  }

  private mapAlbumMetadataEvent(
    row: Record<string, unknown>,
    historyLibraryAlbumId: string,
  ): AlbumMetadataEvent {
    const latest = this.raw
      .prepare(
        `SELECT e.id FROM library_metadata_events e
         WHERE EXISTS (SELECT 1 FROM library_metadata_event_groups g
           WHERE g.event_id=e.id AND g.library_album_id=?)
         ORDER BY e.rowid DESC LIMIT 1`,
      )
      .get(historyLibraryAlbumId) as { id: string } | undefined;
    const compensated = Boolean(
      this.raw
        .prepare(
          "SELECT 1 FROM library_metadata_events WHERE compensates_event_id=?",
        )
        .get(String(row.id)),
    );
    const group = this.raw
      .prepare("SELECT metadata_revision FROM library_albums WHERE id=?")
      .get(historyLibraryAlbumId) as { metadata_revision: number } | undefined;
    const expectedAfter = parseJson<AlbumMetadataSnapshot>(
      row.after_state_json,
      {
        libraryAlbumId: historyLibraryAlbumId,
        memberVersionIds: [],
        values: [],
      },
    );
    const canUndo =
      row.event_type !== "UNDO" &&
      !compensated &&
      latest?.id === String(row.id) &&
      Number(group?.metadata_revision) ===
        Number(row.resulting_metadata_revision) &&
      JSON.stringify(
        this.captureAlbumMetadataSnapshot(historyLibraryAlbumId),
      ) === JSON.stringify(expectedAfter);
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      libraryAlbumId: String(row.library_album_id),
      type: row.event_type as AlbumMetadataEvent["type"],
      actor: {
        id: String(row.actor_id),
        displayName: String(row.actor_display_name),
      },
      expectedMetadataRevision: Number(row.expected_metadata_revision),
      resultingMetadataRevision: Number(row.resulting_metadata_revision),
      commands: parseJson<MetadataCommand[]>(row.commands_json, []),
      compensatesEventId: nullableString(row.compensates_event_id),
      canUndo,
      createdAt: String(row.created_at),
    };
  }

  private observedIdentitySource(
    versionId: string,
    field: "title" | "albumArtist",
  ): "OBSERVED_TAG" | "PATH_FALLBACK" {
    const expression =
      field === "title"
        ? "trim(COALESCE(media_files.album,'')) <> ''"
        : "trim(COALESCE(media_files.album_artist,'')) <> '' OR json_array_length(media_files.artists_json)>0";
    return this.raw
      .prepare(
        `SELECT 1 FROM album_files JOIN media_files ON media_files.id=album_files.media_file_id
         WHERE album_files.album_id=? AND album_files.is_primary=1 AND (${expression}) LIMIT 1`,
      )
      .get(versionId)
      ? "OBSERVED_TAG"
      : "PATH_FALLBACK";
  }

  private refreshMetadataIssueStatus(libraryAlbumId: string): void {
    const metadata = this.getAlbumMetadata(libraryAlbumId);
    if (!metadata) return;
    const title = metadata.album.title.effectiveValue;
    const artist = metadata.album.albumArtist.effectiveValue;
    const textResolved =
      typeof title === "string" &&
      title.trim() !== "" &&
      !hasBrokenText(title) &&
      typeof artist === "string" &&
      artist.trim() !== "" &&
      !hasBrokenText(artist);
    this.raw
      .prepare(
        `UPDATE library_issues SET resolution_status=?,updated_at=?
         WHERE library_album_id=? AND code='BROKEN_TEXT'`,
      )
      .run(
        textResolved ? "RESOLVED_BY_METADATA" : "PENDING",
        new Date().toISOString(),
        libraryAlbumId,
      );
    const identityResolved =
      textResolved &&
      metadata.album.title.effectiveSource !== "PATH_FALLBACK" &&
      metadata.album.albumArtist.effectiveSource !== "PATH_FALLBACK";
    this.raw
      .prepare(
        `UPDATE library_issues SET resolution_status=?,updated_at=?
         WHERE library_album_id=? AND code='MISSING_IDENTITY'`,
      )
      .run(
        identityResolved ? "RESOLVED_BY_METADATA" : "PENDING",
        new Date().toISOString(),
        libraryAlbumId,
      );
  }

  syncObservedArtworkCandidates(): void {
    this.raw.transaction(() => {
      const now = new Date().toISOString();
      this.raw
        .prepare(
          `UPDATE library_artwork_candidates SET is_current=0,updated_at=?
           WHERE source_type IN ('OBSERVED_EMBEDDED','OBSERVED_SIDECAR')`,
        )
        .run(now);
      const rows = this.raw
        .prepare(
          `SELECT la.id AS library_album_id,a.id AS local_version_id,
                  mf.relative_path,mf.artwork_json
           FROM library_albums la
           JOIN library_album_members lm ON lm.library_album_id=la.id
           JOIN albums a ON a.id=lm.album_id
           JOIN album_files af ON af.album_id=a.id
           JOIN media_files mf ON mf.id=af.media_file_id
           ORDER BY la.id,a.id,mf.relative_path`,
        )
        .all() as Record<string, unknown>[];
      for (const row of rows) {
        const candidates = parseJson<
          Array<{
            source?: string;
            mimeType?: string | null;
            width?: number | null;
            height?: number | null;
            bytes?: number | null;
            sha256?: string | null;
            kind?: string | null;
          }>
        >(row.artwork_json, []);
        for (const candidate of candidates) {
          const mimeType = supportedArtworkMime(candidate.mimeType);
          if (
            !mimeType ||
            !candidate.sha256?.match(/^[a-f0-9]{64}$/) ||
            !candidate.width ||
            !candidate.height ||
            candidate.bytes == null ||
            !["EMBEDDED", "SIDECAR"].includes(candidate.source ?? "")
          )
            continue;
          this.upsertArtworkCandidateInTransaction(
            String(row.library_album_id),
            {
              sha256: candidate.sha256,
              mimeType,
              width: candidate.width,
              height: candidate.height,
              sizeBytes: candidate.bytes,
              extension: artworkExtension(mimeType),
              source:
                candidate.source === "EMBEDDED"
                  ? "OBSERVED_EMBEDDED"
                  : "OBSERVED_SIDECAR",
              localVersionId: String(row.local_version_id),
              relativePath: String(row.relative_path),
              kind: candidate.kind ?? null,
              evidence: { mediaRelativePath: String(row.relative_path) },
            },
            now,
          );
        }
      }
      const groups = this.raw
        .prepare("SELECT id FROM library_albums ORDER BY id")
        .all() as Array<{ id: string }>;
      for (const group of groups)
        this.refreshEffectiveArtwork(group.id, true, now);
    })();
  }

  getConfirmedMusicBrainzReleaseId(
    albumId: string,
    localVersionId: string,
  ): string | null {
    const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
    if (!libraryAlbumId) return null;
    const row = this.raw
      .prepare(
        `SELECT a.musicbrainz_release_id FROM albums a
         JOIN library_album_members m ON m.album_id=a.id
         WHERE m.library_album_id=? AND a.id=? AND a.match_status='USER_CONFIRMED'`,
      )
      .get(libraryAlbumId, localVersionId) as
      { musicbrainz_release_id: string | null } | undefined;
    return row?.musicbrainz_release_id ?? null;
  }

  upsertArtworkCandidate(
    albumId: string,
    candidate: ArtworkCandidateInput,
  ): string {
    const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
    if (!libraryAlbumId)
      throw new AlbumArtworkDecisionError(
        "INVALID_ARTWORK_DECISION",
        "没有找到需要管理封面的唱片",
      );
    if (
      candidate.localVersionId &&
      !this.libraryIdentityMemberIds([libraryAlbumId]).includes(
        candidate.localVersionId,
      )
    )
      throw new AlbumArtworkDecisionError(
        "ARTWORK_DECISION_CONFLICT",
        "封面候选绑定的本地版本已不属于当前唱片",
      );
    return this.raw.transaction(() => {
      const now = new Date().toISOString();
      const id = this.upsertArtworkCandidateInTransaction(
        libraryAlbumId,
        candidate,
        now,
      );
      this.refreshEffectiveArtwork(libraryAlbumId, true, now);
      return id;
    })();
  }

  applyAlbumArtworkCandidateDecision(
    albumId: string,
    candidate: ArtworkCandidateInput,
    command: { requestId: string; expectedArtworkRevision: number },
    actor: LibraryIdentityActor,
    eventType: "UPLOAD" | "IMPORT",
  ): AlbumArtworkMutationResult {
    const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
    if (!libraryAlbumId)
      throw new AlbumArtworkDecisionError(
        "INVALID_ARTWORK_DECISION",
        "没有找到需要管理封面的唱片",
      );
    if (
      candidate.localVersionId &&
      !this.libraryIdentityMemberIds([libraryAlbumId]).includes(
        candidate.localVersionId,
      )
    )
      throw new AlbumArtworkDecisionError(
        "ARTWORK_DECISION_CONFLICT",
        "封面候选绑定的本地版本已不属于当前唱片",
      );
    const candidateId = artworkCandidateId(libraryAlbumId, candidate);
    const decision: ArtworkDecisionCommand = {
      action: "SELECT",
      candidateId,
      ...command,
    };
    const inputJson = JSON.stringify(
      sortJsonValue({ libraryAlbumId, command: decision, eventType }),
    );
    const replay = this.artworkResultByRequestId(command.requestId, inputJson);
    if (replay) return replay;
    return this.raw.transaction(() => {
      this.upsertArtworkCandidateInTransaction(
        libraryAlbumId,
        candidate,
        new Date().toISOString(),
      );
      return this.applyAlbumArtworkDecision(
        libraryAlbumId,
        decision,
        actor,
        eventType,
      );
    })();
  }

  getAlbumArtworkGovernance(albumId: string): AlbumArtworkGovernance | null {
    const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
    if (!libraryAlbumId) return null;
    const group = this.raw
      .prepare(
        `SELECT artwork_revision,effective_artwork_json,effective_artwork_source
         FROM library_albums WHERE id=?`,
      )
      .get(libraryAlbumId) as Record<string, unknown> | undefined;
    if (!group) return null;
    const selection = this.captureArtworkSelection(libraryAlbumId);
    const total = Number(
      (
        this.raw
          .prepare(
            `SELECT COUNT(*) AS count FROM library_artwork_candidates
             WHERE library_album_id=? AND (is_current=1 OR id=?)`,
          )
          .get(libraryAlbumId, selection.candidateId ?? "") as { count: number }
      ).count,
    );
    const rows = this.raw
      .prepare(
        `SELECT c.*,a.mime_type,a.width,a.height,a.size_bytes
         FROM library_artwork_candidates c
         JOIN library_artwork_assets a ON a.sha256=c.asset_sha256
         WHERE c.library_album_id=? AND (c.is_current=1 OR c.id=?)
         ORDER BY CASE WHEN c.id=? THEN 0 ELSE 1 END,
                  CASE c.source_type
                    WHEN 'OBSERVED_EMBEDDED' THEN 0 WHEN 'OBSERVED_SIDECAR' THEN 1
                    WHEN 'MUSICBRAINZ_CAA' THEN 2 ELSE 3 END,
                  MIN(a.width,a.height) DESC,a.size_bytes DESC,c.id
         LIMIT 100`,
      )
      .all(
        libraryAlbumId,
        selection.candidateId ?? "",
        selection.candidateId ?? "",
      ) as Record<string, unknown>[];
    return {
      libraryAlbumId,
      artworkRevision: Number(group.artwork_revision),
      effectiveArtwork: parseJson<Artwork>(
        group.effective_artwork_json,
        emptyArtworkValue(),
      ),
      selectionSource: String(
        group.effective_artwork_source,
      ) as AlbumArtworkGovernance["selectionSource"],
      selectedAssetSha256: selection.assetSha256,
      selectedCandidateId: selection.candidateId,
      candidates: rows.map((row) => ({
        id: String(row.id),
        assetSha256: String(row.asset_sha256),
        source:
          row.source_type as AlbumArtworkGovernance["candidates"][number]["source"],
        localVersionId: nullableString(row.local_version_id),
        relativePath: nullableString(row.relative_path),
        kind: nullableString(row.kind),
        mimeType: row.mime_type as "image/jpeg" | "image/png" | "image/webp",
        width: Number(row.width),
        height: Number(row.height),
        sizeBytes: Number(row.size_bytes),
        url: `/api/v1/artwork/${String(row.asset_sha256)}`,
        current: Boolean(row.is_current),
        selected: selection.candidateId
          ? selection.candidateId === String(row.id)
          : selection.assetSha256 === String(row.asset_sha256),
        lowResolution: Number(row.width) < 600 || Number(row.height) < 600,
        evidence: parseJson<Record<string, unknown>>(row.evidence_json, {}),
      })),
      truncated: total > 100,
    };
  }

  applyAlbumArtworkDecision(
    albumId: string,
    command: ArtworkDecisionCommand,
    actor: LibraryIdentityActor,
    eventType?: AlbumArtworkEvent["type"],
  ): AlbumArtworkMutationResult {
    const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
    if (!libraryAlbumId)
      throw new AlbumArtworkDecisionError(
        "INVALID_ARTWORK_DECISION",
        "没有找到需要管理封面的唱片",
      );
    const inputJson = JSON.stringify(
      sortJsonValue({ libraryAlbumId, command, eventType: eventType ?? null }),
    );
    const replay = this.artworkResultByRequestId(command.requestId, inputJson);
    if (replay) return replay;
    return this.raw.transaction(() => {
      const row = this.raw
        .prepare("SELECT artwork_revision FROM library_albums WHERE id=?")
        .get(libraryAlbumId) as { artwork_revision: number };
      if (Number(row.artwork_revision) !== command.expectedArtworkRevision)
        throw new AlbumArtworkDecisionError(
          "ARTWORK_DECISION_CONFLICT",
          "封面已被其他操作更新，请刷新后重试",
        );
      const before = this.captureArtworkSelection(libraryAlbumId);
      const now = new Date().toISOString();
      let assetSha256: string | null = null;
      let candidateId: string | null = null;
      if (command.action === "SELECT") {
        const candidate = this.raw
          .prepare(
            `SELECT id,asset_sha256 FROM library_artwork_candidates
             WHERE id=? AND library_album_id=? AND is_current=1`,
          )
          .get(command.candidateId, libraryAlbumId) as
          { id: string; asset_sha256: string } | undefined;
        if (!candidate)
          throw new AlbumArtworkDecisionError(
            "ARTWORK_DECISION_CONFLICT",
            "封面候选已变化，请重新选择",
          );
        assetSha256 = candidate.asset_sha256;
        candidateId = candidate.id;
        this.raw
          .prepare(
            `INSERT INTO library_artwork_selections
             (library_album_id,state,asset_sha256,candidate_id,actor_id,actor_display_name,created_at,updated_at)
             VALUES (?,'SELECTED',?,?,?,?,?,?)
             ON CONFLICT(library_album_id) DO UPDATE SET
               state='SELECTED',asset_sha256=excluded.asset_sha256,
               candidate_id=excluded.candidate_id,actor_id=excluded.actor_id,
               actor_display_name=excluded.actor_display_name,updated_at=excluded.updated_at`,
          )
          .run(
            libraryAlbumId,
            assetSha256,
            candidateId,
            actor.id,
            actor.displayName,
            before.createdAt ?? now,
            now,
          );
      } else if (command.action === "HIDE") {
        this.raw
          .prepare(
            `INSERT INTO library_artwork_selections
             (library_album_id,state,asset_sha256,candidate_id,actor_id,actor_display_name,created_at,updated_at)
             VALUES (?,'HIDDEN',NULL,NULL,?,?,?,?)
             ON CONFLICT(library_album_id) DO UPDATE SET
               state='HIDDEN',asset_sha256=NULL,candidate_id=NULL,
               actor_id=excluded.actor_id,actor_display_name=excluded.actor_display_name,
               updated_at=excluded.updated_at`,
          )
          .run(
            libraryAlbumId,
            actor.id,
            actor.displayName,
            before.createdAt ?? now,
            now,
          );
      } else {
        this.raw
          .prepare(
            "DELETE FROM library_artwork_selections WHERE library_album_id=?",
          )
          .run(libraryAlbumId);
      }
      this.raw
        .prepare(
          "UPDATE library_albums SET artwork_revision=artwork_revision+1,updated_at=? WHERE id=?",
        )
        .run(now, libraryAlbumId);
      this.refreshEffectiveArtwork(libraryAlbumId, false, now);
      const after = this.captureArtworkSelection(libraryAlbumId);
      return this.recordAlbumArtworkEvent({
        requestId: command.requestId,
        inputJson,
        libraryAlbumId,
        type:
          eventType ??
          (command.action === "SELECT"
            ? "SELECT"
            : command.action === "HIDE"
              ? "HIDE"
              : "RESET"),
        actor,
        expectedArtworkRevision: command.expectedArtworkRevision,
        before,
        after,
        assetSha256,
        candidateId,
        compensatesEventId: null,
        createdAt: now,
      });
    })();
  }

  listAlbumArtworkHistory(albumId: string): AlbumArtworkEvent[] {
    const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
    if (!libraryAlbumId) return [];
    return (
      this.raw
        .prepare(
          `SELECT e.* FROM library_artwork_events e
           WHERE EXISTS (SELECT 1 FROM library_artwork_event_groups g
             WHERE g.event_id=e.id AND g.library_album_id=?)
           ORDER BY e.rowid DESC LIMIT 100`,
        )
        .all(libraryAlbumId) as Record<string, unknown>[]
    ).map((row) => this.mapAlbumArtworkEvent(row, libraryAlbumId));
  }

  undoAlbumArtworkEvent(
    albumId: string,
    eventId: string,
    requestId: string,
    expectedArtworkRevision: number,
    actor: LibraryIdentityActor,
  ): AlbumArtworkMutationResult {
    const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
    if (!libraryAlbumId)
      throw new AlbumArtworkDecisionError(
        "INVALID_ARTWORK_DECISION",
        "没有找到需要撤销封面决定的唱片",
      );
    const inputJson = JSON.stringify(
      sortJsonValue({
        libraryAlbumId,
        eventId,
        requestId,
        expectedArtworkRevision,
        action: "UNDO",
      }),
    );
    const replay = this.artworkResultByRequestId(requestId, inputJson);
    if (replay) return replay;
    return this.raw.transaction(() => {
      const event = this.raw
        .prepare("SELECT * FROM library_artwork_events WHERE id=?")
        .get(eventId) as Record<string, unknown> | undefined;
      const mapped = event
        ? this.mapAlbumArtworkEvent(event, libraryAlbumId)
        : null;
      if (!event || !mapped?.canUndo)
        throw new AlbumArtworkDecisionError(
          "ARTWORK_DECISION_CONFLICT",
          "该封面决定已不是可安全撤销的最新事件",
        );
      const group = this.raw
        .prepare("SELECT artwork_revision FROM library_albums WHERE id=?")
        .get(libraryAlbumId) as { artwork_revision: number };
      if (Number(group.artwork_revision) !== expectedArtworkRevision)
        throw new AlbumArtworkDecisionError(
          "ARTWORK_DECISION_CONFLICT",
          "封面已更新，请刷新后重试撤销",
        );
      const before = this.captureArtworkSelection(libraryAlbumId);
      const restore = parseJson<ArtworkSelectionSnapshot>(
        event.before_state_json,
        emptyArtworkSelection(libraryAlbumId),
      );
      this.restoreArtworkSelection(restore);
      const now = new Date().toISOString();
      this.raw
        .prepare(
          "UPDATE library_albums SET artwork_revision=artwork_revision+1,updated_at=? WHERE id=?",
        )
        .run(now, libraryAlbumId);
      this.refreshEffectiveArtwork(libraryAlbumId, false, now);
      const after = this.captureArtworkSelection(libraryAlbumId);
      return this.recordAlbumArtworkEvent({
        requestId,
        inputJson,
        libraryAlbumId,
        type: "UNDO",
        actor,
        expectedArtworkRevision,
        before,
        after,
        assetSha256: after.assetSha256,
        candidateId: after.candidateId,
        compensatesEventId: eventId,
        createdAt: now,
      });
    })();
  }

  private upsertArtworkCandidateInTransaction(
    libraryAlbumId: string,
    candidate: ArtworkCandidateInput,
    now: string,
  ): string {
    if (
      !candidate.sha256.match(/^[a-f0-9]{64}$/) ||
      candidate.width <= 0 ||
      candidate.height <= 0 ||
      candidate.sizeBytes < 0
    )
      throw new AlbumArtworkDecisionError(
        "INVALID_ARTWORK_DECISION",
        "封面资产事实无效",
      );
    this.raw
      .prepare(
        `INSERT OR IGNORE INTO library_artwork_assets
         (sha256,mime_type,width,height,size_bytes,extension,created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        candidate.sha256,
        candidate.mimeType,
        candidate.width,
        candidate.height,
        candidate.sizeBytes,
        candidate.extension,
        now,
      );
    const storedAsset = this.raw
      .prepare(
        `SELECT mime_type,width,height,size_bytes,extension
         FROM library_artwork_assets WHERE sha256=?`,
      )
      .get(candidate.sha256) as Record<string, unknown>;
    if (
      storedAsset.mime_type !== candidate.mimeType ||
      Number(storedAsset.width) !== candidate.width ||
      Number(storedAsset.height) !== candidate.height ||
      Number(storedAsset.size_bytes) !== candidate.sizeBytes ||
      storedAsset.extension !== candidate.extension
    )
      throw new AlbumArtworkDecisionError(
        "ARTWORK_DECISION_CONFLICT",
        "相同内容哈希的封面资产事实不一致",
      );
    const id = artworkCandidateId(libraryAlbumId, candidate);
    this.raw
      .prepare(
        `INSERT INTO library_artwork_candidates
         (id,library_album_id,local_version_id,asset_sha256,source_type,
          relative_path,kind,evidence_json,is_current,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,1,?,?)
         ON CONFLICT(id) DO UPDATE SET asset_sha256=excluded.asset_sha256,
           relative_path=excluded.relative_path,kind=excluded.kind,
           evidence_json=excluded.evidence_json,is_current=1,updated_at=excluded.updated_at`,
      )
      .run(
        id,
        libraryAlbumId,
        candidate.localVersionId,
        candidate.sha256,
        candidate.source,
        candidate.relativePath,
        candidate.kind,
        JSON.stringify(candidate.evidence),
        now,
        now,
      );
    return id;
  }

  private captureArtworkSelection(
    libraryAlbumId: string,
  ): ArtworkSelectionSnapshot {
    const row = this.raw
      .prepare(
        "SELECT * FROM library_artwork_selections WHERE library_album_id=?",
      )
      .get(libraryAlbumId) as Record<string, unknown> | undefined;
    return row
      ? {
          libraryAlbumId,
          state: row.state as "SELECTED" | "HIDDEN",
          assetSha256: nullableString(row.asset_sha256),
          candidateId: nullableString(row.candidate_id),
          actorId: nullableString(row.actor_id),
          actorDisplayName: nullableString(row.actor_display_name),
          createdAt: nullableString(row.created_at),
          updatedAt: nullableString(row.updated_at),
        }
      : emptyArtworkSelection(libraryAlbumId);
  }

  private restoreArtworkSelection(snapshot: ArtworkSelectionSnapshot): void {
    const candidateId = snapshot.candidateId
      ? this.raw
          .prepare("SELECT 1 FROM library_artwork_candidates WHERE id=?")
          .get(snapshot.candidateId)
        ? snapshot.candidateId
        : null
      : null;
    this.raw
      .prepare(
        "DELETE FROM library_artwork_selections WHERE library_album_id=?",
      )
      .run(snapshot.libraryAlbumId);
    if (!snapshot.state) return;
    this.raw
      .prepare(
        `INSERT INTO library_artwork_selections
         (library_album_id,state,asset_sha256,candidate_id,actor_id,
          actor_display_name,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        snapshot.libraryAlbumId,
        snapshot.state,
        snapshot.assetSha256,
        candidateId,
        snapshot.actorId ?? "system",
        snapshot.actorDisplayName ?? "System",
        snapshot.createdAt ?? new Date().toISOString(),
        snapshot.updatedAt ?? new Date().toISOString(),
      );
  }

  private refreshEffectiveArtwork(
    libraryAlbumId: string,
    bumpRevision: boolean,
    now: string,
  ): void {
    const group = this.raw
      .prepare(
        `SELECT primary_version_id,effective_artwork_json,effective_artwork_source
         FROM library_albums WHERE id=?`,
      )
      .get(libraryAlbumId) as Record<string, unknown> | undefined;
    if (!group) return;
    const selection = this.captureArtworkSelection(libraryAlbumId);
    let artwork = emptyArtworkValue();
    let source: AlbumArtworkGovernance["selectionSource"] = "NONE";
    if (selection.state === "HIDDEN") {
      source = "USER_HIDDEN";
    } else if (selection.state === "SELECTED" && selection.assetSha256) {
      const asset = this.raw
        .prepare(
          `SELECT a.*,c.source_type FROM library_artwork_assets a
           LEFT JOIN library_artwork_candidates c ON c.id=?
           WHERE a.sha256=?`,
        )
        .get(selection.candidateId, selection.assetSha256) as
        Record<string, unknown> | undefined;
      if (asset) {
        artwork = artworkFromAsset(asset);
        source = "USER_SELECTED";
      }
    } else {
      const candidate = this.raw
        .prepare(
          `SELECT c.*,a.mime_type,a.width,a.height,a.size_bytes
           FROM library_artwork_candidates c
           JOIN library_artwork_assets a ON a.sha256=c.asset_sha256
           WHERE c.library_album_id=? AND c.is_current=1
             AND c.source_type IN ('OBSERVED_EMBEDDED','OBSERVED_SIDECAR')
           ORDER BY CASE WHEN c.local_version_id=? THEN 0 ELSE 1 END,
                    CASE WHEN lower(COALESCE(c.kind,'')) LIKE '%front%' THEN 0
                         WHEN lower(COALESCE(c.kind,'')) LIKE '%folder%' THEN 1 ELSE 2 END,
                    CASE c.source_type WHEN 'OBSERVED_EMBEDDED' THEN 0 ELSE 1 END,
                    MIN(a.width,a.height) DESC,a.size_bytes DESC,c.id
           LIMIT 1`,
        )
        .get(libraryAlbumId, group.primary_version_id) as
        Record<string, unknown> | undefined;
      if (candidate) {
        artwork = artworkFromAsset(candidate);
        source =
          candidate.local_version_id === group.primary_version_id
            ? "AUTOMATIC_PRIMARY"
            : "AUTOMATIC_REPRESENTATIVE";
      } else {
        const primary = this.raw
          .prepare("SELECT artwork_json FROM albums WHERE id=?")
          .get(group.primary_version_id) as
          { artwork_json: string } | undefined;
        const legacy = primary
          ? parseJson<Artwork>(primary.artwork_json, emptyArtworkValue())
          : emptyArtworkValue();
        if (legacy.source !== "NONE") {
          artwork = legacy;
          source = "AUTOMATIC_PRIMARY";
        }
      }
    }
    const artworkJson = JSON.stringify(artwork);
    const changed =
      nullableString(group.effective_artwork_json) !== artworkJson ||
      String(group.effective_artwork_source) !== source;
    this.raw
      .prepare(
        `UPDATE library_albums SET effective_artwork_json=?,effective_artwork_source=?,
           artwork_revision=artwork_revision+?,updated_at=? WHERE id=?`,
      )
      .run(
        artworkJson,
        source,
        changed && bumpRevision ? 1 : 0,
        now,
        libraryAlbumId,
      );
    this.refreshArtworkIssueStatus(libraryAlbumId, artwork, source, now);
  }

  private refreshArtworkIssueStatus(
    libraryAlbumId: string,
    artwork: Artwork,
    source: AlbumArtworkGovernance["selectionSource"],
    now: string,
  ): void {
    const visible = artwork.source !== "NONE" && source !== "USER_HIDDEN";
    const highResolution =
      visible &&
      artwork.width != null &&
      artwork.height != null &&
      artwork.width >= 600 &&
      artwork.height >= 600;
    this.raw
      .prepare(
        `UPDATE library_issues SET resolution_status=?,updated_at=?
         WHERE library_album_id=? AND code='MISSING_ARTWORK'`,
      )
      .run(visible ? "RESOLVED_BY_ARTWORK" : "PENDING", now, libraryAlbumId);
    this.raw
      .prepare(
        `UPDATE library_issues SET resolution_status=?,updated_at=?
         WHERE library_album_id=? AND code='LOW_RES_ARTWORK'`,
      )
      .run(
        highResolution ? "RESOLVED_BY_ARTWORK" : "PENDING",
        now,
        libraryAlbumId,
      );
  }

  private recordAlbumArtworkEvent(input: {
    requestId: string;
    inputJson: string;
    libraryAlbumId: string;
    type: AlbumArtworkEvent["type"];
    actor: LibraryIdentityActor;
    expectedArtworkRevision: number;
    before: ArtworkSelectionSnapshot;
    after: ArtworkSelectionSnapshot;
    assetSha256: string | null;
    candidateId: string | null;
    compensatesEventId: string | null;
    createdAt: string;
  }): AlbumArtworkMutationResult {
    const id = randomUUID();
    const artwork = this.getAlbumArtworkGovernance(input.libraryAlbumId)!;
    this.raw
      .prepare(
        `INSERT INTO library_artwork_events
         (id,request_id,library_album_id,event_type,actor_id,actor_display_name,
          expected_artwork_revision,resulting_artwork_revision,input_json,
          before_state_json,after_state_json,result_json,asset_sha256,candidate_id,
          compensates_event_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.requestId,
        input.libraryAlbumId,
        input.type,
        input.actor.id,
        input.actor.displayName,
        input.expectedArtworkRevision,
        artwork.artworkRevision,
        input.inputJson,
        JSON.stringify(input.before),
        JSON.stringify(input.after),
        JSON.stringify({ artwork }),
        input.assetSha256,
        input.candidateId,
        input.compensatesEventId,
        input.createdAt,
      );
    this.raw
      .prepare(
        "INSERT INTO library_artwork_event_groups(event_id,library_album_id) VALUES (?,?)",
      )
      .run(id, input.libraryAlbumId);
    return {
      artwork,
      event: this.mapAlbumArtworkEvent(
        this.raw
          .prepare("SELECT * FROM library_artwork_events WHERE id=?")
          .get(id) as Record<string, unknown>,
        input.libraryAlbumId,
      ),
    };
  }

  private artworkResultByRequestId(
    requestId: string,
    inputJson: string,
  ): AlbumArtworkMutationResult | null {
    const row = this.raw
      .prepare("SELECT * FROM library_artwork_events WHERE request_id=?")
      .get(requestId) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (String(row.input_json) !== inputJson)
      throw new AlbumArtworkDecisionError(
        "ARTWORK_DECISION_CONFLICT",
        "requestId 已用于不同的封面请求",
      );
    const stored = parseJson<{ artwork: AlbumArtworkGovernance }>(
      row.result_json,
      {
        artwork: this.getAlbumArtworkGovernance(String(row.library_album_id))!,
      },
    );
    const historyAlbumId =
      this.resolveLibraryAlbumId(String(row.library_album_id)) ??
      String(row.library_album_id);
    return {
      artwork: stored.artwork,
      event: this.mapAlbumArtworkEvent(row, historyAlbumId),
    };
  }

  private mapAlbumArtworkEvent(
    row: Record<string, unknown>,
    historyLibraryAlbumId: string,
  ): AlbumArtworkEvent {
    const latest = this.raw
      .prepare(
        `SELECT e.id FROM library_artwork_events e
         WHERE EXISTS (SELECT 1 FROM library_artwork_event_groups g
           WHERE g.event_id=e.id AND g.library_album_id=?)
         ORDER BY e.rowid DESC LIMIT 1`,
      )
      .get(historyLibraryAlbumId) as { id: string } | undefined;
    const compensated = Boolean(
      this.raw
        .prepare(
          "SELECT 1 FROM library_artwork_events WHERE compensates_event_id=?",
        )
        .get(String(row.id)),
    );
    const group = this.raw
      .prepare("SELECT artwork_revision FROM library_albums WHERE id=?")
      .get(historyLibraryAlbumId) as { artwork_revision: number } | undefined;
    const expectedAfter = parseJson<ArtworkSelectionSnapshot>(
      row.after_state_json,
      emptyArtworkSelection(historyLibraryAlbumId),
    );
    const canUndo =
      row.event_type !== "UNDO" &&
      !compensated &&
      latest?.id === String(row.id) &&
      Number(group?.artwork_revision) ===
        Number(row.resulting_artwork_revision) &&
      JSON.stringify(this.captureArtworkSelection(historyLibraryAlbumId)) ===
        JSON.stringify(expectedAfter);
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      libraryAlbumId: String(row.library_album_id),
      type: row.event_type as AlbumArtworkEvent["type"],
      actor: {
        id: String(row.actor_id),
        displayName: String(row.actor_display_name),
      },
      expectedArtworkRevision: Number(row.expected_artwork_revision),
      resultingArtworkRevision: Number(row.resulting_artwork_revision),
      assetSha256: nullableString(row.asset_sha256),
      candidateId: nullableString(row.candidate_id),
      compensatesEventId: nullableString(row.compensates_event_id),
      canUndo,
      createdAt: String(row.created_at),
    };
  }

  applyAlbumVisibility(
    albumId: string,
    command: AlbumVisibilityCommand,
    actor: LibraryIdentityActor,
  ): AlbumVisibilityMutationResult {
    const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
    if (!libraryAlbumId)
      throw new LibraryLifecycleError(
        "INVALID_LIFECYCLE_COMMAND",
        "唱片不存在",
      );
    const inputJson = JSON.stringify({ libraryAlbumId, ...command });
    return this.raw.transaction(() => {
      const replay = this.raw
        .prepare("SELECT * FROM library_visibility_events WHERE request_id=?")
        .get(command.requestId) as Record<string, unknown> | undefined;
      if (replay) {
        if (String(replay.input_json) !== inputJson)
          throw new LibraryLifecycleError(
            "LIFECYCLE_CONFLICT",
            "requestId 已用于不同的显示状态请求",
          );
        return parseJson<AlbumVisibilityMutationResult>(
          replay.result_json,
          this.visibilityResultFromEvent(replay),
        );
      }
      const row = this.raw
        .prepare(
          "SELECT visibility,visibility_revision FROM library_albums WHERE id=?",
        )
        .get(libraryAlbumId) as
        | { visibility: "VISIBLE" | "HIDDEN"; visibility_revision: number }
        | undefined;
      if (!row)
        throw new LibraryLifecycleError(
          "INVALID_LIFECYCLE_COMMAND",
          "唱片不存在",
        );
      if (
        Number(row.visibility_revision) !== command.expectedVisibilityRevision
      )
        throw new LibraryLifecycleError(
          "LIFECYCLE_CONFLICT",
          "显示状态已变化，请刷新后重试",
        );
      const after = command.action === "HIDE" ? "HIDDEN" : "VISIBLE";
      if (row.visibility === after)
        throw new LibraryLifecycleError(
          "INVALID_LIFECYCLE_COMMAND",
          after === "HIDDEN" ? "唱片已经隐藏" : "唱片已经显示",
        );
      const createdAt = new Date().toISOString();
      const resultingRevision = command.expectedVisibilityRevision + 1;
      const changed = this.raw
        .prepare(
          `UPDATE library_albums
           SET visibility=?,visibility_revision=?,visibility_updated_at=?,updated_at=?
           WHERE id=? AND visibility_revision=?`,
        )
        .run(
          after,
          resultingRevision,
          createdAt,
          createdAt,
          libraryAlbumId,
          command.expectedVisibilityRevision,
        );
      if (changed.changes !== 1)
        throw new LibraryLifecycleError(
          "LIFECYCLE_CONFLICT",
          "显示状态已变化，请刷新后重试",
        );
      const event: AlbumVisibilityEvent = {
        id: randomUUID(),
        requestId: command.requestId,
        libraryAlbumId,
        type: command.action,
        actor,
        expectedVisibilityRevision: command.expectedVisibilityRevision,
        resultingVisibilityRevision: resultingRevision,
        before: row.visibility,
        after,
        createdAt,
      };
      const result: AlbumVisibilityMutationResult = {
        libraryAlbumId,
        visibility: after,
        visibilityRevision: resultingRevision,
        event,
      };
      this.raw
        .prepare(
          `INSERT INTO library_visibility_events
           (id,request_id,library_album_id,event_type,actor_id,actor_display_name,
            expected_visibility_revision,resulting_visibility_revision,
            before_visibility,after_visibility,input_json,result_json,created_at)
           VALUES (@id,@requestId,@libraryAlbumId,@type,@actorId,@actorDisplayName,
            @expectedVisibilityRevision,@resultingVisibilityRevision,
            @before,@after,@inputJson,@resultJson,@createdAt)`,
        )
        .run({
          ...event,
          actorId: actor.id,
          actorDisplayName: actor.displayName,
          inputJson,
          resultJson: JSON.stringify(result),
        });
      return result;
    })();
  }

  listAlbumVisibilityHistory(albumId: string): AlbumVisibilityEvent[] {
    const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
    if (!libraryAlbumId) return [];
    return this.raw
      .prepare(
        `SELECT * FROM library_visibility_events
         WHERE library_album_id=? OR library_album_id IN (
           SELECT alias_id FROM library_album_aliases WHERE library_album_id=?
         ) ORDER BY created_at DESC,id DESC LIMIT 100`,
      )
      .all(libraryAlbumId, libraryAlbumId)
      .map((row) =>
        this.mapAlbumVisibilityEvent(row as Record<string, unknown>),
      );
  }

  private visibilityResultFromEvent(
    row: Record<string, unknown>,
  ): AlbumVisibilityMutationResult {
    const event = this.mapAlbumVisibilityEvent(row);
    return {
      libraryAlbumId: event.libraryAlbumId,
      visibility: event.after,
      visibilityRevision: event.resultingVisibilityRevision,
      event,
    };
  }

  private mapAlbumVisibilityEvent(
    row: Record<string, unknown>,
  ): AlbumVisibilityEvent {
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      libraryAlbumId: String(row.library_album_id),
      type: row.event_type as AlbumVisibilityEvent["type"],
      actor: {
        id: String(row.actor_id),
        displayName: String(row.actor_display_name),
      },
      expectedVisibilityRevision: Number(row.expected_visibility_revision),
      resultingVisibilityRevision: Number(row.resulting_visibility_revision),
      before: row.before_visibility as AlbumVisibilityEvent["before"],
      after: row.after_visibility as AlbumVisibilityEvent["after"],
      createdAt: String(row.created_at),
    };
  }

  createQuarantinePlan(
    albumId: string,
    command: {
      requestId: string;
      expectedLibraryRevision: number;
      localVersionId: string;
    },
    actor: LibraryIdentityActor,
  ): LibraryChangePlan {
    const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
    if (!libraryAlbumId)
      throw new LibraryLifecycleError(
        "INVALID_LIFECYCLE_COMMAND",
        "唱片不存在",
      );
    const inputJson = JSON.stringify({
      action: "QUARANTINE_VERSION",
      libraryAlbumId,
      ...command,
    });
    return this.raw.transaction(() => {
      const replay = this.lifecyclePlanReplay(command.requestId, inputJson);
      if (replay) return replay;
      const version = this.lifecycleVersionEvidence(
        libraryAlbumId,
        command.localVersionId,
      );
      if (!version)
        throw new LibraryLifecycleError(
          "INVALID_LIFECYCLE_COMMAND",
          "所选本地版本不属于这张唱片",
        );
      if (version.libraryRevision !== command.expectedLibraryRevision)
        throw new LibraryLifecycleError(
          "LIFECYCLE_CONFLICT",
          "唱片版本关系已变化，请刷新后重新预览",
        );
      this.expireLifecyclePreviews(command.localVersionId);
      if (this.hasActiveLifecyclePlan(command.localVersionId))
        throw new LibraryLifecycleError(
          "LIFECYCLE_CONFLICT",
          "这个本地版本已有进行中的管理操作",
        );
      const planId = randomUUID();
      const files = this.lifecycleVersionFiles(command.localVersionId);
      if (files.length === 0)
        throw new LibraryLifecycleError(
          "INVALID_LIFECYCLE_COMMAND",
          "所选本地版本没有可管理的音频文件",
        );
      const blockers = this.lifecycleBlockers(version.rootId, files, [
        command.localVersionId,
      ]);
      const now = new Date().toISOString();
      this.insertLifecyclePlan({
        id: planId,
        requestId: command.requestId,
        action: "QUARANTINE_VERSION",
        status: "PREVIEWED",
        libraryAlbumId,
        localVersionId: command.localVersionId,
        rootId: version.rootId,
        rootContainerPath: version.rootContainerPath,
        quarantineRootPath: this.quarantineRoot,
        sourcePlanId: null,
        expectedLibraryRevision: command.expectedLibraryRevision,
        inputJson,
        blockers,
        fileCount: files.length,
        totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
        actor,
        createdAt: now,
      });
      const insertItem = this.raw.prepare(
        `INSERT INTO library_change_plan_items
         (plan_id,ordinal,media_file_id,source_relative_path,
          quarantine_relative_path,size_bytes,sha256,status,updated_at)
         VALUES (?,?,?,?,?,?,?,'PENDING',?)`,
      );
      files.forEach((file, ordinal) => {
        insertItem.run(
          planId,
          ordinal,
          file.id,
          file.relativePath,
          lifecycleQuarantinePath(planId, file.relativePath),
          file.sizeBytes,
          file.sha256,
          now,
        );
      });
      this.insertLibraryChangeEvent(
        planId,
        "PREVIEW",
        actor,
        { executable: blockers.length === 0, blockers },
        command.requestId,
        now,
      );
      return this.requireLibraryChangePlan(planId);
    })();
  }

  createRestorePlan(
    sourcePlanId: string,
    requestId: string,
    actor: LibraryIdentityActor,
  ): LibraryChangePlan {
    const inputJson = JSON.stringify({
      action: "RESTORE_VERSION",
      sourcePlanId,
      requestId,
    });
    return this.raw.transaction(() => {
      const replay = this.lifecyclePlanReplay(requestId, inputJson);
      if (replay) return replay;
      const source = this.getLibraryChangePlan(sourcePlanId);
      if (
        !source ||
        source.action !== "QUARANTINE_VERSION" ||
        source.status !== "SUCCEEDED"
      )
        throw new LibraryLifecycleError(
          "INVALID_LIFECYCLE_COMMAND",
          "只有已完成隔离的版本可以恢复",
        );
      this.expireLifecyclePreviews(source.localVersionId);
      const existing = this.raw
        .prepare(
          `SELECT id FROM library_change_plans
           WHERE source_plan_id=? AND action='RESTORE_VERSION'
             AND status IN ('PREVIEWED','QUEUED','RUNNING','SUCCEEDED','RECOVERY_REQUIRED')
           ORDER BY created_at DESC,id DESC LIMIT 1`,
        )
        .get(sourcePlanId) as { id: string } | undefined;
      if (existing)
        throw new LibraryLifecycleError(
          "LIFECYCLE_CONFLICT",
          "这个隔离版本已有恢复操作",
        );
      if (this.hasActiveLifecyclePlan(source.localVersionId))
        throw new LibraryLifecycleError(
          "LIFECYCLE_CONFLICT",
          "这个本地版本已有进行中的管理操作",
        );
      const currentLibraryAlbumId = this.resolveLibraryAlbumId(
        source.libraryAlbumId,
      );
      const album = this.raw
        .prepare("SELECT revision FROM library_albums WHERE id=?")
        .get(currentLibraryAlbumId ?? "") as { revision: number } | undefined;
      if (!album)
        throw new LibraryLifecycleError(
          "INVALID_LIFECYCLE_COMMAND",
          "唱片不存在",
        );
      const sourceItems = source.items;
      const sourceIdentity = this.raw
        .prepare(
          `SELECT root_container_path,quarantine_root_path
           FROM library_change_plans WHERE id=?`,
        )
        .get(sourcePlanId) as {
        root_container_path: string;
        quarantine_root_path: string;
      };
      const files = sourceItems.map((item) => ({
        id: item.mediaFileId,
        rootId: source.root.id,
        relativePath: item.sourceRelativePath,
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
      }));
      const blockers = this.lifecycleBlockers(source.root.id, files, [
        source.localVersionId,
      ]);
      const currentRoot = this.raw
        .prepare("SELECT container_path FROM library_roots WHERE id=?")
        .get(source.root.id) as { container_path: string } | undefined;
      if (
        currentRoot?.container_path !== sourceIdentity.root_container_path ||
        this.quarantineRoot !== sourceIdentity.quarantine_root_path
      )
        blockers.push({
          code: "PLAN_STALE",
          message: "来源或隔离目录身份已变化，不能按旧清单恢复",
        });
      const planId = randomUUID();
      const now = new Date().toISOString();
      this.insertLifecyclePlan({
        id: planId,
        requestId,
        action: "RESTORE_VERSION",
        status: "PREVIEWED",
        libraryAlbumId: currentLibraryAlbumId!,
        localVersionId: source.localVersionId,
        rootId: source.root.id,
        rootContainerPath: sourceIdentity.root_container_path,
        quarantineRootPath: sourceIdentity.quarantine_root_path,
        sourcePlanId,
        expectedLibraryRevision: Number(album.revision),
        inputJson,
        blockers,
        fileCount: source.fileCount,
        totalBytes: source.totalBytes,
        actor,
        createdAt: now,
      });
      const insertItem = this.raw.prepare(
        `INSERT INTO library_change_plan_items
         (plan_id,ordinal,media_file_id,source_relative_path,
          quarantine_relative_path,size_bytes,sha256,status,updated_at)
         VALUES (?,?,?,?,?,?,?,'PENDING',?)`,
      );
      sourceItems.forEach((item) =>
        insertItem.run(
          planId,
          item.ordinal,
          item.mediaFileId,
          item.sourceRelativePath,
          item.quarantineRelativePath,
          item.sizeBytes,
          item.sha256,
          now,
        ),
      );
      this.insertLibraryChangeEvent(
        planId,
        "PREVIEW",
        actor,
        { executable: blockers.length === 0, blockers, sourcePlanId },
        requestId,
        now,
      );
      return this.requireLibraryChangePlan(planId);
    })();
  }

  confirmLibraryChangePlan(
    planId: string,
    requestId: string,
    actor: LibraryIdentityActor,
  ): LibraryChangePlan {
    const detailsJson = JSON.stringify({ planId, requestId });
    return this.raw.transaction(() => {
      const replay = this.raw
        .prepare(
          "SELECT plan_id,event_type,details_json FROM library_change_events WHERE request_id=?",
        )
        .get(requestId) as
        | { plan_id: string; event_type: string; details_json: string }
        | undefined;
      if (replay) {
        if (
          replay.plan_id !== planId ||
          replay.event_type !== "CONFIRM" ||
          replay.details_json !== detailsJson
        )
          throw new LibraryLifecycleError(
            "LIFECYCLE_CONFLICT",
            "requestId 已用于不同的确认请求",
          );
        return this.requireLibraryChangePlan(planId);
      }
      const plan = this.requireLibraryChangePlan(planId);
      if (plan.status !== "PREVIEWED")
        throw new LibraryLifecycleError(
          "LIFECYCLE_CONFLICT",
          "计划已确认或不再可确认",
        );
      if (!plan.executable)
        throw new LibraryLifecycleError(
          "LIFECYCLE_NOT_EXECUTABLE",
          plan.blockers.map((blocker) => blocker.message).join("；") ||
            "计划不可执行",
        );
      const blockers = this.revalidateLifecyclePlan(plan);
      if (blockers.length)
        throw new LibraryLifecycleError(
          "LIFECYCLE_NOT_EXECUTABLE",
          blockers.map((blocker) => blocker.message).join("；"),
        );
      const now = new Date().toISOString();
      const changed = this.raw
        .prepare(
          `UPDATE library_change_plans
           SET status='QUEUED',confirmed_at=? WHERE id=? AND status='PREVIEWED'`,
        )
        .run(now, planId);
      if (changed.changes !== 1)
        throw new LibraryLifecycleError("LIFECYCLE_CONFLICT", "计划状态已变化");
      this.insertLibraryChangeEvent(
        planId,
        "CONFIRM",
        actor,
        { planId, requestId },
        requestId,
        now,
      );
      return this.requireLibraryChangePlan(planId);
    })();
  }

  cancelLibraryChangePlan(
    planId: string,
    requestId: string,
    actor: LibraryIdentityActor,
  ): LibraryChangePlan {
    const detailsJson = JSON.stringify({ planId, requestId });
    return this.raw.transaction(() => {
      const replay = this.raw
        .prepare(
          "SELECT plan_id,event_type,details_json FROM library_change_events WHERE request_id=?",
        )
        .get(requestId) as
        | { plan_id: string; event_type: string; details_json: string }
        | undefined;
      if (replay) {
        if (
          replay.plan_id !== planId ||
          replay.event_type !== "CANCEL" ||
          replay.details_json !== detailsJson
        )
          throw new LibraryLifecycleError(
            "LIFECYCLE_CONFLICT",
            "requestId 已用于不同的取消请求",
          );
        return this.requireLibraryChangePlan(planId);
      }
      const plan = this.requireLibraryChangePlan(planId);
      if (plan.status !== "PREVIEWED" && plan.status !== "QUEUED")
        throw new LibraryLifecycleError(
          "LIFECYCLE_CONFLICT",
          "只有尚未执行的计划可以取消",
        );
      const now = new Date().toISOString();
      this.raw
        .prepare(
          `UPDATE library_change_plans SET status='CANCELLED',finished_at=?
           WHERE id=? AND status IN ('PREVIEWED','QUEUED')`,
        )
        .run(now, planId);
      this.insertLibraryChangeEvent(
        planId,
        "CANCEL",
        actor,
        { planId, requestId },
        requestId,
        now,
      );
      return this.requireLibraryChangePlan(planId);
    })();
  }

  retryLibraryChangePlan(
    planId: string,
    requestId: string,
    actor: LibraryIdentityActor,
  ): LibraryChangePlan {
    const detailsJson = JSON.stringify({ planId, requestId, retry: true });
    return this.raw.transaction(() => {
      const replay = this.raw
        .prepare(
          "SELECT plan_id,event_type,details_json FROM library_change_events WHERE request_id=?",
        )
        .get(requestId) as
        | { plan_id: string; event_type: string; details_json: string }
        | undefined;
      if (replay) {
        if (
          replay.plan_id !== planId ||
          replay.event_type !== "CONFIRM" ||
          replay.details_json !== detailsJson
        )
          throw new LibraryLifecycleError(
            "LIFECYCLE_CONFLICT",
            "requestId 已用于不同的重试请求",
          );
        return this.requireLibraryChangePlan(planId);
      }
      const plan = this.requireLibraryChangePlan(planId);
      if (plan.status !== "RECOVERY_REQUIRED")
        throw new LibraryLifecycleError(
          "LIFECYCLE_CONFLICT",
          "只有需要人工处理的计划可以重新核验",
        );
      const originalActor = this.getUser(plan.actor.id);
      if (
        !originalActor ||
        !originalActor.enabled ||
        originalActor.role !== "ADMIN"
      )
        throw new LibraryLifecycleError(
          "LIFECYCLE_NOT_EXECUTABLE",
          "原发起人已不再是启用的管理员",
        );
      const now = new Date().toISOString();
      const changed = this.raw
        .prepare(
          `UPDATE library_change_plans SET status='QUEUED',error=NULL,
             started_at=NULL,finished_at=NULL WHERE id=? AND status='RECOVERY_REQUIRED'`,
        )
        .run(planId);
      if (changed.changes !== 1)
        throw new LibraryLifecycleError("LIFECYCLE_CONFLICT", "计划状态已变化");
      this.insertLibraryChangeEvent(
        planId,
        "CONFIRM",
        actor,
        { planId, requestId, retry: true },
        requestId,
        now,
      );
      return this.requireLibraryChangePlan(planId);
    })();
  }

  getLibraryChangePlan(planId: string): LibraryChangePlan | null {
    const row = this.raw
      .prepare(
        `SELECT p.*,r.name AS root_name,r.policy AS root_policy
         FROM library_change_plans p JOIN library_roots r ON r.id=p.root_id
         WHERE p.id=?`,
      )
      .get(planId) as Record<string, unknown> | undefined;
    return row ? this.mapLibraryChangePlan(row) : null;
  }

  getLibraryChangePlanExecution(planId: string): {
    plan: LibraryChangePlan;
    rootContainerPath: string;
    quarantineRootPath: string;
  } | null {
    const plan = this.getLibraryChangePlan(planId);
    if (!plan) return null;
    const row = this.raw
      .prepare(
        `SELECT root_container_path,quarantine_root_path
         FROM library_change_plans WHERE id=?`,
      )
      .get(planId) as {
      root_container_path: string;
      quarantine_root_path: string;
    };
    return {
      plan,
      rootContainerPath: row.root_container_path,
      quarantineRootPath: row.quarantine_root_path,
    };
  }

  revalidateRunningLibraryChangePlan(planId: string): LibraryChangeBlocker[] {
    const plan = this.requireLibraryChangePlan(planId);
    if (plan.status !== "RUNNING")
      throw new LibraryLifecycleError(
        "LIFECYCLE_CONFLICT",
        "只有运行中的计划可以执行最终复验",
      );
    return this.revalidateLifecyclePlan(plan);
  }

  requireLibraryChangePlan(planId: string): LibraryChangePlan {
    const plan = this.getLibraryChangePlan(planId);
    if (!plan)
      throw new LibraryLifecycleError(
        "INVALID_LIFECYCLE_COMMAND",
        "管理计划不存在",
      );
    return plan;
  }

  listLibraryChangePlans(
    options: { limit?: number } = {},
  ): LibraryChangePlan[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
    return this.raw
      .prepare(
        `WITH head AS (
           SELECT id FROM library_change_plans
           ORDER BY created_at DESC,id DESC LIMIT ?
         )
         SELECT p.*,r.name AS root_name,r.policy AS root_policy
         FROM library_change_plans p JOIN library_roots r ON r.id=p.root_id
         WHERE p.id IN (SELECT id FROM head) OR p.status='RECOVERY_REQUIRED'
         ORDER BY p.created_at DESC,p.id DESC`,
      )
      .all(limit)
      .map((row) => this.mapLibraryChangePlan(row as Record<string, unknown>));
  }

  listQuarantinedLibraryVersions(limit = 100): LibraryChangePlan[] {
    return this.raw
      .prepare(
        `SELECT p.*,r.name AS root_name,r.policy AS root_policy
         FROM library_change_plans p JOIN library_roots r ON r.id=p.root_id
         WHERE p.action='QUARANTINE_VERSION' AND p.status='SUCCEEDED'
           AND NOT EXISTS (
             SELECT 1 FROM library_change_plans restore
             WHERE restore.source_plan_id=p.id AND restore.action='RESTORE_VERSION'
               AND restore.status='SUCCEEDED'
           )
         ORDER BY p.finished_at DESC,p.id DESC LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 100))
      .map((row) => this.mapLibraryChangePlan(row as Record<string, unknown>));
  }

  claimNextLibraryChangePlan(): LibraryChangePlan | null {
    return this.raw.transaction(() => {
      const row = this.raw
        .prepare(
          `SELECT id FROM library_change_plans
           WHERE status='QUEUED' ORDER BY confirmed_at,created_at,id LIMIT 1`,
        )
        .get() as { id: string } | undefined;
      if (!row) return null;
      const now = new Date().toISOString();
      const changed = this.raw
        .prepare(
          `UPDATE library_change_plans SET status='RUNNING',started_at=?,error=NULL
           WHERE id=? AND status='QUEUED'`,
        )
        .run(now, row.id);
      if (changed.changes !== 1) return null;
      const plan = this.requireLibraryChangePlan(row.id);
      this.insertLibraryChangeEvent(
        row.id,
        "START",
        plan.actor,
        { action: plan.action },
        null,
        now,
      );
      return this.requireLibraryChangePlan(row.id);
    })();
  }

  updateLibraryChangePlanItem(
    planId: string,
    ordinal: number,
    update: {
      status: LibraryChangePlanItem["status"];
      finalSizeBytes?: number | null;
      finalSha256?: string | null;
      error?: string | null;
    },
  ): LibraryChangePlan {
    return this.raw.transaction(() => {
      const plan = this.requireLibraryChangePlan(planId);
      if (plan.status !== "RUNNING")
        throw new LibraryLifecycleError(
          "LIFECYCLE_CONFLICT",
          "只有运行中的计划可以更新文件状态",
        );
      const now = new Date().toISOString();
      const changed = this.raw
        .prepare(
          `UPDATE library_change_plan_items
           SET status=@status,final_size_bytes=@finalSizeBytes,
               final_sha256=@finalSha256,error=@error,updated_at=@updatedAt
           WHERE plan_id=@planId AND ordinal=@ordinal`,
        )
        .run({
          planId,
          ordinal,
          status: update.status,
          finalSizeBytes: update.finalSizeBytes ?? null,
          finalSha256: update.finalSha256 ?? null,
          error: update.error ?? null,
          updatedAt: now,
        });
      if (changed.changes !== 1)
        throw new LibraryLifecycleError(
          "INVALID_LIFECYCLE_COMMAND",
          "计划文件不存在",
        );
      this.insertLibraryChangeEvent(
        planId,
        "ITEM_UPDATE",
        plan.actor,
        { ordinal, ...update },
        null,
        now,
      );
      return this.requireLibraryChangePlan(planId);
    })();
  }

  finishLibraryChangePlan(
    planId: string,
    status: "SUCCEEDED" | "FAILED" | "RECOVERY_REQUIRED",
    error: string | null = null,
  ): LibraryChangePlan {
    return this.raw.transaction(() => {
      const plan = this.requireLibraryChangePlan(planId);
      if (plan.status !== "RUNNING")
        throw new LibraryLifecycleError(
          "LIFECYCLE_CONFLICT",
          "只有运行中的计划可以结束",
        );
      if (
        status === "SUCCEEDED" &&
        plan.items.some((item) =>
          plan.action === "QUARANTINE_VERSION"
            ? item.status !== "QUARANTINED"
            : item.status !== "RESTORED",
        )
      )
        throw new LibraryLifecycleError(
          "LIFECYCLE_NOT_EXECUTABLE",
          "仍有文件未完成，不能标记成功",
        );
      const now = new Date().toISOString();
      this.raw
        .prepare(
          `UPDATE library_change_plans SET status=?,error=?,finished_at=?
           WHERE id=? AND status='RUNNING'`,
        )
        .run(status, error, now, planId);
      const eventType =
        status === "SUCCEEDED"
          ? "COMPLETE"
          : status === "RECOVERY_REQUIRED"
            ? "RECOVERY_REQUIRED"
            : "FAIL";
      this.insertLibraryChangeEvent(
        planId,
        eventType,
        plan.actor,
        { status, error },
        null,
        now,
      );
      if (status === "SUCCEEDED")
        this.enqueueLifecycleReconciliationScan(plan.root.id, now);
      return this.requireLibraryChangePlan(planId);
    })();
  }

  recoverRunningLibraryChangePlans(): number {
    return this.raw.transaction(() => {
      const rows = this.raw
        .prepare(
          `SELECT id FROM library_change_plans WHERE status='RUNNING'
           ORDER BY started_at,id`,
        )
        .all() as Array<{ id: string }>;
      const now = new Date().toISOString();
      for (const row of rows) {
        const plan = this.requireLibraryChangePlan(row.id);
        this.raw
          .prepare(
            `UPDATE library_change_plans SET status='QUEUED',started_at=NULL,
             error='Worker 中断，已按冻结清单排队恢复' WHERE id=? AND status='RUNNING'`,
          )
          .run(row.id);
        this.insertLibraryChangeEvent(
          row.id,
          "RECOVERY_REQUIRED",
          plan.actor,
          { recoveredTo: "QUEUED", reason: "WORKER_RESTART" },
          null,
          now,
        );
      }
      return rows.length;
    })();
  }

  private lifecyclePlanReplay(
    requestId: string,
    inputJson: string,
  ): LibraryChangePlan | null {
    const row = this.raw
      .prepare(
        "SELECT id,input_json FROM library_change_plans WHERE request_id=?",
      )
      .get(requestId) as { id: string; input_json: string } | undefined;
    if (!row) return null;
    if (row.input_json !== inputJson)
      throw new LibraryLifecycleError(
        "LIFECYCLE_CONFLICT",
        "requestId 已用于不同的管理计划",
      );
    return this.requireLibraryChangePlan(row.id);
  }

  private lifecycleVersionEvidence(
    libraryAlbumId: string,
    localVersionId: string,
  ): {
    rootId: string;
    rootName: string;
    rootPolicy: "WATCH_ONLY" | "MANAGED";
    rootContainerPath: string;
    libraryRevision: number;
  } | null {
    const row = this.raw
      .prepare(
        `SELECT a.root_id AS rootId,r.name AS rootName,r.policy AS rootPolicy,
                r.container_path AS rootContainerPath,
                la.revision AS libraryRevision
         FROM library_album_members lm
         JOIN library_albums la ON la.id=lm.library_album_id
         JOIN albums a ON a.id=lm.album_id
         JOIN library_roots r ON r.id=a.root_id
         WHERE lm.library_album_id=? AND lm.album_id=?`,
      )
      .get(libraryAlbumId, localVersionId) as
      | {
          rootId: string;
          rootName: string;
          rootPolicy: "WATCH_ONLY" | "MANAGED";
          rootContainerPath: string;
          libraryRevision: number;
        }
      | undefined;
    return row ?? null;
  }

  private lifecycleVersionFiles(localVersionId: string): Array<{
    id: string;
    rootId: string;
    relativePath: string;
    sizeBytes: number;
    sha256: string | null;
  }> {
    return (
      this.raw
        .prepare(
          `SELECT mf.id,mf.root_id,mf.relative_path,mf.size_bytes,mf.file_sha256
           FROM album_files af JOIN media_files mf ON mf.id=af.media_file_id
           WHERE af.album_id=? ORDER BY mf.relative_path,mf.id`,
        )
        .all(localVersionId) as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row.id),
      rootId: String(row.root_id),
      relativePath: String(row.relative_path),
      sizeBytes: Number(row.size_bytes),
      sha256: nullableString(row.file_sha256)?.toLowerCase() ?? null,
    }));
  }

  private lifecycleBlockers(
    rootId: string,
    files: Array<{
      rootId: string;
      sha256: string | null;
    }>,
    localVersionIds: string[],
  ): LibraryChangeBlocker[] {
    const blockers: LibraryChangeBlocker[] = [];
    const root = this.raw
      .prepare("SELECT policy,enabled FROM library_roots WHERE id=?")
      .get(rootId) as
      { policy: "WATCH_ONLY" | "MANAGED"; enabled: number } | undefined;
    if (!root || !root.enabled)
      blockers.push({
        code: "SOURCE_UNAVAILABLE",
        message: "来源目录当前不可用",
      });
    else if (root.policy !== "MANAGED")
      blockers.push({
        code: "WATCH_ONLY_ROOT",
        message: "这个目录是只读观察目录，不能移动文件",
      });
    if (files.some((file) => file.rootId !== rootId))
      blockers.push({
        code: "CROSS_ROOT_VERSION",
        message: "本地版本跨越多个来源目录，不能隔离",
      });
    if (files.some((file) => !file.sha256))
      blockers.push({
        code: "MISSING_SHA256",
        message: "部分文件缺少完整校验值，请先重新扫描",
      });
    if (
      this.raw
        .prepare(
          `SELECT 1 FROM scan_jobs WHERE root_id=?
           AND status IN ('QUEUED','RUNNING') LIMIT 1`,
        )
        .get(rootId)
    )
      blockers.push({
        code: "ACTIVE_SCAN",
        message: "来源目录正在扫描，请稍后重试",
      });
    if (
      localVersionIds.some((versionId) =>
        this.raw
          .prepare(
            `SELECT 1 FROM delivery_jobs WHERE album_id=?
             AND status IN ('QUEUED','RUNNING') LIMIT 1`,
          )
          .get(versionId),
      )
    )
      blockers.push({
        code: "ACTIVE_DELIVERY",
        message: "这个版本正在投送，请稍后重试",
      });
    return blockers;
  }

  private hasActiveLifecyclePlan(localVersionId: string): boolean {
    return Boolean(
      this.raw
        .prepare(
          `SELECT 1 FROM library_change_plans WHERE local_version_id=?
           AND status IN ('PREVIEWED','QUEUED','RUNNING','RECOVERY_REQUIRED') LIMIT 1`,
        )
        .get(localVersionId),
    );
  }

  private groupsHaveActiveLifecyclePlans(groupIds: string[]): boolean {
    if (!groupIds.length) return false;
    const placeholders = groupIds.map(() => "?").join(",");
    return Boolean(
      this.raw
        .prepare(
          `SELECT 1 FROM library_change_plans p
           WHERE p.local_version_id IN (
             SELECT album_id FROM library_album_members
             WHERE library_album_id IN (${placeholders})
           ) AND p.status IN ('PREVIEWED','QUEUED','RUNNING','RECOVERY_REQUIRED')
           LIMIT 1`,
        )
        .get(...groupIds),
    );
  }

  hasActiveLibraryChangePlan(albumId: string): boolean {
    const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
    return libraryAlbumId
      ? this.groupsHaveActiveLifecyclePlans([libraryAlbumId])
      : false;
  }

  libraryAlbumIdentityExists(albumId: string): boolean {
    const resolved = this.resolveLibraryAlbumId(albumId);
    if (!resolved) return false;
    return Boolean(
      this.raw.prepare("SELECT 1 FROM library_albums WHERE id=?").get(resolved),
    );
  }

  private expireLifecyclePreviews(localVersionId: string): void {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const rows = this.raw
      .prepare(
        `SELECT id,actor_id,actor_display_name FROM library_change_plans
         WHERE local_version_id=? AND status='PREVIEWED' AND created_at<?`,
      )
      .all(localVersionId, cutoff) as Array<{
      id: string;
      actor_id: string;
      actor_display_name: string;
    }>;
    const now = new Date().toISOString();
    for (const row of rows) {
      this.raw
        .prepare(
          `UPDATE library_change_plans SET status='CANCELLED',finished_at=?,
             error='预览已过期，请重新生成' WHERE id=? AND status='PREVIEWED'`,
        )
        .run(now, row.id);
      this.insertLibraryChangeEvent(
        row.id,
        "CANCEL",
        { id: row.actor_id, displayName: row.actor_display_name },
        { reason: "PREVIEW_EXPIRED" },
        null,
        now,
      );
    }
  }

  private revalidateLifecyclePlan(
    plan: LibraryChangePlan,
  ): LibraryChangeBlocker[] {
    const files =
      plan.action === "QUARANTINE_VERSION"
        ? this.lifecycleVersionFiles(plan.localVersionId)
        : plan.items.map((item) => ({
            id: item.mediaFileId ?? "",
            rootId: plan.root.id,
            relativePath: item.sourceRelativePath,
            sizeBytes: item.sizeBytes,
            sha256: item.sha256,
          }));
    const blockers = this.lifecycleBlockers(plan.root.id, files, [
      plan.localVersionId,
    ]);
    const actor = this.raw
      .prepare("SELECT role,enabled FROM app_users WHERE id=?")
      .get(plan.actor.id) as
      { role: "ADMIN" | "MEMBER"; enabled: number } | undefined;
    if (!actor || actor.role !== "ADMIN" || !actor.enabled)
      blockers.push({
        code: "ACTOR_NOT_AUTHORIZED",
        message: "发起人已不再是启用的管理员，计划不能执行",
      });
    const album = this.raw
      .prepare("SELECT revision FROM library_albums WHERE id=?")
      .get(plan.libraryAlbumId) as { revision: number } | undefined;
    const pathIdentity = this.raw
      .prepare(
        `SELECT p.root_container_path,p.quarantine_root_path,r.container_path
         FROM library_change_plans p JOIN library_roots r ON r.id=p.root_id
         WHERE p.id=?`,
      )
      .get(plan.id) as {
      root_container_path: string;
      quarantine_root_path: string;
      container_path: string;
    };
    if (
      !album ||
      Number(album.revision) !== plan.expectedLibraryRevision ||
      pathIdentity.root_container_path !== pathIdentity.container_path ||
      pathIdentity.quarantine_root_path !== this.quarantineRoot ||
      (plan.action === "QUARANTINE_VERSION" &&
        plan.items.every((item) => item.status === "PENDING") &&
        (files.length !== plan.items.length ||
          files.some((file, index) => {
            const frozen = plan.items[index];
            return (
              !frozen ||
              file.id !== frozen.mediaFileId ||
              file.rootId !== plan.root.id ||
              file.relativePath !== frozen.sourceRelativePath ||
              file.sizeBytes !== frozen.sizeBytes ||
              file.sha256 !== frozen.sha256
            );
          })))
    )
      blockers.push({
        code: "PLAN_STALE",
        message: "唱片或文件清单已变化，请重新生成预览",
      });
    return blockers;
  }

  private insertLifecyclePlan(input: {
    id: string;
    requestId: string;
    action: "QUARANTINE_VERSION" | "RESTORE_VERSION";
    status: LibraryChangePlanStatus;
    libraryAlbumId: string;
    localVersionId: string;
    rootId: string;
    rootContainerPath: string;
    quarantineRootPath: string;
    sourcePlanId: string | null;
    expectedLibraryRevision: number;
    inputJson: string;
    blockers: LibraryChangeBlocker[];
    fileCount: number;
    totalBytes: number;
    actor: LibraryIdentityActor;
    createdAt: string;
  }): void {
    this.raw
      .prepare(
        `INSERT INTO library_change_plans
         (id,request_id,action,status,library_album_id,local_version_id,root_id,
          root_container_path,quarantine_root_path,
          source_plan_id,expected_library_revision,input_json,executable,
          blockers_json,file_count,total_bytes,actor_id,actor_display_name,created_at)
         VALUES (@id,@requestId,@action,@status,@libraryAlbumId,@localVersionId,@rootId,
          @rootContainerPath,@quarantineRootPath,
          @sourcePlanId,@expectedLibraryRevision,@inputJson,@executable,
          @blockersJson,@fileCount,@totalBytes,@actorId,@actorDisplayName,@createdAt)`,
      )
      .run({
        ...input,
        executable: input.blockers.length === 0 ? 1 : 0,
        blockersJson: JSON.stringify(input.blockers),
        actorId: input.actor.id,
        actorDisplayName: input.actor.displayName,
      });
  }

  private insertLibraryChangeEvent(
    planId: string,
    eventType:
      | "PREVIEW"
      | "CONFIRM"
      | "START"
      | "ITEM_UPDATE"
      | "COMPLETE"
      | "FAIL"
      | "RECOVERY_REQUIRED"
      | "CANCEL",
    actor: LibraryIdentityActor,
    details: unknown,
    requestId: string | null,
    createdAt = new Date().toISOString(),
  ): void {
    this.raw
      .prepare(
        `INSERT INTO library_change_events
         (id,request_id,plan_id,event_type,actor_id,actor_display_name,details_json,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        requestId,
        planId,
        eventType,
        actor.id,
        actor.displayName,
        JSON.stringify(details),
        createdAt,
      );
  }

  private mapLibraryChangePlan(
    row: Record<string, unknown>,
  ): LibraryChangePlan {
    const items = (
      this.raw
        .prepare(
          `SELECT * FROM library_change_plan_items
           WHERE plan_id=? ORDER BY ordinal`,
        )
        .all(String(row.id)) as Record<string, unknown>[]
    ).map((item): LibraryChangePlanItem => ({
      ordinal: Number(item.ordinal),
      mediaFileId: nullableString(item.media_file_id),
      sourceRelativePath: String(item.source_relative_path),
      quarantineRelativePath: String(item.quarantine_relative_path),
      sizeBytes: Number(item.size_bytes),
      sha256: nullableString(item.sha256),
      status: item.status as LibraryChangePlanItem["status"],
      finalSizeBytes: nullableNumber(item.final_size_bytes),
      finalSha256: nullableString(item.final_sha256),
      error: nullableString(item.error),
    }));
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      action: row.action as LibraryChangePlan["action"],
      status: row.status as LibraryChangePlanStatus,
      libraryAlbumId: String(row.library_album_id),
      localVersionId: String(row.local_version_id),
      root: {
        id: String(row.root_id),
        name: String(row.root_name),
        policy: row.root_policy as "WATCH_ONLY" | "MANAGED",
      },
      sourcePlanId: nullableString(row.source_plan_id),
      expectedLibraryRevision: Number(row.expected_library_revision),
      executable: Boolean(row.executable),
      blockers: parseJson<LibraryChangeBlocker[]>(row.blockers_json, []),
      fileCount: Number(row.file_count),
      totalBytes: Number(row.total_bytes),
      items,
      actor: {
        id: String(row.actor_id),
        displayName: String(row.actor_display_name),
      },
      error: nullableString(row.error),
      createdAt: String(row.created_at),
      confirmedAt: nullableString(row.confirmed_at),
      startedAt: nullableString(row.started_at),
      finishedAt: nullableString(row.finished_at),
    };
  }

  private enqueueLifecycleReconciliationScan(
    rootId: string,
    createdAt: string,
  ): void {
    this.tryCreateScanJob(
      emptyScanJob(randomUUID(), rootId, "INCREMENTAL", "MANUAL", createdAt),
    );
  }

  listAlbums(
    options: {
      search?: string;
      filter?: "ALL" | "DIGITAL" | PhysicalMedium;
      issue?: LibraryIssueCode | "ALL";
      sort?: "ARTIST" | "TITLE" | "YEAR_DESC";
      visibility?: "VISIBLE" | "HIDDEN" | "ALL";
      limit?: number;
      offset?: number;
    } = {},
  ): AlbumSummary[] {
    const search = options.search?.trim();
    const filter = options.filter ?? "ALL";
    const sort = options.sort ?? "ARTIST";
    const issue = options.issue ?? "ALL";
    const visibility = options.visibility ?? "VISIBLE";
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const effectiveTitle = effectiveAlbumFieldSql("title", "a.title");
    const effectiveArtist = effectiveAlbumFieldSql(
      "albumArtist",
      "a.album_artist",
    );
    const effectiveYear = effectiveAlbumFieldSql("year", "a.year");
    const conditions: string[] = [];
    const parameters: Record<string, string | number> = { limit, offset };
    if (visibility !== "ALL") {
      conditions.push("la.visibility=@visibility");
      parameters.visibility = visibility;
    }
    if (search) {
      conditions.push(
        `(${effectiveTitle} LIKE @query ESCAPE '\\' OR ${effectiveArtist} LIKE @query ESCAPE '\\')`,
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
        "EXISTS (SELECT 1 FROM library_issues li WHERE li.library_album_id=la.id AND li.code=@issue AND li.resolution_status='PENDING')",
      );
      parameters.issue = issue;
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order =
      sort === "TITLE"
        ? `${effectiveTitle} COLLATE NOCASE, ${effectiveArtist} COLLATE NOCASE, ${effectiveYear}`
        : sort === "YEAR_DESC"
          ? `${effectiveYear} IS NULL, ${effectiveYear} DESC, ${effectiveTitle} COLLATE NOCASE, ${effectiveArtist} COLLATE NOCASE`
          : `${effectiveArtist} COLLATE NOCASE, ${effectiveYear}, ${effectiveTitle} COLLATE NOCASE`;
    const rows = this.raw
      .prepare(
        `SELECT a.*, la.id AS library_album_id, la.primary_version_id,
                la.primary_version_source, la.revision, la.metadata_revision,
                la.artwork_revision,la.effective_artwork_json,la.effective_artwork_source,
                la.visibility,la.visibility_revision,
                ${effectiveTitle} AS effective_title,
                ${effectiveArtist} AS effective_album_artist,
                ${effectiveYear} AS effective_year,
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
      visibility?: "VISIBLE" | "HIDDEN" | "ALL";
    } = {},
  ): number {
    const search = options.search?.trim();
    const filter = options.filter ?? "ALL";
    const issue = options.issue ?? "ALL";
    const visibility = options.visibility ?? "VISIBLE";
    const effectiveTitle = effectiveAlbumFieldSql("title", "a.title");
    const effectiveArtist = effectiveAlbumFieldSql(
      "albumArtist",
      "a.album_artist",
    );
    const conditions: string[] = [];
    const parameters: Record<string, string> = {};
    if (visibility !== "ALL") {
      conditions.push("la.visibility=@visibility");
      parameters.visibility = visibility;
    }
    if (search) {
      conditions.push(
        `(${effectiveTitle} LIKE @query ESCAPE '\\' OR ${effectiveArtist} LIKE @query ESCAPE '\\')`,
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
        "EXISTS (SELECT 1 FROM library_issues li WHERE li.library_album_id=la.id AND li.code=@issue AND li.resolution_status='PENDING')",
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
    const effectiveTitle = effectiveAlbumFieldSql("title", "a.title");
    const effectiveArtist = effectiveAlbumFieldSql(
      "albumArtist",
      "a.album_artist",
    );
    const effectiveYear = effectiveAlbumFieldSql("year", "a.year");
    const row = this.raw
      .prepare(
        `SELECT a.*, la.id AS library_album_id, la.primary_version_id,
        la.primary_version_source, la.revision, la.metadata_revision,
        la.artwork_revision,la.effective_artwork_json,la.effective_artwork_source,
        la.visibility,la.visibility_revision,
        ${effectiveTitle} AS effective_title,
        ${effectiveArtist} AS effective_album_artist,
        ${effectiveYear} AS effective_year,
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
        matchStatus: row.match_status as AlbumSummary["matchStatus"],
        musicBrainzReleaseId: nullableString(row.musicbrainz_release_id),
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
        lifecycleStatus: this.getLocalVersionLifecycle(String(row.id)),
      };
    });
  }

  private getLocalVersionLifecycle(localVersionId: string) {
    const row = this.raw
      .prepare(
        `SELECT action,status FROM library_change_plans
         WHERE local_version_id=?
         ORDER BY created_at DESC,id DESC LIMIT 1`,
      )
      .get(localVersionId) as
      { action: string; status: LibraryChangePlanStatus } | undefined;
    if (!row) return "ACTIVE" as const;
    if (row.status === "RECOVERY_REQUIRED") return "RECOVERY_REQUIRED" as const;
    if (row.action === "QUARANTINE_VERSION") {
      if (["QUEUED", "RUNNING"].includes(row.status))
        return "QUARANTINING" as const;
      if (row.status === "SUCCEEDED") return "QUARANTINED" as const;
    } else {
      if (["PREVIEWED", "QUEUED", "RUNNING"].includes(row.status))
        return "RESTORING" as const;
      if (row.status === "FAILED") return "QUARANTINED" as const;
    }
    return "ACTIVE" as const;
  }

  private listLibraryIssues(
    libraryAlbumId: string,
    albumId?: string,
    includeResolved = false,
  ): LibraryIssue[] {
    const status = includeResolved ? "" : " AND resolution_status='PENDING'";
    const rows = albumId
      ? this.raw
          .prepare(
            `SELECT * FROM library_issues WHERE library_album_id=? AND album_id=?${status} ORDER BY code, album_id`,
          )
          .all(libraryAlbumId, albumId)
      : this.raw
          .prepare(
            `SELECT * FROM library_issues WHERE library_album_id=?${status} ORDER BY code, album_id`,
          )
          .all(libraryAlbumId);
    return (rows as Record<string, unknown>[]).map((row) => ({
      code: row.code as LibraryIssueCode,
      versionId: nullableString(row.album_id),
      evidence: parseJson<Record<string, unknown>>(row.evidence_json, {}),
      resolutionStatus: (nullableString(row.resolution_status) ??
        "PENDING") as LibraryIssue["resolutionStatus"],
    }));
  }

  findAlbumSummaryByIdentity(
    title: string,
    albumArtist: string,
  ): AlbumSummary | null {
    const effectiveTitle = effectiveAlbumFieldSql("title", "a.title");
    const effectiveArtist = effectiveAlbumFieldSql(
      "albumArtist",
      "a.album_artist",
    );
    const row = this.raw
      .prepare(
        `SELECT la.id FROM library_albums la JOIN albums a ON a.id=la.primary_version_id
         WHERE la.visibility='VISIBLE'
           AND ${effectiveTitle} = ? COLLATE NOCASE
           AND ${effectiveArtist} = ? COLLATE NOCASE
         ORDER BY EXISTS(
           SELECT 1 FROM album_files WHERE album_files.album_id = a.id
         ) DESC, a.updated_at DESC, la.id
         LIMIT 1`,
      )
      .get(title, albumArtist) as { id: string } | undefined;
    return row ? this.getAlbumSummary(row.id) : null;
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
    const metadata = this.getAlbumMetadata(summary.id);
    if (!metadata) return null;
    const versionMetadata = metadata.versions.find(
      (version) => version.versionId === localId,
    );
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
        label: metadataString(versionMetadata?.fields.label.effectiveValue),
        catalogNumber: metadataString(
          versionMetadata?.fields.catalogNumber.effectiveValue,
        ),
        barcode: metadataString(versionMetadata?.fields.barcode.effectiveValue),
        country: metadataString(versionMetadata?.fields.country.effectiveValue),
        releaseDate: metadataString(
          versionMetadata?.fields.releaseDate.effectiveValue,
        ),
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
      metadata,
      artworkGovernance:
        this.getAlbumArtworkGovernance(summary.id) ?? undefined,
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
    requestedLocalVersionId?: string,
  ): void {
    const localVersionId = this.resolveCandidateLocalVersionId(
      albumId,
      requestedLocalVersionId,
    );
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

  listReleaseCandidates(
    albumId: string,
    requestedLocalVersionId?: string,
  ): ReleaseCandidate[] {
    const localVersionId = this.resolveCandidateLocalVersionId(
      albumId,
      requestedLocalVersionId,
    );
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

  private resolveCandidateLocalVersionId(
    albumId: string,
    requestedLocalVersionId?: string,
  ): string | null {
    const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
    if (!libraryAlbumId) return null;
    if (!requestedLocalVersionId)
      return this.resolveLocalVersionId(libraryAlbumId);
    return this.raw
      .prepare(
        `SELECT album_id FROM library_album_members
         WHERE library_album_id=? AND album_id=?`,
      )
      .get(libraryAlbumId, requestedLocalVersionId)
      ? requestedLocalVersionId
      : null;
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
    const metadata = this.getAlbumMetadata(albumId);
    if (metadata)
      this.confirmReleaseCandidateMetadata(
        albumId,
        candidateId,
        localVersionId,
        `legacy-confirm-${randomUUID()}`,
        metadata.metadataRevision,
        { id: "legacy", displayName: "兼容接口" },
      );
    return candidate;
  }

  confirmReleaseCandidateMetadata(
    albumId: string,
    candidateId: string,
    localVersionId: string,
    requestId: string,
    expectedMetadataRevision: number,
    actor: LibraryIdentityActor,
  ): {
    candidate: ReleaseCandidate;
    result: AlbumMetadataMutationResult;
  } | null {
    return this.raw.transaction(() => {
      const inputJson = canonicalMetadataInput(
        albumId,
        expectedMetadataRevision,
        [{ candidateId, localVersionId }],
      );
      const replayRow = this.raw
        .prepare("SELECT * FROM library_metadata_events WHERE request_id=?")
        .get(requestId) as Record<string, unknown> | undefined;
      if (replayRow) {
        if (String(replayRow.input_json) !== inputJson)
          throw new AlbumMetadataDecisionError(
            "METADATA_DECISION_CONFLICT",
            "requestId 已用于不同的元数据请求",
          );
        const stored = parseJson<{
          metadata: AlbumMetadata;
          candidate: ReleaseCandidate;
        }>(replayRow.result_json, null as never);
        if (!stored?.candidate)
          throw new AlbumMetadataDecisionError(
            "METADATA_DECISION_CONFLICT",
            "历史候选确认结果不完整，无法安全重放",
          );
        return {
          candidate: stored.candidate,
          result: {
            metadata: stored.metadata,
            event: this.mapAlbumMetadataEvent(
              replayRow,
              this.resolveLibraryAlbumId(String(replayRow.library_album_id)) ??
                String(replayRow.library_album_id),
            ),
          },
        };
      }
      const libraryAlbumId = this.resolveLibraryAlbumId(albumId);
      if (!libraryAlbumId)
        throw new AlbumMetadataDecisionError(
          "METADATA_DECISION_CONFLICT",
          "唱片已经不存在或无法解析",
        );
      if (
        !this.libraryIdentityMemberIds([libraryAlbumId]).includes(
          localVersionId,
        )
      )
        throw new AlbumMetadataDecisionError(
          "METADATA_DECISION_CONFLICT",
          "候选目标版本已不属于当前唱片",
        );
      const row = this.raw
        .prepare(
          "SELECT payload_json FROM release_match_candidates WHERE id=? AND album_id=?",
        )
        .get(candidateId, localVersionId) as
        { payload_json: string } | undefined;
      if (!row) return null;
      const candidate = releaseCandidateSchema.parse(
        JSON.parse(row.payload_json),
      );
      const year = candidate.releaseDate?.match(/^(\d{4})/)?.[1];
      const commands: MetadataCommand[] = [
        { action: "SET", field: "title", value: candidate.title },
        { action: "SET", field: "albumArtist", value: candidate.artistCredit },
        ...(year
          ? ([{ action: "SET", field: "year", value: Number(year) }] as const)
          : []),
        ...(candidate.labels[0]
          ? ([
              {
                action: "SET",
                field: "label",
                versionId: localVersionId,
                value: candidate.labels[0],
              },
            ] as const)
          : []),
        ...(candidate.catalogNumbers[0]
          ? ([
              {
                action: "SET",
                field: "catalogNumber",
                versionId: localVersionId,
                value: candidate.catalogNumbers[0],
              },
            ] as const)
          : []),
        ...(candidate.barcode
          ? ([
              {
                action: "SET",
                field: "barcode",
                versionId: localVersionId,
                value: candidate.barcode,
              },
            ] as const)
          : []),
        ...(candidate.country
          ? ([
              {
                action: "SET",
                field: "country",
                versionId: localVersionId,
                value: candidate.country,
              },
            ] as const)
          : []),
        ...(candidate.releaseDate
          ? ([
              {
                action: "SET",
                field: "releaseDate",
                versionId: localVersionId,
                value: candidate.releaseDate,
              },
            ] as const)
          : []),
      ];
      const normalized = this.normalizeMetadataCommands(
        libraryAlbumId,
        commands,
      );
      this.assertMetadataRevision(libraryAlbumId, expectedMetadataRevision);
      const before = this.captureAlbumMetadataSnapshot(libraryAlbumId);
      const now = new Date().toISOString();
      const evidence = JSON.stringify({
        provider: candidate.source,
        candidateId: candidate.sourceId,
        localVersionId,
      });
      this.raw
        .prepare(
          `DELETE FROM library_metadata_values
           WHERE source_type='CONFIRMED_EXTERNAL'
             AND ((scope_type='ALBUM' AND owner_id=?)
               OR (scope_type='VERSION' AND owner_id=?))`,
        )
        .run(libraryAlbumId, localVersionId);
      const insert = this.raw.prepare(
        `INSERT INTO library_metadata_values
         (scope_type,owner_id,field_name,source_type,value_json,evidence_json,
          actor_id,actor_display_name,created_at,updated_at)
         VALUES (?,?,?,'CONFIRMED_EXTERNAL',?,?,NULL,NULL,?,?)
         ON CONFLICT(scope_type,owner_id,field_name,source_type) DO UPDATE SET
           value_json=excluded.value_json,evidence_json=excluded.evidence_json,
           updated_at=excluded.updated_at`,
      );
      for (const item of normalized) {
        const scopeType = isAlbumMetadataField(item.field)
          ? "ALBUM"
          : "VERSION";
        insert.run(
          scopeType,
          scopeType === "ALBUM" ? libraryAlbumId : item.versionId!,
          item.field,
          JSON.stringify(item.action === "SET" ? item.value : null),
          evidence,
          now,
          now,
        );
      }
      this.raw
        .prepare(
          `UPDATE albums SET match_status='USER_CONFIRMED',musicbrainz_release_id=?,updated_at=?
           WHERE id=?`,
        )
        .run(candidate.sourceId, now, localVersionId);
      this.raw
        .prepare(
          "UPDATE library_albums SET metadata_revision=metadata_revision+1,updated_at=? WHERE id=?",
        )
        .run(now, libraryAlbumId);
      this.refreshMetadataIssueStatus(libraryAlbumId);
      const after = this.captureAlbumMetadataSnapshot(libraryAlbumId);
      const result = this.recordAlbumMetadataEvent({
        requestId,
        inputJson,
        libraryAlbumId,
        type: "CONFIRM_EXTERNAL",
        actor,
        expectedMetadataRevision,
        commands: normalized,
        before,
        after,
        compensatesEventId: null,
        createdAt: now,
        resultExtra: { candidate },
      });
      return { candidate, result };
    })();
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
          (SELECT COUNT(*)
           FROM library_albums la
           JOIN album_files af ON af.album_id=la.primary_version_id
           WHERE af.is_primary=1) AS tracks,
          (SELECT COUNT(*) FROM media_files) AS files,
          (SELECT COUNT(DISTINCT library_album_id) FROM library_issues WHERE resolution_status='PENDING') AS needs_review,
          (SELECT COUNT(DISTINCT library_album_id) FROM library_issues WHERE code='MISSING_ARTWORK' AND resolution_status='PENDING') AS missing_artwork,
          (SELECT COUNT(DISTINCT library_album_id) FROM library_issues WHERE code='IDENTITY_OVERLAP' AND resolution_status='PENDING') AS pending_groups,
          (SELECT COUNT(DISTINCT library_album_id) FROM library_issues WHERE code='INCOMPLETE_TRACKS' AND resolution_status='PENDING') AS incomplete_albums,
          (SELECT COUNT(DISTINCT library_album_id) FROM library_issues WHERE code='LOW_RES_ARTWORK' AND resolution_status='PENDING') AS low_resolution_artwork,
          (SELECT COUNT(DISTINCT library_album_id) FROM library_issues WHERE code IN ('BROKEN_TEXT','MISSING_IDENTITY') AND resolution_status='PENDING') AS broken_identity,
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
      title: nullableString(row.effective_title) ?? summary.title,
      albumArtist:
        nullableString(row.effective_album_artist) ?? summary.albumArtist,
      year: nullableNumber(row.effective_year),
      id,
      hasDigital,
      physicalMedia,
      primaryVersionId: String(row.primary_version_id),
      primaryVersionSource: row.primary_version_source as "AUTOMATIC" | "USER",
      revision: Number(row.revision),
      metadataRevision: Number(row.metadata_revision ?? 0),
      artwork: row.effective_artwork_json
        ? parseJson<Artwork>(row.effective_artwork_json, summary.artwork)
        : summary.artwork,
      versionCount: Number(row.version_count),
      issues: this.listLibraryIssues(id),
      visibility:
        (nullableString(row.visibility) as AlbumSummary["visibility"]) ??
        "VISIBLE",
      visibilityRevision: Number(row.visibility_revision ?? 0),
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
      metadataRevision: 0,
      trackCount: Number(row.track_count),
      discCount: Number(row.disc_count),
      sourceVersionCount: Number(row.source_version_count ?? 1),
      duplicateFileCount: Number(row.duplicate_file_count ?? 0),
      aggregationIssues: parseJson<AlbumAggregationIssue[]>(
        row.aggregation_issues_json,
        [],
      ),
      visibility: "VISIBLE",
      visibilityRevision: 0,
    };
  }
}

function canonicalLibraryIdentityDecisionInput(
  albumId: string,
  command: Record<string, unknown> | LibraryIdentityDecisionCommand,
): string {
  return JSON.stringify(sortJsonValue({ albumId, command }));
}

function supportedArtworkMime(
  value: string | null | undefined,
): ArtworkAssetInput["mimeType"] | null {
  return value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/webp"
    ? value
    : null;
}

function artworkExtension(
  mimeType: ArtworkAssetInput["mimeType"],
): ArtworkAssetInput["extension"] {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  return ".jpg";
}

function artworkCandidateId(
  libraryAlbumId: string,
  candidate: ArtworkCandidateInput,
): string {
  return `artwork-${createHash("sha256")
    .update(
      JSON.stringify(
        sortJsonValue({
          libraryAlbumId,
          localVersionId: candidate.localVersionId,
          source: candidate.source,
          sha256: candidate.sha256,
          kind: candidate.kind,
        }),
      ),
    )
    .digest("hex")
    .slice(0, 32)}`;
}

function emptyArtworkValue(): Artwork {
  return {
    source: "NONE",
    url: null,
    mimeType: null,
    width: null,
    height: null,
  };
}

function emptyArtworkSelection(
  libraryAlbumId: string,
): ArtworkSelectionSnapshot {
  return {
    libraryAlbumId,
    state: null,
    assetSha256: null,
    candidateId: null,
    actorId: null,
    actorDisplayName: null,
    createdAt: null,
    updatedAt: null,
  };
}

function artworkFromAsset(row: Record<string, unknown>): Artwork {
  const sourceType = nullableString(row.source_type);
  const source: Artwork["source"] =
    sourceType === "OBSERVED_EMBEDDED"
      ? "EMBEDDED"
      : sourceType === "OBSERVED_SIDECAR"
        ? "SIDECAR"
        : sourceType === "USER_UPLOAD"
          ? "USER_UPLOAD"
          : sourceType === "MUSICBRAINZ_CAA"
            ? "MUSICBRAINZ_CAA"
            : "REPRESENTATIVE";
  return {
    source,
    url: `/api/v1/artwork/${String(row.asset_sha256 ?? row.sha256)}`,
    mimeType: String(row.mime_type),
    width: Number(row.width),
    height: Number(row.height),
  };
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

function sameArtworkSelections(
  left: LibraryIdentitySnapshot,
  right: LibraryIdentitySnapshot,
): boolean {
  const state = (snapshot: LibraryIdentitySnapshot) =>
    snapshot.groups
      .map((group) => ({
        id: group.id,
        state: group.artworkSelection?.state ?? null,
        assetSha256: group.artworkSelection?.assetSha256 ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(state(left)) === JSON.stringify(state(right));
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

function lifecycleQuarantinePath(planId: string, relativePath: string): string {
  if (
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  )
    throw new LibraryLifecycleError(
      "INVALID_LIFECYCLE_COMMAND",
      "文件路径不在来源目录内",
    );
  const segments = relativePath.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new LibraryLifecycleError(
      "INVALID_LIFECYCLE_COMMAND",
      "文件路径包含不安全的目录片段",
    );
  return `${planId}/${segments.join("/")}`;
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

function isAlbumMetadataField(
  field: MetadataField,
): field is "title" | "albumArtist" | "year" {
  return field === "title" || field === "albumArtist" || field === "year";
}

function normalizeMetadataValue(
  field: MetadataField,
  value: string | number,
): string | number {
  const invalidText = (text: string, maximum: number) =>
    text.length > maximum ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text);
  if (field === "year") {
    const year = typeof value === "number" ? value : Number(value);
    if (
      !Number.isInteger(year) ||
      year < 1000 ||
      year > new Date().getUTCFullYear() + 1
    )
      throw new AlbumMetadataDecisionError(
        "INVALID_METADATA_DECISION",
        "年份必须是 1000 至下一年之间的整数",
      );
    return year;
  }
  if (typeof value !== "string")
    throw new AlbumMetadataDecisionError(
      "INVALID_METADATA_DECISION",
      `${field} 必须是文本`,
    );
  const text = value.trim();
  const maximum =
    field === "catalogNumber" ? 100 : field === "barcode" ? 14 : 300;
  if (!text)
    throw new AlbumMetadataDecisionError(
      "INVALID_METADATA_DECISION",
      `${field} 不能设置为空白；需要空值时请使用 CLEAR`,
    );
  if (invalidText(text, maximum))
    throw new AlbumMetadataDecisionError(
      "INVALID_METADATA_DECISION",
      `${field} 的长度或字符不符合要求`,
    );
  if (field === "barcode" && !/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(text))
    throw new AlbumMetadataDecisionError(
      "INVALID_METADATA_DECISION",
      "条码必须是 8、12、13 或 14 位数字",
    );
  if (field === "country" && !/^[A-Z]{2}$/.test(text))
    throw new AlbumMetadataDecisionError(
      "INVALID_METADATA_DECISION",
      "国家必须是两位大写国家码",
    );
  if (field === "releaseDate" && !validReleaseDate(text))
    throw new AlbumMetadataDecisionError(
      "INVALID_METADATA_DECISION",
      "发行日期必须是 YYYY、YYYY-MM 或有效的 YYYY-MM-DD",
    );
  return text;
}

function validReleaseDate(value: string): boolean {
  if (/^\d{4}$/.test(value)) return true;
  if (/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) return true;
  if (!/^\d{4}-(?:0[1-9]|1[0-2])-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseMetadataJson(value: string | null): string | number | null {
  if (value === null) return null;
  return parseJson<string | number | null>(value, null);
}

function metadataString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function mapStoredMetadataValue(
  row: Record<string, unknown>,
): StoredMetadataValue {
  return {
    scopeType: row.scope_type as StoredMetadataValue["scopeType"],
    ownerId: String(row.owner_id),
    fieldName: row.field_name as MetadataField,
    sourceType: row.source_type as StoredMetadataValue["sourceType"],
    valueJson: row.value_json === null ? null : String(row.value_json),
    evidenceJson: String(row.evidence_json),
    actorId: nullableString(row.actor_id),
    actorDisplayName: nullableString(row.actor_display_name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function canonicalMetadataInput(
  libraryAlbumId: string,
  expectedMetadataRevision: number,
  commands: unknown[],
): string {
  return JSON.stringify({
    libraryAlbumId,
    expectedMetadataRevision,
    commands,
  });
}

function effectiveAlbumFieldSql(
  field: "title" | "albumArtist" | "year",
  observedSql: string,
): string {
  const row = (source: "USER_OVERRIDE" | "CONFIRMED_EXTERNAL") =>
    `(SELECT json_extract(mv.value_json,'$') FROM library_metadata_values mv
      WHERE mv.scope_type='ALBUM' AND mv.owner_id=la.id
        AND mv.field_name='${field}' AND mv.source_type='${source}')`;
  const exists = (source: "USER_OVERRIDE" | "CONFIRMED_EXTERNAL") =>
    `EXISTS(SELECT 1 FROM library_metadata_values mv
      WHERE mv.scope_type='ALBUM' AND mv.owner_id=la.id
        AND mv.field_name='${field}' AND mv.source_type='${source}')`;
  return `(CASE WHEN ${exists("USER_OVERRIDE")} THEN ${row("USER_OVERRIDE")}
    WHEN ${exists("CONFIRMED_EXTERNAL")} THEN ${row("CONFIRMED_EXTERNAL")}
    ELSE ${observedSql} END)`;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function readInventoryVersionFactRows(
  database: Sqlite,
): Record<string, unknown>[] {
  return database
    .prepare(
      `SELECT a.id,a.root_id,lm.library_album_id,
              CASE WHEN la.primary_version_id=a.id THEN 1 ELSE 0 END AS is_primary,
              lm.relationship_status,la.primary_version_source,
              (SELECT COUNT(*) FROM physical_copies pc WHERE pc.album_id=a.id) AS physical_copy_count,
              COALESCE((SELECT SUM(pc.quantity) FROM physical_copies pc WHERE pc.album_id=a.id),0) AS physical_quantity,
              EXISTS(SELECT 1 FROM delivery_records dr WHERE dr.album_id=a.id) AS has_delivery_record,
              EXISTS(SELECT 1 FROM delivery_jobs dj WHERE dj.album_id=a.id) AS has_delivery_job,
              EXISTS(SELECT 1 FROM album_introductions ai WHERE ai.album_id=a.id) AS has_introduction,
              EXISTS(SELECT 1 FROM release_match_candidates rc WHERE rc.album_id=a.id) AS has_candidate,
              EXISTS(SELECT 1 FROM library_metadata_values mv WHERE mv.scope_type='VERSION' AND mv.owner_id=a.id) AS has_version_metadata,
              EXISTS(SELECT 1 FROM library_metadata_event_groups meg WHERE meg.library_album_id=lm.library_album_id) AS has_metadata_governance,
              (EXISTS(SELECT 1 FROM library_artwork_candidates ac WHERE ac.local_version_id=a.id)
                OR EXISTS(SELECT 1 FROM library_artwork_selections ase WHERE ase.library_album_id=lm.library_album_id)
                OR EXISTS(SELECT 1 FROM library_artwork_event_groups aeg WHERE aeg.library_album_id=lm.library_album_id)) AS has_artwork,
              EXISTS(SELECT 1 FROM library_visibility_events ve WHERE ve.library_album_id=lm.library_album_id) AS has_visibility,
              EXISTS(SELECT 1 FROM library_change_plans cp WHERE cp.local_version_id=a.id) AS has_lifecycle,
              EXISTS(SELECT 1 FROM library_issues li WHERE li.album_id=a.id) AS has_issue
       FROM albums a
       LEFT JOIN library_album_members lm ON lm.album_id=a.id
       LEFT JOIN library_albums la ON la.id=lm.library_album_id
       ORDER BY a.id`,
    )
    .all() as Record<string, unknown>[];
}

function zeroFileRetentionReasons(
  row: Record<string, unknown>,
  localVersionId: string,
  auditReferences: ReturnType<typeof readInventoryAuditVersionReferences>,
): InventoryReason[] {
  const facts: Array<[boolean, InventoryReason]> = [
    [Boolean(row.has_delivery_record), "DELIVERY_RECORD"],
    [Boolean(row.has_delivery_job), "DELIVERY_JOB"],
    [Boolean(row.has_introduction), "ALBUM_INTRODUCTION"],
    [Boolean(row.has_candidate), "RELEASE_CANDIDATE"],
    [
      row.relationship_status === "USER_CONFIRMED" ||
        row.relationship_status === "USER_SEPARATE" ||
        auditReferences.identity.has(localVersionId),
      "USER_IDENTITY",
    ],
    [
      row.primary_version_source === "USER" && Boolean(row.is_primary),
      "USER_PRIMARY",
    ],
    [Boolean(row.has_version_metadata), "VERSION_METADATA"],
    [
      Boolean(row.has_metadata_governance) ||
        auditReferences.metadata.has(localVersionId),
      "METADATA_GOVERNANCE",
    ],
    [
      Boolean(row.has_artwork) || auditReferences.artwork.has(localVersionId),
      "ARTWORK_GOVERNANCE",
    ],
    [Boolean(row.has_visibility), "VISIBILITY_GOVERNANCE"],
    [Boolean(row.has_lifecycle), "LIFECYCLE_GOVERNANCE"],
    [Boolean(row.has_issue), "LIBRARY_ISSUE"],
  ];
  return facts.filter(([present]) => present).map(([, reason]) => reason);
}

function readInventoryAuditVersionReferences(database: Sqlite): {
  identity: Set<string>;
  metadata: Set<string>;
  artwork: Set<string>;
} {
  const result = {
    identity: new Set<string>(),
    metadata: new Set<string>(),
    artwork: new Set<string>(),
  };
  const add = (target: Set<string>, value: unknown) => {
    if (typeof value === "string" && value.length > 0) target.add(value);
  };
  const object = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const array = (value: unknown): unknown[] =>
    Array.isArray(value) ? value : [];
  const parsed = (value: unknown): Record<string, unknown> | null =>
    object(parseJson<unknown>(value, null));

  const identityRows = database
    .prepare(
      `SELECT input_json,details_json,before_state_json,after_state_json,result_json
       FROM library_identity_decisions`,
    )
    .all() as Record<string, unknown>[];
  for (const row of identityRows) {
    for (const column of [
      "input_json",
      "details_json",
      "before_state_json",
      "after_state_json",
      "result_json",
    ]) {
      const document = parsed(row[column]);
      if (!document) continue;
      add(result.identity, document.primaryVersionId);
      for (const partitionValue of array(document.partitions)) {
        const partition = object(partitionValue);
        if (!partition) continue;
        add(result.identity, partition.primaryVersionId);
        for (const id of array(partition.versionIds)) add(result.identity, id);
      }
      const details = object(document.details);
      if (details) {
        add(result.identity, details.primaryVersionId);
        for (const partitionValue of array(details.partitions)) {
          const partition = object(partitionValue);
          if (!partition) continue;
          add(result.identity, partition.primaryVersionId);
          for (const id of array(partition.versionIds))
            add(result.identity, id);
        }
      }
      for (const groupValue of array(document.groups)) {
        const group = object(groupValue);
        if (!group) continue;
        add(result.identity, group.primaryVersionId);
        for (const memberValue of array(group.members)) {
          const member = object(memberValue);
          if (member) add(result.identity, member.albumId);
        }
      }
    }
  }

  const metadataRows = database
    .prepare(
      `SELECT input_json,commands_json,before_state_json,after_state_json,result_json
       FROM library_metadata_events`,
    )
    .all() as Record<string, unknown>[];
  for (const row of metadataRows) {
    for (const column of [
      "input_json",
      "commands_json",
      "before_state_json",
      "after_state_json",
      "result_json",
    ]) {
      const raw = parseJson<unknown>(row[column], null);
      const document = object(raw);
      const commands = Array.isArray(raw) ? raw : array(document?.commands);
      for (const commandValue of commands) {
        const command = object(commandValue);
        if (command) add(result.metadata, command.versionId);
      }
      if (!document) continue;
      for (const id of array(document.memberVersionIds))
        add(result.metadata, id);
      for (const valueItem of array(document.values)) {
        const value = object(valueItem);
        if (value?.scopeType === "VERSION") add(result.metadata, value.ownerId);
      }
    }
  }

  const artworkRows = database
    .prepare(
      `SELECT input_json,before_state_json,after_state_json,result_json
       FROM library_artwork_events`,
    )
    .all() as Record<string, unknown>[];
  for (const row of artworkRows) {
    for (const column of [
      "input_json",
      "before_state_json",
      "after_state_json",
      "result_json",
    ]) {
      const document = parsed(row[column]);
      if (!document) continue;
      add(result.artwork, document.localVersionId);
      for (const candidateValue of array(document.candidates)) {
        const candidate = object(candidateValue);
        if (candidate) add(result.artwork, candidate.localVersionId);
      }
      const artwork = object(document.artwork);
      for (const candidateValue of array(artwork?.candidates)) {
        const candidate = object(candidateValue);
        if (candidate) add(result.artwork, candidate.localVersionId);
      }
    }
  }
  return result;
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
