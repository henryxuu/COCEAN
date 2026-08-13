import { z } from "zod";

const lookupSchema = z.object({
  resultCount: z.number().int().nonnegative(),
  results: z.array(
    z
      .object({
        wrapperType: z.string().optional(),
        collectionType: z.string().optional(),
        collectionId: z.number().optional(),
        collectionName: z.string().optional(),
        artistName: z.string().optional(),
        artworkUrl100: z.string().url().optional(),
        collectionViewUrl: z.string().url().optional(),
        previewUrl: z.string().url().optional(),
      })
      .passthrough(),
  ),
});

export interface ExternalCatalogMedia {
  provider: "APPLE_MUSIC" | "QOBUZ" | "OTHER";
  url: string;
  artworkUrl: string | null;
  previewUrl: string | null;
  previewSeconds: number | null;
  fullPlayback:
    "MUSICKIT_AUTH_REQUIRED" | "QOBUZ_PARTNER_REQUIRED" | "EXTERNAL_ONLY";
}

export class AppleCatalogClient {
  private readonly cache = new Map<
    string,
    Promise<ExternalCatalogMedia | null>
  >();

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  lookup(sourceRef: string): Promise<ExternalCatalogMedia | null> {
    if (!isAppleMusicUrl(sourceRef)) return Promise.resolve(null);
    const cached = this.cache.get(sourceRef);
    if (cached) return cached;
    const promise = this.lookupUncached(sourceRef).catch(() => ({
      provider: "APPLE_MUSIC" as const,
      url: sourceRef,
      artworkUrl: null,
      previewUrl: null,
      previewSeconds: null,
      fullPlayback: "MUSICKIT_AUTH_REQUIRED" as const,
    }));
    this.cache.set(sourceRef, promise);
    return promise;
  }

  private async lookupUncached(
    sourceRef: string,
  ): Promise<ExternalCatalogMedia | null> {
    const parsed = new URL(sourceRef);
    const id = parsed.pathname.match(/\/(\d+)$/)?.[1];
    if (!id) return null;
    const lookup = new URL("lookup", this.baseUrl);
    lookup.searchParams.set("id", id);
    lookup.searchParams.set("entity", "song");
    const storefront = parsed.pathname.split("/").filter(Boolean)[0];
    if (storefront && /^[a-z]{2}$/i.test(storefront))
      lookup.searchParams.set("country", storefront.toUpperCase());
    const response = await fetch(lookup, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok)
      throw new Error(`Apple lookup failed (${response.status})`);
    const payload = lookupSchema.parse(await response.json());
    const album = payload.results.find(
      (item) =>
        item.wrapperType === "collection" || item.collectionType === "Album",
    );
    const preview = payload.results.find((item) => item.previewUrl)?.previewUrl;
    return {
      provider: "APPLE_MUSIC",
      url: album?.collectionViewUrl ?? sourceRef,
      artworkUrl: album?.artworkUrl100
        ? upscaleArtwork(album.artworkUrl100)
        : null,
      previewUrl: preview ?? null,
      previewSeconds: preview ? 30 : null,
      fullPlayback: "MUSICKIT_AUTH_REQUIRED",
    };
  }
}

export function externalMediaFallback(
  sourceRef: string,
): ExternalCatalogMedia | null {
  if (isAppleMusicUrl(sourceRef))
    return {
      provider: "APPLE_MUSIC",
      url: sourceRef,
      artworkUrl: null,
      previewUrl: null,
      previewSeconds: null,
      fullPlayback: "MUSICKIT_AUTH_REQUIRED",
    };
  if (/^https:\/\/(?:open\.)?qobuz\.com\//i.test(sourceRef))
    return {
      provider: "QOBUZ",
      url: sourceRef,
      artworkUrl: null,
      previewUrl: null,
      previewSeconds: null,
      fullPlayback: "QOBUZ_PARTNER_REQUIRED",
    };
  if (/^https:\/\//i.test(sourceRef))
    return {
      provider: "OTHER",
      url: sourceRef,
      artworkUrl: null,
      previewUrl: null,
      previewSeconds: null,
      fullPlayback: "EXTERNAL_ONLY",
    };
  return null;
}

function isAppleMusicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "music.apple.com";
  } catch {
    return false;
  }
}

function upscaleArtwork(value: string): string {
  return value.replace(
    /\/\d+x\d+[^/]*\.(jpg|png)(?:\?.*)?$/i,
    "/1200x1200bb.$1",
  );
}
