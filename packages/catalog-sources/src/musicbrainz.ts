import { createHash } from "node:crypto";
import type { ReleaseCandidate } from "@cocean/contracts";
import { z } from "zod";

const artistCreditSchema = z
  .array(
    z
      .object({
        name: z.string().optional(),
        joinphrase: z.string().optional(),
      })
      .passthrough(),
  )
  .default([]);
const releaseSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    score: z.union([z.number(), z.string()]).optional(),
    date: z.string().optional(),
    country: z.string().optional(),
    status: z.string().optional(),
    barcode: z.string().nullable().optional(),
    "artist-credit": artistCreditSchema,
    "label-info": z
      .array(
        z
          .object({
            "catalog-number": z.string().nullable().optional(),
            label: z
              .object({ name: z.string().optional() })
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .default([]),
    media: z
      .array(
        z
          .object({
            format: z.string().nullable().optional(),
            "track-count": z.number().int().nonnegative().optional(),
          })
          .passthrough(),
      )
      .default([]),
    "cover-art-archive": z
      .object({
        artwork: z.boolean().optional(),
        front: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();
const searchResponseSchema = z
  .object({ releases: z.array(releaseSchema).default([]) })
  .passthrough();

export interface MusicBrainzClientOptions {
  contact: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  minimumIntervalMs?: number;
  timeoutMs?: number;
  now?: () => Date;
}

export interface ReleaseSearchInput {
  albumId: string;
  title: string;
  artist: string;
  year?: number | null;
  limit?: number;
}

export class MusicBrainzClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly userAgent: string;
  private readonly minimumIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private nextAllowedAt = 0;

  constructor(options: MusicBrainzClientOptions) {
    if (!options.contact.trim())
      throw new Error("MusicBrainz requires a maintainer contact URL or email");
    this.baseUrl = options.baseUrl ?? "https://musicbrainz.org/ws/2/";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.userAgent = `COCEAN/0.1.0 (${options.contact.trim()})`;
    this.minimumIntervalMs = Math.max(options.minimumIntervalMs ?? 1100, 1000);
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.now = options.now ?? (() => new Date());
  }

  async searchReleases(input: ReleaseSearchInput): Promise<ReleaseCandidate[]> {
    await this.waitForRateLimit();
    const query = [
      `release:${quote(input.title)}`,
      `artist:${quote(input.artist)}`,
    ];
    if (input.year) query.push(`date:${input.year}`);
    const url = new URL("release/", this.baseUrl);
    url.search = new URLSearchParams({
      query: query.join(" AND "),
      fmt: "json",
      limit: String(Math.min(Math.max(input.limit ?? 8, 1), 25)),
    }).toString();
    const response = await this.fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": this.userAgent },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.nextAllowedAt = Date.now() + this.minimumIntervalMs;
    if (!response.ok)
      throw new CatalogSourceError(
        "MUSICBRAINZ_REQUEST_FAILED",
        `MusicBrainz returned ${response.status}`,
        response.status,
      );
    const parsed = searchResponseSchema.safeParse(await response.json());
    if (!parsed.success)
      throw new CatalogSourceError(
        "MUSICBRAINZ_INVALID_RESPONSE",
        "MusicBrainz response did not match the expected schema",
      );
    const fetchedAt = this.now().toISOString();
    return parsed.data.releases.map((release) =>
      mapRelease(input.albumId, release, fetchedAt),
    );
  }

  private async waitForRateLimit(): Promise<void> {
    const delay = this.nextAllowedAt - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

export class CatalogSourceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "CatalogSourceError";
  }
}

function mapRelease(
  albumId: string,
  release: z.infer<typeof releaseSchema>,
  fetchedAt: string,
): ReleaseCandidate {
  const artistCredit = release["artist-credit"]
    .map((credit) => `${credit.name ?? ""}${credit.joinphrase ?? ""}`)
    .join("")
    .trim();
  const labels = unique(
    release["label-info"].map((item) => item.label?.name ?? null),
  );
  const catalogNumbers = unique(
    release["label-info"].map((item) => item["catalog-number"] ?? null),
  );
  const mediaFormats = unique(
    release.media.map((medium) => medium.format ?? null),
  );
  const trackCounts = release.media
    .map((medium) => medium["track-count"])
    .filter((value): value is number => typeof value === "number");
  const rawScore = release.score === undefined ? null : Number(release.score);
  return {
    id: createHash("sha256")
      .update(`${albumId}\0MUSICBRAINZ\0${release.id}`)
      .digest("base64url")
      .slice(0, 32),
    albumId,
    source: "MUSICBRAINZ",
    sourceId: release.id,
    title: release.title,
    artistCredit: artistCredit || "未知艺术家",
    releaseDate: release.date ?? null,
    country: release.country ?? null,
    status: release.status ?? null,
    barcode: release.barcode || null,
    labels,
    catalogNumbers,
    mediaFormats,
    trackCount: trackCounts.length
      ? trackCounts.reduce((total, value) => total + value, 0)
      : null,
    coverArtAvailable: Boolean(
      release["cover-art-archive"]?.artwork ||
      release["cover-art-archive"]?.front,
    ),
    sourceScore:
      rawScore !== null && Number.isFinite(rawScore)
        ? Math.min(Math.max(rawScore, 0), 100)
        : null,
    fetchedAt,
  };
}

function quote(value: string): string {
  return `"${value.normalize("NFKC").replaceAll("\\", "\\\\").replaceAll('"', '\\"').trim()}"`;
}

function unique(values: Array<string | null>): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => Boolean(value?.trim()))
        .map((value) => value.trim()),
    ),
  ];
}
