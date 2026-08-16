import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  OctagonX,
  ArchiveRestore,
  ScanLine,
  Send,
} from "lucide-react";
import type {
  DeliveryJob,
  LibraryChangePlanRead,
  ScanJob,
} from "@cocean/contracts";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { Button, EmptyState, PageHeader } from "../components.js";
import {
  groupDeliveryPlans,
  summarizeDeliveryPlan,
  type DeliveryPlan,
} from "../delivery-plan.js";
import { useAsync, useToast } from "../hooks.js";
import { formatFileSize } from "../media-ui.js";
import { safeLifecycleMessage } from "./quarantine.js";

export function TasksPage({ canManage }: { canManage: boolean }) {
  const [searchParams] = useSearchParams();
  const requestedPlanId = searchParams.get("plan")?.trim() ?? "";
  const scans = useAsync(() => api.scans(), []);
  const deliveries = useAsync(() => api.deliveries(), []);
  const lifecyclePlans = useAsync(() => api.lifecyclePlans(), []);
  const recentlyDeleted = useAsync(() => api.quarantinedVersions(), []);
  const requestedLifecyclePlan = useAsync(
    () =>
      requestedPlanId
        ? api.lifecyclePlan(requestedPlanId)
        : Promise.resolve<LibraryChangePlanRead | null>(null),
    [requestedPlanId],
  );
  const requestedSourcePlanId =
    requestedLifecyclePlan.data?.action === "RESTORE_VERSION"
      ? (requestedLifecyclePlan.data.sourcePlanId ?? "")
      : requestedPlanId;
  const requestedSourcePlan = useAsync(
    () =>
      requestedSourcePlanId && requestedSourcePlanId !== requestedPlanId
        ? api.lifecyclePlan(requestedSourcePlanId)
        : Promise.resolve<LibraryChangePlanRead | null>(null),
    [requestedPlanId, requestedSourcePlanId],
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAllLifecycle, setShowAllLifecycle] = useState(false);
  const [scanDialogOpen, setScanDialogOpen] = useState(false);
  const [scanMode, setScanMode] = useState<"INCREMENTAL" | "FULL">(
    "INCREMENTAL",
  );
  const [starting, setStarting] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const toast = useToast();
  const hasActiveTask = Boolean(
    scans.data?.some((job) => ["QUEUED", "RUNNING"].includes(job.status)) ||
    deliveries.data?.some((job) =>
      ["QUEUED", "RUNNING"].includes(job.status),
    ) ||
    lifecyclePlans.data?.some((plan) =>
      ["QUEUED", "RUNNING"].includes(plan.status),
    ),
  );
  useEffect(() => {
    if (!hasActiveTask) return;
    const timer = window.setInterval(() => {
      void scans.reload();
      void deliveries.reload();
      void lifecyclePlans.reload();
      void recentlyDeleted.reload();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [
    deliveries.reload,
    hasActiveTask,
    lifecyclePlans.reload,
    recentlyDeleted.reload,
    scans.reload,
  ]);
  const start = async () => {
    setStarting(true);
    try {
      const job = await api.startScan(scanMode);
      setExpanded(job.id);
      setScanDialogOpen(false);
      await scans.reload();
      toast.show(
        scanMode === "INCREMENTAL" ? "增量扫描已创建" : "全量扫描已创建",
      );
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "扫描任务创建失败");
    } finally {
      setStarting(false);
    }
  };
  const cancel = async (job: ScanJob) => {
    if (
      !window.confirm(
        "停止后不会更新唱片库；已完成的只读扫描证据会保留。确认停止？",
      )
    )
      return;
    try {
      await api.cancelScan(job.id);
      await scans.reload();
      toast.show(job.status === "QUEUED" ? "任务已取消" : "正在安全停止扫描");
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "无法停止扫描");
    }
  };
  const retry = async (job: ScanJob) => {
    setRetrying(job.id);
    try {
      const retried = await api.retryScan(job.id);
      setExpanded(retried.id);
      await scans.reload();
      toast.show("失败扫描已重新排队");
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "扫描重试失败");
    } finally {
      setRetrying(null);
    }
  };
  const lifecycleRecords = prioritizeLifecyclePlan(
    mergeLifecyclePlans(
      lifecyclePlans.data ?? [],
      requestedLifecyclePlan.data,
      requestedSourcePlan.data,
    ),
    requestedSourcePlanId || requestedPlanId,
  );
  return (
    <div className="page tasks-page">
      <PageHeader
        title="任务"
        subtitle="Music 扫描与播放器投送的真实执行进度"
        action={
          canManage ? (
            <Button
              variant="secondary"
              onClick={() => setScanDialogOpen(true)}
              disabled={hasActiveTask}
            >
              <ScanLine /> 扫描 Music
            </Button>
          ) : (
            <span className="status-pill">成员只读</span>
          )
        }
      />
      {scanDialogOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section
            className="scan-dialog surface-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scan-dialog-title"
          >
            <div>
              <p className="eyebrow">LIBRARY SCAN</p>
              <h2 id="scan-dialog-title">扫描 Music 目录</h2>
              <p>扫描只读取文件，不修改标签、封面或目录内容。</p>
            </div>
            <div className="scan-mode-grid">
              <button
                className={scanMode === "INCREMENTAL" ? "is-selected" : ""}
                onClick={() => setScanMode("INCREMENTAL")}
              >
                <strong>增量扫描</strong>
                <span>
                  推荐。复用大小与修改时间未变化的已入库文件，仅解析新增或变更内容。
                </span>
              </button>
              <button
                className={scanMode === "FULL" ? "is-selected" : ""}
                onClick={() => setScanMode("FULL")}
              >
                <strong>全量扫描</strong>
                <span>
                  重新探测并校验全部候选文件；耗时更长，适合规则升级或集中修复标签后。
                </span>
              </button>
            </div>
            <div className="scan-warning">
              <AlertTriangle />
              <span>
                全量扫描会大量读取磁盘，但 Music
                仍保持只读。运行中可安全停止，旧唱片库快照不会被半成品覆盖。
              </span>
            </div>
            <footer>
              <Button
                variant="secondary"
                onClick={() => setScanDialogOpen(false)}
              >
                取消
              </Button>
              <Button disabled={starting} onClick={() => void start()}>
                {starting
                  ? "正在创建"
                  : `开始${scanMode === "FULL" ? "全量" : "增量"}扫描`}
              </Button>
            </footer>
          </section>
        </div>
      ) : null}
      <h2 className="task-section-title">文件管理 / 最近删除</h2>
      <section className="surface-card lifecycle-task-summary">
        {recentlyDeleted.error ? (
          <div className="deep-link-context has-error" role="alert">
            最近删除数量读取失败：
            {safeLifecycleMessage(recentlyDeleted.error.message)}
          </div>
        ) : null}
        {lifecyclePlans.error ? (
          <div className="deep-link-context has-error" role="alert">
            文件管理历史读取失败：
            {safeLifecycleMessage(lifecyclePlans.error.message)}
          </div>
        ) : null}
        <div className="lifecycle-task-count">
          <ArchiveRestore aria-hidden="true" />
          <div>
            <strong>
              最近删除 {recentlyDeleted.data?.total.toLocaleString() ?? "—"} 项
            </strong>
            <span>
              精确统计已移出且尚未成功恢复的对象；成员仅可查看脱敏概要。
            </span>
          </div>
          <Link
            className="button secondary"
            to={
              requestedPlanId
                ? `/quarantine?plan=${encodeURIComponent(
                    requestedSourcePlanId || requestedPlanId,
                  )}`
                : "/quarantine"
            }
          >
            打开最近删除
          </Link>
        </div>
        {requestedPlanId && requestedLifecyclePlan.error ? (
          <div className="deep-link-context has-error" role="alert">
            没有找到指定的文件管理记录，可能已失效或无权查看。
          </div>
        ) : null}
        <div className="lifecycle-task-list">
          {lifecycleRecords
            .slice(0, showAllLifecycle ? undefined : 5)
            .map((plan) => (
              <LifecycleTaskRecord
                plan={plan}
                highlighted={
                  plan.id === (requestedSourcePlanId || requestedPlanId)
                }
                key={plan.id}
              />
            ))}
        </div>
        {!lifecyclePlans.loading &&
        !lifecyclePlans.error &&
        !lifecycleRecords.length ? (
          <p className="lifecycle-task-empty">
            暂无文件管理任务；这里不会用演示记录代替真实生命周期事实。
          </p>
        ) : null}
        {lifecycleRecords.length > 5 ? (
          <Button
            variant="quiet"
            onClick={() => setShowAllLifecycle((current) => !current)}
          >
            {showAllLifecycle ? "收起" : "展开全部"}
          </Button>
        ) : null}
      </section>
      <h2 className="task-section-title">Music 扫描</h2>
      {scans.error ? (
        <EmptyState
          title="任务 API 暂不可用"
          detail="不会用演示任务替代真实扫描状态。"
        />
      ) : !scans.loading && !scans.data?.length ? (
        <EmptyState
          title="没有任务"
          detail="确认 Music 目录只读挂载后，启动第一次扫描。"
        />
      ) : (
        <div className="task-table">
          {(scans.data ?? []).map((job) => {
            const terminal = isTerminal(job.status);
            const isExpanded = expanded === job.id;
            return (
              <article
                className={`task-record${isExpanded ? " is-expanded" : ""}`}
                key={job.id}
              >
                <div className="task-record-summary">
                  <StatusIcon status={job.status} />
                  <div className="task-record-main">
                    <div>
                      <strong>Music 目录扫描</strong>
                      <span>
                        {job.mode === "INCREMENTAL" ? "增量" : "全量"} ·{" "}
                        {triggerSourceLabel(job.triggerSource)} · 根目录{" "}
                        {job.rootId}
                      </span>
                    </div>
                    <progress
                      value={job.processedFiles}
                      max={Math.max(job.totalFiles, 1)}
                    />
                    <small>
                      {job.processedFiles.toLocaleString()} /{" "}
                      {job.totalFiles.toLocaleString()} · 已解析{" "}
                      {job.parsedFiles.toLocaleString()} · 不支持 / 失败{" "}
                      {job.failedFiles.toLocaleString()}
                      {job.reusedFiles
                        ? ` · 复用 ${job.reusedFiles.toLocaleString()}`
                        : ""}
                      {job.deferredAlbumDirectories
                        ? ` · 等待稳定 ${job.deferredAlbumDirectories.toLocaleString()} 个目录`
                        : ""}
                    </small>
                    <small>
                      创建 {formatTaskTime(job.createdAt)}
                      {job.startedAt
                        ? ` · 开始 ${formatTaskTime(job.startedAt)}`
                        : ""}
                      {job.finishedAt
                        ? ` · 完成 ${formatTaskTime(job.finishedAt)}`
                        : ""}
                      {job.error ? ` · ${job.error}` : ""}
                    </small>
                  </div>
                  {!terminal && canManage ? (
                    <button
                      className="task-cancel"
                      type="button"
                      onClick={() => void cancel(job)}
                      disabled={Boolean(job.cancelRequestedAt)}
                    >
                      <OctagonX /> {job.cancelRequestedAt ? "停止中" : "停止"}
                    </button>
                  ) : null}
                  {job.status === "FAILED" && canManage ? (
                    <Button
                      variant="secondary"
                      onClick={() => void retry(job)}
                      disabled={retrying === job.id || hasActiveTask}
                    >
                      {retrying === job.id ? "重试中" : "重试"}
                    </Button>
                  ) : null}
                  <span className="status-pill">{statusLabel(job.status)}</span>
                  <button
                    type="button"
                    className="task-expand"
                    disabled={!terminal}
                    aria-expanded={isExpanded}
                    aria-label={isExpanded ? "收起扫描报告" : "展开扫描报告"}
                    onClick={() => setExpanded(isExpanded ? null : job.id)}
                  >
                    {isExpanded ? <ChevronUp /> : <ChevronDown />}
                  </button>
                </div>
                {isExpanded && terminal ? <TaskEvidence job={job} /> : null}
              </article>
            );
          })}
        </div>
      )}
      <h2 className="task-section-title">专辑投送</h2>
      {deliveries.error ? (
        <EmptyState
          title="投送任务 API 暂不可用"
          detail="不会用模拟进度替代真实 FTP / U 盘状态。"
        />
      ) : !deliveries.loading && !deliveries.data?.length ? (
        <EmptyState
          title="没有投送任务"
          detail="在专辑详情选择 SP3000M 或 U 盘目标后发起投送。"
        />
      ) : (
        <div className="task-table">
          {groupDeliveryPlans(deliveries.data ?? []).map((plan) =>
            plan.jobs.length > 1 ? (
              <DeliveryPlanRecord plan={plan} key={plan.id} />
            ) : (
              <DeliveryTaskRecord job={plan.jobs[0]!} key={plan.id} />
            ),
          )}
        </div>
      )}{" "}
      {toast.message ? <div className="toast">{toast.message}</div> : null}
    </div>
  );
}

function mergeLifecyclePlans(
  plans: LibraryChangePlanRead[],
  ...requested: Array<LibraryChangePlanRead | null | undefined>
): LibraryChangePlanRead[] {
  const result = [...plans];
  for (const plan of requested) {
    if (plan && !result.some((candidate) => candidate.id === plan.id))
      result.unshift(plan);
  }
  return result;
}

function prioritizeLifecyclePlan(
  plans: LibraryChangePlanRead[],
  pinnedId: string,
): LibraryChangePlanRead[] {
  if (!pinnedId) return plans;
  const pinned = plans.find((plan) => plan.id === pinnedId);
  return pinned
    ? [pinned, ...plans.filter((plan) => plan.id !== pinnedId)]
    : plans;
}

export function LifecycleTaskRecord({
  plan,
  highlighted = false,
}: {
  plan: LibraryChangePlanRead;
  highlighted?: boolean;
}) {
  const sourcePlanId =
    plan.action === "RESTORE_VERSION" ? plan.sourcePlanId : plan.id;
  return (
    <article
      className={`lifecycle-task-record ${highlighted ? "is-target" : ""}`}
      aria-current={highlighted ? "true" : undefined}
    >
      <div>
        <strong>{plan.object.title}</strong>
        <span>
          {plan.object.albumArtist ?? "未知艺术家"} · {plan.fileCount} 个文件 ·{" "}
          {formatFileSize(plan.totalBytes)}
        </span>
        <small>
          {lifecycleActionLabel(plan.action)} ·{" "}
          {lifecyclePlanStatusLabel(plan.status)} ·{" "}
          {formatTaskTime(plan.finishedAt ?? plan.createdAt)}
          {plan.completedFiles
            ? ` · 已处理 ${plan.completedFiles}/${plan.fileCount}`
            : ""}
        </small>
        {plan.error ? (
          <small role="alert">{safeLifecycleMessage(plan.error)}</small>
        ) : null}
      </div>
      {sourcePlanId ? (
        <Link
          className="button quiet"
          to={`/quarantine?plan=${encodeURIComponent(sourcePlanId)}`}
        >
          查看记录
        </Link>
      ) : (
        <span className="status-pill">源记录不可用</span>
      )}
    </article>
  );
}

function lifecycleActionLabel(action: LibraryChangePlanRead["action"]): string {
  return action === "QUARANTINE_VERSION" ? "移到最近删除" : "恢复到原位置";
}

function lifecyclePlanStatusLabel(
  status: LibraryChangePlanRead["status"],
): string {
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

export function DeliveryPlanRecord({
  plan,
  now,
}: {
  plan: DeliveryPlan;
  now?: number;
}) {
  const summary = summarizeDeliveryPlan(plan.jobs, now);
  return (
    <article className="task-record delivery-task-record delivery-plan-record">
      <div className="task-record-summary">
        {summary.active && !summary.failed ? (
          <LoaderCircle className="spin" />
        ) : summary.failed ? (
          <AlertTriangle />
        ) : (
          <CheckCircle2 />
        )}
        <div className="task-record-main">
          <div>
            <strong>投送计划 · {plan.jobs.length} 张专辑</strong>
            <span>
              {plan.jobs[0]?.targetName} · 已完成 {summary.completed} /{" "}
              {plan.jobs.length}
            </span>
          </div>
          <progress
            value={Math.min(
              summary.transferredBytes,
              Math.max(summary.totalBytes, 1),
            )}
            max={Math.max(summary.totalBytes, 1)}
            aria-label={`投送计划进度 ${summary.percent}%`}
          />
          <small>
            {summary.percent}% · {formatBytes(summary.transferredBytes)} /{" "}
            {formatBytes(summary.totalBytes)}
            {summary.fileCount
              ? ` · ${summary.completedFileCount}/${summary.fileCount} 个文件`
              : ""}
            {summary.eta ? ` · 预计剩余 ${summary.eta}` : ""}
          </small>
        </div>
        <span className="status-pill">{summary.statusLabel}</span>
      </div>
      <div className="delivery-plan-albums">
        {plan.jobs.map((job) => (
          <Link to={`/albums/${job.albumId}`} key={job.id}>
            <span>{job.albumTitle ?? "专辑投送"}</span>
            <small>
              {deliveryStatusLabel(job.status, job.verified)} ·{" "}
              {job.completedFileCount}/{job.fileCount}
            </small>
          </Link>
        ))}
      </div>
    </article>
  );
}

export function DeliveryTaskRecord({ job }: { job: DeliveryJob }) {
  const max = Math.max(job.totalBytes, 1);
  const transferred = Math.min(job.transferredBytes, max);
  const percent = job.totalBytes
    ? Math.min(100, Math.round((job.transferredBytes / job.totalBytes) * 100))
    : job.status === "COMPLETED"
      ? 100
      : 0;
  return (
    <article className="task-record delivery-task-record">
      <div className="task-record-summary">
        {job.status === "RUNNING" ? (
          <LoaderCircle className="spin" />
        ) : job.status === "COMPLETED" && job.verified ? (
          <CheckCircle2 />
        ) : job.status === "FAILED" || job.status === "COMPLETED" ? (
          <AlertTriangle />
        ) : (
          <Send />
        )}
        <div className="task-record-main">
          <div>
            <strong>{job.albumTitle ?? "专辑投送"}</strong>
            <span>
              {job.targetName} · {deliveryTransportLabel(job.transport)}
            </span>
          </div>
          <progress
            value={transferred}
            max={max}
            aria-label={`投送进度 ${percent}%`}
          />
          <small>
            {percent}% · {formatBytes(job.transferredBytes)} /{" "}
            {formatBytes(job.totalBytes)}
            {job.fileCount
              ? ` · ${job.completedFileCount}/${job.fileCount} 个文件`
              : ""}
            {job.error ? ` · ${job.error}` : ""}
          </small>
        </div>
        <span className="status-pill">
          {deliveryStatusLabel(job.status, job.verified)}
        </span>
        <Link className="task-album-link" to={`/albums/${job.albumId}`}>
          打开
        </Link>
      </div>
    </article>
  );
}

function TaskEvidence({ job }: { job: ScanJob }) {
  const evidence = useAsync(async () => {
    const [report, failures, files] = await Promise.all([
      api.scanReport(job.id),
      api.scanFailures(job.id, 100, 0),
      api.scanFiles(job.id, 1, 0),
    ]);
    return { report, failures, files };
  }, [job.id]);
  if (evidence.loading)
    return <div className="task-evidence-loading">正在核对不可变报告…</div>;
  if (evidence.error || !evidence.data)
    return (
      <div className="task-evidence-error">
        该任务没有可读取的终态报告：{evidence.error?.message ?? "未知错误"}
      </div>
    );
  const { report, failures, files } = evidence.data;
  return (
    <div className="task-evidence">
      <div className="task-evidence-grid">
        <EvidenceFact label="候选" value={report.candidates} />
        <EvidenceFact label="已解析" value={report.parsed} />
        <EvidenceFact label="不支持" value={report.unsupported} warning />
        <EvidenceFact label="失败" value={report.failed} warning />
        <EvidenceFact label="Album" value={report.albumCount ?? "—"} />
        <EvidenceFact label="稳定目录" value={job.stableAlbumDirectories} />
        <EvidenceFact
          label="等待稳定"
          value={job.deferredAlbumDirectories}
          warning
        />
        <EvidenceFact
          label="聚合问题"
          value={report.albumIssueCount ?? "—"}
          warning
        />
        <EvidenceFact label="辅助文件" value={report.auxiliaryFiles} />
        <EvidenceFact label="忽略文件" value={report.ignoredFiles} />
        <EvidenceFact label="符号链接" value={report.skippedSymlinks} />
      </div>
      <div className="task-evidence-proof">
        <div>
          <small>扫描规则</small>
          <code>{report.rulesVersion}</code>
        </div>
        <div>
          <small>逐文件 ledger</small>
          <strong>{files.total.toLocaleString()} 条</strong>
        </div>
        <div>
          <small>不可变摘要 SHA-256</small>
          <code title={report.summaryHash}>{report.summaryHash}</code>
        </div>
      </div>
      {failures.items.length ? (
        <div className="task-failure-list">
          <div>
            <strong>前 {failures.items.length} 个待处理项</strong>
            <span>共 {failures.total.toLocaleString()} 个</span>
          </div>
          {failures.items.map((failure) => (
            <div key={failure.id}>
              <code>{failure.relativePath}</code>
              <span>
                {failure.code} · {failure.stage}
              </span>
              <small>{failure.message}</small>
            </div>
          ))}
        </div>
      ) : (
        <div className="task-evidence-ok">
          <CheckCircle2 /> 没有解析失败或不支持的音频候选
        </div>
      )}
      <footer>
        <span>
          候选平衡、结果平衡、目录边界：
          {report.invariants.valid ? "均已通过" : "未通过"}
        </span>
        <Link to="/library">打开唱片库</Link>
      </footer>
    </div>
  );
}

function EvidenceFact({
  label,
  value,
  warning,
}: {
  label: string;
  value: number | string;
  warning?: boolean;
}) {
  const activeWarning = warning && typeof value === "number" && value > 0;
  return (
    <div className={activeWarning ? "has-warning" : ""}>
      <small>{label}</small>
      <strong>
        {typeof value === "number" ? value.toLocaleString() : value}
      </strong>
    </div>
  );
}

function isTerminal(status: string) {
  return [
    "COMPLETED",
    "COMPLETED_WITH_WARNINGS",
    "FAILED",
    "CANCELLED",
  ].includes(status);
}
function triggerSourceLabel(source: ScanJob["triggerSource"]) {
  return {
    MANUAL: "手工触发",
    AUTO_DISCOVERY: "自动发现",
    RETRY: "失败重试",
  }[source];
}

function formatTaskTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
function StatusIcon({ status }: { status: string }) {
  if (status === "COMPLETED") return <CheckCircle2 />;
  if (status === "COMPLETED_WITH_WARNINGS" || status === "FAILED")
    return <AlertTriangle />;
  if (status === "RUNNING") return <LoaderCircle className="spin" />;
  return <Clock3 />;
}
function statusLabel(status: string) {
  return (
    (
      {
        QUEUED: "等待中",
        RUNNING: "扫描中",
        COMPLETED: "已完成",
        COMPLETED_WITH_WARNINGS: "完成，有待处理项",
        FAILED: "失败",
        CANCELLED: "已取消",
      } as Record<string, string>
    )[status] ?? status
  );
}

function deliveryStatusLabel(status: string, verified = false) {
  if (status === "COMPLETED" && !verified) return "完成但校验失败";
  return (
    (
      {
        QUEUED: "等待投送",
        RUNNING: "投送中",
        COMPLETED: "已完成",
        FAILED: "失败",
        CANCELLED: "已取消",
      } as Record<string, string>
    )[status] ?? status
  );
}

function deliveryTransportLabel(transport: string) {
  if (transport === "AK_FILE_DROP") return "AK File Drop · FTP";
  if (transport === "FTP") return "FTP";
  if (transport === "USB_MOUNT") return "U 盘";
  return transport;
}

function formatBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  const amount = value / 1024 ** index;
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}
