import { z } from "zod";

export const albumVisibilitySchema = z.enum(["VISIBLE", "HIDDEN"]);
export type AlbumVisibility = z.infer<typeof albumVisibilitySchema>;

export const albumVisibilityCommandSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  expectedVisibilityRevision: z.number().int().nonnegative(),
  action: z.enum(["HIDE", "RESTORE"]),
});
export type AlbumVisibilityCommand = z.infer<
  typeof albumVisibilityCommandSchema
>;

export const albumVisibilityEventSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  libraryAlbumId: z.string(),
  type: z.enum(["HIDE", "RESTORE"]),
  actor: z.object({ id: z.string(), displayName: z.string() }),
  expectedVisibilityRevision: z.number().int().nonnegative(),
  resultingVisibilityRevision: z.number().int().nonnegative(),
  before: albumVisibilitySchema,
  after: albumVisibilitySchema,
  createdAt: z.string(),
});
export type AlbumVisibilityEvent = z.infer<typeof albumVisibilityEventSchema>;

export const albumVisibilityMutationResultSchema = z.object({
  libraryAlbumId: z.string(),
  visibility: albumVisibilitySchema,
  visibilityRevision: z.number().int().nonnegative(),
  event: albumVisibilityEventSchema,
});
export type AlbumVisibilityMutationResult = z.infer<
  typeof albumVisibilityMutationResultSchema
>;

export const libraryChangeActionSchema = z.enum([
  "QUARANTINE_VERSION",
  "RESTORE_VERSION",
]);
export type LibraryChangeAction = z.infer<typeof libraryChangeActionSchema>;

export const libraryChangePlanStatusSchema = z.enum([
  "PREVIEWED",
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "RECOVERY_REQUIRED",
  "CANCELLED",
]);
export type LibraryChangePlanStatus = z.infer<
  typeof libraryChangePlanStatusSchema
>;

export const localVersionLifecycleSchema = z.enum([
  "ACTIVE",
  "QUARANTINING",
  "QUARANTINED",
  "RESTORING",
  "RECOVERY_REQUIRED",
]);
export type LocalVersionLifecycle = z.infer<typeof localVersionLifecycleSchema>;

export const libraryChangeItemStatusSchema = z.enum([
  "PENDING",
  "SOURCE",
  "QUARANTINED",
  "RESTORED",
  "CONFLICT",
  "MISSING",
  "FAILED",
]);
export type LibraryChangeItemStatus = z.infer<
  typeof libraryChangeItemStatusSchema
>;

export const libraryChangeBlockerSchema = z.object({
  code: z.enum([
    "WATCH_ONLY_ROOT",
    "ROOT_NOT_WRITABLE",
    "CROSS_ROOT_VERSION",
    "MISSING_SHA256",
    "ACTIVE_SCAN",
    "ACTIVE_DELIVERY",
    "ACTIVE_LIFECYCLE_PLAN",
    "ACTOR_NOT_AUTHORIZED",
    "PLAN_STALE",
    "SOURCE_UNAVAILABLE",
    "TARGET_CONFLICT",
  ]),
  message: z.string(),
});
export type LibraryChangeBlocker = z.infer<typeof libraryChangeBlockerSchema>;

export const libraryChangePlanItemSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  mediaFileId: z.string().nullable(),
  sourceRelativePath: z.string(),
  quarantineRelativePath: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  status: libraryChangeItemStatusSchema,
  finalSizeBytes: z.number().int().nonnegative().nullable(),
  finalSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  error: z.string().nullable(),
});
export type LibraryChangePlanItem = z.infer<typeof libraryChangePlanItemSchema>;

export const libraryChangePlanSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  action: libraryChangeActionSchema,
  status: libraryChangePlanStatusSchema,
  libraryAlbumId: z.string(),
  localVersionId: z.string(),
  root: z.object({
    id: z.string(),
    name: z.string(),
    policy: z.enum(["WATCH_ONLY", "MANAGED"]),
  }),
  sourcePlanId: z.string().nullable(),
  expectedLibraryRevision: z.number().int().nonnegative(),
  executable: z.boolean(),
  blockers: z.array(libraryChangeBlockerSchema),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  items: z.array(libraryChangePlanItemSchema),
  actor: z.object({ id: z.string(), displayName: z.string() }),
  error: z.string().nullable(),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type LibraryChangePlan = z.infer<typeof libraryChangePlanSchema>;

export const libraryChangePlanSummarySchema = libraryChangePlanSchema
  .omit({ requestId: true, items: true, actor: true })
  .extend({ completedFiles: z.number().int().nonnegative() });
export type LibraryChangePlanSummary = z.infer<
  typeof libraryChangePlanSummarySchema
>;

export const libraryChangePlanObjectSchema = z.object({
  title: z.string().min(1),
  albumArtist: z.string().nullable(),
});
export type LibraryChangePlanObject = z.infer<
  typeof libraryChangePlanObjectSchema
>;

const libraryChangePlanReadFields = {
  object: libraryChangePlanObjectSchema,
  completedFiles: z.number().int().nonnegative(),
};

export const libraryChangePlanMemberReadSchema = z.object({
  id: z.string(),
  action: libraryChangeActionSchema,
  status: libraryChangePlanStatusSchema,
  sourcePlanId: z.string().nullable(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  error: z.string().nullable(),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  ...libraryChangePlanReadFields,
});
export type LibraryChangePlanMemberRead = z.infer<
  typeof libraryChangePlanMemberReadSchema
>;

export const libraryChangePlanReadSchema = z.union([
  libraryChangePlanSchema.extend(libraryChangePlanReadFields),
  libraryChangePlanMemberReadSchema,
]);
export type LibraryChangePlanRead = z.infer<typeof libraryChangePlanReadSchema>;

export const libraryChangePlanListResponseSchema = z.object({
  items: z.array(libraryChangePlanReadSchema),
});
export type LibraryChangePlanListResponse = z.infer<
  typeof libraryChangePlanListResponseSchema
>;

export const recentlyDeletedItemSchema = z.object({
  source: libraryChangePlanReadSchema,
  latestRestore: libraryChangePlanReadSchema.nullable(),
});
export type RecentlyDeletedItem = z.infer<typeof recentlyDeletedItemSchema>;

export const recentlyDeletedResponseSchema = z.object({
  items: z.array(recentlyDeletedItemSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type RecentlyDeletedResponse = z.infer<
  typeof recentlyDeletedResponseSchema
>;

export const createQuarantinePlanCommandSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  expectedLibraryRevision: z.number().int().nonnegative(),
  localVersionId: z.string().min(1),
});
export type CreateQuarantinePlanCommand = z.infer<
  typeof createQuarantinePlanCommandSchema
>;

export const confirmLibraryChangePlanCommandSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
});
export type ConfirmLibraryChangePlanCommand = z.infer<
  typeof confirmLibraryChangePlanCommandSchema
>;

export const createRestorePlanCommandSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
});
export type CreateRestorePlanCommand = z.infer<
  typeof createRestorePlanCommandSchema
>;
