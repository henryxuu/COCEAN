import type { AlbumSummary } from "@cocean/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { libraryScrollKey } from "../library-state.js";
import { AlbumDetailBreadcrumb } from "./album-detail.js";
import { LibraryAlbumCard, LibraryPage } from "./library.js";

describe("唱片库页面返回接线", () => {
  it("页面渲染直接服从当前 URL 的查询、筛选、排序与页码", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={[
          "/library?q=Schubert&filter=CD&sort=YEAR_DESC&issue=MISSING_ARTWORK&page=2",
        ]}
      >
        <LibraryPage canManage={false} />
      </MemoryRouter>,
    );
    expect(html).toContain('value="Schubert"');
    expect(html).toContain('<button class="filter-pill is-active">CD</button>');
    expect(html).toContain(
      '<option value="YEAR_DESC" selected="">年份 ↓</option>',
    );
    expect(html).toContain(
      '<option value="MISSING_ARTWORK" selected="">缺少封面</option>',
    );
  });

  it("AlbumCard href 携带完整路由，普通/辅助/右键导航都会保存同一路由与 1200px", () => {
    const route = "/library?q=Schubert&filter=DIGITAL&sort=YEAR_DESC&page=2";
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
    const card = LibraryAlbumCard({
      album,
      route,
      storage,
      scrollTop: () => 1200,
      now: () => 123_456,
    });
    const handlers = card.props as {
      onOpen(): void;
      onAuxOpen(): void;
      onContextOpen(): void;
    };

    for (const capture of [
      handlers.onOpen,
      handlers.onAuxOpen,
      handlers.onContextOpen,
    ]) {
      values.clear();
      capture();
      expect(JSON.parse(values.get(libraryScrollKey(route)) ?? "null")).toEqual(
        { route, top: 1200, savedAt: 123_456 },
      );
    }

    const html = renderToStaticMarkup(<MemoryRouter>{card}</MemoryRouter>);
    expect(html).toContain(
      'href="/albums/album-schubert?from=%2Flibrary%3Fq%3DSchubert%26filter%3DDIGITAL%26sort%3DYEAR_DESC%26page%3D2"',
    );
    expect(html).toContain("PCM 24/96");
    expect(html).toContain("2 个本地版本");
    expect(html).toContain("待确认分组");
  });

  it("详情面包屑可观察地返回完整的 q/filter/sort/page 路由", () => {
    const route = "/library?q=Schubert&filter=DIGITAL&sort=YEAR_DESC&page=2";
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AlbumDetailBreadcrumb returnTo={route} title="String Quintet" />
      </MemoryRouter>,
    );
    expect(html).toContain(
      'href="/library?q=Schubert&amp;filter=DIGITAL&amp;sort=YEAR_DESC&amp;page=2"',
    );
    expect(html).toContain("唱片库");
    expect(html).toContain("String Quintet");
  });

  it("旧摘要没有 issues 时仍显示 TRACKS_INCOMPLETE", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        {LibraryAlbumCard({
          album: {
            ...album,
            issues: undefined,
            versionCount: undefined,
            matchStatus: "TRACKS_INCOMPLETE",
          },
          route: "/library",
        })}
      </MemoryRouter>,
    );
    expect(html).toContain("曲目不完整");
  });
});

const album: AlbumSummary = {
  id: "album-schubert",
  title: "String Quintet",
  albumArtist: "Franz Schubert",
  year: 2007,
  artwork: {
    source: "NONE",
    url: null,
    mimeType: null,
    width: null,
    height: null,
  },
  audioBadge: "24/96",
  audioSummary: null,
  mixedAudioSpecs: false,
  hasDigital: true,
  physicalMedia: [],
  matchStatus: "NEEDS_REVIEW",
  trackCount: 8,
  discCount: 1,
  versionCount: 2,
  primaryVersionId: "album-schubert-complete",
  issues: [
    {
      code: "IDENTITY_OVERLAP",
      versionId: null,
      evidence: { versionCount: 2 },
    },
  ],
};
