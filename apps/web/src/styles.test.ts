import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("最近删除窄屏 CSS 合同", () => {
  it("保留 44px 触控目标并在窄屏纵向排列动作", () => {
    expect(styles).toMatch(
      /\.quarantine-row \.button,[\s\S]*?min-height:\s*44px;/,
    );
    const narrow = styles.match(
      /@media \(max-width:\s*767px\) \{([\s\S]*?)@media \(max-width:\s*479px\)/,
    )?.[1];
    expect(narrow).toContain(".quarantine-actions");
    expect(narrow).toMatch(
      /\.quarantine-actions\s*\{[\s\S]*?flex-direction:\s*column;/,
    );
    expect(narrow).toMatch(
      /\.quarantine-actions \.button\s*\{[\s\S]*?width:\s*100%;/,
    );
  });
});
