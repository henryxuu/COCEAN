import type { CoceanSettings } from "@cocean/contracts";

const THEME_CACHE_KEY = "cocean.theme";

export function applyTheme(
  theme: CoceanSettings["theme"],
  persist = true,
): void {
  if (theme === "SYSTEM")
    document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme.toLowerCase();
  if (persist) {
    try {
      localStorage.setItem(THEME_CACHE_KEY, theme);
    } catch {
      // Storage can be unavailable in hardened/private browser contexts.
    }
  }
}

export function applyCachedTheme(): void {
  try {
    const cached = localStorage.getItem(THEME_CACHE_KEY);
    if (cached === "SYSTEM" || cached === "LIGHT" || cached === "DARK")
      applyTheme(cached, false);
  } catch {
    // System appearance remains the safe default.
  }
}
