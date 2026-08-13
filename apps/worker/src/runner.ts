import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  sep,
} from "node:path";
import type { AlbumSummary, ObservedMediaFile } from "@cocean/contracts";
import type { Logger } from "pino";
import { scanMediaFiles } from "@cocean/media-scanner";
import {
  CoceanDatabase,
  type AlbumIdentityHint,
  type AlbumRecordInput,
} from "@cocean/database";
import { cachePreferredArtwork } from "./artwork-cache.js";
import { groupAlbums, stableFileId, type IndexedFile } from "./albums.js";
import type { WorkerConfig } from "./config.js";
import { collectAudioInventory } from "./discover.js";

// T0 changes when an incremental scan is allowed to publish an Album, not how
// an individual media file is parsed. Keep the v5 evidence contract so an
// upgrade can reuse the last compatible snapshot instead of forcing a
// terabyte-scale reparse and silently changing the accepted tag-warning
// baseline.
export const SCAN_RULES_VERSION = "cocean-library-scan/5";

interface ParsedObservation {
  file: ObservedMediaFile;
  artwork: AlbumSummary["artwork"];
  warningCodes: string[];
}

interface ResolvedIndexedFile extends IndexedFile {
  warningCodes: string[];
}

export async function processNextJob(
  database: CoceanDatabase,
  config: WorkerConfig,
  logger: Logger,
  signal?: AbortSignal,
  now = new Date(),
  clock: () => Date = () => new Date(),
): Promise<boolean> {
  await observeDueAutoDiscoveryProbes(
    database,
    config,
    logger,
    signal,
    now,
    clock,
  );
  database.enqueueDueAutoDiscoveryJobs(now);
  const job = database.claimNextScanJob();
  if (!job) return false;
  const root = database.getLibraryRoot(job.rootId);
  if (!root) {
    database.finalizeFailedScan(
      job.id,
      `Library root ${job.rootId} is unavailable`,
      SCAN_RULES_VERSION,
    );
    return true;
  }
  logger.info(
    { jobId: job.id, rootId: root.id },
    "starting read-only library scan",
  );
  let totalFiles = 0;
  let processedFiles = 0;
  let parsedFiles = 0;
  let unsupportedFiles = 0;
  let failedFiles = 0;
  let reusedFiles = 0;
  try {
    const inventory = await collectAudioInventory(
      root.containerPath,
      signal,
      config.excludeDirectories,
    );
    if (inventory.excludedDirectories.length)
      logger.info(
        { count: inventory.excludedDirectories.length },
        "skipped explicitly excluded library directories",
      );
    totalFiles = inventory.supported.length + inventory.unsupported.length;
    database.recordScanDiscovery({
      scanJobId: job.id,
      rulesVersion: SCAN_RULES_VERSION,
      candidates: totalFiles,
      regularFiles: inventory.regularFiles,
      auxiliaryFiles: inventory.auxiliaryFiles,
      ignoredFiles: inventory.ignoredFiles,
      skippedSymlinks: inventory.symlinks.length,
      traversalErrors: inventory.traversalIssues.length,
    });

    for (const path of inventory.symlinks) {
      database.recordScanFileResult({
        scanJobId: job.id,
        rootId: root.id,
        relativePath: evidenceRelativePath(root.containerPath, path),
        extension: extname(path).toLowerCase(),
        candidateKind: "SYMLINK",
        outcome: "SKIPPED",
        mediaFileId: null,
        sizeBytes: null,
        modifiedAtMs: null,
        errorCode: "SKIPPED_SYMLINK",
        errorStage: "discover",
        warningCodes: [],
      });
    }
    for (const issue of inventory.traversalIssues) {
      const relativePath = evidenceRelativePath(root.containerPath, issue.path);
      database.recordScanFileResult({
        scanJobId: job.id,
        rootId: root.id,
        relativePath,
        extension: "",
        candidateKind: "TRAVERSAL_ERROR",
        outcome: "FAILED",
        mediaFileId: null,
        sizeBytes: null,
        modifiedAtMs: null,
        errorCode: issue.code,
        errorStage: "discover",
        warningCodes: [],
      });
      database.recordScanFailure({
        scanJobId: job.id,
        rootId: root.id,
        relativePath,
        code: issue.code,
        stage: "discover",
        message: "无法完整遍历该相对目录；为防止误删，当前库快照不会更新",
        recoverable: true,
      });
    }
    if (signal?.aborted)
      throw new Error("Worker stopped while scan discovery was running");
    if (database.isScanCancellationRequested(job.id))
      throw new ScanCancelledError();
    if (inventory.traversalIssues.length > 0)
      throw new Error(
        "Library traversal was incomplete; the previous library snapshot was preserved",
      );

    const requiresAlbumStability = database.scanRequiresAlbumStability(job.id);
    const stability =
      requiresAlbumStability
        ? database.observeAlbumDirectories(
            root.id,
            albumDirectoryFingerprints(root.containerPath, inventory.fileFacts),
            clock(),
          )
        : {
            stableDirectories: albumDirectoryFingerprints(
              root.containerPath,
              inventory.fileFacts,
            ).map((candidate) => candidate.relativeDirectory),
            deferredDirectories: [],
          };
    database.updateScanStability(
      job.id,
      stability.stableDirectories.length,
      stability.deferredDirectories.length,
    );
    if (requiresAlbumStability && stability.deferredDirectories.length > 0)
      database.scheduleAutoDiscoveryStabilityCheck(root.id, now);
    const stableDirectories = new Set(stability.stableDirectories);
    const deferredDirectories = new Set(stability.deferredDirectories);
    const eligibleSupported = inventory.supported.filter((path) =>
      stableDirectories.has(albumDirectory(root.containerPath, path)),
    );
    const eligibleUnsupported = inventory.unsupported.filter((path) =>
      stableDirectories.has(albumDirectory(root.containerPath, path)),
    );
    if (deferredDirectories.size)
      logger.info(
        {
          jobId: job.id,
          deferredAlbumDirectories: deferredDirectories.size,
        },
        "deferred changing album directories until the stability window is satisfied",
      );

    for (const path of eligibleUnsupported) {
      const relativePath = evidenceRelativePath(root.containerPath, path);
      database.recordScanFileResult({
        scanJobId: job.id,
        rootId: root.id,
        relativePath,
        extension: extname(path).toLowerCase(),
        candidateKind: "KNOWN_UNSUPPORTED_AUDIO",
        outcome: "UNSUPPORTED",
        mediaFileId: null,
        sizeBytes: null,
        modifiedAtMs: null,
        errorCode: "UNSUPPORTED_MEDIA",
        errorStage: "discover",
        warningCodes: [],
      });
      database.recordScanFailure({
        scanJobId: job.id,
        rootId: root.id,
        relativePath,
        code: "UNSUPPORTED_MEDIA",
        stage: "discover",
        message: `当前规则不支持该音频载体 (${extname(path).toLowerCase() || "未知扩展名"})；源文件未被读取或修改`,
        recoverable: true,
      });
      processedFiles += 1;
      unsupportedFiles += 1;
    }
    database.updateScanProgress(job.id, {
      totalFiles,
      processedFiles,
      parsedFiles,
      failedFiles: unsupportedFiles + failedFiles,
      reusedFiles,
    });

    const existingFiles = database.listMediaFilesForRoot(root.id);
    const albumIdentityHints = database.listAlbumIdentityHints(root.id);
    const unavailableAlbumIds = new Set(database.listAlbumIds());
    const parsedObservations: ParsedObservation[] = [];
    const existingByPath = new Map(
      existingFiles.map((item) => [item.file.relativePath, item]),
    );
    const scanPaths: string[] = [];
    const canReuse =
      job.mode === "INCREMENTAL" &&
      hasCompatiblePreviousSnapshot(database, root.id, job.id);
    if (canReuse) {
      let inspected = 0;
      for (const absolutePath of eligibleSupported) {
        const relativePath = evidenceRelativePath(
          root.containerPath,
          absolutePath,
        );
        inspected += 1;
        if (inspected % 50 === 0) {
          database.updateScanProgress(job.id, {
            totalFiles,
            processedFiles,
            parsedFiles,
            failedFiles: unsupportedFiles + failedFiles,
            reusedFiles,
          });
          if (database.isScanCancellationRequested(job.id))
            throw new ScanCancelledError();
        }
        const existing = existingByPath.get(relativePath);
        if (!existing) {
          scanPaths.push(absolutePath);
          continue;
        }
        // Incremental scans are a filesystem delta: unchanged files must not
        // be reread just because their existing tags need review. Parser/tag
        // repair belongs to an explicit full scan after the rules version is
        // advanced; this avoids hashing large DSD files on every incremental.
        const information = await stat(absolutePath);
        if (
          information.size !== existing.file.sizeBytes ||
          information.mtimeMs !== existing.file.modifiedAtMs
        ) {
          scanPaths.push(absolutePath);
          continue;
        }
        parsedObservations.push({
          file: existing.file,
          artwork: existingArtwork(existing.file),
          warningCodes: [
            ...new Set(existing.file.warnings.map((warning) => warning.code)),
          ],
        });
        processedFiles += 1;
        parsedFiles += 1;
        reusedFiles += 1;
      }
      database.updateScanProgress(job.id, {
        totalFiles,
        processedFiles,
        parsedFiles,
        failedFiles: unsupportedFiles + failedFiles,
        reusedFiles,
      });
      if (database.isScanCancellationRequested(job.id))
        throw new ScanCancelledError();
    } else {
      scanPaths.push(...eligibleSupported);
    }
    let successfulWarnings = 0;
    for await (const outcome of scanMediaFiles(scanPaths, {
      rootPath: root.containerPath,
      ffprobePath: config.ffprobePath,
      ffprobeTimeoutMs: config.ffprobeTimeoutMs,
      ...(signal ? { signal } : {}),
    })) {
      processedFiles += 1;
      if (outcome.ok) {
        let artworkCacheFailed = false;
        const artwork = await cachePreferredArtwork(
          outcome.value,
          config.cacheRoot,
        ).catch(() => {
          artworkCacheFailed = true;
          logger.warn(
            { relativePath: outcome.value.relativePath },
            "failed to cache artwork",
          );
          return emptyArtwork();
        });
        const warnings = [
          ...outcome.value.warnings,
          ...(artworkCacheFailed
            ? [
                {
                  code: "ARTWORK_CACHE_FAILED",
                  message: "首选封面无法写入 COCEAN 缓存；源音乐文件未被修改",
                },
              ]
            : []),
        ];
        // The detailed warnings retain one message per conflicting field, but
        // the compact evidence/API code list is a set by contract.
        const warningCodes = [
          ...new Set(warnings.map((warning) => warning.code)),
        ];
        parsedObservations.push({
          file: { ...outcome.value, warnings },
          artwork,
          warningCodes,
        });
        successfulWarnings += warningCodes.length;
        parsedFiles += 1;
      } else {
        const relativePath = evidenceRelativePath(
          root.containerPath,
          outcome.filePath,
        );
        const unsupported = outcome.error.code === "UNSUPPORTED_MEDIA";
        database.recordScanFileResult({
          scanJobId: job.id,
          rootId: root.id,
          relativePath,
          extension: extname(outcome.filePath).toLowerCase(),
          candidateKind: "SUPPORTED_AUDIO",
          outcome: unsupported ? "UNSUPPORTED" : "FAILED",
          mediaFileId: null,
          sizeBytes: null,
          modifiedAtMs: null,
          errorCode: outcome.error.code,
          errorStage: outcome.error.stage,
          warningCodes: [],
        });
        if (unsupported) unsupportedFiles += 1;
        else failedFiles += 1;
        database.recordScanFailure({
          scanJobId: job.id,
          rootId: root.id,
          relativePath,
          code: outcome.error.code,
          stage: outcome.error.stage,
          message: safeFailureMessage(outcome.error.code),
          recoverable: outcome.error.recoverable,
        });
        logger.warn(
          {
            code: outcome.error.code,
            stage: outcome.error.stage,
            relativePath,
          },
          "media file could not be parsed",
        );
      }
      if (processedFiles % 25 === 0 || processedFiles === totalFiles)
        database.updateScanProgress(job.id, {
          totalFiles,
          processedFiles,
          parsedFiles,
          failedFiles: unsupportedFiles + failedFiles,
          reusedFiles,
        });
      if (database.isScanCancellationRequested(job.id))
        throw new ScanCancelledError();
    }
    if (signal?.aborted)
      throw new Error("Worker stopped while scan was running");

    const seenRelativePaths = [...inventory.supported, ...inventory.unsupported]
      .map((path) => evidenceRelativePath(root.containerPath, path))
      .concat(
        existingFiles
          .filter((item) =>
            deferredDirectories.has(
              albumDirectoryFromRelativePath(item.file.relativePath),
            ),
          )
          .map((item) => item.file.relativePath),
      )
      .filter((path, index, paths) => paths.indexOf(path) === index)
      .sort((a, b) => a.localeCompare(b));
    const indexed = assignStableMediaIds(
      root.id,
      existingFiles,
      parsedObservations,
      new Set(seenRelativePaths),
    );
    for (const item of indexed) {
      database.recordScanFileResult({
        scanJobId: job.id,
        rootId: root.id,
        relativePath: item.file.relativePath,
        extension: item.file.extension,
        candidateKind: "SUPPORTED_AUDIO",
        outcome: "PARSED",
        mediaFileId: item.id,
        sizeBytes: item.file.sizeBytes,
        modifiedAtMs: item.file.modifiedAtMs,
        errorCode: null,
        errorStage: null,
        warningCodes: item.warningCodes,
      });
    }
    const survivors = mergeWithLastGood(
      existingFiles,
      indexed,
      new Set(seenRelativePaths),
    );
    const albums = reconcileAlbumIdentities(
      groupAlbums(root.id, survivors),
      albumIdentityHints,
      unavailableAlbumIds,
    );
    const albumIssueCount = albums.reduce(
      (total, album) => total + (album.aggregationIssues?.length ?? 0),
      0,
    );
    const report = database.finalizeSuccessfulScan({
      scanJobId: job.id,
      rootId: root.id,
      stagedFiles: indexed.map(({ id, file }) => ({ id, file })),
      seenRelativePaths,
      albums,
      withWarnings:
        deferredDirectories.size > 0 ||
        unsupportedFiles > 0 ||
        failedFiles > 0 ||
        inventory.symlinks.length > 0 ||
        successfulWarnings > 0 ||
        parsedObservations.some(
          (observation) => observation.warningCodes.length > 0,
        ) ||
        albumIssueCount > 0,
    });
    logger.info(
      {
        jobId: job.id,
        candidates: report.candidates,
        parsed: report.parsed,
        unsupported: report.unsupported,
        failed: report.failed,
        albums: report.albumCount,
        summaryHash: report.summaryHash,
      },
      "library scan completed",
    );
  } catch (error) {
    if (error instanceof ScanCancelledError) {
      const report = database.finalizeCancelledScan(job.id, SCAN_RULES_VERSION);
      logger.info(
        {
          jobId: job.id,
          processed: report.processed,
          unprocessed: report.unprocessed,
        },
        "library scan cancelled; previous library snapshot was preserved",
      );
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    const report = database.finalizeFailedScan(
      job.id,
      safeJobError(message),
      SCAN_RULES_VERSION,
    );
    logger.error(
      {
        jobId: job.id,
        status: report.status,
        processed: report.processed,
        unprocessed: report.unprocessed,
      },
      "library scan failed; previous library snapshot was preserved",
    );
  }
  return true;
}

export async function observeDueAutoDiscoveryProbes(
  database: CoceanDatabase,
  config: WorkerConfig,
  logger: Logger,
  signal?: AbortSignal,
  now = new Date(),
  clock: () => Date = () => new Date(),
): Promise<number> {
  let observed = 0;
  for (const root of database.listDueAutoDiscoveryProbes(now)) {
    if (signal?.aborted) break;
    const inventory = await collectAudioInventory(
      root.containerPath,
      signal,
      config.excludeDirectories,
    );
    if (inventory.traversalIssues.length > 0) {
      database.markAutoDiscoveryProbeCompleted(root.id, root.scheduledScanAt);
      logger.warn(
        { rootId: root.id, traversalErrors: inventory.traversalIssues.length },
        "skipped automatic-discovery stability probe after incomplete traversal",
      );
      continue;
    }
    const observedAt = clock();
    database.observeAlbumDirectories(
      root.id,
      albumDirectoryFingerprints(root.containerPath, inventory.fileFacts),
      observedAt,
    );
    if (database.markAutoDiscoveryProbeCompleted(root.id, root.scheduledScanAt))
      observed += 1;
  }
  return observed;
}

function hasCompatiblePreviousSnapshot(
  database: CoceanDatabase,
  rootId: string,
  currentJobId: string,
): boolean {
  const previous = database
    .listScanJobs(100)
    .find(
      (candidate) =>
        candidate.id !== currentJobId &&
        candidate.rootId === rootId &&
        ["COMPLETED", "COMPLETED_WITH_WARNINGS"].includes(candidate.status),
    );
  return previous
    ? database.getScanReport(previous.id)?.rulesVersion === SCAN_RULES_VERSION
    : false;
}

class ScanCancelledError extends Error {
  constructor() {
    super("Scan cancelled by user");
    this.name = "ScanCancelledError";
  }
}

function existingArtwork(file: ObservedMediaFile): AlbumSummary["artwork"] {
  const preferred = file.artwork[0];
  return preferred?.sha256
    ? {
        source: preferred.source,
        url: `/api/v1/artwork/${preferred.sha256}`,
        mimeType: preferred.mimeType,
        width: preferred.width,
        height: preferred.height,
      }
    : emptyArtwork();
}

function assignStableMediaIds(
  rootId: string,
  existing: Array<{ id: string; file: ObservedMediaFile }>,
  parsed: ParsedObservation[],
  seenRelativePaths: Set<string>,
): ResolvedIndexedFile[] {
  const existingByPath = new Map(
    existing.map((item) => [item.file.relativePath, item]),
  );
  const existingById = new Map(existing.map((item) => [item.id, item]));
  const eligibleOldBySha = new Map<
    string,
    Array<{ id: string; file: ObservedMediaFile }>
  >();
  for (const item of existing) {
    const checksum = item.file.fileSha256;
    if (!checksum || seenRelativePaths.has(item.file.relativePath)) continue;
    const matches = eligibleOldBySha.get(checksum) ?? [];
    matches.push(item);
    eligibleOldBySha.set(checksum, matches);
  }
  const newBySha = new Map<string, ParsedObservation[]>();
  for (const item of parsed) {
    const checksum = item.file.fileSha256;
    if (!checksum || existingByPath.has(item.file.relativePath)) continue;
    const matches = newBySha.get(checksum) ?? [];
    matches.push(item);
    newBySha.set(checksum, matches);
  }
  const assignedIds = new Set<string>();
  return parsed.map((item) => {
    const samePath = existingByPath.get(item.file.relativePath);
    const checksum = item.file.fileSha256;
    const uniqueRename = checksum
      ? eligibleOldBySha.get(checksum)?.length === 1 &&
        newBySha.get(checksum)?.length === 1
        ? eligibleOldBySha.get(checksum)?.[0]
        : undefined
      : undefined;
    let id = samePath?.id ?? uniqueRename?.id ?? "";
    if (!id || assignedIds.has(id)) {
      let attempt = 0;
      do {
        const identityPath =
          attempt === 0
            ? item.file.relativePath
            : `identity-v2\0${item.file.relativePath}\0${checksum ?? "no-sha"}\0${attempt}`;
        id = stableFileId(rootId, identityPath);
        attempt += 1;
      } while (
        assignedIds.has(id) ||
        (existingById.has(id) &&
          existingById.get(id)?.file.relativePath !== item.file.relativePath)
      );
    }
    assignedIds.add(id);
    return { id, ...item };
  });
}

function reconcileAlbumIdentities(
  albums: AlbumRecordInput[],
  existing: AlbumIdentityHint[],
  unavailableAlbumIds: Set<string>,
): AlbumRecordInput[] {
  const oldAlbumByFileId = new Map<string, Set<string>>();
  const knownAlbumIds = new Set(existing.map((album) => album.id));
  const oldAlbumIdByGroupKey = new Map(
    existing.map((album) => [album.groupKey, album.id]),
  );
  for (const album of existing) {
    for (const fileId of album.fileIds) {
      const ids = oldAlbumByFileId.get(fileId) ?? new Set<string>();
      ids.add(album.id);
      oldAlbumByFileId.set(fileId, ids);
    }
  }
  // A stable group key is stronger identity evidence than file overlap. Reserve
  // every exact match first so a file that moved between historical groups
  // cannot claim an Album row whose UNIQUE(root_id, group_key) slot is still
  // occupied during the atomic snapshot replacement.
  const exactMatches = albums.map(
    (album) => oldAlbumIdByGroupKey.get(album.groupKey) ?? null,
  );
  const exactMatchIds = new Set(
    exactMatches.filter((id): id is string => id !== null),
  );
  const candidates = albums.map((album) => {
    const exactMatch = oldAlbumIdByGroupKey.get(album.groupKey);
    if (exactMatch) return exactMatch;
    const overlap = new Map<string, number>();
    for (const fileId of album.primaryFileIds ?? album.fileIds) {
      for (const id of oldAlbumByFileId.get(fileId) ?? []) {
        if (exactMatchIds.has(id)) continue;
        overlap.set(id, (overlap.get(id) ?? 0) + 1);
      }
    }
    return (
      [...overlap.entries()].sort(
        ([idA, countA], [idB, countB]) =>
          countB - countA || idA.localeCompare(idB),
      )[0]?.[0] ?? null
    );
  });
  const useCount = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate) useCount.set(candidate, (useCount.get(candidate) ?? 0) + 1);
  }
  const assignmentByIndex = new Map<number, string>();
  const assignedIds = new Set<string>();
  const assign = (index: number, id: string): boolean => {
    if (assignedIds.has(id)) return false;
    assignmentByIndex.set(index, id);
    assignedIds.add(id);
    return true;
  };

  // Resolve the whole set instead of deciding each Album independently. This
  // also handles historical cross-assignments such as {id: X, key: A} and
  // {id: stable(A), key: B} without assigning stable(A) twice.
  exactMatches.forEach((id, index) => {
    if (id) assign(index, id);
  });
  candidates.forEach((candidate, index) => {
    if (
      candidate &&
      !assignmentByIndex.has(index) &&
      useCount.get(candidate) === 1
    )
      assign(index, candidate);
  });
  albums.forEach((album, index) => {
    if (!assignmentByIndex.has(index) && knownAlbumIds.has(album.id))
      assign(index, album.id);
  });
  albums.forEach((album, index) => {
    if (assignmentByIndex.has(index)) return;
    if (!unavailableAlbumIds.has(album.id) && assign(index, album.id)) return;
    assign(
      index,
      collisionSafeAlbumId(
        album,
        new Set([...unavailableAlbumIds, ...assignedIds]),
      ),
    );
  });

  return albums.map((album, index) => {
    const assignedId = assignmentByIndex.get(index);
    if (!assignedId)
      throw new Error("Album identity reconciliation did not assign an ID");
    return assignedId === album.id ? album : { ...album, id: assignedId };
  });
}

function collisionSafeAlbumId(
  album: AlbumRecordInput,
  unavailableIds: Set<string>,
): string {
  for (let attempt = 1; ; attempt += 1) {
    const id = createHash("sha256")
      .update(
        [
          "album-reconciled",
          album.rootId,
          album.groupKey,
          String(attempt),
        ].join("\u0000"),
      )
      .digest("base64url")
      .slice(0, 32);
    if (!unavailableIds.has(id)) return id;
  }
}

function mergeWithLastGood(
  existing: Array<{ id: string; file: ObservedMediaFile }>,
  parsed: IndexedFile[],
  seenRelativePaths: Set<string>,
): IndexedFile[] {
  const current = new Map(parsed.map((item) => [item.file.relativePath, item]));
  for (const item of existing) {
    if (
      seenRelativePaths.has(item.file.relativePath) &&
      !current.has(item.file.relativePath)
    ) {
      current.set(item.file.relativePath, {
        ...item,
        artwork: artworkFromLastGood(item.file),
      });
    }
  }
  return [...current.values()].sort((a, b) =>
    a.file.relativePath.localeCompare(b.file.relativePath),
  );
}

function artworkFromLastGood(file: ObservedMediaFile): AlbumSummary["artwork"] {
  const candidate = file.artwork[0];
  if (!candidate?.sha256) return emptyArtwork();
  return {
    source: candidate.source,
    url: `/api/v1/artwork/${candidate.sha256}`,
    mimeType: candidate.mimeType,
    width: candidate.width,
    height: candidate.height,
  };
}

function emptyArtwork(): AlbumSummary["artwork"] {
  return {
    source: "NONE",
    url: null,
    mimeType: null,
    width: null,
    height: null,
  };
}

function evidenceRelativePath(root: string, path: string): string {
  const candidate = relative(root, path);
  if (
    candidate === ".." ||
    candidate.startsWith(`..${sep}`) ||
    isAbsolute(candidate)
  ) {
    return "outside-configured-root";
  }
  return (candidate || ".").split(sep).join("/");
}

function albumDirectory(root: string, path: string): string {
  return albumDirectoryFromRelativePath(evidenceRelativePath(root, path));
}

function albumDirectoryFromRelativePath(relativePath: string): string {
  let directory = dirname(relativePath).split(sep).join("/") || ".";
  if (
    directory !== "." &&
    /^(?:cd|disc|disk|sacd)[\s._-]*\d+$/i.test(basename(directory))
  )
    directory = dirname(directory).split(sep).join("/") || ".";
  return directory;
}

function albumDirectoryFingerprints(
  root: string,
  facts: readonly {
    path: string;
    sizeBytes: number;
    modifiedAtMs: number;
  }[],
): Array<{ relativeDirectory: string; fingerprint: string }> {
  const grouped = new Map<string, string[]>();
  for (const fact of facts) {
    const relativePath = evidenceRelativePath(root, fact.path);
    const relativeDirectory = albumDirectoryFromRelativePath(relativePath);
    const entries = grouped.get(relativeDirectory) ?? [];
    entries.push(
      JSON.stringify([relativePath, fact.sizeBytes, fact.modifiedAtMs]),
    );
    grouped.set(relativeDirectory, entries);
  }
  return [...grouped.entries()]
    .map(([relativeDirectory, entries]) => ({
      relativeDirectory,
      fingerprint: createHash("sha256")
        .update(entries.sort().join("\n"))
        .digest("hex"),
    }))
    .sort((a, b) => a.relativeDirectory.localeCompare(b.relativeDirectory));
}

function safeFailureMessage(code: string): string {
  const messages: Record<string, string> = {
    ABORTED: "媒体扫描被中断；源文件未修改",
    FILE_NOT_FOUND: "扫描期间文件已不存在或被移动",
    PATH_NOT_FILE: "候选路径不再是普通文件",
    PATH_OUTSIDE_ROOT: "候选路径越过音乐根目录边界，未读取",
    FILE_CHANGED_DURING_SCAN: "扫描期间文件发生变化；该次观察未入库",
    FILE_HASH_FAILED: "无法计算整文件 SHA-256 校验值",
    PERMISSION_DENIED: "没有权限读取该文件",
    UNSUPPORTED_MEDIA: "文件没有可由当前规则可靠解析的音频内容",
    CONTENT_TYPE_MISMATCH:
      "文件扩展名是受支持的音频格式，但实际内容不是音频；请核对来源文件",
    METADATA_PARSE_FAILED: "无法可靠解析音频标签",
    FFPROBE_NOT_FOUND: "扫描运行环境缺少 ffprobe",
    FFPROBE_TIMEOUT: "音频技术参数探测超时",
    FFPROBE_FAILED: "无法可靠读取音频技术参数",
    FFPROBE_INVALID_OUTPUT: "音频技术参数探测返回无效结果",
    INVALID_ARGUMENT: "扫描候选参数无效",
    UNKNOWN: "媒体扫描发生未分类错误",
  };
  return messages[code] ?? "媒体扫描发生可追踪错误";
}

function safeJobError(message: string): string {
  if (/traversal|遍历/i.test(message))
    return "音乐目录未能完整遍历；上一版曲库快照已保留";
  if (/stopped|abort|中断/i.test(message))
    return "扫描被中断；上一版曲库快照已保留";
  return "扫描未能完成；上一版曲库快照已保留";
}
