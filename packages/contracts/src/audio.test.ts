import { describe, expect, it } from "vitest";
import {
  formatCompactAudioSpec,
  formatFullAudioSpec,
  isCdQuality,
  isHiResPcm,
} from "./audio.js";

describe("audio display contract", () => {
  it("keeps digital CD quality separate from the physical CD tag", () => {
    const spec = {
      kind: "PCM" as const,
      codec: "flac",
      container: "flac",
      lossless: true,
      bitDepth: 16,
      sampleRate: 44_100,
      bitrate: 800_000,
      channels: 2,
      dsdRate: null,
    };
    expect(isCdQuality(spec)).toBe(true);
    expect(formatCompactAudioSpec(spec)).toBe("16/44.1");
    expect(formatFullAudioSpec(spec)).toBe(
      "LOSSLESS · 16-bit · 44.1 kHz · FLAC",
    );
  });

  it("does not label 16-bit PCM as Hi-Res solely because it is 48 kHz", () => {
    const spec = {
      kind: "PCM" as const,
      codec: "flac",
      container: "flac",
      lossless: true,
      bitDepth: 16,
      sampleRate: 48_000,
      bitrate: 900_000,
      channels: 2,
      dsdRate: null,
    };
    expect(isHiResPcm(spec)).toBe(false);
    expect(formatFullAudioSpec(spec)).toBe("LOSSLESS · 16-bit · 48 kHz · FLAC");
  });

  it("labels verified 24-bit lossless PCM as Hi-Res", () => {
    const spec = {
      kind: "PCM" as const,
      codec: "flac",
      container: "flac",
      lossless: true,
      bitDepth: 24,
      sampleRate: 44_100,
      bitrate: 1_200_000,
      channels: 2,
      dsdRate: null,
    };
    expect(isHiResPcm(spec)).toBe(true);
    expect(formatFullAudioSpec(spec)).toContain("HI-RES");
  });

  it("uses a DSD multiplier instead of PCM notation", () => {
    const spec = {
      kind: "DSD" as const,
      codec: "dsf",
      container: "dsf",
      lossless: true,
      bitDepth: 1,
      sampleRate: 5_644_800,
      bitrate: 11_289_600,
      channels: 2,
      dsdRate: "DSD128" as const,
    };
    expect(formatCompactAudioSpec(spec)).toBe("DSD128");
    expect(formatFullAudioSpec(spec)).toBe("DSD128 · 1-bit · 5.6 MHz · DSF");
  });

  it("never presents an unknown stream as verified lossless audio", () => {
    const spec = {
      kind: "UNKNOWN" as const,
      codec: "mystery",
      container: null,
      lossless: null,
      bitDepth: null,
      sampleRate: null,
      bitrate: null,
      channels: null,
      dsdRate: null,
    };
    expect(formatCompactAudioSpec(spec)).toBe("MYSTERY");
    expect(formatFullAudioSpec(spec)).toBe("UNKNOWN · MYSTERY");
  });
});
