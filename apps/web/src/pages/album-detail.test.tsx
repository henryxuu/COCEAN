import type {
  AlbumDetail,
  AlbumMetadata,
  DeliveryJob,
  LocalVersionSummary,
} from "@cocean/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AlbumDeliveryRecord,
  AlbumIdentityGovernance,
  AlbumIdentityHistory,
  AlbumIntegrityIssues,
  AlbumLocalVersions,
  AlbumMetadataGovernance,
  buildConfirmIdentityCommand,
  buildMetadataCommands,
  buildMergeIdentityCommand,
  buildSetPrimaryIdentityCommand,
  buildSplitIdentityCommand,
  createLatestRequestTracker,
  legacyLocalVersions,
} from "./album-detail.js";

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
      <AlbumLocalVersions versions={versions} versionCount={2} />,
    );
    expect(html).toContain("主版本");
    expect(html).toContain("本地版本");
    expect(html).toContain("PCM 24/96");
    expect(html).toContain("21 首");
    expect(html).toContain("2 首");
    expect(html).toContain("自动候选 · 待确认");
    expect(html).toContain("曲目不完整");
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
    expect(html).toContain("唱片级字段");
    expect(html).toContain("版本级字段");
    expect(html).toContain("来源：人工覆盖");
    expect(html).toContain("观察值：扫描标题");
    expect(html).toContain("保存修改（0 个字段）");
    expect(html).toContain("清空有效值");
    expect(html).toContain("移除人工覆盖 / 恢复下一层可信值");
    expect(html).toContain("撤销");
    expect(html).toContain("仅修改 COCEAN 数据库");
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
    expect(html).toContain("成员与 Demo 可以查看来源和历史");
    expect(html).not.toContain("保存修改（");
    expect(html).not.toContain("清空有效值");
    expect(html).not.toContain(">撤销<");
  });
});

describe("Album 详情身份治理", () => {
  it("为管理员提供确认、设主、拆分和合并入口并明确不修改 NAS", () => {
    const album = {
      id: "library-manual",
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
    expect(history).toContain("身份历史加载失败");
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
    expect(readonly).toContain("身份治理为只读");
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
    expect(html).toContain("折叠 1 个重复文件");
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
