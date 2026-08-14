import type { AlbumDetail, MetadataFieldState } from "@cocean/contracts";
import { describe, expect, it } from "vitest";
import { informationMatchVersion } from "./information-match.js";

describe("InformationMatch LocalVersion selection", () => {
  it("derives current release state from the selected non-primary version", () => {
    const field = (value: string | null): MetadataFieldState => ({
      observed: {
        value,
        source: "OBSERVED_TAG",
        versionId: "secondary",
      },
      confirmedExternal: null,
      userOverride: null,
      effectiveValue: value,
      effectiveSource: "OBSERVED_TAG",
    });
    const album = {
      id: "library",
      title: "Primary",
      albumArtist: "Primary Artist",
      year: 2001,
      matchStatus: "USER_CONFIRMED",
      primaryVersionId: "primary",
      release: { musicBrainzReleaseId: "primary-release" },
      localVersions: [
        {
          id: "primary",
          title: "Primary",
          albumArtist: "Primary Artist",
          year: 2001,
          isPrimary: true,
          matchStatus: "USER_CONFIRMED",
          musicBrainzReleaseId: "primary-release",
        },
        {
          id: "secondary",
          title: "Secondary",
          albumArtist: "Secondary Artist",
          year: 2002,
          isPrimary: false,
          matchStatus: "NEEDS_REVIEW",
          musicBrainzReleaseId: null,
        },
      ],
      metadata: {
        versions: [
          {
            versionId: "secondary",
            fields: {
              label: field("Secondary Label"),
              catalogNumber: field(null),
              barcode: field(null),
              country: field("GB"),
              releaseDate: field("2002-03-04"),
            },
          },
        ],
      },
    } as unknown as AlbumDetail;

    expect(informationMatchVersion(album, "secondary")).toEqual({
      id: "secondary",
      title: "Secondary",
      albumArtist: "Secondary Artist",
      year: 2002,
      matchStatus: "NEEDS_REVIEW",
      musicBrainzReleaseId: null,
      label: "Secondary Label",
      catalogNumber: null,
      barcode: null,
      country: "GB",
      releaseDate: "2002-03-04",
    });
  });
});
