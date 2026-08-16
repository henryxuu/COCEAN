import type {
  AlbumDetail,
  AlbumArtworkGovernance,
  AlbumMetadata,
  DeliveryJob,
  LocalVersionSummary,
} from "@cocean/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../api.js";
import {
  AlbumDetailPage,
  AlbumDeliveryRecord,
  AlbumDetailHeroActions,
  AlbumArtworkGovernancePanel,
  AlbumIdentityGovernance,
  AlbumIdentityHistory,
  AlbumIntegrityIssues,
  AlbumLocalVersions,
  AlbumMetadataGovernance,
  OrphanGovernancePreviewCard,
  buildConfirmIdentityCommand,
  buildMetadataCommands,
  buildMergeIdentityCommand,
  buildSetPrimaryIdentityCommand,
  buildSplitIdentityCommand,
  createLatestRequestTracker,
  legacyLocalVersions,
  mergeTargetAlbumQuery,
} from "./album-detail.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Album 详情主操作", () => {
  it("以投送为主要入口，并将目标选择默认折叠", () => {
    const html = renderToStaticMarkup(
      <AlbumDetailHeroActions
        canManage
        hasDigital
        hasTracks
        listening={false}
        targets={[
          {
            id: "sp3000m",
            deviceId: null,
            name: "SP3000M",
            kind: "NETWORK",
            transport: "AK_FILE_DROP",
            location: "172.16.1.10",
            username: "owner",
            credentialConfigured: true,
            enabled: true,
            verifiedAt: "2026-08-14T00:00:00.000Z",
            createdAt: "2026-08-14T00:00:00.000Z",
            updatedAt: "2026-08-14T00:00:00.000Z",
          },
        ]}
        selectedTargetId="sp3000m"
        delivering={false}
        selectedTargetNeedsCredential={false}
        onSelectTarget={() => undefined}
        onDeliver={() => undefined}
        onListen={() => undefined}
      />,
    );
    expect(html).toContain("投送到播放器");
    expect(html).toContain("试听");
    expect(html).toContain("管理唱片");
    expect(html).toContain('<details class="delivery-action-menu">');
    expect(html).not.toContain(
      '<details class="delivery-action-menu" open="">',
    );
    expect(html).not.toContain("Listen");
    expect(html).not.toContain("信息匹配");
  });
});

describe("Album 异常版本治理", () => {
  const expected = {
    scanJobId: "scan-one",
    rootId: "music",
    localVersionId: "orphan-one",
    classification: "ORPHAN" as const,
    reasons: ["NO_CURRENT_FACT" as const],
    libraryAlbumId: "library-one",
    libraryRevision: 2,
    visibility: "VISIBLE" as const,
    visibilityRevision: 0,
    primaryVersionId: "orphan-one",
    memberVersionIds: ["orphan-one"],
    currentMemberVersionIds: [],
    referenceFingerprint: "c".repeat(64),
    memberFacts: [
      {
        localVersionId: "orphan-one",
        classification: "ORPHAN" as const,
        reasons: ["NO_CURRENT_FACT" as const],
        isPrimary: true,
        referenceFingerprint: "d".repeat(64),
      },
    ],
  };

  it("只在可执行预览中显示明确保留声明和二次确认", () => {
    const html = renderToStaticMarkup(
      <OrphanGovernancePreviewCard
        preview={{
          schema: "cocean.library-orphan-governance-preview/v1",
          action: "CLOSE_ORPHAN_IDENTITY",
          executable: true,
          before: expected,
          replacementPrimaryVersionId: null,
          affectedLibraryAlbumIds: ["library-one"],
          expected,
          expectedFingerprint: "a".repeat(64),
          blockers: [],
        }}
        confirmed={false}
        stale={false}
        working={false}
        onConfirmedChange={() => undefined}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(html).toContain("关闭无依据孤立身份");
    expect(html).toContain("本地版本、历史账本和音乐文件必须保留");
    expect(html).toContain("指纹 aaaaaaaaaaaa");
    expect(html).toContain("disabled");
    expect(html).not.toContain("/library/");
  });

  it("阻塞预览保留证据并禁用确认，不显示确认勾选", () => {
    const html = renderToStaticMarkup(
      <OrphanGovernancePreviewCard
        preview={{
          schema: "cocean.library-orphan-governance-preview/v1",
          action: null,
          executable: false,
          before: expected,
          replacementPrimaryVersionId: null,
          affectedLibraryAlbumIds: ["library-one"],
          expected,
          expectedFingerprint: "b".repeat(64),
          blockers: [
            {
              code: "ALREADY_GOVERNED",
              message: "该版本已经处于隐藏历史身份",
            },
          ],
        }}
        confirmed={false}
        stale={false}
        working={false}
        onConfirmedChange={() => undefined}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(html).toContain("当前不能安全治理");
    expect(html).toContain("该版本已经处于隐藏历史身份");
    expect(html).not.toContain('type="checkbox"');
  });

  it("409 后呈现过期状态并锁定再次确认", () => {
    const html = renderToStaticMarkup(
      <OrphanGovernancePreviewCard
        preview={{
          schema: "cocean.library-orphan-governance-preview/v1",
          action: "CLOSE_ORPHAN_IDENTITY",
          executable: true,
          before: expected,
          replacementPrimaryVersionId: null,
          affectedLibraryAlbumIds: ["library-one"],
          expected,
          expectedFingerprint: "e".repeat(64),
          blockers: [],
        }}
        confirmed={false}
        stale
        working={false}
        onConfirmedChange={() => undefined}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(html).toContain("预览已过期，必须重新检查后才能确认");
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("disabled");
  });

  it("挂载页面保持 requestId 重试语义，并在 409 后要求重新预览", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    const album = mountedOrphanAlbum();
    vi.spyOn(api, "album").mockResolvedValue(album);
    vi.spyOn(api, "deliveryTargets").mockResolvedValue([]);
    vi.spyOn(api, "albumDeliveries").mockResolvedValue([]);
    vi.spyOn(api, "albumIntroduction").mockResolvedValue(null);
    vi.spyOn(api, "identityDecisions").mockResolvedValue([]);
    vi.spyOn(api, "metadataHistory").mockResolvedValue([]);
    vi.spyOn(api, "artworkHistory").mockResolvedValue([]);
    vi.spyOn(api, "orphanGovernanceHistory").mockResolvedValue([]);
    vi.spyOn(api, "capabilities").mockResolvedValue({} as never);
    vi.spyOn(api, "lifecyclePlans").mockResolvedValue([]);
    const preview = mountedOrphanPreview();
    const previewCall = vi
      .spyOn(api, "previewOrphanGovernance")
      .mockResolvedValue(preview);
    const confirmCall = vi
      .spyOn(api, "confirmOrphanGovernance")
      .mockRejectedValueOnce(new Error("network uncertain"))
      .mockRejectedValueOnce(
        new ApiError(409, "ORPHAN_GOVERNANCE_CONFLICT", "stale"),
      )
      .mockResolvedValueOnce({
        status: "APPLIED",
        action: "CLOSE_ORPHAN_IDENTITY",
        localVersionId: "mounted-version",
        libraryAlbumId: "mounted-library",
        resultingLibraryAlbumId: "mounted-library",
        event: {} as never,
      });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryRouter initialEntries={["/albums/mounted-library"]}>
          <Routes>
            <Route path="/albums/:id" element={<AlbumDetailPage canManage />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    const button = (label: string) =>
      renderer!.root
        .findAllByType("button")
        .find((candidate) => testRendererText(candidate).includes(label))!;
    await act(async () => void (await button("检查异常状态").props.onClick()));
    expect(previewCall).toHaveBeenCalledWith("mounted-version");
    const checkbox = () =>
      renderer!.root
        .findAllByType("input")
        .find((candidate) => candidate.props.type === "checkbox")!;
    await act(async () =>
      checkbox().props.onChange({ target: { checked: true } }),
    );
    await act(async () => void (await button("确认安全闭合").props.onClick()));
    await act(async () => void (await button("确认安全闭合").props.onClick()));
    expect(confirmCall).toHaveBeenCalledTimes(2);
    expect(confirmCall.mock.calls[0]![1].requestId).toBe(
      confirmCall.mock.calls[1]![1].requestId,
    );
    expect(testRendererText(renderer!.root)).toContain("预览已过期");
    expect(button("确认安全闭合").props.disabled).toBe(true);

    await act(async () => void (await button("检查异常状态").props.onClick()));
    expect(
      renderer!.root
        .findAll((candidate) => candidate.props.role === "alert")
        .map(testRendererText),
    ).not.toContain("预览已过期，必须重新检查后才能确认。");
    await act(async () =>
      checkbox().props.onChange({ target: { checked: true } }),
    );
    await act(async () => void (await button("确认安全闭合").props.onClick()));
    expect(confirmCall).toHaveBeenCalledTimes(3);
    expect(confirmCall.mock.calls[2]![1].requestId).not.toBe(
      confirmCall.mock.calls[1]![1].requestId,
    );
    expect(vi.mocked(api.album).mock.calls.length).toBeGreaterThanOrEqual(3);
    await act(async () => renderer!.unmount());
  });
});

describe("Album 详情投送记录", () => {
  it("从持久化目标清单明确显示 8 首音频与封面完成 9/9", () => {
    const job: DeliveryJob = {
      id: "delivery-nine",
      albumId: "album-schubert",
      albumTitle: "String Quintet",
      targetId: "sp3000m",
      targetName: "SP3000M",
      transport: "AK_FILE_DROP",
      status: "COMPLETED",
      fileCount: 9,
      completedFileCount: 9,
      totalBytes: 900,
      transferredBytes: 900,
      verified: true,
      error: null,
      createdAt: "2026-08-13T00:00:00.000Z",
      startedAt: "2026-08-13T00:00:01.000Z",
      finishedAt: "2026-08-13T00:01:00.000Z",
      planId: "11111111-1111-4111-8111-111111111111",
    };

    const html = renderToStaticMarkup(<AlbumDeliveryRecord job={job} />);
    expect(html).toContain("9/9 个文件");
    expect(html).toContain("投送完成");
    expect(html).toContain("已校验");
    expect(html).toContain("投送进度 100%");
  });
});

describe("Album 详情本地版本", () => {
  it("同时展示主版本、残缺候选、来源路径和精确 PCM 规格", () => {
    const versions: LocalVersionSummary[] = [
      version({
        id: "complete",
        isPrimary: true,
        trackCount: 21,
        sizeBytes: 1_500_000_000,
      }),
      version({
        id: "fragment",
        isPrimary: false,
        trackCount: 2,
        sizeBytes: 120_000_000,
        completeness: "INCOMPLETE",
        issues: [
          {
            code: "INCOMPLETE_TRACKS",
            versionId: "fragment",
            evidence: { missing: 19 },
          },
        ],
      }),
    ];

    const html = renderToStaticMarkup(
      <AlbumLocalVersions
        versions={versions}
        versionCount={2}
        fallbackRelease={{
          label: "Decca",
          catalogNumber: "SXL 2001",
          barcode: "0123456789012",
          country: "GB",
          releaseDate: "1961-01-01",
          musicBrainzReleaseId: null,
        }}
      />,
    );
    expect(html).toContain("主版本");
    expect(html).toContain("本地版本");
    expect(html).toContain("PCM 24/96");
    expect(html).toContain("21 首");
    expect(html).toContain("2 首");
    expect(html).toContain("自动候选 · 待确认");
    expect(html).toContain("曲目不完整");
    expect(html).toContain("Decca · SXL 2001 · GB 1961-01-01");
    expect(html).toContain("条码 · 0123456789012");
    expect(html).toContain('<details class="version-technical-details">');
    expect(html).not.toContain(
      '<details class="version-technical-details" open="">',
    );
    expect(html).toContain("/library/music/Artist/Album/01.flac");
  });
});

describe("Album 元数据治理", () => {
  it("构造多字段 SET/CLEAR 命令并绑定版本，纯空白 SET 被拒绝", () => {
    const rows = [
      { key: "title", field: "title" as const },
      { key: "v:label", field: "label" as const, versionId: "v" },
      { key: "year", field: "year" as const },
    ];
    expect(
      buildMetadataCommands(
        rows,
        new Set(["title", "v:label", "year"]),
        new Set(["v:label"]),
        { title: "Curated", "v:label": "", year: "2024" },
      ),
    ).toEqual([
      { action: "SET", field: "title", value: "Curated" },
      { action: "CLEAR", field: "label", versionId: "v" },
      { action: "SET", field: "year", value: 2024 },
    ]);
    expect(() =>
      buildMetadataCommands(rows, new Set(["v:label"]), new Set(), {
        "v:label": "   ",
      }),
    ).toThrow(/清空有效值/);
  });

  it("管理员看到分作用域字段、来源、批量保存、清空、恢复和撤销入口", () => {
    const metadata = metadataFixture();
    const html = renderToStaticMarkup(
      <AlbumMetadataGovernance
        metadata={metadata}
        history={[
          {
            id: "event-1",
            requestId: "request-1",
            libraryAlbumId: metadata.libraryAlbumId,
            type: "UPDATE",
            actor: { id: "admin", displayName: "管理员" },
            expectedMetadataRevision: 0,
            resultingMetadataRevision: 1,
            commands: [{ action: "SET", field: "title", value: "人工标题" }],
            compensatesEventId: null,
            canUndo: true,
            createdAt: "2026-08-14T00:00:00.000Z",
          },
        ]}
        historyError={null}
        canManage
        onReload={async () => true}
        onToast={() => undefined}
      />,
    );
    expect(html).toContain("整张唱片");
    expect(html).toContain("本地版本 1");
    expect(html).toContain("来源：人工覆盖");
    expect(html).toContain("观察值：扫描标题");
    expect(html).toContain("保存修改（0 个字段）");
    expect(html).toContain("清空有效值");
    expect(html).toContain("移除人工覆盖 / 恢复下一层可信值");
    expect(html).toContain("撤销");
    expect(html).toContain("不会改写 NAS 文件");
  });

  it("成员只看到来源与历史，不出现写入操作", () => {
    const html = renderToStaticMarkup(
      <AlbumMetadataGovernance
        metadata={metadataFixture()}
        history={[]}
        historyError={null}
        canManage={false}
        onReload={async () => true}
        onToast={() => undefined}
      />,
    );
    expect(html).toContain("你可以查看资料来源和修改记录");
    expect(html).not.toContain("保存修改（");
    expect(html).not.toContain("清空有效值");
    expect(html).not.toContain(">撤销<");
  });
});

describe("Album 封面治理", () => {
  const album = {
    id: "library-art",
    title: "Artwork Album",
    albumArtist: "Artist",
    localVersions: [
      {
        id: "local-art",
        title: "Artwork Album",
        albumArtist: "Artist",
        year: 2026,
        matchStatus: "USER_CONFIRMED",
        musicBrainzReleaseId: "123e4567-e89b-42d3-a456-426614174000",
      },
    ],
  } as AlbumDetail;
  const governance = {
    libraryAlbumId: "library-art",
    artworkRevision: 2,
    effectiveArtwork: {
      source: "EMBEDDED",
      url: `/api/v1/artwork/${"a".repeat(64)}`,
      mimeType: "image/jpeg",
      width: 1200,
      height: 1200,
    },
    selectionSource: "USER_SELECTED",
    selectedAssetSha256: "a".repeat(64),
    selectedCandidateId: "candidate-local",
    candidates: [
      {
        id: "candidate-local",
        assetSha256: "a".repeat(64),
        source: "OBSERVED_EMBEDDED",
        localVersionId: "local-art",
        relativePath: "Artist/Album/01.flac",
        kind: "Front Cover",
        mimeType: "image/jpeg",
        width: 1200,
        height: 1200,
        sizeBytes: 120000,
        url: `/api/v1/artwork/${"a".repeat(64)}`,
        current: true,
        selected: true,
        lowResolution: false,
        evidence: {},
      },
    ],
    truncated: false,
  } satisfies AlbumArtworkGovernance;

  it("统一展示有效封面、本地候选、CAA、上传、质量事实与撤销入口", () => {
    const html = renderToStaticMarkup(
      <AlbumArtworkGovernancePanel
        album={album}
        governance={governance}
        history={[
          {
            id: "art-event",
            requestId: "art-request",
            libraryAlbumId: "library-art",
            type: "SELECT",
            actor: { id: "admin", displayName: "管理员" },
            expectedArtworkRevision: 1,
            resultingArtworkRevision: 2,
            assetSha256: "a".repeat(64),
            candidateId: "candidate-local",
            compensatesEventId: null,
            canUndo: true,
            createdAt: "2026-08-14T00:00:00.000Z",
          },
        ]}
        historyError={null}
        canManage
        onReload={async () => true}
        onToast={() => undefined}
      />,
    );
    expect(html).toContain("人工选择");
    expect(html).toContain("1200 × 1200");
    expect(html).toContain("内嵌封面");
    expect(html).toContain("MusicBrainz / CAA");
    expect(html).toContain("导入 CAA 正面封面");
    expect(html).toContain("上传并选中");
    expect(html).toContain("服务端会真实解码校验");
    expect(html).toContain("撤销");
    expect(html).not.toMatch(/Hi-Res|HiRes/);
  });

  it("成员能看证据和历史，但没有选择、导入、上传或撤销按钮", () => {
    const html = renderToStaticMarkup(
      <AlbumArtworkGovernancePanel
        album={album}
        governance={governance}
        history={[]}
        historyError={null}
        canManage={false}
        onReload={async () => true}
        onToast={() => undefined}
      />,
    );
    expect(html).toContain("管理封面");
    expect(html).toContain("内嵌封面");
    expect(html).not.toContain("导入 CAA 正面封面");
    expect(html).not.toContain("上传并选中");
    expect(html).not.toContain(">撤销<");
  });
});

describe("Album 详情身份治理", () => {
  it("合并目标搜索显式保持 Artist 排序", () => {
    expect(mergeTargetAlbumQuery("Miles")).toEqual({
      search: "Miles",
      sort: "ARTIST",
      limit: 25,
    });
  });

  it("从详情页真实提交合并搜索时调用显式 Artist 查询", async () => {
    const album = mountedOrphanAlbum();
    vi.spyOn(api, "album").mockResolvedValue(album);
    vi.spyOn(api, "deliveryTargets").mockResolvedValue([]);
    vi.spyOn(api, "albumDeliveries").mockResolvedValue([]);
    vi.spyOn(api, "albumIntroduction").mockResolvedValue(null);
    vi.spyOn(api, "identityDecisions").mockResolvedValue([]);
    vi.spyOn(api, "metadataHistory").mockResolvedValue([]);
    vi.spyOn(api, "artworkHistory").mockResolvedValue([]);
    vi.spyOn(api, "orphanGovernanceHistory").mockResolvedValue([]);
    vi.spyOn(api, "capabilities").mockResolvedValue({} as never);
    vi.spyOn(api, "lifecyclePlans").mockResolvedValue([]);
    const albumPage = vi.spyOn(api, "albumPage").mockResolvedValue({
      items: [],
      limit: 25,
      offset: 0,
      total: 0,
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryRouter initialEntries={["/albums/mounted-library"]}>
          <Routes>
            <Route path="/albums/:id" element={<AlbumDetailPage canManage />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    const input = renderer!.root
      .findAllByType("input")
      .find((candidate) => candidate.props.placeholder === "搜索唱片或艺术家")!;
    await act(async () => input.props.onChange({ target: { value: "Miles" } }));
    const form = renderer!.root.find(
      (candidate) => candidate.props.className === "identity-merge-search",
    );
    await act(async () => form.props.onSubmit({ preventDefault: vi.fn() }));

    expect(albumPage).toHaveBeenCalledWith({
      search: "Miles",
      sort: "ARTIST",
      limit: 25,
    });
    await act(async () => renderer!.unmount());
  });

  it("为管理员提供确认、设主、拆分和合并入口并明确不修改 NAS", () => {
    const album = {
      id: "library-manual",
      addedAt: "2026-08-12T00:00:00.000Z",
      title: "Manual Album",
      albumArtist: "Artist",
      year: 2026,
      artwork: {
        source: "NONE" as const,
        url: null,
        mimeType: null,
        width: null,
        height: null,
      },
      audioBadge: null,
      audioSummary: null,
      mixedAudioSpecs: false,
      hasDigital: true,
      physicalMedia: [],
      matchStatus: "NEEDS_REVIEW" as const,
      trackCount: 2,
      discCount: 1,
      primaryVersionId: "version-a",
      primaryVersionSource: "AUTOMATIC" as const,
      revision: 0,
      versionCount: 2,
      release: {
        label: null,
        catalogNumber: null,
        barcode: null,
        country: null,
        releaseDate: null,
        musicBrainzReleaseId: null,
      },
      tracks: [],
      physicalCopies: [],
      sourceRoot: null,
    } satisfies AlbumDetail;
    const versions = [
      version({ id: "version-a", isPrimary: true }),
      version({ id: "version-b", isPrimary: false }),
    ];
    const html = renderToStaticMarkup(
      <AlbumIdentityGovernance
        album={album}
        versions={versions}
        canManage
        working={false}
        searchResults={[
          {
            ...album,
            id: "library-target",
            title: "Merge Target",
            primaryVersionId: "target-version",
            versionCount: 1,
          },
        ]}
        targetDetail={{
          ...album,
          id: "library-target",
          title: "Merge Target",
          revision: 4,
          primaryVersionId: "target-version",
          localVersions: [
            version({ id: "target-version", title: "Target Cut" }),
          ],
        }}
        initialTargetId="library-target"
        onSearch={() => undefined}
        onApply={() => undefined}
      />,
    );
    expect(html).toContain("确认同一唱片");
    expect(html).toContain("设为主版本");
    expect(html).toContain("拆出并保持分开");
    expect(html).toContain("跨唱片合并搜索");
    expect(html).toContain("Target Cut");
    expect(html).toContain("24/96");
    expect(html).toContain("不会移动、改名或删除 NAS 文件");
  });

  it("以纯函数构造完整 CONFIRM、SET_PRIMARY、SPLIT、MERGE 命令", () => {
    const album = {
      id: "library-source",
      revision: 7,
      primaryVersionId: "version-a",
    } as AlbumDetail;
    const target = {
      id: "library-target",
      revision: 9,
    } as AlbumDetail;
    const versions = [
      version({ id: "version-a" }),
      version({ id: "version-b" }),
    ];
    expect(buildConfirmIdentityCommand(album, "confirm-request")).toEqual({
      type: "CONFIRM",
      requestId: "confirm-request",
      revision: 7,
      primaryVersionId: "version-a",
    });
    expect(
      buildSetPrimaryIdentityCommand(album, "version-b", "primary-request"),
    ).toEqual({
      type: "SET_PRIMARY",
      requestId: "primary-request",
      revision: 7,
      primaryVersionId: "version-b",
    });
    expect(
      buildSplitIdentityCommand(album, versions, "version-b", "split-request"),
    ).toEqual({
      type: "SPLIT",
      requestId: "split-request",
      revision: 7,
      partitions: [
        { versionIds: ["version-a"] },
        { versionIds: ["version-b"] },
      ],
    });
    expect(
      buildMergeIdentityCommand(
        album,
        target,
        "target-version",
        "merge-request",
      ),
    ).toEqual({
      type: "MERGE",
      requestId: "merge-request",
      revision: 7,
      targetLibraryAlbumId: "library-target",
      targetRevision: 9,
      primaryVersionId: "target-version",
    });
  });

  it("只接受最新合并搜索，并明确渲染搜索与历史错误", () => {
    const tracker = createLatestRequestTracker();
    const first = tracker.begin();
    const second = tracker.begin();
    expect(tracker.isLatest(first)).toBe(false);
    expect(tracker.isLatest(second)).toBe(true);
    tracker.invalidate();
    expect(tracker.isLatest(second)).toBe(false);

    const governance = renderToStaticMarkup(
      <AlbumIdentityGovernance
        album={{} as AlbumDetail}
        versions={[]}
        canManage
        working={false}
        searchResults={[]}
        searchError="搜索服务暂不可用"
        onSearch={() => undefined}
        onApply={() => undefined}
      />,
    );
    expect(governance).toContain("搜索服务暂不可用");
    const history = renderToStaticMarkup(
      <AlbumIdentityHistory
        decisions={[]}
        error="网络错误"
        canManage={false}
        working={false}
        onUndo={() => undefined}
      />,
    );
    expect(history).toContain("版本修改记录加载失败");
    expect(history).not.toContain("尚无人工身份决定");
  });

  it("成员只读，历史仅对仍可撤销的决定展示撤销", () => {
    const readonly = renderToStaticMarkup(
      <AlbumIdentityGovernance
        album={{} as AlbumDetail}
        versions={[]}
        canManage={false}
        working={false}
        searchResults={[]}
        onSearch={() => undefined}
        onApply={() => undefined}
      />,
    );
    expect(readonly).toContain("版本关系为只读");
    expect(readonly).not.toContain("确认同一唱片");
    const history = renderToStaticMarkup(
      <AlbumIdentityHistory
        decisions={[
          {
            id: "decision-confirm",
            requestId: "request-confirm",
            libraryAlbumId: "library-manual",
            type: "CONFIRM",
            actor: { id: "admin", displayName: "管理员" },
            expectedRevision: 0,
            resultingRevision: 1,
            details: {
              targetLibraryAlbumId: null,
              primaryVersionId: "version-a",
              partitions: [],
              compensatedDecisionId: null,
            },
            affectedLibraryAlbumIds: ["library-manual"],
            compensatesDecisionId: null,
            canUndo: true,
            createdAt: "2026-08-13T00:00:00.000Z",
          },
        ]}
        canManage
        working={false}
        onUndo={() => undefined}
      />,
    );
    expect(history).toContain("确认同一唱片");
    expect(history).toContain("管理员");
    expect(history).toContain("撤销");
  });
});

function testRendererText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) =>
      typeof child === "string" ? child : testRendererText(child),
    )
    .join("");
}

function mountedOrphanPreview() {
  const expected = {
    scanJobId: "mounted-scan",
    rootId: "physical",
    localVersionId: "mounted-version",
    classification: "ORPHAN" as const,
    reasons: ["NO_CURRENT_FACT" as const],
    libraryAlbumId: "mounted-library",
    libraryRevision: 0,
    visibility: "VISIBLE" as const,
    visibilityRevision: 0,
    primaryVersionId: "mounted-version",
    memberVersionIds: ["mounted-version"],
    currentMemberVersionIds: [],
    referenceFingerprint: "1".repeat(64),
    memberFacts: [
      {
        localVersionId: "mounted-version",
        classification: "ORPHAN" as const,
        reasons: ["NO_CURRENT_FACT" as const],
        isPrimary: true,
        referenceFingerprint: "2".repeat(64),
      },
    ],
  };
  return {
    schema: "cocean.library-orphan-governance-preview/v1" as const,
    action: "CLOSE_ORPHAN_IDENTITY" as const,
    executable: true,
    before: expected,
    replacementPrimaryVersionId: null,
    affectedLibraryAlbumIds: ["mounted-library"],
    expected,
    expectedFingerprint: "3".repeat(64),
    blockers: [],
  };
}

function mountedOrphanAlbum(): AlbumDetail {
  return {
    id: "mounted-library",
    addedAt: "2026-08-12T00:00:00.000Z",
    title: "Mounted",
    albumArtist: "Artist",
    year: null,
    artwork: {
      source: "NONE",
      url: null,
      mimeType: null,
      width: null,
      height: null,
    },
    audioBadge: null,
    audioSummary: null,
    mixedAudioSpecs: false,
    hasDigital: false,
    physicalMedia: [],
    matchStatus: "UNMATCHED",
    primaryVersionSource: "AUTOMATIC",
    primaryVersionId: "mounted-version",
    visibility: "VISIBLE",
    visibilityRevision: 0,
    revision: 0,
    trackCount: 0,
    discCount: 1,
    sourceVersionCount: 1,
    duplicateFileCount: 0,
    aggregationIssues: [],
    issues: [],
    release: {
      label: null,
      catalogNumber: null,
      barcode: null,
      country: null,
      releaseDate: null,
      musicBrainzReleaseId: null,
    },
    tracks: [],
    physicalCopies: [],
    sourceRoot: null,
    versionCount: 1,
    localVersions: [
      version({
        id: "mounted-version",
        title: "Mounted",
        fileCount: 0,
        trackCount: 0,
        sizeBytes: 0,
        sourceRoot: null,
        relativePath: null,
      }),
    ],
  } as AlbumDetail;
}

function version(patch: Partial<LocalVersionSummary>): LocalVersionSummary {
  return {
    id: "version",
    title: "Album",
    albumArtist: "Artist",
    year: 2020,
    isPrimary: false,
    relationshipStatus: "AUTO_CANDIDATE",
    sourceRoot: {
      id: "music",
      name: "Music",
      containerPath: "/library/music",
      readOnly: true,
    },
    relativePath: "Artist/Album/01.flac",
    audioBadge: "24/96",
    mixedAudioSpecs: false,
    trackCount: 1,
    fileCount: 1,
    sizeBytes: 1,
    sourceVersionCount: 1,
    duplicateFileCount: 0,
    completeness: "COMPLETE",
    issues: [],
    ...patch,
  };
}

describe("Album 详情完整性与兼容展示", () => {
  it("解释组级身份重叠、缺轨与封面证据", () => {
    const html = renderToStaticMarkup(
      <AlbumIntegrityIssues
        issues={[
          {
            code: "IDENTITY_OVERLAP",
            versionId: null,
            evidence: { versionCount: 2, basis: "NORMALIZED_TITLE_ARTIST" },
          },
          {
            code: "INCOMPLETE_TRACKS",
            versionId: "short",
            evidence: {
              aggregationIssues: [
                { code: "MISSING_TRACK", expected: 21, actual: 2 },
              ],
            },
          },
          {
            code: "LOW_RES_ARTWORK",
            versionId: "short",
            evidence: { width: 599, height: 600 },
          },
        ]}
      />,
    );
    expect(html).toContain("唱片完整性问题");
    expect(html).toContain("2 个本地版本");
    expect(html).toContain("规范化标题与艺术家相同");
    expect(html).toContain("预期 21 / 实际 2");
    expect(html).toContain("封面 599×600");
  });

  it("实体收藏不显示托管，并为旧详情恢复数字版本与折叠事实", () => {
    const physical = renderToStaticMarkup(
      <AlbumLocalVersions
        versions={[version({ sourceRoot: null, relativePath: null })]}
        versionCount={1}
      />,
    );
    expect(physical).toContain("实体收藏");
    expect(physical).not.toContain("实体收藏<!-- --> · <!-- -->托管");
    const legacy = legacyLocalVersions({
      id: "legacy",
      addedAt: "2026-08-12T00:00:00.000Z",
      title: "Legacy",
      albumArtist: "Artist",
      year: 2020,
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
      matchStatus: "TRACKS_INCOMPLETE",
      primaryVersionSource: "AUTOMATIC",
      revision: 0,
      trackCount: 2,
      discCount: 1,
      sourceVersionCount: 3,
      duplicateFileCount: 1,
      aggregationIssues: [],
      release: {
        label: null,
        catalogNumber: null,
        barcode: null,
        country: null,
        releaseDate: null,
        musicBrainzReleaseId: null,
      },
      tracks: [],
      physicalCopies: [],
      sourceRoot: {
        id: "music",
        name: "Music",
        containerPath: "/library/music",
        readOnly: true,
      },
    } satisfies AlbumDetail);
    const html = renderToStaticMarkup(
      <AlbumLocalVersions versions={legacy} versionCount={1} />,
    );
    expect(html).toContain("2 首");
    expect(html).toContain("3 个文件");
    expect(html).toContain("3 个来源副本");
    expect(html).toContain("已归并 1 个重复文件");
    expect(html).toContain("曲目不完整");
  });
});

function metadataFixture(): AlbumMetadata {
  const field = (
    observed: string | number | null,
    effective = observed,
    override = false,
  ) => ({
    observed: {
      value: observed,
      source: "OBSERVED_TAG" as const,
      versionId: "version-a",
    },
    confirmedExternal: null,
    userOverride: override
      ? {
          value: effective,
          actor: { id: "admin", displayName: "管理员" },
          updatedAt: "2026-08-14T00:00:00.000Z",
        }
      : null,
    effectiveValue: effective,
    effectiveSource: override
      ? ("USER_OVERRIDE" as const)
      : ("OBSERVED_TAG" as const),
  });
  return {
    libraryAlbumId: "library-a",
    metadataRevision: 1,
    album: {
      title: field("扫描标题", "人工标题", true),
      albumArtist: field("艺术家"),
      year: field(2020),
    },
    versions: [
      {
        versionId: "version-a",
        fields: {
          label: field("厂牌"),
          catalogNumber: field(null),
          barcode: field(null),
          country: field("CN"),
          releaseDate: field("2020-01-01"),
        },
      },
    ],
    observedIssues: [],
  };
}
