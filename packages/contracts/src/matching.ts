import { z } from "zod";

export const releaseCandidateSchema = z.object({
  id: z.string(),
  albumId: z.string(),
  source: z.literal("MUSICBRAINZ"),
  sourceId: z.string(),
  title: z.string(),
  artistCredit: z.string(),
  releaseDate: z.string().nullable(),
  country: z.string().nullable(),
  status: z.string().nullable(),
  barcode: z.string().nullable(),
  labels: z.array(z.string()),
  catalogNumbers: z.array(z.string()),
  mediaFormats: z.array(z.string()),
  trackCount: z.number().int().nonnegative().nullable(),
  coverArtAvailable: z.boolean(),
  sourceScore: z.number().min(0).max(100).nullable(),
  fetchedAt: z.string(),
});
export type ReleaseCandidate = z.infer<typeof releaseCandidateSchema>;
