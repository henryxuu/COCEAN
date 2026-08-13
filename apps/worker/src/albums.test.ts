import { describe, expect, it } from "vitest";
import type { ObservedMediaFile } from "@cocean/contracts";
import { groupAlbums, stableFileId } from "./albums.js";

const artwork = {
  source: "NONE" as const,
  url: null,
  mimeType: null,
  width: null,
  height: null,
};

describe("Album aggregation", () => {
  it("groups Disc 1 and Disc 2 into one Album", () => {
    const first = observed("Artist/Album/Disc 1/01 One.flac", 1, 1);
    const second = observed("Artist/Album/Disc 2/01 Two.flac", 2, 1);
    const albums = groupAlbums(
      "music",
      [first, second].map((file) => ({
        id: stableFileId("music", file.relativePath),
        file,
        artwork,
      })),
    );
    expect(albums).toHaveLength(1);
    expect(albums[0]).toEqual(
      expect.objectContaining({
        title: "Album",
        albumArtist: "Artist",
        discCount: 2,
      }),
    );
    expect(albums[0]?.fileIds).toHaveLength(2);
  });

  it("keeps distinct masterings separate even when their tags share a title", () => {
    const first = version("Artist/Album US", "Same Album");
    const second = version("Artist/Album JP", "Same Album");
    second.forEach((file) => {
      file.fileSha256 = "1".repeat(64);
      file.audio = { ...file.audio, sampleRate: 192_000 };
    });
    expect(
      groupAlbums(
        "music",
        [...first, ...second].map((file) => ({
          id: stableFileId("music", file.relativePath),
          file,
          artwork,
        })),
      ),
    ).toHaveLength(2);
  });

  it("merges sibling folders whose names end in CD1 and CD2 and supplies Disc numbers", () => {
    const first = observed(
      "DSD/[ESOTERIC-1] Puccini - Turandot CD1/01 One.dsf",
      null,
      1,
      "Puccini: Turandot",
      { discTotal: null },
    );
    const second = observed(
      "DSD/[ESOTERIC-2] Puccini - Turandot CD2/01 Two.dsf",
      null,
      1,
      "Puccini: Turandot",
      { discTotal: null },
    );
    const [album] = groupAlbums(
      "music",
      [first, second].map((file) => ({
        id: stableFileId("music", file.relativePath),
        file,
        artwork,
      })),
    );

    expect(album).toEqual(
      expect.objectContaining({
        discCount: 2,
        sourceVersionCount: 1,
        duplicateFileCount: 0,
      }),
    );
    expect(Object.values(album?.fileDiscNumbers ?? {}).sort()).toEqual([1, 2]);
  });

  it("keeps missing Album tags and Album Artist drift in the same folder Album", () => {
    const files = [
      observed("DSD/Handel/01 One.dsf", 1, 1, "Handel: Water Music", {
        albumArtist: "John Eliot Gardiner",
      }),
      observed("DSD/Handel/02 Two.dsf", 1, 2, "Handel: Water Music", {
        albumArtist: "John Eliot Gardiner",
      }),
      observed("DSD/Handel/03 Three.dsf", 1, 3, "Handel: Water Music", {
        albumArtist: "John Eliot Gardiner, English Baroque Soloists",
      }),
      observed("DSD/Handel/04 Four.dsf", 1, 4, "", {
        albumArtist: null,
      }),
    ];
    const [album] = groupAlbums(
      "music",
      files.map((file) => ({
        id: stableFileId("music", file.relativePath),
        file,
        artwork,
      })),
    );

    expect(album).toEqual(
      expect.objectContaining({
        title: "Handel: Water Music",
        albumArtist: "John Eliot Gardiner",
        primaryFileIds: expect.arrayContaining(
          files.map((file) => stableFileId("music", file.relativePath)),
        ),
      }),
    );
  });

  it("folds byte-identical duplicate folders into one Album without deleting files", () => {
    const originals = [
      observed("HiRes/Schubert/01 Quintet.flac", 1, 1, "Schubert"),
      observed("HiRes/Schubert/02 Adagio.flac", 1, 2, "Schubert"),
    ];
    const copies = [
      observed("HiRes/Schubert (1)/01 Quintet.flac", 1, 1, "Schubert"),
      observed("HiRes/Schubert (1)/02 Adagio.flac", 1, 2, "Schubert"),
    ];
    const [album] = groupAlbums(
      "music",
      [...originals, ...copies].map((file) => ({
        id: stableFileId("music", file.relativePath),
        file,
        artwork,
      })),
    );

    expect(album?.fileIds).toHaveLength(4);
    expect(album?.primaryFileIds).toHaveLength(2);
    expect(album?.sourceVersionCount).toBe(2);
    expect(album?.duplicateFileCount).toBe(2);
    expect(album?.primaryFileIds).toEqual(
      originals.map((file) => stableFileId("music", file.relativePath)),
    );
  });

  it("folds tag-only duplicate encodes with matching track facts", () => {
    const originals = [
      observed("Normal/Bach/01 Prelude.flac", 1, 1, "Bach"),
      observed("Normal/Bach/02 Fugue.flac", 1, 2, "Bach"),
    ];
    const copies = [
      observed("Provider/Bach/01 Prelude.flac", 1, 1, "Bach"),
      observed("Provider/Bach/02 Fugue.flac", 1, 2, "Bach"),
    ];
    originals.forEach((file) => {
      file.fileSha256 = "1".repeat(64);
      file.sizeBytes = 100_000_000;
    });
    copies.forEach((file) => {
      file.fileSha256 = "2".repeat(64);
      file.tags = {
        ...file.tags,
        title: `${file.tags.title} -sonyhires.com`,
      };
      file.sizeBytes = 100_150_000;
    });
    const [album] = groupAlbums(
      "music",
      [...originals, ...copies].map((file) => ({
        id: stableFileId("music", file.relativePath),
        file,
        artwork,
      })),
    );

    expect(album?.sourceVersionCount).toBe(2);
    expect(album?.duplicateFileCount).toBe(2);
  });

  it("folds bilingual duplicate releases by track number and exact timing", () => {
    const english = [
      observed("Qobuz/Album/01 English One.flac", 1, 1, "Album", {
        albumArtist: "Soloist",
        title: "English One",
      }),
      observed("Qobuz/Album/02 English Two.flac", 1, 2, "Album", {
        albumArtist: "Soloist",
        title: "English Two",
      }),
    ];
    const bilingual = [
      observed("Normal/Album/01 中文：English One.flac", 1, 1, "Album", {
        albumArtist: "Soloist, Orchestra",
        title: "中文：English One",
      }),
      observed("Normal/Album/02 中文：English Two.flac", 1, 2, "Album", {
        albumArtist: "Soloist, Orchestra",
        title: "中文：English Two",
      }),
    ];
    english[0]!.durationSeconds = bilingual[0]!.durationSeconds = 298.08;
    english[1]!.durationSeconds = bilingual[1]!.durationSeconds = 166.253;
    english.forEach((file) => (file.sizeBytes = 20_000_000));
    bilingual.forEach((file) => (file.sizeBytes = 20_200_000));
    bilingual.forEach((file) => {
      file.tags = { ...file.tags, year: null, date: null };
    });
    const albums = groupAlbums(
      "music",
      [...english, ...bilingual].map((file) => ({
        id: stableFileId("music", file.relativePath),
        file,
        artwork,
      })),
    );

    expect(albums).toHaveLength(1);
    expect(albums[0]).toEqual(
      expect.objectContaining({
        albumArtist: "Soloist",
        year: 2020,
        sourceVersionCount: 2,
        duplicateFileCount: 2,
      }),
    );
  });

  it("does not mistake a release year in the folder name for a copy suffix", () => {
    const untagged = [
      observed("Normal/Album/01 One.flac", 1, 1, "Album", {
        albumArtist: null,
        title: "One",
      }),
      observed("Normal/Album/02 Two.flac", 1, 2, "Album", {
        albumArtist: null,
        title: "Two",
      }),
    ];
    const tagged = [
      observed("Qobuz/Album (2007) [16B-44.1kHz]/01 One.flac", 1, 1, "Album", {
        albumArtist: "Soloist",
        title: "One",
      }),
      observed("Qobuz/Album (2007) [16B-44.1kHz]/02 Two.flac", 1, 2, "Album", {
        albumArtist: "Soloist",
        title: "Two",
      }),
    ];
    for (const file of [...untagged, ...tagged]) {
      file.durationSeconds = file.tags.trackNumber === 1 ? 300 : 240;
      file.sizeBytes = file.tags.trackNumber === 1 ? 30_000_000 : 24_000_000;
    }
    for (const file of tagged) {
      file.tags = {
        ...file.tags,
        year: 2007,
        date: "2007-10-01",
        label: ["Canary Classics"],
      };
    }

    const albums = groupAlbums(
      "music",
      [...untagged, ...tagged].map((file) => ({
        id: stableFileId("music", file.relativePath),
        file,
        artwork,
      })),
    );

    expect(albums).toHaveLength(1);
    expect(albums[0]).toEqual(
      expect.objectContaining({
        albumArtist: "Soloist",
        year: 2007,
        label: "Canary Classics",
        sourceVersionCount: 2,
      }),
    );
  });

  it("keeps different performances separate when durations differ", () => {
    const first = version("A/Album", "Album", { albumArtist: "Soloist A" });
    const second = version("B/Album", "Album", { albumArtist: "Soloist B" });
    first[0]!.durationSeconds = 300;
    second[0]!.durationSeconds = 315;
    expect(
      groupAlbums(
        "music",
        [...first, ...second].map((file) => ({
          id: stableFileId("music", file.relativePath),
          file,
          artwork,
        })),
      ),
    ).toHaveLength(2);
  });

  it("keeps versions separate when a track number is missing", () => {
    const first = [
      observed("A/Album/01 One.flac", 1, 1),
      observed("A/Album/02 Two.flac", 1, 2),
    ];
    const second = [
      observed("B/Album/01 One.flac", 1, 1),
      observed("B/Album/02 Two.flac", 1, 2, "Album", {
        trackNumber: null,
      }),
    ];
    second.forEach((file) => (file.fileSha256 = "2".repeat(64)));

    expect(
      groupAlbums(
        "music",
        [...first, ...second].map((file) => ({
          id: stableFileId("music", file.relativePath),
          file,
          artwork,
        })),
      ),
    ).toHaveLength(2);
  });

  it("keeps versions separate when the full audio specification differs", () => {
    const first = [
      observed("A/Album/01 One.flac", 1, 1),
      observed("A/Album/02 Two.flac", 1, 2),
    ];
    const second = [
      observed("B/Album/01 One.flac", 1, 1),
      observed("B/Album/02 Two.flac", 1, 2),
    ];
    second.forEach((file) => {
      file.fileSha256 = "2".repeat(64);
      file.audio = { ...file.audio, channels: 6 };
    });

    expect(
      groupAlbums(
        "music",
        [...first, ...second].map((file) => ({
          id: stableFileId("music", file.relativePath),
          file,
          artwork,
        })),
      ),
    ).toHaveLength(2);
  });

  it("requires the normalized Album title independently of matching two-track facts", () => {
    expect(
      albumCount([
        ...version("A/Album", "First"),
        ...version("B/Album", "Second"),
      ]),
    ).toBe(2);
  });

  it("requires the same track count independently of otherwise matching facts", () => {
    const first = version("A/Album");
    const second = [
      ...version("B/Album"),
      observed("B/Album/03 Three.flac", 1, 3),
    ];
    expect(albumCount([...first, ...second])).toBe(2);
  });

  it("requires each track duration independently of otherwise matching facts", () => {
    const first = version("A/Album");
    const second = version("B/Album");
    second[1]!.durationSeconds = first[1]!.durationSeconds! + 0.251;
    expect(albumCount([...first, ...second])).toBe(2);
  });

  it.each([
    [
      "kind",
      (file: ObservedMediaFile) => {
        file.audio = {
          ...file.audio,
          kind: "LOSSY",
          lossless: false,
          bitrate: 320_000,
          bitDepth: null,
        };
      },
    ],
    [
      "codec",
      (file: ObservedMediaFile) => {
        file.audio = { ...file.audio, codec: "wavpack" };
      },
    ],
    [
      "container",
      (file: ObservedMediaFile) => {
        file.audio = { ...file.audio, container: "wav" };
      },
    ],
    [
      "lossless",
      (file: ObservedMediaFile) => {
        file.audio = { ...file.audio, lossless: false };
      },
    ],
    [
      "bitDepth",
      (file: ObservedMediaFile) => {
        file.audio = { ...file.audio, bitDepth: 16 };
      },
    ],
    [
      "sampleRate",
      (file: ObservedMediaFile) => {
        file.audio = { ...file.audio, sampleRate: 192_000 };
      },
    ],
    [
      "channels",
      (file: ObservedMediaFile) => {
        file.audio = { ...file.audio, channels: 6 };
      },
    ],
  ] as const)(
    "requires matching applicable %s audio facts",
    (_field, mutate) => {
      const first = version("A/Album");
      const second = version("B/Album");
      second.forEach(mutate);
      expect(albumCount([...first, ...second])).toBe(2);
    },
  );

  it.each([
    "codec",
    "container",
    "lossless",
    "bitDepth",
    "sampleRate",
    "channels",
  ] as const)(
    "rejects two versions whose applicable %s fact is missing on both sides",
    (field) => {
      const first = version("A/Album");
      const second = version("B/Album");
      for (const file of [...first, ...second])
        file.audio = { ...file.audio, [field]: null };
      expect(albumCount([...first, ...second])).toBe(2);
    },
  );

  it("requires LOSSY bitrate facts and DSD rate facts when those formats are compared", () => {
    const lossyA = version("Lossy A/Album");
    const lossyB = version("Lossy B/Album");
    for (const file of [...lossyA, ...lossyB])
      file.audio = {
        ...file.audio,
        kind: "LOSSY",
        codec: "mp3",
        container: "mp3",
        lossless: false,
        bitDepth: null,
        bitrate: null,
        dsdRate: null,
      };
    const dsdA = version("DSD A/Album");
    const dsdB = version("DSD B/Album");
    for (const file of [...dsdA, ...dsdB])
      file.audio = {
        ...file.audio,
        kind: "DSD",
        codec: "dsd_lsbf_planar",
        container: "dsf",
        lossless: true,
        bitDepth: null,
        bitrate: null,
        dsdRate: null,
      };
    expect(albumCount([...lossyA, ...lossyB])).toBe(2);
    expect(albumCount([...dsdA, ...dsdB])).toBe(2);
  });

  it("uses a 2% capped size tolerance instead of a 2 MiB blanket for small tracks", () => {
    const first = version("A/Album");
    const second = version("B/Album");
    first.forEach((file) => (file.sizeBytes = 1_000));
    second.forEach((file) => (file.sizeBytes = 1_021));
    expect(albumCount([...first, ...second])).toBe(2);
  });

  it("requires explicit Disc facts instead of silently assuming Disc 1", () => {
    const first = version("A/Album");
    const second = version("B/Album");
    for (const file of [...first, ...second]) file.tags.discNumber = null;
    expect(albumCount([...first, ...second])).toBe(2);
  });

  it("rejects a duplicate Disc/Track slot before considering version equivalence", () => {
    const first = version("A/Album");
    const second = version("B/Album");
    first[1]!.tags.trackNumber = 1;
    second[1]!.tags.trackNumber = 1;
    expect(albumCount([...first, ...second])).toBe(2);
  });

  it("forms only clique-equivalent clusters for a non-transitive duration triad", () => {
    const center = version("A/Album");
    const low = version("B/Album");
    const high = version("C/Album");
    center[0]!.durationSeconds = 100.2;
    low[0]!.durationSeconds = 100;
    high[0]!.durationSeconds = 100.4;
    const albums = groupAlbums(
      "music",
      [...center, ...low, ...high].map((file) => indexed(file)),
    );
    expect(albums).toHaveLength(2);
    expect(albums.map((album) => album.sourceVersionCount).sort()).toEqual([
      1, 2,
    ]);
  });

  it("uses artwork from a secondary merged version while retaining primary metadata", () => {
    const primary = version("Normal/Album", "Album", { year: 2007 });
    primary.forEach((file) => {
      file.tags = { ...file.tags, label: ["Primary Label"] };
    });
    const secondary = version("Provider/Album (1)", "Album", { year: null });
    const secondaryArtwork = {
      source: "SIDECAR" as const,
      url: "/api/v1/artwork/" + "a".repeat(64),
      mimeType: "image/jpeg",
      width: 1200,
      height: 1200,
    };
    const albums = groupAlbums("music", [
      ...primary.map((file) => indexed(file)),
      ...secondary.map((file) => indexed(file, secondaryArtwork)),
    ]);
    expect(albums).toHaveLength(1);
    expect(albums[0]).toEqual(
      expect.objectContaining({
        year: 2007,
        label: "Primary Label",
        artwork: secondaryArtwork,
        sourceVersionCount: 2,
      }),
    );
  });

  it("keeps a compilation in one Album when track artists differ and Album Artist is absent", () => {
    const first = observed("精选集/01 One.wav", 1, 1, "精选集", {
      albumArtist: null,
      artists: ["陈彼得"],
      title: "One",
    });
    const second = observed("精选集/02 Two.wav", 1, 2, "精选集", {
      albumArtist: null,
      artists: ["游戏科学"],
      title: "Two",
    });
    const albums = groupAlbums(
      "music",
      [first, second].map((file) => ({
        id: stableFileId("music", file.relativePath),
        file,
        artwork,
      })),
    );

    expect(albums).toHaveLength(1);
    expect(albums[0]).toEqual(
      expect.objectContaining({
        title: "精选集",
        albumArtist: "群星",
        fileIds: expect.arrayContaining([
          stableFileId("music", first.relativePath),
          stableFileId("music", second.relativePath),
        ]),
      }),
    );
  });

  it("checks declared track totals independently for each disc", () => {
    const files = [
      observed("Artist/Album/Disc 1/01 One.flac", 1, 1, "Album", {
        trackTotal: 2,
      }),
      observed("Artist/Album/Disc 1/02 Two.flac", 1, 2, "Album", {
        trackTotal: 2,
      }),
      observed("Artist/Album/Disc 2/01 Three.flac", 2, 1, "Album", {
        trackTotal: 2,
      }),
    ];
    const [album] = groupAlbums(
      "music",
      files.map((file) => ({
        id: stableFileId("music", file.relativePath),
        file,
        artwork,
      })),
    );
    expect(album?.matchStatus).toBe("TRACKS_INCOMPLETE");
    expect(album?.aggregationIssues).toContainEqual({
      code: "MISSING_TRACK",
      discNumber: 2,
      trackNumber: 2,
      expected: 2,
      actual: 1,
    });
  });

  it("does not treat an album-wide total as a per-disc total", () => {
    const files = [
      observed("Artist/Album/Disc 1/01 One.flac", 1, 1, "Album", {
        trackTotal: 2,
      }),
      observed("Artist/Album/Disc 2/02 Two.flac", 2, 2, "Album", {
        trackTotal: 2,
      }),
    ];
    const [album] = groupAlbums(
      "music",
      files.map((file) => ({
        id: stableFileId("music", file.relativePath),
        file,
        artwork,
      })),
    );
    expect(album?.aggregationIssues).toEqual([]);
    expect(album?.matchStatus).toBe("NEEDS_REVIEW");
  });

  it("detects a missing disc and duplicate track slot", () => {
    const files = [
      observed("Artist/Album/Disc 1/01 One.flac", 1, 1, "Album", {
        discTotal: 3,
      }),
      observed("Artist/Album/Disc 3/01 Three.flac", 3, 1, "Album", {
        discTotal: 3,
      }),
      observed("Artist/Album/Disc 3/01 Three copy.flac", 3, 1, "Album", {
        discTotal: 3,
      }),
    ];
    const [album] = groupAlbums(
      "music",
      files.map((file) => ({
        id: stableFileId("music", file.relativePath),
        file,
        artwork,
      })),
    );
    expect(album?.aggregationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MISSING_DISC", discNumber: 2 }),
        expect.objectContaining({
          code: "DUPLICATE_TRACK_SLOT",
          discNumber: 3,
          trackNumber: 1,
        }),
      ]),
    );
  });

  it("does not treat global numbering on disc 2 as twelve missing tracks", () => {
    const files = [
      observed("Artist/Album/Disc 1/01 One.flac", 1, 1, "Album", {
        trackTotal: 1,
      }),
      observed("Artist/Album/Disc 2/13 Thirteen.flac", 2, 13, "Album", {
        trackTotal: 20,
      }),
      observed("Artist/Album/Disc 2/14 Fourteen.flac", 2, 14, "Album", {
        trackTotal: 20,
      }),
    ];
    const [album] = groupAlbums(
      "music",
      files.map((file) => ({
        id: stableFileId("music", file.relativePath),
        file,
        artwork,
      })),
    );
    expect(album?.aggregationIssues).toEqual([]);
    expect(album?.matchStatus).toBe("NEEDS_REVIEW");
  });

  it("does not multiply an album-wide total across three locally numbered discs", () => {
    const files = Array.from({ length: 3 }, (_, discIndex) =>
      Array.from({ length: 22 }, (_, trackIndex) =>
        observed(
          `Artist/Box/Disc ${discIndex + 1}/${String(trackIndex + 1).padStart(2, "0")} Track.flac`,
          discIndex + 1,
          trackIndex + 1,
          "Box",
          { discTotal: 3, trackTotal: 66 },
        ),
      ),
    ).flat();
    const [album] = groupAlbums(
      "music",
      files.map((file) => ({
        id: stableFileId("music", file.relativePath),
        file,
        artwork,
      })),
    );

    expect(album?.fileIds).toHaveLength(66);
    expect(album?.aggregationIssues).toEqual([]);
    expect(album?.matchStatus).toBe("NEEDS_REVIEW");
  });

  it("does not report missing tracks for complete globally increasing numbering", () => {
    const files = Array.from({ length: 100 }, (_, index) => {
      const trackNumber = index + 1;
      const discNumber = trackNumber <= 50 ? 1 : 2;
      return observed(
        `Artist/Anthology/Disc ${discNumber}/${String(trackNumber).padStart(3, "0")} Track.flac`,
        discNumber,
        trackNumber,
        "Anthology",
        { discTotal: 2, trackTotal: 100 },
      );
    });
    const [album] = groupAlbums(
      "music",
      files.map((file) => ({
        id: stableFileId("music", file.relativePath),
        file,
        artwork,
      })),
    );

    expect(album?.fileIds).toHaveLength(100);
    expect(album?.aggregationIssues).toEqual([]);
  });
});

function observed(
  relativePath: string,
  discNumber: number | null,
  trackNumber: number,
  album = "Album",
  tagOverrides: Partial<ObservedMediaFile["tags"]> = {},
): ObservedMediaFile {
  return {
    absolutePath: `/library/music/${relativePath}`,
    relativePath,
    extension: ".flac",
    sizeBytes: 100,
    modifiedAtMs: 1,
    fileSha256: "0".repeat(64),
    audio: {
      kind: "PCM",
      codec: "flac",
      container: "flac",
      lossless: true,
      bitDepth: 24,
      sampleRate: 96_000,
      bitrate: null,
      channels: 2,
      dsdRate: null,
    },
    durationSeconds: 100,
    tags: {
      album,
      albumArtist: "Artist",
      title: `Track ${trackNumber}`,
      artists: ["Artist"],
      year: 2020,
      date: "2020",
      genre: [],
      composer: [],
      label: [],
      catalogNumber: null,
      barcode: null,
      musicBrainzReleaseId: null,
      discNumber,
      discTotal: 2,
      trackNumber,
      trackTotal: 1,
      ...tagOverrides,
    },
    artwork: [],
    rawTags: [],
    warnings: [],
  };
}

function version(
  folder: string,
  album = "Album",
  tagOverrides: Partial<ObservedMediaFile["tags"]> = {},
): ObservedMediaFile[] {
  return [
    observed(`${folder}/01 One.flac`, 1, 1, album, tagOverrides),
    observed(`${folder}/02 Two.flac`, 1, 2, album, tagOverrides),
  ];
}

function indexed(
  file: ObservedMediaFile,
  fileArtwork: typeof artwork = artwork,
) {
  return {
    id: stableFileId("music", file.relativePath),
    file,
    artwork: fileArtwork,
  };
}

function albumCount(files: ObservedMediaFile[]): number {
  return groupAlbums(
    "music",
    files.map((file) => indexed(file)),
  ).length;
}
