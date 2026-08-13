import { afterEach, describe, expect, it, vi } from "vitest";
import { AppleCatalogClient, externalMediaFallback } from "./apple-catalog.js";

afterEach(() => vi.unstubAllGlobals());

describe("Apple catalog media", () => {
  it("adds representative artwork, a 30-second preview and keeps full play behind MusicKit auth", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/lookup");
      expect(url.searchParams.get("id")).toBe("123456789");
      expect(url.searchParams.get("country")).toBe("CN");
      return new Response(
        JSON.stringify({
          resultCount: 2,
          results: [
            {
              wrapperType: "collection",
              collectionType: "Album",
              collectionId: 123456789,
              artworkUrl100:
                "https://is1-ssl.mzstatic.com/image/thumb/example/100x100bb.jpg",
              collectionViewUrl:
                "https://music.apple.com/cn/album/example/123456789",
            },
            {
              wrapperType: "track",
              previewUrl:
                "https://audio-ssl.itunes.apple.com/itunes-assets/example.m4a",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AppleCatalogClient("https://itunes.apple.com/", 5_000);
    const result = await client.lookup(
      "https://music.apple.com/cn/album/example/123456789",
    );

    expect(result).toEqual({
      provider: "APPLE_MUSIC",
      url: "https://music.apple.com/cn/album/example/123456789",
      artworkUrl:
        "https://is1-ssl.mzstatic.com/image/thumb/example/1200x1200bb.jpg",
      previewUrl:
        "https://audio-ssl.itunes.apple.com/itunes-assets/example.m4a",
      previewSeconds: 30,
      fullPlayback: "MUSICKIT_AUTH_REQUIRED",
    });
    await client.lookup("https://music.apple.com/cn/album/example/123456789");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not claim Qobuz playback without a partner integration", () => {
    expect(
      externalMediaFallback("https://open.qobuz.com/album/example"),
    ).toEqual(
      expect.objectContaining({
        provider: "QOBUZ",
        fullPlayback: "QOBUZ_PARTNER_REQUIRED",
        previewUrl: null,
      }),
    );
  });
});
