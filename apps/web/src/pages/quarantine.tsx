import type {
  LibraryChangePlan,
  LibraryChangePlanRead,
  RecentlyDeletedItem,
  RecentlyDeletedResponse,
} from "@cocean/contracts";
import { ArchiveRestore, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api.js";
import { Button, EmptyState, PageHeader, Toast } from "../components.js";
import { useAsync, useToast } from "../hooks.js";
import { formatFileSize } from "../media-ui.js";

const pageSize = 100;

export function QuarantinePage({ canManage }: { canManage: boolean }) {
  const [searchParams] = useSearchParams();
  const requestedPlanId = searchParams.get("plan")?.trim() ?? "";
  const [pageOffset, setPageOffset] = useState(0);
  const currentPage = useAsync(
    () => api.quarantinedVersions({ limit: pageSize, offset: pageOffset }),
    [pageOffset],
  );
  const [snapshot, setSnapshot] = useState<RecentlyDeletedResponse | null>(
    null,
  );
  const [refreshError, setRefreshError] = useState<Error | null>(null);
  const requested = useAsync(
    () =>
      requestedPlanId
        ? api.lifecyclePlan(requestedPlanId)
        : Promise.resolve<LibraryChangePlanRead | null>(null),
    [requestedPlanId],
  );
  const requestedSourcePlanId =
    requested.data?.action === "RESTORE_VERSION"
      ? (requested.data.sourcePlanId ?? "")
      : (requested.data?.id ?? "");
  const requestedSource = useAsync(
    () =>
      requestedSourcePlanId && requestedSourcePlanId !== requestedPlanId
        ? api.lifecyclePlan(requestedSourcePlanId)
        : Promise.resolve<LibraryChangePlanRead | null>(null),
    [requestedPlanId, requestedSourcePlanId],
  );
  const requestedCurrent = useAsync(
    () =>
      requestedSourcePlanId
        ? api.recentlyDeletedVersion(requestedSourcePlanId)
        : Promise.resolve<RecentlyDeletedItem | null>(null),
    [requestedSourcePlanId],
  );
  const [preview, setPreview] = useState<LibraryChangePlan | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const page = currentPage.data;
    if (!page) return;
    setRefreshError(null);
    setSnapshot((previous) => {
      if (page.offset === 0) return page;
      const byId = new Map(
        (previous?.items ?? []).map((item) => [item.source.id, item]),
      );
      for (const item of page.items) byId.set(item.source.id, item);
      return { ...page, items: [...byId.values()], offset: 0 };
    });
  }, [currentPage.data]);

  const displayItems = useMemo(() => {
    const items = [...(snapshot?.items ?? [])];
    const exact = requestedCurrent.error ? null : requestedCurrent.data;
    if (exact && !items.some((item) => item.source.id === exact.source.id))
      items.unshift(exact);
    return items;
  }, [requestedCurrent.data, requestedCurrent.error, snapshot?.items]);
  const hasRunningRestore = displayItems.some((item) =>
    ["QUEUED", "RUNNING"].includes(item.latestRestore?.status ?? ""),
  );

  const reloadCurrent = async () => {
    try {
      const page = await api.quarantinedVersions({
        limit: pageSize,
        offset: 0,
      });
      setPageOffset(0);
      setSnapshot(page);
      setRefreshError(null);
      if (requestedSourcePlanId) await requestedCurrent.reload();
      return page;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      setRefreshError(failure);
      throw failure;
    }
  };
  useEffect(() => {
    if (!hasRunningRestore) return;
    const timer = globalThis.setInterval(
      () => void reloadCurrent().catch(() => undefined),
      1_500,
    );
    return () => globalThis.clearInterval(timer);
  }, [hasRunningRestore, requestedSourcePlanId]);

  const previewRestore = async (sourcePlanId: string) => {
    setWorking(true);
    setConfirmed(false);
    try {
      if (preview?.status === "PREVIEWED")
        await api.cancelLifecyclePlan(preview.id, crypto.randomUUID());
      setPreview(
        await api.createRestorePlan(sourcePlanId, crypto.randomUUID()),
      );
      await reloadCurrent();
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "无法生成恢复预览");
    } finally {
      setWorking(false);
    }
  };
  const continuePreview = (plan: LibraryChangePlanRead) => {
    if (!("items" in plan)) return;
    setConfirmed(false);
    setPreview(plan);
  };
  const confirmRestore = async () => {
    if (!preview || !confirmed) return;
    setWorking(true);
    try {
      await api.confirmLifecyclePlan(preview.id, crypto.randomUUID());
      setPreview(null);
      setConfirmed(false);
      await reloadCurrent();
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
      await reloadCurrent();
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "预览取消失败");
    }
  };
  const cancelPlan = async (planId: string) => {
    setWorking(true);
    try {
      await api.cancelLifecyclePlan(planId, crypto.randomUUID());
      await reloadCurrent();
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
      await reloadCurrent();
      toast.show("已重新核验；冲突仍存在时会继续保持待处理状态");
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "重新核验失败");
    } finally {
      setWorking(false);
    }
  };

  const sourceRecord =
    requestedSource.data ??
    (requested.data?.action === "QUARANTINE_VERSION" ? requested.data : null);
  const contextMessage = deepLinkContext({
    requestedPlanId,
    requested: requested.data,
    requestedError: requested.error,
    source: sourceRecord,
    sourceError: requestedSource.error,
    current: requestedCurrent.error ? null : requestedCurrent.data,
    currentError: requestedCurrent.error,
    loading:
      requested.loading ||
      (Boolean(requestedSourcePlanId) &&
        (requestedSource.loading || requestedCurrent.loading)),
  });
  const initialLoading = currentPage.loading && !snapshot;
  const initialError = currentPage.error && !snapshot;
  const associationsKnown = !currentPage.error && !refreshError;
  const hasMore = (snapshot?.items.length ?? 0) < (snapshot?.total ?? 0);

  return (
    <div className="page quarantine-page">
      <PageHeader
        title="最近删除"
        subtitle="这里显示已从托管曲库移出、且尚未成功恢复的本地版本"
        action={
          <Link
            className="button secondary"
            to={
              requestedPlanId
                ? `/tasks?plan=${encodeURIComponent(requestedPlanId)}`
                : "/tasks"
            }
          >
            返回任务
          </Link>
        }
      />
      <section className="surface-card recently-deleted-summary">
        <div>
          <small>当前可恢复对象</small>
          <strong>{snapshot?.total.toLocaleString() ?? "—"}</strong>
        </div>
        <p>成功恢复后会自动退出此集合；可继续加载并管理超过 100 条的记录。</p>
        {!canManage ? <span className="status-pill">成员只读</span> : null}
      </section>
      {contextMessage ? (
        <div
          className={`deep-link-context ${contextMessage.error ? "has-error" : ""}`}
          role={contextMessage.error ? "alert" : "status"}
        >
          {contextMessage.text}
        </div>
      ) : null}
      {initialLoading ? <div className="detail-skeleton" /> : null}
      {initialError ? (
        <EmptyState
          title="无法读取最近删除"
          detail={safeLifecycleMessage(currentPage.error!.message)}
        />
      ) : null}
      {(currentPage.error ?? refreshError) && snapshot ? (
        <div className="deep-link-context has-error" role="alert">
          当前状态刷新失败：
          {safeLifecycleMessage((currentPage.error ?? refreshError)!.message)}。
          为避免重复恢复，管理操作已暂时停用。
        </div>
      ) : null}
      {!initialLoading && !initialError && snapshot && !displayItems.length ? (
        <EmptyState
          title="最近删除为空"
          detail="当前没有等待恢复的文件管理记录。成功恢复的对象不会继续显示。"
        />
      ) : null}
      <div className="quarantine-list">
        {displayItems.map((item) => {
          const plan = item.source;
          const restore = item.latestRestore;
          const isTarget = requestedSourcePlanId === plan.id;
          const exactKnown = requestedCurrent.data?.source.id === plan.id;
          return (
            <section
              className={`surface-card quarantine-row ${isTarget ? "is-target" : ""}`}
              key={plan.id}
              aria-current={isTarget ? "true" : undefined}
            >
              <ShieldCheck aria-hidden="true" />
              <div>
                <strong>{plan.object.title}</strong>
                <span>
                  {plan.object.albumArtist ?? "未知艺术家"} · {plan.fileCount}{" "}
                  个文件 · {formatFileSize(plan.totalBytes)}
                </span>
                <small>
                  {restoreStatusLabel(restore)} ·{" "}
                  {formatPlanTime(
                    restore?.createdAt ?? plan.finishedAt ?? plan.createdAt,
                  )}
                </small>
                {(restore?.error ?? plan.error) ? (
                  <small role="alert">
                    {safeLifecycleMessage((restore?.error ?? plan.error)!)}
                  </small>
                ) : null}
                {canManage && restore && "items" in restore
                  ? restore.items
                      .filter((file) => file.error)
                      .map((file) => (
                        <small role="alert" key={file.ordinal}>
                          文件 {file.ordinal + 1}：
                          {safeLifecycleMessage(file.error!)}
                        </small>
                      ))
                  : null}
              </div>
              {canManage ? (
                <RestoreAction
                  sourcePlan={plan}
                  restorePlan={restore}
                  working={working}
                  associationKnown={associationsKnown || exactKnown}
                  onPreview={previewRestore}
                  onContinue={continuePreview}
                  onCancel={cancelPlan}
                  onRetry={retryPlan}
                />
              ) : null}
            </section>
          );
        })}
      </div>
      {hasMore ? (
        <Button
          variant="secondary"
          disabled={currentPage.loading}
          onClick={() => setPageOffset(snapshot?.items.length ?? 0)}
        >
          {currentPage.loading ? "正在加载" : "加载更多"}
        </Button>
      ) : null}
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
                <span key={blocker.code}>
                  {safeLifecycleMessage(blocker.message)}
                </span>
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

export function RestoreAction({
  sourcePlan,
  restorePlan,
  working,
  associationKnown,
  onPreview,
  onContinue,
  onCancel,
  onRetry,
}: {
  sourcePlan: LibraryChangePlanRead;
  restorePlan: LibraryChangePlanRead | null;
  working: boolean;
  associationKnown: boolean;
  onPreview: (sourcePlanId: string) => Promise<void>;
  onContinue: (plan: LibraryChangePlanRead) => void;
  onCancel: (planId: string) => Promise<void>;
  onRetry: (planId: string) => Promise<void>;
}) {
  if (!associationKnown)
    return <span className="status-pill">恢复状态未知，暂不可操作</span>;
  if (!restorePlan)
    return (
      <Button
        variant="secondary"
        disabled={working}
        onClick={() => void onPreview(sourcePlan.id)}
      >
        <ArchiveRestore /> 恢复到原位置
      </Button>
    );
  if (restorePlan.status === "PREVIEWED")
    return (
      <div className="quarantine-actions">
        <Button
          variant="secondary"
          disabled={working || !("items" in restorePlan)}
          onClick={() => onContinue(restorePlan)}
        >
          继续确认恢复
        </Button>
        <Button
          variant="quiet"
          disabled={working}
          onClick={() => void onCancel(restorePlan.id)}
        >
          取消预览
        </Button>
      </div>
    );
  if (restorePlan.status === "QUEUED")
    return (
      <Button
        variant="quiet"
        disabled={working}
        onClick={() => void onCancel(restorePlan.id)}
      >
        取消等待中的恢复
      </Button>
    );
  if (restorePlan.status === "RUNNING")
    return <span className="status-pill">正在恢复到原位置</span>;
  if (restorePlan.status === "RECOVERY_REQUIRED")
    return (
      <Button
        variant="secondary"
        disabled={working}
        onClick={() => void onRetry(restorePlan.id)}
      >
        重新核验
      </Button>
    );
  if (["FAILED", "CANCELLED"].includes(restorePlan.status))
    return (
      <div className="quarantine-actions">
        <span className="status-pill">
          {restorePlan.status === "FAILED" ? "上次恢复失败" : "上次恢复已取消"}
        </span>
        <Button
          variant="secondary"
          disabled={working}
          onClick={() => void onPreview(sourcePlan.id)}
        >
          重新预览恢复
        </Button>
      </div>
    );
  return <span className="status-pill">已恢复到原位置，正在刷新</span>;
}

function restoreStatusLabel(plan: LibraryChangePlanRead | null): string {
  if (!plan) return "已移到最近删除";
  return {
    PREVIEWED: "恢复预览等待确认",
    QUEUED: "恢复等待执行",
    RUNNING: "正在恢复到原位置",
    SUCCEEDED: "已恢复到原位置，正在刷新",
    FAILED: "恢复失败，可重新预览",
    RECOVERY_REQUIRED: "恢复需要人工处理",
    CANCELLED: "恢复已取消，可重新预览",
  }[plan.status];
}

interface DeepLinkFacts {
  requestedPlanId: string;
  requested: LibraryChangePlanRead | null;
  requestedError: Error | null;
  source: LibraryChangePlanRead | null;
  sourceError: Error | null;
  current: RecentlyDeletedItem | null;
  currentError: Error | null;
  loading: boolean;
}

function deepLinkContext(
  facts: DeepLinkFacts,
): { text: string; error: boolean } | null {
  if (!facts.requestedPlanId) return null;
  if (facts.loading) return { text: "正在定位任务记录…", error: false };
  if (facts.requestedError)
    return {
      text: "没有找到这条任务记录，可能已失效或无权查看。",
      error: true,
    };
  if (
    facts.requested?.action === "RESTORE_VERSION" &&
    !facts.requested.sourcePlanId
  )
    return { text: "恢复记录缺少源记录，无法定位。", error: true };
  if (facts.sourceError || !facts.source)
    return { text: "源文件管理记录不可用。", error: true };
  if (facts.current)
    return { text: "已定位到对应的最近删除记录。", error: false };
  if (
    facts.currentError instanceof ApiError &&
    facts.currentError.status === 404
  ) {
    if (
      facts.requested?.action === "RESTORE_VERSION" &&
      facts.requested.status === "SUCCEEDED"
    )
      return {
        text: "这条记录已经恢复到原位置，因此不在当前最近删除集合中。",
        error: false,
      };
    if (
      facts.source.action === "QUARANTINE_VERSION" &&
      facts.source.status === "SUCCEEDED"
    )
      return {
        text: "这条源记录已经成功恢复，因此不在当前最近删除集合中。",
        error: false,
      };
    return {
      text: `源记录当前状态为“${sourceStatusLabel(facts.source.status)}”，尚未进入最近删除。`,
      error: false,
    };
  }
  if (facts.currentError)
    return {
      text: `无法确认这条记录的当前状态：${safeLifecycleMessage(facts.currentError.message)}`,
      error: true,
    };
  return null;
}

function sourceStatusLabel(status: LibraryChangePlanRead["status"]): string {
  return {
    PREVIEWED: "等待确认",
    QUEUED: "等待执行",
    RUNNING: "执行中",
    SUCCEEDED: "已完成",
    FAILED: "失败",
    RECOVERY_REQUIRED: "需要人工处理",
    CANCELLED: "已取消",
  }[status];
}

export function safeLifecycleMessage(value: string): string {
  const hiddenPath = "[文件位置已隐藏]";
  const hiddenHash = "[校验值已隐藏]";
  return value
    .replace(/\b[a-f0-9]{64}\b/gi, hiddenHash)
    .replace(/\\\\[^\s"'（）()]+(?:\\[^\s"'（）()]+)+/g, hiddenPath)
    .replace(
      /\b[A-Za-z]:[\\/][^\s"'（）()]+(?:[\\/][^\s"'（）()]+)*/g,
      hiddenPath,
    )
    .replace(/\/(?:[^\s/"'（）()]+\/)*[^\s/"'（）()]+/g, hiddenPath)
    .replace(
      /(^|[\s"'（(])((?:\.\.?[\\/])?(?:[^\s\\/"'（）()]+[\\/])+[^\s\\/"'（）()]+)/g,
      (_match, prefix: string) => `${prefix}${hiddenPath}`,
    );
}

function formatPlanTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
