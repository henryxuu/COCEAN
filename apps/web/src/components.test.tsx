import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { PageShell } from "./components.js";

describe("产品外壳一级导航", () => {
  it("桌面和移动端只呈现四个核心管理入口，并让品牌直达唱片库", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/library"]}>
        <PageShell
          user={{
            id: "member-one",
            username: "member",
            displayName: "Member",
            role: "MEMBER",
            enabled: true,
            createdAt: "2026-08-16T00:00:00.000Z",
            updatedAt: "2026-08-16T00:00:00.000Z",
            lastLoginAt: null,
          }}
          onLogout={() => undefined}
        >
          <h1>内容</h1>
        </PageShell>
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="桌面主导航"');
    expect(html).toContain('aria-label="桌面设置导航"');
    expect(html).toContain('aria-label="移动主导航"');
    expect(html).toContain('<main class="main-content"><h1>内容</h1></main>');
    expect(html).toMatch(
      /<a aria-label="COCEAN 唱片库" aria-current="page"[^>]*href="\/library"/,
    );

    const desktopMain = navMarkup(html, "桌面主导航");
    const desktopSettings = navMarkup(html, "桌面设置导航");
    const desktop = `${desktopMain}${desktopSettings}`;
    const mobile = navMarkup(html, "移动主导航");
    const expected = [
      { label: "唱片库", href: "/library" },
      { label: "任务", href: "/tasks" },
      { label: "我的系统", href: "/systems" },
      { label: "设置", href: "/settings" },
    ];
    expect(anchorEntries(desktop)).toEqual(expected);
    expect(anchorEntries(mobile)).toEqual(expected);
    for (const hidden of ["今日", "找歌", "隔离区"]) {
      expect(desktop).not.toContain(hidden);
      expect(mobile).not.toContain(hidden);
    }

    const aside = asideMarkup(html);
    expect(aside.indexOf('class="brand-lockup')).toBeLessThan(
      aside.indexOf('class="sidebar-nav"'),
    );
    expect(aside.indexOf('class="sidebar-nav"')).toBeLessThan(
      aside.indexOf('class="sidebar-spacer"'),
    );
    expect(aside.indexOf('class="sidebar-spacer"')).toBeLessThan(
      aside.indexOf('class="sidebar-account"'),
    );
    expect(aside.indexOf('class="sidebar-account"')).toBeLessThan(
      aside.indexOf('class="sidebar-footer-nav"'),
    );
    expect(aside.indexOf('class="sidebar-footer-nav"')).toBeLessThan(
      aside.indexOf('class="nas-status"'),
    );
  });

  it("源码在完整移动导航区间声明 44px 与可见焦点合同", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const mobileCss = mediaBlock(css, "@media (max-width: 1023px)");

    expect(css).toMatch(
      /button:focus-visible,\s*a:focus-visible,\s*input:focus-visible,\s*select:focus-visible,\s*summary:focus-visible\s*\{[^}]*outline: 2px solid var\(--focus\);[^}]*\}/,
    );
    expect(mobileCss).toMatch(
      /\.mobile-nav\s*\{[^}]*grid-template-columns: repeat\(4, 1fr\);[^}]*\}/,
    );
    expect(mobileCss).toMatch(
      /\.mobile-nav a\s*\{[^}]*min-width: 44px;[^}]*min-height: 44px;[^}]*\}/,
    );
    expect(mobileCss).toMatch(
      /select,\s*summary,\s*\.filter-pill\s*\{[^}]*min-height: 44px;[^}]*\}/,
    );
  });
});

function navMarkup(html: string, label: string): string {
  return (
    new RegExp(`<nav[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)</nav>`).exec(
      html,
    )?.[1] ?? ""
  );
}

function asideMarkup(html: string): string {
  return /<aside[^>]*>([\s\S]*?)<\/aside>/.exec(html)?.[1] ?? "";
}

function anchorEntries(html: string): Array<{ label: string; href: string }> {
  return [
    ...html.matchAll(
      /<a[^>]*href="([^"]+)"[^>]*>[\s\S]*?<span>([^<]+)<\/span><\/a>/g,
    ),
  ].map((match) => ({ href: match[1]!, label: match[2]! }));
}

function mediaBlock(css: string, marker: string): string {
  const start = css.indexOf(marker);
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(open + 1, index);
  }
  return "";
}
