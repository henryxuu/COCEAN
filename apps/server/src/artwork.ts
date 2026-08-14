import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const maximumArtworkBytes = 20 * 1024 * 1024;
const maximumArtworkDimension = 12_000;
const maximumArtworkPixels = 50_000_000;
const allowedRedirectHosts = new Set(["coverartarchive.org", "archive.org"]);

export type GovernedArtworkMime = "image/jpeg" | "image/png" | "image/webp";

export interface StoredArtworkAsset {
  sha256: string;
  mimeType: GovernedArtworkMime;
  width: number;
  height: number;
  sizeBytes: number;
  extension: ".jpg" | ".png" | ".webp";
  path: string;
}

export class ArtworkValidationError extends Error {
  constructor(
    public readonly code:
      | "INVALID_ARTWORK_FILE"
      | "ARTWORK_TOO_LARGE"
      | "ARTWORK_SOURCE_UNAVAILABLE",
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ArtworkValidationError";
  }
}

export async function validateAndStoreArtwork(input: {
  bytes: Buffer;
  declaredMimeType: string;
  cacheRoot: string;
  ffprobePath: string;
}): Promise<StoredArtworkAsset> {
  if (!input.bytes.length) throw invalidArtwork("上传的封面是空文件");
  if (input.bytes.length > maximumArtworkBytes)
    throw new ArtworkValidationError(
      "ARTWORK_TOO_LARGE",
      "封面文件不能超过 20 MiB",
      413,
    );
  const mimeType = detectArtworkMime(input.bytes);
  if (!mimeType || mimeType !== input.declaredMimeType)
    throw invalidArtwork(
      "封面 MIME 与真实文件格式不一致，仅支持 JPEG、PNG、WebP",
    );
  const extension = artworkExtension(mimeType);
  const artworkRoot = resolve(input.cacheRoot, "artwork");
  const incomingRoot = join(artworkRoot, ".incoming");
  await mkdir(incomingRoot, { recursive: true });
  const temporaryPath = join(incomingRoot, `${randomUUID()}${extension}`);
  try {
    await writeFile(temporaryPath, input.bytes, { flag: "wx", mode: 0o600 });
    const dimensions = await probeArtwork(
      temporaryPath,
      mimeType,
      input.ffprobePath,
    );
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const target = join(artworkRoot, `${sha256}${extension}`);
    try {
      const existing = await readFile(target);
      if (
        existing.length !== input.bytes.length ||
        createHash("sha256").update(existing).digest("hex") !== sha256
      )
        throw invalidArtwork("封面缓存中的同名资产校验失败");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await rename(temporaryPath, target);
    }
    return {
      sha256,
      mimeType,
      width: dimensions.width,
      height: dimensions.height,
      sizeBytes: input.bytes.length,
      extension,
      path: target,
    };
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function fetchCoverArtArchiveFront(input: {
  releaseId: string;
  contact: string;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}): Promise<{ bytes: Buffer; mimeType: string; sourceUrl: string }> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.releaseId,
    )
  )
    throw invalidArtwork("MusicBrainz Release ID 无效");
  const fetchImpl = input.fetch ?? globalThis.fetch;
  let url = new URL(
    `https://coverartarchive.org/release/${input.releaseId}/front-1200`,
  );
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    assertAllowedArtworkUrl(url);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        headers: {
          accept: "image/jpeg,image/png,image/webp",
          "user-agent": `COCEAN/0.1.0 (${input.contact})`,
        },
        signal: AbortSignal.timeout(input.timeoutMs),
      });
    } catch (error) {
      throw new ArtworkValidationError(
        "ARTWORK_SOURCE_UNAVAILABLE",
        error instanceof Error
          ? `Cover Art Archive 请求失败：${error.message}`
          : "Cover Art Archive 请求失败",
        502,
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirect === 4)
        throw sourceUnavailable("Cover Art Archive 重定向无效或次数过多");
      url = new URL(location, url);
      continue;
    }
    if (response.status === 404)
      throw new ArtworkValidationError(
        "ARTWORK_SOURCE_UNAVAILABLE",
        "已确认的 MusicBrainz Release 没有 CAA 正面封面",
        404,
      );
    if (!response.ok)
      throw sourceUnavailable(`Cover Art Archive 返回 ${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maximumArtworkBytes)
      throw new ArtworkValidationError(
        "ARTWORK_TOO_LARGE",
        "Cover Art Archive 封面超过 20 MiB",
        413,
      );
    return {
      bytes: await readResponseWithLimit(response, maximumArtworkBytes),
      mimeType: response.headers.get("content-type")?.split(";", 1)[0] ?? "",
      sourceUrl: url.toString(),
    };
  }
  throw sourceUnavailable("Cover Art Archive 重定向次数过多");
}

function detectArtworkMime(bytes: Buffer): GovernedArtworkMime | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}

async function probeArtwork(
  path: string,
  mimeType: GovernedArtworkMime,
  ffprobePath: string,
): Promise<{ width: number; height: number }> {
  const streams = await runArtworkProbe(ffprobePath, [
    "-v",
    "error",
    "-select_streams",
    "v",
    "-show_entries",
    "stream=codec_name,width,height,nb_frames",
    "-of",
    "json",
    path,
  ]);
  if (streams.length !== 1) throw invalidArtwork("封面必须是单张静态图片");
  const stream = streams[0]!;
  const expectedCodec = {
    "image/jpeg": "mjpeg",
    "image/png": "png",
    "image/webp": "webp",
  }[mimeType];
  const width = Number(stream.width);
  const height = Number(stream.height);
  if (
    stream.codec_name !== expectedCodec ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    throw invalidArtwork("封面格式或尺寸无效");
  if (
    width > maximumArtworkDimension ||
    height > maximumArtworkDimension ||
    width * height > maximumArtworkPixels
  )
    throw new ArtworkValidationError(
      "ARTWORK_TOO_LARGE",
      "封面宽高不能超过 12,000 像素，且总像素不能超过 50 MP",
      413,
    );
  const decoded = await runArtworkProbe(ffprobePath, [
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v",
    "-show_entries",
    "stream=nb_read_frames",
    "-of",
    "json",
    path,
  ]);
  const frames = Number(decoded[0]?.nb_read_frames ?? stream.nb_frames ?? 1);
  if (decoded.length !== 1 || !Number.isInteger(frames) || frames !== 1)
    throw invalidArtwork("封面必须是单张可完整解码的静态图片");
  return { width, height };
}

async function runArtworkProbe(
  ffprobePath: string,
  arguments_: string[],
): Promise<Array<Record<string, unknown>>> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(ffprobePath, arguments_, {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    }));
  } catch {
    throw invalidArtwork("封面无法被真实解码，文件可能已损坏");
  }
  try {
    return (
      (
        JSON.parse(stdout) as {
          streams?: Array<Record<string, unknown>>;
        }
      ).streams ?? []
    );
  } catch {
    throw invalidArtwork("封面探测结果无效");
  }
}

async function readResponseWithLimit(
  response: Response,
  limit: number,
): Promise<Buffer> {
  if (!response.body) throw sourceUnavailable("Cover Art Archive 返回空响应");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ArtworkValidationError(
        "ARTWORK_TOO_LARGE",
        "Cover Art Archive 封面超过 20 MiB",
        413,
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function assertAllowedArtworkUrl(url: URL): void {
  const hostname = url.hostname.toLowerCase();
  const allowed =
    allowedRedirectHosts.has(hostname) || hostname.endsWith(".archive.org");
  if (
    url.protocol !== "https:" ||
    !allowed ||
    isIP(hostname) !== 0 ||
    hostname === "localhost"
  )
    throw sourceUnavailable("Cover Art Archive 返回了不允许的下载地址");
}

function artworkExtension(
  mimeType: GovernedArtworkMime,
): StoredArtworkAsset["extension"] {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  return ".jpg";
}

function invalidArtwork(message: string): ArtworkValidationError {
  return new ArtworkValidationError("INVALID_ARTWORK_FILE", message, 400);
}

function sourceUnavailable(message: string): ArtworkValidationError {
  return new ArtworkValidationError("ARTWORK_SOURCE_UNAVAILABLE", message, 502);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
