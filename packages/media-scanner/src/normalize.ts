import { createHash } from "node:crypto";
import { extname } from "node:path";

import type {
  ArtworkCandidate,
  AudioSpec,
  ObservedMediaFile,
  ObservedRawTag,
  ObservedTag,
} from "@cocean/contracts";

import type { FfprobeDocument } from "./ffprobe.js";
import type { ScanWarning } from "./types.js";

export interface NormalizeMediaFileInput {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
  readonly fileSha256: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly probe: FfprobeDocument;
  readonly artwork: readonly ArtworkCandidate[];
  readonly warnings?: readonly ScanWarning[];
}

interface AudioNormalizationResult {
  readonly audio: AudioSpec;
  readonly durationSeconds: number | null;
  readonly warnings: readonly ScanWarning[];
}

const LOSSLESS_CODECS = new Set([
  "alac",
  "ape",
  "dsd_lsbf",
  "dsd_lsbf_planar",
  "dsd_msbf",
  "dsd_msbf_planar",
  "flac",
  "mlp",
  "shorten",
  "tak",
  "truehd",
  "tta",
  "wavpack",
]);

const LOSSY_CODECS = new Set([
  "aac",
  "ac3",
  "dts",
  "eac3",
  "mp2",
  "mp3",
  "opus",
  "vorbis",
  "wma",
  "wmav1",
  "wmav2",
  "wmavoice",
]);

const DXD_SAMPLE_RATES = new Set([352_800, 384_000, 705_600, 768_000]);

export function normalizeMediaFile(
  input: NormalizeMediaFileInput,
): ObservedMediaFile {
  const format = recordProperty(input.metadata, "format");
  const common = recordProperty(input.metadata, "common");
  const normalizedAudio = normalizeAudio(
    format,
    common,
    input.probe,
    extname(input.absolutePath).toLowerCase(),
  );
  const rawTags = normalizeRawTags(recordProperty(input.metadata, "native"));
  const tags = preferReliableNativeTags(
    normalizeTags(common),
    rawTags,
    input.probe,
  );

  return {
    absolutePath: input.absolutePath,
    relativePath: input.relativePath,
    extension: extname(input.absolutePath).toLowerCase(),
    sizeBytes: input.sizeBytes,
    modifiedAtMs: input.modifiedAtMs,
    fileSha256: input.fileSha256,
    audio: normalizedAudio.audio,
    durationSeconds: normalizedAudio.durationSeconds,
    tags,
    rawTags,
    artwork: [...input.artwork],
    warnings: [
      ...(input.warnings ?? []),
      ...normalizedAudio.warnings,
      ...missingTagWarnings(tags),
    ],
  };
}

function preferReliableNativeTags(
  tags: ObservedTag,
  rawTags: readonly ObservedRawTag[],
  probe: FfprobeDocument,
): ObservedTag {
  const native = (source: string, id: string): string | null =>
    rawTags.find(
      (tag) =>
        tag.source.toLocaleLowerCase("en-US") ===
          source.toLocaleLowerCase("en-US") &&
        tag.id.toLocaleUpperCase("en-US") === id,
    )?.value ?? null;
  const id3Artist = native("ID3v2.3", "TPE1") ?? native("ID3v2.4", "TPE1");
  const id3AlbumArtist = native("ID3v2.3", "TPE2") ?? native("ID3v2.4", "TPE2");
  const id3Title = native("ID3v2.3", "TIT2") ?? native("ID3v2.4", "TIT2");
  const id3Album = native("ID3v2.3", "TALB") ?? native("ID3v2.4", "TALB");
  const probeArtist = probeTextTag(probe, ["artist"]);
  const probeAlbumArtist = probeTextTag(probe, ["album_artist", "albumartist"]);
  const probeTitle = probeTextTag(probe, ["title"]);
  const probeAlbum = probeTextTag(probe, ["album"]);
  const suspiciousArtist = tags.artists.some(isLikelyBrokenLegacyText);
  const reliableArtist = id3Artist ?? probeArtist;
  return {
    ...tags,
    album: preferReliableText(tags.album, id3Album ?? probeAlbum),
    albumArtist: preferReliableText(
      tags.albumArtist,
      id3AlbumArtist ?? probeAlbumArtist,
    ),
    title: preferReliableText(tags.title, id3Title ?? probeTitle),
    artists:
      reliableArtist && suspiciousArtist
        ? [reliableArtist]
        : tags.artists.length
          ? tags.artists
          : reliableArtist
            ? [reliableArtist]
            : [],
  };
}

function probeTextTag(
  probe: FfprobeDocument,
  names: readonly string[],
): string | null {
  for (const source of [probe.audioStream, probe.format]) {
    const tags = source ? recordProperty(source, "tags") : {};
    for (const [key, value] of Object.entries(tags)) {
      if (!names.some((name) => key.toLowerCase() === name)) continue;
      const text = cleanString(value);
      if (text && !isLikelyBrokenLegacyText(text)) return text;
    }
  }
  return null;
}

function preferReliableText(
  commonValue: string | null,
  id3Value: string | null,
): string | null {
  if (!commonValue || isLikelyBrokenLegacyText(commonValue)) return id3Value;
  return commonValue;
}

function isLikelyBrokenLegacyText(value: string): boolean {
  if (!value.trim()) return true;
  if (/\uFFFD|(?:Ã.|Â.|â€|锟斤拷)/u.test(value)) return true;
  if (/\?{2,}/u.test(value)) return true;
  const ascii = [...value].filter((character) => character.charCodeAt(0) < 128);
  if (ascii.length !== [...value].length) return false;
  if (value.length <= 9) {
    const punctuation = ascii.filter((character) =>
      /[^A-Za-z0-9 ]/.test(character),
    );
    const mixedAlphaNumeric = /[A-Za-z]/.test(value) && /\d/.test(value);
    return punctuation.length > 0 || mixedAlphaNumeric;
  }
  return false;
}

function missingTagWarnings(tags: ObservedTag): ScanWarning[] {
  const warnings: ScanWarning[] = [];
  if (!tags.album)
    warnings.push({
      code: "MISSING_ALBUM_TAG",
      message: "文件缺少 Album 标签",
    });
  if (!tags.albumArtist && tags.artists.length === 0)
    warnings.push({
      code: "MISSING_ARTIST_TAG",
      message: "文件缺少 Album Artist / Artist 标签",
    });
  if (!tags.title)
    warnings.push({
      code: "MISSING_TITLE_TAG",
      message: "文件缺少 Title 标签",
    });
  if (tags.trackNumber === null)
    warnings.push({
      code: "MISSING_TRACK_NUMBER_TAG",
      message: "文件缺少 Track Number 标签",
    });
  return warnings;
}

export function normalizeRawTags(
  native: Readonly<Record<string, unknown>>,
): ObservedRawTag[] {
  const result: ObservedRawTag[] = [];
  for (const source of Object.keys(native).sort((left, right) =>
    left.localeCompare(right),
  )) {
    const entries = native[source];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const id = cleanString(entry.id);
      if (!id || !("value" in entry)) continue;
      const normalized = normalizeRawTagValue(entry.value);
      result.push({ source, id, ...normalized });
    }
  }
  return result.sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.id.localeCompare(right.id) ||
      left.value.localeCompare(right.value),
  );
}

function normalizeRawTagValue(
  value: unknown,
): Pick<ObservedRawTag, "valueKind" | "value"> {
  if (typeof value === "string") return { valueKind: "TEXT", value };
  if (typeof value === "number")
    return { valueKind: "NUMBER", value: String(value) };
  if (typeof value === "boolean")
    return { valueKind: "BOOLEAN", value: String(value) };
  const binary = binaryView(value);
  if (binary) {
    return {
      valueKind: "BINARY",
      value: JSON.stringify(binaryIdentity(binary)),
    };
  }
  return {
    valueKind: "STRUCTURED",
    value: JSON.stringify(canonicalTagValue(value, new WeakSet(), 0)),
  };
}

function canonicalTagValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return String(value);
  const binary = binaryView(value);
  if (binary) return binaryIdentity(binary);
  if (depth >= 12) return { truncated: "maximum-depth" };
  if (Array.isArray(value))
    return value.map((item) => canonicalTagValue(item, seen, depth + 1));
  if (typeof value !== "object" || value === null) return String(value);
  if (seen.has(value)) return { circular: true };
  seen.add(value);
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((left, right) =>
    left.localeCompare(right),
  )) {
    result[key] = canonicalTagValue(record[key], seen, depth + 1);
  }
  seen.delete(value);
  return result;
}

function binaryView(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function binaryIdentity(value: Uint8Array): {
  bytes: number;
  sha256: string;
} {
  return {
    bytes: value.byteLength,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

export function normalizeTags(
  common: Readonly<Record<string, unknown>>,
): ObservedTag {
  const track = tagNumber(common.track);
  const disc = tagNumber(common.disk ?? common.disc);
  const artists = stringArray(common.artists);
  const primaryArtist = cleanString(common.artist);

  return {
    album: cleanString(common.album),
    albumArtist: cleanString(common.albumartist),
    title: cleanString(common.title),
    artists: uniqueStrings(
      artists.length > 0 ? artists : primaryArtist ? [primaryArtist] : [],
    ),
    year: positiveInteger(common.year),
    date: cleanString(common.date),
    genre: uniqueStrings(stringArray(common.genre)),
    composer: uniqueStrings(stringArray(common.composer)),
    label: uniqueStrings(stringArray(common.label)),
    catalogNumber: firstString(common.catalognumber),
    barcode: firstString(common.barcode),
    musicBrainzReleaseId: cleanString(common.musicbrainz_albumid),
    discNumber: disc.number,
    discTotal: disc.total,
    trackNumber: track.number,
    trackTotal: track.total,
  };
}

function normalizeAudio(
  metadataFormat: Readonly<Record<string, unknown>>,
  common: Readonly<Record<string, unknown>>,
  probe: FfprobeDocument,
  extension: string,
): AudioNormalizationResult {
  const stream = probe.audioStream ?? {};
  const probeFormat = probe.format ?? {};
  const warnings: ScanWarning[] = [];

  const container =
    cleanString(metadataFormat.container) ??
    firstCommaSeparatedString(probeFormat.format_name);
  const codec = normalizeCodec(
    cleanString(stream.codec_name) ?? cleanString(metadataFormat.codec),
  );
  const codecProfile =
    cleanString(stream.profile) ?? cleanString(metadataFormat.codecProfile);
  const hint = [
    codec,
    container,
    codecProfile,
    extension,
    cleanString(common.media),
  ]
    .filter((value): value is string => value !== null)
    .join(" ")
    .toLowerCase();
  const isDsd = /(?:^|[^a-z])(?:dsd|dsf|dff|dsdiff)(?:[^a-z]|$)/i.test(hint);

  const metadataSampleRate = positiveInteger(metadataFormat.sampleRate);
  const rawProbeSampleRate = positiveInteger(stream.sample_rate);
  const probeSampleRate = isDsd
    ? normalizeDsdProbeSampleRate(rawProbeSampleRate, metadataSampleRate, codec)
    : rawProbeSampleRate;
  // DSF/DFF headers carry the native one-bit clock. ffprobe exposes many DSD
  // decoders as packed 8-bit samples, so prefer the header fact when present.
  const sampleRate = isDsd
    ? (metadataSampleRate ?? probeSampleRate)
    : (probeSampleRate ?? metadataSampleRate);

  const metadataBitDepth = positiveInteger(metadataFormat.bitsPerSample);
  const rawProbeBitDepth =
    positiveInteger(stream.bits_per_raw_sample) ??
    positiveInteger(stream.bits_per_sample);
  const probeBitDepth =
    isDsd && rawProbeBitDepth !== null ? 1 : rawProbeBitDepth;
  const comparableMetadataBitDepth =
    isDsd && metadataBitDepth !== null ? 1 : metadataBitDepth;
  let bitDepth = isDsd ? 1 : (probeBitDepth ?? comparableMetadataBitDepth);

  const metadataChannels = positiveInteger(metadataFormat.numberOfChannels);
  const probeChannels = positiveInteger(stream.channels);
  const channels = probeChannels ?? metadataChannels;

  const metadataDuration = nonnegativeNumber(metadataFormat.duration);
  const probeDuration =
    nonnegativeNumber(stream.duration) ??
    nonnegativeNumber(probeFormat.duration);
  // DSD container sample counts are exact; ffprobe durations can include a
  // small decoder-padding delta. PCM keeps ffprobe as the primary source.
  const durationSeconds = isDsd
    ? (metadataDuration ?? probeDuration)
    : (probeDuration ?? metadataDuration);

  const metadataBitrate = nonnegativeInteger(metadataFormat.bitrate);
  const probeBitrate =
    nonnegativeInteger(stream.bit_rate) ??
    nonnegativeInteger(probeFormat.bit_rate);
  const bitrate = probeBitrate ?? metadataBitrate;

  addIntegerConflict(
    warnings,
    "sampleRate",
    metadataSampleRate,
    probeSampleRate,
    isDsd ? "music-metadata" : "ffprobe",
  );
  addIntegerConflict(
    warnings,
    "bitDepth",
    comparableMetadataBitDepth,
    probeBitDepth,
    isDsd ? "DSD 1-bit 语义" : "ffprobe",
  );
  addIntegerConflict(warnings, "channels", metadataChannels, probeChannels);
  if (
    !isDsd &&
    metadataDuration !== null &&
    probeDuration !== null &&
    Math.abs(metadataDuration - probeDuration) > 0.25
  ) {
    warnings.push({
      code: "TECHNICAL_METADATA_CONFLICT",
      message: `duration 在 music-metadata (${metadataDuration}) 与 ffprobe (${probeDuration}) 之间不一致，采用 ffprobe`,
    });
  }

  const explicitDxd = /(?:^|[^a-z])dxd(?:[^a-z]|$)/i.test(hint);
  const pcmLike = codec?.startsWith("pcm_") === true || /\bpcm\b/i.test(hint);
  const inferredDxd =
    !explicitDxd &&
    pcmLike &&
    sampleRate !== null &&
    DXD_SAMPLE_RATES.has(sampleRate) &&
    (bitDepth === null || bitDepth >= 24);

  const metadataLossless = booleanValue(metadataFormat.lossless);
  const classifiedLossless = classifyLossless(codec);
  let lossless = metadataLossless ?? classifiedLossless;
  let kind: AudioSpec["kind"];
  let dsdRate: AudioSpec["dsdRate"] = null;

  if (isDsd) {
    kind = "DSD";
    lossless = true;
    bitDepth ??= 1;
    dsdRate = classifyDsdRate(sampleRate);
    if (sampleRate !== null && dsdRate === null) {
      warnings.push({
        code: "UNRECOGNIZED_DSD_RATE",
        message: `识别为 DSD，但采样率 ${sampleRate} Hz 无法映射到 DSD64–DSD512`,
      });
    }
  } else if (explicitDxd || inferredDxd) {
    kind = "DXD";
    lossless = true;
    if (inferredDxd) {
      warnings.push({
        code: "DXD_INFERRED_FROM_PCM_RATE",
        message: `根据 ${bitDepth ?? "未知"}-bit / ${sampleRate ?? "未知"} Hz PCM 推断为 DXD，建议结合发行信息确认`,
      });
    }
  } else if (
    lossless === false ||
    (codec !== null && LOSSY_CODECS.has(codec))
  ) {
    kind = "LOSSY";
    lossless = false;
  } else if (
    lossless === true ||
    pcmLike ||
    (codec !== null && LOSSLESS_CODECS.has(codec))
  ) {
    kind = "PCM";
    lossless = true;
  } else {
    kind = "UNKNOWN";
  }

  return {
    audio: {
      kind,
      codec,
      container,
      lossless,
      bitDepth,
      sampleRate,
      bitrate,
      channels,
      dsdRate,
    },
    durationSeconds,
    warnings,
  };
}

function classifyDsdRate(sampleRate: number | null): AudioSpec["dsdRate"] {
  if (sampleRate === null) return null;
  const candidates: readonly [AudioSpec["dsdRate"], number][] = [
    ["DSD64", 64],
    ["DSD128", 128],
    ["DSD256", 256],
    ["DSD512", 512],
  ];

  for (const [label, multiplier] of candidates) {
    for (const baseRate of [44_100, 48_000]) {
      const expected = baseRate * multiplier;
      if (Math.abs(sampleRate - expected) / expected <= 0.001) return label;
    }
  }
  return null;
}

function normalizeDsdProbeSampleRate(
  probeSampleRate: number | null,
  metadataSampleRate: number | null,
  codec: string | null,
): number | null {
  if (probeSampleRate === null) return null;
  if (metadataSampleRate !== null) {
    if (nearRate(probeSampleRate, metadataSampleRate)) return probeSampleRate;
    if (nearRate(probeSampleRate * 8, metadataSampleRate))
      return probeSampleRate * 8;
  }
  // FFmpeg DSD codecs expose one byte containing eight one-bit samples as one
  // sample. Convert that packed rate back to the native DSD clock.
  return codec?.startsWith("dsd_") === true
    ? probeSampleRate * 8
    : probeSampleRate;
}

function nearRate(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) / expected <= 0.001;
}

function classifyLossless(codec: string | null): boolean | null {
  if (!codec) return null;
  if (codec.startsWith("pcm_") || LOSSLESS_CODECS.has(codec)) return true;
  if (LOSSY_CODECS.has(codec)) return false;
  return null;
}

function normalizeCodec(codec: string | null): string | null {
  return codec?.trim().toLowerCase() || null;
}

function addIntegerConflict(
  warnings: ScanWarning[],
  field: string,
  metadataValue: number | null,
  probeValue: number | null,
  preferredSource = "ffprobe",
): void {
  if (
    metadataValue === null ||
    probeValue === null ||
    metadataValue === probeValue
  )
    return;
  warnings.push({
    code: "TECHNICAL_METADATA_CONFLICT",
    message: `${field} 在 music-metadata (${metadataValue}) 与 ffprobe (${probeValue}) 之间不一致，采用 ${preferredSource}`,
  });
}

function tagNumber(value: unknown): {
  readonly number: number | null;
  readonly total: number | null;
} {
  if (!isRecord(value)) return { number: null, total: null };
  return {
    number: positiveInteger(value.no),
    total: positiveInteger(value.of),
  };
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const direct = cleanString(item);
      if (direct) return [direct];
      if (isRecord(item)) {
        const text = cleanString(item.text);
        return text ? [text] : [];
      }
      return [];
    });
  }
  const single = cleanString(value);
  return single ? [single] : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function firstString(value: unknown): string | null {
  return stringArray(value)[0] ?? null;
}

function firstCommaSeparatedString(value: unknown): string | null {
  const text = cleanString(value);
  return text?.split(",", 1)[0]?.trim() || null;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  const number = numericValue(value);
  return number !== null && Number.isInteger(number) && number > 0
    ? number
    : null;
}

function nonnegativeInteger(value: unknown): number | null {
  const number = numericValue(value);
  return number !== null && Number.isInteger(number) && number >= 0
    ? number
    : null;
}

function nonnegativeNumber(value: unknown): number | null {
  const number = numericValue(value);
  return number !== null && number >= 0 ? number : null;
}

function numericValue(value: unknown): number | null {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function recordProperty(
  value: Readonly<Record<string, unknown>>,
  property: string,
): Readonly<Record<string, unknown>> {
  return isRecord(value[property]) ? value[property] : {};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
