import { describe, expect, it } from "vitest";
import { isSameOriginMutation, resolveUpstreamUrl } from "./security.mjs";

describe("Web edge authentication", () => {
  it("requires an exact same-origin Host for state-changing requests", () => {
    expect(
      isSameOriginMutation(
        "POST",
        "http://cocean.local:18080",
        "cocean.local:18080",
      ),
    ).toBe(true);
    expect(
      isSameOriginMutation("POST", "https://cocean.local", "cocean.local"),
    ).toBe(true);
    expect(
      isSameOriginMutation("POST", "https://attacker.invalid", "cocean.local"),
    ).toBe(false);
    expect(isSameOriginMutation("POST", undefined, "cocean.local")).toBe(false);
    expect(isSameOriginMutation("GET", undefined, "cocean.local")).toBe(true);
  });

  it("keeps absolute-form request targets on the configured internal Server", () => {
    expect(
      resolveUpstreamUrl(
        "http://attacker.invalid/api/v1/albums?limit=1",
        "http://server:8080",
      ).href,
    ).toBe("http://server:8080/api/v1/albums?limit=1");
    expect(() =>
      resolveUpstreamUrl("/api/v1/albums", "file:///tmp/server"),
    ).toThrow(/invalid/);
  });
});
