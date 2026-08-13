import type { ReleaseCandidate } from "@cocean/contracts";
import {
  Check,
  CircleHelp,
  ExternalLink,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";
import {
  AlbumArtwork,
  Button,
  EmptyState,
  PageHeader,
  Toast,
} from "../components.js";
import { useAsync, useToast } from "../hooks.js";
import { releaseMatchEvidence } from "../media-ui.js";

export function InformationMatchPage({ canManage }: { canManage: boolean }) {
  const { id = "" } = useParams();
  const album = useAsync(() => api.album(id), [id]);
  const candidates = useAsync(() => api.matchCandidates(id), [id]);
  const capabilities = useAsync(() => api.capabilities(), []);
  const [working, setWorking] = useState<string | null>(null);
  const toast = useToast();
  if (album.loading)
    return (
      <div className="page">
        <PageHeader title="信息匹配" subtitle="正在读取原文件事实" />
      </div>
    );
  if (album.error || !album.data)
    return (
      <div className="page">
        <PageHeader title="信息匹配" />
        <EmptyState
          title="无法读取原文件事实"
          detail="该 Album 不存在，或 COCEAN API 暂不可用。"
        />
      </div>
    );
  const item = album.data;
  const musicBrainz = capabilities.data?.catalogSources.musicBrainz;
  const musicBrainzReady = musicBrainz?.configured === true;
  const releaseEvidence = releaseMatchEvidence(
    item.matchStatus,
    item.release.musicBrainzReleaseId,
  );
  const userConfirmed = releaseEvidence.kind === "USER_CONFIRMED";
  const pending = [
    item.release.catalogNumber,
    item.release.barcode,
    item.release.releaseDate,
  ].filter((value) => !value).length;
  const searchExternal = async () => {
    if (!musicBrainzReady) {
      toast.show(
        musicBrainz?.enabled
          ? "MusicBrainz 缺少合规联系信息，暂不能查询"
          : "MusicBrainz 当前已关闭",
      );
      return;
    }
    setWorking("search");
    try {
      const results = await api.searchMatchCandidates(item.id);
      await candidates.reload();
      toast.show(
        results.length
          ? `找到 ${results.length} 个 MusicBrainz 发行版候选`
          : "MusicBrainz 没有返回候选；本地信息未改变",
      );
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "外部目录核验失败");
    } finally {
      setWorking(null);
    }
  };
  const confirmCandidate = async (candidate: ReleaseCandidate) => {
    setWorking(candidate.id);
    try {
      await api.confirmMatchCandidate(item.id, candidate.id);
      await Promise.all([album.reload(), candidates.reload()]);
      toast.show("发行版证据已确认；源音乐文件没有被修改");
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "发行版确认失败");
    } finally {
      setWorking(null);
    }
  };
  return (
    <div className="page match-page">
      <PageHeader
        title="信息匹配"
        subtitle="先展示原文件事实；只有拿到可追溯来源后才提出修改建议"
        action={<span className="status-pill">{pending} 个发行字段待确认</span>}
      />
      <div className="match-layout">
        <div className="match-main">
          <section className="surface-card source-file-card">
            <AlbumArtwork album={item} size="small" />
            <div>
              <h2>{item.title}</h2>
              <p>
                {item.albumArtist} · {item.year}
              </p>
              <code>
                {item.sourceRoot
                  ? `${item.sourceRoot.containerPath}/${item.tracks[0]?.relativePath ?? ""}`
                  : "实体收藏 · 没有本地数字文件"}
              </code>
              <div className="inline-facts">
                <span>
                  音频规格 <strong>{item.audioBadge ?? "无数字文件"}</strong>
                </span>
                <span>
                  曲目 <strong>{item.trackCount}</strong>
                </span>
                <span>
                  封面{" "}
                  <strong>
                    {item.artwork.source === "NONE"
                      ? "待选择"
                      : item.artwork.source}
                  </strong>
                </span>
              </div>
            </div>
          </section>
          <section className="surface-card">
            <h2>字段核对</h2>
            <DiffRow
              field="专辑标题"
              current={item.title}
              proposed={item.title}
              evidence={item.hasDigital ? "本地 Album 标签" : "实体收藏记录"}
              decision="保持原值"
            />
            <DiffRow
              field="发行日期"
              current={item.year ? String(item.year) : "空"}
              proposed={item.release.releaseDate ?? "等待精确发行来源"}
              evidence={
                userConfirmed
                  ? "用户已确认 MusicBrainz Release"
                  : releaseEvidence.kind === "FILE_TAG_ONLY"
                    ? "文件标签包含 MusicBrainz Release ID，尚未人工确认"
                    : "尚未确认外部发行版"
              }
              decision={userConfirmed ? "已确认" : "待确认"}
              conflict={!userConfirmed}
            />
          </section>
          <section className="surface-card candidate-section">
            <div className="section-heading-inline">
              <div>
                <h2>MusicBrainz 发行版候选</h2>
                <p>候选只作为证据；确认前不会写入唱片事实</p>
              </div>
              <span>{candidates.data?.length ?? 0} 个</span>
            </div>
            {candidates.loading ? (
              <p className="candidate-note">正在读取已有候选…</p>
            ) : candidates.error ? (
              <p className="candidate-note">候选读取失败，请确认 API 状态。</p>
            ) : candidates.data?.length ? (
              <div className="candidate-list">
                {candidates.data.map((candidate) => (
                  <CandidateRow
                    key={candidate.id}
                    candidate={candidate}
                    confirmed={
                      userConfirmed &&
                      item.release.musicBrainzReleaseId === candidate.sourceId
                    }
                    working={working === candidate.id}
                    canManage={canManage}
                    onConfirm={() => void confirmCandidate(candidate)}
                  />
                ))}
              </div>
            ) : (
              <p className="candidate-note">
                {musicBrainzReady
                  ? "还没有外部候选。查询后可人工选择精确发行版。"
                  : musicBrainz?.enabled
                    ? "MusicBrainz 已启用，但缺少合规联系信息，当前不能查询。"
                    : "MusicBrainz 当前关闭；可在部署配置中显式启用后查询。"}
              </p>
            )}
          </section>
          <section className="surface-card">
            <div className="section-heading-inline">
              <h2>封面来源</h2>
              <span className="status-pill">
                {artworkSourceLabel(item.artwork.source)}
              </span>
            </div>
            <div className="cover-choice-row">
              <CoverChoice
                title="本地观察"
                detail={
                  item.artwork.source === "NONE"
                    ? "没有发现内嵌或目录封面"
                    : `${artworkSourceLabel(item.artwork.source)} · 未修改源文件`
                }
                album={item}
                selected
              />
              <div className="cover-choice unavailable">
                <div className="album-artwork artwork-small">
                  <span>尚未接入</span>
                </div>
                <div>
                  <strong>外部精确封面</strong>
                  <span>当前版本尚未接入外部封面来源</span>
                  <small>不可用</small>
                </div>
              </div>
            </div>
          </section>
        </div>
        <aside className="match-aside">
          <section className="surface-card evidence-card">
            <h2>来源依据</h2>
            <p>
              录音识别只能核对曲目，不能单独认定 CD、SACD、黑胶或具体压片版本。
            </p>
            <Evidence
              title={item.hasDigital ? "本地文件标签" : "实体收藏记录"}
              tag="已读取"
              detail={
                item.hasDigital
                  ? `${item.trackCount} 首 · ${item.discCount} Disc`
                  : item.physicalMedia.join(" / ")
              }
            />
            <Evidence
              title="本地封面"
              tag={item.artwork.source === "NONE" ? "未发现" : "已读取"}
              detail={artworkSourceLabel(item.artwork.source)}
            />
            <Evidence
              title="MusicBrainz"
              tag={
                userConfirmed
                  ? "已确认"
                  : releaseEvidence.kind === "FILE_TAG_ONLY"
                    ? "文件标签"
                    : musicBrainzReady
                      ? "可查询"
                      : musicBrainz?.enabled
                        ? "未配置"
                        : "已关闭"
              }
              detail={
                userConfirmed
                  ? `${releaseEvidence.sourceId} · 用户已确认`
                  : releaseEvidence.kind === "FILE_TAG_ONLY"
                    ? `${releaseEvidence.sourceId} · 尚未人工确认`
                    : musicBrainzReady
                      ? "等待人工查询并确认精确发行版"
                      : "当前不会向外部目录发送信息"
              }
            />
          </section>
          <section className="surface-card assistant-card">
            <h2>
              <Sparkles /> 辅助判断
            </h2>
            <p>
              可选智能辅助接入后，可以整理多个可追溯候选之间的差异；是否采用发行版仍由你确认。
            </p>
            <small>
              音频规格、封面与发行事实仍来自文件、目录来源与人工确认
            </small>
          </section>
          <section className="surface-card save-scope">
            <h2>保存范围</h2>
            <Scope
              title="只保存到 COCEAN"
              detail="V1 默认且唯一的主库策略"
              selected
            />
            <Scope title="写回音乐文件" detail="V1 固定关闭" />
            <Scope title="只用于投送副本" detail="未来可单独修改设备副本" />
          </section>
        </aside>
      </div>
      <footer className="sticky-actions">
        <div>
          <small>固定安全策略</small>
          <strong>扫描与核验不会修改 Music 目录</strong>
        </div>
        <div>
          <Button
            variant="secondary"
            disabled={working !== null || !musicBrainzReady || !canManage}
            onClick={() => void searchExternal()}
          >
            <RefreshCw />
            {working === "search"
              ? "正在查询"
              : musicBrainzReady
                ? "查询 MusicBrainz"
                : musicBrainz?.enabled
                  ? "MusicBrainz 未配置"
                  : "MusicBrainz 已关闭"}
          </Button>
          <Link className="button primary" to={`/albums/${item.id}`}>
            返回 Album
          </Link>
        </div>
      </footer>
      <Link className="back-link" to={`/albums/${item.id}`}>
        返回专辑详情
      </Link>
      <Toast message={toast.message} />
    </div>
  );
}

function CandidateRow({
  candidate,
  confirmed,
  working,
  canManage,
  onConfirm,
}: {
  candidate: ReleaseCandidate;
  confirmed: boolean;
  working: boolean;
  canManage: boolean;
  onConfirm: () => void;
}) {
  const identity =
    [candidate.country, candidate.releaseDate, candidate.status]
      .filter(Boolean)
      .join(" · ") || "日期与地区未提供";
  const edition =
    [
      candidate.labels[0],
      candidate.catalogNumbers[0],
      candidate.mediaFormats.join(" / "),
    ]
      .filter(Boolean)
      .join(" · ") || "厂牌与介质未提供";
  return (
    <article className={`candidate-row${confirmed ? " is-confirmed" : ""}`}>
      <div className="candidate-copy">
        <div className="candidate-title">
          <strong>{candidate.title}</strong>
          {confirmed ? (
            <span>
              <Check /> 已确认
            </span>
          ) : null}
        </div>
        <span>{candidate.artistCredit}</span>
        <small>{identity}</small>
        <small>
          {edition}
          {candidate.trackCount !== null
            ? ` · ${candidate.trackCount} tracks`
            : ""}
        </small>
        <a
          href={`https://musicbrainz.org/release/${candidate.sourceId}`}
          target="_blank"
          rel="noreferrer"
        >
          查看 MusicBrainz 证据 <ExternalLink />
        </a>
      </div>
      <Button
        variant={confirmed ? "quiet" : "secondary"}
        disabled={confirmed || working || !canManage}
        onClick={onConfirm}
      >
        {working ? "确认中" : confirmed ? "已选" : "确认此版本"}
      </Button>
    </article>
  );
}

function DiffRow({
  field,
  current,
  proposed,
  evidence,
  decision,
  conflict,
}: {
  field: string;
  current: string;
  proposed: string;
  evidence: string;
  decision: string;
  conflict?: boolean;
}) {
  return (
    <div className={`diff-row${conflict ? " conflict" : ""}`}>
      <div className="diff-title">
        <h3>{field}</h3>
        <span>{decision}</span>
      </div>
      <div className="diff-values">
        <div>
          <small>原文件</small>
          <strong>{current}</strong>
        </div>
        <span>→</span>
        <div>
          <small>
            {conflict
              ? "等待来源"
              : current === proposed
                ? "核验结果"
                : "建议值"}
          </small>
          <strong>{proposed}</strong>
          <em>{evidence}</em>
        </div>
      </div>
    </div>
  );
}
function CoverChoice({
  title,
  detail,
  album,
  selected,
}: {
  title: string;
  detail: string;
  album: Parameters<typeof AlbumArtwork>[0]["album"];
  selected?: boolean;
}) {
  return (
    <div className={`cover-choice${selected ? " selected" : ""}`}>
      <AlbumArtwork album={album} size="small" />
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
        {selected ? (
          <small>
            <Check /> 已选用
          </small>
        ) : (
          <small>保留原图</small>
        )}
      </div>
    </div>
  );
}
function Evidence({
  title,
  tag,
  detail,
}: {
  title: string;
  tag: string;
  detail: string;
}) {
  return (
    <div className="evidence-row">
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <small>{tag}</small>
    </div>
  );
}
function Scope({
  title,
  detail,
  selected,
}: {
  title: string;
  detail: string;
  selected?: boolean;
}) {
  return (
    <div className={`scope-row${selected ? " selected" : ""}`}>
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {selected ? <Check /> : <CircleHelp />}
    </div>
  );
}
function artworkSourceLabel(source: string) {
  return (
    (
      {
        SIDECAR: "目录封面",
        EMBEDDED: "内嵌封面",
        EXACT_RELEASE: "精确发行封面",
        REPRESENTATIVE: "代表性封面",
        NONE: "未发现封面",
      } as Record<string, string>
    )[source] ?? source
  );
}
