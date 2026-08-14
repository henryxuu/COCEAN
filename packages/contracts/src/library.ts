import { z } from "zod";
import { audioSpecSchema } from "./audio.js";

export const physicalMediumSchema = z.enum([
  "CD",
  "SACD",
  "VINYL",
  "CASSETTE",
  "BLURAY_AUDIO",
  "OTHER",
]);
export type PhysicalMedium = z.infer<typeof physicalMediumSchema>;

export const matchStatusSchema = z.enum([
  "UNMATCHED",
  "NEEDS_REVIEW",
  "SOURCE_MATCHED",
  "USER_CONFIRMED",
  "TRACKS_INCOMPLETE",
]);
export type MatchStatus = z.infer<typeof matchStatusSchema>;

export const albumAggregationIssueSchema = z.object({
  code: z.enum(["MISSING_DISC", "MISSING_TRACK", "DUPLICATE_TRACK_SLOT"]),
  discNumber: z.number().int().positive().nullable(),
  trackNumber: z.number().int().positive().nullable(),
  expected: z.number().int().nonnegative().nullable(),
  actual: z.number().int().nonnegative().nullable(),
});
export type AlbumAggregationIssue = z.infer<typeof albumAggregationIssueSchema>;

export const libraryIssueCodeSchema = z.enum([
  "IDENTITY_OVERLAP",
  "INCOMPLETE_TRACKS",
  "MISSING_ARTWORK",
  "LOW_RES_ARTWORK",
  "MIXED_AUDIO_SPECS",
  "BROKEN_TEXT",
  "MISSING_IDENTITY",
]);
export type LibraryIssueCode = z.infer<typeof libraryIssueCodeSchema>;

export const libraryIssueSchema = z.object({
  code: libraryIssueCodeSchema,
  versionId: z.string().nullable(),
  evidence: z.record(z.string(), z.unknown()),
});
export type LibraryIssue = z.infer<typeof libraryIssueSchema>;

export const libraryAlbumPrimaryVersionSourceSchema = z.enum([
  "AUTOMATIC",
  "USER",
]);
export type LibraryAlbumPrimaryVersionSource = z.infer<
  typeof libraryAlbumPrimaryVersionSourceSchema
>;

const identityDecisionBaseSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  revision: z.number().int().nonnegative(),
});

export const libraryIdentityDecisionCommandSchema = z.discriminatedUnion(
  "type",
  [
    identityDecisionBaseSchema.extend({
      type: z.literal("CONFIRM"),
      primaryVersionId: z.string().min(1).optional(),
    }),
    identityDecisionBaseSchema.extend({
      type: z.literal("MERGE"),
      targetLibraryAlbumId: z.string().min(1),
      targetRevision: z.number().int().nonnegative(),
      primaryVersionId: z.string().min(1),
    }),
    identityDecisionBaseSchema.extend({
      type: z.literal("SPLIT"),
      partitions: z
        .array(
          z.object({
            versionIds: z.array(z.string().min(1)).min(1).max(100),
            primaryVersionId: z.string().min(1).optional(),
          }),
        )
        .min(2)
        .max(100),
    }),
    identityDecisionBaseSchema.extend({
      type: z.literal("SET_PRIMARY"),
      primaryVersionId: z.string().min(1),
    }),
  ],
);
export type LibraryIdentityDecisionCommand = z.infer<
  typeof libraryIdentityDecisionCommandSchema
>;

export const undoLibraryIdentityDecisionCommandSchema =
  identityDecisionBaseSchema;
export type UndoLibraryIdentityDecisionCommand = z.infer<
  typeof undoLibraryIdentityDecisionCommandSchema
>;

export const libraryIdentityDecisionSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  libraryAlbumId: z.string(),
  type: z.enum(["CONFIRM", "MERGE", "SPLIT", "SET_PRIMARY", "UNDO"]),
  actor: z.object({ id: z.string(), displayName: z.string() }),
  expectedRevision: z.number().int().nonnegative(),
  resultingRevision: z.number().int().nonnegative(),
  details: z.object({
    targetLibraryAlbumId: z.string().nullable(),
    primaryVersionId: z.string().nullable(),
    partitions: z.array(
      z.object({
        versionIds: z.array(z.string()),
        primaryVersionId: z.string().nullable(),
      }),
    ),
    compensatedDecisionId: z.string().nullable(),
  }),
  affectedLibraryAlbumIds: z.array(z.string()),
  compensatesDecisionId: z.string().nullable(),
  canUndo: z.boolean(),
  createdAt: z.string(),
});
export type LibraryIdentityDecision = z.infer<
  typeof libraryIdentityDecisionSchema
>;

export const libraryIdentityDecisionResultSchema = z.object({
  decision: libraryIdentityDecisionSchema,
  currentLibraryAlbumId: z.string(),
  affectedLibraryAlbumIds: z.array(z.string()),
});
export type LibraryIdentityDecisionResult = z.infer<
  typeof libraryIdentityDecisionResultSchema
>;

export const localVersionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  albumArtist: z.string(),
  year: z.number().int().nullable(),
  isPrimary: z.boolean(),
  relationshipStatus: z.enum([
    "AUTO_CANDIDATE",
    "USER_CONFIRMED",
    "USER_SEPARATE",
  ]),
  sourceRoot: z
    .object({
      id: z.string(),
      name: z.string(),
      containerPath: z.string(),
      readOnly: z.boolean(),
    })
    .nullable(),
  relativePath: z.string().nullable(),
  audioBadge: z.string().nullable(),
  mixedAudioSpecs: z.boolean(),
  trackCount: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  sourceVersionCount: z.number().int().positive(),
  duplicateFileCount: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  completeness: z.enum(["COMPLETE", "INCOMPLETE", "NEEDS_REVIEW"]),
  issues: z.array(libraryIssueSchema),
});
export type LocalVersionSummary = z.infer<typeof localVersionSummarySchema>;

export const artworkSchema = z.object({
  source: z.enum([
    "EMBEDDED",
    "SIDECAR",
    "EXACT_RELEASE",
    "REPRESENTATIVE",
    "NONE",
  ]),
  url: z.string().nullable(),
  mimeType: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});
export type Artwork = z.infer<typeof artworkSchema>;

export const albumSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  albumArtist: z.string(),
  year: z.number().int().nullable(),
  artwork: artworkSchema,
  audioBadge: z.string().nullable(),
  audioSummary: audioSpecSchema.nullable(),
  mixedAudioSpecs: z.boolean(),
  hasDigital: z.boolean(),
  physicalMedia: z.array(physicalMediumSchema),
  matchStatus: matchStatusSchema,
  trackCount: z.number().int().nonnegative(),
  discCount: z.number().int().positive(),
  sourceVersionCount: z.number().int().positive().optional(),
  duplicateFileCount: z.number().int().nonnegative().optional(),
  aggregationIssues: z.array(albumAggregationIssueSchema).optional(),
  primaryVersionId: z.string().optional(),
  primaryVersionSource: libraryAlbumPrimaryVersionSourceSchema,
  revision: z.number().int().nonnegative(),
  versionCount: z.number().int().positive().optional(),
  issues: z.array(libraryIssueSchema).optional(),
});
export type AlbumSummary = z.infer<typeof albumSummarySchema>;

export const physicalCopySchema = z.object({
  id: z.string(),
  albumId: z.string(),
  medium: physicalMediumSchema,
  label: z.string().nullable(),
  catalogNumber: z.string().nullable(),
  barcode: z.string().nullable(),
  country: z.string().nullable(),
  releaseYear: z.number().int().nullable(),
  quantity: z.number().int().positive(),
  conditionNote: z.string().nullable(),
  storageLocation: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PhysicalCopy = z.infer<typeof physicalCopySchema>;

export const trackSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  discNumber: z.number().int().positive().nullable(),
  trackNumber: z.number().int().positive().nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  audioSpec: audioSpecSchema,
  relativePath: z.string(),
  warningCodes: z.array(z.string()),
});
export type TrackSummary = z.infer<typeof trackSummarySchema>;

export const albumDetailSchema = albumSummarySchema.extend({
  release: z.object({
    label: z.string().nullable(),
    catalogNumber: z.string().nullable(),
    barcode: z.string().nullable(),
    country: z.string().nullable(),
    releaseDate: z.string().nullable(),
    musicBrainzReleaseId: z.string().nullable(),
  }),
  tracks: z.array(trackSummarySchema),
  physicalCopies: z.array(physicalCopySchema),
  sourceRoot: z
    .object({
      id: z.string(),
      name: z.string(),
      containerPath: z.string(),
      readOnly: z.boolean(),
    })
    .nullable(),
  localVersions: z.array(localVersionSummarySchema).optional(),
});
export type AlbumDetail = z.infer<typeof albumDetailSchema>;

export const libraryStatsSchema = z.object({
  albums: z.number().int().nonnegative(),
  tracks: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  needsReview: z.number().int().nonnegative(),
  missingArtwork: z.number().int().nonnegative(),
  parseFailures: z.number().int().nonnegative(),
  lastScanAt: z.string().nullable(),
  pendingGroups: z.number().int().nonnegative(),
  incompleteAlbums: z.number().int().nonnegative(),
  lowResolutionArtwork: z.number().int().nonnegative(),
  brokenIdentity: z.number().int().nonnegative(),
  recentlyAdded: z.number().int().nonnegative(),
});
export type LibraryStats = z.infer<typeof libraryStatsSchema>;
