import type { StillCatalogAlbum } from "@cocean/contracts";
import { describe, expect, it } from "vitest";
import { selectCatalogRecommendations } from "./selector.js";

const catalog: StillCatalogAlbum[] = [
  album("warm", ["jazz"], ["musical.timbre:warm", "musical.dynamics:soft"]),
  album(
    "dark",
    ["ambient"],
    ["musical.timbre:dark", "musical.density:spacious"],
  ),
  album("clear", ["classical"], ["musical.timbre:clear"]),
];

describe("selectCatalogRecommendations", () => {
  it("returns the same daily primary for the same catalog version and day", () => {
    const first = selectCatalogRecommendations({
      kind: "TODAY",
      catalog,
      contentVersion: "v1",
      dayKey: "2026-08-12",
    });
    const replay = selectCatalogRecommendations({
      kind: "TODAY",
      catalog: [...catalog].reverse(),
      contentVersion: "v1",
      dayKey: "2026-08-12",
    });
    expect(first.items[0]?.album.id).toBe(replay.items[0]?.album.id);
    expect(first.modelCallCount).toBe(0);
  });

  it("only explains criteria present in the catalog and reports unsupported facts", () => {
    const result = selectCatalogRecommendations({
      kind: "DISCOVER",
      catalog,
      contentVersion: "v1",
      dayKey: "2026-08-12",
      query: "深夜、安静但不冷的 90 年代女声专辑",
    });
    expect(result.query.supportedCriteria.map((item) => item.label)).toEqual([
      "柔和动态",
      "温暖音色",
      "暗色音色",
    ]);
    expect(result.query.unsupportedTerms).toEqual(["年代", "演唱者性别"]);
    expect(result.items.map((item) => item.album.id)).toEqual(["warm", "dark"]);
    expect(
      result.items[0]?.matchedCriteria.map((item) => item.catalogValue),
    ).toEqual(["musical.dynamics:soft", "musical.timbre:warm"]);
  });

  it("does not invent results when neither taxonomy nor identity matches", () => {
    const result = selectCatalogRecommendations({
      kind: "DISCOVER",
      catalog,
      contentVersion: "v1",
      dayKey: "2026-08-12",
      query: "火星上的雨",
    });
    expect(result.items).toEqual([]);
  });
});

function album(
  id: string,
  domains: string[],
  features: string[],
): StillCatalogAlbum {
  return {
    id,
    title: `Album ${id}`,
    artist: `Artist ${id}`,
    recordingFamilyId: `recording:${id}`,
    releaseFamilyId: `release:${id}`,
    domains,
    features,
    sourceKind: "verified_catalog",
    sourceRef: `https://example.test/${id}`,
    verifiedAt: "2026-08-01T00:00:00.000Z",
    contentVersion: "v1",
  };
}
