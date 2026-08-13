import {
  formatCompactAudioSpec,
  type AlbumAggregationIssue,
  type AlbumDetail,
  type AlbumSummary,
  type AudioSpec,
  type CatalogRecommendationAlbum,
  type MatchStatus,
  type TrackSummary,
} from "@cocean/contracts";

export type CatalogListenAvailability =
  | { kind: "NO_LOCAL" }
  | { kind: "NO_DIGITAL" }
  | { kind: "CHECKING" }
  | { kind: "NO_TRACK" }
  | { kind: "ERROR" }
  | { kind: "READY"; album: AlbumSummary; track: TrackSummary };

export interface DiscTrackGroup {
  key: string;
  discNumber: number | null;
  tracks: TrackSummary[];
}

export type ReleaseMatchEvidence =
  | { kind: "NONE"; sourceId: null }
  | { kind: "FILE_TAG_ONLY"; sourceId: string }
  | { kind: "USER_CONFIRMED"; sourceId: string };

export function releaseMatchEvidence(
  matchStatus: MatchStatus,
  sourceId: string | null,
): ReleaseMatchEvidence {
  if (!sourceId) return { kind: "NONE", sourceId: null };
  return matchStatus === "USER_CONFIRMED"
    ? { kind: "USER_CONFIRMED", sourceId }
    : { kind: "FILE_TAG_ONLY", sourceId };
}

export function initialCatalogListenAvailability(
  item: CatalogRecommendationAlbum,
): CatalogListenAvailability {
  if (!item.localAlbum) return { kind: "NO_LOCAL" };
  if (!item.localAlbum.hasDigital) return { kind: "NO_DIGITAL" };
  return { kind: "CHECKING" };
}

export async function resolveCatalogListenAvailability(
  item: CatalogRecommendationAlbum,
  loadAlbum: (albumId: string) => Promise<AlbumDetail>,
): Promise<CatalogListenAvailability> {
  const initial = initialCatalogListenAvailability(item);
  if (initial.kind !== "CHECKING" || !item.localAlbum) return initial;

  try {
    const detail = await loadAlbum(item.localAlbum.id);
    const track = detail.tracks[0];
    return track
      ? { kind: "READY", album: item.localAlbum, track }
      : { kind: "NO_TRACK" };
  } catch {
    return { kind: "ERROR" };
  }
}

export function listenButtonLabel(
  availability: CatalogListenAvailability,
): string {
  switch (availability.kind) {
    case "READY":
      return "Listen";
    case "NO_LOCAL":
      return "未匹配本地";
    case "NO_DIGITAL":
      return "本地无数字文件";
    case "CHECKING":
      return "检查本地曲目";
    case "NO_TRACK":
      return "没有可用曲目";
    case "ERROR":
      return "Listen 不可用";
  }
}

export function listenAvailabilityDetail(
  availability: CatalogListenAvailability,
): string {
  switch (availability.kind) {
    case "READY":
      return `已连接 NAS 中的真实曲目：${availability.track.title}`;
    case "NO_LOCAL":
      return "未匹配到 NAS 唱片库，无法 Listen。";
    case "NO_DIGITAL":
      return "当前只有实体介质记录，没有本地数字曲目。";
    case "CHECKING":
      return "正在核对已索引的本地曲目。";
    case "NO_TRACK":
      return "本地 Album 已匹配，但没有已索引曲目。";
    case "ERROR":
      return "本地曲目详情读取失败，Listen 暂不可用。";
  }
}

export function groupTracksByDisc(tracks: TrackSummary[]): DiscTrackGroup[] {
  const groups = new Map<
    string,
    {
      discNumber: number | null;
      entries: Array<{ track: TrackSummary; index: number }>;
    }
  >();

  tracks.forEach((track, index) => {
    const key =
      track.discNumber === null ? "unmarked" : String(track.discNumber);
    const group = groups.get(key) ?? {
      discNumber: track.discNumber,
      entries: [],
    };
    group.entries.push({ track, index });
    groups.set(key, group);
  });

  return [...groups.entries()]
    .sort(([, left], [, right]) => {
      if (left.discNumber === null) return 1;
      if (right.discNumber === null) return -1;
      return left.discNumber - right.discNumber;
    })
    .map(([key, group]) => ({
      key,
      discNumber: group.discNumber,
      tracks: group.entries
        .sort((left, right) => {
          if (
            left.track.trackNumber === null &&
            right.track.trackNumber !== null
          )
            return 1;
          if (
            left.track.trackNumber !== null &&
            right.track.trackNumber === null
          )
            return -1;
          if (
            left.track.trackNumber !== null &&
            right.track.trackNumber !== null &&
            left.track.trackNumber !== right.track.trackNumber
          )
            return left.track.trackNumber - right.track.trackNumber;
          return left.index - right.index;
        })
        .map(({ track }) => track),
    }));
}

export function formatTrackPosition(track: TrackSummary): string {
  const disc =
    track.discNumber === null ? "Disc 未标记" : `Disc ${track.discNumber}`;
  const number =
    track.trackNumber === null
      ? "Track 未标记"
      : `Track ${String(track.trackNumber).padStart(2, "0")}`;
  return `${disc} · ${number}`;
}

export function formatTrackAudioDetails(
  spec: AudioSpec,
  sizeBytes?: number,
): string {
  const codec = spec.codec?.toUpperCase() ?? "未读取";
  const container = spec.container?.toUpperCase() ?? "未读取";
  const bitDepth = spec.bitDepth ? `${spec.bitDepth}-bit` : "位深未读取";
  const sampleRate = spec.sampleRate
    ? spec.kind === "DSD"
      ? `${trimZeros(spec.sampleRate / 1_000_000)} MHz`
      : `${trimZeros(spec.sampleRate / 1000)} kHz`
    : "采样率未读取";
  const channels = spec.channels ? `${spec.channels} ch` : "声道未读取";
  const bitrate = spec.bitrate
    ? `${Math.round(spec.bitrate / 1000).toLocaleString("en-US")} kbps`
    : "码率未读取";

  return [
    `Codec ${codec}`,
    `Container ${container}`,
    spec.kind === "DSD" ? (spec.dsdRate ?? "DSD 倍率未读取") : null,
    bitDepth,
    sampleRate,
    channels,
    bitrate,
    sizeBytes === undefined ? null : `File ${formatFileSize(sizeBytes)}`,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

export function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let value = sizeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits)).toLocaleString("en-US")} ${units[unitIndex]}`;
}

export function compactTrackAudioSpec(spec: AudioSpec): string {
  return formatCompactAudioSpec(spec);
}

export function albumAggregationIssueLabel(
  issue: AlbumAggregationIssue,
): string {
  const disc = issue.discNumber ?? "?";
  switch (issue.code) {
    case "MISSING_DISC":
      return `缺 Disc ${disc}`;
    case "MISSING_TRACK":
      return `Disc ${disc} 缺 Track ${String(issue.trackNumber ?? "?").padStart(2, "0")}`;
    case "DUPLICATE_TRACK_SLOT":
      return `Disc ${disc} · Track ${String(issue.trackNumber ?? "?").padStart(2, "0")} 重复 ${issue.actual ?? "?"} 个`;
  }
}

export function trackWarningLabel(code: string): string {
  return (
    (
      {
        MISSING_ALBUM_TAG: "缺 Album",
        MISSING_ARTIST_TAG: "缺 Artist",
        MISSING_TITLE_TAG: "缺 Title",
        MISSING_TRACK_NUMBER_TAG: "缺 Track No.",
        TECHNICAL_METADATA_CONFLICT: "规格冲突",
        UNRECOGNIZED_DSD_RATE: "DSD 倍率待确认",
        DXD_INFERRED_FROM_PCM_RATE: "DXD 推断",
        ARTWORK_CACHE_FAILED: "封面缓存失败",
        SIDECAR_DIRECTORY_UNREADABLE: "封面目录不可读",
        SIDECAR_ARTWORK_UNREADABLE: "封面不可读",
      } as Record<string, string>
    )[code] ?? code
  );
}

function trimZeros(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(1).replace(/\.0$/, "");
}
