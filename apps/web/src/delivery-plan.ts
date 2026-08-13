import type { DeliveryJob } from "@cocean/contracts";

export interface DeliveryPlan {
  id: string;
  planId: string | null;
  targetId: string;
  jobs: DeliveryJob[];
}

export interface DeliveryPlanSummary {
  totalBytes: number;
  transferredBytes: number;
  fileCount: number;
  completedFileCount: number;
  completed: number;
  failed: boolean;
  cancelled: boolean;
  active: boolean;
  percent: number;
  eta: string | null;
  statusLabel:
    | "执行中"
    | "执行中 · 有失败"
    | "部分失败"
    | "已取消"
    | "部分完成 · 已取消"
    | "全部完成"
    | "未完成";
}

export function groupDeliveryPlans(jobs: DeliveryJob[]): DeliveryPlan[] {
  const groups = new Map<string, DeliveryJob[]>();
  for (const job of jobs) {
    const key = `${job.targetId}\0${job.planId ?? job.id}`;
    const group = groups.get(key) ?? [];
    group.push(job);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([id, items]) => ({
    id,
    planId: items[0]?.planId ?? null,
    targetId: items[0]!.targetId,
    jobs: items,
  }));
}

export function summarizeDeliveryPlan(
  jobs: DeliveryJob[],
  now = Date.now(),
): DeliveryPlanSummary {
  const totalBytes = jobs.reduce((total, job) => total + job.totalBytes, 0);
  const transferredBytes = jobs.reduce(
    (total, job) => total + job.transferredBytes,
    0,
  );
  const fileCount = jobs.reduce((total, job) => total + job.fileCount, 0);
  const completedFileCount = jobs.reduce(
    (total, job) => total + job.completedFileCount,
    0,
  );
  const completed = jobs.filter(isVerifiedComplete).length;
  const failed = jobs.some(
    (job) =>
      job.status === "FAILED" || (job.status === "COMPLETED" && !job.verified),
  );
  const cancelled = jobs.some((job) => job.status === "CANCELLED");
  const active = jobs.some((job) => ["QUEUED", "RUNNING"].includes(job.status));
  const percent = totalBytes
    ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100))
    : completed === jobs.length
      ? 100
      : 0;
  return {
    totalBytes,
    transferredBytes,
    fileCount,
    completedFileCount,
    completed,
    failed,
    cancelled,
    active,
    percent,
    eta: active ? deliveryEta(jobs.filter(isActive), now) : null,
    statusLabel: active
      ? failed
        ? "执行中 · 有失败"
        : "执行中"
      : failed
        ? "部分失败"
        : cancelled
          ? completed
            ? "部分完成 · 已取消"
            : "已取消"
          : jobs.length > 0 && completed === jobs.length
            ? "全部完成"
            : "未完成",
  };
}

function deliveryEta(jobs: DeliveryJob[], now: number): string | null {
  const transferredBytes = jobs.reduce(
    (total, job) => total + job.transferredBytes,
    0,
  );
  const totalBytes = jobs.reduce((total, job) => total + job.totalBytes, 0);
  if (!transferredBytes || transferredBytes >= totalBytes) return null;
  const started = jobs
    .map((job) => job.startedAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  if (!started.length) return null;
  const elapsedSeconds = (now - Math.min(...started)) / 1000;
  if (elapsedSeconds < 2) return null;
  const bytesPerSecond = transferredBytes / elapsedSeconds;
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  const remainingSeconds = (totalBytes - transferredBytes) / bytesPerSecond;
  if (remainingSeconds < 60) return "不足 1 分钟";
  if (remainingSeconds < 3600)
    return `${Math.ceil(remainingSeconds / 60)} 分钟`;
  return `${(remainingSeconds / 3600).toFixed(1)} 小时`;
}

function isVerifiedComplete(job: DeliveryJob): boolean {
  return job.status === "COMPLETED" && job.verified;
}

function isActive(job: DeliveryJob): boolean {
  return job.status === "QUEUED" || job.status === "RUNNING";
}
