import { afterEach, describe, expect, it, vi } from "vitest";
import { api, buildDemoAlbumPage } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("web API client", () => {
  it("includes the concrete issue in live album page requests", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(
          JSON.stringify({ items: [], limit: 96, offset: 0, total: 0 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );
    await api.albumPage({ issue: "LOW_RES_ARTWORK" });
    expect(
      new URL(requests[0]!, "http://cocean.test").searchParams.get("issue"),
    ).toBe("LOW_RES_ARTWORK");
  });

  it("applies concrete issue filtering to demo album pages", () => {
    const page = buildDemoAlbumPage({ issue: "MISSING_ARTWORK" });
    expect(page.total).toBe(1);
    expect(page.items[0]?.issues?.map((issue) => issue.code)).toContain(
      "MISSING_ARTWORK",
    );
    expect(buildDemoAlbumPage({ issue: "INCOMPLETE_TRACKS" }).total).toBe(0);
  });

  it("does not attach a JSON content type to an empty POST", async () => {
    const requests: Array<{
      input: RequestInfo | URL;
      init: RequestInit | undefined;
    }> = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input, init });
        return new Response(
          JSON.stringify({
            albumId: "album-one",
            content: "介绍",
            model: "verified-model",
            generatedAt: "2026-08-12T00:00:00.000Z",
            factualBasis: ["Album: One"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.generateAlbumIntroduction("album-one");

    const init = requests[0]?.init;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });

  it("transmits the caller planId when queuing an Album delivery", async () => {
    const requests: Array<{
      input: RequestInfo | URL;
      init: RequestInit | undefined;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input, init });
        return new Response(
          JSON.stringify({
            id: "delivery-one",
            albumId: "album-one",
            albumTitle: "Album One",
            targetId: "target-one",
            targetName: "SP3000M",
            transport: "AK_FILE_DROP",
            status: "QUEUED",
            fileCount: 9,
            completedFileCount: 0,
            totalBytes: 900,
            transferredBytes: 0,
            verified: false,
            error: null,
            createdAt: "2026-08-13T00:00:00.000Z",
            startedAt: null,
            finishedAt: null,
            planId: "11111111-1111-4111-8111-111111111111",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    await api.deliverAlbum(
      "album-one",
      "target-one",
      "11111111-1111-4111-8111-111111111111",
    );

    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.input)).toBe(
      "/api/v1/albums/album-one/deliveries",
    );
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      targetId: "target-one",
      planId: "11111111-1111-4111-8111-111111111111",
    });
  });
});
