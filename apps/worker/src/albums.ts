import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import type {
  AlbumAggregationIssue,
  AlbumSummary,
  AudioSpec,
  ObservedMediaFile,
} from "@cocean/contracts";
import { formatCompactAudioSpec } from "@cocean/contracts";
import type { AlbumRecordInput } from "@cocean/database";

export interface IndexedFile {
  id: string;
  file: ObservedMediaFile;
  artwork: AlbumSummary["artwork"];
}

interface AlbumVersion {
  key: string;
  folder: string;
  parentFolder: string;
  discHint: number | null;
  title: string;
  albumArtist: string;
  files: IndexedFile[];
  discNumbers: Map<string, number>;
}

export function groupAlbums(
  rootId: string,
  files: IndexedFile[],
): AlbumRecordInput[] {
  const folders = new Map<string, IndexedFile[]>();
  for (const indexed of files) {
    const folder = albumFolder(indexed.file.relativePath);
    const group = folders.get(folder) ?? [];
    group.push(indexed);
    folders.set(folder, group);
  }

  const folderVersions = [...folders.entries()].flatMap(([folder, group]) =>
    versionsInFolder(folder, group),
  );
  const discSets = mergeSiblingDiscs(folderVersions);
  return clusterEquivalentVersions(discSets).map((cluster) => {
    const primary = choosePrimaryVersion(cluster);
    const allFiles = cluster.flatMap((version) => version.files);
    const discNumbers = new Map<string, number>();
    for (const version of cluster) {
      for (const [fileId, discNumber] of version.discNumbers)
        discNumbers.set(fileId, discNumber);
    }
    return buildAlbum(
      rootId,
      primary.key,
      allFiles,
      primary.files,
      discNumbers,
      cluster.length,
    );
  });
}

function buildAlbum(
  rootId: string,
  key: string,
  allFiles: IndexedFile[],
  primaryFiles: IndexedFile[],
  discNumbers: Map<string, number>,
  sourceVersionCount: number,
): AlbumRecordInput {
  const sorted = [...primaryFiles].sort((a, b) =>
    compareTracks(a.file, b.file, discNumbers.get(a.id), discNumbers.get(b.id)),
  );
  const first = sorted[0]!;
  const title =
    mostCommon(
      sorted.map(({ file }) => file.tags.album?.trim()).filter(isNonEmpty),
    ) ?? fallbackAlbum(first.file.relativePath);
  const albumArtist =
    mostCommon(
      sorted
        .map(({ file }) => file.tags.albumArtist?.trim())
        .filter(isNonEmpty),
    ) ||
    commonTrackArtist(sorted.map(({ file }) => file)) ||
    fallbackArtist(first.file.relativePath);
  const specs = sorted.map(({ file }) => file.audio);
  const mixedAudioSpecs = new Set(specs.map(formatCompactAudioSpec)).size > 1;
  const audioSummary = chooseSummary(specs);
  const layout = analyzeTrackLayout(
    sorted.map(({ id, file }) => withDiscNumber(file, discNumbers.get(id))),
  );
  const musicBrainzReleaseId = firstNonNull(
    sorted.map(({ file }) => file.tags.musicBrainzReleaseId),
  );
  const artwork =
    [...sorted, ...allFiles]
      .map(({ artwork }) => artwork)
      .find((item) => item.source !== "NONE") ?? emptyArtwork();
  return {
    id: stableId("album", rootId, key),
    rootId,
    groupKey: key,
    title,
    albumArtist,
    year: firstNonNull(sorted.map(({ file }) => file.tags.year)),
    discCount: layout.discCount,
    aggregationIssues: layout.issues,
    fileIds: [...allFiles]
      .sort((a, b) => a.file.relativePath.localeCompare(b.file.relativePath))
      .map(({ id }) => id),
    primaryFileIds: sorted.map(({ id }) => id),
    fileDiscNumbers: Object.fromEntries(discNumbers),
    sourceVersionCount,
    duplicateFileCount: allFiles.length - sorted.length,
    audioSummary,
    mixedAudioSpecs,
    artwork,
    matchStatus: layout.issues.length
      ? "TRACKS_INCOMPLETE"
      : musicBrainzReleaseId
        ? "SOURCE_MATCHED"
        : "NEEDS_REVIEW",
    label: firstNonNull(sorted.flatMap(({ file }) => file.tags.label)),
    catalogNumber: firstNonNull(
      sorted.map(({ file }) => file.tags.catalogNumber),
    ),
    barcode: firstNonNull(sorted.map(({ file }) => file.tags.barcode)),
    musicBrainzReleaseId,
  };
}

function versionsInFolder(
  folder: string,
  files: IndexedFile[],
): AlbumVersion[] {
  const taggedAlbumNames = [
    ...new Set(
      files
        .map(({ file }) => file.tags.album?.trim())
        .filter(isNonEmpty)
        .map(normalize),
    ),
  ];
  const soleTaggedAlbum =
    taggedAlbumNames.length === 1 ? taggedAlbumNames[0]! : null;
  const groups = new Map<string, IndexedFile[]>();
  for (const indexed of files) {
    const albumName = indexed.file.tags.album?.trim();
    const key = albumName
      ? normalize(albumName)
      : (soleTaggedAlbum ??
        normalize(fallbackAlbum(indexed.file.relativePath)));
    const group = groups.get(key) ?? [];
    group.push(indexed);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([albumKey, group]) => {
    const first = group[0]!;
    const title =
      mostCommon(
        group.map(({ file }) => file.tags.album?.trim()).filter(isNonEmpty),
      ) ?? fallbackAlbum(first.file.relativePath);
    const albumArtist =
      mostCommon(
        group
          .map(({ file }) => file.tags.albumArtist?.trim())
          .filter(isNonEmpty),
      ) ??
      commonTrackArtist(group.map(({ file }) => file)) ??
      fallbackArtist(first.file.relativePath);
    const hint = discFolderHint(folder);
    const discNumbers = new Map<string, number>();
    if (hint) {
      for (const { id, file } of group)
        discNumbers.set(id, file.tags.discNumber ?? hint.discNumber);
    }
    return {
      key: `${normalize(folder)}\u0000${albumKey}`,
      folder,
      parentFolder: hint?.parentFolder ?? dirname(folder).replaceAll("\\", "/"),
      discHint: hint?.discNumber ?? null,
      title,
      albumArtist,
      files: group,
      discNumbers,
    };
  });
}

function mergeSiblingDiscs(versions: AlbumVersion[]): AlbumVersion[] {
  const buckets = new Map<string, AlbumVersion[]>();
  const standalone: AlbumVersion[] = [];
  for (const version of versions) {
    if (!version.discHint) {
      standalone.push(version);
      continue;
    }
    const identity = `${normalize(version.parentFolder)}\u0000${normalize(version.title)}\u0000${normalize(version.albumArtist)}`;
    const bucket = buckets.get(identity) ?? [];
    bucket.push(version);
    buckets.set(identity, bucket);
  }
  for (const [identity, bucket] of buckets) {
    const hints = new Set(bucket.map((version) => version.discHint));
    if (bucket.length < 2 || hints.size !== bucket.length) {
      standalone.push(...bucket);
      continue;
    }
    const files = bucket.flatMap((version) => version.files);
    const discNumbers = new Map<string, number>();
    for (const version of bucket) {
      for (const [fileId, discNumber] of version.discNumbers)
        discNumbers.set(fileId, discNumber);
    }
    const preferred = choosePrimaryVersion(bucket);
    standalone.push({
      ...preferred,
      key: `disc-set\u0000${identity}`,
      folder: preferred.parentFolder,
      parentFolder: dirname(preferred.parentFolder).replaceAll("\\", "/"),
      discHint: null,
      files,
      discNumbers,
    });
  }
  return standalone;
}

function clusterEquivalentVersions(versions: AlbumVersion[]): AlbumVersion[][] {
  const clusters: AlbumVersion[][] = [];
  for (const version of [...versions].sort((a, b) =>
    a.key.localeCompare(b.key),
  )) {
    const cluster = clusters.find((candidate) =>
      candidate.every(
        (member) =>
          normalize(member.title) === normalize(version.title) &&
          equivalentAudioVersion(member, version),
      ),
    );
    if (cluster) cluster.push(version);
    else clusters.push([version]);
  }
  return clusters;
}

function sameTrackFingerprint(a: AlbumVersion, b: AlbumVersion): boolean {
  const aFiles = sortedVersionFiles(a);
  const bFiles = sortedVersionFiles(b);
  if (
    aFiles.length < 2 ||
    aFiles.length !== bFiles.length ||
    !hasUniqueExplicitTrackSlots(a) ||
    !hasUniqueExplicitTrackSlots(b)
  )
    return false;
  return aFiles.every(({ id, file }, index) => {
    const otherIndexed = bFiles[index];
    const other = otherIndexed?.file;
    if (!other) return false;
    const durationA = file.durationSeconds;
    const durationB = other.durationSeconds;
    if (durationA === null || durationB === null) return false;
    const trackA = file.tags.trackNumber;
    const trackB = other.tags.trackNumber;
    const discA = a.discNumbers.get(id) ?? file.tags.discNumber;
    const discB = b.discNumbers.get(otherIndexed.id) ?? other.tags.discNumber;
    return (
      trackA !== null &&
      trackB !== null &&
      discA !== null &&
      discA !== undefined &&
      discB !== null &&
      discB !== undefined &&
      trackA === trackB &&
      discA === discB &&
      Math.abs(durationA - durationB) <= 0.25
    );
  });
}

function equivalentAudioVersion(a: AlbumVersion, b: AlbumVersion): boolean {
  const aFiles = sortedVersionFiles(a);
  const bFiles = sortedVersionFiles(b);
  if (aFiles.length !== bFiles.length || !sameTrackFingerprint(a, b))
    return false;
  return aFiles.every(({ file }, index) => {
    const other = bFiles[index]?.file;
    if (!other) return false;
    const sizeDelta = Math.abs(file.sizeBytes - other.sizeBytes);
    const sizeTolerance = Math.min(
      2 * 1024 * 1024,
      Math.min(file.sizeBytes, other.sizeBytes) * 0.02,
    );
    return sameAudioSpec(file.audio, other.audio) && sizeDelta <= sizeTolerance;
  });
}

function sameAudioSpec(a: AudioSpec, b: AudioSpec): boolean {
  return (
    hasCompleteApplicableAudioFacts(a) &&
    hasCompleteApplicableAudioFacts(b) &&
    a.kind === b.kind &&
    normalizeNullable(a.codec) === normalizeNullable(b.codec) &&
    normalizeNullable(a.container) === normalizeNullable(b.container) &&
    a.lossless === b.lossless &&
    a.bitDepth === b.bitDepth &&
    a.sampleRate === b.sampleRate &&
    a.bitrate === b.bitrate &&
    a.channels === b.channels &&
    a.dsdRate === b.dsdRate
  );
}

function hasUniqueExplicitTrackSlots(version: AlbumVersion): boolean {
  const slots = new Set<string>();
  for (const { id, file } of version.files) {
    const discNumber = version.discNumbers.get(id) ?? file.tags.discNumber;
    const trackNumber = file.tags.trackNumber;
    if (
      !Number.isInteger(discNumber) ||
      Number(discNumber) <= 0 ||
      !Number.isInteger(trackNumber) ||
      Number(trackNumber) <= 0
    )
      return false;
    const slot = `${discNumber}:${trackNumber}`;
    if (slots.has(slot)) return false;
    slots.add(slot);
  }
  return true;
}

function hasCompleteApplicableAudioFacts(spec: AudioSpec): boolean {
  const common =
    isNonEmpty(spec.codec) &&
    isNonEmpty(spec.container) &&
    spec.lossless !== null &&
    spec.sampleRate !== null &&
    spec.channels !== null;
  if (!common) return false;
  if (spec.kind === "PCM" || spec.kind === "DXD") return spec.bitDepth !== null;
  if (spec.kind === "DSD") return spec.dsdRate !== null;
  if (spec.kind === "LOSSY") return spec.bitrate !== null;
  return false;
}

function normalizeNullable(value: string | null): string | null {
  return value === null ? null : value.trim().toLocaleLowerCase("en-US");
}

function sortedVersionFiles(version: AlbumVersion): IndexedFile[] {
  return [...version.files].sort((a, b) =>
    compareTracks(
      a.file,
      b.file,
      version.discNumbers.get(a.id),
      version.discNumbers.get(b.id),
    ),
  );
}

function choosePrimaryVersion(versions: AlbumVersion[]): AlbumVersion {
  return [...versions].sort((a, b) => {
    const pathPenalty = (value: AlbumVersion) => {
      const folderName = basename(value.folder).trim();
      return /(?:\(\d{1,2}\)|\bcopy\b|副本)\s*$/i.test(folderName) ? 1 : 0;
    };
    const metadataScore = (value: AlbumVersion) =>
      value.files.reduce(
        (score, { file }) =>
          score +
          Number(Boolean(file.tags.album)) * 2 +
          Number(Boolean(file.tags.albumArtist)) * 2 +
          Number(Boolean(file.tags.title)) +
          Number(file.tags.year !== null) * 2 +
          Number(Boolean(file.tags.date)) +
          Number(Boolean(file.tags.label.length)) +
          Number(Boolean(file.tags.catalogNumber)) +
          Number(Boolean(file.tags.barcode)),
        0,
      );
    return (
      pathPenalty(a) - pathPenalty(b) ||
      metadataScore(b) - metadataScore(a) ||
      a.folder.localeCompare(b.folder)
    );
  })[0]!;
}

function discFolderHint(folder: string): {
  discNumber: number;
  parentFolder: string;
} | null {
  const name = basename(folder);
  const match = name.match(
    /(?:^|[\s._-])(?:cd|disc|disk|碟|盘)[\s._-]*(\d+)\s*$/i,
  );
  if (!match) return null;
  return {
    discNumber: Number(match[1]),
    parentFolder: dirname(folder).replaceAll("\\", "/"),
  };
}

function withDiscNumber(
  file: ObservedMediaFile,
  discNumber: number | undefined,
): ObservedMediaFile {
  if (!discNumber || file.tags.discNumber === discNumber) return file;
  return { ...file, tags: { ...file.tags, discNumber } };
}

function analyzeTrackLayout(files: ObservedMediaFile[]): {
  discCount: number;
  issues: AlbumAggregationIssue[];
} {
  const actualDiscs = new Set(files.map((file) => file.tags.discNumber ?? 1));
  const declaredDiscTotal = Math.max(
    ...files.map((file) => file.tags.discTotal ?? 0),
    0,
  );
  const highestDiscNumber = Math.max(...actualDiscs, 1);
  const discCount = Math.max(declaredDiscTotal, highestDiscNumber, 1);
  const issues: AlbumAggregationIssue[] = [];
  const discTrackNumbers = new Map<number, Set<number>>();

  for (const discNumber of actualDiscs) {
    discTrackNumbers.set(
      discNumber,
      new Set(
        files
          .filter((file) => (file.tags.discNumber ?? 1) === discNumber)
          .map((file) => file.tags.trackNumber)
          .filter((value): value is number => value !== null),
      ),
    );
  }

  const declaredTotalsByDisc = new Map<number, Set<number>>();
  for (const discNumber of actualDiscs) {
    declaredTotalsByDisc.set(
      discNumber,
      new Set(
        files
          .filter((file) => (file.tags.discNumber ?? 1) === discNumber)
          .map((file) => file.tags.trackTotal)
          .filter((value): value is number => value !== null),
      ),
    );
  }

  const singleTotals = [...declaredTotalsByDisc.values()].map((totals) =>
    totals.size === 1 ? [...totals][0]! : null,
  );
  const firstDeclaredTrackTotal = singleTotals[0] ?? null;
  const sharedDeclaredTrackTotal =
    firstDeclaredTrackTotal !== null &&
    singleTotals.every(
      (total) => total !== null && total === firstDeclaredTrackTotal,
    )
      ? firstDeclaredTrackTotal
      : null;
  const highestLocalTrackNumber = Math.max(
    ...[...discTrackNumbers.values()].flatMap((numbers) => [...numbers]),
    0,
  );
  // A common TRACKTOTAL that is larger than every disc's local numbering is
  // an album-wide total (for example 66 tracks repeated on each of 3 discs),
  // not proof that every disc should contain 66 tracks.
  const likelyAlbumWideTrackTotal =
    actualDiscs.size > 1 &&
    sharedDeclaredTrackTotal !== null &&
    sharedDeclaredTrackTotal > highestLocalTrackNumber;

  // TRACKTOTAL is ambiguous in the wild: some taggers store a per-disc total,
  // while others store the whole box-set total alongside globally increasing
  // track numbers. Only treat it as a per-disc fact when every present disc is
  // locally anchored at track 1. Ambiguous numbering remains reviewable but
  // must not manufacture false MISSING_TRACK issues.
  const trustworthyPerDiscNumbering =
    actualDiscs.size === 1 ||
    [...actualDiscs].every(
      (discNumber) => discTrackNumbers.get(discNumber)?.has(1) === true,
    );

  for (let discNumber = 1; discNumber <= discCount; discNumber += 1) {
    if (!actualDiscs.has(discNumber)) {
      issues.push({
        code: "MISSING_DISC",
        discNumber,
        trackNumber: null,
        expected: discCount,
        actual: actualDiscs.size,
      });
    }
  }

  for (const discNumber of [...actualDiscs].sort((a, b) => a - b)) {
    const discFiles = files.filter(
      (file) => (file.tags.discNumber ?? 1) === discNumber,
    );
    const numberedTracks = new Map<number, number>();
    for (const file of discFiles) {
      if (file.tags.trackNumber === null) continue;
      numberedTracks.set(
        file.tags.trackNumber,
        (numberedTracks.get(file.tags.trackNumber) ?? 0) + 1,
      );
    }
    for (const [trackNumber, copies] of numberedTracks) {
      if (copies > 1) {
        issues.push({
          code: "DUPLICATE_TRACK_SLOT",
          discNumber,
          trackNumber,
          expected: 1,
          actual: copies,
        });
      }
    }

    const declaredTotals = declaredTotalsByDisc.get(discNumber) ?? new Set();
    const declaredTrackTotal =
      declaredTotals.size === 1 ? [...declaredTotals][0]! : null;
    const highestTrackNumber = Math.max(...numberedTracks.keys(), 0);
    // A trustworthy per-disc total needs one consistent declaration and local
    // numbering anchored at track 1. Disc 2 beginning at 13 is commonly global
    // box-set numbering and must not imply that tracks 1-12 are missing.
    const expectedTrackTotal =
      declaredTrackTotal !== null &&
      trustworthyPerDiscNumbering &&
      !likelyAlbumWideTrackTotal &&
      numberedTracks.has(1) &&
      highestTrackNumber <= declaredTrackTotal
        ? declaredTrackTotal
        : 0;
    for (
      let trackNumber = 1;
      trackNumber <= expectedTrackTotal;
      trackNumber += 1
    ) {
      if (!numberedTracks.has(trackNumber)) {
        issues.push({
          code: "MISSING_TRACK",
          discNumber,
          trackNumber,
          expected: expectedTrackTotal,
          actual: numberedTracks.size,
        });
      }
    }
  }

  return { discCount, issues };
}

export function stableFileId(rootId: string, relativePath: string): string {
  return stableId("file", rootId, relativePath);
}

function commonTrackArtist(files: ObservedMediaFile[]): string | null {
  const values = [
    ...new Set(
      files
        .flatMap((file) => file.tags.artists)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  return values.length === 1 ? values[0]! : values.length > 1 ? "群星" : null;
}

function albumFolder(relativePath: string): string {
  return dirname(relativePath).replaceAll("\\", "/");
}

function fallbackAlbum(relativePath: string): string {
  let folder = dirname(relativePath);
  if (/^(?:cd|disc|disk|碟|盘)[ _.-]*\d+$/i.test(basename(folder)))
    folder = dirname(folder);
  return basename(folder) || "未知专辑";
}

function fallbackArtist(relativePath: string): string {
  let folder = dirname(relativePath);
  if (/^(?:cd|disc|disk|碟|盘)[ _.-]*\d+$/i.test(basename(folder)))
    folder = dirname(folder);
  return basename(dirname(folder)) || "未知艺术家";
}

function compareTracks(
  a: ObservedMediaFile,
  b: ObservedMediaFile,
  discA?: number,
  discB?: number,
): number {
  return (
    (discA ?? a.tags.discNumber ?? 1) - (discB ?? b.tags.discNumber ?? 1) ||
    (a.tags.trackNumber ?? 9999) - (b.tags.trackNumber ?? 9999) ||
    a.relativePath.localeCompare(b.relativePath)
  );
}

function chooseSummary(specs: AudioSpec[]): AudioSpec | null {
  if (!specs.length) return null;
  return (
    [...specs].sort((a, b) => qualityOrder(b) - qualityOrder(a))[0] ?? null
  );
}

function qualityOrder(spec: AudioSpec): number {
  if (spec.kind === "DSD") return 10_000_000_000 + (spec.sampleRate ?? 0);
  return (spec.sampleRate ?? 0) * Math.max(spec.bitDepth ?? 1, 1);
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*&\s*/g, " & ");
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, { value: string; count: number }>();
  for (const value of values) {
    const key = normalize(value);
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { value, count: 1 });
  }
  return (
    [...counts.values()].sort(
      (a, b) => b.count - a.count || a.value.localeCompare(b.value),
    )[0]?.value ?? null
  );
}

function isNonEmpty(value: string | null | undefined): value is string {
  return Boolean(value?.trim());
}

function stableId(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("base64url")
    .slice(0, 32);
}

function firstNonNull<T>(values: Array<T | null | undefined>): T | null {
  return (
    values.find(
      (value): value is T =>
        value !== null && value !== undefined && value !== "",
    ) ?? null
  );
}

function emptyArtwork(): AlbumSummary["artwork"] {
  return {
    source: "NONE",
    url: null,
    mimeType: null,
    width: null,
    height: null,
  };
}
