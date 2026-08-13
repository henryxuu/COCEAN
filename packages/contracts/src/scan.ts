import { z } from "zod";
import { audioSpecSchema } from "./audio.js";

export const scanJobStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "COMPLETED_WITH_WARNINGS",
  "FAILED",
  "CANCELLED",
]);
export type ScanJobStatus = z.infer<typeof scanJobStatusSchema>;

export const scanModeSchema = z.enum(["INCREMENTAL", "FULL"]);
export type ScanMode = z.infer<typeof scanModeSchema>;

export const scanTriggerSourceSchema = z.enum([
  "MANUAL",
  "AUTO_DISCOVERY",
  "RETRY",
]);
export type ScanTriggerSource = z.infer<typeof scanTriggerSourceSchema>;

export const scanJobSchema = z.object({
  id: z.string(),
  rootId: z.string(),
  mode: scanModeSchema,
  triggerSource: scanTriggerSourceSchema,
  retryOfScanJobId: z.string().nullable(),
  status: scanJobStatusSchema,
  totalFiles: z.number().int().nonnegative(),
  processedFiles: z.number().int().nonnegative(),
  parsedFiles: z.number().int().nonnegative(),
  failedFiles: z.number().int().nonnegative(),
  reusedFiles: z.number().int().nonnegative(),
  stableAlbumDirectories: z.number().int().nonnegative(),
  deferredAlbumDirectories: z.number().int().nonnegative(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  cancelRequestedAt: z.string().nullable(),
});
export type ScanJob = z.infer<typeof scanJobSchema>;

export const scanFailureSchema = z.object({
  id: z.number().int().positive(),
  scanJobId: z.string(),
  rootId: z.string(),
  relativePath: z.string(),
  code: z.string(),
  stage: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
  createdAt: z.string(),
});
export type ScanFailure = z.infer<typeof scanFailureSchema>;

export const scanFileCandidateKindSchema = z.enum([
  "SUPPORTED_AUDIO",
  "KNOWN_UNSUPPORTED_AUDIO",
  "SYMLINK",
  "TRAVERSAL_ERROR",
]);
export type ScanFileCandidateKind = z.infer<typeof scanFileCandidateKindSchema>;

export const scanFileOutcomeSchema = z.enum([
  "PARSED",
  "UNSUPPORTED",
  "FAILED",
  "SKIPPED",
]);
export type ScanFileOutcome = z.infer<typeof scanFileOutcomeSchema>;

/**
 * Immutable, path-redacted observation for one scan. `relativePath` is always
 * relative to the configured library root; absolute NAS paths are forbidden.
 */
export const scanFileResultSchema = z.object({
  id: z.number().int().positive(),
  scanJobId: z.string(),
  rootId: z.string(),
  relativePath: z.string().min(1),
  extension: z.string(),
  candidateKind: scanFileCandidateKindSchema,
  outcome: scanFileOutcomeSchema,
  mediaFileId: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  modifiedAtMs: z.number().nonnegative().nullable(),
  errorCode: z.string().nullable(),
  errorStage: z.string().nullable(),
  warningCodes: z.array(z.string()),
  createdAt: z.string(),
});
export type ScanFileResult = z.infer<typeof scanFileResultSchema>;

export const scanReportSchema = z.object({
  scanJobId: z.string(),
  rootId: z.string(),
  status: scanJobStatusSchema,
  rulesVersion: z.string().min(1),
  summaryHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** Supported plus known-unsupported audio candidates only. */
  candidateScope: z.literal("SUPPORTED_AND_KNOWN_UNSUPPORTED_AUDIO"),
  candidates: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  parsed: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  unprocessed: z.number().int().nonnegative(),
  regularFiles: z.number().int().nonnegative(),
  auxiliaryFiles: z.number().int().nonnegative(),
  ignoredFiles: z.number().int().nonnegative(),
  skippedSymlinks: z.number().int().nonnegative(),
  traversalErrors: z.number().int().nonnegative(),
  albumCount: z.number().int().nonnegative().nullable(),
  albumIssueCount: z.number().int().nonnegative().nullable(),
  trackSemantics: z.literal("ONE_AUDIO_FILE_ONE_TRACK"),
  cueSheetSupport: z.literal("AUXILIARY_ONLY"),
  invariants: z.object({
    candidateBalance: z.boolean(),
    outcomeBalance: z.boolean(),
    regularFileBalance: z.boolean(),
    boundaryEvidence: z.boolean(),
    valid: z.boolean(),
  }),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
});
export type ScanReport = z.infer<typeof scanReportSchema>;

export const observedTagSchema = z.object({
  album: z.string().nullable(),
  albumArtist: z.string().nullable(),
  title: z.string().nullable(),
  artists: z.array(z.string()),
  year: z.number().int().nullable(),
  date: z.string().nullable(),
  genre: z.array(z.string()),
  composer: z.array(z.string()),
  label: z.array(z.string()),
  catalogNumber: z.string().nullable(),
  barcode: z.string().nullable(),
  musicBrainzReleaseId: z.string().nullable(),
  discNumber: z.number().int().positive().nullable(),
  discTotal: z.number().int().positive().nullable(),
  trackNumber: z.number().int().positive().nullable(),
  trackTotal: z.number().int().positive().nullable(),
});
export type ObservedTag = z.infer<typeof observedTagSchema>;

export const observedRawTagSchema = z.object({
  source: z.string().min(1),
  id: z.string().min(1),
  valueKind: z.enum(["TEXT", "NUMBER", "BOOLEAN", "BINARY", "STRUCTURED"]),
  /**
   * Deterministic text representation of the original native tag value.
   * Binary payloads are represented by byte length and SHA-256, never copied
   * into the database a second time.
   */
  value: z.string(),
});
export type ObservedRawTag = z.infer<typeof observedRawTagSchema>;

export const artworkCandidateSchema = z.object({
  source: z.enum(["EMBEDDED", "SIDECAR"]),
  path: z.string().nullable(),
  mimeType: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  kind: z.string().nullable(),
});
export type ArtworkCandidate = z.infer<typeof artworkCandidateSchema>;

export const observedMediaFileSchema = z.object({
  absolutePath: z.string(),
  relativePath: z.string(),
  extension: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAtMs: z.number().nonnegative(),
  /** Null is reserved for observations created before checksum migration v7. */
  fileSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  audio: audioSpecSchema,
  durationSeconds: z.number().nonnegative().nullable(),
  tags: observedTagSchema,
  rawTags: z.array(observedRawTagSchema),
  artwork: z.array(artworkCandidateSchema),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});
export type ObservedMediaFile = z.infer<typeof observedMediaFileSchema>;
