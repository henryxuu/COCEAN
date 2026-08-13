import { z } from "zod";
import { albumSummarySchema } from "./library.js";

export const recommendationCriterionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["DOMAIN", "FEATURE", "TEXT"]),
  catalogValue: z.string().min(1),
});
export type RecommendationCriterion = z.infer<
  typeof recommendationCriterionSchema
>;

export const catalogRecommendationAlbumSchema = z.object({
  stillAlbumId: z.string().min(1),
  title: z.string().min(1),
  artist: z.string().min(1),
  domains: z.array(z.string().min(1)),
  features: z.array(z.string().min(1)),
  sourceKind: z.string().min(1),
  sourceRef: z.string().min(1),
  external: z
    .object({
      provider: z.enum(["APPLE_MUSIC", "QOBUZ", "OTHER"]),
      url: z.string().url(),
      artworkUrl: z.string().url().nullable(),
      previewUrl: z.string().url().nullable(),
      previewSeconds: z.number().int().positive().nullable(),
      fullPlayback: z.enum([
        "MUSICKIT_AUTH_REQUIRED",
        "QOBUZ_PARTNER_REQUIRED",
        "EXTERNAL_ONLY",
      ]),
    })
    .nullable(),
  matchedCriteria: z.array(recommendationCriterionSchema),
  localAlbum: albumSummarySchema.nullable(),
});
export type CatalogRecommendationAlbum = z.infer<
  typeof catalogRecommendationAlbumSchema
>;

export const catalogRecommendationResponseSchema = z.object({
  mode: z.literal("VERIFIED_CATALOG_COMPATIBILITY"),
  requestKind: z.enum(["TODAY", "DISCOVER"]),
  sourceContentVersion: z.string().min(1),
  algorithmVersion: z.string().min(1),
  modelCallCount: z.literal(0),
  query: z.object({
    raw: z.string(),
    supportedCriteria: z.array(recommendationCriterionSchema),
    unsupportedTerms: z.array(z.string().min(1)),
  }),
  primary: catalogRecommendationAlbumSchema.nullable(),
  items: z.array(catalogRecommendationAlbumSchema),
  v010: z.object({
    algorithmVersion: z.string().min(1),
    status: z.literal("WAITING_FOR_ACCEPTED_RUNTIME"),
    reasonCode: z.literal("ACCEPTED_RUNTIME_SNAPSHOT_MISSING"),
  }),
  limitations: z.array(z.string().min(1)),
});
export type CatalogRecommendationResponse = z.infer<
  typeof catalogRecommendationResponseSchema
>;
