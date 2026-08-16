import type {
  LibraryChangePlan,
  LibraryChangePlanRead,
  RecentlyDeletedItem,
} from "@cocean/contracts";
import { MemoryRouter } from "react-router-dom";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../api.js";
import {
  QuarantinePage,
  RestoreAction,
  safeLifecycleMessage,
} from "./quarantine.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("最近删除页面", () => {
  it.each([
    ["ADMIN", true, "恢复到原位置"],
    ["MEMBER", false, "成员只读"],
  ] as const)(
    "%s 直接访问超过首屏范围的 source plan 时仍精确定位",
    async (_role, canManage, expectedAction) => {
      const source = canManage ? adminPlan() : memberPlan();
      const item = recentlyDeletedItem(source, null);
      vi.spyOn(api, "quarantinedVersions").mockResolvedValue(page([], 137));
      vi.spyOn(api, "lifecyclePlan").mockResolvedValue(source);
      vi.spyOn(api, "recentlyDeletedVersion").mockResolvedValue(item);

      const renderer = await renderPage(canManage, "/quarantine?plan=source");
      const text = rendererText(renderer.root);
      expect(text).toContain("137");
      expect(text).toContain("Kind of Blue");
      expect(text).toContain("已定位到对应的最近删除记录");
      expect(text).toContain(expectedAction);
      expect(
        renderer.root.findByProps({ "aria-current": "true" }),
      ).toBeTruthy();
      expect(text).not.toContain("version-internal-id");
      await act(async () => renderer.unmount());
    },
  );

  it.each([
    ["PREVIEWED", "恢复预览等待确认", "继续确认恢复"],
    ["QUEUED", "恢复等待执行", "取消等待中的恢复"],
    ["RUNNING", "正在恢复到原位置", "正在恢复到原位置"],
    ["RECOVERY_REQUIRED", "恢复需要人工处理", "重新核验"],
    ["FAILED", "恢复失败，可重新预览", "重新预览恢复"],
    ["CANCELLED", "恢复已取消，可重新预览", "重新预览恢复"],
    ["SUCCEEDED", "已恢复到原位置，正在刷新", "正在刷新"],
  ] as const)(
    "latest restore=%s 时渲染准确状态和动作",
    async (status, statusText, actionText) => {
      const item = recentlyDeletedItem(adminPlan(), restorePlan(status));
      mockCurrent(item);
      const renderer = await renderPage(true);
      const text = rendererText(renderer.root);
      expect(text).toContain(statusText);
      expect(text).toContain(actionText);
      if (
        ["PREVIEWED", "QUEUED", "RUNNING", "RECOVERY_REQUIRED"].includes(status)
      )
        expect(text).not.toContain("重新预览恢复");
      await act(async () => renderer.unmount());
    },
  );

  it.each([
    ["PREVIEWED", "取消预览", "cancelLifecyclePlan"],
    ["QUEUED", "取消等待中的恢复", "cancelLifecyclePlan"],
    ["RECOVERY_REQUIRED", "重新核验", "retryLifecyclePlan"],
  ] as const)(
    "%s 动作使用关联 restore plan id",
    async (status, buttonText, method) => {
      const restore = restorePlan(status);
      const item = recentlyDeletedItem(adminPlan(), restore);
      mockCurrent(item);
      const mutation = vi
        .spyOn(api, method)
        .mockResolvedValue(restore as unknown as LibraryChangePlan);
      const renderer = await renderPage(true);
      await clickButton(renderer, buttonText);
      expect(mutation).toHaveBeenCalledWith("restore-plan", expect.any(String));
      await act(async () => renderer.unmount());
    },
  );

  it("恢复关联未知时 fail closed，保留已加载数据并禁用新恢复", async () => {
    const item = recentlyDeletedItem(adminPlan(), null);
    vi.spyOn(api, "quarantinedVersions")
      .mockResolvedValueOnce(page([item], 1))
      .mockRejectedValueOnce(new Error("恢复关联查询超时"));
    vi.spyOn(api, "createRestorePlan").mockResolvedValue(
      restorePlan("PREVIEWED") as unknown as LibraryChangePlan,
    );
    const renderer = await renderPage(true);
    await clickButton(renderer, "恢复到原位置");
    const text = rendererText(renderer.root);
    expect(text).toContain("Kind of Blue");
    expect(text).toContain("恢复关联查询超时");
    expect(text).toContain("恢复状态未知，暂不可操作");
    await act(async () => renderer.unmount());
  });

  it("current loading/error 不显示已恢复或空态", async () => {
    vi.spyOn(api, "quarantinedVersions").mockRejectedValue(
      new Error("current projection unavailable"),
    );
    const renderer = await renderPage(true);
    const text = rendererText(renderer.root);
    expect(text).toContain("无法读取最近删除");
    expect(text).toContain("current projection unavailable");
    expect(text).not.toContain("已经恢复到原位置");
    expect(text).not.toContain("最近删除为空");
    await act(async () => renderer.unmount());
  });

  it.each([
    ["PREVIEWED", "等待确认"],
    ["QUEUED", "等待执行"],
    ["RUNNING", "执行中"],
    ["FAILED", "失败"],
    ["CANCELLED", "已取消"],
    ["RECOVERY_REQUIRED", "需要人工处理"],
  ] as const)(
    "非 SUCCEEDED source=%s 不会误报已恢复",
    async (status, label) => {
      const source = adminPlan({ status });
      vi.spyOn(api, "quarantinedVersions").mockResolvedValue(page([], 0));
      vi.spyOn(api, "lifecyclePlan").mockResolvedValue(source);
      vi.spyOn(api, "recentlyDeletedVersion").mockRejectedValue(
        new ApiError(404, "RECENTLY_DELETED_NOT_FOUND", "not current"),
      );
      const renderer = await renderPage(true, "/quarantine?plan=source");
      const text = rendererText(renderer.root);
      expect(text).toContain(`当前状态为“${label}”`);
      expect(text).not.toContain("已经恢复到原位置");
      await act(async () => renderer.unmount());
    },
  );

  it("成功 restore 深链明确已恢复，缺 sourcePlanId 明确不可定位", async () => {
    const restored = restorePlan("SUCCEEDED");
    vi.spyOn(api, "quarantinedVersions").mockResolvedValue(page([], 0));
    vi.spyOn(api, "lifecyclePlan").mockResolvedValue(restored);
    vi.spyOn(api, "recentlyDeletedVersion").mockRejectedValue(
      new ApiError(404, "RECENTLY_DELETED_NOT_FOUND", "not current"),
    );
    const renderer = await renderPage(true, "/quarantine?plan=restore-plan");
    expect(rendererText(renderer.root)).toContain("已经恢复到原位置");
    await act(async () => renderer.unmount());

    vi.restoreAllMocks();
    vi.spyOn(api, "quarantinedVersions").mockResolvedValue(page([], 0));
    vi.spyOn(api, "lifecyclePlan").mockResolvedValue({
      ...restored,
      sourcePlanId: null,
    });
    const missing = await renderPage(true, "/quarantine?plan=restore-plan");
    expect(rendererText(missing.root)).toContain("恢复记录缺少源记录");
    await act(async () => missing.unmount());
  });

  it("可继续加载第二页并发现第 101 条记录", async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      recentlyDeletedItem(adminPlan({ id: `source-${index}` }), null),
    );
    const last = recentlyDeletedItem(
      {
        ...adminPlan({ id: "source-100" }),
        object: { title: "第 101 条唱片", albumArtist: "Artist" },
      },
      null,
    );
    vi.spyOn(api, "quarantinedVersions")
      .mockResolvedValueOnce(page(first, 101, 0))
      .mockResolvedValueOnce(page([last], 101, 100));
    const renderer = await renderPage(true);
    await clickButton(renderer, "加载更多");
    expect(rendererText(renderer.root)).toContain("第 101 条唱片");
    await act(async () => renderer.unmount());
  });

  it("终态轮询的最后一次刷新同时清除旧 current 精确快照", async () => {
    vi.useFakeTimers();
    const queued = recentlyDeletedItem(adminPlan(), restorePlan("QUEUED"));
    vi.spyOn(api, "quarantinedVersions")
      .mockResolvedValueOnce(page([queued], 1))
      .mockResolvedValue(page([], 0));
    vi.spyOn(api, "lifecyclePlan").mockResolvedValue(adminPlan());
    vi.spyOn(api, "recentlyDeletedVersion")
      .mockResolvedValueOnce(queued)
      .mockRejectedValue(
        new ApiError(404, "RECENTLY_DELETED_NOT_FOUND", "not current"),
      );
    const renderer = await renderPage(true, "/quarantine?plan=source");
    expect(rendererText(renderer.root)).toContain("恢复等待执行");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    const text = rendererText(renderer.root);
    expect(text).toContain("已经成功恢复");
    expect(text).not.toContain("恢复等待执行");
    expect(text).not.toContain("正在恢复到原位置");
    await act(async () => renderer.unmount());
  });
});

describe("RestoreAction", () => {
  it("关联未知时不提供可点击动作", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <RestoreAction
          sourcePlan={adminPlan()}
          restorePlan={null}
          working={false}
          associationKnown={false}
          onPreview={vi.fn()}
          onContinue={vi.fn()}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
    });
    expect(rendererText(renderer.root)).toContain("恢复状态未知");
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
    await act(async () => renderer.unmount());
  });
});

describe("生命周期错误脱敏", () => {
  it.each([
    ["/library/music/Artist/Album/01.flac 冲突", "Unix 绝对路径"],
    ["C:\\Music\\Artist\\Album\\01.flac 冲突", "Windows 路径"],
    ["C:/Music/Artist/Album/01.flac 冲突", "Windows 正斜杠路径"],
    ["\\\\nas\\Music\\Artist\\01.flac 冲突", "UNC 路径"],
    ["Artist/Album/01.flac 冲突", "相对路径"],
    [`校验 ${"a".repeat(64)} 不一致`, "SHA-256"],
  ])("隐藏%s", (message) => {
    const result = safeLifecycleMessage(message);
    expect(result).toContain("已隐藏");
    expect(result).not.toContain("01.flac");
    expect(result).not.toContain("a".repeat(64));
  });

  it("保留一般非敏感错误", () => {
    expect(safeLifecycleMessage("目标文件已存在，请先处理冲突")).toBe(
      "目标文件已存在，请先处理冲突",
    );
  });
});

function mockCurrent(item: RecentlyDeletedItem): void {
  vi.spyOn(api, "quarantinedVersions").mockResolvedValue(page([item], 1));
}

async function renderPage(canManage: boolean, entry = "/quarantine") {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <MemoryRouter initialEntries={[entry]}>
        <QuarantinePage canManage={canManage} />
      </MemoryRouter>,
    );
  });
  return renderer!;
}

async function clickButton(
  renderer: TestRenderer.ReactTestRenderer,
  text: string,
): Promise<void> {
  const button = renderer.root
    .findAllByType("button")
    .find((candidate) => rendererText(candidate).includes(text));
  expect(button, `button ${text}`).toBeTruthy();
  await act(async () => {
    button!.props.onClick();
    await Promise.resolve();
  });
}

function page(
  items: RecentlyDeletedItem[],
  total = items.length,
  offset = 0,
): Awaited<ReturnType<typeof api.quarantinedVersions>> {
  return { items, total, limit: 100, offset };
}

function recentlyDeletedItem(
  source: LibraryChangePlanRead,
  latestRestore: LibraryChangePlanRead | null,
): RecentlyDeletedItem {
  return { source, latestRestore };
}

function memberPlan(
  overrides: Partial<LibraryChangePlanRead> = {},
): LibraryChangePlanRead {
  return {
    id: "source",
    action: "QUARANTINE_VERSION",
    status: "SUCCEEDED",
    sourcePlanId: null,
    fileCount: 8,
    totalBytes: 8_000,
    error: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    confirmedAt: "2026-08-16T00:01:00.000Z",
    startedAt: "2026-08-16T00:02:00.000Z",
    finishedAt: "2026-08-16T00:03:00.000Z",
    completedFiles: 8,
    object: { title: "Kind of Blue", albumArtist: "Miles Davis" },
    ...overrides,
  } as LibraryChangePlanRead;
}

function adminPlan(
  overrides: Partial<LibraryChangePlan> = {},
): LibraryChangePlanRead {
  return {
    id: "source",
    requestId: "request-source",
    action: "QUARANTINE_VERSION",
    status: "SUCCEEDED",
    libraryAlbumId: "album-internal-id",
    localVersionId: "version-internal-id",
    root: { id: "music", name: "Music", policy: "MANAGED" },
    sourcePlanId: null,
    expectedLibraryRevision: 1,
    executable: true,
    blockers: [],
    fileCount: 8,
    totalBytes: 8_000,
    items: [],
    actor: { id: "admin", displayName: "Admin" },
    error: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    confirmedAt: "2026-08-16T00:01:00.000Z",
    startedAt: "2026-08-16T00:02:00.000Z",
    finishedAt: "2026-08-16T00:03:00.000Z",
    completedFiles: 8,
    object: { title: "Kind of Blue", albumArtist: "Miles Davis" },
    ...overrides,
  } as LibraryChangePlanRead;
}

function restorePlan(
  status: LibraryChangePlan["status"],
): LibraryChangePlanRead {
  return {
    ...(adminPlan() as LibraryChangePlan),
    id: "restore-plan",
    requestId: "request-restore",
    action: "RESTORE_VERSION",
    status,
    sourcePlanId: "source",
    completedFiles: status === "SUCCEEDED" ? 8 : 0,
    items: [
      {
        ordinal: 0,
        mediaFileId: "file-one",
        sourceRelativePath: "Artist/Album/01.flac",
        quarantineRelativePath: "source/Artist/Album/01.flac",
        sizeBytes: 1_000,
        sha256: "a".repeat(64),
        status: status === "SUCCEEDED" ? "RESTORED" : "CONFLICT",
        finalSizeBytes: null,
        finalSha256: null,
        error:
          status === "RECOVERY_REQUIRED" ? "Artist/Album/01.flac 已存在" : null,
      },
    ],
  } as LibraryChangePlanRead;
}

function rendererText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : rendererText(child)))
    .join("");
}
