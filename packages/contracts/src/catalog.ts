import { z } from "zod";

export const stillCatalogAlbumSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  artist: z.string().min(1),
  recordingFamilyId: z.string().nullable(),
  releaseFamilyId: z.string().nullable(),
  domains: z.array(z.string().min(1)),
  features: z.array(z.string().min(1)),
  sourceKind: z.string().min(1),
  sourceRef: z.string().min(1),
  verifiedAt: z.string(),
  contentVersion: z.string().min(1),
});
export type StillCatalogAlbum = z.infer<typeof stillCatalogAlbumSchema>;

export const stillRuntimeCatalogSchema = z.object({
  schemaId: z.literal("cocean.still-runtime-catalog"),
  schemaVersion: z.literal("1.0.0"),
  source: z.object({
    schemaId: z.string().min(1),
    schemaVersion: z.string().min(1),
    contentVersion: z.string().min(1),
    contentChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  recordCount: z.number().int().nonnegative(),
  rejectedRecordCount: z.number().int().nonnegative(),
  records: z.array(stillCatalogAlbumSchema),
  runtimeChecksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export type StillRuntimeCatalog = z.infer<typeof stillRuntimeCatalogSchema>;

export const stillCatalogStatusSchema = z.object({
  configuredPath: z.string(),
  fileAvailable: z.boolean(),
  activeContentVersion: z.string().nullable(),
  sourceSchemaId: z.string().nullable(),
  sourceSchemaVersion: z.string().nullable(),
  recordCount: z.number().int().nonnegative(),
  runtimeChecksum: z.string().nullable(),
  installedAt: z.string().nullable(),
  lastLoadError: z.string().nullable(),
});
export type StillCatalogStatus = z.infer<typeof stillCatalogStatusSchema>;
