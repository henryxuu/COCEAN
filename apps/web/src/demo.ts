import type {
  AlbumDetail,
  AlbumSummary,
  CoceanSettings,
  LibraryStats,
  ScanJob,
} from "@cocean/contracts";

const baseAlbums: Array<
  Pick<
    AlbumSummary,
    "id" | "title" | "albumArtist" | "year" | "audioBadge" | "physicalMedia"
  > & {
    status?: AlbumSummary["matchStatus"];
  }
> = [
  {
    id: "carrie-lowell",
    title: "Carrie & Lowell",
    albumArtist: "Sufjan Stevens",
    year: 2015,
    audioBadge: "24/96",
    physicalMedia: ["CD"],
  },
  {
    id: "kind-of-blue",
    title: "Kind of Blue",
    albumArtist: "Miles Davis",
    year: 1959,
    audioBadge: "DSD64",
    physicalMedia: ["SACD"],
  },
  {
    id: "blue",
    title: "Blue",
    albumArtist: "Joni Mitchell",
    year: 1971,
    audioBadge: "24/192",
    physicalMedia: ["VINYL"],
  },
  {
    id: "koln",
    title: "The Köln Concert",
    albumArtist: "Keith Jarrett",
    year: 1975,
    audioBadge: "24/96",
    physicalMedia: ["CD"],
  },
  {
    id: "love-supreme",
    title: "A Love Supreme",
    albumArtist: "John Coltrane",
    year: 1965,
    audioBadge: "24/96",
    physicalMedia: ["CD", "VINYL"],
  },
  {
    id: "vespertine",
    title: "Vespertine",
    albumArtist: "Björk",
    year: 2001,
    audioBadge: "16/44.1",
    physicalMedia: ["CD"],
  },
  {
    id: "dummy",
    title: "Dummy",
    albumArtist: "Portishead",
    year: 1994,
    audioBadge: "24/96",
    physicalMedia: ["CD", "VINYL"],
  },
  {
    id: "random-access",
    title: "Random Access Memories",
    albumArtist: "Daft Punk",
    year: 2013,
    audioBadge: "24/88.2",
    physicalMedia: ["VINYL"],
  },
  {
    id: "goldberg",
    title: "Goldberg Variations",
    albumArtist: "Glenn Gould",
    year: 1982,
    audioBadge: "DSD128",
    physicalMedia: ["CD", "SACD"],
  },
];

export const demoAlbums: AlbumSummary[] = baseAlbums.map((album, index) => ({
  ...album,
  artwork: {
    source: "NONE",
    url: null,
    mimeType: null,
    width: null,
    height: null,
  },
  audioSummary: audioFromBadge(album.audioBadge),
  mixedAudioSpecs: false,
  hasDigital: true,
  matchStatus: album.status ?? "SOURCE_MATCHED",
  primaryVersionSource: "AUTOMATIC",
  revision: 0,
  trackCount: index === 7 ? 32 : 10 + (index % 4),
  discCount: index === 7 ? 2 : 1,
  issues:
    index === 0
      ? [
          {
            code: "MISSING_ARTWORK",
            versionId: album.id,
            evidence: { source: "NONE" },
          },
        ]
      : [],
}));

export const demoStats: LibraryStats = {
  albums: 8246,
  tracks: 96214,
  files: 96408,
  needsReview: 28,
  missingArtwork: 17,
  parseFailures: 3,
  lastScanAt: new Date(Date.now() - 32 * 60_000).toISOString(),
  pendingGroups: 10,
  incompleteAlbums: 22,
  lowResolutionArtwork: 278,
  brokenIdentity: 4,
  recentlyAdded: 18,
};

export const demoScans: ScanJob[] = [
  {
    id: "demo-scan",
    rootId: "music",
    mode: "FULL",
    triggerSource: "MANUAL",
    retryOfScanJobId: null,
    status: "COMPLETED",
    totalFiles: 96408,
    processedFiles: 96408,
    parsedFiles: 96405,
    failedFiles: 3,
    reusedFiles: 0,
    stableAlbumDirectories: 0,
    deferredAlbumDirectories: 0,
    createdAt: new Date(Date.now() - 48 * 60_000).toISOString(),
    startedAt: new Date(Date.now() - 48 * 60_000).toISOString(),
    finishedAt: new Date(Date.now() - 32 * 60_000).toISOString(),
    error: null,
    cancelRequestedAt: null,
  },
];

export const demoSettings: CoceanSettings = {
  libraryRoots: [
    {
      id: "music",
      name: "Music",
      hostPathHint: null,
      containerPath: "/library/music",
      policy: "WATCH_ONLY",
      enabled: true,
      autoDiscoveryEnabled: false,
      autoDiscoveryIntervalMinutes: 5,
    },
  ],
  scanOnStart: false,
  sourceWritebackEnabled: false,
  deviceCopyMetadataEnabled: false,
  naturalLanguageDiscoveryEnabled: false,
  evidenceSummaryEnabled: false,
  qobuzEnabled: false,
  theme: "SYSTEM",
};

export function demoAlbumDetail(id: string): AlbumDetail {
  const album = demoAlbums.find((item) => item.id === id) ?? demoAlbums[0]!;
  return {
    ...album,
    release: {
      label:
        album.id === "carrie-lowell"
          ? "Asthmatic Kitty"
          : "Still verified source",
      catalogNumber: album.id === "carrie-lowell" ? "AKR099" : null,
      barcode: album.id === "carrie-lowell" ? "656605609928" : null,
      country: "US",
      releaseDate: album.year ? `${album.year}-01-01` : null,
      musicBrainzReleaseId: null,
    },
    tracks: Array.from({ length: album.trackCount }, (_, index) => ({
      id: `${album.id}-${index + 1}`,
      title: index === 0 ? "Death with Dignity" : `Track ${index + 1}`,
      artist: album.albumArtist,
      discNumber:
        album.discCount > 1
          ? Math.floor(index / Math.ceil(album.trackCount / album.discCount)) +
            1
          : 1,
      trackNumber: (index % Math.ceil(album.trackCount / album.discCount)) + 1,
      durationSeconds: 210 + (index % 5) * 17,
      sizeBytes: 48_000_000 + index * 1_250_000,
      audioSpec: album.audioSummary ?? audioFromBadge("24/96"),
      relativePath: `${album.albumArtist}/${album.title}/${String(index + 1).padStart(2, "0")} Track.flac`,
      warningCodes: [],
    })),
    physicalCopies: album.physicalMedia.map((medium, index) => ({
      id: `${album.id}-physical-${index}`,
      albumId: album.id,
      medium,
      label: null,
      catalogNumber: null,
      barcode: null,
      country: null,
      releaseYear: album.year,
      quantity: 1,
      conditionNote: null,
      storageLocation: null,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    })),
    sourceRoot: {
      id: "music",
      name: "Music",
      containerPath: "/library/music",
      readOnly: true,
    },
  };
}

function audioFromBadge(
  badge: string | null,
): NonNullable<AlbumSummary["audioSummary"]> {
  if (badge?.startsWith("DSD")) {
    const rate = badge === "DSD128" ? 5_644_800 : 2_822_400;
    return {
      kind: "DSD",
      codec: "dsf",
      container: "dsf",
      lossless: true,
      bitDepth: 1,
      sampleRate: rate,
      bitrate: rate * 2,
      channels: 2,
      dsdRate: badge as "DSD64" | "DSD128",
    };
  }
  const [bits = "24", sample = "96"] = (badge ?? "24/96").split("/");
  return {
    kind: "PCM",
    codec: "flac",
    container: "flac",
    lossless: true,
    bitDepth: Number(bits),
    sampleRate: Number(sample) * 1000,
    bitrate: null,
    channels: 2,
    dsdRate: null,
  };
}
