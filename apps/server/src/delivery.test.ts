import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoceanDatabase } from "@cocean/database";
import { CredentialVault } from "./credential-vault.js";
import {
  DeliveryRunner,
  safeAlbumDirectoryName,
  safeAlbumTargetPath,
} from "./delivery.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("album delivery", () => {
  it("copies an Album only inside the configured USB mount and records verified history", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const deliveryRoot = join(root, "delivery");
    const sourceRelative = "Artist/Album/01 Track.flac";
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await mkdir(deliveryRoot, { recursive: true });
    await writeFile(join(musicRoot, sourceRelative), "lossless-audio-bytes");

    const database = new CoceanDatabase(":memory:", { musicRoot });
    database.createScanJob({
      id: "scan-delivery",
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
    const observed = {
      absolutePath: join(musicRoot, sourceRelative),
      relativePath: sourceRelative,
      extension: ".flac",
      sizeBytes: 20,
      modifiedAtMs: 1,
      fileSha256: "0".repeat(64),
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
    };
    database.upsertMediaFile(
      "track-delivery",
      "music",
      "scan-delivery",
      observed,
    );
    database.replaceAlbumsForRoot("music", [
      {
        id: "album-delivery",
        rootId: "music",
        groupKey: "artist\0album",
        title: "Album",
        albumArtist: "Artist",
        year: 2026,
        discCount: 1,
        fileIds: ["track-delivery"],
        audioSummary: observed.audio,
        mixedAudioSpecs: false,
        artwork: {
          source: "NONE",
          url: null,
          mimeType: null,
          width: null,
          height: null,
        },
        matchStatus: "NEEDS_REVIEW",
      },
    ]);
    database.finishScanJob("scan-delivery");
    const now = "2026-08-12T00:00:00.000Z";
    database.createDeliveryTarget({
      id: "target-usb",
      deviceId: null,
      name: "USB",
      kind: "MOUNTED_VOLUME",
      transport: "USB_MOUNT",
      location: join(deliveryRoot, "SP3000M"),
      username: null,
      credentialConfigured: false,
      enabled: true,
      verifiedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    database.createDeliveryJob({
      id: "delivery-job",
      albumId: "album-delivery",
      targetId: "target-usb",
      targetName: "USB",
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
    });
    const vault = await CredentialVault.load(join(root, "credential.key"));
    const recovery = vi.spyOn(database, "recoverInterruptedDeliveries");
    const runner = new DeliveryRunner(database, vault, deliveryRoot);
    runner.start();
    runner.start();
    expect(recovery).toHaveBeenCalledTimes(1);

    await waitFor(() =>
      database
        .listAlbumDeliveryJobs("album-delivery")
        .some((job) => ["COMPLETED", "FAILED"].includes(job.status)),
    );
    const [job] = database.listAlbumDeliveryJobs("album-delivery");
    expect(job).toEqual(
      expect.objectContaining({
        status: "COMPLETED",
        fileCount: 1,
        totalBytes: 20,
        transferredBytes: 20,
        verified: true,
      }),
    );
    const targetDirectory = join(deliveryRoot, "SP3000M", albumDirectory());
    const [copied] = await readdir(targetDirectory);
    expect(copied).toBe("001 01 Track.flac");
    expect(await readFile(join(targetDirectory, copied!), "utf8")).toBe(
      "lossless-audio-bytes",
    );
    expect(database.listDeliveryTargets()[0]?.verifiedAt).not.toBeNull();
    database.close();
  });

  it("delivers eight tracks and a compatible cover into the AK File Drop Album directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-cover-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const deliveryRoot = join(root, "delivery");
    const cacheRoot = join(root, "cache");
    const sourceRelatives = Array.from(
      { length: 8 },
      (_, index) =>
        `Artist/Album/${String(index + 1).padStart(2, "0")} Track ${index + 1}.flac`,
    );
    const artworkHash = "a".repeat(64);
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await mkdir(join(cacheRoot, "artwork"), { recursive: true });
    await mkdir(deliveryRoot, { recursive: true });
    await Promise.all(
      sourceRelatives.map((sourceRelative) =>
        writeFile(join(musicRoot, sourceRelative), "lossless-audio-bytes"),
      ),
    );
    await writeFile(join(cacheRoot, "artwork", `${artworkHash}.jpg`), "jpeg");

    const database = deliveryDatabase(
      musicRoot,
      sourceRelatives,
      `/api/v1/artwork/${artworkHash}`,
    );
    const vault = await CredentialVault.load(join(root, "credential.key"));
    database.createDeliveryTarget(
      {
        id: "target-cover",
        deviceId: null,
        name: "SP3000M",
        kind: "NETWORK",
        transport: "AK_FILE_DROP",
        location: "ftp://sp3000m.local/",
        username: "AK",
        credentialConfigured: true,
        enabled: true,
        verifiedAt: null,
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
      },
      vault.encrypt(JSON.stringify({ password: "test-password" })),
    );
    const fakeFfmpeg = join(root, "fake-ffmpeg.sh");
    await writeFile(
      fakeFfmpeg,
      '#!/bin/sh\neval "out=\\${$#}"\ncp "$5" "$out"\n',
      { mode: 0o755 },
    );
    const remoteFiles = new Map<string, Buffer>();
    const ftpClient = fakeFtpClient(remoteFiles);
    const runner = new DeliveryRunner(
      database,
      vault,
      deliveryRoot,
      cacheRoot,
      fakeFfmpeg,
      "ffprobe",
      () => ftpClient,
    );
    const bundle = await runner.prepareAlbumDelivery(
      "album-delivery",
      "AK_FILE_DROP",
    );
    expect(bundle.deliveryProfileVersion).toBe("organized-v2");
    expect(bundle.files.every((file) => file.conversionType === "COPY")).toBe(
      true,
    );
    database.createDeliveryJob(
      {
        id: "delivery-cover",
        albumId: "album-delivery",
        targetId: "target-cover",
        targetName: "SP3000M",
        transport: "AK_FILE_DROP",
        status: "QUEUED",
        fileCount:
          bundle.files.length + Number(Boolean(bundle.preparedArtwork)),
        completedFileCount: 0,
        totalBytes:
          bundle.files.reduce((total, file) => total + file.sizeBytes, 0) +
          (bundle.preparedArtwork?.sizeBytes ?? 0),
        transferredBytes: 0,
        verified: false,
        error: null,
        createdAt: "2026-08-12T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
      },
      bundle,
    );
    expect(database.getDeliveryJob("delivery-cover")).toEqual(
      expect.objectContaining({
        fileCount: 9,
        completedFileCount: 0,
        totalBytes: 8 * 20 + 4,
      }),
    );
    runner.start();

    await waitFor(() =>
      database
        .listAlbumDeliveryJobs("album-delivery")
        .some((job) => ["COMPLETED", "FAILED"].includes(job.status)),
    );
    const [job] = database.listAlbumDeliveryJobs("album-delivery");
    expect(job).toEqual(
      expect.objectContaining({
        status: "COMPLETED",
        fileCount: 9,
        completedFileCount: 9,
        verified: true,
      }),
    );
    const albumDirectoryPath = `/Music/${bundle.targetAlbumPath}`;
    const delivered = [...remoteFiles.keys()]
      .filter((path) => path.startsWith(`${albumDirectoryPath}/`))
      .map((path) => path.slice(albumDirectoryPath.length + 1))
      .sort();
    expect(delivered).toHaveLength(9);
    expect(delivered).toContain("cover.jpg");
    expect(delivered.filter((name) => name.endsWith(".flac"))).toHaveLength(8);
    expect(remoteFiles.get(`${albumDirectoryPath}/cover.jpg`)?.toString()).toBe(
      "jpeg",
    );
    expect(ftpClient.accessOptions).toEqual({
      host: "sp3000m.local",
      port: 21,
      user: "AK",
      password: "test-password",
      secure: false,
    });
    expect(ftpClient.uploadProgressObserved).toEqual(Array(9).fill(true));
    expect(ftpClient.progressRegistrations).toBe(10);
    database.close();
  });

  it("normalizes a missing-tag APE into a lossless FLAC copy without inventing a track tag", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-ape-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const cacheRoot = join(root, "cache");
    const sourceRelative = "Artist/Album/路小雨.ape";
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await writeFile(join(musicRoot, sourceRelative), "lossless-audio-bytes");
    const database = deliveryDatabase(musicRoot, sourceRelative, null);
    database.raw
      .prepare(
        `UPDATE media_files
         SET extension='.ape', container='ape', codec='ape', album=NULL,
             album_artist=NULL, title='路小雨', track_number=NULL,
             track_total=NULL
         WHERE id='track-delivery-1'`,
      )
      .run();
    const ffmpegLog = join(root, "ffmpeg.log");
    const fakeFfmpeg = await createFakeFfmpeg(root, ffmpegLog);
    const fakeFfprobe = await createFakeFfprobe(root, {
      title: "路小雨",
      track: null,
    });
    const vault = await CredentialVault.load(join(root, "credential.key"));
    const runner = new DeliveryRunner(
      database,
      vault,
      join(root, "delivery"),
      cacheRoot,
      fakeFfmpeg,
      fakeFfprobe,
    );

    const bundle = await runner.prepareAlbumDelivery(
      "album-delivery",
      "AK_FILE_DROP",
    );
    const [file] = bundle.files;
    expect(file).toEqual(
      expect.objectContaining({
        conversionType: "APE_TO_FLAC",
        targetRelativePath: expect.stringMatching(/001 路小雨\.flac$/),
        outputSizeBytes: 20,
        outputSha256: createHash("sha256")
          .update("lossless-audio-bytes")
          .digest("hex"),
      }),
    );
    const argumentsLine = await readFile(ffmpegLog, "utf8");
    expect(argumentsLine).toContain("-c:a flac");
    expect(argumentsLine).toContain("-metadata album=Album");
    expect(argumentsLine).toContain("-metadata album_artist=Artist");
    expect(argumentsLine).toContain("-metadata title=路小雨");
    expect(argumentsLine).not.toContain("track=");
    expect(await readFile(join(musicRoot, sourceRelative), "utf8")).toBe(
      "lossless-audio-bytes",
    );
    database.close();
  });

  it("remuxes a mismatched FLAC without re-encoding audio", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-flac-remux-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const sourceRelative = "Artist/Album/01 Track.flac";
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await writeFile(join(musicRoot, sourceRelative), "lossless-audio-bytes");
    const database = deliveryDatabase(musicRoot, sourceRelative, null);
    database.raw
      .prepare(
        "UPDATE media_files SET album='Wrong', album_artist='Other' WHERE id='track-delivery-1'",
      )
      .run();
    const ffmpegLog = join(root, "ffmpeg.log");
    const fakeFfmpeg = await createFakeFfmpeg(root, ffmpegLog);
    const fakeFfprobe = await createFakeFfprobe(root);
    const vault = await CredentialVault.load(join(root, "credential.key"));
    const bundle = await new DeliveryRunner(
      database,
      vault,
      join(root, "delivery"),
      join(root, "cache"),
      fakeFfmpeg,
      fakeFfprobe,
    ).prepareAlbumDelivery("album-delivery", "AK_FILE_DROP");

    expect(bundle.files[0]?.conversionType).toBe("FLAC_REMUX");
    expect(await readFile(ffmpegLog, "utf8")).toContain("-c:a copy");
    database.close();
  });

  it("uses real ffmpeg and ffprobe to verify normalized FLAC tags and observed Disc override", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-real-flac-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const relativePath = "Artist/Album/01 Track.flac";
    const source = join(musicRoot, relativePath);
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await execFileAsync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.1",
      "-c:a",
      "flac",
      source,
    ]);
    const bytes = await readFile(source);
    const database = deliveryDatabase(musicRoot, relativePath, null);
    database.raw
      .prepare(
        `UPDATE media_files SET size_bytes=?, file_sha256=?, album='Wrong',
         album_artist='Other', title='Observed Title', artists_json='["Observed Artist"]',
         disc_number=1, disc_total=1, track_number=2, track_total=9
         WHERE id='track-delivery-1'`,
      )
      .run(bytes.byteLength, createHash("sha256").update(bytes).digest("hex"));
    database.raw
      .prepare(
        "UPDATE album_files SET disc_number_override=2 WHERE media_file_id='track-delivery-1'",
      )
      .run();
    const vault = await CredentialVault.load(join(root, "credential.key"));
    const bundle = await new DeliveryRunner(
      database,
      vault,
      join(root, "delivery"),
      join(root, "cache"),
      "ffmpeg",
      "ffprobe",
    ).prepareAlbumDelivery("album-delivery", "AK_FILE_DROP");
    const output = bundle.files[0]!.preparedPath!;
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=format_name:format_tags:stream=codec_name,codec_type",
      "-of",
      "json",
      output,
    ]);
    const probe = JSON.parse(stdout) as {
      format: { format_name: string; tags: Record<string, string> };
      streams: Array<{ codec_type: string; codec_name: string }>;
    };
    const tags = Object.fromEntries(
      Object.entries(probe.format.tags).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    expect(probe.format.format_name).toContain("flac");
    expect(probe.streams).toContainEqual(
      expect.objectContaining({ codec_type: "audio", codec_name: "flac" }),
    );
    expect(tags).toEqual(
      expect.objectContaining({
        album: "Album",
        album_artist: "Artist",
        title: "Observed Title",
        artist: "Observed Artist",
        disc: "2",
        track: "2/9",
      }),
    );
    database.raw
      .prepare(
        "UPDATE media_files SET track_number=NULL, track_total=NULL WHERE id='track-delivery-1'",
      )
      .run();
    const withoutTrack = await new DeliveryRunner(
      database,
      vault,
      join(root, "delivery"),
      join(root, "cache-two"),
      "ffmpeg",
      "ffprobe",
    ).prepareAlbumDelivery("album-delivery", "AK_FILE_DROP");
    const noTrackProbe = JSON.parse(
      (
        await execFileAsync("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "format_tags=track",
          "-of",
          "json",
          withoutTrack.files[0]!.preparedPath!,
        ])
      ).stdout,
    ) as { format?: { tags?: Record<string, string> } };
    expect(
      Object.keys(noTrackProbe.format?.tags ?? {}).map((key) =>
        key.toLowerCase(),
      ),
    ).not.toContain("track");
    database.close();
  });

  it("fails closed when a DSD copy needs unsupported tag normalization", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-dsd-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const sourceRelative = "Artist/Album/01 Track.dsf";
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await writeFile(join(musicRoot, sourceRelative), "lossless-audio-bytes");
    const database = deliveryDatabase(musicRoot, sourceRelative, null);
    database.raw
      .prepare(
        `UPDATE media_files SET extension='.dsf', container='dsf', codec='dsd_lsbf',
         audio_kind='DSD', album=NULL WHERE id='track-delivery-1'`,
      )
      .run();
    const vault = await CredentialVault.load(join(root, "credential.key"));
    await expect(
      new DeliveryRunner(
        database,
        vault,
        join(root, "delivery"),
        join(root, "cache"),
      ).prepareAlbumDelivery("album-delivery", "AK_FILE_DROP"),
    ).rejects.toThrow("暂不支持安全标签规范");
    database.close();
  });

  it("sanitizes organized path segments and truncates them on UTF-8 boundaries", () => {
    const first = safeAlbumTargetPath({
      ...albumBundle("same-id"),
      albumArtist: "/\\\u0001..",
      title: `${"中😀".repeat(100)}/..`,
    });
    const second = safeAlbumTargetPath({
      ...albumBundle("other-id"),
      albumArtist: "/\\\u0001..",
      title: `${"中😀".repeat(100)}/..`,
    });
    expect(Buffer.byteLength(first.split("/")[0]!, "utf8")).toBeLessThanOrEqual(
      125,
    );
    expect(
      Buffer.byteLength(first.split("/")[1]!.split(" [")[0]!, "utf8"),
    ).toBeLessThanOrEqual(125);
    expect(first).not.toMatch(/[\\\u0000-\u001f]/);
    expect(first.split("/")).not.toContain("..");
    expect(first).not.toBe(second);
    expect(first).not.toContain("�");
  });

  it("fails preparation when the source changes with the same size during conversion", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cocean-delivery-source-window-"),
    );
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const relativePath = "Artist/Album/01 Track.flac";
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await writeFile(join(musicRoot, relativePath), "lossless-audio-bytes");
    const database = deliveryDatabase(musicRoot, relativePath, null);
    database.raw
      .prepare(
        "UPDATE media_files SET album='Wrong' WHERE id='track-delivery-1'",
      )
      .run();
    const ffmpeg = join(root, "drift-ffmpeg.sh");
    await writeFile(
      ffmpeg,
      `#!/bin/sh\ninput=''\noutput=''\nprevious=''\nfor argument in "$@"; do [ "$previous" = '-i' ] && input="$argument"; previous="$argument"; output="$argument"; done\ncp "$input" "$output"\nprintf '%s' 'LOSSLESS-AUDIO-BYTES' > "$input"\n`,
      { mode: 0o755 },
    );
    const ffprobe = await createFakeFfprobe(root);
    const vault = await CredentialVault.load(join(root, "credential.key"));
    await expect(
      new DeliveryRunner(
        database,
        vault,
        join(root, "delivery"),
        join(root, "cache"),
        ffmpeg,
        ffprobe,
      ).prepareAlbumDelivery("album-delivery", "AK_FILE_DROP"),
    ).rejects.toThrow("副本生成期间发生变化");
    database.close();
  });

  it("rejects a delivery-audio symlink that escapes the real cache root", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-cache-link-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const cacheRoot = join(root, "cache");
    const outside = join(root, "outside");
    const relativePath = "Artist/Album/01 Track.flac";
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await mkdir(cacheRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(cacheRoot, "delivery-audio"));
    await writeFile(join(musicRoot, relativePath), "lossless-audio-bytes");
    const database = deliveryDatabase(musicRoot, relativePath, null);
    const vault = await CredentialVault.load(join(root, "credential.key"));
    await expect(
      new DeliveryRunner(
        database,
        vault,
        join(root, "delivery"),
        cacheRoot,
      ).prepareAlbumDelivery("album-delivery", "AK_FILE_DROP"),
    ).rejects.toThrow("超出 cacheRoot 边界");
    database.close();
  });

  it("delivers observed multi-disc files into Disc folders and leaves an unknown Disc at the Album root", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-disc-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const deliveryRoot = join(root, "delivery");
    const cacheRoot = join(root, "cache");
    const sourceRelatives = [
      "Artist/Album/01 One.flac",
      "Artist/Album/01 Two.flac",
      "Artist/Album/Bonus.flac",
    ];
    const artworkHash = "d".repeat(64);
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await mkdir(join(cacheRoot, "artwork"), { recursive: true });
    await mkdir(deliveryRoot, { recursive: true });
    await Promise.all(
      sourceRelatives.map((path) =>
        writeFile(join(musicRoot, path), "lossless-audio-bytes"),
      ),
    );
    await writeFile(join(cacheRoot, "artwork", `${artworkHash}.jpg`), "jpeg");
    const database = deliveryDatabase(
      musicRoot,
      sourceRelatives,
      `/api/v1/artwork/${artworkHash}`,
    );
    database.raw
      .prepare(
        `UPDATE media_files SET disc_number=CASE id
          WHEN 'track-delivery-1' THEN 1
          WHEN 'track-delivery-2' THEN 1
          ELSE NULL END`,
      )
      .run();
    database.raw
      .prepare(
        "UPDATE album_files SET disc_number_override=2 WHERE media_file_id='track-delivery-2'",
      )
      .run();
    const fakeFfmpeg = await createFakeFfmpeg(root);
    const vault = await CredentialVault.load(join(root, "credential.key"));
    const runner = new DeliveryRunner(
      database,
      vault,
      deliveryRoot,
      cacheRoot,
      fakeFfmpeg,
    );
    const bundle = await runner.prepareAlbumDelivery(
      "album-delivery",
      "AK_FILE_DROP",
    );
    expect(bundle.files.map((file) => file.targetRelativePath)).toEqual([
      `${bundle.targetAlbumPath}/Disc 01/001 01 One.flac`,
      `${bundle.targetAlbumPath}/002 Bonus.flac`,
      `${bundle.targetAlbumPath}/Disc 02/003 01 Two.flac`,
    ]);
    expect(bundle.preparedArtwork?.targetRelativePath).toBe(
      `${bundle.targetAlbumPath}/cover.jpg`,
    );
    database.close();
  });

  it("fails an AK File Drop job when the remote size check disagrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-ftp-size-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const deliveryRoot = join(root, "delivery");
    const sourceRelative = "Artist/Album/01 Track.flac";
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await mkdir(deliveryRoot, { recursive: true });
    await writeFile(join(musicRoot, sourceRelative), "lossless-audio-bytes");
    const database = deliveryDatabase(musicRoot, sourceRelative, null);
    const vault = await CredentialVault.load(join(root, "credential.key"));
    database.createDeliveryTarget(
      {
        id: "target-ftp-size",
        deviceId: null,
        name: "SP3000M",
        kind: "NETWORK",
        transport: "AK_FILE_DROP",
        location: "ftp://sp3000m.local/",
        username: "AK",
        credentialConfigured: true,
        enabled: true,
        verifiedAt: null,
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
      },
      vault.encrypt(JSON.stringify({ password: "test-password" })),
    );
    database.createDeliveryJob({
      id: "delivery-ftp-size",
      albumId: "album-delivery",
      targetId: "target-ftp-size",
      targetName: "SP3000M",
      transport: "AK_FILE_DROP",
      status: "QUEUED",
      fileCount: 1,
      completedFileCount: 0,
      totalBytes: 20,
      transferredBytes: 0,
      verified: false,
      error: null,
      createdAt: "2026-08-12T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    });
    const ftpClient = fakeFtpClient(new Map(), 19);
    new DeliveryRunner(
      database,
      vault,
      deliveryRoot,
      join(root, "cache"),
      "ffmpeg",
      "ffprobe",
      () => ftpClient,
    ).start();

    await waitFor(() =>
      database
        .listAlbumDeliveryJobs("album-delivery")
        .some((job) => ["COMPLETED", "FAILED"].includes(job.status)),
    );
    expect(database.listAlbumDeliveryJobs("album-delivery")[0]).toEqual(
      expect.objectContaining({
        status: "FAILED",
        verified: false,
        error: expect.stringContaining("文件大小校验失败"),
      }),
    );
    database.close();
  });

  it("fails FTP verification when downloaded bytes are corrupted without changing size", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-ftp-hash-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const deliveryRoot = join(root, "delivery");
    const relativePath = "Artist/Album/01 Track.flac";
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await mkdir(deliveryRoot, { recursive: true });
    await writeFile(join(musicRoot, relativePath), "lossless-audio-bytes");
    const database = deliveryDatabase(musicRoot, relativePath, null);
    const vault = await CredentialVault.load(join(root, "credential.key"));
    database.createDeliveryTarget(
      ftpTarget("ftp-hash-target"),
      vault.encrypt(JSON.stringify({ password: "test-password" })),
    );
    database.createDeliveryJob(
      deliveryJob("ftp-hash", "ftp-hash-target", "AK_FILE_DROP"),
    );
    new DeliveryRunner(
      database,
      vault,
      deliveryRoot,
      join(root, "cache"),
      "ffmpeg",
      "ffprobe",
      () => fakeFtpClient(new Map(), null, true),
    ).start();
    await waitFor(
      () => database.getDeliveryJob("delivery-ftp-hash")?.status === "FAILED",
    );
    expect(database.getDeliveryJob("delivery-ftp-hash")).toEqual(
      expect.objectContaining({
        verified: false,
        error: expect.stringContaining("哈希校验失败"),
      }),
    );
    database.close();
  });

  it("delivers FTP multi-disc files under Disc folders with artwork at the Album root", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-ftp-disc-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const cacheRoot = join(root, "cache");
    const relativePaths = [
      "Artist/Album/01 Disc One.flac",
      "Artist/Album/01 Disc Two.flac",
    ];
    const artworkHash = "e".repeat(64);
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await mkdir(join(cacheRoot, "artwork"), { recursive: true });
    await Promise.all(
      relativePaths.map((path) =>
        writeFile(join(musicRoot, path), "lossless-audio-bytes"),
      ),
    );
    await writeFile(join(cacheRoot, "artwork", `${artworkHash}.jpg`), "jpeg");
    const database = deliveryDatabase(
      musicRoot,
      relativePaths,
      `/api/v1/artwork/${artworkHash}`,
    );
    database.raw
      .prepare(
        `UPDATE media_files SET disc_number=CASE id
         WHEN 'track-delivery-1' THEN 1 ELSE 2 END`,
      )
      .run();
    const vault = await CredentialVault.load(join(root, "credential.key"));
    database.createDeliveryTarget(
      ftpTarget("ftp-disc-target"),
      vault.encrypt(JSON.stringify({ password: "test-password" })),
    );
    const remoteFiles = new Map<string, Buffer>();
    const ffmpeg = await createFakeFfmpeg(root);
    const runner = new DeliveryRunner(
      database,
      vault,
      join(root, "delivery"),
      cacheRoot,
      ffmpeg,
      "ffprobe",
      () => fakeFtpClient(remoteFiles),
    );
    const bundle = await runner.prepareAlbumDelivery(
      "album-delivery",
      "AK_FILE_DROP",
    );
    database.createDeliveryJob(
      {
        ...frozenJob("ftp-disc", "ftp-disc-target", bundle),
        transport: "AK_FILE_DROP",
      },
      bundle,
    );
    runner.start();
    await waitFor(() =>
      ["COMPLETED", "FAILED"].includes(
        database.getDeliveryJob("delivery-ftp-disc")?.status ?? "",
      ),
    );
    expect(database.getDeliveryJob("delivery-ftp-disc")).toEqual(
      expect.objectContaining({ status: "COMPLETED", verified: true }),
    );
    const base = `/Music/${bundle.targetAlbumPath}`;
    expect([...remoteFiles.keys()].sort()).toEqual(
      [
        `${base}/Disc 01/001 01 Disc One.flac`,
        `${base}/Disc 02/002 01 Disc Two.flac`,
        `${base}/cover.jpg`,
      ].sort(),
    );
    const manifest = JSON.parse(
      String(
        (
          database.raw
            .prepare(
              "SELECT manifest_json FROM delivery_jobs WHERE id='delivery-ftp-disc'",
            )
            .get() as { manifest_json: string }
        ).manifest_json,
      ),
    ) as Array<{ relativePath: string }>;
    expect(manifest.map((entry) => entry.relativePath).sort()).toEqual(
      [
        `${bundle.targetAlbumPath}/Disc 01/001 01 Disc One.flac`,
        `${bundle.targetAlbumPath}/Disc 02/002 01 Disc Two.flac`,
        `${bundle.targetAlbumPath}/cover.jpg`,
      ].sort(),
    );
    database.close();
  });

  it("removes only verified files from a newly created failed FTP Album so retry succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-ftp-retry-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const relativePaths = [
      "Artist/Album/01 One.flac",
      "Artist/Album/02 Two.flac",
    ];
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await Promise.all(
      relativePaths.map((path) =>
        writeFile(join(musicRoot, path), "lossless-audio-bytes"),
      ),
    );
    const database = deliveryDatabase(musicRoot, relativePaths, null);
    const vault = await CredentialVault.load(join(root, "credential.key"));
    database.createDeliveryTarget(
      ftpTarget("ftp-retry-target"),
      vault.encrypt(JSON.stringify({ password: "test-password" })),
    );
    const remoteFiles = new Map<string, Buffer>();
    const failingRunner = new DeliveryRunner(
      database,
      vault,
      join(root, "delivery"),
      join(root, "cache"),
      "ffmpeg",
      "ffprobe",
      () =>
        fakeFtpClient(remoteFiles, (_path, uploadCount) =>
          uploadCount === 2 ? 19 : 20,
        ),
    );
    const bundle = await failingRunner.prepareAlbumDelivery(
      "album-delivery",
      "AK_FILE_DROP",
    );
    database.createDeliveryJob(
      {
        ...frozenJob("ftp-retry-one", "ftp-retry-target", bundle),
        transport: "AK_FILE_DROP",
      },
      bundle,
    );
    failingRunner.start();
    await waitFor(
      () =>
        database.getDeliveryJob("delivery-ftp-retry-one")?.status === "FAILED",
    );
    expect(remoteFiles.size).toBe(0);

    database.createDeliveryJob(
      {
        ...frozenJob("ftp-retry-two", "ftp-retry-target", bundle),
        transport: "AK_FILE_DROP",
      },
      bundle,
    );
    const retryRunner = new DeliveryRunner(
      database,
      vault,
      join(root, "delivery"),
      join(root, "cache"),
      "ffmpeg",
      "ffprobe",
      () => fakeFtpClient(remoteFiles),
    );
    retryRunner.start();
    await waitFor(
      () =>
        database.getDeliveryJob("delivery-ftp-retry-two")?.status ===
        "COMPLETED",
    );
    expect(database.getDeliveryJob("delivery-ftp-retry-two")?.verified).toBe(
      true,
    );
    database.close();
  });

  it("fails closed when an Album promises artwork but the cached image is missing", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cocean-delivery-cover-missing-"),
    );
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const deliveryRoot = join(root, "delivery");
    const cacheRoot = join(root, "cache");
    const sourceRelative = "Artist/Album/01 Track.flac";
    const artworkHash = "b".repeat(64);
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await mkdir(deliveryRoot, { recursive: true });
    await writeFile(join(musicRoot, sourceRelative), "lossless-audio-bytes");
    const database = deliveryDatabase(
      musicRoot,
      sourceRelative,
      `/api/v1/artwork/${artworkHash}`,
    );
    database.createDeliveryTarget({
      id: "target-cover-missing",
      deviceId: null,
      name: "USB",
      kind: "MOUNTED_VOLUME",
      transport: "USB_MOUNT",
      location: join(deliveryRoot, "SP3000M"),
      username: null,
      credentialConfigured: false,
      enabled: true,
      verifiedAt: null,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    });
    database.createDeliveryJob({
      id: "delivery-cover-missing",
      albumId: "album-delivery",
      targetId: "target-cover-missing",
      targetName: "USB",
      transport: "USB_MOUNT",
      status: "QUEUED",
      fileCount: 0,
      completedFileCount: 0,
      totalBytes: 0,
      transferredBytes: 0,
      verified: false,
      error: null,
      createdAt: "2026-08-12T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    });
    const vault = await CredentialVault.load(join(root, "credential.key"));
    new DeliveryRunner(
      database,
      vault,
      deliveryRoot,
      cacheRoot,
      "ffmpeg",
    ).start();

    await waitFor(() =>
      database
        .listAlbumDeliveryJobs("album-delivery")
        .some((job) => ["COMPLETED", "FAILED"].includes(job.status)),
    );
    expect(database.listAlbumDeliveryJobs("album-delivery")[0]).toEqual(
      expect.objectContaining({
        status: "FAILED",
        error: expect.stringContaining("封面缓存不可用"),
      }),
    );
    database.close();
  });

  it("uses distinct stable directory suffixes for identical human Album labels", () => {
    const first = albumDirectory("album-one");
    const second = albumDirectory("album-two");
    expect(first).not.toBe(second);
    expect(first).toContain("album-one-");
    expect(second).toContain("album-two-");
  });

  it("fails closed instead of overwriting a non-empty USB Album directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-usb-existing-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const deliveryRoot = join(root, "delivery");
    const sourceRelative = "Artist/Album/01 Track.flac";
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await writeFile(join(musicRoot, sourceRelative), "lossless-audio-bytes");
    const targetRoot = join(deliveryRoot, "SP3000M");
    const destination = join(targetRoot, albumDirectory());
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "old.flac"), "keep-me");
    const database = deliveryDatabase(musicRoot, sourceRelative, null);
    database.createDeliveryTarget(usbTarget("target-existing", targetRoot));
    database.createDeliveryJob(deliveryJob("existing", "target-existing"));
    const vault = await CredentialVault.load(join(root, "credential.key"));
    new DeliveryRunner(database, vault, deliveryRoot).start();

    await waitFor(() =>
      database
        .listAlbumDeliveryJobs("album-delivery")
        .some((job) => ["COMPLETED", "FAILED"].includes(job.status)),
    );
    expect(database.getDeliveryJob("delivery-existing")).toEqual(
      expect.objectContaining({
        status: "FAILED",
        completedFileCount: 0,
        error: expect.stringContaining("未覆盖或移动旧文件"),
      }),
    );
    expect(await readFile(join(destination, "old.flac"), "utf8")).toBe(
      "keep-me",
    );
    database.close();
  });

  it("fails closed instead of overwriting a non-empty FTP Album directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-ftp-existing-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const deliveryRoot = join(root, "delivery");
    const sourceRelative = "Artist/Album/01 Track.flac";
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await mkdir(deliveryRoot, { recursive: true });
    await writeFile(join(musicRoot, sourceRelative), "lossless-audio-bytes");
    const database = deliveryDatabase(musicRoot, sourceRelative, null);
    const vault = await CredentialVault.load(join(root, "credential.key"));
    database.createDeliveryTarget(
      ftpTarget("target-ftp-existing"),
      vault.encrypt(JSON.stringify({ password: "test-password" })),
    );
    database.createDeliveryJob(
      deliveryJob("ftp-existing", "target-ftp-existing", "AK_FILE_DROP"),
    );
    const oldPath = `/Music/${albumDirectory()}/old.flac`;
    const remoteFiles = new Map([[oldPath, Buffer.from("keep-me")]]);
    new DeliveryRunner(
      database,
      vault,
      deliveryRoot,
      join(root, "cache"),
      "ffmpeg",
      "ffprobe",
      () => fakeFtpClient(remoteFiles),
    ).start();

    await waitFor(() =>
      database
        .listAlbumDeliveryJobs("album-delivery")
        .some((job) => ["COMPLETED", "FAILED"].includes(job.status)),
    );
    expect(database.getDeliveryJob("delivery-ftp-existing")).toEqual(
      expect.objectContaining({
        status: "FAILED",
        completedFileCount: 0,
        error: expect.stringContaining("未覆盖或移动旧文件"),
      }),
    );
    expect(remoteFiles.get(oldPath)?.toString()).toBe("keep-me");
    database.close();
  });

  it("rejects an organized-v2 frozen bundle on an ordinary USB target without touching either copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-v2-existing-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const deliveryRoot = join(root, "delivery");
    const targetRoot = join(deliveryRoot, "SP3000M");
    const sourceRelative = "Artist/Album/01 Track.flac";
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await mkdir(deliveryRoot, { recursive: true });
    await writeFile(join(musicRoot, sourceRelative), "lossless-audio-bytes");
    const database = deliveryDatabase(musicRoot, sourceRelative, null);
    database.createDeliveryTarget(usbTarget("target-v2-existing", targetRoot));
    const vault = await CredentialVault.load(join(root, "credential.key"));
    const runner = new DeliveryRunner(
      database,
      vault,
      deliveryRoot,
      join(root, "cache"),
    );
    const bundle = await runner.prepareAlbumDelivery(
      "album-delivery",
      "AK_FILE_DROP",
    );
    const legacyDirectory = join(targetRoot, albumDirectory());
    const organizedDirectory = join(targetRoot, bundle.targetAlbumPath!);
    await mkdir(legacyDirectory, { recursive: true });
    await mkdir(organizedDirectory, { recursive: true });
    await writeFile(join(legacyDirectory, "old.flac"), "keep-legacy");
    await writeFile(join(organizedDirectory, "existing.flac"), "keep-new");
    database.createDeliveryJob(
      frozenJob("v2-existing", "target-v2-existing", bundle),
      bundle,
    );
    runner.start();

    await waitFor(() =>
      ["COMPLETED", "FAILED"].includes(
        database.getDeliveryJob("delivery-v2-existing")?.status ?? "",
      ),
    );
    expect(database.getDeliveryJob("delivery-v2-existing")).toEqual(
      expect.objectContaining({
        status: "FAILED",
        error: expect.stringContaining("organized-v2 仅允许用于 AK File Drop"),
      }),
    );
    expect(await readFile(join(legacyDirectory, "old.flac"), "utf8")).toBe(
      "keep-legacy",
    );
    expect(
      await readFile(join(organizedDirectory, "existing.flac"), "utf8"),
    ).toBe("keep-new");
    database.close();
  });

  it("runs a queued job from its frozen source membership after Album primary files change", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-frozen-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const deliveryRoot = join(root, "delivery");
    const sources = [
      "Artist/Album/01 Original.flac",
      "Artist/Album/01 Replacement.flac",
    ];
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await mkdir(deliveryRoot, { recursive: true });
    await writeFile(join(musicRoot, sources[0]!), "lossless-audio-bytes");
    await writeFile(join(musicRoot, sources[1]!), "lossless-audio-bytes");
    const database = deliveryDatabase(musicRoot, sources, null);
    database.raw
      .prepare(
        `UPDATE album_files SET is_primary = CASE media_file_id
          WHEN 'track-delivery-1' THEN 1 ELSE 0 END
         WHERE album_id='album-delivery'`,
      )
      .run();
    database.raw
      .prepare(
        "UPDATE media_files SET file_sha256=NULL WHERE id='track-delivery-1'",
      )
      .run();
    const targetRoot = join(deliveryRoot, "SP3000M");
    database.createDeliveryTarget(usbTarget("target-frozen", targetRoot));
    const vault = await CredentialVault.load(join(root, "credential.key"));
    const runner = new DeliveryRunner(
      database,
      vault,
      deliveryRoot,
      join(root, "cache"),
    );
    const bundle = await runner.prepareAlbumDelivery(
      "album-delivery",
      "USB_MOUNT",
    );
    expect(bundle.files.map((file) => file.relativePath)).toEqual([sources[0]]);
    expect(bundle.files[0]?.sha256).toBe(
      createHash("sha256").update("lossless-audio-bytes").digest("hex"),
    );
    database.createDeliveryJob(
      {
        ...deliveryJob("frozen", "target-frozen"),
        fileCount: 1,
        totalBytes: 20,
      },
      bundle,
    );
    database.raw
      .prepare(
        `UPDATE album_files SET is_primary = CASE media_file_id
          WHEN 'track-delivery-2' THEN 1 ELSE 0 END
         WHERE album_id='album-delivery'`,
      )
      .run();
    runner.start();

    await waitFor(() =>
      database
        .listAlbumDeliveryJobs("album-delivery")
        .some((job) => ["COMPLETED", "FAILED"].includes(job.status)),
    );
    expect(database.getDeliveryJob("delivery-frozen")).toEqual(
      expect.objectContaining({
        status: "COMPLETED",
        completedFileCount: 1,
        verified: true,
      }),
    );
    expect(await readdir(join(targetRoot, albumDirectory()))).toEqual([
      "001 01 Original.flac",
    ]);
    database.close();
  });

  it("executes a legacy frozen bundle end to end using the flat Album path", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cocean-delivery-legacy-frozen-"),
    );
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const deliveryRoot = join(root, "delivery");
    const relativePath = "Artist/Album/01 Track.flac";
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await mkdir(deliveryRoot, { recursive: true });
    await writeFile(join(musicRoot, relativePath), "lossless-audio-bytes");
    const database = deliveryDatabase(musicRoot, relativePath, null);
    const targetRoot = join(deliveryRoot, "USB");
    database.createDeliveryTarget(
      usbTarget("legacy-frozen-target", targetRoot),
    );
    const vault = await CredentialVault.load(join(root, "credential.key"));
    const runner = new DeliveryRunner(database, vault, deliveryRoot);
    const bundle = await runner.prepareAlbumDelivery(
      "album-delivery",
      "USB_MOUNT",
    );
    expect(bundle.deliveryProfileVersion).toBeUndefined();
    database.createDeliveryJob(
      deliveryJob("legacy-frozen", "legacy-frozen-target"),
      bundle,
    );
    runner.start();
    await waitFor(() =>
      ["COMPLETED", "FAILED"].includes(
        database.getDeliveryJob("delivery-legacy-frozen")?.status ?? "",
      ),
    );
    expect(database.getDeliveryJob("delivery-legacy-frozen")).toEqual(
      expect.objectContaining({ status: "COMPLETED", verified: true }),
    );
    expect(await readdir(join(targetRoot, albumDirectory()))).toEqual([
      "001 01 Track.flac",
    ]);
    database.close();
  });

  it("rejects an unknown frozen delivery profile version", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-delivery-version-"));
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const relativePath = "Artist/Album/01 Track.flac";
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await writeFile(join(musicRoot, relativePath), "lossless-audio-bytes");
    const database = deliveryDatabase(musicRoot, relativePath, null);
    database.createDeliveryTarget(
      usbTarget("version-target", join(root, "delivery", "USB")),
    );
    const vault = await CredentialVault.load(join(root, "credential.key"));
    const runner = new DeliveryRunner(database, vault, join(root, "delivery"));
    const bundle = await runner.prepareAlbumDelivery(
      "album-delivery",
      "USB_MOUNT",
    );
    database.createDeliveryJob(
      deliveryJob("version", "version-target"),
      bundle,
    );
    const stored = JSON.parse(
      String(
        (
          database.raw
            .prepare(
              "SELECT source_bundle_json FROM delivery_jobs WHERE id='delivery-version'",
            )
            .get() as { source_bundle_json: string }
        ).source_bundle_json,
      ),
    ) as Record<string, unknown>;
    stored.deliveryProfileVersion = "organized-v3";
    database.raw
      .prepare(
        "UPDATE delivery_jobs SET source_bundle_json=? WHERE id='delivery-version'",
      )
      .run(JSON.stringify(stored));
    runner.start();
    await waitFor(
      () => database.getDeliveryJob("delivery-version")?.status === "FAILED",
    );
    expect(database.getDeliveryJob("delivery-version")).toEqual(
      expect.objectContaining({
        verified: false,
        error: expect.stringContaining("版本不受支持"),
      }),
    );
    database.close();
  });

  it("fails instead of completing when manifest membership does not match the frozen job", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cocean-delivery-complete-gate-"),
    );
    temporaryDirectories.push(root);
    const musicRoot = join(root, "music");
    const relativePath = "Artist/Album/01 Track.flac";
    await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
    await writeFile(join(musicRoot, relativePath), "lossless-audio-bytes");
    const database = deliveryDatabase(musicRoot, relativePath, null);
    const deliveryRoot = join(root, "delivery");
    database.createDeliveryTarget(
      usbTarget("complete-gate-target", join(deliveryRoot, "USB")),
    );
    const vault = await CredentialVault.load(join(root, "credential.key"));
    const runner = new DeliveryRunner(database, vault, deliveryRoot);
    const bundle = await runner.prepareAlbumDelivery(
      "album-delivery",
      "USB_MOUNT",
    );
    database.createDeliveryJob(
      {
        ...deliveryJob("complete-gate", "complete-gate-target"),
        fileCount: 2,
      },
      bundle,
    );
    runner.start();
    await waitFor(
      () =>
        database.getDeliveryJob("delivery-complete-gate")?.status === "FAILED",
    );
    expect(database.getDeliveryJob("delivery-complete-gate")).toEqual(
      expect.objectContaining({
        verified: false,
        error: expect.stringContaining("完成校验不完整"),
      }),
    );
    database.close();
  });

  it.each([
    ["source", "投送源校验值"],
    ["cache", "冻结音频副本校验"],
  ] as const)(
    "fails a frozen organized-v2 job when the %s bytes drift",
    async (drift, expectedError) => {
      const root = await mkdtemp(
        join(tmpdir(), `cocean-delivery-${drift}-drift-`),
      );
      temporaryDirectories.push(root);
      const musicRoot = join(root, "music");
      const deliveryRoot = join(root, "delivery");
      const sourceRelative = "Artist/Album/01 Track.flac";
      await mkdir(join(musicRoot, "Artist", "Album"), { recursive: true });
      await mkdir(deliveryRoot, { recursive: true });
      await writeFile(join(musicRoot, sourceRelative), "lossless-audio-bytes");
      const database = deliveryDatabase(musicRoot, sourceRelative, null);
      const targetId = `target-${drift}-drift`;
      const vault = await CredentialVault.load(join(root, "credential.key"));
      database.createDeliveryTarget(
        ftpTarget(targetId),
        vault.encrypt(JSON.stringify({ password: "test-password" })),
      );
      const runner = new DeliveryRunner(
        database,
        vault,
        deliveryRoot,
        join(root, "cache"),
        "ffmpeg",
        "ffprobe",
        () => fakeFtpClient(new Map()),
      );
      const bundle = await runner.prepareAlbumDelivery(
        "album-delivery",
        "AK_FILE_DROP",
      );
      database.createDeliveryJob(
        {
          ...frozenJob(`${drift}-drift`, targetId, bundle),
          transport: "AK_FILE_DROP",
        },
        bundle,
      );
      await writeFile(
        drift === "source"
          ? join(musicRoot, sourceRelative)
          : bundle.files[0]!.preparedPath!,
        "LOSSLESS-AUDIO-BYTES",
      );
      runner.start();
      await waitFor(() =>
        ["COMPLETED", "FAILED"].includes(
          database.getDeliveryJob(`delivery-${drift}-drift`)?.status ?? "",
        ),
      );
      expect(database.getDeliveryJob(`delivery-${drift}-drift`)).toEqual(
        expect.objectContaining({
          status: "FAILED",
          error: expect.stringContaining(expectedError),
        }),
      );
      database.close();
    },
  );
});

function deliveryDatabase(
  musicRoot: string,
  sourceRelative: string | string[],
  artworkUrl: string | null,
): CoceanDatabase {
  const sourceRelatives = Array.isArray(sourceRelative)
    ? sourceRelative
    : [sourceRelative];
  const database = new CoceanDatabase(":memory:", { musicRoot });
  database.createScanJob({
    id: "scan-delivery",
    rootId: "music",
    mode: "FULL",
    status: "RUNNING",
    totalFiles: sourceRelatives.length,
    processedFiles: sourceRelatives.length,
    parsedFiles: sourceRelatives.length,
    failedFiles: 0,
    reusedFiles: 0,
    createdAt: "2026-08-12T00:00:00.000Z",
    startedAt: "2026-08-12T00:00:00.000Z",
    finishedAt: null,
    error: null,
    cancelRequestedAt: null,
  });
  const audio = {
    kind: "PCM" as const,
    codec: "flac",
    container: "flac",
    lossless: true,
    bitDepth: 24,
    sampleRate: 96_000,
    bitrate: null,
    channels: 2,
    dsdRate: null,
  };
  const fileIds = sourceRelatives.map(
    (relativePath, index) => `track-delivery-${index + 1}`,
  );
  sourceRelatives.forEach((relativePath, index) => {
    database.upsertMediaFile(fileIds[index]!, "music", "scan-delivery", {
      absolutePath: join(musicRoot, relativePath),
      relativePath,
      extension: ".flac",
      sizeBytes: 20,
      modifiedAtMs: 1,
      fileSha256: createHash("sha256")
        .update("lossless-audio-bytes")
        .digest("hex"),
      audio,
      durationSeconds: 1,
      tags: {
        album: "Album",
        albumArtist: "Artist",
        title: `Track ${index + 1}`,
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
        trackNumber: index + 1,
        trackTotal: sourceRelatives.length,
      },
      rawTags: [],
      artwork: [],
      warnings: [],
    });
  });
  database.replaceAlbumsForRoot("music", [
    {
      id: "album-delivery",
      rootId: "music",
      groupKey: "artist\0album",
      title: "Album",
      albumArtist: "Artist",
      year: 2026,
      discCount: 1,
      fileIds,
      audioSummary: audio,
      mixedAudioSpecs: false,
      artwork: {
        source: artworkUrl ? ("SIDECAR" as const) : ("NONE" as const),
        url: artworkUrl,
        mimeType: artworkUrl ? "image/jpeg" : null,
        width: artworkUrl ? 600 : null,
        height: artworkUrl ? 600 : null,
      },
      matchStatus: "NEEDS_REVIEW",
    },
  ]);
  database.finishScanJob("scan-delivery");
  return database;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("delivery did not reach a terminal state");
}

function fakeFtpClient(
  remoteFiles: Map<string, Buffer>,
  reportedSize:
    number | null | ((path: string, uploadCount: number) => number) = null,
  corruptDownloads = false,
) {
  let currentDirectory = "/";
  let bytesOverall = 0;
  let uploadCount = 0;
  let progress: ((info: { bytesOverall: number }) => void) | undefined;
  return {
    accessOptions: null as Record<string, unknown> | null,
    progressRegistrations: 0,
    uploadProgressObserved: [] as boolean[],
    async access(options: Record<string, unknown>) {
      this.accessOptions = options;
    },
    async ensureDir(path: string) {
      currentDirectory = path.startsWith("/")
        ? path.replace(/\/+$/g, "") || "/"
        : `${currentDirectory.replace(/\/+$/g, "")}/${path}`;
    },
    async list(path?: string) {
      const base = path
        ? `${currentDirectory.replace(/\/+$/g, "")}/${path}`
        : currentDirectory.replace(/\/+$/g, "") || "/";
      const entries = new Map<string, { name: string; isDirectory: boolean }>();
      for (const remotePath of remoteFiles.keys()) {
        if (!remotePath.startsWith(`${base}/`)) continue;
        const remainder = remotePath.slice(base.length + 1);
        if (!remainder) continue;
        const [name, ...rest] = remainder.split("/");
        entries.set(name!, { name: name!, isDirectory: rest.length > 0 });
      }
      return [...entries.values()];
    },
    trackProgress(
      handler: ((info: { bytesOverall: number }) => void) | undefined,
    ) {
      progress = handler;
      if (handler) this.progressRegistrations += 1;
    },
    async uploadFrom(source: string, remotePath: string) {
      this.uploadProgressObserved.push(Boolean(progress));
      const content = await readFile(source);
      remoteFiles.set(
        `${currentDirectory.replace(/\/+$/g, "")}/${remotePath}`,
        content,
      );
      bytesOverall += content.byteLength;
      uploadCount += 1;
      progress?.({ bytesOverall });
    },
    async downloadTo(destination: string, remotePath: string) {
      const content = remoteFiles.get(
        `${currentDirectory.replace(/\/+$/g, "")}/${remotePath}`,
      );
      if (!content) throw new Error("remote file missing");
      const downloaded = Buffer.from(content);
      if (corruptDownloads && downloaded.length)
        downloaded[0] = downloaded[0] === 0 ? 1 : downloaded[0]! ^ 1;
      await writeFile(destination, downloaded);
    },
    async size(path: string) {
      if (typeof reportedSize === "function")
        return reportedSize(path, uploadCount);
      if (reportedSize !== null) return reportedSize;
      return (
        remoteFiles.get(`${currentDirectory.replace(/\/+$/g, "")}/${path}`)
          ?.byteLength ?? -1
      );
    },
    async remove(path: string) {
      remoteFiles.delete(`${currentDirectory.replace(/\/+$/g, "")}/${path}`);
    },
    async removeEmptyDir() {},
    close() {},
  };
}

function albumDirectory(albumId = "album-delivery"): string {
  return safeAlbumDirectoryName({
    albumId,
    title: "Album",
    albumArtist: "Artist",
    year: 2026,
    artwork: {
      source: "NONE",
      url: null,
      mimeType: null,
      width: null,
      height: null,
    },
    files: [],
  });
}

function albumBundle(albumId = "album-delivery") {
  return {
    albumId,
    title: "Album",
    albumArtist: "Artist",
    year: 2026,
    artwork: {
      source: "NONE" as const,
      url: null,
      mimeType: null,
      width: null,
      height: null,
    },
    files: [],
  };
}

function usbTarget(id: string, location: string) {
  return {
    id,
    deviceId: null,
    name: "USB",
    kind: "MOUNTED_VOLUME" as const,
    transport: "USB_MOUNT" as const,
    location,
    username: null,
    credentialConfigured: false,
    enabled: true,
    verifiedAt: null,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
}

function ftpTarget(id: string) {
  return {
    id,
    deviceId: null,
    name: "SP3000M",
    kind: "NETWORK" as const,
    transport: "AK_FILE_DROP" as const,
    location: "ftp://sp3000m.local/",
    username: "AK",
    credentialConfigured: true,
    enabled: true,
    verifiedAt: null,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
}

function deliveryJob(
  suffix: string,
  targetId: string,
  transport: "USB_MOUNT" | "AK_FILE_DROP" = "USB_MOUNT",
) {
  return {
    id: `delivery-${suffix}`,
    albumId: "album-delivery",
    targetId,
    targetName: transport === "USB_MOUNT" ? "USB" : "SP3000M",
    transport,
    status: "QUEUED" as const,
    fileCount: 1,
    completedFileCount: 0,
    totalBytes: 20,
    transferredBytes: 0,
    verified: false,
    error: null,
    createdAt: "2026-08-12T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
  };
}

function frozenJob(
  suffix: string,
  targetId: string,
  bundle: Awaited<ReturnType<DeliveryRunner["prepareAlbumDelivery"]>>,
) {
  return {
    ...deliveryJob(suffix, targetId),
    fileCount: bundle.files.length + Number(Boolean(bundle.preparedArtwork)),
    totalBytes:
      bundle.files.reduce(
        (total, file) => total + (file.outputSizeBytes ?? file.sizeBytes),
        0,
      ) + (bundle.preparedArtwork?.sizeBytes ?? 0),
  };
}

async function createFakeFfmpeg(
  root: string,
  logPath?: string,
): Promise<string> {
  const path = join(root, "fake-ffmpeg.sh");
  const log = logPath
    ? `printf '%s ' "$@" > ${JSON.stringify(logPath)}\nprintf '\\n' >> ${JSON.stringify(logPath)}\n`
    : "";
  await writeFile(
    path,
    `#!/bin/sh\n${log}input=''\noutput=''\nprevious=''\nfor argument in "$@"; do\n  if [ "$previous" = '-i' ]; then input="$argument"; fi\n  previous="$argument"\n  output="$argument"\ndone\ncp "$input" "$output"\n`,
    { mode: 0o755 },
  );
  return path;
}

async function createFakeFfprobe(
  root: string,
  overrides: {
    title?: string;
    artist?: string;
    disc?: string;
    track?: string | null;
  } = {},
): Promise<string> {
  const path = join(
    root,
    `fake-ffprobe-${Math.random().toString(16).slice(2)}.sh`,
  );
  const tags: Record<string, string> = {
    album: "Album",
    album_artist: "Artist",
    title: overrides.title ?? "Track 1",
    artist: overrides.artist ?? "Artist",
    disc: overrides.disc ?? "1/1",
  };
  if (overrides.track !== null) tags.track = overrides.track ?? "1/1";
  await writeFile(
    path,
    `#!/bin/sh\nprintf '%s' ${JSON.stringify(
      JSON.stringify({
        format: { format_name: "flac", tags },
        streams: [{ codec_type: "audio", codec_name: "flac" }],
      }),
    )}\n`,
    { mode: 0o755 },
  );
  return path;
}
