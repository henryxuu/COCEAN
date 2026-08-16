import type { DeliveryJob, LibraryChangePlanRead } from "@cocean/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api.js";
import { groupDeliveryPlans } from "../delivery-plan.js";
import {
  DeliveryPlanRecord,
  DeliveryTaskRecord,
  LifecycleTaskRecord,
  TasksPage,
} from "./tasks.js";

afterEach(() => vi.restoreAllMocks());

describe("任务页投送记录渲染", () => {
  it("可观察地渲染总体进度、活动 ETA、失败状态与每张 Album 子记录", () => {
    const jobs = [
      deliveryJob("one", "COMPLETED", 400, 400, 4, 4, true),
      deliveryJob("two", "RUNNING", 600, 200, 6, 2, false),
      deliveryJob("three", "FAILED", 200, 0, 2, 0, false),
    ];
    const plan = groupDeliveryPlans(jobs)[0]!;

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DeliveryPlanRecord
          plan={plan}
          now={Date.parse("2026-08-13T00:10:00.000Z")}
        />
      </MemoryRouter>,
    );

    expect(html).toContain("投送计划 · 3 张专辑");
    expect(html).toContain("投送计划进度 50%");
    expect(html).toContain("预计剩余 20 分钟");
    expect(html).toContain("执行中 · 有失败");
    expect(html).toContain("6/12 个文件");
    expect(html).toContain('href="/albums/album-one"');
    expect(html).toContain('href="/albums/album-two"');
    expect(html).toContain('href="/albums/album-three"');
    expect(html).toContain("Album one");
    expect(html).toContain("失败 · 0/2");
  });

  it("完成后明确渲染持久化清单导出的 9/9", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DeliveryTaskRecord
          job={deliveryJob("done", "COMPLETED", 900, 900, 9, 9, true)}
        />
      </MemoryRouter>,
    );

    expect(html).toContain("9/9 个文件");
    expect(html).toContain("已完成");
  });
});

describe("任务页文件管理记录", () => {
  it("以对象名称和用户语言定位最近删除记录，不把内部 ID 当标题", () => {
    const plan = lifecyclePlan();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LifecycleTaskRecord plan={plan} highlighted />
      </MemoryRouter>,
    );

    expect(html).toContain("Kind of Blue");
    expect(html).toContain("Miles Davis");
    expect(html).toContain("移到最近删除");
    expect(html).toContain("已处理 8/8");
    expect(html).toContain('href="/quarantine?plan=plan-source"');
    expect(html).not.toContain("version-internal-id");
  });

  it("生命周期 API 失败时显示真实错误而不是伪造空态", async () => {
    vi.spyOn(api, "scans").mockResolvedValue([]);
    vi.spyOn(api, "deliveries").mockResolvedValue([]);
    vi.spyOn(api, "lifecyclePlans").mockRejectedValue(
      new Error("生命周期账本暂时不可读"),
    );
    vi.spyOn(api, "quarantinedVersions").mockRejectedValue(
      new Error("生命周期账本暂时不可读"),
    );

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryRouter>
          <TasksPage canManage={false} />
        </MemoryRouter>,
      );
    });
    const text = rendererText(renderer!.root);
    expect(text).toContain("最近删除数量读取失败");
    expect(text).toContain("文件管理历史读取失败");
    expect(text).toContain("生命周期账本暂时不可读");
    expect(text).not.toContain("暂无文件管理任务");
    await act(async () => renderer!.unmount());
  });

  it("restore plan 深链请求源记录、排到首位高亮并生成 source link", async () => {
    vi.spyOn(api, "scans").mockResolvedValue([]);
    vi.spyOn(api, "deliveries").mockResolvedValue([]);
    const source = lifecyclePlan();
    const restore: LibraryChangePlanRead = {
      ...lifecyclePlan(),
      id: "restore-plan",
      action: "RESTORE_VERSION" as const,
      sourcePlanId: "plan-source",
    };
    const history: LibraryChangePlanRead[] = Array.from(
      { length: 8 },
      (_, index) => ({
        ...lifecyclePlan(),
        id: `other-${index}`,
        object: { title: `Other ${index}`, albumArtist: "Artist" },
      }),
    );
    history[7] = source;
    vi.spyOn(api, "lifecyclePlans").mockResolvedValue(history);
    vi.spyOn(api, "quarantinedVersions").mockResolvedValue({
      items: [],
      total: 1,
      limit: 100,
      offset: 0,
    });
    const detail = vi
      .spyOn(api, "lifecyclePlan")
      .mockImplementation((id) =>
        Promise.resolve(id === "restore-plan" ? restore : source),
      );

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryRouter initialEntries={["/tasks?plan=restore-plan"]}>
          <TasksPage canManage />
        </MemoryRouter>,
      );
    });
    expect(detail).toHaveBeenCalledWith("restore-plan");
    expect(detail).toHaveBeenCalledWith("plan-source");
    const highlighted = renderer!.root.findByProps({ "aria-current": "true" });
    expect(rendererText(highlighted)).toContain("Kind of Blue");
    expect(
      renderer!.root
        .findAllByType("a")
        .some((link) => link.props.href === "/quarantine?plan=plan-source"),
    ).toBe(true);
    expect(rendererText(renderer!.root)).toContain("展开全部");
    await clickButton(renderer!, "展开全部");
    expect(rendererText(renderer!.root)).toContain("Other 6");
    await act(async () => renderer!.unmount());
  });

  it.each(["history", "total"] as const)(
    "%s API 单侧失败时保留另一侧成功数据",
    async (failure) => {
      vi.spyOn(api, "scans").mockResolvedValue([]);
      vi.spyOn(api, "deliveries").mockResolvedValue([]);
      const history = vi.spyOn(api, "lifecyclePlans");
      const total = vi.spyOn(api, "quarantinedVersions");
      if (failure === "history") {
        history.mockRejectedValue(new Error("历史暂不可用"));
        total.mockResolvedValue({
          items: [],
          total: 23,
          limit: 100,
          offset: 0,
        });
      } else {
        history.mockResolvedValue([lifecyclePlan()]);
        total.mockRejectedValue(new Error("数量暂不可用"));
      }
      let renderer: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <MemoryRouter>
            <TasksPage canManage={false} />
          </MemoryRouter>,
        );
      });
      const text = rendererText(renderer!.root);
      if (failure === "history") {
        expect(text).toContain("最近删除 23 项");
        expect(text).toContain("历史暂不可用");
      } else {
        expect(text).toContain("Kind of Blue");
        expect(text).toContain("数量暂不可用");
      }
      await act(async () => renderer!.unmount());
    },
  );
});

function lifecyclePlan(): LibraryChangePlanRead {
  return {
    id: "plan-source",
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
    error: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    confirmedAt: "2026-08-16T00:01:00.000Z",
    startedAt: "2026-08-16T00:02:00.000Z",
    finishedAt: "2026-08-16T00:03:00.000Z",
    completedFiles: 8,
    object: { title: "Kind of Blue", albumArtist: "Miles Davis" },
  };
}

function deliveryJob(
  suffix: string,
  status: DeliveryJob["status"],
  totalBytes: number,
  transferredBytes: number,
  fileCount: number,
  completedFileCount: number,
  verified: boolean,
): DeliveryJob {
  return {
    id: `job-${suffix}`,
    albumId: `album-${suffix}`,
    albumTitle: `Album ${suffix}`,
    targetId: "sp3000m",
    targetName: "SP3000M",
    transport: "AK_FILE_DROP",
    status,
    fileCount,
    completedFileCount,
    totalBytes,
    transferredBytes,
    verified,
    error: status === "FAILED" ? "上传失败" : null,
    createdAt: "2026-08-13T00:00:00.000Z",
    startedAt: status === "RUNNING" ? "2026-08-13T00:00:00.000Z" : null,
    finishedAt: status === "RUNNING" ? null : "2026-08-13T00:05:00.000Z",
    planId: "plan-one",
  };
}

function rendererText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : rendererText(child)))
    .join("");
}

async function clickButton(
  renderer: TestRenderer.ReactTestRenderer,
  text: string,
): Promise<void> {
  const button = renderer.root
    .findAllByType("button")
    .find((candidate) => rendererText(candidate).includes(text));
  expect(button).toBeTruthy();
  await act(async () => button!.props.onClick());
}
