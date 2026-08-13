import type { DeliveryJob } from "@cocean/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { groupDeliveryPlans } from "../delivery-plan.js";
import { DeliveryPlanRecord, DeliveryTaskRecord } from "./tasks.js";

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
