import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtworkValidationError,
  fetchCoverArtArchiveFront,
  validateAndStoreArtwork,
} from "./artwork.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("governed artwork assets", () => {
  it("uses real ffprobe decoding before storing a content-addressed PNG", async () => {
    const root = await artworkFixtureRoot();
    const source = join(root, "fixture.png");
    await execFileAsync("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=32x24",
      "-frames:v",
      "1",
      source,
    ]);
    const bytes = await readFile(source);
    const stored = await validateAndStoreArtwork({
      bytes,
      declaredMimeType: "image/png",
      cacheRoot: root,
      ffprobePath: "ffprobe",
    });
    expect(stored).toEqual(
      expect.objectContaining({
        mimeType: "image/png",
        width: 32,
        height: 24,
        sizeBytes: bytes.length,
      }),
    );
    expect(await readFile(stored.path)).toEqual(bytes);
    const replay = await validateAndStoreArtwork({
      bytes,
      declaredMimeType: "image/png",
      cacheRoot: root,
      ffprobePath: "ffprobe",
    });
    expect(replay.path).toBe(stored.path);
  });

  it("rejects MIME spoofing and corrupt signed files without keeping an asset", async () => {
    const root = await artworkFixtureRoot();
    await expect(
      validateAndStoreArtwork({
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
        declaredMimeType: "image/png",
        cacheRoot: root,
        ffprobePath: "ffprobe",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARTWORK_FILE" });
    await expect(
      validateAndStoreArtwork({
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
        declaredMimeType: "image/jpeg",
        cacheRoot: root,
        ffprobePath: "ffprobe",
      }),
    ).rejects.toBeInstanceOf(ArtworkValidationError);
    await expect(
      validateAndStoreArtwork({
        bytes: Buffer.alloc(20 * 1024 * 1024 + 1),
        declaredMimeType: "image/png",
        cacheRoot: root,
        ffprobePath: "ffprobe",
      }),
    ).rejects.toMatchObject({
      code: "ARTWORK_TOO_LARGE",
      statusCode: 413,
    });
  });

  it("follows only bounded CAA/archive.org HTTPS redirects and caps bytes", async () => {
    const calls: string[] = [];
    const fetch = async (input: URL | RequestInfo) => {
      const url = String(input);
      calls.push(url);
      if (calls.length === 1)
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://archive.org/download/release/front.png",
          },
        });
      return new Response(Buffer.from("image"), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "5" },
      });
    };
    const result = await fetchCoverArtArchiveFront({
      releaseId: "123e4567-e89b-42d3-a456-426614174000",
      contact: "https://example.test/cocean",
      timeoutMs: 1_000,
      fetch: fetch as typeof globalThis.fetch,
    });
    expect(result.sourceUrl).toBe(
      "https://archive.org/download/release/front.png",
    );
    expect(result.bytes.toString()).toBe("image");

    await expect(
      fetchCoverArtArchiveFront({
        releaseId: "123e4567-e89b-42d3-a456-426614174000",
        contact: "https://example.test/cocean",
        timeoutMs: 1_000,
        fetch: (async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/private.png" },
          })) as typeof globalThis.fetch,
      }),
    ).rejects.toMatchObject({ code: "ARTWORK_SOURCE_UNAVAILABLE" });
  });
});

async function artworkFixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cocean-artwork-test-"));
  temporaryRoots.push(root);
  return root;
}
