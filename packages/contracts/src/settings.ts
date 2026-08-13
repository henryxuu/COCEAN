import { z } from "zod";

export const libraryRootSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostPathHint: z.string().nullable(),
  containerPath: z.string(),
  policy: z.enum(["WATCH_ONLY", "MANAGED"]),
  enabled: z.boolean(),
  autoDiscoveryEnabled: z.boolean(),
  autoDiscoveryIntervalMinutes: z.number().int().min(1).max(1440),
});
export type LibraryRoot = z.infer<typeof libraryRootSchema>;

export const coceanSettingsSchema = z.object({
  libraryRoots: z.array(libraryRootSchema),
  scanOnStart: z.boolean(),
  sourceWritebackEnabled: z.boolean(),
  deviceCopyMetadataEnabled: z.boolean(),
  naturalLanguageDiscoveryEnabled: z.boolean(),
  evidenceSummaryEnabled: z.boolean(),
  qobuzEnabled: z.boolean(),
  theme: z.enum(["SYSTEM", "LIGHT", "DARK"]),
});
export type CoceanSettings = z.infer<typeof coceanSettingsSchema>;
