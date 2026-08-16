import { describe, expect, it } from "vitest";
import {
  albumAddedAtSchema,
  albumDetailSchema,
  albumSummarySchema,
  defaultLibrarySort,
  librarySortSchema,
} from "./library.js";

describe("album addedAt contract", () => {
  it("requires a valid ISO 8601 UTC instant on summaries and details", () => {
    const summary = {
      id: "library-album",
      addedAt: "2026-08-12T00:00:00.000Z",
      title: "Album",
      albumArtist: "Artist",
      year: 2026,
      artwork: {
        source: "NONE",
        url: null,
        mimeType: null,
        width: null,
        height: null,
      },
      audioBadge: null,
      audioSummary: null,
      mixedAudioSpecs: false,
      hasDigital: true,
      physicalMedia: [],
      matchStatus: "UNMATCHED",
      trackCount: 0,
      discCount: 1,
      primaryVersionSource: "AUTOMATIC",
      revision: 0,
    };

    expect(albumSummarySchema.safeParse(summary).success).toBe(true);
    const { addedAt: _addedAt, ...withoutAddedAt } = summary;
    expect(albumSummarySchema.safeParse(withoutAddedAt).success).toBe(false);
    expect(
      albumSummarySchema.safeParse({
        ...summary,
        addedAt: "2026-08-12T08:00:00+08:00",
      }).success,
    ).toBe(false);

    const detail = {
      ...summary,
      release: {
        label: null,
        catalogNumber: null,
        barcode: null,
        country: null,
        releaseDate: null,
        musicBrainzReleaseId: null,
      },
      tracks: [],
      physicalCopies: [],
      sourceRoot: null,
    };
    expect(albumDetailSchema.safeParse(detail).success).toBe(true);
    const { addedAt: _detailAddedAt, ...detailWithoutAddedAt } = detail;
    expect(albumDetailSchema.safeParse(detailWithoutAddedAt).success).toBe(
      false,
    );
    expect(
      albumDetailSchema.safeParse({
        ...detail,
        addedAt: "2026-08-12T08:00:00+08:00",
      }).success,
    ).toBe(false);
    expect(
      albumAddedAtSchema.safeParse("2026-08-12T00:00:00.000Z").success,
    ).toBe(true);
    for (const invalid of [
      "",
      "2026-08-12T00:00:00.1Z",
      "2026-08-12T00:00:00.1001Z",
      "2026-08-12T08:00:00.000+08:00",
    ]) {
      expect(albumAddedAtSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("library sort contract", () => {
  it("shares four values and defaults browsing to latest added", () => {
    expect(librarySortSchema.options).toEqual([
      "ADDED_DESC",
      "ARTIST",
      "TITLE",
      "YEAR_DESC",
    ]);
    expect(defaultLibrarySort).toBe("ADDED_DESC");
  });

  it("rejects unknown sort values", () => {
    expect(librarySortSchema.safeParse("POPULAR").success).toBe(false);
    expect(librarySortSchema.safeParse("").success).toBe(false);
  });
});
