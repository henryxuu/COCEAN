import { describe, expect, it } from "vitest";
import { loadWorkerConfig, parseExcludedDirectories } from "./config.js";

describe("scan exclusion configuration", () => {
  it("normalizes a unique exact-directory JSON policy", () => {
    expect(
      parseExcludedDirectories(
        '["from-qobuz/qobuz-venv","RoonBackups","@Recycle"]',
      ),
    ).toEqual(["@Recycle", "from-qobuz/qobuz-venv", "RoonBackups"]);
    expect(
      loadWorkerConfig({ COCEAN_SCAN_EXCLUDE_DIRS: '["RoonBackups"]' })
        .excludeDirectories,
    ).toEqual(["RoonBackups"]);
  });

  it.each([
    "not-json",
    "{}",
    '["/absolute"]',
    '["../escape"]',
    '["folder/"]',
    '["folder","folder"]',
    '["folder","folder/nested"]',
  ])("rejects an ambiguous or unsafe policy: %s", (value) => {
    expect(() => parseExcludedDirectories(value)).toThrow();
  });
});
