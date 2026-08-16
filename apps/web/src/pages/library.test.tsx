import type { AlbumSummary } from "@cocean/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, useLocation } from "react-router-dom";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api.js";
import { libraryScrollKey } from "../library-state.js";
import { AlbumDetailBreadcrumb } from "./album-detail.js";
import { libraryAlbumQuery, LibraryAlbumCard, LibraryPage } from "./library.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("唱片库页面返回接线", () => {
  it("无排序参数时选中最新加入并查询共享默认值", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/library"]}>
        <LibraryPage canManage={false} />
      </MemoryRouter>,
    );
    expect(html).toContain(
      '<option value="ADDED_DESC" selected="">最新加入</option>',
    );
    expect(
      libraryAlbumQuery({
        query: "",
        filter: "ALL",
        sort: "ADDED_DESC",
        issue: "ALL",
        visibility: "VISIBLE",
        page: 0,
      }),
    ).toEqual(expect.objectContaining({ sort: "ADDED_DESC", offset: 0 }));
  });

  it("挂载页面后按 canonical 状态请求，并让排序或筛选变化从第 2 页归零", async () => {
    const pending = new Promise<never>(() => {});
    const albumPage = vi.spyOn(api, "albumPage").mockReturnValue(pending);
    vi.spyOn(api, "stats").mockReturnValue(pending);
    let renderer: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryRouter initialEntries={["/library"]}>
          <LibraryPage canManage={false} />
        </MemoryRouter>,
      );
    });
    expect(albumPage).toHaveBeenLastCalledWith({
      search: "",
      filter: "ALL",
      sort: "ADDED_DESC",
      issue: "ALL",
      visibility: "VISIBLE",
      limit: 96,
      offset: 0,
    });
    await act(async () => renderer!.unmount());

    albumPage.mockClear();
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryRouter initialEntries={["/library?sort=ARTIST&page=2"]}>
          <LibraryPage canManage={false} />
        </MemoryRouter>,
      );
    });
    expect(albumPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: "ARTIST", offset: 96 }),
    );
    const sortSelect = renderer!.root
      .findAllByType("select")
      .find((candidate) => candidate.props.value === "ARTIST")!;
    await act(async () =>
      sortSelect.props.onChange({ target: { value: "TITLE" } }),
    );
    expect(albumPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: "TITLE", offset: 0 }),
    );
    await act(async () => renderer!.unmount());

    albumPage.mockClear();
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryRouter initialEntries={["/library?page=2"]}>
          <LibraryPage canManage={false} />
        </MemoryRouter>,
      );
    });
    expect(albumPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: "ADDED_DESC", offset: 96 }),
    );
    const cdFilter = renderer!.root
      .findAllByType("button")
      .find((candidate) => rendererText(candidate) === "CD")!;
    await act(async () => cdFilter.props.onClick());
    expect(albumPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ filter: "CD", offset: 0 }),
    );
    await act(async () => renderer!.unmount());
  });

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

  it("管理员可从唱片库切换到已隐藏管理视图", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/library?visibility=HIDDEN"]}>
        <LibraryPage canManage />
      </MemoryRouter>,
    );
    expect(html).toContain(
      '<button class="filter-pill is-active">已隐藏</button>',
    );
    expect(
      libraryAlbumQuery({
        query: "",
        filter: "ALL",
        sort: "ARTIST",
        issue: "ALL",
        visibility: "HIDDEN",
        page: 0,
      }),
    ).toEqual(expect.objectContaining({ visibility: "HIDDEN" }));
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

  it.each([
    { role: "ADMIN" as const, canManage: true },
    { role: "MEMBER" as const, canManage: false },
  ])("$role 真空库不在空态重复页头动作", async ({ role, canManage }) => {
    const renderer = await renderEmptyLibrary("/library", canManage);
    const emptyState = findEmptyState(renderer.root);
    const emptyText = rendererText(emptyState);
    const emptyActions = emptyState
      .findAll(
        (candidate) => candidate.type === "a" || candidate.type === "button",
      )
      .map(rendererText);
    const headerText = rendererText(
      renderer.root.find(
        (candidate) => candidate.props.className === "page-header",
      ),
    );

    expect(emptyText).toContain("唱片库还是空的");
    expect(emptyActions).not.toContain("管理扫描");
    expect(emptyActions).not.toContain("查看任务");
    expect(emptyActions).not.toContain("添加实体唱片");
    if (canManage) {
      expect(emptyText).toContain("检查目录设置");
      expect(headerText).toContain("管理扫描");
      expect(headerText).toContain("添加实体唱片");
      expect(headerText).not.toContain("查看任务");
    } else {
      expect(emptyText).not.toContain("检查目录设置");
      expect(emptyText).toContain("联系管理员检查目录");
      expect(headerText).toContain("查看任务");
      expect(headerText).not.toContain("管理扫描");
      expect(headerText).not.toContain("添加实体唱片");
    }

    await act(async () => renderer.unmount());
  });

  it("纯空白 query 不会把真空库误判为筛选无结果", async () => {
    const renderer = await renderEmptyLibrary("/library?q=%20%20%20", false);
    const emptyText = rendererText(findEmptyState(renderer.root));

    expect(emptyText).toContain("唱片库还是空的");
    expect(emptyText).not.toContain("清除筛选");
    await act(async () => renderer.unmount());
  });

  it.each(
    [
      { criterion: "q", entry: "/library?q=Schubert" },
      { criterion: "filter", entry: "/library?filter=CD" },
      { criterion: "issue", entry: "/library?issue=MISSING_ARTWORK" },
      { criterion: "visibility", entry: "/library?visibility=HIDDEN" },
    ].flatMap((item) => [
      { ...item, role: "ADMIN" as const, canManage: true },
      { ...item, role: "MEMBER" as const, canManage: false },
    ]),
  )(
    "$role 的 $criterion 条件无结果只显示筛选空态",
    async ({ entry, canManage }) => {
      const renderer = await renderEmptyLibrary(entry, canManage);
      const emptyText = rendererText(findEmptyState(renderer.root));

      expect(emptyText).toContain("没有符合条件的 Album");
      expect(emptyText).toContain("清除筛选");
      expect(emptyText).not.toContain("唱片库还是空的");
      expect(emptyText).not.toContain("检查目录设置");
      expect(emptyText).not.toContain("管理扫描");
      expect(emptyText).not.toContain("查看任务");
      expect(emptyText).not.toContain("添加实体唱片");
      await act(async () => renderer.unmount());
    },
  );

  it("点击清除筛选后 URL 与页面状态回到 canonical 默认值", async () => {
    stubAnimationFrame();
    vi.spyOn(api, "albumPage").mockResolvedValue(emptyAlbumPage());
    vi.spyOn(api, "stats").mockResolvedValue({} as never);
    let renderer: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryRouter
          initialEntries={[
            "/library?q=Schubert&filter=CD&sort=YEAR_DESC&issue=MISSING_ARTWORK&visibility=HIDDEN",
          ]}
        >
          <LibraryRouteProbe />
          <LibraryPage canManage />
        </MemoryRouter>,
      );
    });
    const emptyState = findEmptyState(renderer!.root);
    const clear = emptyState
      .findAllByType("button")
      .find((candidate) => rendererText(candidate) === "清除筛选")!;
    await act(async () => clear.props.onClick());

    expect(
      renderer!.root.findByProps({ "data-library-route": true }).props.children,
    ).toBe("/library");
    expect(
      renderer!.root.findByProps({ "aria-label": "搜索唱片库" }).props.value,
    ).toBe("");
    expect(
      renderer!.root
        .findAllByType("select")
        .map((select) => select.props.value),
    ).toEqual(["ALL", "ADDED_DESC"]);
    expect(rendererText(findEmptyState(renderer!.root))).toContain(
      "唱片库还是空的",
    );
    await act(async () => renderer!.unmount());
  });

  it.each([
    { label: "total>0", total: 1 },
    { label: "total=0", total: 0 },
  ])("$label 的越界 page 仅归零页码并保留全部查询条件", async ({ total }) => {
    stubAnimationFrame();
    const albumPage = vi
      .spyOn(api, "albumPage")
      .mockImplementation(async (input) => {
        const offset = input?.offset ?? 0;
        return offset
          ? { ...emptyAlbumPage(), total, offset }
          : {
              ...emptyAlbumPage(),
              items: total ? [album] : [],
              total,
            };
      });
    vi.spyOn(api, "stats").mockResolvedValue({} as never);
    let renderer: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryRouter
          initialEntries={[
            "/library?q=Schubert&filter=CD&sort=YEAR_DESC&issue=MISSING_ARTWORK&visibility=HIDDEN&page=2",
          ]}
        >
          <LibraryRouteProbe />
          <LibraryPage canManage />
        </MemoryRouter>,
      );
    });

    expect(
      renderer!.root.findByProps({ "data-library-route": true }).props.children,
    ).toBe(
      "/library?q=Schubert&filter=CD&sort=YEAR_DESC&issue=MISSING_ARTWORK&visibility=HIDDEN",
    );
    expect(albumPage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        search: "Schubert",
        filter: "CD",
        sort: "YEAR_DESC",
        issue: "MISSING_ARTWORK",
        visibility: "HIDDEN",
        offset: 96,
      }),
    );
    expect(albumPage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        search: "Schubert",
        filter: "CD",
        sort: "YEAR_DESC",
        issue: "MISSING_ARTWORK",
        visibility: "HIDDEN",
        offset: 0,
      }),
    );
    expect(rendererText(renderer!.root)).not.toContain("第 2 /");
    if (total) {
      expect(rendererText(renderer!.root)).toContain("String Quintet");
    } else {
      expect(rendererText(findEmptyState(renderer!.root))).toContain(
        "没有符合条件的 Album",
      );
    }
    await act(async () => renderer!.unmount());
  });
});

const album: AlbumSummary = {
  id: "album-schubert",
  addedAt: "2026-08-12T00:00:00.000Z",
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
  primaryVersionSource: "AUTOMATIC",
  revision: 0,
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

function rendererText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : rendererText(child)))
    .join("");
}

async function renderEmptyLibrary(entry: string, canManage: boolean) {
  stubAnimationFrame();
  vi.spyOn(api, "albumPage").mockResolvedValue(emptyAlbumPage());
  vi.spyOn(api, "stats").mockResolvedValue({} as never);
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <MemoryRouter initialEntries={[entry]}>
        <LibraryPage canManage={canManage} />
      </MemoryRouter>,
    );
  });
  return renderer!;
}

function emptyAlbumPage() {
  return {
    items: [],
    total: 0,
    limit: 96,
    offset: 0,
  };
}

function findEmptyState(root: TestRenderer.ReactTestInstance) {
  return root.find((candidate) => candidate.props.className === "empty-state");
}

function LibraryRouteProbe() {
  const location = useLocation();
  return (
    <output data-library-route>
      {`${location.pathname}${location.search}`}
    </output>
  );
}

function stubAnimationFrame() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
}
