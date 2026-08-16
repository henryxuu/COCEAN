import type { AlbumSummary, PhysicalMedium } from "@cocean/contracts";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  ScanLine,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import {
  AlbumCard,
  Button,
  EmptyState,
  FilterPill,
  LoadingGrid,
  PageHeader,
  SearchField,
  Toast,
} from "../components.js";
import { useAsync, useToast } from "../hooks.js";
import {
  libraryRoute,
  librarySearchParams,
  changeLibraryCriteria,
  consumeLibraryScrollRestoration,
  readLibraryScrollRestoration,
  readLibraryState,
  safeBrowserSessionStorage,
  saveLibraryScrollRestoration,
  scheduleLibraryScrollRestore,
  type LibraryFilter,
  type LibraryIssue,
  type LibraryState,
  type LibraryStorage,
  type LibrarySort,
  type LibraryVisibility,
} from "../library-state.js";

type Filter = LibraryFilter;
type Sort = LibrarySort;
const PAGE_SIZE = 96;

export function LibraryPage({ canManage }: { canManage: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentLibraryState = readLibraryState(searchParams);
  const { query, filter, sort, issue, visibility, page } = currentLibraryState;
  const currentLibraryRoute = libraryRoute(currentLibraryState);
  const restoredRoute = useRef<string | null>(null);
  const [addingPhysical, setAddingPhysical] = useState(false);
  const [physicalTitle, setPhysicalTitle] = useState("");
  const [physicalArtist, setPhysicalArtist] = useState("");
  const [physicalYear, setPhysicalYear] = useState("");
  const [physicalMedium, setPhysicalMedium] = useState<PhysicalMedium>("CD");
  const albums = useAsync(
    async () => ({
      route: currentLibraryRoute,
      page: await api.albumPage(libraryAlbumQuery(currentLibraryState)),
    }),
    [query, filter, sort, issue, visibility, page],
  );
  const stats = useAsync(() => api.stats(), []);
  const toast = useToast();
  const loadedPage =
    albums.data?.route === currentLibraryRoute ? albums.data.page : null;
  const items = loadedPage?.items ?? [];
  const total = loadedPage?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isRecoveringFromOutOfRangePage = Boolean(
    loadedPage && page > 0 && items.length === 0,
  );
  const hasActiveCriteria =
    Boolean(query.trim()) ||
    filter !== "ALL" ||
    issue !== "ALL" ||
    visibility !== "VISIBLE";
  const updateLibraryState = (
    patch: Partial<{
      query: string;
      filter: Filter;
      sort: Sort;
      issue: LibraryIssue;
      visibility: LibraryVisibility;
      page: number;
    }>,
  ) => {
    setSearchParams(librarySearchParams({ ...currentLibraryState, ...patch }), {
      replace: true,
    });
  };
  const updateLibraryCriteria = (
    patch: Parameters<typeof changeLibraryCriteria>[1],
  ) => {
    setSearchParams(
      librarySearchParams(changeLibraryCriteria(currentLibraryState, patch)),
      { replace: true },
    );
  };
  useLayoutEffect(() => {
    if (!isRecoveringFromOutOfRangePage) return;
    setSearchParams(
      librarySearchParams({
        query,
        filter,
        sort,
        issue,
        visibility,
        page: 0,
      }),
      { replace: true },
    );
  }, [
    filter,
    isRecoveringFromOutOfRangePage,
    issue,
    query,
    setSearchParams,
    sort,
    visibility,
  ]);
  useLayoutEffect(() => {
    if (
      albums.loading ||
      !loadedPage ||
      restoredRoute.current === currentLibraryRoute
    )
      return;
    const storage = safeBrowserSessionStorage();
    const saved = storage
      ? readLibraryScrollRestoration(storage, currentLibraryRoute)
      : null;
    return scheduleLibraryScrollRestore(
      saved?.top ?? 0,
      {
        requestFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (handle) => cancelAnimationFrame(handle),
        setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clearTimer: (handle) => window.clearTimeout(handle),
        scrollTo: (top) => window.scrollTo({ top, behavior: "auto" }),
      },
      () => {
        restoredRoute.current = currentLibraryRoute;
        if (storage && saved)
          consumeLibraryScrollRestoration(storage, currentLibraryRoute);
      },
    );
  }, [albums.loading, currentLibraryRoute, loadedPage]);

  const addPhysicalAlbum = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await api.addPhysicalAlbum({
        title: physicalTitle,
        albumArtist: physicalArtist,
        year: physicalYear ? Number(physicalYear) : null,
        medium: physicalMedium,
      });
      setPhysicalTitle("");
      setPhysicalArtist("");
      setPhysicalYear("");
      setAddingPhysical(false);
      updateLibraryState({ page: 0 });
      await Promise.all([
        ...(page === 0 ? [albums.reload()] : []),
        stats.reload(),
      ]);
      toast.show(
        `${physicalMedium === "VINYL" ? "黑胶" : physicalMedium} 已加入唱片库`,
      );
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "实体唱片保存失败");
    }
  };

  return (
    <div className="page library-page">
      <PageHeader
        title="唱片库"
        subtitle="数字文件与实体唱片，共享同一个 Album 身份"
        action={
          <div className="header-actions">
            {canManage ? (
              <Button
                variant="secondary"
                onClick={() => setAddingPhysical((value) => !value)}
              >
                <Plus /> 添加实体唱片
              </Button>
            ) : null}
            <Link className="button secondary" to="/tasks">
              <ScanLine /> {canManage ? "管理扫描" : "查看任务"}
            </Link>
          </div>
        }
      />
      <div className="library-overview">
        <span>
          <strong>{stats.data?.pendingGroups ?? 0}</strong> 待确认分组
        </span>
        <span>
          <strong>{stats.data?.incompleteAlbums ?? 0}</strong> 残缺
        </span>
        <span>
          <strong>{stats.data?.missingArtwork ?? 0}</strong> 缺封面
        </span>
        <span>
          <strong>{stats.data?.lowResolutionArtwork ?? 0}</strong> 低清封面
        </span>
        <span>
          <strong>{stats.data?.brokenIdentity ?? 0}</strong> 字段异常
        </span>
        <span>
          <strong>{stats.data?.recentlyAdded ?? 0}</strong> 最近新增
        </span>
        <span>
          <strong>{stats.data?.albums ?? 0}</strong> Albums
        </span>
        <span>
          <strong>{stats.data?.files ?? 0}</strong> 数字文件
        </span>
        <span>
          <strong>
            {stats.data?.lastScanAt
              ? new Intl.DateTimeFormat("zh-CN", {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(stats.data.lastScanAt))
              : "尚未扫描"}
          </strong>{" "}
          最后扫描
        </span>
      </div>
      {addingPhysical && canManage ? (
        <form
          className="physical-album-form surface-card"
          onSubmit={addPhysicalAlbum}
        >
          <label>
            <span>Album</span>
            <input
              value={physicalTitle}
              onChange={(event) => setPhysicalTitle(event.target.value)}
              required
            />
          </label>
          <label>
            <span>Artist</span>
            <input
              value={physicalArtist}
              onChange={(event) => setPhysicalArtist(event.target.value)}
              required
            />
          </label>
          <label>
            <span>年份</span>
            <input
              type="number"
              min="1877"
              max="2200"
              value={physicalYear}
              onChange={(event) => setPhysicalYear(event.target.value)}
            />
          </label>
          <label>
            <span>介质</span>
            <select
              value={physicalMedium}
              onChange={(event) =>
                setPhysicalMedium(event.target.value as PhysicalMedium)
              }
            >
              <option value="CD">CD</option>
              <option value="SACD">SACD</option>
              <option value="VINYL">黑胶</option>
            </select>
          </label>
          <Button type="submit">加入唱片库</Button>
        </form>
      ) : null}
      <div className="library-toolbar">
        <SearchField
          value={query}
          onChange={(event) => {
            updateLibraryCriteria({ query: event.target.value });
          }}
          placeholder="搜索 Album、Artist"
          aria-label="搜索唱片库"
        />
        {canManage ? (
          <div className="filter-row" aria-label="筛选显示状态">
            <FilterPill
              active={visibility === "VISIBLE"}
              onClick={() => updateLibraryCriteria({ visibility: "VISIBLE" })}
            >
              日常唱片
            </FilterPill>
            <FilterPill
              active={visibility === "HIDDEN"}
              onClick={() => updateLibraryCriteria({ visibility: "HIDDEN" })}
            >
              已隐藏
            </FilterPill>
          </div>
        ) : null}
        <div className="filter-row" aria-label="筛选介质">
          {(
            [
              ["ALL", "全部"],
              ["DIGITAL", "数字"],
              ["CD", "CD"],
              ["SACD", "SACD"],
              ["VINYL", "黑胶"],
            ] as Array<[Filter, string]>
          ).map(([value, label]) => (
            <FilterPill
              key={value}
              active={filter === value}
              onClick={() => {
                updateLibraryCriteria({ filter: value });
              }}
            >
              {label}
            </FilterPill>
          ))}
        </div>
        <label className="sort-control">
          <span>完整性问题</span>
          <select
            value={issue}
            onChange={(event) =>
              updateLibraryCriteria({
                issue: event.target.value as LibraryIssue,
              })
            }
          >
            <option value="ALL">全部问题</option>
            <option value="IDENTITY_OVERLAP">待确认分组</option>
            <option value="INCOMPLETE_TRACKS">曲目不完整</option>
            <option value="MISSING_ARTWORK">缺少封面</option>
            <option value="LOW_RES_ARTWORK">低清封面</option>
            <option value="MIXED_AUDIO_SPECS">混合规格</option>
            <option value="BROKEN_TEXT">字段异常</option>
            <option value="MISSING_IDENTITY">身份缺失</option>
          </select>
        </label>
        <label className="sort-control">
          <span>排序</span>
          <select
            value={sort}
            onChange={(event) => {
              updateLibraryCriteria({
                sort: event.target.value as Sort,
              });
            }}
          >
            <option value="ADDED_DESC">最新加入</option>
            <option value="ARTIST">Artist</option>
            <option value="TITLE">Album</option>
            <option value="YEAR_DESC">年份 ↓</option>
          </select>
        </label>
        <Button
          variant="quiet"
          onClick={() => void albums.reload()}
          aria-label="刷新"
        >
          <RefreshCw />
        </Button>
      </div>
      {albums.loading ||
      (!loadedPage && !albums.error) ||
      isRecoveringFromOutOfRangePage ? (
        <LoadingGrid />
      ) : albums.error ? (
        <EmptyState
          title="唱片库 API 暂不可用"
          detail="不会显示演示数据；请检查 Server 健康状态和同源 /api 代理。"
        />
      ) : items.length ? (
        <>
          <div className="album-grid">
            {items.map((album) => (
              <LibraryAlbumCard
                key={album.id}
                album={album}
                route={currentLibraryRoute}
              />
            ))}
          </div>
          <nav className="library-pagination" aria-label="唱片库分页">
            <Button
              variant="secondary"
              disabled={page === 0}
              onClick={() =>
                updateLibraryState({ page: Math.max(0, page - 1) })
              }
            >
              <ChevronLeft /> 上一页
            </Button>
            <span>
              第 {page + 1} / {pageCount} 页 · 显示{" "}
              {(page * PAGE_SIZE + 1).toLocaleString()}–
              {Math.min((page + 1) * PAGE_SIZE, total).toLocaleString()} /{" "}
              {total.toLocaleString()}
            </span>
            <Button
              variant="secondary"
              disabled={page + 1 >= pageCount}
              onClick={() => updateLibraryState({ page: page + 1 })}
            >
              下一页 <ChevronRight />
            </Button>
          </nav>
        </>
      ) : (
        <EmptyState
          title={hasActiveCriteria ? "没有符合条件的 Album" : "唱片库还是空的"}
          detail={
            hasActiveCriteria
              ? "清除搜索或筛选条件，再查看完整唱片库。"
              : canManage
                ? "从真实 Music 目录开始扫描，或添加一张实体唱片。"
                : "唱片库尚无可浏览内容；可查看任务进度或联系管理员检查目录。"
          }
          action={
            hasActiveCriteria ? (
              <Button
                variant="secondary"
                onClick={() => setSearchParams({}, { replace: true })}
              >
                清除筛选
              </Button>
            ) : canManage ? (
              <div className="empty-state-actions">
                <Link
                  className="button secondary"
                  to="/settings#settings-resources"
                >
                  检查目录设置
                </Link>
              </div>
            ) : undefined
          }
        />
      )}
      <Toast message={toast.message} />
    </div>
  );
}

export function libraryAlbumQuery(state: LibraryState) {
  return {
    search: state.query,
    filter: state.filter,
    sort: state.sort,
    issue: state.issue,
    visibility: state.visibility,
    limit: PAGE_SIZE,
    offset: state.page * PAGE_SIZE,
  };
}

export function LibraryAlbumCard({
  album,
  route,
  storage,
  scrollTop,
  now,
}: {
  album: AlbumSummary;
  route: string;
  storage?: LibraryStorage | null;
  scrollTop?: () => number;
  now?: () => number;
}) {
  const captureRoute = () => {
    const targetStorage = storage ?? safeBrowserSessionStorage();
    if (!targetStorage) return;
    let top = 0;
    try {
      top = scrollTop ? scrollTop() : window.scrollY;
    } catch {
      top = 0;
    }
    saveLibraryScrollRestoration(
      targetStorage,
      route,
      top,
      now?.() ?? Date.now(),
    );
  };
  return (
    <AlbumCard
      album={album}
      to={`/albums/${album.id}?from=${encodeURIComponent(route)}`}
      onOpen={captureRoute}
      onAuxOpen={captureRoute}
      onContextOpen={captureRoute}
    />
  );
}
