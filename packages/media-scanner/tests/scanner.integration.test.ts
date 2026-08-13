import { rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFile } from "music-metadata";
import { describe, expect, it } from "vitest";

import { scanMediaFile } from "../src/scanner.js";

const enabled = process.env.COCEAN_TEST_FIXTURES === "1";
const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "generated-fixtures",
);

describe.skipIf(!enabled)("generated ffmpeg fixtures", () => {
  it("scans CD-quality FLAC tags and facts", async () => {
    const result = await scanMediaFile(join(fixtureRoot, "cd-quality.flac"), {
      rootPath: fixtureRoot,
    });
    expect(result.audio).toMatchObject({
      kind: "PCM",
      codec: "flac",
      lossless: true,
      bitDepth: 16,
      sampleRate: 44_100,
      channels: 2,
    });
    expect(result.tags).toMatchObject({
      title: "Fixture Track",
      album: "Fixture Album",
      albumArtist: "COCEAN Fixture Artist",
      trackNumber: 1,
      trackTotal: 1,
    });
    expect(result.fileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.rawTags.length).toBeGreaterThan(0);
    expect(result.rawTags).toContainEqual(
      expect.objectContaining({
        id: expect.any(String),
        value: expect.any(String),
      }),
    );
  });

  it("scans a hi-res FLAC and a DXD-rate PCM fixture", async () => {
    const highResolution = await scanMediaFile(
      join(fixtureRoot, "hires-24-96.flac"),
      {
        rootPath: fixtureRoot,
      },
    );
    const dxd = await scanMediaFile(join(fixtureRoot, "dxd-24-352k.wav"), {
      rootPath: fixtureRoot,
    });

    expect(highResolution.audio).toMatchObject({
      bitDepth: 24,
      sampleRate: 96_000,
    });
    expect(dxd.audio).toMatchObject({
      kind: "DXD",
      bitDepth: 24,
      sampleRate: 352_800,
    });
  });

  it("scans ALAC, AIFF and MKA facts without relying on filenames", async () => {
    const alac = await scanMediaFile(
      join(fixtureRoot, "有声唱片", "02 夜航.m4a"),
      { rootPath: fixtureRoot },
    );
    const aiff = await scanMediaFile(join(fixtureRoot, "hires-24-96.aiff"), {
      rootPath: fixtureRoot,
    });
    const matroska = await scanMediaFile(
      join(fixtureRoot, "lossless-audio.mka"),
      { rootPath: fixtureRoot },
    );

    expect(alac).toMatchObject({
      relativePath: "有声唱片/02 夜航.m4a",
      audio: { kind: "PCM", codec: "alac", lossless: true, sampleRate: 48_000 },
      tags: {
        title: "夜航",
        album: "海上录音",
        albumArtist: "测试艺术家",
        trackNumber: 2,
        trackTotal: 3,
      },
    });
    expect(aiff.audio).toMatchObject({
      kind: "PCM",
      codec: "pcm_s24be",
      lossless: true,
      bitDepth: 24,
      sampleRate: 96_000,
    });
    expect(matroska.audio).toMatchObject({
      kind: "PCM",
      codec: "flac",
      lossless: true,
      bitDepth: 16,
      sampleRate: 44_100,
    });
  });

  it("returns sidecar and embedded artwork metadata", async () => {
    const sidecar = await scanMediaFile(
      join(fixtureRoot, "album-with-cover", "01-track.flac"),
      {
        rootPath: fixtureRoot,
      },
    );
    const embedded = await scanMediaFile(
      join(fixtureRoot, "embedded-cover.mp3"),
      {
        rootPath: fixtureRoot,
      },
    );

    expect(sidecar.artwork).toContainEqual(
      expect.objectContaining({ source: "SIDECAR", kind: "Front Cover" }),
    );
    expect(embedded.artwork).toContainEqual(
      expect.objectContaining({ source: "EMBEDDED", kind: "Front Cover" }),
    );
  });

  it("prefers an embedded Front Cover over a sibling sidecar", async () => {
    const result = await scanMediaFile(
      join(fixtureRoot, "有声唱片", "嵌入封面优先", "01 封面优先级.mp3"),
      { rootPath: fixtureRoot },
    );

    expect(result.artwork.map(({ source }) => source)).toEqual([
      "EMBEDDED",
      "SIDECAR",
    ]);
    expect(result.artwork[0]).toMatchObject({
      kind: "Front Cover",
      mimeType: "image/jpeg",
      width: 192,
      height: 192,
    });
    expect(result.artwork[1]).toMatchObject({
      source: "SIDECAR",
      width: 160,
      height: 160,
    });
    expect(result.artwork[0]?.sha256).not.toBe(result.artwork[1]?.sha256);
  });

  it("classifies a truncated audio file deterministically", async () => {
    const corruptPath = join(fixtureRoot, "corrupt-truncated.flac");
    await expect(
      scanMediaFile(corruptPath, { rootPath: fixtureRoot }),
    ).rejects.toMatchObject({
      name: "MediaScanError",
      code: "FFPROBE_FAILED",
      stage: "probe",
      filePath: corruptPath,
    });
  });

  it.each(["jpeg-disguised-as-audio.flac", "jpeg-disguised-as-audio.dsf"])(
    "classifies JPEG bytes named %s as a content-type mismatch",
    async (fixtureName) => {
      const disguisedPath = join(fixtureRoot, fixtureName);

      // Lock the regression precondition: music-metadata rejects this JPEG as
      // malformed audio metadata while ffprobe successfully identifies an
      // image stream. The successful no-audio probe must win.
      await expect(parseFile(disguisedPath)).rejects.toMatchObject({
        name: "FieldDecodingError",
      });
      await expect(
        scanMediaFile(disguisedPath, { rootPath: fixtureRoot }),
      ).rejects.toMatchObject({
        name: "MediaScanError",
        code: "CONTENT_TYPE_MISMATCH",
        stage: "probe",
        filePath: disguisedPath,
        recoverable: true,
      });
    },
  );

  it("keeps a general container without audio as unsupported media", async () => {
    const videoOnlyPath = join(fixtureRoot, "video-only.mp4");
    await expect(
      scanMediaFile(videoOnlyPath, { rootPath: fixtureRoot }),
    ).rejects.toMatchObject({
      name: "MediaScanError",
      code: "UNSUPPORTED_MEDIA",
      stage: "probe",
      filePath: videoOnlyPath,
      recoverable: true,
    });
  });

  it("allows a symlink when its canonical target remains inside the root", async () => {
    const linkedPath = join(fixtureRoot, "internal-link.flac");
    await rm(linkedPath, { force: true });
    await symlink("cd-quality.flac", linkedPath);
    try {
      const result = await scanMediaFile(linkedPath, { rootPath: fixtureRoot });
      expect(result).toMatchObject({
        absolutePath: linkedPath,
        relativePath: "internal-link.flac",
        audio: { kind: "PCM", codec: "flac", sampleRate: 44_100 },
      });
    } finally {
      await rm(linkedPath, { force: true });
    }
  });
});
