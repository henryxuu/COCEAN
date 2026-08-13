import type { DeliveryJob } from "@cocean/contracts";
import { describe, expect, it } from "vitest";
import { groupDeliveryPlans, summarizeDeliveryPlan } from "./delivery-plan.js";

describe("多专辑投送计划", () => {
  it("按 planId 聚合总体大小、文件数、进度和 ETA，同时保留 Album 子任务", () => {
    const now = Date.parse("2026-08-13T00:10:00.000Z");
    const jobs = [
      deliveryJob("one", "COMPLETED", 400, 400, 4),
      deliveryJob("two", "RUNNING", 600, 200, 6),
      deliveryJob("three", "FAILED", 200, 0, 2),
    ];

    const plans = groupDeliveryPlans(jobs);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.jobs.map((job) => job.albumId)).toEqual([
      "album-one",
      "album-two",
      "album-three",
    ]);
    expect(summarizeDeliveryPlan(plans[0]!.jobs, now)).toEqual({
      totalBytes: 1200,
      transferredBytes: 600,
      fileCount: 12,
      completedFileCount: 4,
      completed: 1,
      failed: true,
      cancelled: false,
      active: true,
      percent: 50,
      eta: "20 分钟",
      statusLabel: "执行中 · 有失败",
    });
  });

  it("没有 planId 的历史任务不会被改写或彼此合并", () => {
    const first = {
      ...deliveryJob("old-one", "COMPLETED", 10, 10, 1),
      planId: null,
    };
    const second = {
      ...deliveryJob("old-two", "COMPLETED", 10, 10, 1),
      planId: null,
    };

    expect(
      groupDeliveryPlans([first, second]).map((plan) => plan.jobs),
    ).toEqual([[first], [second]]);
  });

  it("即使客户端错误复用同一 planId，也不会跨目标合并", () => {
    const first = deliveryJob("one", "RUNNING", 100, 10, 1);
    const second = {
      ...deliveryJob("two", "RUNNING", 100, 20, 1),
      targetId: "other-target",
      targetName: "Other Player",
    };

    const plans = groupDeliveryPlans([first, second]);
    expect(plans).toHaveLength(2);
    expect(plans.map((plan) => plan.targetId)).toEqual([
      "sp3000m",
      "other-target",
    ]);
  });

  it.each([
    ["CANCELLED", true, "已取消"],
    ["COMPLETED", false, "部分失败"],
  ] as const)(
    "%s 终态（verified=%s）绝不会显示全部完成，且没有 ETA",
    (status, verified, statusLabel) => {
      const job = {
        ...deliveryJob("terminal", status, 100, 100, 1),
        verified,
      };
      const summary = summarizeDeliveryPlan([job]);
      expect(summary.statusLabel).toBe(statusLabel);
      expect(summary.completed).toBe(0);
      expect(summary.eta).toBeNull();
    },
  );

  it("只有已校验 COMPLETED 才计为完成并显示全部完成与 9/9", () => {
    const job = {
      ...deliveryJob("done", "COMPLETED", 900, 900, 9),
      completedFileCount: 9,
      verified: true,
    };

    expect(summarizeDeliveryPlan([job])).toEqual(
      expect.objectContaining({
        fileCount: 9,
        completedFileCount: 9,
        completed: 1,
        statusLabel: "全部完成",
        eta: null,
      }),
    );
  });
});

function deliveryJob(
  suffix: string,
  status: DeliveryJob["status"],
  totalBytes: number,
  transferredBytes: number,
  fileCount: number,
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
    completedFileCount: status === "COMPLETED" ? fileCount : 0,
    totalBytes,
    transferredBytes,
    verified: status === "COMPLETED",
    error: status === "FAILED" ? "上传失败" : null,
    createdAt: "2026-08-13T00:00:00.000Z",
    startedAt: "2026-08-13T00:00:00.000Z",
    finishedAt: status === "RUNNING" ? null : "2026-08-13T00:05:00.000Z",
    planId: "plan-one",
  };
}
