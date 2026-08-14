import {
  formatFullAudioSpec,
  type AlbumDetail,
  type AlbumMetadataEvent,
  type AlbumSummary,
  type DeliveryJob,
  type DeliveryTarget,
  type LibraryIdentityDecision,
  type LibraryIdentityDecisionCommand,
  type LocalVersionSummary,
  type MetadataCommand,
  type MetadataField,
  type MetadataFieldState,
  type PhysicalMedium,
} from "@cocean/contracts";
import {
  ChevronRight,
  Clock3,
  FileAudio2,
  Pause,
  Play,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
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
  const capabilities = useAsync(() => api.capabilities(), []);
  const [listeningTrackId, setListeningTrackId] = useState<string | null>(null);
  const [deliveryTargetId, setDeliveryTargetId] = useState("");
  const [delivering, setDelivering] = useState(false);
  const [generatingIntroduction, setGeneratingIntroduction] = useState(false);
  const [copyFormOpen, setCopyFormOpen] = useState(false);
  const [identityWorking, setIdentityWorking] = useState(false);
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
  const modelStatusTone = generatingIntroduction
    ? "is-working"
    : modelReady
      ? "is-ready"
      : modelCapability?.verificationStatus === "FAILED"
        ? "is-failed"
        : "is-idle";
  const modelStatusTitle = generatingIntroduction
    ? "模型正在整理本地专辑事实"
    : modelReady
      ? `模型已就绪${modelCapability?.model ? ` · ${modelCapability.model}` : ""}`
      : !modelConfigured
        ? "可借助模型生成专辑介绍"
        : !modelCapability?.enabled
          ? "模型连接已保存，但尚未启用"
          : "模型连接尚未验证";
  const modelStatusDetail = modelReady
    ? "介绍只使用本地标题、艺术家、年份、厂牌与曲目，不参与发行核验。"
    : "前往设置完成连接验证与启用；模型不会修改标签，也不会参与发行定版。";
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
          <p className="eyebrow">ALBUM</p>
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
                  <small>
                    由 {introduction.data.model} 基于本地专辑事实生成 ·
                    不作为发行核验
                  </small>
                </>
              ) : (
                <p>
                  {item.trackCount} 首曲目 · {item.discCount} Disc
                  {item.release.label ? ` · ${item.release.label}` : ""}
                </p>
              )}
            </div>
            {canManage ? (
              <div className="model-assist-bar">
                <span
                  className={`model-breath-dot ${modelStatusTone}`}
                  aria-hidden="true"
                />
                <div>
                  <strong>{modelStatusTitle}</strong>
                  <small>{modelStatusDetail}</small>
                </div>
                {modelReady ? (
                  <Button
                    variant="secondary"
                    disabled={generatingIntroduction}
                    onClick={() => void generateIntroduction()}
                  >
                    <Sparkles />
                    {generatingIntroduction
                      ? "正在生成"
                      : introduction.data
                        ? "重新生成"
                        : "生成介绍"}
                  </Button>
                ) : (
                  <Link
                    className="button secondary model-setup-link"
                    to="/settings#settings-assist"
                  >
                    {modelConfigured ? "检查模型" : "开通模型"}
                  </Link>
                )}
              </div>
            ) : null}
          </div>
          <div className="hero-actions">
            <Button disabled={!item.tracks.length} onClick={() => listen()}>
              {listeningTrack ? <Pause /> : <Play />} Listen
            </Button>
            <Link className="button secondary" to={`/albums/${item.id}/match`}>
              信息匹配
            </Link>
            {canManage && item.hasDigital && enabledTargets.length ? (
              <>
                <select
                  className="delivery-target-select"
                  aria-label="选择投送目标"
                  value={deliveryTargetId}
                  onChange={(event) => setDeliveryTargetId(event.target.value)}
                >
                  {enabledTargets.map((target) => (
                    <option value={target.id} key={target.id}>
                      {target.name} · {deliveryTargetTransportLabel(target)}
                      {isFtpTarget(target) && !target.credentialConfigured
                        ? " · 待凭据"
                        : ""}
                    </option>
                  ))}
                </select>
                <Button
                  disabled={delivering || selectedTargetNeedsCredential}
                  onClick={() => void deliver()}
                >
                  <Send /> {delivering ? "正在创建" : "投送专辑"}
                </Button>
                {selectedTargetNeedsCredential ? (
                  <Link className="text-link" to="/systems">
                    补录 FTP 凭据
                  </Link>
                ) : null}
              </>
            ) : canManage && item.hasDigital ? (
              <Link className="button secondary" to="/systems">
                <Send /> 配置投送
              </Link>
            ) : null}
          </div>
        </div>
        <aside className="release-card">
          <h2>发行信息</h2>
          <Fact label="厂牌" value={item.release.label} />
          <Fact label="目录号" value={item.release.catalogNumber} />
          <Fact label="条码" value={item.release.barcode} />
          <Fact
            label="地区 / 日期"
            value={
              [item.release.country, item.release.releaseDate]
                .filter(Boolean)
                .join(" · ") || null
            }
          />
          <span className="source-status">
            <ShieldCheck /> {statusLabel(item.matchStatus)}
          </span>
          <small className="release-proof-note">
            来自文件标签、外部候选与人工确认；大模型不参与定版。
          </small>
        </aside>
      </section>

      {item.metadata ? (
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
      ) : null}

      <div className="detail-grid">
        <section className="surface-card owned-versions">
          <SectionTitle title="我的版本" />
          <AlbumLocalVersions
            versions={localVersions}
            versionCount={item.versionCount ?? 1}
          />
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
        </section>
        <section className="surface-card delivery-history-card">
          <SectionTitle title="投送记录" />
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
        </section>
      </div>

      <AlbumIdentityHistory
        decisions={identityHistory.data ?? []}
        error={identityHistory.error?.message ?? null}
        canManage={canManage}
        working={identityWorking}
        onUndo={undoIdentityDecision}
      />

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

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="fact-row">
      <span>{label}</span>
      <strong>{value ?? "待确认"}</strong>
    </div>
  );
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
      aria-label="元数据治理"
    >
      <SectionTitle
        title="元数据"
        meta={`revision ${metadata.metadataRevision} · ${canManage ? "管理员可编辑" : "只读"}`}
      />
      <p className="quiet-row">
        有效值按人工覆盖、外部确认、扫描标签、路径回退依次解析；操作仅修改
        COCEAN 数据库，不改 NAS 文件。
      </p>
      <h3>唱片级字段</h3>
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
      {metadata.versions.map((version) => (
        <div key={version.versionId} className="metadata-version-group">
          <h3>版本级字段 · {shortStableId(version.versionId)}</h3>
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
          成员与 Demo 可以查看来源和历史；编辑、清空、恢复与撤销仅对管理员开放。
        </p>
      )}
      <div className="metadata-history">
        <h3>最近元数据历史</h3>
        {historyError ? <p className="error-row">{historyError}</p> : null}
        {history.map((event) => (
          <div className="version-row" key={event.id}>
            <Clock3 />
            <div>
              <strong>{metadataEventLabel(event.type)}</strong>
              <span>
                {event.actor.displayName} · {metadataEventCommands(event)} ·
                revision {event.resultingMetadataRevision}
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
function statusLabel(status: string) {
  return (
    (
      {
        UNMATCHED: "未匹配",
        NEEDS_REVIEW: "待人工确认",
        SOURCE_MATCHED: "文件含来源标识",
        USER_CONFIRMED: "人工已确认",
        TRACKS_INCOMPLETE: "曲目不完整",
      } as Record<string, string>
    )[status] ?? status
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
}: {
  versions: LocalVersionSummary[];
  versionCount: number;
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
    return (
      <div className="version-row" key={version.id}>
        <FileAudio2 />
        <div>
          <strong>{version.isPrimary ? "主版本" : "本地版本"}</strong>
          <span>
            {specification} · {version.trackCount} 首 · {version.fileCount}{" "}
            个文件 · {formatFileSize(version.sizeBytes)}
          </span>
          <small>
            {version.sourceRoot ? (
              <>
                {version.sourceRoot.containerPath}
                {version.relativePath ? `/${version.relativePath}` : ""} ·{" "}
                {version.sourceRoot.readOnly ? "只读" : "托管"}
              </>
            ) : (
              "实体收藏"
            )}
          </small>
          <small>
            {version.sourceVersionCount} 个来源副本 · 折叠{" "}
            {version.duplicateFileCount} 个重复文件
          </small>
          <small>
            {relationship} · {completeness}
          </small>
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
        <strong>身份治理为只读</strong>
        <small>
          成员可以查看人工关系和历史；只有管理员可以确认、拆分、合并或设置主版本。
        </small>
      </div>
    );
  return (
    <div className="identity-governance" aria-label="唱片身份治理">
      <div className="identity-governance-heading">
        <strong>身份治理</strong>
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
    <section className="surface-card identity-history" aria-label="身份历史">
      <SectionTitle title="身份历史" />
      {error ? (
        <p className="error-row">身份历史加载失败：{error}</p>
      ) : decisions.length ? (
        decisions.map((decision) => (
          <div className="version-row" key={decision.id}>
            <Clock3 />
            <div>
              <strong>{labels[decision.type]}</strong>
              <span>
                {decision.actor.displayName} · revision{" "}
                {decision.resultingRevision}
              </span>
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
        <p className="quiet-row">尚无人工身份决定；自动候选不会被静默确认。</p>
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
