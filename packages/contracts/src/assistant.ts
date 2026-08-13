import { z } from "zod";

export const modelVerificationStatusSchema = z.enum([
  "UNVERIFIED",
  "VERIFIED",
  "FAILED",
]);
export type ModelVerificationStatus = z.infer<
  typeof modelVerificationStatusSchema
>;

export const modelConfigurationSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string(),
  model: z.string(),
  apiKeyConfigured: z.boolean(),
  verificationStatus: modelVerificationStatusSchema,
  lastCheckedAt: z.string().nullable(),
  verificationMessage: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type ModelConfiguration = z.infer<typeof modelConfigurationSchema>;

export const albumIntroductionSchema = z.object({
  albumId: z.string(),
  content: z.string(),
  model: z.string(),
  generatedAt: z.string(),
  factualBasis: z.array(z.string()),
});
export type AlbumIntroduction = z.infer<typeof albumIntroductionSchema>;
