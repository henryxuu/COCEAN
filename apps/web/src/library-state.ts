import {
  defaultLibrarySort,
  librarySortSchema,
  type LibraryIssueCode,
  type LibrarySort,
} from "@cocean/contracts";

export type LibraryFilter = "ALL" | "DIGITAL" | "CD" | "SACD" | "VINYL";
export type { LibrarySort };
export type LibraryIssue = "ALL" | LibraryIssueCode;
export type LibraryVisibility = "VISIBLE" | "HIDDEN";

const libraryIssues: LibraryIssue[] = [
  "ALL",
  "IDENTITY_OVERLAP",
  "INCOMPLETE_TRACKS",
  "MISSING_ARTWORK",
  "LOW_RES_ARTWORK",
  "MIXED_AUDIO_SPECS",
  "BROKEN_TEXT",
  "MISSING_IDENTITY",
];

export interface LibraryState {
  query: string;
  filter: LibraryFilter;
  sort: LibrarySort;
  issue: LibraryIssue;
  visibility: LibraryVisibility;
  page: number;
}

export interface LibraryScrollRestoration {
  route: string;
  top: number;
  savedAt: number;
}

export type LibraryStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export const LIBRARY_SCROLL_RESTORATION_TTL_MS = 30 * 60 * 1000;

export function readLibraryState(searchParams: URLSearchParams): LibraryState {
  const filter = searchParams.get("filter");
  const sort = searchParams.get("sort");
  const parsedSort = librarySortSchema.safeParse(sort);
  const page = parsePage(searchParams.get("page"));
  const issue = searchParams.get("issue");
  return {
    query: searchParams.get("q") ?? "",
    filter: ["ALL", "DIGITAL", "CD", "SACD", "VINYL"].includes(filter ?? "")
      ? (filter as LibraryFilter)
      : "ALL",
    sort: parsedSort.success ? parsedSort.data : defaultLibrarySort,
    issue: libraryIssues.includes(issue as LibraryIssue)
      ? (issue as LibraryIssue)
      : "ALL",
    visibility:
      searchParams.get("visibility") === "HIDDEN" ? "HIDDEN" : "VISIBLE",
    page,
  };
}

export function librarySearchParams(state: LibraryState): URLSearchParams {
  const next = new URLSearchParams();
  if (state.query) next.set("q", state.query);
  if (state.filter !== "ALL") next.set("filter", state.filter);
  if (state.sort !== defaultLibrarySort) next.set("sort", state.sort);
  if (state.issue !== "ALL") next.set("issue", state.issue);
  if (state.visibility === "HIDDEN") next.set("visibility", "HIDDEN");
  if (state.page > 0) next.set("page", String(state.page + 1));
  return next;
}

export function libraryRoute(state: LibraryState): string {
  const query = librarySearchParams(state).toString();
  return query ? `/library?${query}` : "/library";
}

export function changeLibraryCriteria(
  state: LibraryState,
  patch: Partial<
    Pick<LibraryState, "query" | "filter" | "sort" | "issue" | "visibility">
  >,
): LibraryState {
  return { ...state, ...patch, page: 0 };
}

export function libraryScrollKey(route: string): string {
  return `cocean:library-scroll:${route}`;
}

export function safeLibraryReturn(value: string | null): string {
  if (!value?.startsWith("/")) return "/library";
  try {
    const parsed = new URL(value, "http://cocean.local");
    if (
      parsed.origin !== "http://cocean.local" ||
      parsed.pathname !== "/library"
    )
      return "/library";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/library";
  }
}

export function saveLibraryScrollRestoration(
  storage: LibraryStorage,
  route: string,
  top: number,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(top) || top < 0) return false;
  return safeStorageSet(
    storage,
    libraryScrollKey(route),
    JSON.stringify({
      route,
      top,
      savedAt: now,
    } satisfies LibraryScrollRestoration),
  );
}

export function readLibraryScrollRestoration(
  storage: LibraryStorage,
  route: string,
  now = Date.now(),
): LibraryScrollRestoration | null {
  const key = libraryScrollKey(route);
  const raw = safeStorageGet(storage, key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LibraryScrollRestoration>;
    const valid =
      value.route === route &&
      typeof value.top === "number" &&
      Number.isFinite(value.top) &&
      value.top >= 0 &&
      typeof value.savedAt === "number" &&
      Number.isFinite(value.savedAt) &&
      now >= value.savedAt &&
      now - value.savedAt <= LIBRARY_SCROLL_RESTORATION_TTL_MS;
    if (valid) return value as LibraryScrollRestoration;
  } catch {
    // Invalid or legacy records cannot establish a query-bound restoration.
  }
  safeStorageRemove(storage, key);
  return null;
}

export function consumeLibraryScrollRestoration(
  storage: LibraryStorage,
  route: string,
): boolean {
  return safeStorageRemove(storage, libraryScrollKey(route));
}

export function safeStorageGet(
  storage: Pick<Storage, "getItem">,
  key: string,
): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function safeStorageSet(
  storage: Pick<Storage, "setItem">,
  key: string,
  value: string,
): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeStorageRemove(
  storage: Pick<Storage, "removeItem">,
  key: string,
): boolean {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function safeBrowserSessionStorage(): LibraryStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

interface ScrollScheduler {
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
  scrollTo(top: number): void;
}

export function scheduleLibraryScrollRestore(
  top: number,
  scheduler: ScrollScheduler,
  onRestored: () => void,
): () => void {
  let cancelled = false;
  let secondFrame = 0;
  let settleTimer = 0;
  let finalTimer = 0;
  const restore = () => {
    if (!cancelled) scheduler.scrollTo(top);
  };
  const firstFrame = scheduler.requestFrame(() => {
    secondFrame = scheduler.requestFrame(() => {
      if (cancelled) return;
      restore();
      // Album artwork and responsive fonts can still shift the grid after the
      // first paint. Re-assert the saved position after both the immediate and
      // delayed layout settle points instead of letting scroll anchoring win.
      settleTimer = scheduler.setTimer(restore, 120);
      finalTimer = scheduler.setTimer(() => {
        restore();
        if (!cancelled) onRestored();
      }, 700);
    });
  });
  return () => {
    cancelled = true;
    scheduler.cancelFrame(firstFrame);
    if (secondFrame) scheduler.cancelFrame(secondFrame);
    if (settleTimer) scheduler.clearTimer(settleTimer);
    if (finalTimer) scheduler.clearTimer(finalTimer);
  };
}

function parsePage(value: string | null): number {
  if (!value || !/^[1-9]\d*$/.test(value)) return 0;
  const page = Number(value);
  return Number.isSafeInteger(page) ? page - 1 : 0;
}
