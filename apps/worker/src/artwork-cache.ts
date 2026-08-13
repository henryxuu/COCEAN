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
  const preferred = file.artwork[0];
  if (!preferred?.sha256) return emptyArtwork();
  const directory = join(cacheRoot, "artwork");
  await mkdir(directory, { recursive: true });
  const extension = extensionFor(preferred);
  const target = join(directory, `${preferred.sha256}${extension}`);
  if (!(await containsExpectedArtwork(target, preferred.sha256))) {
    const temporary = join(
      directory,
      `.${preferred.sha256}.${randomUUID()}.tmp`,
    );
    try {
      if (preferred.source === "SIDECAR" && preferred.path) {
        await copyFile(preferred.path, temporary);
      } else if (preferred.source === "EMBEDDED") {
        const metadata = await parseFile(file.absolutePath, {
          duration: false,
          skipCovers: false,
        });
        const picture = metadata.common.picture?.find(
          (candidate) => sha256(candidate.data) === preferred.sha256,
        );
        if (!picture)
          throw new Error("preferred embedded artwork no longer exists");
        await writeFile(temporary, picture.data, { flag: "wx" });
      } else {
        throw new Error("preferred artwork source cannot be cached");
      }
      if (!(await containsExpectedArtwork(temporary, preferred.sha256)))
        throw new Error("artwork changed after scan checksum was recorded");
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return {
    source: preferred.source,
    url: `/api/v1/artwork/${preferred.sha256}`,
    mimeType: preferred.mimeType,
    width: preferred.width,
    height: preferred.height,
  };
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
