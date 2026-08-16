import { describe, expect, it, vi } from "vitest";
import {
  changeLibraryCriteria,
  consumeLibraryScrollRestoration,
  libraryRoute,
  libraryScrollKey,
  readLibraryScrollRestoration,
  readLibraryState,
  safeLibraryReturn,
  saveLibraryScrollRestoration,
  scheduleLibraryScrollRestore,
} from "./library-state.js";

describe("唱片库返回连续性", () => {
  it("将最新加入作为无参数默认，并保留所有显式旧排序", () => {
    const defaultState = readLibraryState(new URLSearchParams());
    expect(defaultState.sort).toBe("ADDED_DESC");
    expect(libraryRoute(defaultState)).toBe("/library");
    expect(
      libraryRoute(readLibraryState(new URLSearchParams("sort=ADDED_DESC"))),
    ).toBe("/library");
    expect(
      libraryRoute(readLibraryState(new URLSearchParams("sort=POPULAR"))),
    ).toBe("/library");

    for (const sort of ["ARTIST", "TITLE", "YEAR_DESC"] as const) {
      const state = readLibraryState(new URLSearchParams(`sort=${sort}`));
      expect(state.sort).toBe(sort);
      expect(libraryRoute(state)).toBe(`/library?sort=${sort}`);
    }
  });

  it("搜索、筛选、问题、可见性和排序变化都回到第一页并保留其他状态", () => {
    const current = readLibraryState(
      new URLSearchParams(
        "q=Bach&filter=CD&sort=ARTIST&issue=MISSING_ARTWORK&visibility=HIDDEN&page=3",
      ),
    );
    const patches: Array<Parameters<typeof changeLibraryCriteria>[1]> = [
      { query: "Mozart" },
      { filter: "VINYL" },
      { issue: "BROKEN_TEXT" },
      { visibility: "VISIBLE" },
      { sort: "YEAR_DESC" },
    ];
    for (const patch of patches) {
      const changed = changeLibraryCriteria(current, patch);
      expect(changed.page).toBe(0);
      expect(changed).toEqual(expect.objectContaining(patch));
      expect(changed.query).toBe(patch.query ?? current.query);
      expect(changed.filter).toBe(patch.filter ?? current.filter);
      expect(changed.sort).toBe(patch.sort ?? current.sort);
      expect(changed.issue).toBe(patch.issue ?? current.issue);
      expect(changed.visibility).toBe(patch.visibility ?? current.visibility);
    }
  });

  it("把查询、筛选、排序和第 2 页稳定编码为同一个返回 URL", () => {
    const state = readLibraryState(
      new URLSearchParams(
        "q=Schubert&filter=DIGITAL&sort=YEAR_DESC&issue=IDENTITY_OVERLAP&page=2",
      ),
    );

    expect(state).toEqual({
      query: "Schubert",
      filter: "DIGITAL",
      sort: "YEAR_DESC",
      issue: "IDENTITY_OVERLAP",
      visibility: "VISIBLE",
      page: 1,
    });
    expect(libraryRoute(state)).toBe(
      "/library?q=Schubert&filter=DIGITAL&sort=YEAR_DESC&issue=IDENTITY_OVERLAP&page=2",
    );
  });

  it("按完整查询隔离滚动位置，并在列表两帧布局完成后恢复 1200px", () => {
    const route = "/library?q=Schubert&filter=DIGITAL&sort=YEAR_DESC&page=2";
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
    expect(saveLibraryScrollRestoration(storage, route, 1200, 1000)).toBe(true);
    const frames: FrameRequestCallback[] = [];
    const scrollTo = vi.fn();
    const restored = vi.fn();
    const timers: Array<() => void> = [];
    const cancel = scheduleLibraryScrollRestore(
      readLibraryScrollRestoration(storage, route, 1000)?.top ?? 0,
      {
        requestFrame(callback) {
          frames.push(callback);
          return frames.length;
        },
        cancelFrame: vi.fn(),
        setTimer(callback) {
          timers.push(callback);
          return timers.length;
        },
        clearTimer: vi.fn(),
        scrollTo,
      },
      () => {
        consumeLibraryScrollRestoration(storage, route);
        restored();
      },
    );

    expect(
      readLibraryScrollRestoration(storage, "/library?page=2", 1000),
    ).toBeNull();
    expect(values.has(libraryScrollKey(route))).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();
    frames.shift()?.(0);
    expect(scrollTo).not.toHaveBeenCalled();
    frames.shift()?.(16);
    expect(scrollTo).toHaveBeenCalledWith(1200);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    timers.shift()?.();
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(values.has(libraryScrollKey(route))).toBe(true);
    timers.shift()?.();
    expect(scrollTo).toHaveBeenCalledTimes(3);
    expect(restored).toHaveBeenCalledOnce();
    expect(values.has(libraryScrollKey(route))).toBe(false);
    cancel();
  });

  it("无有效滚动记录时在列表两帧布局后回到页首", () => {
    const frames: FrameRequestCallback[] = [];
    const scrollTo = vi.fn();
    const restored = vi.fn();
    const timers: Array<() => void> = [];
    scheduleLibraryScrollRestore(
      readLibraryScrollRestoration(
        {
          getItem: () => "not-a-number",
          setItem: () => {},
          removeItem: () => {},
        },
        "/library",
      )?.top ?? 0,
      {
        requestFrame(callback) {
          frames.push(callback);
          return frames.length;
        },
        cancelFrame: vi.fn(),
        setTimer(callback) {
          timers.push(callback);
          return timers.length;
        },
        clearTimer: vi.fn(),
        scrollTo,
      },
      restored,
    );

    frames.shift()?.(0);
    expect(scrollTo).not.toHaveBeenCalled();
    frames.shift()?.(16);
    expect(scrollTo).toHaveBeenCalledWith(0);
    timers.shift()?.();
    timers.shift()?.();
    expect(restored).toHaveBeenCalledOnce();
  });

  it("取消旧布局的恢复后不会误滚动或宣告完成", () => {
    const frames: FrameRequestCallback[] = [];
    const scrollTo = vi.fn();
    const restored = vi.fn();
    const clearTimer = vi.fn();
    const cancel = scheduleLibraryScrollRestore(
      1200,
      {
        requestFrame(callback) {
          frames.push(callback);
          return frames.length;
        },
        cancelFrame: vi.fn(),
        setTimer: vi.fn(() => 1),
        clearTimer,
        scrollTo,
      },
      restored,
    );

    frames.shift()?.(0);
    cancel();
    frames.shift()?.(16);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(restored).not.toHaveBeenCalled();
  });

  it("拒绝非安全整数页码，并让当前 URL 完整决定列表状态", () => {
    expect(
      readLibraryState(new URLSearchParams("page=9007199254740992")).page,
    ).toBe(0);
    expect(readLibraryState(new URLSearchParams("page=1e3")).page).toBe(0);
    expect(
      readLibraryState(
        new URLSearchParams("q=Bach&filter=CD&sort=TITLE&page=3"),
      ),
    ).toEqual({
      query: "Bach",
      filter: "CD",
      sort: "TITLE",
      issue: "ALL",
      visibility: "VISIBLE",
      page: 2,
    });
    expect(
      readLibraryState(new URLSearchParams("issue=NOT_A_REAL_ISSUE")).issue,
    ).toBe("ALL");
    const hidden = readLibraryState(
      new URLSearchParams("visibility=HIDDEN&q=hidden"),
    );
    expect(hidden.visibility).toBe("HIDDEN");
    expect(libraryRoute(hidden)).toContain("visibility=HIDDEN");
  });

  it("过期、损坏或存储异常的恢复记录会安全失效", () => {
    const route = "/library?page=2";
    const storage = memoryStorage();
    saveLibraryScrollRestoration(storage, route, 1200, 0);
    expect(
      readLibraryScrollRestoration(storage, route, 31 * 60 * 1000),
    ).toBeNull();
    expect(storage.getItem(libraryScrollKey(route))).toBeNull();

    const unavailable = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(saveLibraryScrollRestoration(unavailable, route, 1200)).toBe(false);
    expect(readLibraryScrollRestoration(unavailable, route)).toBeNull();
    expect(consumeLibraryScrollRestoration(unavailable, route)).toBe(false);
  });

  it("详情返回只接受精确的唱片库路由并保留查询", () => {
    expect(safeLibraryReturn("/library?filter=CD&page=2")).toBe(
      "/library?filter=CD&page=2",
    );
    expect(safeLibraryReturn("/library-other?page=2")).toBe("/library");
    expect(safeLibraryReturn("//example.com/library?page=2")).toBe("/library");
  });
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}
