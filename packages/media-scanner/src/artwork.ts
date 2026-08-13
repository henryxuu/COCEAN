import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { ArtworkCandidate } from "@cocean/contracts";

import type { ScanWarning } from "./types.js";

interface ArtworkDiscoveryResult {
  readonly candidates: readonly ArtworkCandidate[];
  readonly warnings: readonly ScanWarning[];
}

interface ImageInspection {
  readonly bytes: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
}

interface RankedArtwork {
  readonly priority: number;
  readonly candidate: ArtworkCandidate;
}

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

const MAX_IMAGE_HEADER_BYTES = 64 * 1024;

export function extractEmbeddedArtwork(
  common: Readonly<Record<string, unknown>>,
): ArtworkCandidate[] {
  const pictures = Array.isArray(common.picture) ? common.picture : [];
  const candidates: ArtworkCandidate[] = [];

  for (const picture of pictures) {
    if (!isRecord(picture)) continue;
    const data = toBuffer(picture.data);
    if (!data) continue;

    const dimensions = readImageDimensions(data);
    candidates.push({
      source: "EMBEDDED",
      path: null,
      mimeType: normalizeMimeType(asString(picture.format)),
      width: dimensions.width,
      height: dimensions.height,
      bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
      kind: normalizePictureKind(picture.type, asString(picture.description)),
    });
  }

  return candidates.sort(
    (left, right) =>
      embeddedArtworkPriority(left) - embeddedArtworkPriority(right),
  );
}

/**
 * Produces the single deterministic preference order used by album artwork
 * selection. A true embedded front cover remains first, but an album-folder
 * front/folder image outranks embedded media, back-cover, or unknown pictures.
 */
export function rankArtworkCandidates(
  candidates: readonly ArtworkCandidate[],
): ArtworkCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (left, right) =>
        artworkPriority(left.candidate) - artworkPriority(right.candidate) ||
        left.index - right.index,
    )
    .map(({ candidate }) => candidate);
}

function artworkPriority(candidate: ArtworkCandidate): number {
  if (candidate.source === "EMBEDDED" && candidate.kind === "Front Cover")
    return 0;
  if (candidate.source === "SIDECAR" && candidate.kind === "Front Cover")
    return 10;
  if (candidate.source === "SIDECAR" && candidate.kind === "Folder Cover")
    return 20;
  if (candidate.source === "EMBEDDED" && candidate.kind === "Media") return 30;
  if (candidate.source === "EMBEDDED" && candidate.kind === "Back Cover")
    return 40;
  if (candidate.source === "EMBEDDED") return 50;
  if (candidate.kind === "Back Cover") return 70;
  if (candidate.kind === "Media") return 80;
  return 90;
}

function embeddedArtworkPriority(candidate: ArtworkCandidate): number {
  if (candidate.kind === "Front Cover") return 0;
  if (candidate.kind === "Media") return 20;
  if (candidate.kind === "Back Cover") return 30;
  return 40;
}

export async function discoverSidecarArtwork(
  mediaFilePath: string,
  signal?: AbortSignal,
  boundaryRootPath?: string,
): Promise<ArtworkDiscoveryResult> {
  const mediaDirectory = dirname(mediaFilePath);
  const searchDirectories = [mediaDirectory];
  const parentAlbumDirectory = dirname(mediaDirectory);
  if (
    isDiscDirectory(basename(mediaDirectory)) &&
    (!boundaryRootPath ||
      isPathInsideRoot(parentAlbumDirectory, boundaryRootPath))
  ) {
    searchDirectories.push(parentAlbumDirectory);
  }
  const warnings: ScanWarning[] = [];
  const ranked: RankedArtwork[] = [];
  for (const [scopeIndex, albumDirectory] of searchDirectories.entries()) {
    let entries;
    try {
      entries = await readdir(albumDirectory, { withFileTypes: true });
    } catch (error) {
      warnings.push({
        code: "SIDECAR_DIRECTORY_UNREADABLE",
        message: `无法读取封面目录：${errorMessage(error)}`,
      });
      continue;
    }
    for (const entry of entries) {
      if (signal?.aborted) break;
      if (!entry.isFile()) continue;

      const extension = extname(entry.name).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension)) continue;

      const classification = classifySidecarName(
        basename(entry.name, extension),
      );
      if (!classification) continue;

      const artworkPath = join(albumDirectory, entry.name);
      try {
        const inspection = await inspectImageFile(artworkPath, signal);
        ranked.push({
          // Prefer a local name when semantics are equal, while still allowing
          // a parent album cover/front to outrank a disc/media image.
          priority: classification.priority + scopeIndex * 5,
          candidate: {
            source: "SIDECAR",
            path: artworkPath,
            mimeType: mimeTypeFromExtension(extension),
            width: inspection.width,
            height: inspection.height,
            bytes: inspection.bytes,
            sha256: inspection.sha256,
            kind: classification.kind,
          },
        });
      } catch (error) {
        warnings.push({
          code: "SIDECAR_ARTWORK_UNREADABLE",
          message: `无法读取封面 ${entry.name}：${errorMessage(error)}`,
        });
      }
    }
  }

  ranked.sort(
    (left, right) =>
      left.priority - right.priority ||
      (left.candidate.path ?? "").localeCompare(right.candidate.path ?? ""),
  );
  return { candidates: ranked.map(({ candidate }) => candidate), warnings };
}

function isDiscDirectory(name: string): boolean {
  return /^(?:cd|disc|disk|碟|盘)[ _.-]*0*\d{1,3}(?:[ _.-]+.*)?$/i.test(
    name.trim(),
  );
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = relative(resolve(rootPath), resolve(candidatePath));
  return !(
    candidate === ".." ||
    candidate.startsWith(`..${sep}`) ||
    isAbsolute(candidate)
  );
}

async function inspectImageFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<ImageInspection> {
  const hash = createHash("sha256");
  const headerChunks: Buffer[] = [];
  let headerBytes = 0;
  let bytes = 0;
  const stream = createReadStream(filePath, signal ? { signal } : undefined);

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    hash.update(buffer);

    if (headerBytes < MAX_IMAGE_HEADER_BYTES) {
      const remaining = MAX_IMAGE_HEADER_BYTES - headerBytes;
      const slice = buffer.subarray(0, Math.min(buffer.byteLength, remaining));
      headerChunks.push(slice);
      headerBytes += slice.byteLength;
    }
  }

  const dimensions = readImageDimensions(
    Buffer.concat(headerChunks, headerBytes),
  );
  return {
    bytes,
    sha256: hash.digest("hex"),
    width: dimensions.width,
    height: dimensions.height,
  };
}

function classifySidecarName(
  rawBaseName: string,
): { readonly kind: string; readonly priority: number } | null {
  const baseName = rawBaseName.trim().toLowerCase();
  if (/^(cover|front)(?:[-_. ]?\d+)?$/.test(baseName)) {
    return {
      kind: "Front Cover",
      priority: baseName.startsWith("cover") ? 10 : 20,
    };
  }
  if (/^folder(?:[-_. ]?\d+)?$/.test(baseName)) {
    return { kind: "Folder Cover", priority: 30 };
  }
  if (/^(album|jacket|poster)(?:[-_. ]?\d+)?$/.test(baseName)) {
    return { kind: "Front Cover", priority: 40 };
  }
  if (/^(back|rear)(?:[-_. ]?\d+)?$/.test(baseName)) {
    return { kind: "Back Cover", priority: 70 };
  }
  if (/^(disc|disk|cd|media)(?:[-_. ]?\d+)?$/.test(baseName)) {
    return { kind: "Media", priority: 80 };
  }
  return null;
}

function readImageDimensions(data: Buffer): {
  readonly width: number | null;
  readonly height: number | null;
} {
  if (
    data.byteLength >= 24 &&
    data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }

  if (
    data.byteLength >= 10 &&
    (data.subarray(0, 6).toString("ascii") === "GIF87a" ||
      data.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }

  if (
    data.byteLength >= 30 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP" &&
    data.subarray(12, 16).toString("ascii") === "VP8X"
  ) {
    return {
      width: 1 + readUInt24LE(data, 24),
      height: 1 + readUInt24LE(data, 27),
    };
  }

  if (data.byteLength >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.byteLength) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1];
      if (marker === undefined || marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const segmentLength = data.readUInt16BE(offset + 2);
      if (segmentLength < 2 || offset + segmentLength + 2 > data.byteLength)
        break;
      if (isJpegStartOfFrame(marker)) {
        return {
          width: data.readUInt16BE(offset + 7),
          height: data.readUInt16BE(offset + 5),
        };
      }
      offset += segmentLength + 2;
    }
  }

  return { width: null, height: null };
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function readUInt24LE(data: Buffer, offset: number): number {
  return (
    (data[offset] ?? 0) |
    ((data[offset + 1] ?? 0) << 8) |
    ((data[offset + 2] ?? 0) << 16)
  );
}

function normalizePictureKind(
  type: unknown,
  description: string | null,
): string | null {
  const textType = asString(type)?.toLowerCase() ?? null;
  if (textType) {
    if (textType.includes("front")) return "Front Cover";
    if (textType.includes("back")) return "Back Cover";
    if (textType.includes("media") || textType.includes("disc")) return "Media";
    if (textType.includes("leaflet") || textType.includes("booklet"))
      return "Leaflet";
    if (textType.includes("artist")) return "Artist";
    if (textType.includes("logo")) return "Logo";
  }
  const numericType = typeof type === "number" ? type : Number.NaN;
  const knownKinds: Readonly<Record<number, string>> = {
    0: "Other",
    3: "Front Cover",
    4: "Back Cover",
    5: "Leaflet",
    6: "Media",
    7: "Lead Artist",
    8: "Artist",
    10: "Band",
    11: "Composer",
    18: "Illustration",
    19: "Band Logo",
    20: "Publisher Logo",
  };
  if (Number.isInteger(numericType) && knownKinds[numericType])
    return knownKinds[numericType];
  return description;
}

function normalizeMimeType(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith("image/")) return normalized;
  if (normalized === "jpg" || normalized === "jpeg") return "image/jpeg";
  if (normalized === "tif" || normalized === "tiff") return "image/tiff";
  if (["avif", "bmp", "gif", "png", "webp"].includes(normalized))
    return `image/${normalized}`;
  return normalized;
}

function mimeTypeFromExtension(extension: string): string | null {
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".tif" || extension === ".tiff") return "image/tiff";
  const withoutDot = extension.slice(1);
  return withoutDot ? `image/${withoutDot}` : null;
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
