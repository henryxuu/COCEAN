import { describe, expect, it } from "vitest";

import { extractEmbeddedArtwork } from "../src/artwork.js";
import type { FfprobeDocument } from "../src/ffprobe.js";
import {
  normalizeMediaFile,
  normalizeRawTags,
  normalizeTags,
} from "../src/normalize.js";

const fixtureHash = "0".repeat(64);

function probe(
  audioStream: Readonly<Record<string, unknown>>,
  format: Readonly<Record<string, unknown>> = {},
): FfprobeDocument {
  return {
    audioStream: { codec_type: "audio", ...audioStream },
    format,
    streams: [{ codec_type: "audio", ...audioStream }],
  };
}

describe("normalizeMediaFile", () => {
  it("normalizes lossless PCM facts and common tags", () => {
    const result = normalizeMediaFile({
      absolutePath:
        "/music/Sufjan Stevens/Carrie & Lowell/01 Death with Dignity.flac",
      relativePath: "Sufjan Stevens/Carrie & Lowell/01 Death with Dignity.flac",
      sizeBytes: 12_345,
      modifiedAtMs: 1_700_000_000_000,
      fileSha256: fixtureHash,
      metadata: {
        format: {
          container: "FLAC",
          codec: "FLAC",
          lossless: true,
          bitsPerSample: 24,
          sampleRate: 96_000,
          numberOfChannels: 2,
          duration: 245.25,
        },
        common: {
          title: "Death with Dignity",
          album: "Carrie & Lowell",
          artist: "Sufjan Stevens",
          albumartist: "Sufjan Stevens",
          year: 2015,
          genre: ["Indie Folk", "Indie Folk"],
          track: { no: 1, of: 11 },
          disk: { no: 1, of: 1 },
          musicbrainz_albumid: "release-id",
        },
      },
      probe: probe(
        {
          codec_name: "flac",
          sample_rate: "96000",
          bits_per_raw_sample: "24",
          channels: 2,
          duration: "245.25",
          bit_rate: "2800000",
        },
        { format_name: "flac" },
      ),
      artwork: [],
    });

    expect(result.audio).toEqual({
      kind: "PCM",
      codec: "flac",
      container: "FLAC",
      lossless: true,
      bitDepth: 24,
      sampleRate: 96_000,
      bitrate: 2_800_000,
      channels: 2,
      dsdRate: null,
    });
    expect(result.durationSeconds).toBe(245.25);
    expect(result.tags).toMatchObject({
      title: "Death with Dignity",
      album: "Carrie & Lowell",
      albumArtist: "Sufjan Stevens",
      artists: ["Sufjan Stevens"],
      trackNumber: 1,
      trackTotal: 11,
      musicBrainzReleaseId: "release-id",
      genre: ["Indie Folk"],
    });
    expect(result.warnings).toEqual([]);
  });

  it("prefers valid ID3 text when a WAV RIFF reader exposes corrupted legacy text", () => {
    const result = normalizeMediaFile({
      absolutePath: "/music/黑神话：悟空 游戏音乐精选集/01 云宫迅音.wav",
      relativePath: "黑神话：悟空 游戏音乐精选集/01 云宫迅音.wav",
      sizeBytes: 100,
      modifiedAtMs: 1,
      fileSha256: fixtureHash,
      metadata: {
        format: {
          container: "WAVE",
          codec: "PCM",
          lossless: true,
          bitsPerSample: 24,
          sampleRate: 96_000,
          numberOfChannels: 2,
          duration: 10,
        },
        common: {
          title: "4eNw",
          album: "3B:hSn",
          artist: "SNO7?FQ'",
          track: { no: 1, of: 9 },
        },
        native: {
          RIFF: [{ id: "IART", value: "SNO7?FQ'" }],
          "ID3v2.3": [
            { id: "TIT2", value: "云宫迅音" },
            { id: "TALB", value: "黑神话：悟空 游戏音乐精选集" },
            { id: "TPE1", value: "游戏科学" },
          ],
        },
      },
      probe: probe(
        {
          codec_name: "pcm_s24le",
          sample_rate: "96000",
          bits_per_sample: 24,
          channels: 2,
          duration: "10",
        },
        { format_name: "wav" },
      ),
      artwork: [],
    });

    expect(result.tags).toMatchObject({
      title: "云宫迅音",
      album: "黑神话：悟空 游戏音乐精选集",
      artists: ["游戏科学"],
    });
    expect(result.rawTags).toContainEqual({
      source: "RIFF",
      id: "IART",
      valueKind: "TEXT",
      value: "SNO7?FQ'",
    });
  });

  it("prefers valid ffprobe RIFF text when the primary WAV parser returns placeholders", () => {
    const result = normalizeMediaFile({
      absolutePath: "/music/言の葉の庭/A Rainy Morning.wav",
      relativePath: "言の葉の庭/A Rainy Morning.wav",
      sizeBytes: 100,
      modifiedAtMs: 1,
      fileSha256: fixtureHash,
      metadata: {
        format: { container: "WAVE", codec: "PCM", lossless: true },
        common: {
          title: "A Rainy Morning",
          album: "言の葉の庭 サウンドトラック",
          artist: "??? (??? ????)",
          albumartist: "??? (??? ????)",
        },
        native: {
          RIFF: [{ id: "IART", value: "??? (??? ????)" }],
        },
      },
      probe: probe(
        { codec_name: "pcm_s16le", sample_rate: "44100", channels: 2 },
        {
          format_name: "wav",
          tags: {
            album: "言の葉の庭 サウンドトラック",
            artist: "柏大輔 (かしわ だいすけ)",
          },
        },
      ),
      artwork: [],
    });

    expect(result.tags.artists).toEqual(["柏大輔 (かしわ だいすけ)"]);
    expect(result.tags.albumArtist).toBeNull();
  });

  it("classifies DSD rates from both 44.1 kHz and 48 kHz families", () => {
    const dsd64 = normalizeMediaFile({
      absolutePath: "/music/track.dsf",
      relativePath: "track.dsf",
      sizeBytes: 1,
      modifiedAtMs: 1,
      fileSha256: fixtureHash,
      metadata: {
        format: {
          sampleRate: 2_822_400,
          bitsPerSample: 1,
          duration: 10,
        },
        common: {},
      },
      probe: probe({
        codec_name: "dsd_lsbf_planar",
        sample_rate: "352800",
        bits_per_sample: 8,
        channels: 2,
        duration: "10.5",
      }),
      artwork: [],
    });
    const dsd128At48k = normalizeMediaFile({
      absolutePath: "/music/track.dff",
      relativePath: "track.dff",
      sizeBytes: 1,
      modifiedAtMs: 1,
      fileSha256: fixtureHash,
      metadata: { format: {}, common: {} },
      probe: probe({
        codec_name: "dsd_msbf",
        sample_rate: "768000",
        bits_per_sample: 8,
        channels: 2,
      }),
      artwork: [],
    });

    expect(dsd64.audio).toMatchObject({
      kind: "DSD",
      bitDepth: 1,
      sampleRate: 2_822_400,
      dsdRate: "DSD64",
    });
    expect(dsd64.durationSeconds).toBe(10);
    expect(dsd64.warnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TECHNICAL_METADATA_CONFLICT" }),
        expect.objectContaining({ code: "UNRECOGNIZED_DSD_RATE" }),
      ]),
    );
    expect(dsd128At48k.audio).toMatchObject({ kind: "DSD", dsdRate: "DSD128" });
  });

  it("keeps missing player-facing tags visible as quality warnings", () => {
    const result = normalizeMediaFile({
      absolutePath: "/music/Artist/Album/track.flac",
      relativePath: "Artist/Album/track.flac",
      sizeBytes: 1,
      modifiedAtMs: 1,
      fileSha256: fixtureHash,
      metadata: { format: { lossless: true }, common: {} },
      probe: probe({
        codec_name: "flac",
        sample_rate: "44100",
        bits_per_raw_sample: "16",
        channels: 2,
      }),
      artwork: [],
    });

    expect(result.warnings.map(({ code }) => code)).toEqual([
      "MISSING_ALBUM_TAG",
      "MISSING_ARTIST_TAG",
      "MISSING_TITLE_TAG",
      "MISSING_TRACK_NUMBER_TAG",
    ]);
  });

  it.each([
    ["DSD64", 2_822_400],
    ["DSD128", 5_644_800],
    ["DSD256", 11_289_600],
    ["DSD512", 22_579_200],
  ] as const)(
    "maps %s without relying on filename text",
    (expectedRate, sampleRate) => {
      const result = normalizeMediaFile({
        absolutePath: "/music/track.bin",
        relativePath: "track.bin",
        sizeBytes: 1,
        modifiedAtMs: 1,
        fileSha256: fixtureHash,
        metadata: {
          format: { sampleRate, bitsPerSample: 1 },
          common: {},
        },
        probe: probe({
          codec_name: "dsd_lsbf",
          sample_rate: String(sampleRate / 8),
          bits_per_sample: 8,
          channels: 2,
        }),
        artwork: [],
      });

      expect(result.audio).toMatchObject({
        kind: "DSD",
        bitDepth: 1,
        sampleRate,
        dsdRate: expectedRate,
      });
      expect(result.warnings).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "TECHNICAL_METADATA_CONFLICT" }),
          expect.objectContaining({ code: "UNRECOGNIZED_DSD_RATE" }),
        ]),
      );
    },
  );

  it("accepts an ffprobe build that already reports the native DSD clock", () => {
    const result = normalizeMediaFile({
      absolutePath: "/music/native-rate.dsf",
      relativePath: "native-rate.dsf",
      sizeBytes: 1,
      modifiedAtMs: 1,
      fileSha256: fixtureHash,
      metadata: {
        format: { sampleRate: 5_644_800, bitsPerSample: 1 },
        common: {},
      },
      probe: probe({
        codec_name: "dsd_lsbf_planar",
        sample_rate: "5644800",
        bits_per_sample: 1,
        channels: 2,
      }),
      artwork: [],
    });

    expect(result.audio).toMatchObject({
      kind: "DSD",
      bitDepth: 1,
      sampleRate: 5_644_800,
      dsdRate: "DSD128",
    });
    expect(result.warnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TECHNICAL_METADATA_CONFLICT" }),
      ]),
    );
  });

  it("marks 24-bit 352.8 kHz PCM as an inferred DXD candidate", () => {
    const result = normalizeMediaFile({
      absolutePath: "/music/dxd.wav",
      relativePath: "dxd.wav",
      sizeBytes: 1,
      modifiedAtMs: 1,
      fileSha256: fixtureHash,
      metadata: { format: { lossless: true }, common: {} },
      probe: probe({
        codec_name: "pcm_s24le",
        sample_rate: "352800",
        bits_per_sample: 24,
        channels: 2,
      }),
      artwork: [],
    });

    expect(result.audio.kind).toBe("DXD");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "DXD_INFERRED_FROM_PCM_RATE" }),
    );
  });

  it("accepts an explicit DXD media tag without an inference warning", () => {
    const result = normalizeMediaFile({
      absolutePath: "/music/dxd.wav",
      relativePath: "dxd.wav",
      sizeBytes: 1,
      modifiedAtMs: 1,
      fileSha256: fixtureHash,
      metadata: { format: { lossless: true }, common: { media: "DXD" } },
      probe: probe({
        codec_name: "pcm_s24le",
        sample_rate: "384000",
        bits_per_sample: 24,
        channels: 2,
      }),
      artwork: [],
    });

    expect(result.audio).toMatchObject({
      kind: "DXD",
      bitDepth: 24,
      sampleRate: 384_000,
    });
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: "DXD_INFERRED_FROM_PCM_RATE" }),
    );
  });

  it("uses ffprobe technical values and records disagreements", () => {
    const result = normalizeMediaFile({
      absolutePath: "/music/conflict.flac",
      relativePath: "conflict.flac",
      sizeBytes: 1,
      modifiedAtMs: 1,
      fileSha256: fixtureHash,
      metadata: {
        format: {
          lossless: true,
          sampleRate: 44_100,
          bitsPerSample: 16,
          numberOfChannels: 1,
        },
        common: {},
      },
      probe: probe({
        codec_name: "flac",
        sample_rate: "96000",
        bits_per_raw_sample: "24",
        channels: 2,
      }),
      artwork: [],
    });

    expect(result.audio).toMatchObject({
      sampleRate: 96_000,
      bitDepth: 24,
      channels: 2,
    });
    expect(
      result.warnings.filter(
        ({ code }) => code === "TECHNICAL_METADATA_CONFLICT",
      ),
    ).toHaveLength(3);
  });
});

describe("normalizeTags", () => {
  it("normalizes scalar and array common tags without leaking picture data", () => {
    expect(
      normalizeTags({
        title: " Track ",
        artist: "Artist",
        artists: ["Artist", "Guest"],
        catalognumber: ["CAT-001", "CAT-002"],
        barcode: "0123456789012",
        composer: ["Composer"],
        track: { no: "2", of: "10" },
        disk: { no: 1, of: 2 },
      }),
    ).toMatchObject({
      title: "Track",
      artists: ["Artist", "Guest"],
      catalogNumber: "CAT-001",
      barcode: "0123456789012",
      trackNumber: 2,
      trackTotal: 10,
      discNumber: 1,
      discTotal: 2,
    });
  });

  it("preserves non-first disc and per-disc track numbering", () => {
    expect(
      normalizeTags({
        album: "Three Disc Set",
        disk: { no: 2, of: 3 },
        track: { no: 4, of: 9 },
      }),
    ).toMatchObject({
      discNumber: 2,
      discTotal: 3,
      trackNumber: 4,
      trackTotal: 9,
    });
  });
});

describe("normalizeRawTags", () => {
  it("preserves every native tag identity while replacing binary payloads with checksums", () => {
    const raw = normalizeRawTags({
      vorbis: [
        { id: "TITLE", value: "Track" },
        { id: "RATING", value: 5 },
      ],
      ID3v2_4: [
        {
          id: "APIC",
          value: { format: "image/jpeg", data: Buffer.from("private-cover") },
        },
      ],
    });

    expect(raw).toHaveLength(3);
    expect(raw).toContainEqual({
      source: "vorbis",
      id: "TITLE",
      valueKind: "TEXT",
      value: "Track",
    });
    const picture = raw.find(({ id }) => id === "APIC");
    expect(picture).toMatchObject({
      source: "ID3v2_4",
      valueKind: "STRUCTURED",
    });
    expect(picture?.value).toContain('"bytes":13');
    expect(picture?.value).toMatch(/[a-f0-9]{64}/);
    expect(picture?.value).not.toContain("private-cover");
  });
});

describe("extractEmbeddedArtwork", () => {
  it("returns metadata and checksum, never image bytes", () => {
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const result = extractEmbeddedArtwork({
      picture: [
        {
          format: "image/png",
          data: onePixelPng,
          type: 3,
          description: "Front",
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: "EMBEDDED",
      path: null,
      mimeType: "image/png",
      width: 1,
      height: 1,
      bytes: onePixelPng.byteLength,
      kind: "Front Cover",
    });
    expect(result[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result[0]).not.toHaveProperty("data");
  });
});
