import { describe, expect, it } from "vitest";
import { convertLegacyStillCore, parseRuntimeStillCatalog } from "./runtime.js";

const acceptedRecord = {
  stableEntityID: "still:album:1",
  entityKind: "album",
  canonicalTitle: "Glass Rooms",
  primaryArtist: "Test Artist",
  releaseFamilyID: "release:1",
  recordingFamilyID: "recording:1",
  musicDomains: ["ambient"],
  eligibleDomains: ["ambient"],
  features: ["musical.timbre:warm"],
  sourceKind: "verified_catalog",
  sourceRef: "https://example.test/album/1",
  verificationStatus: "verified",
  editorialStatus: "accepted",
  contentVersion: "still-test.1",
  verifiedAt: "2026-08-12T00:00:00.000Z",
};

describe("Still runtime catalog", () => {
  it("converts only verified and editorially accepted albums with a reproducible checksum", () => {
    const source = {
      schemaID: "still.local-curated-catalog",
      schemaVersion: "0.8.0",
      contentVersion: "still-test.1",
      recordCount: 2,
      contentChecksum: "a".repeat(64),
      records: [
        acceptedRecord,
        {
          ...acceptedRecord,
          stableEntityID: "still:album:2",
          editorialStatus: "review",
        },
      ],
    };
    const first = convertLegacyStillCore(source);
    const second = convertLegacyStillCore(source);
    expect(first).toEqual(second);
    expect(first).toEqual(
      expect.objectContaining({ recordCount: 1, rejectedRecordCount: 1 }),
    );
    expect(first.records[0]).toEqual(
      expect.objectContaining({ id: "still:album:1", domains: ["ambient"] }),
    );
    expect(parseRuntimeStillCatalog(first)).toEqual(first);
  });

  it("fails closed when content or record count is changed", () => {
    expect(() =>
      convertLegacyStillCore({
        schemaID: "still.local-curated-catalog",
        schemaVersion: "0.8.0",
        contentVersion: "still-test.1",
        recordCount: 2,
        contentChecksum: "a".repeat(64),
        records: [acceptedRecord],
      }),
    ).toThrow(/recordCount/);
    const runtime = convertLegacyStillCore({
      schemaID: "still.local-curated-catalog",
      schemaVersion: "0.8.0",
      contentVersion: "still-test.1",
      recordCount: 1,
      contentChecksum: "a".repeat(64),
      records: [acceptedRecord],
    });
    expect(() =>
      parseRuntimeStillCatalog({
        ...runtime,
        records: [{ ...runtime.records[0], title: "Tampered" }],
      }),
    ).toThrow(/checksum/);
  });
});
