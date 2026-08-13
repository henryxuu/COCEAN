import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverSidecarArtwork,
  extractEmbeddedArtwork,
  rankArtworkCandidates,
} from "../src/artwork.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("discoverSidecarArtwork", () => {
  it("ranks an embedded Front Cover ahead of other embedded pictures", () => {
    const candidates = extractEmbeddedArtwork({
      picture: [
        {
          type: "Cover (back)",
          format: "image/jpeg",
          data: Buffer.from("back"),
        },
        {
          type: "Cover (front)",
          format: "image/jpeg",
          data: Buffer.from("front"),
        },
      ],
    });
    expect(candidates.map(({ kind }) => kind)).toEqual([
      "Front Cover",
      "Back Cover",
    ]);
  });

  it("ranks a sidecar front above embedded back or media artwork", () => {
    const embedded = extractEmbeddedArtwork({
      picture: [
        {
          type: "Cover (back)",
          format: "image/jpeg",
          data: Buffer.from("back"),
        },
        {
          type: "Media",
          format: "image/jpeg",
          data: Buffer.from("disc"),
        },
      ],
    });
    const sidecar = {
      source: "SIDECAR" as const,
      path: "/music/Artist/Album/cover.jpg",
      mimeType: "image/jpeg",
      width: 1000,
      height: 1000,
      bytes: 100,
      sha256: "0".repeat(64),
      kind: "Front Cover",
    };

    expect(rankArtworkCandidates([...embedded, sidecar])[0]).toBe(sidecar);
  });

  it("finds known album artwork names, orders them, and ignores artist images", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-artwork-"));
    temporaryDirectories.push(directory);
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await Promise.all([
      writeFile(join(directory, "cover.png"), onePixelPng),
      writeFile(join(directory, "back.png"), onePixelPng),
      writeFile(join(directory, "artist.png"), onePixelPng),
    ]);

    const result = await discoverSidecarArtwork(
      join(directory, "01 Track.flac"),
    );

    expect(result.warnings).toEqual([]);
    expect(
      result.candidates.map(({ path }) => path?.split("/").at(-1)),
    ).toEqual(["cover.png", "back.png"]);
    expect(result.candidates[0]).toMatchObject({
      source: "SIDECAR",
      mimeType: "image/png",
      width: 1,
      height: 1,
      kind: "Front Cover",
    });
    expect(result.candidates[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("finds an album-level cover for tracks stored in CD or Disc subfolders", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "cocean-artwork-multidisc-"),
    );
    temporaryDirectories.push(directory);
    const discDirectory = join(directory, "CD 1");
    await mkdir(discDirectory);
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(join(directory, "folder.png"), onePixelPng);

    const result = await discoverSidecarArtwork(
      join(discDirectory, "01 Track.flac"),
    );

    expect(result.candidates[0]).toMatchObject({
      source: "SIDECAR",
      kind: "Folder Cover",
    });
    expect(result.candidates[0]?.path).toBe(join(directory, "folder.png"));
  });

  it("prefers an album front cover over a disc-media image", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-artwork-priority-"));
    temporaryDirectories.push(directory);
    const discDirectory = join(directory, "Disc 02 - Stereo");
    await mkdir(discDirectory);
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await Promise.all([
      writeFile(join(directory, "cover.png"), onePixelPng),
      writeFile(join(discDirectory, "disc2.png"), onePixelPng),
    ]);

    const result = await discoverSidecarArtwork(
      join(discDirectory, "01 Track.flac"),
    );

    expect(result.candidates.map(({ path }) => path)).toEqual([
      join(directory, "cover.png"),
      join(discDirectory, "disc2.png"),
    ]);
  });

  it("does not mistake an artist-directory cover for album artwork", async () => {
    const artistDirectory = await mkdtemp(
      join(tmpdir(), "cocean-artist-artwork-"),
    );
    temporaryDirectories.push(artistDirectory);
    const albumDirectory = join(artistDirectory, "Album");
    await mkdir(albumDirectory);
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(join(artistDirectory, "cover.png"), onePixelPng);

    const result = await discoverSidecarArtwork(
      join(albumDirectory, "01 Track.flac"),
    );

    expect(result.candidates).toEqual([]);
  });

  it("does not cross the configured root to find a parent cover", async () => {
    const albumDirectory = await mkdtemp(join(tmpdir(), "cocean-boundary-"));
    temporaryDirectories.push(albumDirectory);
    const discDirectory = join(albumDirectory, "CD 1");
    await mkdir(discDirectory);
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(join(albumDirectory, "cover.png"), onePixelPng);

    const result = await discoverSidecarArtwork(
      join(discDirectory, "01 Track.flac"),
      undefined,
      discDirectory,
    );

    expect(result.candidates).toEqual([]);
  });
});
