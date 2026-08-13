import {
  formatFullAudioSpec,
  type AlbumDetail,
  type DeliveryJob,
  type DeliveryTarget,
  type LocalVersionSummary,
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
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
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
  const [searchParams] = useSearchParams();
  const libraryReturnTo = safeLibraryReturn(searchParams.get("from"));
  const album = useAsync(() => api.album(id), [id]);
  const deliveryTargets = useAsync(() => api.deliveryTargets(), []);
  const deliveries = useAsync(() => api.albumDeliveries(id), [id]);
  const introduction = useAsync(() => api.albumIntroduction(id), [id]);
  const capabilities = useAsync(() => api.capabilities(), []);
  const [listeningTrackId, setListeningTrackId] = useState<string | null>(null);
  const [deliveryTargetId, setDeliveryTargetId] = useState("");
  const [delivering, setDelivering] = useState(false);
  const [generatingIntroduction, setGeneratingIntroduction] = useState(false);
  const [copyFormOpen, setCopyFormOpen] = useState(false);
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

      <div className="detail-grid">
        <section className="surface-card owned-versions">
          <SectionTitle title="我的版本" />
          <AlbumLocalVersions
            versions={localVersions}
            versionCount={item.versionCount ?? 1}
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
