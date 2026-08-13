import type {
  AlbumSummary,
  CatalogRecommendationAlbum,
  TrackSummary,
} from "@cocean/contracts";
import { ArrowRight, CheckCircle2, CircleAlert, ScanLine } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
} from "../components.js";
import { useAsync, useToast } from "../hooks.js";
import {
  initialCatalogListenAvailability,
  listenAvailabilityDetail,
  listenButtonLabel,
  resolveCatalogListenAvailability,
  type CatalogListenAvailability,
} from "../media-ui.js";
import {
  catalogSourceUrl,
  domainLabel,
  featureLabel,
  localDayKey,
} from "../recommendation-ui.js";

export function HomePage() {
  const dayKey = localDayKey();
  const recommendation = useAsync(
    () => api.todayRecommendation(dayKey),
    [dayKey],
  );
  const stats = useAsync(() => api.stats(), []);
  const scans = useAsync(() => api.scans(), []);
  const [playing, setPlaying] = useState<{
    album: AlbumSummary;
    track: TrackSummary;
  } | null>(null);
  const [externalPreview, setExternalPreview] = useState<{
    title: string;
    artist: string;
    url: string;
  } | null>(null);
  const [listenAvailability, setListenAvailability] =
    useState<CatalogListenAvailability>({ kind: "NO_LOCAL" });
  const toast = useToast();
  const item = recommendation.data?.primary ?? null;
  const hasActiveScan = Boolean(
    scans.data?.some((scan) => ["QUEUED", "RUNNING"].includes(scan.status)),
  );

  useEffect(() => {
    if (!hasActiveScan) return;
    const timer = window.setInterval(() => void scans.reload(), 2_000);
    return () => window.clearInterval(timer);
  }, [hasActiveScan, scans.reload]);

  useEffect(() => {
    let active = true;
    setPlaying(null);
    setExternalPreview(null);
    if (!item) {
      setListenAvailability({ kind: "NO_LOCAL" });
      return () => {
        active = false;
      };
    }

    setListenAvailability(initialCatalogListenAvailability(item));
    void resolveCatalogListenAvailability(item, api.album).then(
      (availability) => {
        if (active) setListenAvailability(availability);
      },
    );
    return () => {
      active = false;
    };
  }, [item]);

  const listen = () => {
    if (listenAvailability.kind === "READY") {
      setExternalPreview(null);
      setPlaying({
        album: listenAvailability.album,
        track: listenAvailability.track,
      });
      return;
    }
    if (item?.external?.previewUrl) {
      setPlaying(null);
      setExternalPreview({
        title: item.title,
        artist: item.artist,
        url: item.external.previewUrl,
      });
    }
  };

  return (
    <div className="page home-page">
      <PageHeader
        title="今天"
        subtitle={new Intl.DateTimeFormat("zh-CN", {
          month: "long",
          day: "numeric",
          weekday: "long",
        }).format(new Date())}
        action={<span className="status-pill">本地 NAS</span>}
      />
      {recommendation.error ? (
        <EmptyState
          title="Still 精选目录尚未就绪"
          detail={recommendation.error.message}
          action={
            <Link className="button primary" to="/settings#settings-catalog">
              检查目录
            </Link>
          }
        />
      ) : item ? (
        <section className="home-hero">
          <AlbumArtwork album={artworkAlbum(item)} size="hero" />
          <div className="home-hero-copy">
            <div>
              <p className="eyebrow">STILL CATALOG · DAILY ROTATION</p>
              <h2>{item.title}</h2>
              <p className="album-meta">{item.artist}</p>
            </div>
            <div className="tag-row">
              {item.localAlbum ? (
                <AudioSpecBadge
                  label={
                    item.localAlbum.mixedAudioSpecs
                      ? "混合规格"
                      : item.localAlbum.audioBadge
                  }
                />
              ) : null}
              {item.localAlbum?.physicalMedia.map((medium) => (
                <MediaTag key={medium} medium={medium} />
              ))}
              {item.domains.slice(0, 2).map((domain) => (
                <span className="catalog-tag" key={domain}>
                  {domainLabel(domain)}
                </span>
              ))}
            </div>
            <div className="editorial">
              <p className="eyebrow">WHY TODAY</p>
              <p>
                来自已核验 Still 目录{" "}
                {recommendation.data?.sourceContentVersion}{" "}
                的每日轮换。结果由目录版本与日期确定，可重复验证；没有推断你的心情或播放次数。
              </p>
              {item.features.length ? (
                <small>
                  目录特征：
                  {item.features.slice(0, 3).map(featureLabel).join(" · ")}
                </small>
              ) : null}
            </div>
            <div className="hero-actions">
              <Button
                disabled={
                  listenAvailability.kind !== "READY" &&
                  !item.external?.previewUrl
                }
                onClick={listen}
              >
                {listenAvailability.kind === "READY"
                  ? listenButtonLabel(listenAvailability)
                  : item.external?.previewUrl
                    ? `试听 ${item.external.previewSeconds ?? 30} 秒`
                    : listenButtonLabel(listenAvailability)}
              </Button>
              {item.localAlbum ? (
                <Link
                  className="button secondary"
                  to={`/albums/${item.localAlbum.id}`}
                >
                  打开详情
                </Link>
              ) : (
                sourceLink(item.external?.url ?? item.sourceRef)
              )}
              {item.localAlbum && item.external?.url
                ? sourceLink(item.external.url)
                : null}
            </div>
            <p className="listen-availability-note" role="status">
              {listenAvailability.kind !== "READY" && item.external?.previewUrl
                ? "本地没有数字文件；可播放 Apple Music 提供的试听片段，完整播放需在 Apple Music 打开。"
                : listenAvailabilityDetail(listenAvailability)}
            </p>
            {playing ? (
              <InlinePlayer
                album={playing.album}
                track={playing.track}
                onError={() =>
                  toast.show(
                    "浏览器无法播放此格式；本地文件与音频规格仍可正常核验",
                  )
                }
              />
            ) : null}
            {externalPreview ? (
              <ExternalPreviewPlayer {...externalPreview} />
            ) : null}
            {item.external?.provider === "APPLE_MUSIC" ? (
              <small className="provider-attribution">
                试听与封面由 Apple Music 提供 · 完整播放需 Apple Music 授权
              </small>
            ) : null}
            <p className="compatibility-note">
              正式 Still v0.10 推荐等待 Accepted Runtime
              Snapshot；当前页面不会把兼容目录轮换标成正式 v0.10 结果。
            </p>
          </div>
        </section>
      ) : recommendation.loading ? (
        <div className="hero-skeleton" />
      ) : (
        <EmptyState
          title="Still 目录没有可展示记录"
          detail="检查目录版本、记录数与加载错误。"
        />
      )}

      <section className="dashboard-section">
        <SectionTitle title="需要处理" meta="只显示需要行动的项目" />
        <div className="metric-grid">
          <Metric
            icon={<CircleAlert />}
            value={stats.data?.needsReview ?? 0}
            label="待确认"
          />
          <Metric
            icon={<ScanLine />}
            value={stats.data?.missingArtwork ?? 0}
            label="封面问题"
          />
          <Metric
            icon={<CircleAlert />}
            value={stats.data?.parseFailures ?? 0}
            label="未入库"
          />
          <Metric
            icon={<CheckCircle2 />}
            value={stats.data?.albums ?? 0}
            label="唱片"
            quiet
          />
        </div>
      </section>

      <section className="dashboard-section">
        <SectionTitle title="进行中" meta="真实 Music 扫描任务" />
        <div className="task-list compact">
          {(scans.data ?? []).slice(0, 3).map((scan) => (
            <TaskSummary
              key={scan.id}
              name="Music 目录扫描"
              state={scan.status}
              progress={
                scan.totalFiles ? scan.processedFiles / scan.totalFiles : 0
              }
            />
          ))}
          {!scans.loading && !scans.data?.length ? (
            <div className="quiet-row">
              <span>当前没有任务</span>
              <Link to="/tasks">
                查看任务 <ArrowRight />
              </Link>
            </div>
          ) : null}
        </div>
      </section>
      <Toast message={toast.message} />
    </div>
  );
}

function InlinePlayer({
  album,
  track,
  onError,
}: {
  album: AlbumSummary;
  track: TrackSummary;
  onError: () => void;
}) {
  const isDsd = track.audioSpec.kind === "DSD";
  return (
    <div className="inline-listen">
      <div>
        <strong>{album.title}</strong>
        <span>
          {track.title}
          {isDsd ? " · 服务器实时转为 PCM FLAC；源 DSD 不修改" : ""}
        </span>
      </div>
      <audio
        key={track.id}
        src={api.listenUrl(track.id)}
        controls
        autoPlay
        preload="metadata"
        onError={onError}
      />
    </div>
  );
}

function ExternalPreviewPlayer({
  title,
  artist,
  url,
}: {
  title: string;
  artist: string;
  url: string;
}) {
  return (
    <div className="inline-listen external-preview">
      <div>
        <strong>{title}</strong>
        <span>{artist} · Apple Music 试听</span>
      </div>
      <audio key={url} src={url} controls autoPlay preload="metadata" />
    </div>
  );
}

function artworkAlbum(
  item: CatalogRecommendationAlbum,
): Pick<AlbumSummary, "id" | "title" | "artwork"> {
  return item.localAlbum?.artwork.url
    ? item.localAlbum
    : {
        id: item.stillAlbumId,
        title: item.title,
        artwork: {
          source: item.external?.artworkUrl ? "REPRESENTATIVE" : "NONE",
          url: item.external?.artworkUrl ?? null,
          mimeType: null,
          width: null,
          height: null,
        },
      };
}

function sourceLink(value: string) {
  const url = catalogSourceUrl(value);
  return url ? (
    <a className="button secondary" href={url} target="_blank" rel="noreferrer">
      {url.includes("music.apple.com") ? "在 Apple Music 打开" : "查看目录来源"}
    </a>
  ) : (
    <span className="source-ref">目录来源已记录</span>
  );
}

function Metric({
  icon,
  value,
  label,
  quiet,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
  quiet?: boolean;
}) {
  return (
    <div className={`metric-card${quiet ? " quiet" : ""}`}>
      <span>{icon}</span>
      <strong>{value.toLocaleString()}</strong>
      <small>{label}</small>
    </div>
  );
}

function TaskSummary({
  name,
  state,
  progress,
}: {
  name: string;
  state: string;
  progress: number;
}) {
  return (
    <div className="task-summary">
      <div>
        <strong>{name}</strong>
        <span>{stateLabel(state)}</span>
      </div>
      <progress value={progress} max={1} />
    </div>
  );
}

function stateLabel(state: string) {
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
    )[state] ?? state
  );
}
