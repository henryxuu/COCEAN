import { z } from "zod";
import { audioSpecSchema } from "./audio.js";
import {
  albumVisibilitySchema,
  localVersionLifecycleSchema,
} from "./lifecycle.js";

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
  resolutionStatus: z
    .enum(["PENDING", "RESOLVED_BY_METADATA", "RESOLVED_BY_ARTWORK"])
    .optional(),
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

export const metadataValueSourceSchema = z.enum([
  "USER_OVERRIDE",
  "CONFIRMED_EXTERNAL",
  "OBSERVED_TAG",
  "PATH_FALLBACK",
]);
export type MetadataValueSource = z.infer<typeof metadataValueSourceSchema>;

export const albumMetadataFieldSchema = z.enum([
  "title",
  "albumArtist",
  "year",
]);
export type AlbumMetadataField = z.infer<typeof albumMetadataFieldSchema>;
export const versionMetadataFieldSchema = z.enum([
  "label",
  "catalogNumber",
  "barcode",
  "country",
  "releaseDate",
]);
export type VersionMetadataField = z.infer<typeof versionMetadataFieldSchema>;
export const metadataFieldSchema = z.union([
  albumMetadataFieldSchema,
  versionMetadataFieldSchema,
]);
export type MetadataField = z.infer<typeof metadataFieldSchema>;

export const metadataFieldValueSchema = z.union([
  z.string(),
  z.number().int(),
  z.null(),
]);
export type MetadataFieldValue = z.infer<typeof metadataFieldValueSchema>;

export const metadataFieldStateSchema = z.object({
  observed: z.object({
    value: metadataFieldValueSchema,
    source: z.enum(["OBSERVED_TAG", "PATH_FALLBACK"]),
    versionId: z.string(),
  }),
  confirmedExternal: z
    .object({
      value: metadataFieldValueSchema,
      provider: z.string(),
      candidateId: z.string(),
      confirmedAt: z.string(),
    })
    .nullable(),
  userOverride: z
    .object({
      value: metadataFieldValueSchema,
      actor: z.object({ id: z.string(), displayName: z.string() }),
      updatedAt: z.string(),
    })
    .nullable(),
  effectiveValue: metadataFieldValueSchema,
  effectiveSource: metadataValueSourceSchema,
});
export type MetadataFieldState = z.infer<typeof metadataFieldStateSchema>;

export const albumMetadataSchema = z.object({
  libraryAlbumId: z.string(),
  metadataRevision: z.number().int().nonnegative(),
  album: z.object({
    title: metadataFieldStateSchema,
    albumArtist: metadataFieldStateSchema,
    year: metadataFieldStateSchema,
  }),
  versions: z.array(
    z.object({
      versionId: z.string(),
      fields: z.object({
        label: metadataFieldStateSchema,
        catalogNumber: metadataFieldStateSchema,
        barcode: metadataFieldStateSchema,
        country: metadataFieldStateSchema,
        releaseDate: metadataFieldStateSchema,
      }),
    }),
  ),
  observedIssues: z.array(libraryIssueSchema),
});
export type AlbumMetadata = z.infer<typeof albumMetadataSchema>;

const metadataCommandBaseSchema = z.object({
  field: metadataFieldSchema,
  versionId: z.string().min(1).optional(),
});
export const metadataCommandSchema = z.discriminatedUnion("action", [
  metadataCommandBaseSchema.extend({
    action: z.literal("SET"),
    value: z.union([z.string(), z.number().int()]),
  }),
  metadataCommandBaseSchema.extend({ action: z.literal("CLEAR") }),
  metadataCommandBaseSchema.extend({ action: z.literal("RESET") }),
]);
export type MetadataCommand = z.infer<typeof metadataCommandSchema>;

export const updateAlbumMetadataCommandSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  expectedMetadataRevision: z.number().int().nonnegative(),
  commands: z.array(metadataCommandSchema).min(1).max(8),
});
export type UpdateAlbumMetadataCommand = z.infer<
  typeof updateAlbumMetadataCommandSchema
>;

export const undoAlbumMetadataCommandSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  expectedMetadataRevision: z.number().int().nonnegative(),
});
export type UndoAlbumMetadataCommand = z.infer<
  typeof undoAlbumMetadataCommandSchema
>;

export const confirmReleaseCandidateCommandSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  expectedMetadataRevision: z.number().int().nonnegative(),
  localVersionId: z.string().min(1),
});
export type ConfirmReleaseCandidateCommand = z.infer<
  typeof confirmReleaseCandidateCommandSchema
>;

export const albumMetadataEventSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  libraryAlbumId: z.string(),
  type: z.enum(["UPDATE", "CONFIRM_EXTERNAL", "UNDO"]),
  actor: z.object({ id: z.string(), displayName: z.string() }),
  expectedMetadataRevision: z.number().int().nonnegative(),
  resultingMetadataRevision: z.number().int().nonnegative(),
  commands: z.array(metadataCommandSchema),
  compensatesEventId: z.string().nullable(),
  canUndo: z.boolean(),
  createdAt: z.string(),
});
export type AlbumMetadataEvent = z.infer<typeof albumMetadataEventSchema>;

export const albumMetadataMutationResultSchema = z.object({
  metadata: albumMetadataSchema,
  event: albumMetadataEventSchema,
});
export type AlbumMetadataMutationResult = z.infer<
  typeof albumMetadataMutationResultSchema
>;

export const localVersionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  albumArtist: z.string(),
  year: z.number().int().nullable(),
  matchStatus: matchStatusSchema.optional(),
  musicBrainzReleaseId: z.string().nullable().optional(),
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
  lifecycleStatus: localVersionLifecycleSchema.optional(),
});
export type LocalVersionSummary = z.infer<typeof localVersionSummarySchema>;

export const artworkSchema = z.object({
  source: z.enum([
    "EMBEDDED",
    "SIDECAR",
    "EXACT_RELEASE",
    "REPRESENTATIVE",
    "USER_UPLOAD",
    "MUSICBRAINZ_CAA",
    "NONE",
  ]),
  url: z.string().nullable(),
  mimeType: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});
export type Artwork = z.infer<typeof artworkSchema>;

export const artworkSelectionSourceSchema = z.enum([
  "USER_SELECTED",
  "USER_HIDDEN",
  "AUTOMATIC_PRIMARY",
  "AUTOMATIC_REPRESENTATIVE",
  "NONE",
]);
export type ArtworkSelectionSource = z.infer<
  typeof artworkSelectionSourceSchema
>;

export const artworkCandidateSourceSchema = z.enum([
  "OBSERVED_EMBEDDED",
  "OBSERVED_SIDECAR",
  "USER_UPLOAD",
  "MUSICBRAINZ_CAA",
]);
export type ArtworkCandidateSource = z.infer<
  typeof artworkCandidateSourceSchema
>;

export const governedArtworkCandidateSchema = z.object({
  id: z.string(),
  assetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  source: artworkCandidateSourceSchema,
  localVersionId: z.string().nullable(),
  relativePath: z.string().nullable(),
  kind: z.string().nullable(),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative(),
  url: z.string(),
  current: z.boolean(),
  selected: z.boolean(),
  lowResolution: z.boolean(),
  evidence: z.record(z.string(), z.unknown()),
});
export type GovernedArtworkCandidate = z.infer<
  typeof governedArtworkCandidateSchema
>;

export const albumArtworkGovernanceSchema = z.object({
  libraryAlbumId: z.string(),
  artworkRevision: z.number().int().nonnegative(),
  effectiveArtwork: artworkSchema,
  selectionSource: artworkSelectionSourceSchema,
  selectedAssetSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  selectedCandidateId: z.string().nullable(),
  candidates: z.array(governedArtworkCandidateSchema).max(100),
  truncated: z.boolean(),
});
export type AlbumArtworkGovernance = z.infer<
  typeof albumArtworkGovernanceSchema
>;

const artworkDecisionBaseSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  expectedArtworkRevision: z.number().int().nonnegative(),
});

export const artworkDecisionCommandSchema = z.discriminatedUnion("action", [
  artworkDecisionBaseSchema.extend({
    action: z.literal("SELECT"),
    candidateId: z.string().min(1),
  }),
  artworkDecisionBaseSchema.extend({ action: z.literal("HIDE") }),
  artworkDecisionBaseSchema.extend({ action: z.literal("RESET") }),
]);
export type ArtworkDecisionCommand = z.infer<
  typeof artworkDecisionCommandSchema
>;

export const importMusicBrainzArtworkCommandSchema =
  artworkDecisionBaseSchema.extend({ localVersionId: z.string().min(1) });
export type ImportMusicBrainzArtworkCommand = z.infer<
  typeof importMusicBrainzArtworkCommandSchema
>;

export const undoAlbumArtworkCommandSchema = artworkDecisionBaseSchema.pick({
  requestId: true,
  expectedArtworkRevision: true,
});
export type UndoAlbumArtworkCommand = z.infer<
  typeof undoAlbumArtworkCommandSchema
>;

export const albumArtworkEventSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  libraryAlbumId: z.string(),
  type: z.enum(["SELECT", "HIDE", "RESET", "UPLOAD", "IMPORT", "UNDO"]),
  actor: z.object({ id: z.string(), displayName: z.string() }),
  expectedArtworkRevision: z.number().int().nonnegative(),
  resultingArtworkRevision: z.number().int().nonnegative(),
  assetSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  candidateId: z.string().nullable(),
  compensatesEventId: z.string().nullable(),
  canUndo: z.boolean(),
  createdAt: z.string(),
});
export type AlbumArtworkEvent = z.infer<typeof albumArtworkEventSchema>;

export const albumArtworkMutationResultSchema = z.object({
  artwork: albumArtworkGovernanceSchema,
  event: albumArtworkEventSchema,
});
export type AlbumArtworkMutationResult = z.infer<
  typeof albumArtworkMutationResultSchema
>;

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
  metadataRevision: z.number().int().nonnegative().optional(),
  versionCount: z.number().int().positive().optional(),
  issues: z.array(libraryIssueSchema).optional(),
  visibility: albumVisibilitySchema.optional(),
  visibilityRevision: z.number().int().nonnegative().optional(),
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
  metadata: albumMetadataSchema.optional(),
  artworkGovernance: albumArtworkGovernanceSchema.optional(),
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
