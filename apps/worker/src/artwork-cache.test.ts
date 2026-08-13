import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObservedMediaFile } from "@cocean/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { cachePreferredArtwork } from "./artwork-cache.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("artwork cache integrity", () => {
  it("publishes a sidecar atomically only after its checksum is verified", async () => {
    const directory = await temporaryDirectory();
    const sidecar = join(directory, "cover.jpg");
    const cache = join(directory, "cache");
    const bytes = Buffer.from("verified-cover");
    const hash = sha256(bytes);
    await writeFile(sidecar, bytes);

    const result = await cachePreferredArtwork(observed(sidecar, hash), cache);

    expect(result.url).toBe(`/api/v1/artwork/${hash}`);
    expect(await readFile(join(cache, "artwork", `${hash}.jpg`))).toEqual(
      bytes,
    );
    expect(
      (await readdir(join(cache, "artwork"))).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  it("rejects a sidecar changed after discovery and leaves no cache artifact", async () => {
    const directory = await temporaryDirectory();
    const sidecar = join(directory, "cover.jpg");
    const cache = join(directory, "cache");
    await writeFile(sidecar, "new-and-unverified-cover");
    const expected = sha256(Buffer.from("old-observed-cover"));

    await expect(
      cachePreferredArtwork(observed(sidecar, expected), cache),
    ).rejects.toThrow(/changed after scan checksum/);
    expect(await readdir(join(cache, "artwork"))).toEqual([]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cocean-cache-artwork-"));
  temporaryDirectories.push(directory);
  return directory;
}

function observed(path: string, artworkSha256: string): ObservedMediaFile {
  return {
    absolutePath: join(path, "..", "01 Track.flac"),
    relativePath: "Artist/Album/01 Track.flac",
    extension: ".flac",
    sizeBytes: 1,
    modifiedAtMs: 1,
    fileSha256: "0".repeat(64),
    audio: {
      kind: "PCM",
      codec: "flac",
      container: "flac",
      lossless: true,
      bitDepth: 16,
      sampleRate: 44_100,
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
      year: null,
      date: null,
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
    artwork: [
      {
        source: "SIDECAR",
        path,
        mimeType: "image/jpeg",
        width: null,
        height: null,
        bytes: null,
        sha256: artworkSha256,
        kind: "Front Cover",
      },
    ],
    warnings: [],
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
