import type {
  AlbumSummary,
  CatalogRecommendationAlbum,
  RecommendationCriterion,
  TrackSummary,
} from "@cocean/contracts";
import { ExternalLink, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import {
  AlbumArtwork,
  AudioSpecBadge,
  Button,
  EmptyState,
  FilterPill,
  MediaTag,
  PageHeader,
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
import { catalogSourceUrl, featureLabel } from "../recommendation-ui.js";

const defaultPrompt = "想听一张适合深夜、安静但不冷的 90 年代女声专辑";

export function DiscoverPage() {
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [submitted, setSubmitted] = useState(defaultPrompt);
  const result = useAsync(
    () => api.discoverRecommendations(submitted),
    [submitted],
  );
  const [playing, setPlaying] = useState<{
    album: AlbumSummary;
    track: TrackSummary;
  } | null>(null);
  const [externalPreview, setExternalPreview] = useState<{
    title: string;
    artist: string;
    url: string;
  } | null>(null);
  const [listenAvailability, setListenAvailability] = useState<
    Record<string, CatalogListenAvailability>
  >({});
  const toast = useToast();
  const primary = result.data?.primary ?? null;
  const resultItems = result.data?.items;

  useEffect(() => {
    let active = true;
    const items = resultItems ?? [];
    const initial = Object.fromEntries(
      items.map((item) => [
        item.stillAlbumId,
        initialCatalogListenAvailability(item),
      ]),
    ) as Record<string, CatalogListenAvailability>;
    setPlaying(null);
    setExternalPreview(null);
    setListenAvailability(initial);

    for (const item of items) {
      if (initial[item.stillAlbumId]?.kind !== "CHECKING") continue;
      void resolveCatalogListenAvailability(item, api.album).then(
        (availability) => {
          if (!active) return;
          setListenAvailability((current) => ({
            ...current,
            [item.stillAlbumId]: availability,
          }));
        },
      );
    }
    return () => {
      active = false;
    };
  }, [resultItems]);

  const listen = (availability: CatalogListenAvailability) => {
    if (availability.kind !== "READY") return;
    setExternalPreview(null);
    setPlaying({ album: availability.album, track: availability.track });
  };

  const preview = (item: CatalogRecommendationAlbum) => {
    if (!item.external?.previewUrl) return;
    setPlaying(null);
    setExternalPreview({
      title: item.title,
      artist: item.artist,
      url: item.external.previewUrl,
    });
  };

  return (
    <div className="page discover-page">
      <PageHeader
        title="找歌"
        subtitle="把听感描述映射到 Still 目录中真实存在的标签"
        action={<span className="status-pill">Still 精选 · 兼容目录</span>}
      />
      <section className="query-card surface-card">
        <div className="section-heading-inline">
          <h2>描述你现在想听什么</h2>
          <span className="status-pill">确定性检索 · 0 次模型调用</span>
        </div>
        <form
          className="query-input"
          onSubmit={(event) => {
            event.preventDefault();
            setPlaying(null);
            setExternalPreview(null);
            setListenAvailability({});
            setSubmitted(prompt.trim());
          }}
        >
          <Search aria-hidden="true" />
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            aria-label="找歌描述"
            maxLength={500}
          />
          <Button type="submit">寻找 Album</Button>
        </form>
        <div className="extracted-row">
          <span>实际采用</span>
          {(result.data?.query.supportedCriteria ?? []).map((criterion) => (
            <FilterPill active key={criterion.id}>
              {criterion.label}
            </FilterPill>
          ))}
          {!result.loading && !result.data?.query.supportedCriteria.length ? (
            <small>没有识别到可由当前目录证明的条件</small>
          ) : null}
        </div>
      </section>

      <div className="discover-layout">
        <aside className="surface-card filter-panel">
          <div className="section-heading-inline">
            <h2>条件边界</h2>
            <button
              onClick={() => {
                setPrompt("");
                setSubmitted("");
              }}
            >
              浏览全部
            </button>
          </div>
          {(result.data?.query.supportedCriteria ?? []).map((criterion) => (
            <CriterionRow key={criterion.id} criterion={criterion} />
          ))}
          {result.data?.query.unsupportedTerms.length ? (
            <div className="unsupported-criteria">
              <small>当前目录没有这些事实</small>
              {result.data.query.unsupportedTerms.map((term) => (
                <span key={term}>{term}</span>
              ))}
              <p>它们没有参与排序，也不会由歌手姓名或模型猜测。</p>
            </div>
          ) : null}
          <div className="boundary-note">
            <strong>模型是可选增强，不是事实来源</strong>
            <span>
              当前排序只用版本化 Still 目录的
              domains/features；模型配置用于专辑介绍，不参与发行事实裁决。
            </span>
          </div>
          <div className="provider-note">
            <small>外部试听</small>
            <span>
              Apple Music 提供封面与试听片段；Qobuz 正式合作接口尚未接入。
            </span>
          </div>
        </aside>
        <section className="recommendations">
          <div className="section-heading-inline">
            <div>
              <h2>目录结果</h2>
              <span>
                {result.data
                  ? `${result.data.items.length} 张 · ${result.data.sourceContentVersion}`
                  : "等待查询"}
              </span>
            </div>
            <span>只显示可说明的依据</span>
          </div>
          {result.error ? (
            <EmptyState
              title="Still 精选目录不可用"
              detail={result.error.message}
              action={
                <Link
                  className="button secondary"
                  to="/settings#settings-catalog"
                >
                  检查目录
                </Link>
              }
            />
          ) : result.loading ? (
            <div className="discover-loading">正在检索版本化目录…</div>
          ) : result.data?.items.length ? (
            <div className="discover-albums">
              {result.data.items.map((item) => (
                <CatalogResultCard
                  key={item.stillAlbumId}
                  item={item}
                  availability={
                    listenAvailability[item.stillAlbumId] ??
                    initialCatalogListenAvailability(item)
                  }
                  onListen={listen}
                  onPreview={preview}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              title="没有可证明匹配的 Album"
              detail="尝试输入古典、爵士、温暖、暗色、柔和、留白、开阔、稳定或完整专辑等当前目录具备的条件。"
            />
          )}
          {primary ? <WhyCard item={primary} /> : null}
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
            <div className="inline-listen external-preview">
              <div>
                <strong>{externalPreview.title}</strong>
                <span>{externalPreview.artist} · Apple Music 试听</span>
              </div>
              <audio
                key={externalPreview.url}
                src={externalPreview.url}
                controls
                autoPlay
                preload="metadata"
              />
            </div>
          ) : null}
          {result.data ? (
            <div className="compatibility-banner">
              <strong>推荐运行时边界</strong>
              <span>
                正式 Still v0.10：等待 Accepted Runtime
                Snapshot。当前结果是已核验目录的兼容检索，不显示伪造分数。
              </span>
            </div>
          ) : null}
        </section>
      </div>
      <Toast message={toast.message} />
    </div>
  );
}

function CatalogResultCard({
  item,
  availability,
  onListen,
  onPreview,
}: {
  item: CatalogRecommendationAlbum;
  availability: CatalogListenAvailability;
  onListen: (availability: CatalogListenAvailability) => void;
  onPreview: (item: CatalogRecommendationAlbum) => void;
}) {
  const local = item.localAlbum;
  return (
    <article className="catalog-result-card">
      <div className="album-card-art">
        <AlbumArtwork album={artworkAlbum(item)} />
        <AudioSpecBadge
          label={
            local?.mixedAudioSpecs ? "混合规格" : (local?.audioBadge ?? null)
          }
        />
      </div>
      <div className="catalog-result-copy">
        <h3>{item.title}</h3>
        <p>{item.artist}</p>
        <div className="tag-row">
          {local?.physicalMedia.map((medium) => (
            <MediaTag key={medium} medium={medium} />
          ))}
          {item.matchedCriteria.slice(0, 2).map((criterion) => (
            <span className="catalog-tag" key={criterion.id}>
              {criterion.label}
            </span>
          ))}
        </div>
        <small>
          {local
            ? local.hasDigital
              ? "本地数字文件可用"
              : "本地仅有实体记录"
            : "本地唱片库未匹配"}
        </small>
      </div>
      <div className="catalog-result-actions">
        <Button
          disabled={availability.kind !== "READY" && !item.external?.previewUrl}
          onClick={() =>
            availability.kind === "READY"
              ? onListen(availability)
              : onPreview(item)
          }
        >
          {availability.kind === "READY"
            ? listenButtonLabel(availability)
            : item.external?.previewUrl
              ? `试听 ${item.external.previewSeconds ?? 30} 秒`
              : listenButtonLabel(availability)}
        </Button>
        {local ? (
          <Link className="button secondary" to={`/albums/${local.id}`}>
            详情
          </Link>
        ) : (
          sourceButton(item.external?.url ?? item.sourceRef)
        )}
        {local && item.external?.url ? sourceButton(item.external.url) : null}
      </div>
      <small className="listen-availability-note" role="status">
        {availability.kind !== "READY" && item.external?.previewUrl
          ? "本地未匹配；可试听片段，完整播放请在 Apple Music 打开。"
          : listenAvailabilityDetail(availability)}
      </small>
      {item.external?.provider === "APPLE_MUSIC" ? (
        <small className="provider-attribution">
          封面与试听由 Apple Music 提供
        </small>
      ) : null}
    </article>
  );
}

function WhyCard({ item }: { item: CatalogRecommendationAlbum }) {
  const reasons = item.matchedCriteria.length
    ? item.matchedCriteria
    : [
        {
          id: "catalog.identity",
          label: "标题或艺术家文本",
          kind: "TEXT",
          catalogValue: "identity",
        } as const,
      ];
  return (
    <section className="surface-card why-card">
      <div className="section-heading-inline">
        <div>
          <h2>为什么出现《{item.title}》</h2>
          <p>以下依据来自这条目录记录本身，不包含模型补写。</p>
        </div>
        {sourceButton(item.sourceRef)}
      </div>
      <div className="reason-grid">
        {reasons.slice(0, 3).map((reason) => (
          <Reason
            key={reason.id}
            title={reason.label}
            detail={
              reason.kind === "DOMAIN"
                ? `目录领域：${reason.catalogValue}`
                : reason.kind === "FEATURE"
                  ? `目录特征：${featureLabel(reason.catalogValue)}`
                  : "输入文本与 Album 身份字段直接匹配。"
            }
          />
        ))}
        <Reason
          title="本地关系"
          detail={
            item.localAlbum
              ? item.localAlbum.hasDigital
                ? `已匹配本地数字 Album；${item.localAlbum.audioBadge ?? "音频规格见详情"}。`
                : `已匹配本地实体收藏：${item.localAlbum.physicalMedia.join(" / ") || "介质待补充"}。`
              : "尚未在本地唱片库找到严格同名同艺术家记录。"
          }
        />
      </div>
    </section>
  );
}

function CriterionRow({ criterion }: { criterion: RecommendationCriterion }) {
  return (
    <div className="editable-filter">
      <div>
        <small>{criterion.kind === "DOMAIN" ? "音乐领域" : "目录特征"}</small>
        <strong>{criterion.label}</strong>
      </div>
      <span>已采用</span>
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
  return (
    <div className="inline-listen">
      <div>
        <strong>{album.title}</strong>
        <span>
          {track.title}
          {track.audioSpec.kind === "DSD"
            ? " · 服务器实时转为 PCM FLAC；源 DSD 不修改"
            : ""}
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

function sourceButton(value: string) {
  const url = catalogSourceUrl(value);
  return url ? (
    <a className="button secondary" href={url} target="_blank" rel="noreferrer">
      {url.includes("music.apple.com") ? "Apple Music" : "目录来源"}{" "}
      <ExternalLink />
    </a>
  ) : (
    <span className="source-ref">来源标识已记录</span>
  );
}

function Reason({ title, detail }: { title: string; detail: string }) {
  return (
    <div>
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}
