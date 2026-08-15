import {
  formatFullAudioSpec,
  type AlbumArtworkEvent,
  type AlbumArtworkGovernance,
  type AlbumDetail,
  type AlbumMetadataEvent,
  type AlbumSummary,
  type DeliveryJob,
  type DeliveryTarget,
  type LibraryIdentityDecision,
  type LibraryIdentityDecisionCommand,
  type LibraryChangePlan,
  type LocalVersionSummary,
  type MetadataCommand,
  type MetadataField,
  type MetadataFieldState,
  type PhysicalMedium,
} from "@cocean/contracts";
import {
  ChevronRight,
  Clock3,
  Download,
  FileAudio2,
  ImageOff,
  Pause,
  Play,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  Upload,
  Archive,
  EyeOff,
  RotateCcw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { ApiError, api } from "../api.js";
import {
  AlbumArtwork,
  AudioSpecBadge,
  Button,
  EmptyState,
  MediaTag,
  PageHeader,
  SectionTitle,
  Toast,
  libraryAudioBadgeLabel,
  libraryIssueLabel,
} from "../components.js";
import { useAsync, useToast } from "../hooks.js";
import {
  safeBrowserSessionStorage,
  safeLibraryReturn,
  safeStorageGet,
  safeStorageRemove,
  safeStorageSet,
  type LibraryStorage,
} from "../library-state.js";
import {
  albumAggregationIssueLabel,
  compactTrackAudioSpec,
  formatFileSize,
  formatTrackAudioDetails,
  formatTrackPosition,
  groupTracksByDisc,
  trackWarningLabel,
} from "../media-ui.js";

export function AlbumDetailPage({ canManage }: { canManage: boolean }) {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const libraryReturnTo = safeLibraryReturn(searchParams.get("from"));
  const album = useAsync(() => api.album(id), [id]);
  const deliveryTargets = useAsync(() => api.deliveryTargets(), []);
  const deliveries = useAsync(() => api.albumDeliveries(id), [id]);
  const introduction = useAsync(() => api.albumIntroduction(id), [id]);
  const identityHistory = useAsync(() => api.identityDecisions(id), [id]);
  const metadataHistory = useAsync(() => api.metadataHistory(id), [id]);
  const artworkHistory = useAsync(() => api.artworkHistory(id), [id]);
  const capabilities = useAsync(() => api.capabilities(), []);
  const lifecyclePlans = useAsync(
    () => (canManage ? api.lifecyclePlans() : Promise.resolve([])),
    [canManage],
  );
  const [listeningTrackId, setListeningTrackId] = useState<string | null>(null);
  const [deliveryTargetId, setDeliveryTargetId] = useState("");
  const [delivering, setDelivering] = useState(false);
  const [generatingIntroduction, setGeneratingIntroduction] = useState(false);
  const [copyFormOpen, setCopyFormOpen] = useState(false);
  const [identityWorking, setIdentityWorking] = useState(false);
  const [visibilityWorking, setVisibilityWorking] = useState(false);
  const [lifecycleWorking, setLifecycleWorking] = useState(false);
  const [lifecyclePreview, setLifecyclePreview] =
    useState<LibraryChangePlan | null>(null);
  const [lifecycleConfirmed, setLifecycleConfirmed] = useState(false);
  const [identitySearchResults, setIdentitySearchResults] = useState<
    AlbumSummary[]
  >([]);
  const [identitySearchError, setIdentitySearchError] = useState<string | null>(
    null,
  );
  const [identityTargetDetail, setIdentityTargetDetail] =
    useState<AlbumDetail | null>(null);
  const [identityTargetError, setIdentityTargetError] = useState<string | null>(
    null,
  );
  const identitySearchGeneration = useRef(createLatestRequestTracker());
  const identityTargetGeneration = useRef(createLatestRequestTracker());
  const [copyDraft, setCopyDraft] = useState({
    medium: "CD" as PhysicalMedium,
    label: "",
    catalogNumber: "",
    barcode: "",
    country: "",
    releaseYear: "",
    quantity: "1",
    conditionNote: "",
    storageLocation: "",
  });
  const toast = useToast();
  const enabledTargets = (deliveryTargets.data ?? []).filter(
    (target) => target.enabled,
  );
  const selectedDeliveryTarget = enabledTargets.find(
    (target) => target.id === deliveryTargetId,
  );
  const selectedTargetNeedsCredential = Boolean(
    selectedDeliveryTarget &&
    isFtpTarget(selectedDeliveryTarget) &&
    !selectedDeliveryTarget.credentialConfigured,
  );
  useEffect(() => {
    if (!deliveryTargetId && enabledTargets[0])
      setDeliveryTargetId(enabledTargets[0].id);
  }, [deliveryTargetId, enabledTargets]);
  const hasActiveDelivery = Boolean(
    deliveries.data?.some((job) => ["QUEUED", "RUNNING"].includes(job.status)),
  );
  useEffect(() => {
    if (!hasActiveDelivery) return;
    const timer = window.setInterval(() => void deliveries.reload(), 1_000);
    return () => window.clearInterval(timer);
  }, [hasActiveDelivery, deliveries.reload]);
  useEffect(() => {
    identitySearchGeneration.current.invalidate();
    identityTargetGeneration.current.invalidate();
    setIdentitySearchResults([]);
    setIdentitySearchError(null);
    setIdentityTargetDetail(null);
    setIdentityTargetError(null);
  }, [id]);
  useEffect(() => {
    if (lifecyclePreview || !album.data) return;
    const recoverable = lifecyclePlans.data?.find(
      (plan) =>
        plan.action === "QUARANTINE_VERSION" &&
        plan.status === "PREVIEWED" &&
        plan.libraryAlbumId === album.data?.id,
    );
    if (recoverable) setLifecyclePreview(recoverable);
  }, [album.data, lifecyclePlans.data, lifecyclePreview]);
  if (album.loading)
    return (
      <div className="page">
        <PageHeader title="Album" subtitle="正在读取详情" />
        <div className="detail-skeleton" />
      </div>
    );
  if (album.error || !album.data)
    return (
      <div className="page">
        <PageHeader title="Album" />
        <EmptyState
          title="无法打开专辑详情"
          detail="该 Album 不存在，或 COCEAN API 暂不可用。"
        />
      </div>
    );
  const item = album.data;
  const localVersions = item.localVersions ?? legacyLocalVersions(item);
  const modelCapability = capabilities.data?.model;
  const modelConfigured = modelCapability?.configured === true;
  const modelReady = Boolean(
    modelConfigured && modelCapability?.enabled && modelCapability.verified,
  );
  const discGroups = groupTracksByDisc(item.tracks);
  const firstTrackId = discGroups[0]?.tracks[0]?.id;
  const listeningTrack =
    item.tracks.find((track) => track.id === listeningTrackId) ?? null;
  const listen = (trackId = firstTrackId) => {
    if (!trackId) return toast.show("这张专辑没有可试听曲目");
    setListeningTrackId((current) => (current === trackId ? null : trackId));
  };
  const addPhysicalCopy = async (medium: PhysicalMedium) => {
    try {
      await api.addPhysicalCopy(item.id, { medium, quantity: 1 });
      await album.reload();
      toast.show(`${medium === "VINYL" ? "黑胶" : medium} 已加入我的版本`);
    } catch {
      toast.show("实体唱片记录保存失败");
    }
  };
  const changeVisibility = async () => {
    setVisibilityWorking(true);
    try {
      await api.setAlbumVisibility(item.id, {
        action: item.visibility === "HIDDEN" ? "RESTORE" : "HIDE",
        requestId: createBrowserUuid(),
        expectedVisibilityRevision: item.visibilityRevision ?? 0,
      });
      await album.reload();
      toast.show(
        item.visibility === "HIDDEN"
          ? "唱片已恢复到唱片库"
          : "唱片已从日常浏览中隐藏",
      );
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "显示状态更新失败");
    } finally {
      setVisibilityWorking(false);
    }
  };
  const previewQuarantine = async (localVersionId: string) => {
    setLifecycleWorking(true);
    setLifecycleConfirmed(false);
    try {
      if (lifecyclePreview?.status === "PREVIEWED")
        await api.cancelLifecyclePlan(lifecyclePreview.id, createBrowserUuid());
      const plan = await api.createQuarantinePlan(item.id, {
        requestId: createBrowserUuid(),
        expectedLibraryRevision: item.revision ?? 0,
        localVersionId,
      });
      setLifecyclePreview(plan);
      await lifecyclePlans.reload();
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "无法生成隔离预览");
    } finally {
      setLifecycleWorking(false);
    }
  };
  const confirmQuarantine = async () => {
    if (!lifecyclePreview || !lifecycleConfirmed) return;
    setLifecycleWorking(true);
    try {
      await api.confirmLifecyclePlan(lifecyclePreview.id, createBrowserUuid());
      setLifecyclePreview(null);
      setLifecycleConfirmed(false);
      await Promise.all([album.reload(), lifecyclePlans.reload()]);
      toast.show("已提交隔离任务；源文件会先校验，再移入 COCEAN 隔离区");
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "隔离任务提交失败");
    } finally {
      setLifecycleWorking(false);
    }
  };
  const cancelLifecyclePreview = async () => {
    const plan = lifecyclePreview;
    if (!plan) return;
    try {
      await api.cancelLifecyclePlan(plan.id, createBrowserUuid());
      setLifecyclePreview(null);
      setLifecycleConfirmed(false);
      await lifecyclePlans.reload();
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "预览取消失败");
    }
  };
  const addDetailedCopy = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await api.addPhysicalCopy(item.id, {
        medium: copyDraft.medium,
        label: copyDraft.label || null,
        catalogNumber: copyDraft.catalogNumber || null,
        barcode: copyDraft.barcode || null,
        country: copyDraft.country || null,
        releaseYear: copyDraft.releaseYear
          ? Number(copyDraft.releaseYear)
          : null,
        quantity: Number(copyDraft.quantity),
        conditionNote: copyDraft.conditionNote || null,
        storageLocation: copyDraft.storageLocation || null,
      });
      setCopyFormOpen(false);
      await album.reload();
      toast.show("实体发行版本已保存");
    } catch (error) {
      toast.show(
        error instanceof Error ? error.message : "实体发行版本保存失败",
      );
    }
  };
  const removeCopy = async (copyId: string) => {
    try {
      await api.removePhysicalCopy(item.id, copyId);
      await album.reload();
      toast.show("实体唱片记录已删除");
    } catch {
      toast.show("实体唱片记录删除失败");
    }
  };
  const deliver = async () => {
    if (!deliveryTargetId) return toast.show("请先在“我的系统”配置投送目标");
    setDelivering(true);
    try {
      const planStorageKey = `cocean:delivery-plan:${deliveryTargetId}`;
      const storage = safeBrowserSessionStorage();
      const existingPlan = storage
        ? readRecentDeliveryPlan(planStorageKey, storage)
        : null;
      const planId = existingPlan?.id ?? createBrowserUuid();
      const created = await api.deliverAlbum(id, deliveryTargetId, planId);
      if (storage)
        safeStorageSet(
          storage,
          planStorageKey,
          JSON.stringify({
            id: created.planId ?? planId,
            updatedAt: Date.now(),
          }),
        );
      await deliveries.reload();
      toast.show("投送任务已创建，可在本页查看进度与完成时间");
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "投送任务创建失败");
    } finally {
      setDelivering(false);
    }
  };
  const generateIntroduction = async () => {
    setGeneratingIntroduction(true);
    try {
      await api.generateAlbumIntroduction(id);
      await introduction.reload();
      toast.show("专辑介绍已生成");
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "专辑介绍生成失败");
    } finally {
      setGeneratingIntroduction(false);
    }
  };
  const applyIdentityDecision = async (
    command: LibraryIdentityDecisionCommand,
  ) => {
    setIdentityWorking(true);
    try {
      const result = await api.applyIdentityDecision(id, command);
      await Promise.allSettled([album.reload(), identityHistory.reload()]);
      toast.show("身份治理决定已保存；源文件与既有版本级依赖未修改");
      if (command.type === "MERGE") {
        const params = new URLSearchParams();
        if (libraryReturnTo) params.set("from", libraryReturnTo);
        navigate(
          `/albums/${encodeURIComponent(result.currentLibraryAlbumId)}${params.size ? `?${params.toString()}` : ""}`,
        );
      }
    } catch (error) {
      await Promise.allSettled([album.reload(), identityHistory.reload()]);
      toast.show(error instanceof Error ? error.message : "身份治理操作失败");
    } finally {
      setIdentityWorking(false);
    }
  };
  const searchMergeTargets = async (query: string) => {
    const generation = identitySearchGeneration.current.begin();
    setIdentitySearchError(null);
    if (!query.trim()) return setIdentitySearchResults([]);
    try {
      const result = await api.albumPage({ search: query, limit: 25 });
      if (identitySearchGeneration.current.isLatest(generation))
        setIdentitySearchResults(
          result.items.filter((candidate) => candidate.id !== item.id),
        );
    } catch (error) {
      if (identitySearchGeneration.current.isLatest(generation)) {
        const message =
          error instanceof Error ? error.message : "合并目标搜索失败";
        setIdentitySearchError(message);
        setIdentitySearchResults([]);
        toast.show(message);
      }
    }
  };
  const selectMergeTarget = async (targetId: string) => {
    const generation = identityTargetGeneration.current.begin();
    setIdentityTargetDetail(null);
    setIdentityTargetError(null);
    if (!targetId) return;
    try {
      const detail = await api.album(targetId);
      if (identityTargetGeneration.current.isLatest(generation))
        setIdentityTargetDetail(detail);
    } catch (error) {
      if (identityTargetGeneration.current.isLatest(generation))
        setIdentityTargetError(
          error instanceof Error ? error.message : "无法读取合并目标版本",
        );
    }
  };
  const undoIdentityDecision = async (decision: LibraryIdentityDecision) => {
    if (
      !window.confirm(
        "撤销会写入一条补偿事件并恢复此前的身份关系。仅修改 COCEAN 数据库视图，不会改动 NAS 文件。是否继续？",
      )
    )
      return;
    setIdentityWorking(true);
    try {
      await api.undoIdentityDecision(id, decision.id, {
        requestId: createBrowserUuid(),
        revision: item.revision ?? 0,
      });
      await Promise.allSettled([album.reload(), identityHistory.reload()]);
      toast.show("身份治理决定已撤销，并已记录补偿事件");
    } catch (error) {
      await Promise.allSettled([album.reload(), identityHistory.reload()]);
      toast.show(error instanceof Error ? error.message : "撤销失败");
    } finally {
      setIdentityWorking(false);
    }
  };
  return (
    <div className="page album-detail-page">
      <AlbumDetailBreadcrumb returnTo={libraryReturnTo} title={item.title} />
      <section className="detail-hero">
        <AlbumArtwork album={item} size="hero" />
        <div className="detail-hero-copy">
          <h1>{item.title}</h1>
          <p className="album-meta">
            {item.albumArtist}
            {item.year ? ` · ${item.year}` : ""}
          </p>
          <div className="tag-row">
            <AudioSpecBadge
              label={item.mixedAudioSpecs ? "混合规格" : item.audioBadge}
              full={
                item.audioSummary
                  ? formatFullAudioSpec(item.audioSummary)
                  : null
              }
            />
            {item.physicalMedia.map((medium) => (
              <MediaTag key={medium} medium={medium} />
            ))}
          </div>
          {item.audioSummary ? (
            <p className="audio-spec-full">
              {formatFullAudioSpec(item.audioSummary)}
            </p>
          ) : null}
          <div
            className={`album-introduction${generatingIntroduction ? " is-generating" : ""}`}
          >
            <div className="album-introduction-copy">
              {introduction.data ? (
                <>
                  <p>{introduction.data.content}</p>
                </>
              ) : (
                <p>
                  {item.trackCount} 首曲目 · {item.discCount} Disc
                  {item.release.label ? ` · ${item.release.label}` : ""}
                </p>
              )}
            </div>
          </div>
          <AlbumDetailHeroActions
            canManage={canManage}
            hasDigital={item.hasDigital}
            hasTracks={item.tracks.length > 0}
            listening={Boolean(listeningTrack)}
            targets={enabledTargets}
            selectedTargetId={deliveryTargetId}
            delivering={delivering}
            selectedTargetNeedsCredential={selectedTargetNeedsCredential}
            onSelectTarget={setDeliveryTargetId}
            onDeliver={deliver}
            onListen={() => listen()}
          />
        </div>
      </section>

      <div className="detail-grid">
        <section className="surface-card owned-versions">
          <SectionTitle title="我的版本" />
          <AlbumLocalVersions
            versions={localVersions}
            versionCount={item.versionCount ?? 1}
            metadata={item.metadata}
            fallbackRelease={item.release}
          />
          <details className="collection-disclosure">
            <summary>
              <span>实体收藏</span>
              <small>
                {item.physicalCopies.length
                  ? `${item.physicalCopies.length} 条记录`
                  : "可记录 CD、SACD 与黑胶"}
              </small>
            </summary>
            {item.physicalCopies.map((copy) => (
              <div className="version-row" key={copy.id}>
                <span className="record-icon">◉</span>
                <div>
                  <strong>
                    <MediaTag medium={copy.medium} />
                  </strong>
                  <span>
                    {[copy.label, copy.catalogNumber, copy.releaseYear]
                      .filter(Boolean)
                      .join(" · ") || "实体副本；具体压片信息可继续补充"}
                  </span>
                  {copy.storageLocation ? (
                    <small>存放位置 · {copy.storageLocation}</small>
                  ) : null}
                </div>
                {canManage ? (
                  <button
                    className="version-delete"
                    type="button"
                    aria-label={`删除 ${copy.medium} 记录`}
                    onClick={() => void removeCopy(copy.id)}
                  >
                    <Trash2 />
                  </button>
                ) : null}
              </div>
            ))}
            {canManage ? (
              <div className="quick-media-add">
                <small>添加实体介质</small>
                <div>
                  <Button
                    variant="quiet"
                    onClick={() => void addPhysicalCopy("CD")}
                  >
                    CD
                  </Button>
                  <Button
                    variant="quiet"
                    onClick={() => void addPhysicalCopy("SACD")}
                  >
                    SACD
                  </Button>
                  <Button
                    variant="quiet"
                    onClick={() => void addPhysicalCopy("VINYL")}
                  >
                    黑胶
                  </Button>
                  <Button
                    variant="quiet"
                    onClick={() => setCopyFormOpen((value) => !value)}
                  >
                    <Plus /> 详细版本
                  </Button>
                </div>
              </div>
            ) : null}
            {copyFormOpen && canManage ? (
              <form className="physical-copy-form" onSubmit={addDetailedCopy}>
                <label>
                  <span>介质</span>
                  <select
                    value={copyDraft.medium}
                    onChange={(event) =>
                      setCopyDraft((value) => ({
                        ...value,
                        medium: event.target.value as PhysicalMedium,
                      }))
                    }
                  >
                    <option value="CD">CD</option>
                    <option value="SACD">SACD</option>
                    <option value="VINYL">黑胶</option>
                    <option value="CASSETTE">磁带</option>
                    <option value="BLURAY_AUDIO">Blu-ray Audio</option>
                    <option value="OTHER">其他</option>
                  </select>
                </label>
                <label>
                  <span>厂牌</span>
                  <input
                    value={copyDraft.label}
                    onChange={(event) =>
                      setCopyDraft((value) => ({
                        ...value,
                        label: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>目录号</span>
                  <input
                    value={copyDraft.catalogNumber}
                    onChange={(event) =>
                      setCopyDraft((value) => ({
                        ...value,
                        catalogNumber: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>条码</span>
                  <input
                    value={copyDraft.barcode}
                    onChange={(event) =>
                      setCopyDraft((value) => ({
                        ...value,
                        barcode: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>地区</span>
                  <input
                    value={copyDraft.country}
                    onChange={(event) =>
                      setCopyDraft((value) => ({
                        ...value,
                        country: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>年份</span>
                  <input
                    type="number"
                    min="1877"
                    max="2200"
                    value={copyDraft.releaseYear}
                    onChange={(event) =>
                      setCopyDraft((value) => ({
                        ...value,
                        releaseYear: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>数量</span>
                  <input
                    type="number"
                    min="1"
                    max="999"
                    value={copyDraft.quantity}
                    onChange={(event) =>
                      setCopyDraft((value) => ({
                        ...value,
                        quantity: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>存放位置</span>
                  <input
                    value={copyDraft.storageLocation}
                    onChange={(event) =>
                      setCopyDraft((value) => ({
                        ...value,
                        storageLocation: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="copy-note">
                  <span>品相 / 备注</span>
                  <input
                    value={copyDraft.conditionNote}
                    onChange={(event) =>
                      setCopyDraft((value) => ({
                        ...value,
                        conditionNote: event.target.value,
                      }))
                    }
                  />
                </label>
                <Button type="submit">保存版本</Button>
              </form>
            ) : null}
          </details>
        </section>
        <details className="surface-card delivery-history-card">
          <summary className="card-disclosure-summary">
            <span>投送记录</span>
            <small>
              {deliveries.data?.length
                ? `${deliveries.data.length} 次投送`
                : "尚无投送记录"}
            </small>
          </summary>
          {deliveries.data?.length ? (
            <div className="delivery-history-list">
              {deliveries.data.map((job) => (
                <AlbumDeliveryRecord job={job} key={job.id} />
              ))}
            </div>
          ) : (
            <div className="version-row">
              <span className="record-icon">—</span>
              <div>
                <strong>尚无投送记录</strong>
                <span>完成的 FTP / U 盘传输会显示目标和时间</span>
                <small>
                  <Link to="/systems">前往“我的系统”配置目标</Link>
                </small>
              </div>
            </div>
          )}
        </details>
      </div>

      <section
        id="album-management"
        className="surface-card album-management"
        aria-label="管理唱片"
      >
        <SectionTitle
          title="管理唱片"
          meta={canManage ? "资料、封面与版本" : "查看资料来源与记录"}
        />
        <p className="management-intro">
          日常浏览只保留常用信息。需要修正资料、封面或版本关系时，再展开对应项目。
        </p>
        <div className="management-groups">
          <details className="management-disclosure">
            <summary>
              <span>显示与存放</span>
              <small>隐藏唱片，或将托管目录中的本地版本移入隔离区</small>
            </summary>
            <div className="lifecycle-governance">
              <div className="lifecycle-visibility-row">
                <div>
                  <strong>
                    {item.visibility === "HIDDEN" ? "已隐藏" : "在唱片库中显示"}
                  </strong>
                  <p>隐藏只影响日常浏览和搜索，不会移动或删除 NAS 文件。</p>
                </div>
                {canManage ? (
                  <Button
                    variant="secondary"
                    disabled={visibilityWorking}
                    onClick={() => void changeVisibility()}
                  >
                    {item.visibility === "HIDDEN" ? <RotateCcw /> : <EyeOff />}
                    {item.visibility === "HIDDEN" ? "恢复显示" : "隐藏唱片"}
                  </Button>
                ) : (
                  <small>只有管理员可以更改显示状态</small>
                )}
              </div>

              <div className="lifecycle-version-list">
                <div className="lifecycle-section-heading">
                  <div>
                    <strong>本地文件存放</strong>
                    <p>
                      隔离不是永久删除；文件会保留在 COCEAN 隔离区，可随时恢复。
                    </p>
                  </div>
                  <Link to="/quarantine">查看隔离区</Link>
                </div>
                {localVersions.map((version) => (
                  <div className="lifecycle-version-row" key={version.id}>
                    <Archive aria-hidden="true" />
                    <div>
                      <strong>
                        {version.isPrimary ? "主版本" : "本地版本"} ·{" "}
                        {version.fileCount} 个文件
                      </strong>
                      <span>
                        {version.sourceRoot?.name ?? "实体收藏"} ·{" "}
                        {lifecycleStatusLabel(version.lifecycleStatus)}
                      </span>
                      <small>
                        {version.sourceRoot?.readOnly
                          ? "只读观察目录：COCEAN 不会改动这里的文件"
                          : version.sourceRoot
                            ? "托管目录：可先预览清单，再确认隔离"
                            : "没有可移动的本地文件"}
                      </small>
                    </div>
                    {canManage &&
                    version.sourceRoot &&
                    !version.sourceRoot.readOnly &&
                    (version.lifecycleStatus ?? "ACTIVE") === "ACTIVE" ? (
                      <Button
                        variant="secondary"
                        disabled={lifecycleWorking}
                        onClick={() => void previewQuarantine(version.id)}
                      >
                        预览隔离
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>

              {lifecyclePreview ? (
                <div
                  className="lifecycle-preview"
                  role="region"
                  aria-label="隔离预览"
                >
                  <div>
                    <strong>隔离前确认</strong>
                    <p>
                      将移动 {lifecyclePreview.fileCount} 个文件，共{" "}
                      {formatFileSize(lifecyclePreview.totalBytes)}。
                      文件身份和目标位置已冻结，执行时如有变化会停止。
                    </p>
                  </div>
                  {lifecyclePreview.blockers.length ? (
                    <div className="lifecycle-blockers" role="alert">
                      {lifecyclePreview.blockers.map((blocker) => (
                        <span key={blocker.code}>{blocker.message}</span>
                      ))}
                    </div>
                  ) : (
                    <label className="lifecycle-confirmation">
                      <input
                        type="checkbox"
                        checked={lifecycleConfirmed}
                        onChange={(event) =>
                          setLifecycleConfirmed(event.target.checked)
                        }
                      />
                      我确认移动的是这个本地版本；原曲库目录不会保留这些文件
                    </label>
                  )}
                  <div className="lifecycle-preview-actions">
                    <Button
                      variant="quiet"
                      onClick={() => void cancelLifecyclePreview()}
                    >
                      取消
                    </Button>
                    <Button
                      disabled={
                        lifecycleWorking ||
                        !lifecyclePreview.executable ||
                        !lifecycleConfirmed
                      }
                      onClick={() => void confirmQuarantine()}
                    >
                      确认移入隔离区
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </details>

          <details className="management-disclosure">
            <summary>
              <span>核对唱片资料</span>
              <small>查找匹配的发行版本，补齐可信资料</small>
            </summary>
            <div className="management-shortcut">
              <p>从候选发行中核对曲目、年份与版本，不会自动改动 NAS 文件。</p>
              <Link
                className="button secondary"
                to={`/albums/${item.id}/match`}
              >
                开始核对
              </Link>
            </div>
          </details>

          {item.metadata ? (
            <details className="management-disclosure">
              <summary>
                <span>编辑唱片资料</span>
                <small>名称、艺术家、年份及各版本发行资料</small>
              </summary>
              <AlbumMetadataGovernance
                metadata={item.metadata}
                history={metadataHistory.data ?? []}
                historyError={metadataHistory.error?.message ?? null}
                canManage={canManage}
                onReload={async () => {
                  const [latest] = await Promise.all([
                    album.reload(),
                    metadataHistory.reload(),
                  ]);
                  return latest !== null;
                }}
                onToast={toast.show}
              />
            </details>
          ) : null}

          {item.artworkGovernance ? (
            <details className="management-disclosure">
              <summary>
                <span>管理封面</span>
                <small>比较本地封面、上传图片或恢复自动选择</small>
              </summary>
              <AlbumArtworkGovernancePanel
                album={item}
                governance={item.artworkGovernance}
                history={artworkHistory.data ?? []}
                historyError={artworkHistory.error?.message ?? null}
                canManage={canManage}
                onReload={async () => {
                  const [latest] = await Promise.all([
                    album.reload(),
                    artworkHistory.reload(),
                  ]);
                  return latest !== null;
                }}
                onToast={toast.show}
              />
            </details>
          ) : null}

          <details className="management-disclosure">
            <summary>
              <span>合并或拆分版本</span>
              <small>处理重复唱片、残缺版本与错误聚合</small>
            </summary>
            <AlbumIdentityGovernance
              key={item.id}
              album={item}
              versions={localVersions}
              canManage={canManage}
              working={identityWorking}
              searchResults={identitySearchResults}
              searchError={identitySearchError}
              targetDetail={identityTargetDetail}
              targetError={identityTargetError}
              onSearch={searchMergeTargets}
              onSelectTarget={selectMergeTarget}
              onApply={applyIdentityDecision}
            />
            <AlbumIdentityHistory
              decisions={identityHistory.data ?? []}
              error={identityHistory.error?.message ?? null}
              canManage={canManage}
              working={identityWorking}
              onUndo={undoIdentityDecision}
            />
          </details>

          {canManage ? (
            <details className="management-disclosure">
              <summary>
                <span>唱片介绍</span>
                <small>生成或更新用于浏览的简介</small>
              </summary>
              <div className="management-shortcut">
                <p>
                  介绍仅根据本地唱片事实整理，不参与版本识别，也不会修改标签。
                </p>
                {modelReady ? (
                  <Button
                    variant="secondary"
                    disabled={generatingIntroduction}
                    onClick={() => void generateIntroduction()}
                  >
                    <Sparkles />
                    {generatingIntroduction
                      ? "正在更新"
                      : introduction.data
                        ? "更新唱片介绍"
                        : "生成唱片介绍"}
                  </Button>
                ) : (
                  <Link
                    className="button secondary"
                    to="/settings#settings-assist"
                  >
                    {modelConfigured ? "检查介绍功能" : "配置介绍功能"}
                  </Link>
                )}
              </div>
            </details>
          ) : null}
        </div>
      </section>

      <AlbumIntegrityIssues issues={item.issues ?? []} />

      {item.aggregationIssues?.length ? (
        <section className="album-structure-issues" aria-label="曲目结构需复核">
          <div>
            <strong>曲目结构需复核</strong>
            <span>来自 Disc / Track 标签与本地文件的确定性对照</span>
          </div>
          <div className="issue-labels">
            {item.aggregationIssues.map((issue, index) => (
              <span
                className="issue-tag"
                key={`${issue.code}-${issue.discNumber}-${issue.trackNumber}-${index}`}
              >
                {albumAggregationIssueLabel(issue)}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section className="tracks-section">
        <SectionTitle
          title="曲目"
          meta={
            item.hasDigital
              ? `${item.trackCount} tracks · ${item.discCount} disc`
              : "没有数字文件"
          }
        />
        {item.tracks.length ? (
          <div className="disc-track-groups">
            {discGroups.map((group) => (
              <section className="disc-group" key={group.key}>
                <header className="disc-heading">
                  <h3>
                    {group.discNumber === null
                      ? "Disc 未标记"
                      : `Disc ${group.discNumber}`}
                  </h3>
                  <span>{group.tracks.length} tracks</span>
                </header>
                <div className="track-list">
                  {group.tracks.map((track) => (
                    <div
                      className={`track-row${listeningTrackId === track.id ? " is-listening" : ""}`}
                      key={track.id}
                    >
                      <button
                        className="track-listen"
                        type="button"
                        aria-label={`${listeningTrackId === track.id ? "暂停" : "播放"} ${formatTrackPosition(track)} ${track.title}`}
                        onClick={() => listen(track.id)}
                      >
                        {listeningTrackId === track.id ? <Pause /> : <Play />}
                      </button>
                      <div className="track-copy">
                        <span className="track-position">
                          {formatTrackPosition(track)}
                        </span>
                        <strong>{track.title}</strong>
                        <small>{track.artist}</small>
                        <span className="track-technical">
                          {formatTrackAudioDetails(
                            track.audioSpec,
                            track.sizeBytes,
                          )}
                        </span>
                        {track.warningCodes.length ? (
                          <span
                            className="track-warnings"
                            aria-label="标签与规格待复核"
                          >
                            <TriangleAlert aria-hidden="true" />
                            {track.warningCodes.map((code) => (
                              <span key={code}>{trackWarningLabel(code)}</span>
                            ))}
                          </span>
                        ) : null}
                      </div>
                      <AudioSpecBadge
                        label={compactTrackAudioSpec(track.audioSpec)}
                        full={formatTrackAudioDetails(
                          track.audioSpec,
                          track.sizeBytes,
                        )}
                      />
                      <time>{formatDuration(track.durationSeconds)}</time>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <p className="quiet-row">
            实体收藏不会伪造数字曲目；匹配发行版本后仍需由真实数字文件建立
            Listen。
          </p>
        )}
      </section>
      {listeningTrack ? (
        <section className="listen-bar" aria-label="播放验证">
          <div>
            <small>LISTEN · 播放验证</small>
            <strong>{listeningTrack.title}</strong>
            <span>
              {listeningTrack.audioSpec.kind === "DSD"
                ? "服务器实时转为 PCM FLAC 播放；源 DSD 文件不会修改"
                : listeningTrack.relativePath}
            </span>
          </div>
          <audio
            key={listeningTrack.id}
            src={api.listenUrl(listeningTrack.id)}
            controls
            autoPlay
            onError={() =>
              toast.show("浏览器无法播放此格式；文件与音频规格仍可正常核验")
            }
          />
          <Button
            variant="quiet"
            aria-label="关闭播放验证"
            onClick={() => setListeningTrackId(null)}
          >
            ×
          </Button>
        </section>
      ) : null}
      <Toast message={toast.message} />
    </div>
  );
}

export function AlbumDetailHeroActions({
  canManage,
  hasDigital,
  hasTracks,
  listening,
  targets,
  selectedTargetId,
  delivering,
  selectedTargetNeedsCredential,
  onSelectTarget,
  onDeliver,
  onListen,
}: {
  canManage: boolean;
  hasDigital: boolean;
  hasTracks: boolean;
  listening: boolean;
  targets: DeliveryTarget[];
  selectedTargetId: string;
  delivering: boolean;
  selectedTargetNeedsCredential: boolean;
  onSelectTarget: (targetId: string) => void;
  onDeliver: () => void | Promise<void>;
  onListen: () => void;
}) {
  return (
    <div className="hero-actions">
      {canManage && hasDigital && targets.length ? (
        <details className="delivery-action-menu">
          <summary>
            <Send /> 投送到播放器
          </summary>
          <div className="delivery-action-popover">
            <label>
              <span>投送目标</span>
              <select
                className="delivery-target-select"
                aria-label="选择投送目标"
                value={selectedTargetId}
                onChange={(event) => onSelectTarget(event.target.value)}
              >
                {targets.map((target) => (
                  <option value={target.id} key={target.id}>
                    {target.name} · {deliveryTargetTransportLabel(target)}
                    {isFtpTarget(target) && !target.credentialConfigured
                      ? " · 待凭据"
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={delivering || selectedTargetNeedsCredential}
              onClick={() => void onDeliver()}
            >
              <Send /> {delivering ? "正在创建" : "确认投送"}
            </Button>
            {selectedTargetNeedsCredential ? (
              <a className="text-link" href="/systems">
                补录 FTP 凭据
              </a>
            ) : null}
          </div>
        </details>
      ) : canManage && hasDigital ? (
        <a className="button primary" href="/systems">
          <Send /> 配置投送
        </a>
      ) : null}
      <Button variant="secondary" disabled={!hasTracks} onClick={onListen}>
        {listening ? <Pause /> : <Play />} 试听
      </Button>
      {canManage ? (
        <a
          className="button secondary album-manage-link"
          href="#album-management"
        >
          管理唱片
        </a>
      ) : null}
    </div>
  );
}

function readRecentDeliveryPlan(
  key: string,
  storage: LibraryStorage,
): { id: string; updatedAt: number } | null {
  try {
    const value = JSON.parse(safeStorageGet(storage, key) ?? "null") as {
      id?: unknown;
      updatedAt?: unknown;
    } | null;
    if (
      !value ||
      typeof value.id !== "string" ||
      typeof value.updatedAt !== "number" ||
      Date.now() - value.updatedAt > 15 * 60 * 1000
    ) {
      safeStorageRemove(storage, key);
      return null;
    }
    return { id: value.id, updatedAt: value.updatedAt };
  } catch {
    safeStorageRemove(storage, key);
    return null;
  }
}

export function AlbumDetailBreadcrumb({
  returnTo,
  title,
}: {
  returnTo: string;
  title: string;
}) {
  return (
    <div className="breadcrumb">
      <Link to={safeLibraryReturn(returnTo)}>唱片库</Link>
      <ChevronRight />
      <span>{title}</span>
    </div>
  );
}

function createBrowserUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function AlbumArtworkGovernancePanel({
  album,
  governance,
  history,
  historyError,
  canManage,
  onReload,
  onToast,
}: {
  album: AlbumDetail;
  governance: AlbumArtworkGovernance;
  history: AlbumArtworkEvent[];
  historyError: string | null;
  canManage: boolean;
  onReload: () => Promise<boolean>;
  onToast: (message: string) => void;
}) {
  const confirmedVersions = (album.localVersions ?? []).filter(
    (version) =>
      version.matchStatus === "USER_CONFIRMED" &&
      Boolean(version.musicBrainzReleaseId),
  );
  const [selectedVersionId, setSelectedVersionId] = useState(
    confirmedVersions[0]?.id ?? "",
  );
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [working, setWorking] = useState(false);
  const previousAlbumId = useRef(governance.libraryAlbumId);
  useEffect(() => {
    if (previousAlbumId.current === governance.libraryAlbumId) return;
    previousAlbumId.current = governance.libraryAlbumId;
    setSelectedVersionId(confirmedVersions[0]?.id ?? "");
    setUploadFile(null);
  }, [confirmedVersions, governance.libraryAlbumId]);

  const run = async (
    operation: () => Promise<unknown>,
    successMessage: string,
  ) => {
    setWorking(true);
    try {
      await operation();
      await onReload();
      onToast(successMessage);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await onReload();
      onToast(error instanceof Error ? error.message : "封面操作失败");
    } finally {
      setWorking(false);
    }
  };
  const revision = governance.artworkRevision;
  const localCandidates = governance.candidates.filter((candidate) =>
    candidate.source.startsWith("OBSERVED_"),
  );
  const importedCandidates = governance.candidates.filter(
    (candidate) => candidate.source === "MUSICBRAINZ_CAA",
  );
  const uploadedCandidates = governance.candidates.filter(
    (candidate) => candidate.source === "USER_UPLOAD",
  );
  const selectCandidate = (candidateId: string) =>
    run(
      () =>
        api.selectAlbumArtwork(governance.libraryAlbumId, {
          action: "SELECT",
          candidateId,
          requestId: createBrowserUuid(),
          expectedArtworkRevision: revision,
        }),
      "封面已选中；源文件和既有排队任务未修改",
    );

  return (
    <section className="surface-card artwork-governance" aria-label="管理封面">
      <SectionTitle
        title="管理封面"
        meta={canManage ? "可选择、上传或恢复自动封面" : "只读"}
      />
      <div className="artwork-governance-summary">
        <div className="artwork-effective-preview">
          {governance.effectiveArtwork.url ? (
            <img
              src={governance.effectiveArtwork.url}
              alt={`${album.title} 当前有效封面`}
            />
          ) : (
            <div className="artwork-empty">
              <ImageOff />
              <span>当前不显示封面</span>
            </div>
          )}
        </div>
        <div>
          <strong>{artworkSelectionLabel(governance.selectionSource)}</strong>
          <p>
            {governance.effectiveArtwork.width ?? "–"} ×{" "}
            {governance.effectiveArtwork.height ?? "–"}
            {governance.selectedAssetSha256
              ? ` · ${governance.selectedAssetSha256.slice(0, 12)}`
              : ""}
          </p>
          <small>所有修改只作用于 COCEAN 缓存与治理层，不回写 NAS 文件。</small>
          {canManage ? (
            <div className="artwork-summary-actions">
              <Button
                variant="secondary"
                disabled={working}
                onClick={() =>
                  void run(
                    () =>
                      api.selectAlbumArtwork(governance.libraryAlbumId, {
                        action: "RESET",
                        requestId: createBrowserUuid(),
                        expectedArtworkRevision: revision,
                      }),
                    "已恢复自动封面选择",
                  )
                }
              >
                恢复自动
              </Button>
              <Button
                variant="quiet"
                disabled={working}
                onClick={() =>
                  void run(
                    () =>
                      api.selectAlbumArtwork(governance.libraryAlbumId, {
                        action: "HIDE",
                        requestId: createBrowserUuid(),
                        expectedArtworkRevision: revision,
                      }),
                    "已隐藏这张唱片的封面",
                  )
                }
              >
                <ImageOff /> 隐藏封面
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      <ArtworkCandidateSection
        title="本地候选"
        empty="扫描尚未发现可用的内嵌或目录封面"
        candidates={localCandidates}
        canManage={canManage}
        working={working}
        onSelect={selectCandidate}
      />
      <ArtworkCandidateSection
        title="MusicBrainz / CAA"
        empty="尚未导入已确认发行版的正面封面"
        candidates={importedCandidates}
        canManage={canManage}
        working={working}
        onSelect={selectCandidate}
      />
      {canManage ? (
        <div className="artwork-import-actions">
          <label>
            <span>已确认的本地版本</span>
            <select
              value={selectedVersionId}
              onChange={(event) => setSelectedVersionId(event.target.value)}
            >
              {!confirmedVersions.length ? (
                <option value="">请先完成人工发行匹配</option>
              ) : null}
              {confirmedVersions.map((version) => (
                <option value={version.id} key={version.id}>
                  {version.title} · {version.musicBrainzReleaseId?.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="secondary"
            disabled={working || !selectedVersionId}
            onClick={() =>
              void run(
                () =>
                  api.importMusicBrainzArtwork(governance.libraryAlbumId, {
                    localVersionId: selectedVersionId,
                    requestId: createBrowserUuid(),
                    expectedArtworkRevision: revision,
                  }),
                "CAA 正面封面已校验、导入并选中",
              )
            }
          >
            <Download /> 导入 CAA 正面封面
          </Button>
        </div>
      ) : null}

      <ArtworkCandidateSection
        title="管理员上传"
        empty="尚未上传自定义封面"
        candidates={uploadedCandidates}
        canManage={canManage}
        working={working}
        onSelect={selectCandidate}
      />
      {canManage ? (
        <div className="artwork-upload-row">
          <input
            aria-label="选择封面文件"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
          />
          <Button
            variant="secondary"
            disabled={working || !uploadFile}
            onClick={() => {
              if (!uploadFile) return;
              void run(
                () =>
                  api.uploadAlbumArtwork(
                    governance.libraryAlbumId,
                    uploadFile,
                    {
                      requestId: createBrowserUuid(),
                      expectedArtworkRevision: revision,
                    },
                  ),
                "上传封面已校验并选中",
              );
            }}
          >
            <Upload /> 上传并选中
          </Button>
          <small>JPEG / PNG / WebP，最大 20 MiB；服务端会真实解码校验。</small>
        </div>
      ) : null}

      <div className="artwork-history">
        <h3>封面决定历史</h3>
        {historyError ? (
          <p className="error-copy">历史读取失败：{historyError}</p>
        ) : null}
        {!historyError && !history.length ? <p>还没有人工封面决定。</p> : null}
        {history.map((event) => (
          <div key={event.id} className="artwork-history-row">
            <div>
              <strong>{artworkEventLabel(event.type)}</strong>
              <span>
                {event.actor.displayName} ·{" "}
                {new Date(event.createdAt).toLocaleString()}
              </span>
            </div>
            {canManage && event.canUndo ? (
              <Button
                variant="quiet"
                disabled={working}
                onClick={() =>
                  void run(
                    () =>
                      api.undoArtworkEvent(
                        governance.libraryAlbumId,
                        event.id,
                        {
                          requestId: createBrowserUuid(),
                          expectedArtworkRevision: revision,
                        },
                      ),
                    "封面决定已撤销，并记录补偿事件",
                  )
                }
              >
                撤销
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function ArtworkCandidateSection({
  title,
  empty,
  candidates,
  canManage,
  working,
  onSelect,
}: {
  title: string;
  empty: string;
  candidates: AlbumArtworkGovernance["candidates"];
  canManage: boolean;
  working: boolean;
  onSelect: (candidateId: string) => Promise<void>;
}) {
  return (
    <div className="artwork-candidate-section">
      <h3>{title}</h3>
      {!candidates.length ? <p>{empty}</p> : null}
      <div className="artwork-candidate-grid">
        {candidates.map((candidate) => (
          <article
            key={candidate.id}
            className={`artwork-candidate${candidate.selected ? " is-selected" : ""}`}
          >
            <img src={candidate.url} alt={`${title}封面候选`} />
            <div>
              <strong>{artworkCandidateSourceLabel(candidate.source)}</strong>
              <span>
                {candidate.width} × {candidate.height} · {candidate.mimeType} ·{" "}
                {formatFileSize(candidate.sizeBytes)}
              </span>
              <small>
                {candidate.localVersionId
                  ? `版本 ${candidate.localVersionId.slice(0, 10)}`
                  : "唱片级资产"}
                {candidate.lowResolution ? " · 低清" : ""}
                {!candidate.current ? " · 历史候选" : ""}
              </small>
              {candidate.relativePath ? (
                <small title={candidate.relativePath}>
                  路径 · {candidate.relativePath}
                </small>
              ) : null}
            </div>
            {canManage ? (
              <Button
                variant={candidate.selected ? "quiet" : "secondary"}
                disabled={working || candidate.selected || !candidate.current}
                onClick={() => void onSelect(candidate.id)}
              >
                {candidate.selected ? "当前使用" : "选择"}
              </Button>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}

function artworkSelectionLabel(
  source: AlbumArtworkGovernance["selectionSource"],
): string {
  return (
    {
      USER_SELECTED: "人工选择",
      USER_HIDDEN: "人工隐藏",
      AUTOMATIC_PRIMARY: "主版本自动封面",
      AUTOMATIC_REPRESENTATIVE: "代表版本自动封面",
      NONE: "没有可用封面",
    } as const
  )[source];
}

function artworkCandidateSourceLabel(
  source: AlbumArtworkGovernance["candidates"][number]["source"],
): string {
  return {
    OBSERVED_EMBEDDED: "内嵌封面",
    OBSERVED_SIDECAR: "目录封面",
    USER_UPLOAD: "管理员上传",
    MUSICBRAINZ_CAA: "MusicBrainz CAA",
  }[source];
}

function artworkEventLabel(type: AlbumArtworkEvent["type"]): string {
  return {
    SELECT: "选择封面",
    HIDE: "隐藏封面",
    RESET: "恢复自动",
    UPLOAD: "上传封面",
    IMPORT: "导入 CAA",
    UNDO: "撤销补偿",
  }[type];
}

const metadataLabels: Record<MetadataField, string> = {
  title: "标题",
  albumArtist: "专辑艺术家",
  year: "年份",
  label: "厂牌",
  catalogNumber: "目录号",
  barcode: "条码",
  country: "国家",
  releaseDate: "发行日期",
};

export function AlbumMetadataGovernance({
  metadata,
  history,
  historyError,
  canManage,
  onReload,
  onToast,
}: {
  metadata: NonNullable<AlbumDetail["metadata"]>;
  history: AlbumMetadataEvent[];
  historyError: string | null;
  canManage: boolean;
  onReload: () => Promise<boolean>;
  onToast: (message: string) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [reloadBlocked, setReloadBlocked] = useState(false);
  const previousAlbumId = useRef(metadata.libraryAlbumId);
  const albumRows = (["title", "albumArtist", "year"] as const).map(
    (field) => ({
      key: field,
      field,
      versionId: undefined as string | undefined,
      state: metadata.album[field],
    }),
  );
  const versionRows = metadata.versions.flatMap((version) =>
    (Object.keys(version.fields) as Array<keyof typeof version.fields>).map(
      (field) => ({
        key: `${version.versionId}:${field}`,
        field,
        versionId: version.versionId,
        state: version.fields[field],
      }),
    ),
  );
  const rows = [...albumRows, ...versionRows];
  useEffect(() => {
    const changedAlbum = previousAlbumId.current !== metadata.libraryAlbumId;
    previousAlbumId.current = metadata.libraryAlbumId;
    const validKeys = new Set(rows.map((row) => row.key));
    setReloadBlocked(false);
    setTouched((current) =>
      changedAlbum
        ? new Set()
        : new Set([...current].filter((key) => validKeys.has(key))),
    );
    setCleared((current) =>
      changedAlbum
        ? new Set()
        : new Set([...current].filter((key) => validKeys.has(key))),
    );
    setDraft((current) => {
      const next = changedAlbum ? {} : { ...current };
      for (const row of rows)
        if (changedAlbum || !touched.has(row.key))
          next[row.key] = metadataDisplayValue(row.state.effectiveValue);
      return next;
    });
  }, [metadata.libraryAlbumId, metadata.metadataRevision]);

  const save = async () => {
    let commands: MetadataCommand[];
    try {
      commands = buildMetadataCommands(rows, touched, cleared, draft);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "字段值无效");
      return;
    }
    if (!commands.length) return;
    setWorking(true);
    try {
      await api.updateAlbumMetadata(metadata.libraryAlbumId, {
        requestId: createBrowserUuid(),
        expectedMetadataRevision: metadata.metadataRevision,
        commands,
      });
      setTouched(new Set());
      setCleared(new Set());
      const reloaded = await onReload();
      setReloadBlocked(!reloaded);
      onToast(
        reloaded
          ? "元数据已保存；仅修改 COCEAN 数据库，扫描标签未改变"
          : "元数据已保存，但最新详情加载失败；已暂停编辑，请刷新页面",
      );
    } catch (error) {
      const reloaded = await onReload();
      setReloadBlocked(!reloaded);
      onToast(
        error instanceof ApiError && error.status === 409
          ? "元数据已变化，页面已刷新；未提交草稿仍保留"
          : error instanceof Error
            ? error.message
            : "元数据保存失败",
      );
    } finally {
      setWorking(false);
    }
  };

  const reset = async (row: (typeof rows)[number]) => {
    setWorking(true);
    try {
      await api.updateAlbumMetadata(metadata.libraryAlbumId, {
        requestId: createBrowserUuid(),
        expectedMetadataRevision: metadata.metadataRevision,
        commands: [
          {
            action: "RESET",
            field: row.field,
            ...(row.versionId ? { versionId: row.versionId } : {}),
          },
        ],
      });
      setTouched((current) => {
        const next = new Set(current);
        next.delete(row.key);
        return next;
      });
      setCleared((current) => {
        const next = new Set(current);
        next.delete(row.key);
        return next;
      });
      const reloaded = await onReload();
      setReloadBlocked(!reloaded);
      onToast("已移除人工覆盖，恢复到下一层可信值");
    } catch (error) {
      const reloaded = await onReload();
      setReloadBlocked(!reloaded);
      onToast(error instanceof Error ? error.message : "恢复失败");
    } finally {
      setWorking(false);
    }
  };

  const undo = async (event: AlbumMetadataEvent) => {
    setWorking(true);
    try {
      await api.undoMetadataEvent(metadata.libraryAlbumId, event.id, {
        requestId: createBrowserUuid(),
        expectedMetadataRevision: metadata.metadataRevision,
      });
      const reloaded = await onReload();
      setReloadBlocked(!reloaded);
      onToast("元数据事件已撤销，并追加了补偿记录");
    } catch (error) {
      const reloaded = await onReload();
      setReloadBlocked(!reloaded);
      onToast(error instanceof Error ? error.message : "撤销失败");
    } finally {
      setWorking(false);
    }
  };

  return (
    <section
      className="surface-card metadata-governance"
      aria-label="编辑唱片资料"
    >
      <SectionTitle
        title="编辑唱片资料"
        meta={canManage ? "修改只保存在 COCEAN" : "只读"}
      />
      <p className="quiet-row">
        COCEAN 会优先使用你的修改，其次使用已核对资料和文件标签；不会改写 NAS
        文件。
      </p>
      <h3>整张唱片</h3>
      <div className="metadata-field-list">
        {albumRows.map((row) => (
          <MetadataFieldEditor
            key={row.key}
            label={metadataLabels[row.field]}
            state={row.state}
            value={draft[row.key] ?? ""}
            canManage={canManage}
            disabled={working || reloadBlocked}
            allowClear={row.field === "year"}
            error={
              touched.has(row.key) && !cleared.has(row.key)
                ? metadataDraftError(row.field, draft[row.key] ?? "")
                : null
            }
            onChange={(value) => {
              setDraft((current) => ({ ...current, [row.key]: value }));
              setTouched((current) => new Set(current).add(row.key));
              setCleared((current) => {
                const next = new Set(current);
                next.delete(row.key);
                return next;
              });
            }}
            onClear={() => {
              setDraft((current) => ({ ...current, [row.key]: "" }));
              setTouched((current) => new Set(current).add(row.key));
              setCleared((current) => new Set(current).add(row.key));
            }}
            onReset={() => void reset(row)}
          />
        ))}
      </div>
      {metadata.versions.map((version, versionIndex) => (
        <div key={version.versionId} className="metadata-version-group">
          <h3>本地版本 {versionIndex + 1}</h3>
          {versionRows
            .filter((row) => row.versionId === version.versionId)
            .map((row) => (
              <MetadataFieldEditor
                key={row.key}
                label={metadataLabels[row.field]}
                state={row.state}
                value={draft[row.key] ?? ""}
                canManage={canManage}
                disabled={working || reloadBlocked}
                allowClear
                error={
                  touched.has(row.key) && !cleared.has(row.key)
                    ? metadataDraftError(row.field, draft[row.key] ?? "")
                    : null
                }
                onChange={(value) => {
                  setDraft((current) => ({ ...current, [row.key]: value }));
                  setTouched((current) => new Set(current).add(row.key));
                  setCleared((current) => {
                    const next = new Set(current);
                    next.delete(row.key);
                    return next;
                  });
                }}
                onClear={() => {
                  setDraft((current) => ({ ...current, [row.key]: "" }));
                  setTouched((current) => new Set(current).add(row.key));
                  setCleared((current) => new Set(current).add(row.key));
                }}
                onReset={() => void reset(row)}
              />
            ))}
        </div>
      ))}
      {canManage ? (
        <Button
          disabled={working || reloadBlocked || touched.size === 0}
          onClick={() => void save()}
        >
          保存修改（{touched.size} 个字段）
        </Button>
      ) : (
        <p className="identity-governance-readonly">
          你可以查看资料来源和修改记录；只有管理员可以修改或撤销。
        </p>
      )}
      <div className="metadata-history">
        <h3>最近修改</h3>
        {historyError ? <p className="error-row">{historyError}</p> : null}
        {history.map((event) => (
          <div className="version-row" key={event.id}>
            <Clock3 />
            <div>
              <strong>{metadataEventLabel(event.type)}</strong>
              <span>
                {event.actor.displayName} · {metadataEventCommands(event)}
              </span>
              <small>{new Date(event.createdAt).toLocaleString()}</small>
            </div>
            {canManage && event.canUndo ? (
              <Button
                variant="quiet"
                disabled={working}
                onClick={() => void undo(event)}
              >
                撤销
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function MetadataFieldEditor({
  label,
  state,
  value,
  canManage,
  disabled,
  allowClear,
  error,
  onChange,
  onClear,
  onReset,
}: {
  label: string;
  state: MetadataFieldState;
  value: string;
  canManage: boolean;
  disabled: boolean;
  allowClear: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onClear: () => void;
  onReset: () => void;
}) {
  return (
    <div className="metadata-field-row">
      <label>
        <span>{label}</span>
        {canManage ? (
          <input
            disabled={disabled}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <strong>{metadataDisplayValue(state.effectiveValue) || "空"}</strong>
        )}
      </label>
      <small>
        来源：{metadataSourceLabel(state.effectiveSource)} · 观察值：
        {metadataDisplayValue(state.observed.value) || "空"}
      </small>
      {state.confirmedExternal ? (
        <small>
          外部证据：{state.confirmedExternal.provider} · 候选{" "}
          {state.confirmedExternal.candidateId} ·{" "}
          {new Date(state.confirmedExternal.confirmedAt).toLocaleString()}
        </small>
      ) : null}
      {state.userOverride ? (
        <small>
          人工覆盖：{state.userOverride.actor.displayName} ·{" "}
          {new Date(state.userOverride.updatedAt).toLocaleString()}
        </small>
      ) : null}
      {error ? <small className="error-row">{error}</small> : null}
      {canManage ? (
        <div>
          {allowClear ? (
            <Button variant="quiet" disabled={disabled} onClick={onClear}>
              清空有效值
            </Button>
          ) : null}
          <Button
            variant="quiet"
            disabled={disabled || !state.userOverride}
            onClick={onReset}
          >
            移除人工覆盖 / 恢复下一层可信值
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function metadataDisplayValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function metadataDraftError(
  field: MetadataField,
  value: string,
): string | null {
  const text = value.trim();
  if (!text)
    return `${metadataLabels[field]}不能设置为空白；需要空值时请使用“清空有效值”`;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text))
    return `${metadataLabels[field]}不能包含控制字符`;
  const maximum =
    field === "catalogNumber" ? 100 : field === "barcode" ? 14 : 300;
  if (text.length > maximum)
    return `${metadataLabels[field]}不能超过 ${maximum} 个字符`;
  if (field === "year") {
    const year = Number(text);
    if (
      !Number.isInteger(year) ||
      year < 1000 ||
      year > new Date().getFullYear() + 1
    )
      return "年份必须是 1000 至下一年之间的整数";
  }
  if (field === "barcode" && !/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(text))
    return "条码必须是 8、12、13 或 14 位数字";
  if (field === "country" && !/^[A-Z]{2}$/.test(text))
    return "国家必须是两位大写国家码";
  if (field === "releaseDate" && !validMetadataDate(text))
    return "发行日期必须是 YYYY、YYYY-MM 或有效的 YYYY-MM-DD";
  return null;
}

export function buildMetadataCommands(
  rows: Array<{
    key: string;
    field: MetadataField;
    versionId?: string | undefined;
  }>,
  touched: Set<string>,
  cleared: Set<string>,
  draft: Record<string, string>,
): MetadataCommand[] {
  return rows
    .filter((row) => touched.has(row.key))
    .map((row) => {
      const common = {
        field: row.field,
        ...(row.versionId ? { versionId: row.versionId } : {}),
      };
      if (cleared.has(row.key)) return { action: "CLEAR" as const, ...common };
      const value = draft[row.key] ?? "";
      const error = metadataDraftError(row.field, value);
      if (error) throw new Error(error);
      return {
        action: "SET" as const,
        ...common,
        value: row.field === "year" ? Number(value) : value,
      };
    });
}

function metadataEventCommands(event: AlbumMetadataEvent): string {
  return event.commands
    .map((command) => {
      const target = command.versionId
        ? `${shortStableId(command.versionId)} / `
        : "";
      const value =
        command.action === "SET" ? ` = ${String(command.value)}` : "";
      return `${target}${metadataLabels[command.field]} ${command.action}${value}`;
    })
    .join("；");
}

function validMetadataDate(value: string): boolean {
  if (/^\d{4}$/.test(value) || /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value))
    return true;
  if (!/^\d{4}-(?:0[1-9]|1[0-2])-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

function metadataSourceLabel(source: string): string {
  return (
    (
      {
        USER_OVERRIDE: "人工覆盖",
        CONFIRMED_EXTERNAL: "已确认外部来源",
        OBSERVED_TAG: "扫描标签",
        PATH_FALLBACK: "路径回退",
      } as Record<string, string>
    )[source] ?? source
  );
}

function metadataEventLabel(type: AlbumMetadataEvent["type"]): string {
  return type === "UNDO"
    ? "撤销补偿"
    : type === "CONFIRM_EXTERNAL"
      ? "确认外部候选"
      : "字段修订";
}

function lifecycleStatusLabel(
  status: LocalVersionSummary["lifecycleStatus"],
): string {
  if (!status) return "在曲库中";
  return (
    {
      ACTIVE: "在曲库中",
      QUARANTINING: "正在移入隔离区",
      QUARANTINED: "已隔离",
      RESTORING: "正在恢复",
      RECOVERY_REQUIRED: "需要人工检查",
    }[status] ?? status
  );
}
function formatDuration(value: number | null) {
  if (!value) return "–";
  const wholeSeconds = Math.max(1, Math.round(value));
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

export function AlbumLocalVersions({
  versions,
  versionCount,
  metadata,
  fallbackRelease,
}: {
  versions: LocalVersionSummary[];
  versionCount: number;
  metadata?: NonNullable<AlbumDetail["metadata"]> | null | undefined;
  fallbackRelease?: AlbumDetail["release"];
}) {
  return versions.map((version) => {
    const specification = version.mixedAudioSpecs
      ? "MIXED"
      : version.audioBadge
        ? libraryAudioBadgeLabel(version.audioBadge)
        : "规格待读取";
    const relationship =
      version.relationshipStatus === "AUTO_CANDIDATE" && versionCount > 1
        ? "自动候选 · 待确认"
        : version.relationshipStatus === "USER_CONFIRMED"
          ? "人工已确认"
          : "独立版本";
    const completeness =
      version.completeness === "INCOMPLETE"
        ? "曲目不完整"
        : version.completeness === "NEEDS_REVIEW"
          ? "需要复核"
          : "完整";
    const metadataVersion = metadata?.versions.find(
      (candidate) => candidate.versionId === version.id,
    );
    const release = {
      label:
        metadataText(metadataVersion?.fields.label.effectiveValue) ??
        (version.isPrimary ? fallbackRelease?.label : null),
      catalogNumber:
        metadataText(metadataVersion?.fields.catalogNumber.effectiveValue) ??
        (version.isPrimary ? fallbackRelease?.catalogNumber : null),
      barcode:
        metadataText(metadataVersion?.fields.barcode.effectiveValue) ??
        (version.isPrimary ? fallbackRelease?.barcode : null),
      country:
        metadataText(metadataVersion?.fields.country.effectiveValue) ??
        (version.isPrimary ? fallbackRelease?.country : null),
      releaseDate:
        metadataText(metadataVersion?.fields.releaseDate.effectiveValue) ??
        (version.isPrimary ? fallbackRelease?.releaseDate : null),
    };
    const releaseSummary = [
      release.label,
      release.catalogNumber,
      [release.country, release.releaseDate].filter(Boolean).join(" "),
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <div className="version-row" key={version.id}>
        <FileAudio2 />
        <div>
          <strong>{version.isPrimary ? "主版本" : "本地版本"}</strong>
          <span>
            {specification} · {version.trackCount} 首 · {version.fileCount}{" "}
            个文件 · {formatFileSize(version.sizeBytes)}
          </span>
          <small className="version-release-summary">
            {releaseSummary || "发行资料待补充"}
          </small>
          <details className="version-technical-details">
            <summary>文件与识别详情</summary>
            <small>
              {version.sourceRoot ? (
                <>
                  {version.sourceRoot.containerPath}
                  {version.relativePath
                    ? `/${version.relativePath}`
                    : ""} · {version.sourceRoot.readOnly ? "只读" : "托管"}
                </>
              ) : (
                "实体收藏"
              )}
            </small>
            {release.barcode ? <small>条码 · {release.barcode}</small> : null}
            <small>
              {version.sourceVersionCount} 个来源副本 · 已归并{" "}
              {version.duplicateFileCount} 个重复文件
            </small>
            <small>
              {relationship} · {completeness}
            </small>
          </details>
          {version.issues.map((issue) => (
            <small key={`${version.id}-${issue.code}`} className="issue-tag">
              {libraryIssueLabel(issue.code)}
            </small>
          ))}
        </div>
      </div>
    );
  });
}

function metadataText(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

export function AlbumIdentityGovernance({
  album,
  versions,
  canManage,
  working,
  searchResults,
  searchError,
  targetDetail,
  targetError,
  initialTargetId,
  onSearch,
  onSelectTarget,
  onApply,
}: {
  album: AlbumDetail;
  versions: LocalVersionSummary[];
  canManage: boolean;
  working: boolean;
  searchResults: AlbumSummary[];
  searchError?: string | null;
  targetDetail?: AlbumDetail | null;
  targetError?: string | null;
  initialTargetId?: string;
  onSearch: (query: string) => void | Promise<void>;
  onSelectTarget?: (targetId: string) => void | Promise<void>;
  onApply: (command: LibraryIdentityDecisionCommand) => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [targetId, setTargetId] = useState(initialTargetId ?? "");
  const initialTarget = searchResults.find(
    (candidate) => candidate.id === initialTargetId,
  );
  const [mergePrimaryVersionId, setMergePrimaryVersionId] = useState(
    initialTarget?.primaryVersionId ?? "",
  );
  const target = searchResults.find((candidate) => candidate.id === targetId);
  const confirmation =
    "仅修改 COCEAN 数据库中的唱片视图关系，不会移动、改名或删除 NAS 文件；既有投送、实体副本、匹配和介绍仍绑定原本地版本。";
  const confirmAndApply = (
    message: string,
    command: LibraryIdentityDecisionCommand,
  ) => {
    if (window.confirm(`${message}\n\n${confirmation}`)) void onApply(command);
  };
  if (!canManage)
    return (
      <div className="identity-governance-readonly">
        <strong>版本关系为只读</strong>
        <small>
          你可以查看版本关系和记录；只有管理员可以确认、拆分、合并或设置主版本。
        </small>
      </div>
    );
  return (
    <div className="identity-governance" aria-label="版本关系">
      <div className="identity-governance-heading">
        <strong>版本关系</strong>
        <small>{confirmation}</small>
      </div>
      <div className="identity-governance-actions">
        {versions.length > 1 &&
        versions.some(
          (version) => version.relationshipStatus === "AUTO_CANDIDATE",
        ) ? (
          <Button
            variant="secondary"
            disabled={working}
            onClick={() =>
              confirmAndApply(
                "确认这些本地版本属于同一张唱片？",
                buildConfirmIdentityCommand(album),
              )
            }
          >
            确认同一唱片
          </Button>
        ) : null}
        {versions.map((version) =>
          version.isPrimary ? null : (
            <div className="identity-version-action" key={version.id}>
              <span>
                {version.title} · {shortStableId(version.id)}
                <small>
                  {version.relativePath ?? "无本地路径"} ·{" "}
                  {version.audioBadge ?? "规格未知"}
                </small>
              </span>
              <Button
                variant="quiet"
                disabled={working}
                onClick={() =>
                  confirmAndApply(
                    `把“${version.title}”设为新 Listen / 投送主版本？`,
                    buildSetPrimaryIdentityCommand(album, version.id),
                  )
                }
              >
                设为主版本
              </Button>
              {versions.length > 1 ? (
                <Button
                  variant="quiet"
                  disabled={working}
                  onClick={() =>
                    confirmAndApply(
                      `把“${version.title}”拆为独立唱片并保持分开？后续重扫不会自动合并。`,
                      buildSplitIdentityCommand(album, versions, version.id),
                    )
                  }
                >
                  拆出并保持分开
                </Button>
              ) : null}
            </div>
          ),
        )}
      </div>
      <form
        className="identity-merge-search"
        onSubmit={(event) => {
          event.preventDefault();
          void onSearch(query);
        }}
      >
        <label>
          <span>跨唱片合并搜索</span>
          <input
            value={query}
            placeholder="搜索唱片或艺术家"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Button
          type="submit"
          variant="quiet"
          disabled={working || !query.trim()}
        >
          搜索目标
        </Button>
      </form>
      {searchResults.length ? (
        <div className="identity-merge-results">
          <label>
            <span>保留目标唱片 ID</span>
            <select
              value={targetId}
              onChange={(event) => {
                const next = searchResults.find(
                  (candidate) => candidate.id === event.target.value,
                );
                setTargetId(event.target.value);
                setMergePrimaryVersionId(next?.primaryVersionId ?? "");
                void onSelectTarget?.(event.target.value);
              }}
            >
              <option value="">选择合并目标</option>
              {searchResults.map((candidate) => (
                <option value={candidate.id} key={candidate.id}>
                  {candidate.title} · {candidate.albumArtist}
                  {candidate.year ? ` · ${candidate.year}` : ""} ·{" "}
                  {shortStableId(candidate.id)}
                </option>
              ))}
            </select>
          </label>
          {targetError ? <p className="error-row">{targetError}</p> : null}
          {target && targetDetail ? (
            <>
              <label>
                <span>合并后的主版本</span>
                <select
                  value={mergePrimaryVersionId}
                  onChange={(event) =>
                    setMergePrimaryVersionId(event.target.value)
                  }
                >
                  {versions.map((version) => (
                    <option value={version.id} key={`source-${version.id}`}>
                      当前 · {version.title} · {shortStableId(version.id)}
                    </option>
                  ))}
                  {(
                    targetDetail.localVersions ??
                    legacyLocalVersions(targetDetail)
                  ).map((version) => (
                    <option value={version.id} key={`target-${version.id}`}>
                      目标 · {version.title} · {shortStableId(version.id)}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                disabled={working || !mergePrimaryVersionId}
                onClick={() =>
                  confirmAndApply(
                    `把当前唱片合并到“${target.title}”，并保留目标稳定 ID？`,
                    buildMergeIdentityCommand(
                      album,
                      targetDetail,
                      mergePrimaryVersionId,
                    ),
                  )
                }
              >
                合并到目标唱片
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {searchError ? <p className="error-row">{searchError}</p> : null}
    </div>
  );
}

export function buildConfirmIdentityCommand(
  album: AlbumDetail,
  requestId = createBrowserUuid(),
): LibraryIdentityDecisionCommand {
  return {
    type: "CONFIRM",
    requestId,
    revision: album.revision ?? 0,
    ...(album.primaryVersionId
      ? { primaryVersionId: album.primaryVersionId }
      : {}),
  };
}

export function buildSetPrimaryIdentityCommand(
  album: AlbumDetail,
  primaryVersionId: string,
  requestId = createBrowserUuid(),
): LibraryIdentityDecisionCommand {
  return {
    type: "SET_PRIMARY",
    requestId,
    revision: album.revision ?? 0,
    primaryVersionId,
  };
}

export function buildSplitIdentityCommand(
  album: AlbumDetail,
  versions: LocalVersionSummary[],
  separatedVersionId: string,
  requestId = createBrowserUuid(),
): LibraryIdentityDecisionCommand {
  return {
    type: "SPLIT",
    requestId,
    revision: album.revision ?? 0,
    partitions: [
      {
        versionIds: versions
          .filter((version) => version.id !== separatedVersionId)
          .map((version) => version.id),
      },
      { versionIds: [separatedVersionId] },
    ],
  };
}

export function buildMergeIdentityCommand(
  album: AlbumDetail,
  target: AlbumDetail,
  primaryVersionId: string,
  requestId = createBrowserUuid(),
): LibraryIdentityDecisionCommand {
  return {
    type: "MERGE",
    requestId,
    revision: album.revision ?? 0,
    targetLibraryAlbumId: target.id,
    targetRevision: target.revision ?? 0,
    primaryVersionId,
  };
}

function shortStableId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export function createLatestRequestTracker() {
  let generation = 0;
  return {
    begin: () => ++generation,
    isLatest: (candidate: number) => candidate === generation,
    invalidate: () => {
      generation += 1;
    },
  };
}

export function AlbumIdentityHistory({
  decisions,
  error,
  canManage,
  working,
  onUndo,
}: {
  decisions: LibraryIdentityDecision[];
  error?: string | null;
  canManage: boolean;
  working: boolean;
  onUndo: (decision: LibraryIdentityDecision) => void | Promise<void>;
}) {
  const labels: Record<LibraryIdentityDecision["type"], string> = {
    CONFIRM: "确认同一唱片",
    MERGE: "合并唱片",
    SPLIT: "拆分并保持分开",
    SET_PRIMARY: "设置主版本",
    UNDO: "撤销补偿",
  };
  return (
    <section
      className="surface-card identity-history"
      aria-label="版本修改记录"
    >
      <SectionTitle title="版本修改记录" />
      {error ? (
        <p className="error-row">版本修改记录加载失败：{error}</p>
      ) : decisions.length ? (
        decisions.map((decision) => (
          <div className="version-row" key={decision.id}>
            <Clock3 />
            <div>
              <strong>{labels[decision.type]}</strong>
              <span>{decision.actor.displayName}</span>
              <small>{formatDeliveryTime(decision.createdAt)}</small>
              <small>{identityDecisionSummary(decision)}</small>
            </div>
            {canManage && decision.canUndo ? (
              <Button
                variant="quiet"
                disabled={working}
                onClick={() => void onUndo(decision)}
              >
                撤销
              </Button>
            ) : null}
          </div>
        ))
      ) : (
        <p className="quiet-row">
          尚无人工修改；系统不会自动确认有疑问的版本。
        </p>
      )}
    </section>
  );
}

function identityDecisionSummary(decision: LibraryIdentityDecision): string {
  if (decision.type === "MERGE")
    return `目标 ${shortStableId(decision.details.targetLibraryAlbumId ?? "未知")} · 主版本 ${shortStableId(decision.details.primaryVersionId ?? "未知")}`;
  if (decision.type === "SPLIT")
    return `拆为 ${decision.details.partitions.length} 组 · ${decision.details.partitions.map((partition) => partition.versionIds.map(shortStableId).join("+")).join(" / ")}`;
  if (decision.type === "SET_PRIMARY" || decision.type === "CONFIRM")
    return decision.details.primaryVersionId
      ? `主版本 ${shortStableId(decision.details.primaryVersionId)}`
      : "保留当前主版本";
  return `补偿决定 ${shortStableId(decision.details.compensatedDecisionId ?? "未知")}`;
}

export function AlbumIntegrityIssues({
  issues,
}: {
  issues: NonNullable<AlbumDetail["issues"]>;
}) {
  if (!issues.length) return null;
  return (
    <section className="album-structure-issues" aria-label="唱片完整性问题">
      <div>
        <strong>唱片完整性问题</strong>
        <span>来自本地版本、曲目结构与封面事实的确定性证据</span>
      </div>
      <div className="issue-labels">
        {issues.map((issue, index) => (
          <span
            className="issue-tag"
            key={`${issue.code}-${issue.versionId ?? "group"}-${index}`}
          >
            {libraryIssueLabel(issue.code)}
            {issue.versionId
              ? ` · 版本 ${issue.versionId}`
              : " · 唱片组"} · {libraryIssueEvidence(issue.evidence)}
          </span>
        ))}
      </div>
    </section>
  );
}

function libraryIssueEvidence(evidence: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof evidence.versionCount === "number")
    parts.push(`${evidence.versionCount} 个本地版本`);
  if (evidence.basis === "NORMALIZED_TITLE_ARTIST")
    parts.push("规范化标题与艺术家相同");
  if (typeof evidence.width === "number" || typeof evidence.height === "number")
    parts.push(`封面 ${evidence.width ?? "?"}×${evidence.height ?? "?"}`);
  if (
    typeof evidence.expected === "number" ||
    typeof evidence.actual === "number"
  )
    parts.push(
      `预期 ${evidence.expected ?? "?"} / 实际 ${evidence.actual ?? "?"}`,
    );
  if (
    Array.isArray(evidence.aggregationIssues) &&
    evidence.aggregationIssues.length
  ) {
    const facts = evidence.aggregationIssues.map((entry) => {
      const issue = entry as Record<string, unknown>;
      return `${String(issue.code ?? "结构异常")}${issue.expected != null || issue.actual != null ? `（预期 ${issue.expected ?? "?"} / 实际 ${issue.actual ?? "?"}）` : ""}`;
    });
    parts.push(facts.join("、"));
  }
  return parts.join("；") || "查看本地版本证据";
}

export function legacyLocalVersions(item: AlbumDetail): LocalVersionSummary[] {
  if (!item.hasDigital) return [];
  return [
    {
      id: item.primaryVersionId ?? item.id,
      title: item.title,
      albumArtist: item.albumArtist,
      year: item.year,
      isPrimary: true,
      relationshipStatus: "AUTO_CANDIDATE",
      sourceRoot: item.sourceRoot,
      relativePath: item.tracks[0]?.relativePath ?? null,
      audioBadge: item.audioBadge,
      mixedAudioSpecs: item.mixedAudioSpecs,
      trackCount: item.trackCount,
      fileCount: item.trackCount + (item.duplicateFileCount ?? 0),
      sourceVersionCount: item.sourceVersionCount ?? 1,
      duplicateFileCount: item.duplicateFileCount ?? 0,
      sizeBytes: item.tracks.reduce(
        (total, track) => total + track.sizeBytes,
        0,
      ),
      completeness:
        item.matchStatus === "TRACKS_INCOMPLETE" ? "INCOMPLETE" : "COMPLETE",
      issues: [],
    },
  ];
}

function isFtpTarget(target: DeliveryTarget) {
  return (
    ["AK_FILE_DROP", "FTP"].includes(target.transport) ||
    target.location.toLocaleLowerCase("en-US").startsWith("ftp://")
  );
}

function deliveryTargetTransportLabel(target: DeliveryTarget) {
  if (isFtpTarget(target)) return "AK File Drop · FTP";
  return deliveryTransportLabel(target.transport);
}

function deliveryTransportLabel(value: string) {
  return (
    (
      {
        AK_FILE_DROP: "AK File Drop · FTP",
        FTP: "FTP",
        USB_MOUNT: "U 盘挂载",
        SMB: "SMB",
        SFTP: "SFTP",
        OTHER: "其他",
      } as Record<string, string>
    )[value] ?? value
  );
}

function deliveryStatusLabel(value: string, verified = false) {
  if (value === "COMPLETED" && !verified) return "完成但校验失败";
  return (
    (
      {
        QUEUED: "等待投送",
        RUNNING: "投送中",
        COMPLETED: "投送完成",
        FAILED: "投送失败",
        CANCELLED: "已取消",
      } as Record<string, string>
    )[value] ?? value
  );
}

export function AlbumDeliveryRecord({ job }: { job: DeliveryJob }) {
  return (
    <div className="version-row">
      <span className="record-icon">
        {job.status === "COMPLETED" && job.verified ? (
          <ShieldCheck />
        ) : (
          <Clock3 />
        )}
      </span>
      <div className="delivery-history-content">
        <strong>{job.targetName}</strong>
        <span>
          {deliveryStatusLabel(job.status, job.verified)} ·{" "}
          {deliveryTransportLabel(job.transport)}
          {job.fileCount
            ? ` · ${job.completedFileCount}/${job.fileCount} 个文件`
            : ""}
        </span>
        <small>
          {formatDeliveryTime(job.finishedAt ?? job.createdAt)}
          {job.verified ? " · 已校验" : ""}
          {job.error ? ` · ${job.error}` : ""}
        </small>
        <DeliveryProgress job={job} />
      </div>
    </div>
  );
}

function DeliveryProgress({
  job,
}: {
  job: {
    status: string;
    totalBytes: number;
    transferredBytes: number;
  };
}) {
  const max = Math.max(job.totalBytes, 1);
  const value = Math.min(job.transferredBytes, max);
  const percent = job.totalBytes
    ? Math.min(100, Math.round((job.transferredBytes / job.totalBytes) * 100))
    : job.status === "COMPLETED"
      ? 100
      : 0;
  return (
    <div className="delivery-progress">
      <progress value={value} max={max} aria-label={`投送进度 ${percent}%`} />
      <small>
        {percent}% · {formatDeliveryBytes(job.transferredBytes)} /{" "}
        {formatDeliveryBytes(job.totalBytes)}
      </small>
    </div>
  );
}

function formatDeliveryBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  const amount = value / 1024 ** index;
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatDeliveryTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
