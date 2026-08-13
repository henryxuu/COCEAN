import { realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import type { ObservedMediaFile } from "@cocean/contracts";
import { parseFile } from "music-metadata";

import {
  discoverSidecarArtwork,
  extractEmbeddedArtwork,
  rankArtworkCandidates,
} from "./artwork.js";
import {
  ensureMediaScanError,
  mapFileSystemError,
  mapMetadataError,
  MediaScanError,
  throwIfAborted,
} from "./errors.js";
import { sha256File } from "./file-hash.js";
import { runFfprobe } from "./ffprobe.js";
import { normalizeMediaFile } from "./normalize.js";
import type { MediaScanOutcome, ScanMediaFileOptions } from "./types.js";

const DEFAULT_FFPROBE_TIMEOUT_MS = 30_000;

// ffprobe identifies still images by their demuxer rather than by the source
// filename. Keep this list deliberately narrower than video codecs: an MP4
// containing only video has no usable audio, but it is not necessarily a
// cover image accidentally named like an audio file.
const STILL_IMAGE_FORMAT_NAMES = new Set([
  "apng",
  "gif",
  "image2",
  "image2pipe",
  "jpeg_pipe",
  "jpegls_pipe",
  "jpegxl_pipe",
  "png_pipe",
  "webp_pipe",
]);

export const SUPPORTED_AUDIO_EXTENSIONS = Object.freeze([
  ".aac",
  ".ac3",
  ".aif",
  ".aiff",
  ".aifc",
  ".ape",
  ".asf",
  ".bwf",
  ".dff",
  ".dsf",
  ".eac3",
  ".flac",
  ".m4a",
  ".m4b",
  ".m4pa",
  ".m4r",
  ".m2a",
  ".mka",
  ".mp2",
  ".mp3",
  ".mp4",
  ".mpc",
  ".oga",
  ".ogg",
  ".opus",
  ".spx",
  ".tak",
  ".tta",
  ".wav",
  ".wave",
  ".wma",
  ".wv",
  ".wvp",
  ".3gp",
] as const);

// These extensions are recognizable as audio media or audio-disc containers,
// but the current parser cannot establish trustworthy per-track facts. Workers
// count and report them instead of silently pretending they are not present.
export const KNOWN_UNSUPPORTED_AUDIO_EXTENSIONS = Object.freeze([
  ".aa",
  ".aax",
  ".aob",
  ".au",
  ".caf",
  ".dts",
  ".dtshd",
  ".iso",
  ".mlp",
  ".oma",
  ".ra",
  ".rm",
  ".sacd",
  ".snd",
  ".thd",
  ".vob",
] as const);

const SUPPORTED_EXTENSION_SET = new Set<string>(SUPPORTED_AUDIO_EXTENSIONS);
const KNOWN_UNSUPPORTED_EXTENSION_SET = new Set<string>(
  KNOWN_UNSUPPORTED_AUDIO_EXTENSIONS,
);

export type AudioPathClassification =
  "SUPPORTED" | "KNOWN_UNSUPPORTED" | "NON_AUDIO";

/**
 * Scans one existing audio file. The implementation opens files read-only and
 * never renames, moves, tags, touches, or creates anything beside the source.
 */
export async function scanMediaFile(
  inputPath: string,
  options: ScanMediaFileOptions = {},
): Promise<ObservedMediaFile> {
  if (!inputPath.trim()) {
    throw new MediaScanError("文件路径不能为空", {
      code: "INVALID_ARGUMENT",
      stage: "validate",
      recoverable: false,
    });
  }

  const absolutePath = resolve(inputPath);
  throwIfAborted(options.signal, absolutePath, "validate");

  // Reject lexical traversal before touching a path outside the configured root.
  const rootPath = resolve(options.rootPath ?? dirname(absolutePath));
  const relativePath = calculateRelativePath(absolutePath, rootPath);

  const timeoutMs = options.ffprobeTimeoutMs ?? DEFAULT_FFPROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new MediaScanError("ffprobeTimeoutMs 必须是正整数", {
      code: "INVALID_ARGUMENT",
      stage: "validate",
      filePath: absolutePath,
      recoverable: false,
      details: { ffprobeTimeoutMs: timeoutMs },
    });
  }

  let rootStat;
  try {
    rootStat = await stat(rootPath);
  } catch (error) {
    throw mapFileSystemError(error, rootPath, "stat");
  }
  if (!rootStat.isDirectory()) {
    throw new MediaScanError("曲库根路径不是目录", {
      code: "INVALID_ARGUMENT",
      stage: "validate",
      filePath: absolutePath,
      recoverable: false,
      details: { rootPath },
    });
  }

  let canonicalRootPath: string;
  let canonicalFilePath: string;
  try {
    [canonicalRootPath, canonicalFilePath] = await Promise.all([
      realpath(rootPath),
      realpath(absolutePath),
    ]);
  } catch (error) {
    throw mapFileSystemError(error, absolutePath, "stat");
  }
  assertPathInsideRoot(
    canonicalFilePath,
    canonicalRootPath,
    absolutePath,
    rootPath,
  );

  let fileStat;
  try {
    // Re-stat the canonical target so later parser calls and facts refer to the
    // same path even if an input symlink is concurrently replaced.
    fileStat = await stat(canonicalFilePath);
  } catch (error) {
    throw mapFileSystemError(error, absolutePath, "stat");
  }
  if (!fileStat.isFile()) {
    throw new MediaScanError("扫描路径不是普通文件", {
      code: "PATH_NOT_FILE",
      stage: "stat",
      filePath: absolutePath,
      recoverable: true,
    });
  }

  const metadataPromise = parseFile(canonicalFilePath, {
    duration: true,
    skipCovers: false,
  }).catch((error: unknown) => {
    throw mapMetadataError(error, absolutePath);
  });
  const probePromise = runFfprobe(canonicalFilePath, {
    executable: options.ffprobePath ?? "ffprobe",
    timeoutMs,
    reportedFilePath: absolutePath,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const sidecarPromise = discoverSidecarArtwork(
    absolutePath,
    options.signal,
    rootPath,
  );
  const fileHashPromise = sha256File(canonicalFilePath, options.signal);

  const [[metadataResult, probeResult, fileHashResult], sidecar] =
    await Promise.all([
      Promise.allSettled([metadataPromise, probePromise, fileHashPromise]),
      sidecarPromise,
    ]);
  throwIfAborted(options.signal, absolutePath, "normalize");

  // Keep corrupt-file errors deterministic when both parsers reject. ffprobe
  // is authoritative for technical facts, so its classified error wins.
  if (probeResult.status === "rejected") throw probeResult.reason;
  const probe = probeResult.value;

  // A successful probe with no audio stream is stronger content evidence than
  // a metadata decoder error. In particular, music-metadata may interpret a
  // JPEG named .flac/.dsf as a malformed FourCC and report FieldDecodingError;
  // report the actual extension/content mismatch instead.
  if (!probe.audioStream) {
    throw missingAudioStreamError(probe, absolutePath);
  }
  if (metadataResult.status === "rejected") throw metadataResult.reason;
  if (fileHashResult.status === "rejected") throw fileHashResult.reason;
  const metadata = metadataResult.value;
  const fileSha256 = fileHashResult.value;

  let finalStat;
  try {
    finalStat = await stat(canonicalFilePath);
  } catch (error) {
    throw mapFileSystemError(error, absolutePath, "stat");
  }
  if (
    finalStat.size !== fileStat.size ||
    Math.abs(finalStat.mtimeMs - fileStat.mtimeMs) > 0.001
  ) {
    throw new MediaScanError("扫描期间音频文件发生变化", {
      code: "FILE_CHANGED_DURING_SCAN",
      stage: "hash",
      filePath: absolutePath,
      recoverable: true,
    });
  }

  const metadataRecord = toRecord(metadata);
  const common = recordProperty(metadataRecord, "common");
  const embeddedArtwork = extractEmbeddedArtwork(common);

  return normalizeMediaFile({
    absolutePath,
    relativePath,
    sizeBytes: fileStat.size,
    modifiedAtMs: fileStat.mtimeMs,
    fileSha256,
    metadata: metadataRecord,
    probe,
    artwork: rankArtworkCandidates([...embeddedArtwork, ...sidecar.candidates]),
    warnings: sidecar.warnings,
  });
}

/**
 * Sequential async iterator used by workers. One bad file is returned as an
 * outcome and does not abort the rest of a library; cancellation stops cleanly.
 */
export async function* scanMediaFiles(
  inputPaths: Iterable<string> | AsyncIterable<string>,
  options: ScanMediaFileOptions = {},
): AsyncGenerator<MediaScanOutcome> {
  for await (const inputPath of inputPaths) {
    const absolutePath = resolve(inputPath);
    try {
      const value = await scanMediaFile(absolutePath, options);
      yield { ok: true, value };
    } catch (error) {
      const scanError = ensureMediaScanError(error, absolutePath, "normalize");
      yield { ok: false, filePath: absolutePath, error: scanError.toJSON() };
      if (scanError.code === "ABORTED") return;
    }
  }
}

export function isSupportedAudioPath(filePath: string): boolean {
  return SUPPORTED_EXTENSION_SET.has(extname(filePath).toLowerCase());
}

export function classifyAudioPath(filePath: string): AudioPathClassification {
  const extension = extname(filePath).toLowerCase();
  if (SUPPORTED_EXTENSION_SET.has(extension)) return "SUPPORTED";
  if (KNOWN_UNSUPPORTED_EXTENSION_SET.has(extension))
    return "KNOWN_UNSUPPORTED";
  return "NON_AUDIO";
}

function missingAudioStreamError(
  probe: Awaited<ReturnType<typeof runFfprobe>>,
  filePath: string,
): MediaScanError {
  const detectedFormat = stringProperty(probe.format, "format_name");
  const imageFormat = detectedFormat
    ?.toLowerCase()
    .split(",")
    .map((formatName) => formatName.trim())
    .find((formatName) => STILL_IMAGE_FORMAT_NAMES.has(formatName));

  if (isSupportedAudioPath(filePath) && imageFormat) {
    return new MediaScanError("文件扩展名指向音频，但实际内容是静态图片", {
      code: "CONTENT_TYPE_MISMATCH",
      stage: "probe",
      filePath,
      recoverable: true,
      details: {
        extension: extname(filePath).toLowerCase(),
        detectedFormat: imageFormat,
      },
    });
  }

  return new MediaScanError("文件中没有可识别的音频流", {
    code: "UNSUPPORTED_MEDIA",
    stage: "probe",
    filePath,
    recoverable: true,
    ...(detectedFormat ? { details: { detectedFormat } } : {}),
  });
}

function calculateRelativePath(absolutePath: string, rootPath: string): string {
  const candidate = relative(rootPath, absolutePath);
  if (
    candidate === ".." ||
    candidate.startsWith(`..${sep}`) ||
    isAbsolute(candidate)
  ) {
    throw new MediaScanError("音频文件不在配置的曲库根目录内", {
      code: "PATH_OUTSIDE_ROOT",
      stage: "validate",
      filePath: absolutePath,
      recoverable: false,
      details: { rootPath },
    });
  }
  return (candidate || basename(absolutePath)).split(sep).join("/");
}

function assertPathInsideRoot(
  canonicalFilePath: string,
  canonicalRootPath: string,
  reportedFilePath: string,
  reportedRootPath: string,
): void {
  const candidate = relative(canonicalRootPath, canonicalFilePath);
  if (
    candidate === ".." ||
    candidate.startsWith(`..${sep}`) ||
    isAbsolute(candidate)
  ) {
    throw new MediaScanError("音频文件的符号链接目标不在曲库根目录内", {
      code: "PATH_OUTSIDE_ROOT",
      stage: "validate",
      filePath: reportedFilePath,
      recoverable: false,
      details: { rootPath: reportedRootPath },
    });
  }
}

function toRecord(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function recordProperty(
  value: Readonly<Record<string, unknown>>,
  property: string,
): Readonly<Record<string, unknown>> {
  const candidate = value[property];
  return isRecord(candidate) ? candidate : {};
}

function stringProperty(
  value: Readonly<Record<string, unknown>> | null,
  property: string,
): string | null {
  if (!value) return null;
  const candidate = value[property];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
