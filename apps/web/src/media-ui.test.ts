import type {
  AlbumSummary,
  CatalogRecommendationAlbum,
  TrackSummary,
} from "@cocean/contracts";
import { describe, expect, it, vi } from "vitest";
import { api } from "./api.js";
import { demoAlbumDetail } from "./demo.js";
import {
  albumAggregationIssueLabel,
  formatTrackAudioDetails,
  formatTrackPosition,
  groupTracksByDisc,
  trackWarningLabel,
  listenButtonLabel,
  releaseMatchEvidence,
  resolveCatalogListenAvailability,
} from "./media-ui.js";

function catalogItem(
  localAlbum: AlbumSummary | null,
): CatalogRecommendationAlbum {
  return {
    stillAlbumId: "still:test-album",
    title: "Test Album",
    artist: "Test Artist",
    domains: ["jazz"],
    features: ["warm"],
    sourceKind: "FIXTURE",
    sourceRef: "fixture:test-album",
    external: null,
    matchedCriteria: [],
    localAlbum,
  };
}

describe("Album Detail track facts", () => {
  it("groups by real Disc number and preserves real Track numbers", () => {
    const base = demoAlbumDetail("random-access").tracks[0]!;
    const tracks: TrackSummary[] = [
      { ...base, id: "d2t4", discNumber: 2, trackNumber: 4 },
      { ...base, id: "unmarked", discNumber: null, trackNumber: null },
      { ...base, id: "d1t9", discNumber: 1, trackNumber: 9 },
      { ...base, id: "d1t2", discNumber: 1, trackNumber: 2 },
    ];

    const groups = groupTracksByDisc(tracks);

    expect(groups.map((group) => group.discNumber)).toEqual([1, 2, null]);
    expect(groups[0]?.tracks.map((track) => track.trackNumber)).toEqual([2, 9]);
    expect(formatTrackPosition(groups[0]!.tracks[0]!)).toBe(
      "Disc 1 · Track 02",
    );
    expect(formatTrackPosition(groups[2]!.tracks[0]!)).toBe(
      "Disc 未标记 · Track 未标记",
    );
  });

  it("shows codec, container, channels and bitrate for PCM and DSD", () => {
    const pcm = {
      ...demoAlbumDetail("carrie-lowell").tracks[0]!.audioSpec,
      bitrate: 2_850_000,
    };
    const pcmWithoutBitrate = {
      ...pcm,
      bitrate: null,
    };
    const dsd = demoAlbumDetail("kind-of-blue").tracks[0]!.audioSpec;

    expect(formatTrackAudioDetails(pcm, 128 * 1024 * 1024)).toContain(
      "Codec FLAC",
    );
    expect(formatTrackAudioDetails(pcm, 128 * 1024 * 1024)).toContain(
      "Container FLAC",
    );
    expect(formatTrackAudioDetails(pcm, 128 * 1024 * 1024)).toContain("2 ch");
    expect(formatTrackAudioDetails(pcm, 128 * 1024 * 1024)).toContain(
      "2,850 kbps",
    );
    expect(formatTrackAudioDetails(pcm, 128 * 1024 * 1024)).toContain(
      "File 128 MiB",
    );
    expect(formatTrackAudioDetails(pcmWithoutBitrate)).toContain("码率未读取");
    expect(formatTrackAudioDetails(dsd)).toContain("DSD64");
    expect(formatTrackAudioDetails(dsd)).toContain("2.8 MHz");
  });

  it("renders direct Disc and Track issue labels without a model score", () => {
    expect(
      albumAggregationIssueLabel({
        code: "MISSING_DISC",
        discNumber: 2,
        trackNumber: null,
        expected: 3,
        actual: 2,
      }),
    ).toBe("缺 Disc 2");
    expect(
      albumAggregationIssueLabel({
        code: "MISSING_TRACK",
        discNumber: 2,
        trackNumber: 3,
        expected: 9,
        actual: 8,
      }),
    ).toBe("Disc 2 缺 Track 03");
    expect(
      albumAggregationIssueLabel({
        code: "DUPLICATE_TRACK_SLOT",
        discNumber: 3,
        trackNumber: 1,
        expected: 1,
        actual: 2,
      }),
    ).toBe("Disc 3 · Track 01 重复 2 个");
  });

  it("labels deterministic tag-quality warnings without a confidence score", () => {
    expect(trackWarningLabel("MISSING_ALBUM_TAG")).toBe("缺 Album");
    expect(trackWarningLabel("TECHNICAL_METADATA_CONFLICT")).toBe("规格冲突");
    expect(trackWarningLabel("ARTWORK_CACHE_FAILED")).toBe("封面缓存失败");
  });
});

describe("catalog Listen availability", () => {
  it("does not request an Album when no local digital copy exists", async () => {
    const loader = vi.fn(() =>
      Promise.resolve(demoAlbumDetail("carrie-lowell")),
    );
    const noLocal = await resolveCatalogListenAvailability(
      catalogItem(null),
      loader,
    );
    const physicalOnly = await resolveCatalogListenAvailability(
      catalogItem({
        ...demoAlbumDetail("carrie-lowell"),
        hasDigital: false,
      }),
      loader,
    );

    expect(noLocal.kind).toBe("NO_LOCAL");
    expect(physicalOnly.kind).toBe("NO_DIGITAL");
    expect(loader).not.toHaveBeenCalled();
  });

  it("enables Listen only after resolving a real indexed Track", async () => {
    const detail = demoAlbumDetail("carrie-lowell");
    const item = catalogItem(detail);
    const noTrack = await resolveCatalogListenAvailability(item, async () => ({
      ...detail,
      tracks: [],
    }));
    const ready = await resolveCatalogListenAvailability(
      item,
      async () => detail,
    );
    const failed = await resolveCatalogListenAvailability(item, async () => {
      throw new Error("unavailable");
    });

    expect(noTrack.kind).toBe("NO_TRACK");
    expect(listenButtonLabel(noTrack)).toBe("没有可用曲目");
    expect(ready.kind).toBe("READY");
    expect(listenButtonLabel(ready)).toBe("Listen");
    expect(ready.kind === "READY" ? ready.track.id : null).toBe(
      detail.tracks[0]!.id,
    );
    expect(failed.kind).toBe("ERROR");
  });

  it("builds the local Track endpoint without exposing a filesystem path", () => {
    expect(api.listenUrl("disc/1 track")).toBe(
      "/api/v1/tracks/disc%2F1%20track/listen?mode=browser",
    );
  });
});

describe("release match evidence", () => {
  it("does not confuse a MusicBrainz ID found in file tags with user confirmation", () => {
    expect(releaseMatchEvidence("SOURCE_MATCHED", "release-id")).toEqual({
      kind: "FILE_TAG_ONLY",
      sourceId: "release-id",
    });
    expect(releaseMatchEvidence("USER_CONFIRMED", "release-id")).toEqual({
      kind: "USER_CONFIRMED",
      sourceId: "release-id",
    });
    expect(releaseMatchEvidence("NEEDS_REVIEW", null)).toEqual({
      kind: "NONE",
      sourceId: null,
    });
  });
});
