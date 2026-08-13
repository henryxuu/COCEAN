import { describe, expect, it, vi } from "vitest";
import { MusicBrainzClient } from "./musicbrainz.js";

describe("MusicBrainzClient", () => {
  it("maps release identity evidence without promoting it to a fact", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          releases: [
            {
              id: "f1b2d3c4-1111-4222-8333-123456789abc",
              score: 98,
              title: "Glass Rooms",
              date: "1994-09-01",
              country: "GB",
              status: "Official",
              barcode: "1234567890123",
              "artist-credit": [{ name: "COCEAN Test Artist" }],
              "label-info": [
                {
                  "catalog-number": "STILL-001",
                  label: { name: "Still Test" },
                },
              ],
              media: [{ format: "CD", "track-count": 2 }],
              "cover-art-archive": { artwork: true, front: true },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new MusicBrainzClient({
      contact: "https://example.test/cocean",
      fetch: fetchMock,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
    });

    const results = await client.searchReleases({
      albumId: "album-1",
      title: "Glass Rooms",
      artist: "COCEAN Test Artist",
      year: 1994,
    });

    expect(results).toEqual([
      expect.objectContaining({
        source: "MUSICBRAINZ",
        sourceId: "f1b2d3c4-1111-4222-8333-123456789abc",
        labels: ["Still Test"],
        catalogNumbers: ["STILL-001"],
        mediaFormats: ["CD"],
        trackCount: 2,
        coverArtAvailable: true,
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          "user-agent": "COCEAN/0.1.0 (https://example.test/cocean)",
        }),
      }),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "release%3A%22Glass+Rooms%22",
    );
  });

  it("requires a maintainer contact before any network request", () => {
    expect(() => new MusicBrainzClient({ contact: "" })).toThrow(/contact/);
  });
});
