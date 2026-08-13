import { describe, expect, it } from "vitest";
import {
  catalogSourceUrl,
  domainLabel,
  featureLabel,
  localDayKey,
} from "./recommendation-ui.js";

describe("recommendation UI facts", () => {
  it("formats catalog facts without inventing unknown labels", () => {
    expect(domainLabel("jazz")).toBe("爵士");
    expect(domainLabel("unmapped-domain")).toBe("unmapped-domain");
    expect(featureLabel("musical.timbre:warm")).toBe("温暖");
    expect(featureLabel("musical.form:unknown-form")).toBe("unknown form");
  });

  it("only exposes HTTP catalog references as links", () => {
    expect(catalogSourceUrl("https://example.test/album")).toBe(
      "https://example.test/album",
    );
    expect(catalogSourceUrl("docs/private-audit.json#entry")).toBeNull();
    expect(catalogSourceUrl("javascript:alert(1)")).toBeNull();
  });

  it("uses the browser-local calendar day rather than an implicit UTC slice", () => {
    expect(localDayKey(new Date(2026, 7, 12, 23, 59))).toBe("2026-08-12");
  });
});
