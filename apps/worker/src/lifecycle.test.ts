import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { CoceanDatabase } from "@cocean/database";
import type { WorkerConfig } from "./config.js";
import { processNextLifecyclePlan } from "./lifecycle.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("library lifecycle worker", () => {
  it("quarantines and restores one frozen local version without overwriting", async () => {
    const fixture = await lifecycleFixture();
    const { database, config, sourcePath, bytes, albumId, versionId } = fixture;
    const actor = { id: "admin", displayName: "Admin" };
    const album = database.getAlbumSummary(albumId)!;
    const preview = database.createQuarantinePlan(
      album.id,
      {
        requestId: "worker-preview",
        expectedLibraryRevision: album.revision,
        localVersionId: versionId,
      },
      actor,
    );
    database.confirmLibraryChangePlan(preview.id, "worker-confirm", actor);

    expect(
      await processNextLifecyclePlan(
        database,
        config,
        pino({ level: "silent" }),
        new AbortController().signal,
      ),
    ).toBe(true);
    const quarantinePath = join(
      config.quarantineRoot,
      preview.items[0]!.quarantineRelativePath,
    );
    await expect(access(sourcePath)).rejects.toThrow();
    expect(await readFile(quarantinePath)).toEqual(bytes);
    expect(database.getLibraryChangePlan(preview.id)?.status).toBe("SUCCEEDED");

    const scan = database.claimNextScanJob();
    database.finishScanJob(scan!.id);
    const restore = database.createRestorePlan(
      preview.id,
      "worker-restore-preview",
      actor,
    );
    database.confirmLibraryChangePlan(
      restore.id,
      "worker-restore-confirm",
      actor,
    );
    // Simulate a crash after the verified restore copy and quarantine unlink,
    // but before the item status transaction commits.
    await copyFile(quarantinePath, sourcePath);
    await unlink(quarantinePath);
    await processNextLifecyclePlan(
      database,
      config,
      pino({ level: "silent" }),
      new AbortController().signal,
    );
    expect(await readFile(sourcePath)).toEqual(bytes);
    await expect(access(quarantinePath)).rejects.toThrow();
    expect(database.getLibraryChangePlan(restore.id)?.status).toBe("SUCCEEDED");
    database.close();
  });

  it("fails closed when the quarantine target is occupied", async () => {
    const fixture = await lifecycleFixture();
    const { database, config, sourcePath, albumId, versionId } = fixture;
    const actor = { id: "admin", displayName: "Admin" };
    const album = database.getAlbumSummary(albumId)!;
    const preview = database.createQuarantinePlan(
      album.id,
      {
        requestId: "conflict-preview",
        expectedLibraryRevision: album.revision,
        localVersionId: versionId,
      },
      actor,
    );
    database.confirmLibraryChangePlan(preview.id, "conflict-confirm", actor);
    const target = join(
      config.quarantineRoot,
      preview.items[0]!.quarantineRelativePath,
    );
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "occupied");

    await processNextLifecyclePlan(
      database,
      config,
      pino({ level: "silent" }),
      new AbortController().signal,
    );
    expect(await readFile(sourcePath)).toEqual(fixture.bytes);
    expect(await readFile(target, "utf8")).toBe("occupied");
    expect(database.getLibraryChangePlan(preview.id)).toEqual(
      expect.objectContaining({ status: "RECOVERY_REQUIRED" }),
    );
    database.close();
  });

  it("rejects a source symlink and converges an interrupted verified copy", async () => {
    const fixture = await lifecycleFixture();
    const { database, config, sourcePath, albumId, versionId } = fixture;
    const actor = { id: "admin", displayName: "Admin" };
    const album = database.getAlbumSummary(albumId)!;
    const preview = database.createQuarantinePlan(
      album.id,
      {
        requestId: "symlink-preview",
        expectedLibraryRevision: album.revision,
        localVersionId: versionId,
      },
      actor,
    );
    database.confirmLibraryChangePlan(preview.id, "symlink-confirm", actor);
    const original = `${sourcePath}.original`;
    await writeFile(original, fixture.bytes);
    await rm(sourcePath);
    await symlink(original, sourcePath);
    await processNextLifecyclePlan(
      database,
      config,
      pino({ level: "silent" }),
      new AbortController().signal,
    );
    expect(database.getLibraryChangePlan(preview.id)?.status).toBe(
      "RECOVERY_REQUIRED",
    );
    database.close();

    const resumed = await lifecycleFixture();
    const resumedAlbum = resumed.database.getAlbumSummary(resumed.albumId)!;
    const resumedPlan = resumed.database.createQuarantinePlan(
      resumedAlbum.id,
      {
        requestId: "resume-preview",
        expectedLibraryRevision: resumedAlbum.revision,
        localVersionId: resumed.versionId,
      },
      actor,
    );
    resumed.database.confirmLibraryChangePlan(
      resumedPlan.id,
      "resume-confirm",
      actor,
    );
    const copied = join(
      resumed.config.quarantineRoot,
      resumedPlan.items[0]!.quarantineRelativePath,
    );
    await mkdir(join(copied, ".."), { recursive: true });
    await writeFile(copied, resumed.bytes);
    await processNextLifecyclePlan(
      resumed.database,
      resumed.config,
      pino({ level: "silent" }),
      new AbortController().signal,
    );
    expect(await readFile(resumed.sourcePath)).toEqual(resumed.bytes);
    expect(await readFile(copied)).toEqual(resumed.bytes);
    expect(resumed.database.getLibraryChangePlan(resumedPlan.id)?.status).toBe(
      "RECOVERY_REQUIRED",
    );
    await unlink(copied);
    resumed.database.retryLibraryChangePlan(
      resumedPlan.id,
      "resume-after-manual-fix",
      actor,
    );
    await processNextLifecyclePlan(
      resumed.database,
      resumed.config,
      pino({ level: "silent" }),
      new AbortController().signal,
    );
    await expect(access(resumed.sourcePath)).rejects.toThrow();
    expect(await readFile(copied)).toEqual(resumed.bytes);
    expect(resumed.database.getLibraryChangePlan(resumedPlan.id)?.status).toBe(
      "SUCCEEDED",
    );
    resumed.database.close();
  });

  it("fails closed when runtime database facts or actor authority change", async () => {
    const scanning = await lifecycleFixture();
    const actor = { id: "admin", displayName: "Admin" };
    const album = scanning.database.getAlbumSummary(scanning.albumId)!;
    const plan = scanning.database.createQuarantinePlan(
      album.id,
      {
        requestId: "runtime-scan-preview",
        expectedLibraryRevision: album.revision,
        localVersionId: scanning.versionId,
      },
      actor,
    );
    scanning.database.confirmLibraryChangePlan(
      plan.id,
      "runtime-scan-confirm",
      actor,
    );
    scanning.database.createScanJob({
      id: "late-active-scan",
      rootId: "music",
      mode: "INCREMENTAL",
      status: "RUNNING",
      totalFiles: 0,
      processedFiles: 0,
      parsedFiles: 0,
      failedFiles: 0,
      reusedFiles: 0,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      cancelRequestedAt: null,
    });
    await processNextLifecyclePlan(
      scanning.database,
      scanning.config,
      pino({ level: "silent" }),
      new AbortController().signal,
    );
    expect(await readFile(scanning.sourcePath)).toEqual(scanning.bytes);
    expect(scanning.database.getLibraryChangePlan(plan.id)?.status).toBe(
      "FAILED",
    );
    scanning.database.close();

    const disabled = await lifecycleFixture();
    const disabledAlbum = disabled.database.getAlbumSummary(disabled.albumId)!;
    const disabledPlan = disabled.database.createQuarantinePlan(
      disabledAlbum.id,
      {
        requestId: "disabled-actor-preview",
        expectedLibraryRevision: disabledAlbum.revision,
        localVersionId: disabled.versionId,
      },
      actor,
    );
    disabled.database.confirmLibraryChangePlan(
      disabledPlan.id,
      "disabled-actor-confirm",
      actor,
    );
    disabled.database.updateUser("admin", { enabled: false });
    await processNextLifecyclePlan(
      disabled.database,
      disabled.config,
      pino({ level: "silent" }),
      new AbortController().signal,
    );
    expect(await readFile(disabled.sourcePath)).toEqual(disabled.bytes);
    expect(
      disabled.database.getLibraryChangePlan(disabledPlan.id)?.status,
    ).toBe("FAILED");
    disabled.database.close();
  });

  it("rejects unknown content inside the frozen quarantine namespace", async () => {
    const fixture = await lifecycleFixture();
    const actor = { id: "admin", displayName: "Admin" };
    const album = fixture.database.getAlbumSummary(fixture.albumId)!;
    const plan = fixture.database.createQuarantinePlan(
      album.id,
      {
        requestId: "unknown-target-preview",
        expectedLibraryRevision: album.revision,
        localVersionId: fixture.versionId,
      },
      actor,
    );
    fixture.database.confirmLibraryChangePlan(
      plan.id,
      "unknown-target-confirm",
      actor,
    );
    await mkdir(join(fixture.config.quarantineRoot, plan.id), {
      recursive: true,
    });
    const unknown = join(fixture.config.quarantineRoot, plan.id, "unknown.txt");
    await writeFile(unknown, "unknown");
    await processNextLifecyclePlan(
      fixture.database,
      fixture.config,
      pino({ level: "silent" }),
      new AbortController().signal,
    );
    expect(await readFile(fixture.sourcePath)).toEqual(fixture.bytes);
    expect(await readFile(unknown, "utf8")).toBe("unknown");
    expect(fixture.database.getLibraryChangePlan(plan.id)?.status).toBe(
      "RECOVERY_REQUIRED",
    );
    fixture.database.close();
  });
});

async function lifecycleFixture() {
  const directory = await mkdtemp(join(tmpdir(), "cocean-lifecycle-worker-"));
  temporaryDirectories.push(directory);
  const musicRoot = join(directory, "music");
  const quarantineRoot = join(directory, "quarantine");
  const relativePath = "Artist/Album/01 Track.flac";
  const sourcePath = join(musicRoot, relativePath);
  const bytes = Buffer.from("managed audio bytes");
  await Promise.all([
    mkdir(join(sourcePath, ".."), { recursive: true }),
    mkdir(quarantineRoot, { recursive: true }),
  ]);
  await writeFile(sourcePath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const database = new CoceanDatabase(":memory:", {
    musicRoot,
    musicRootPolicy: "MANAGED",
    quarantineRoot,
  });
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
  const scanId = "lifecycle-scan";
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
  const versionId = "lifecycle-version";
  const fileId = "lifecycle-file";
  database.upsertMediaFile(fileId, "music", scanId, {
    absolutePath: sourcePath,
    relativePath,
    extension: ".flac",
    sizeBytes: bytes.length,
    modifiedAtMs: 1,
    fileSha256: sha256,
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
      groupKey: "artist\0album",
      title: "Album",
      albumArtist: "Artist",
      year: 2026,
      discCount: 1,
      fileIds: [fileId],
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
  const albumId = database.getAlbumSummary(versionId)!.id;
  const config: WorkerConfig = {
    databasePath: ":memory:",
    cacheRoot: join(directory, "cache"),
    musicRoot,
    musicRootPolicy: "MANAGED",
    quarantineRoot,
    pollMs: 1_500,
    ffprobePath: "ffprobe",
    ffprobeTimeoutMs: 30_000,
    excludeDirectories: [],
    logLevel: "silent",
    once: true,
  };
  return { database, config, sourcePath, bytes, albumId, versionId };
}
