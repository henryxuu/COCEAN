import { z } from "zod";

export const deviceOwnershipSchema = z.enum([
  "OWNED",
  "BORROWED",
  "SOLD",
  "WISHLIST",
]);
export type DeviceOwnership = z.infer<typeof deviceOwnershipSchema>;

export const deviceCategorySchema = z.enum([
  "DAP",
  "DAC",
  "AMPLIFIER",
  "HEADPHONE",
  "SPEAKER",
  "STREAMER",
  "OTHER",
]);
export type DeviceCategory = z.infer<typeof deviceCategorySchema>;

export const deviceCapabilitiesSchema = z.object({
  maxPcmSampleRate: z.number().int().positive().nullable(),
  maxPcmBitDepth: z.number().int().positive().nullable(),
  maxDsdRate: z.enum(["DSD64", "DSD128", "DSD256", "DSD512"]).nullable(),
  supportedFormats: z.array(z.string()),
  source: z.string().nullable(),
  verifiedAt: z.string().nullable(),
});
export type DeviceCapabilities = z.infer<typeof deviceCapabilitiesSchema>;

export const ownedDeviceSchema = z.object({
  id: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  category: deviceCategorySchema,
  ownership: deviceOwnershipSchema,
  nickname: z.string().nullable(),
  serialNumber: z.string().nullable(),
  notes: z.string().nullable(),
  capabilities: deviceCapabilitiesSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OwnedDevice = z.infer<typeof ownedDeviceSchema>;

export const deliveryTargetSchema = z.object({
  id: z.string(),
  deviceId: z.string().nullable(),
  name: z.string(),
  kind: z.enum(["MOUNTED_VOLUME", "NETWORK"]),
  transport: z.enum([
    "USB_MOUNT",
    "SMB",
    "SFTP",
    "FTP",
    "AK_FILE_DROP",
    "OTHER",
  ]),
  location: z.string(),
  username: z.string().nullable(),
  credentialConfigured: z.boolean(),
  enabled: z.boolean(),
  verifiedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DeliveryTarget = z.infer<typeof deliveryTargetSchema>;

export const deliveryJobStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type DeliveryJobStatus = z.infer<typeof deliveryJobStatusSchema>;

export const deliveryJobSchema = z.object({
  id: z.string(),
  albumId: z.string(),
  albumTitle: z.string().nullable().optional(),
  targetId: z.string(),
  targetName: z.string(),
  transport: deliveryTargetSchema.shape.transport,
  status: deliveryJobStatusSchema,
  fileCount: z.number().int().nonnegative(),
  completedFileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  transferredBytes: z.number().int().nonnegative(),
  verified: z.boolean(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  planId: z.string().nullable().optional(),
});
export type DeliveryJob = z.infer<typeof deliveryJobSchema>;
