import type { LibraryChangePlan } from "@cocean/contracts";
import { ArchiveRestore, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Button, EmptyState, PageHeader, Toast } from "../components.js";
import { useAsync, useToast } from "../hooks.js";
import { formatFileSize } from "../media-ui.js";

export function QuarantinePage({ canManage }: { canManage: boolean }) {
  const plans = useAsync(() => api.lifecyclePlans(), []);
  const [preview, setPreview] = useState<LibraryChangePlan | null>(null);
  const [statusFilter, setStatusFilter] = useState<
    "QUARANTINED" | "ACTIVE" | "ATTENTION" | "ALL"
  >("ALL");
  const [timeFilter, setTimeFilter] = useState<"ALL" | "30_DAYS">("ALL");
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const toast = useToast();

  const previewRestore = async (sourcePlanId: string) => {
    setWorking(true);
    setConfirmed(false);
    try {
      if (preview?.status === "PREVIEWED")
        await api.cancelLifecyclePlan(preview.id, crypto.randomUUID());
      setPreview(
        await api.createRestorePlan(sourcePlanId, crypto.randomUUID()),
      );
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "无法生成恢复预览");
    } finally {
      setWorking(false);
    }
  };
  const confirmRestore = async () => {
    if (!preview || !confirmed) return;
    setWorking(true);
    try {
      await api.confirmLifecyclePlan(preview.id, crypto.randomUUID());
      setPreview(null);
      setConfirmed(false);
      await plans.reload();
      toast.show("已提交恢复任务；目标位置被占用时不会覆盖");
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "恢复任务提交失败");
    } finally {
      setWorking(false);
    }
  };
  const cancelPreview = async () => {
    const plan = preview;
    setPreview(null);
    setConfirmed(false);
    if (!plan) return;
    try {
      await api.cancelLifecyclePlan(plan.id, crypto.randomUUID());
      await plans.reload();
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "预览取消失败");
    }
  };
  const cancelPlan = async (planId: string) => {
    setWorking(true);
    try {
      await api.cancelLifecyclePlan(planId, crypto.randomUUID());
      await plans.reload();
      toast.show("计划已取消，尚未发生新的文件操作");
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "计划取消失败");
    } finally {
      setWorking(false);
    }
  };
  const retryPlan = async (planId: string) => {
    setWorking(true);
    try {
      await api.retryLifecyclePlan(planId, crypto.randomUUID());
      await plans.reload();
      toast.show("已重新核验；冲突仍存在时会继续保持待处理状态");
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "重新核验失败");
    } finally {
      setWorking(false);
    }
  };
  const restoredSources = new Set(
    (plans.data ?? [])
      .filter(
        (plan) =>
          plan.action === "RESTORE_VERSION" && plan.status === "SUCCEEDED",
      )
      .map((plan) => plan.sourcePlanId)
      .filter((id): id is string => Boolean(id)),
  );
  const visiblePlans = (plans.data ?? []).filter((plan) => {
    const inTime =
      timeFilter === "ALL" ||
      Date.now() - new Date(plan.createdAt).getTime() <=
        30 * 24 * 60 * 60 * 1000;
    if (!inTime) return false;
    if (statusFilter === "ALL") return true;
    if (statusFilter === "ACTIVE")
      return ["PREVIEWED", "QUEUED", "RUNNING"].includes(plan.status);
    if (statusFilter === "ATTENTION")
      return ["FAILED", "RECOVERY_REQUIRED"].includes(plan.status);
    return (
      plan.action === "QUARANTINE_VERSION" &&
      plan.status === "SUCCEEDED" &&
      !restoredSources.has(plan.id)
    );
  });
  const hasActivePlans = (plans.data ?? []).some((plan) =>
    ["QUEUED", "RUNNING"].includes(plan.status),
  );
  useEffect(() => {
    if (!hasActivePlans) return;
    const timer = window.setInterval(() => void plans.reload(), 1_500);
    return () => window.clearInterval(timer);
  }, [hasActivePlans, plans.reload]);

  return (
    <div className="page quarantine-page">
      <PageHeader
        title="隔离区"
        subtitle="保留从托管曲库移出的本地版本；这里不会自动清理文件"
      />
      <div className="library-toolbar quarantine-toolbar">
        <label className="sort-control">
          <span>状态</span>
          <select
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as typeof statusFilter)
            }
          >
            <option value="QUARANTINED">已隔离</option>
            <option value="ACTIVE">进行中</option>
            <option value="ATTENTION">需要处理</option>
            <option value="ALL">全部计划</option>
          </select>
        </label>
        <label className="sort-control">
          <span>时间</span>
          <select
            value={timeFilter}
            onChange={(event) =>
              setTimeFilter(event.target.value as typeof timeFilter)
            }
          >
            <option value="ALL">全部时间</option>
            <option value="30_DAYS">最近 30 天</option>
          </select>
        </label>
      </div>
      {plans.loading ? <div className="detail-skeleton" /> : null}
      {plans.error ? (
        <EmptyState title="无法读取隔离区" detail={plans.error.message} />
      ) : null}
      {!plans.loading && !plans.error && !visiblePlans.length ? (
        <EmptyState
          title="隔离区为空"
          detail="当前筛选下没有管理计划。你可以切换状态或时间范围。"
        />
      ) : null}
      <div className="quarantine-list">
        {visiblePlans.map((plan) => (
          <section className="surface-card quarantine-row" key={plan.id}>
            <ShieldCheck aria-hidden="true" />
            <div>
              <strong>{planTitle(plan.action, plan.status)}</strong>
              <span>
                {plan.fileCount} 个文件 · {formatFileSize(plan.totalBytes)} ·{" "}
                {plan.root.name}
              </span>
              <small>
                版本标识 {shortId(plan.localVersionId)} ·{" "}
                {formatPlanTime(plan.createdAt)}
              </small>
              {plan.error ? <small role="alert">{plan.error}</small> : null}
              {canManage && Array.isArray(plan.items)
                ? plan.items
                    .filter((item) => item.error)
                    .map((item) => (
                      <small role="alert" key={item.ordinal}>
                        文件 {item.ordinal + 1}：{item.error}
                      </small>
                    ))
                : null}
            </div>
            {canManage &&
            plan.action === "QUARANTINE_VERSION" &&
            plan.status === "SUCCEEDED" &&
            !restoredSources.has(plan.id) ? (
              <Button
                variant="secondary"
                disabled={working}
                onClick={() => void previewRestore(plan.id)}
              >
                <ArchiveRestore /> 恢复到原位置
              </Button>
            ) : canManage && plan.status === "RECOVERY_REQUIRED" ? (
              <Button
                variant="secondary"
                disabled={working}
                onClick={() => void retryPlan(plan.id)}
              >
                重新核验
              </Button>
            ) : canManage && ["PREVIEWED", "QUEUED"].includes(plan.status) ? (
              <Button
                variant="quiet"
                disabled={working}
                onClick={() => void cancelPlan(plan.id)}
              >
                取消计划
              </Button>
            ) : null}
          </section>
        ))}
      </div>
      {preview ? (
        <section
          className="surface-card lifecycle-preview"
          aria-label="恢复预览"
        >
          <strong>恢复前确认</strong>
          <p>
            将 {preview.fileCount}{" "}
            个文件恢复到冻结的原位置。只要任一原位置已有文件，任务就会停止且不会覆盖。
          </p>
          {preview.blockers.length ? (
            <div className="lifecycle-blockers" role="alert">
              {preview.blockers.map((blocker) => (
                <span key={blocker.code}>{blocker.message}</span>
              ))}
            </div>
          ) : (
            <label className="lifecycle-confirmation">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              我确认恢复到原曲库位置，并理解 COCEAN 不会覆盖已有文件
            </label>
          )}
          <div className="lifecycle-preview-actions">
            <Button variant="quiet" onClick={() => void cancelPreview()}>
              取消
            </Button>
            <Button
              disabled={working || !preview.executable || !confirmed}
              onClick={() => void confirmRestore()}
            >
              确认恢复
            </Button>
          </div>
        </section>
      ) : null}
      <Toast message={toast.message} />
    </div>
  );
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function planTitle(
  action: LibraryChangePlan["action"],
  status: LibraryChangePlan["status"],
): string {
  const actionLabel =
    action === "QUARANTINE_VERSION" ? "移入隔离区" : "恢复到原位置";
  const statusLabel: Record<LibraryChangePlan["status"], string> = {
    PREVIEWED: "等待确认",
    QUEUED: "等待执行",
    RUNNING: "执行中",
    SUCCEEDED: "已完成",
    FAILED: "未执行",
    RECOVERY_REQUIRED: "需要人工处理",
    CANCELLED: "已取消",
  };
  return `${actionLabel} · ${statusLabel[status]}`;
}

function formatPlanTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
