import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { extname, join } from "node:path";
import type {
  Artwork,
  ArtworkCandidate,
  ObservedMediaFile,
} from "@cocean/contracts";
import { parseFile } from "music-metadata";

export async function cachePreferredArtwork(
  file: ObservedMediaFile,
  cacheRoot: string,
): Promise<Artwork> {
  const result = await cacheArtworkCandidates(file, cacheRoot);
  if (file.artwork[0]?.sha256 && result.artwork.source === "NONE")
    throw new Error("artwork changed after scan checksum was recorded");
  return result.artwork;
}

export async function cacheArtworkCandidates(
  file: ObservedMediaFile,
  cacheRoot: string,
): Promise<{
  artwork: Artwork;
  candidates: ArtworkCandidate[];
  failed: number;
}> {
  const directory = join(cacheRoot, "artwork");
  await mkdir(directory, { recursive: true });
  const embeddedMissing = (
    await Promise.all(
      file.artwork
        .filter(
          (candidate) => candidate.source === "EMBEDDED" && candidate.sha256,
        )
        .map(async (candidate) =>
          containsExpectedArtwork(
            join(directory, `${candidate.sha256}${extensionFor(candidate)}`),
            candidate.sha256!,
          ),
        ),
    )
  ).some((cached) => !cached);
  const embedded = embeddedMissing
    ? await parseFile(file.absolutePath, { duration: false, skipCovers: false })
    : null;
  const successful: ArtworkCandidate[] = [];
  let failed = 0;
  for (const candidate of file.artwork) {
    if (!candidate.sha256) continue;
    try {
      await cacheCandidate(candidate, directory, embedded);
      successful.push(candidate);
    } catch {
      failed += 1;
    }
  }
  const preferred = successful[0];
  if (!preferred?.sha256)
    return { artwork: emptyArtwork(), candidates: [], failed };
  return {
    artwork: {
      source: preferred.source,
      url: `/api/v1/artwork/${preferred.sha256}`,
      mimeType: preferred.mimeType,
      width: preferred.width,
      height: preferred.height,
    },
    candidates: successful,
    failed,
  };
}

async function cacheCandidate(
  candidate: ArtworkCandidate,
  directory: string,
  embedded: Awaited<ReturnType<typeof parseFile>> | null,
): Promise<void> {
  if (!candidate.sha256) throw new Error("artwork checksum is missing");
  const extension = extensionFor(candidate);
  const target = join(directory, `${candidate.sha256}${extension}`);
  if (await containsExpectedArtwork(target, candidate.sha256)) return;
  const temporary = join(directory, `.${candidate.sha256}.${randomUUID()}.tmp`);
  try {
    if (candidate.source === "SIDECAR" && candidate.path) {
      await copyFile(candidate.path, temporary);
    } else if (candidate.source === "EMBEDDED") {
      const picture = embedded?.common.picture?.find(
        (item) => sha256(item.data) === candidate.sha256,
      );
      if (!picture) throw new Error("embedded artwork no longer exists");
      await writeFile(temporary, picture.data, { flag: "wx" });
    } else {
      throw new Error("artwork source cannot be cached");
    }
    if (!(await containsExpectedArtwork(temporary, candidate.sha256)))
      throw new Error("artwork changed after scan checksum was recorded");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function containsExpectedArtwork(
  path: string,
  expectedSha256: string,
): Promise<boolean> {
  try {
    return sha256(await readFile(path)) === expectedSha256;
  } catch {
    return false;
  }
}

function extensionFor(candidate: ArtworkCandidate): string {
  const fromPath = candidate.path ? extname(candidate.path).toLowerCase() : "";
  if (
    [
      ".avif",
      ".bmp",
      ".gif",
      ".jpg",
      ".jpeg",
      ".png",
      ".tif",
      ".tiff",
      ".webp",
    ].includes(fromPath)
  )
    return fromPath === ".jpeg" ? ".jpg" : fromPath;
  if (candidate.mimeType === "image/avif") return ".avif";
  if (candidate.mimeType === "image/bmp") return ".bmp";
  if (candidate.mimeType === "image/png") return ".png";
  if (candidate.mimeType === "image/tiff") return ".tiff";
  if (candidate.mimeType === "image/webp") return ".webp";
  if (candidate.mimeType === "image/gif") return ".gif";
  return ".jpg";
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function emptyArtwork(): Artwork {
  return {
    source: "NONE",
    url: null,
    mimeType: null,
    width: null,
    height: null,
  };
}
