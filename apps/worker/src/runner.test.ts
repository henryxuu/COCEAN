import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObservedMediaFile } from "@cocean/contracts";
import { CoceanDatabase } from "@cocean/database";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "./config.js";
import { groupAlbums } from "./albums.js";
import {
  observeDueAutoDiscoveryProbes,
  processNextJob,
  SCAN_RULES_VERSION,
} from "./runner.js";

const scanControl = vi.hoisted(() => ({
  outcomes: new Map<string, unknown>(),
  throwAfter: null as number | null,
}));

vi.mock("@cocean/media-scanner", async () => {
  const actual = await vi.importActual<object>("@cocean/media-scanner");
  return {
    ...actual,
    scanMediaFiles: async function* (paths: Iterable<string>) {
      let index = 0;
      for (const path of paths) {
        if (scanControl.throwAfter === index)
          throw new Error("synthetic scanner crash");
        const outcome = scanControl.outcomes.get(path);
        if (!outcome) throw new Error(`missing synthetic outcome for ${path}`);
        yield outcome;
        index += 1;
      }
    },
  };
});

vi.mock("./artwork-cache.js", () => ({
  cacheArtworkCandidates: async (file: ObservedMediaFile) => ({
    artwork: {
      source: "NONE" as const,
      url: null,
      mimeType: null,
      width: null,
      height: null,
    },
    candidates: file.artwork,
    failed: 0,
  }),
}));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  scanControl.outcomes.clear();
  scanControl.throwAfter = null;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("scan job runner evidence and snapshot safety", () => {
  it("keeps T0 scheduling compatible with the existing v5 media evidence", () => {
    expect(SCAN_RULES_VERSION).toBe("cocean-library-scan/5");
  });

  it("closes candidate counts across parsed, unsupported and skipped boundaries", async () => {
    const root = await temporaryMusicRoot("cocean-runner-report-");
    const albumDirectory = join(root, "Artist", "Album");
    await mkdir(albumDirectory, { recursive: true });
    const trackPath = join(albumDirectory, "01 Track.flac");
    await Promise.all([
      writeFile(trackPath, "audio"),
      writeFile(join(albumDirectory, "SACD.iso"), "disc"),
      writeFile(join(albumDirectory, "album.cue"), "cue"),
      writeFile(join(albumDirectory, "cover.jpg"), "cover"),
    ]);
    await symlink("01 Track.flac", join(albumDirectory, "linked.flac"));
    scanControl.outcomes.set(trackPath, {
      ok: true,
      value: observed(root, "Artist/Album/01 Track.flac", "Track", 512),
    });
    const database = new CoceanDatabase(":memory:", { musicRoot: root });
    queueScan(database, "scan-balanced");

    await processNextJob(database, config(root), pino({ level: "silent" }));

    const report = database.getScanReport("scan-balanced");
    expect(report).toEqual(
      expect.objectContaining({
        status: "COMPLETED_WITH_WARNINGS",
        rulesVersion: SCAN_RULES_VERSION,
        candidates: 2,
        processed: 2,
        parsed: 1,
        unsupported: 1,
        failed: 0,
        unprocessed: 0,
        regularFiles: 4,
        auxiliaryFiles: 2,
        skippedSymlinks: 1,
        albumCount: 1,
        invariants: expect.objectContaining({ valid: true }),
      }),
    );
    expect(database.countScanFileResults("scan-balanced")).toBe(3);
    expect(database.listAlbums({ filter: "DIGITAL" })).toHaveLength(1);
    database.close();
  });

  it("stores warning codes once while retaining field-level warning evidence", async () => {
    const root = await temporaryMusicRoot("cocean-runner-warning-set-");
    const albumDirectory = join(root, "Artist", "Album");
    await mkdir(albumDirectory, { recursive: true });
    const trackPath = join(albumDirectory, "01 Track.flac");
    await writeFile(trackPath, "audio");
    const file = observed(root, "Artist/Album/01 Track.flac", "Track", 512);
    scanControl.outcomes.set(trackPath, {
      ok: true,
      value: {
        ...file,
        warnings: [
          {
            code: "TECHNICAL_METADATA_CONFLICT",
            message: "sampleRate conflict",
          },
          {
            code: "TECHNICAL_METADATA_CONFLICT",
            message: "bitDepth conflict",
          },
        ],
      },
    });
    const database = new CoceanDatabase(":memory:", { musicRoot: root });
    queueScan(database, "scan-warning-set");

    await processNextJob(database, config(root), pino({ level: "silent" }));

    expect(database.listScanFileResults("scan-warning-set")).toEqual([
      expect.objectContaining({
        warningCodes: ["TECHNICAL_METADATA_CONFLICT"],
      }),
    ]);
    expect(
      database.listMediaFilesForRoot("music")[0]?.file.warnings,
    ).toHaveLength(2);
    const [album] = database.listAlbums({ filter: "DIGITAL" });
    expect(database.getAlbum(album!.id)?.tracks[0]?.warningCodes).toEqual([
      "TECHNICAL_METADATA_CONFLICT",
    ]);
    database.close();
  });

  it("keeps last-good media and Album links when a discovered file fails transiently", async () => {
    const root = await temporaryMusicRoot("cocean-runner-last-good-");
    const relativePath = "Artist/Album/01 Last Good.flac";
    const absolutePath = join(root, relativePath);
    await mkdir(join(root, "Artist", "Album"), { recursive: true });
    await writeFile(absolutePath, "audio");
    const database = new CoceanDatabase(":memory:", { musicRoot: root });
    database.createScanJob(scanJob("seed", "RUNNING"));
    const lastGood = observed(root, relativePath, "Last Good", 100);
    database.upsertMediaFile("last-good-file", "music", "seed", lastGood);
    database.replaceAlbumsForRoot("music", [
      {
        id: "seed-album",
        rootId: "music",
        groupKey: "seed-album",
        title: "Album",
        albumArtist: "Artist",
        year: 2020,
        discCount: 1,
        fileIds: ["last-good-file"],
        audioSummary: lastGood.audio,
        mixedAudioSpecs: false,
        artwork: emptyArtwork(),
        matchStatus: "NEEDS_REVIEW",
      },
    ]);
    database.finishScanJob("seed");
    queueScan(database, "scan-transient-failure");
    scanControl.outcomes.set(absolutePath, {
      ok: false,
      filePath: absolutePath,
      error: {
        name: "MediaScanError",
        code: "FFPROBE_FAILED",
        stage: "probe",
        filePath: absolutePath,
        message: `ffprobe failed for ${absolutePath}`,
        recoverable: true,
        details: {},
      },
    });

    await processNextJob(database, config(root), pino({ level: "silent" }));

    expect(database.getScanReport("scan-transient-failure")).toEqual(
      expect.objectContaining({
        status: "COMPLETED_WITH_WARNINGS",
        parsed: 0,
        failed: 1,
        albumCount: 1,
      }),
    );
    expect(database.listMediaFilesForRoot("music")).toEqual([
      expect.objectContaining({
        id: "last-good-file",
        file: expect.objectContaining({
          relativePath,
          tags: expect.objectContaining({ title: "Last Good" }),
        }),
      }),
    ]);
    const [album] = database.listAlbums({ filter: "DIGITAL" });
    expect(album?.trackCount).toBe(1);
    expect(database.getAlbum(album!.id)?.tracks).toHaveLength(1);
    const [failure] = database.listScanFailures("scan-transient-failure");
    expect(failure?.message).not.toContain(root);
    database.close();
  });

  it("does not commit staged media when the scan task aborts mid-stream", async () => {
    const root = await temporaryMusicRoot("cocean-runner-abort-");
    await mkdir(join(root, "Artist", "Album"), { recursive: true });
    const firstPath = join(root, "Artist", "Album", "01 First.flac");
    const secondPath = join(root, "Artist", "Album", "02 Second.flac");
    await Promise.all([
      writeFile(firstPath, "first"),
      writeFile(secondPath, "second"),
    ]);
    scanControl.outcomes.set(firstPath, {
      ok: true,
      value: observed(root, "Artist/Album/01 First.flac", "First", 100),
    });
    scanControl.outcomes.set(secondPath, {
      ok: true,
      value: observed(root, "Artist/Album/02 Second.flac", "Second", 200),
    });
    scanControl.throwAfter = 1;
    const database = new CoceanDatabase(":memory:", { musicRoot: root });
    queueScan(database, "scan-aborted");

    await processNextJob(database, config(root), pino({ level: "silent" }));

    expect(database.getScanReport("scan-aborted")).toEqual(
      expect.objectContaining({
        status: "FAILED",
        candidates: 2,
        processed: 0,
        parsed: 0,
        unprocessed: 2,
        albumCount: null,
      }),
    );
    expect(database.listMediaFilesForRoot("music")).toEqual([]);
    expect(database.listAlbums({ filter: "DIGITAL" })).toEqual([]);
    database.close();
  });

  it("preserves Track and Album identity across a unique checksum rename", async () => {
    const root = await temporaryMusicRoot("cocean-runner-rename-");
    const oldRelativePath = "Artist/Old Folder/01 Track.flac";
    const newRelativePath = "Artist/Renamed Folder/01 Track.flac";
    const newAbsolutePath = join(root, newRelativePath);
    await mkdir(join(root, "Artist", "Renamed Folder"), { recursive: true });
    await writeFile(newAbsolutePath, "same-audio-content");

    const database = new CoceanDatabase(":memory:", { musicRoot: root });
    database.createScanJob(scanJob("seed-rename", "RUNNING"));
    const checksum = "a".repeat(64);
    const oldObservation = observed(
      root,
      oldRelativePath,
      "Track",
      18,
      checksum,
    );
    database.upsertMediaFile(
      "stable-track-id",
      "music",
      "seed-rename",
      oldObservation,
    );
    database.replaceAlbumsForRoot("music", [
      {
        id: "stable-album-id",
        rootId: "music",
        groupKey: "old-group-key",
        title: "Album",
        albumArtist: "Artist",
        year: 2020,
        discCount: 1,
        fileIds: ["stable-track-id"],
        audioSummary: oldObservation.audio,
        mixedAudioSpecs: false,
        artwork: emptyArtwork(),
        matchStatus: "NEEDS_REVIEW",
      },
    ]);
    database.createPhysicalCopy({
      id: "owned-cd",
      albumId: "stable-album-id",
      medium: "CD",
      label: null,
      catalogNumber: null,
      barcode: null,
      country: null,
      releaseYear: 2020,
      quantity: 1,
      conditionNote: null,
      storageLocation: null,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    });
    database.finishScanJob("seed-rename");

    queueScan(database, "scan-rename");
    scanControl.outcomes.set(newAbsolutePath, {
      ok: true,
      value: observed(root, newRelativePath, "Track", 18, checksum),
    });

    await processNextJob(database, config(root), pino({ level: "silent" }));

    expect(database.listMediaFilesForRoot("music")).toEqual([
      expect.objectContaining({
        id: "stable-track-id",
        file: expect.objectContaining({ relativePath: newRelativePath }),
      }),
    ]);
    expect(database.listAlbums({ filter: "DIGITAL" })).toEqual([
      expect.objectContaining({
        primaryVersionId: "stable-album-id",
        physicalMedia: ["CD"],
        trackCount: 1,
      }),
    ]);
    expect(database.getAlbum("stable-album-id")?.tracks[0]).toEqual(
      expect.objectContaining({
        id: "stable-track-id",
        relativePath: newRelativePath,
      }),
    );
    expect(database.listScanFileResults("scan-rename")).toEqual([
      expect.objectContaining({
        outcome: "PARSED",
        mediaFileId: "stable-track-id",
        relativePath: newRelativePath,
      }),
    ]);
    database.close();
  });

  it("reserves an exact Album group identity before considering file overlap", async () => {
    const root = await temporaryMusicRoot("cocean-runner-group-identity-");
    const currentRelativePath = "Artist/Album/01 Track.flac";
    const currentAbsolutePath = join(root, currentRelativePath);
    await mkdir(join(root, "Artist", "Album"), { recursive: true });
    await writeFile(currentAbsolutePath, "current-audio");

    const database = new CoceanDatabase(":memory:", { musicRoot: root });
    database.createScanJob(scanJob("seed-group-identity", "RUNNING"));
    const legacy = observed(
      root,
      "Artist/Legacy/01 Legacy.flac",
      "Legacy",
      12,
      "a".repeat(64),
    );
    const current = observed(
      root,
      currentRelativePath,
      "Track",
      13,
      "b".repeat(64),
    );
    database.upsertMediaFile(
      "legacy-file",
      "music",
      "seed-group-identity",
      legacy,
    );
    database.upsertMediaFile(
      "current-file",
      "music",
      "seed-group-identity",
      current,
    );
    database.replaceAlbumsForRoot("music", [
      {
        id: "exact-group-owner",
        rootId: "music",
        groupKey: "artist/album\u0000album",
        title: "Album",
        albumArtist: "Artist",
        year: 2020,
        discCount: 1,
        fileIds: ["legacy-file"],
        audioSummary: legacy.audio,
        mixedAudioSpecs: false,
        artwork: emptyArtwork(),
        matchStatus: "NEEDS_REVIEW",
      },
      {
        id: "overlap-owner",
        rootId: "music",
        groupKey: "historical-overlap",
        title: "Album",
        albumArtist: "Artist",
        year: 2020,
        discCount: 1,
        fileIds: ["current-file"],
        audioSummary: current.audio,
        mixedAudioSpecs: false,
        artwork: emptyArtwork(),
        matchStatus: "NEEDS_REVIEW",
      },
    ]);
    database.finishScanJob("seed-group-identity");
    queueScan(database, "scan-group-identity");
    scanControl.outcomes.set(currentAbsolutePath, {
      ok: true,
      value: current,
    });

    await processNextJob(database, config(root), pino({ level: "silent" }));

    expect(database.getScanReport("scan-group-identity")).toEqual(
      expect.objectContaining({
        status: "COMPLETED",
        albumCount: 1,
      }),
    );
    expect(database.listAlbums({ filter: "DIGITAL" })).toEqual([
      expect.objectContaining({
        primaryVersionId: "exact-group-owner",
        trackCount: 1,
      }),
    ]);
    expect(database.getAlbum("exact-group-owner")?.tracks).toEqual([
      expect.objectContaining({ id: "current-file" }),
    ]);
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM albums WHERE id=?")
        .get("overlap-owner"),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("resolves crossed historical Album IDs as one global assignment", async () => {
    const root = await temporaryMusicRoot("cocean-runner-crossed-identity-");
    const aRelativePath = "Artist/Album A/01 A.flac";
    const bRelativePath = "Artist/Album B/01 B.flac";
    const aAbsolutePath = join(root, aRelativePath);
    const bAbsolutePath = join(root, bRelativePath);
    await Promise.all([
      mkdir(join(root, "Artist", "Album A"), { recursive: true }),
      mkdir(join(root, "Artist", "Album B"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(aAbsolutePath, "album-a"),
      writeFile(bAbsolutePath, "album-b"),
    ]);
    const albumAFile = {
      ...observed(root, aRelativePath, "A", 7, "a".repeat(64)),
      tags: {
        ...observed(root, aRelativePath, "A", 7).tags,
        album: "Album A",
      },
    };
    const albumBFile = {
      ...observed(root, bRelativePath, "B", 7, "b".repeat(64)),
      tags: {
        ...observed(root, bRelativePath, "B", 7).tags,
        album: "Album B",
      },
    };
    const grouped = groupAlbums("music", [
      { id: "file-a", file: albumAFile, artwork: emptyArtwork() },
      { id: "file-b", file: albumBFile, artwork: emptyArtwork() },
    ]);
    const generatedA = grouped.find((album) => album.title === "Album A")!;
    const generatedB = grouped.find((album) => album.title === "Album B")!;

    const database = new CoceanDatabase(":memory:", { musicRoot: root });
    database.createScanJob(scanJob("seed-crossed-identity", "RUNNING"));
    database.upsertMediaFile(
      "file-a",
      "music",
      "seed-crossed-identity",
      albumAFile,
    );
    database.upsertMediaFile(
      "file-b",
      "music",
      "seed-crossed-identity",
      albumBFile,
    );
    database.replaceAlbumsForRoot("music", [
      {
        ...generatedA,
        id: "historical-album-a",
        fileIds: ["file-a"],
        primaryFileIds: ["file-a"],
      },
      {
        ...generatedB,
        id: generatedA.id,
        fileIds: ["file-b"],
        primaryFileIds: ["file-b"],
      },
    ]);
    database.finishScanJob("seed-crossed-identity");
    queueScan(database, "scan-crossed-identity");
    scanControl.outcomes.set(aAbsolutePath, { ok: true, value: albumAFile });
    scanControl.outcomes.set(bAbsolutePath, { ok: true, value: albumBFile });

    await processNextJob(database, config(root), pino({ level: "silent" }));

    expect(database.getScanReport("scan-crossed-identity")).toEqual(
      expect.objectContaining({ status: "COMPLETED", albumCount: 2 }),
    );
    expect(database.listAlbums({ filter: "DIGITAL" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          primaryVersionId: "historical-album-a",
          title: "Album A",
        }),
        expect.objectContaining({
          primaryVersionId: generatedA.id,
          title: "Album B",
        }),
      ]),
    );
    expect(database.getAlbum(generatedB.id)).toBeNull();
    database.close();
  });

  it("prefers unique file overlap over an unrelated generated historical ID", async () => {
    const root = await temporaryMusicRoot("cocean-runner-overlap-priority-");
    const aRelativePath = "Artist/Album A/01 A.flac";
    const bRelativePath = "Artist/Album B/01 B.flac";
    const aAbsolutePath = join(root, aRelativePath);
    const bAbsolutePath = join(root, bRelativePath);
    await Promise.all([
      mkdir(join(root, "Artist", "Album A"), { recursive: true }),
      mkdir(join(root, "Artist", "Album B"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(aAbsolutePath, "album-a"),
      writeFile(bAbsolutePath, "album-b"),
    ]);
    const albumAFile = withAlbum(
      observed(root, aRelativePath, "A", 7, "a".repeat(64)),
      "Album A",
    );
    const albumBFile = withAlbum(
      observed(root, bRelativePath, "B", 7, "b".repeat(64)),
      "Album B",
    );
    const grouped = groupAlbums("music", [
      { id: "file-a", file: albumAFile, artwork: emptyArtwork() },
      { id: "file-b", file: albumBFile, artwork: emptyArtwork() },
    ]);
    const generatedA = grouped.find((album) => album.title === "Album A")!;
    const generatedB = grouped.find((album) => album.title === "Album B")!;

    const database = new CoceanDatabase(":memory:", { musicRoot: root });
    database.createScanJob(scanJob("seed-overlap-priority", "RUNNING"));
    database.upsertMediaFile(
      "file-a",
      "music",
      "seed-overlap-priority",
      albumAFile,
    );
    database.upsertMediaFile(
      "file-b",
      "music",
      "seed-overlap-priority",
      albumBFile,
    );
    database.replaceAlbumsForRoot("music", [
      {
        ...generatedB,
        id: generatedA.id,
        groupKey: "old-key-x",
        fileIds: ["file-b"],
        primaryFileIds: ["file-b"],
      },
      {
        ...generatedA,
        id: "old-album-y",
        groupKey: "old-key-y",
        fileIds: ["file-a"],
        primaryFileIds: ["file-a"],
      },
    ]);
    database.finishScanJob("seed-overlap-priority");
    queueScan(database, "scan-overlap-priority");
    scanControl.outcomes.set(aAbsolutePath, { ok: true, value: albumAFile });
    scanControl.outcomes.set(bAbsolutePath, { ok: true, value: albumBFile });

    await processNextJob(database, config(root), pino({ level: "silent" }));

    expect(database.getScanReport("scan-overlap-priority")).toEqual(
      expect.objectContaining({ status: "COMPLETED", albumCount: 2 }),
    );
    expect(database.listAlbums({ filter: "DIGITAL" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          primaryVersionId: "old-album-y",
          title: "Album A",
        }),
        expect.objectContaining({
          primaryVersionId: generatedA.id,
          title: "Album B",
        }),
      ]),
    );
    database.close();
  });

  it("avoids an Album ID already owned by another library root", async () => {
    const root = await temporaryMusicRoot("cocean-runner-global-id-");
    const relativePath = "Artist/Album/01 Track.flac";
    const absolutePath = join(root, relativePath);
    await mkdir(join(root, "Artist", "Album"), { recursive: true });
    await writeFile(absolutePath, "audio");
    const file = observed(root, relativePath, "Track", 5, "a".repeat(64));
    const [generated] = groupAlbums("music", [
      { id: "file", file, artwork: emptyArtwork() },
    ]);

    const database = new CoceanDatabase(":memory:", { musicRoot: root });
    database.replaceAlbumsForRoot("physical", [
      {
        ...generated!,
        id: generated!.id,
        rootId: "physical",
        groupKey: "physical-collision",
        fileIds: [],
        primaryFileIds: [],
      },
    ]);
    queueScan(database, "scan-global-id");
    scanControl.outcomes.set(absolutePath, { ok: true, value: file });

    await processNextJob(database, config(root), pino({ level: "silent" }));

    expect(database.getScanReport("scan-global-id")).toEqual(
      expect.objectContaining({ status: "COMPLETED", albumCount: 1 }),
    );
    const [digital] = database.listAlbums({ filter: "DIGITAL" });
    expect(digital?.id).not.toBe(generated!.id);
    expect(database.listAlbumIds()).toEqual(
      expect.arrayContaining([generated!.id, digital!.primaryVersionId]),
    );
    database.close();
  });

  it("reuses unchanged files only after a compatible completed snapshot", async () => {
    const root = await temporaryMusicRoot("cocean-runner-incremental-");
    const relativePath = "Artist/Album/01 Track.flac";
    const absolutePath = join(root, relativePath);
    await mkdir(join(root, "Artist", "Album"), { recursive: true });
    await writeFile(absolutePath, "audio");
    const information = await stat(absolutePath);
    const observation = {
      ...observed(root, relativePath, "Track", information.size),
      modifiedAtMs: information.mtimeMs,
    };
    scanControl.outcomes.set(absolutePath, { ok: true, value: observation });
    const database = new CoceanDatabase(":memory:", { musicRoot: root });
    queueScan(database, "scan-full");
    await processNextJob(database, config(root), pino({ level: "silent" }));
    expect(database.getScanReport("scan-full")?.rulesVersion).toBe(
      SCAN_RULES_VERSION,
    );

    scanControl.outcomes.clear();
    database.createScanJob(
      scanJob("scan-incremental", "QUEUED", "INCREMENTAL"),
    );
    await processNextJob(database, config(root), pino({ level: "silent" }));

    expect(database.getScanJob("scan-incremental")).toEqual(
      expect.objectContaining({
        status: "COMPLETED",
        parsedFiles: 1,
        reusedFiles: 1,
      }),
    );
    expect(database.listScanFileResults("scan-incremental")).toEqual([
      expect.objectContaining({ outcome: "PARSED", warningCodes: [] }),
    ]);
    database.close();
  });

  it("does not expose a changing automatic-discovery Album until its directory is stable", async () => {
    const root = await temporaryMusicRoot("cocean-runner-auto-stability-");
    const albumDirectory = join(root, "Artist", "Copying Album");
    await mkdir(join(albumDirectory, "Disc 1"), { recursive: true });
    await mkdir(join(albumDirectory, "Disc 2"), { recursive: true });
    const trackPath = join(albumDirectory, "Disc 1", "01 Track.flac");
    const secondTrackPath = join(
      albumDirectory,
      "Disc 2",
      "01 Second Track.flac",
    );
    await writeFile(trackPath, "partial");
    await writeFile(secondTrackPath, "complete second disc");
    scanControl.outcomes.set(trackPath, {
      ok: true,
      value: observed(
        root,
        "Artist/Copying Album/Disc 1/01 Track.flac",
        "Track",
        512,
      ),
    });
    scanControl.outcomes.set(secondTrackPath, {
      ok: true,
      value: observed(
        root,
        "Artist/Copying Album/Disc 2/01 Second Track.flac",
        "Second Track",
        512,
      ),
    });
    const database = new CoceanDatabase(":memory:", { musicRoot: root });
    queueAutoScan(database, "auto-first");

    await processNextJob(database, config(root), pino({ level: "silent" }));

    expect(database.listAlbums({ filter: "DIGITAL" })).toEqual([]);
    expect(database.getScanJob("auto-first")).toEqual(
      expect.objectContaining({
        stableAlbumDirectories: 0,
        deferredAlbumDirectories: 1,
        processedFiles: 0,
      }),
    );

    await writeFile(trackPath, "still copying");
    queueAutoScan(database, "auto-changing");
    await processNextJob(database, config(root), pino({ level: "silent" }));
    expect(database.listAlbums({ filter: "DIGITAL" })).toEqual([]);
    expect(database.getScanJob("auto-changing")).toEqual(
      expect.objectContaining({ deferredAlbumDirectories: 1 }),
    );

    database.raw
      .prepare(
        `UPDATE album_stability_observations
         SET first_observed_at=? WHERE root_id='music'`,
      )
      .run(new Date(Date.now() - 61_000).toISOString());
    queueAutoScan(database, "auto-stable");
    await processNextJob(database, config(root), pino({ level: "silent" }));

    expect(database.getScanJob("auto-stable")).toEqual(
      expect.objectContaining({
        stableAlbumDirectories: 1,
        deferredAlbumDirectories: 0,
        parsedFiles: 2,
      }),
    );
    expect(database.listAlbums({ filter: "DIGITAL" })).toHaveLength(1);
    database.close();
  });

  it("keeps the stability window for a retry of failed automatic discovery", async () => {
    const root = await temporaryMusicRoot("cocean-runner-auto-retry-");
    const trackPath = join(root, "Artist", "Copying Album", "01 Track.flac");
    await mkdir(join(root, "Artist", "Copying Album"), { recursive: true });
    await writeFile(trackPath, "still copying");
    scanControl.outcomes.set(trackPath, {
      ok: true,
      value: observed(root, "Artist/Copying Album/01 Track.flac", "Track", 512),
    });
    const database = new CoceanDatabase(":memory:", { musicRoot: root });
    queueAutoScan(database, "auto-origin");
    database.claimNextScanJob();
    database.finishScanJob("auto-origin", "NAS unavailable");
    database.createScanJob({
      ...scanJob("auto-retry", "QUEUED", "INCREMENTAL"),
      triggerSource: "RETRY",
      retryOfScanJobId: "auto-origin",
    });

    await processNextJob(database, config(root), pino({ level: "silent" }));

    expect(database.getScanJob("auto-retry")).toEqual(
      expect.objectContaining({
        triggerSource: "RETRY",
        deferredAlbumDirectories: 1,
        parsedFiles: 0,
      }),
    );
    expect(database.listAlbums({ filter: "DIGITAL" })).toEqual([]);
    database.close();
  });

  it("makes an Album stable just after a scan visible within the default five-minute bound", async () => {
    const root = await temporaryMusicRoot("cocean-runner-auto-bound-");
    const trackPath = join(root, "Artist", "New Album", "01 Track.flac");
    await mkdir(join(root, "Artist", "New Album"), { recursive: true });
    await writeFile(trackPath, "complete");
    const information = await stat(trackPath);
    scanControl.outcomes.set(trackPath, {
      ok: true,
      value: {
        ...observed(
          root,
          "Artist/New Album/01 Track.flac",
          "Track",
          information.size,
        ),
        modifiedAtMs: information.mtimeMs,
      },
    });
    const database = new CoceanDatabase(":memory:", { musicRoot: root });
    const settings = database.getSettings();
    database.saveSettings({
      ...settings,
      libraryRoots: settings.libraryRoots.map((libraryRoot) => ({
        ...libraryRoot,
        autoDiscoveryEnabled: true,
        autoDiscoveryIntervalMinutes: 5,
      })),
    });
    const stableAt = new Date("2030-01-01T00:00:00.001Z");
    const firstScheduledAt = new Date("2030-01-01T00:00:00.000Z");
    const [emptyFirst] = database.enqueueDueAutoDiscoveryJobs(firstScheduledAt);
    database.requestScanCancellation(emptyFirst!.id);

    // The durable pre-observation starts two minutes before the planned scan,
    // leaving a full minute of traversal/polling budget before the required
    // sixty-second stability window begins.
    const probeAt = new Date("2030-01-01T00:03:00.000Z");
    expect(
      await observeDueAutoDiscoveryProbes(
        database,
        config(root),
        pino({ level: "silent" }),
        undefined,
        probeAt,
        () => probeAt,
      ),
    ).toBe(1);
    expect(database.listAlbums({ filter: "DIGITAL" })).toEqual([]);

    const visibleAt = new Date("2030-01-01T00:05:00.000Z");
    await processNextJob(
      database,
      config(root),
      pino({ level: "silent" }),
      undefined,
      visibleAt,
      () => visibleAt,
    );

    expect(database.listAlbums({ filter: "DIGITAL" })).toHaveLength(1);
    expect(visibleAt.getTime() - stableAt.getTime()).toBeLessThanOrEqual(
      5 * 60_000,
    );
    database.close();
  });

  it("records a failed pre-observation once and uses traversal completion time", async () => {
    const root = await temporaryMusicRoot("cocean-runner-probe-clock-");
    const trackPath = join(root, "Artist", "Album", "01 Track.flac");
    await mkdir(join(root, "Artist", "Album"), { recursive: true });
    await writeFile(trackPath, "complete");
    const database = new CoceanDatabase(":memory:", { musicRoot: root });
    const settings = database.getSettings();
    database.saveSettings({
      ...settings,
      libraryRoots: settings.libraryRoots.map((libraryRoot) => ({
        ...libraryRoot,
        autoDiscoveryEnabled: true,
        autoDiscoveryIntervalMinutes: 5,
      })),
    });
    const scheduled = new Date("2030-01-01T00:00:00.000Z");
    const [first] = database.enqueueDueAutoDiscoveryJobs(scheduled);
    database.requestScanCancellation(first!.id);
    const probeStartedAt = new Date("2030-01-01T00:03:00.000Z");
    const traversalFinishedAt = new Date("2030-01-01T00:03:45.000Z");
    expect(
      await observeDueAutoDiscoveryProbes(
        database,
        config(root),
        pino({ level: "silent" }),
        undefined,
        probeStartedAt,
        () => traversalFinishedAt,
      ),
    ).toBe(1);
    expect(
      database.raw
        .prepare(
          "SELECT first_observed_at FROM album_stability_observations WHERE root_id='music'",
        )
        .get(),
    ).toEqual({ first_observed_at: traversalFinishedAt.toISOString() });

    const missingRoot = database.getLibraryRoot("music")!;
    database.raw
      .prepare("UPDATE library_roots SET container_path=? WHERE id='music'")
      .run(join(root, "unreachable"));
    database.raw
      .prepare(
        "UPDATE library_roots SET auto_discovery_probe_for_scan_at=NULL WHERE id='music'",
      )
      .run();
    expect(
      await observeDueAutoDiscoveryProbes(
        database,
        { ...config(root), musicRoot: missingRoot.containerPath },
        pino({ level: "silent" }),
        undefined,
        probeStartedAt,
        () => traversalFinishedAt,
      ),
    ).toBe(0);
    expect(database.listDueAutoDiscoveryProbes(probeStartedAt)).toEqual([]);
    database.close();
  });

  it("does not repeatedly reread unchanged files whose stored tags need repair", async () => {
    const root = await temporaryMusicRoot("cocean-runner-tag-repair-");
    const relativePath = "Artist/Album/01 Track.wav";
    const absolutePath = join(root, relativePath);
    await mkdir(join(root, "Artist", "Album"), { recursive: true });
    await writeFile(absolutePath, "audio");
    const information = await stat(absolutePath);
    const broken = {
      ...observed(root, relativePath, "Track", information.size),
      modifiedAtMs: information.mtimeMs,
      tags: {
        ...observed(root, relativePath, "Track", information.size).tags,
        albumArtist: "??? (??? ????)",
        artists: ["??? (??? ????)"],
      },
    };
    scanControl.outcomes.set(absolutePath, { ok: true, value: broken });
    const database = new CoceanDatabase(":memory:", { musicRoot: root });
    queueScan(database, "scan-broken-tags");
    await processNextJob(database, config(root), pino({ level: "silent" }));

    scanControl.outcomes.clear();
    database.createScanJob(
      scanJob("scan-repair-tags", "QUEUED", "INCREMENTAL"),
    );
    await processNextJob(database, config(root), pino({ level: "silent" }));

    expect(database.getScanJob("scan-repair-tags")).toEqual(
      expect.objectContaining({ parsedFiles: 1, reusedFiles: 1 }),
    );
    expect(database.listAlbums({ filter: "DIGITAL" })).toEqual([
      expect.objectContaining({ albumArtist: "??? (??? ????)" }),
    ]);
    database.close();
  });
});

async function temporaryMusicRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

function queueScan(database: CoceanDatabase, id: string): void {
  database.createScanJob(scanJob(id, "QUEUED"));
}

function queueAutoScan(database: CoceanDatabase, id: string): void {
  database.createScanJob({
    ...scanJob(id, "QUEUED", "INCREMENTAL"),
    triggerSource: "AUTO_DISCOVERY",
    retryOfScanJobId: null,
    stableAlbumDirectories: 0,
    deferredAlbumDirectories: 0,
  });
}

function scanJob(
  id: string,
  status: "QUEUED" | "RUNNING",
  mode: "FULL" | "INCREMENTAL" = "FULL",
) {
  return {
    id,
    rootId: "music",
    mode,
    status,
    totalFiles: 0,
    processedFiles: 0,
    parsedFiles: 0,
    failedFiles: 0,
    reusedFiles: 0,
    createdAt: "2026-08-12T00:00:00.000Z",
    startedAt: status === "RUNNING" ? "2026-08-12T00:00:00.000Z" : null,
    finishedAt: null,
    error: null,
    cancelRequestedAt: null,
  } as const;
}

function config(root: string): WorkerConfig {
  return {
    databasePath: ":memory:",
    cacheRoot: join(root, ".cache"),
    musicRoot: root,
    musicRootPolicy: "WATCH_ONLY",
    quarantineRoot: join(root, ".quarantine"),
    pollMs: 1500,
    ffprobePath: "ffprobe",
    ffprobeTimeoutMs: 30_000,
    excludeDirectories: [],
    logLevel: "silent",
    once: true,
  };
}

function observed(
  root: string,
  relativePath: string,
  title: string,
  sizeBytes: number,
  fileSha256 = "0".repeat(64),
): ObservedMediaFile {
  return {
    absolutePath: join(root, relativePath),
    relativePath,
    extension: ".flac",
    sizeBytes,
    modifiedAtMs: 1,
    fileSha256,
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
      album: "Album",
      albumArtist: "Artist",
      title,
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
    rawTags: [],
    artwork: [],
    warnings: [],
  };
}

function emptyArtwork() {
  return {
    source: "NONE" as const,
    url: null,
    mimeType: null,
    width: null,
    height: null,
  };
}

function withAlbum(file: ObservedMediaFile, album: string): ObservedMediaFile {
  return { ...file, tags: { ...file.tags, album } };
}
