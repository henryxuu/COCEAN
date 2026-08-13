import { z } from "zod";

export const audioKindSchema = z.enum([
  "PCM",
  "DSD",
  "DXD",
  "LOSSY",
  "UNKNOWN",
]);
export type AudioKind = z.infer<typeof audioKindSchema>;

export const audioSpecSchema = z.object({
  kind: audioKindSchema,
  codec: z.string().nullable(),
  container: z.string().nullable(),
  lossless: z.boolean().nullable(),
  bitDepth: z.number().int().positive().nullable(),
  sampleRate: z.number().int().positive().nullable(),
  bitrate: z.number().int().nonnegative().nullable(),
  channels: z.number().int().positive().nullable(),
  dsdRate: z.enum(["DSD64", "DSD128", "DSD256", "DSD512"]).nullable(),
});
export type AudioSpec = z.infer<typeof audioSpecSchema>;

export function formatCompactAudioSpec(spec: AudioSpec): string {
  if (spec.kind === "DSD" && spec.dsdRate) return spec.dsdRate;
  if (spec.kind === "DXD" && spec.bitDepth && spec.sampleRate) {
    return `${spec.bitDepth}/${formatSampleRate(spec.sampleRate)}`;
  }
  if (
    (spec.kind === "PCM" || spec.lossless) &&
    spec.bitDepth &&
    spec.sampleRate
  ) {
    return `${spec.bitDepth}/${formatSampleRate(spec.sampleRate)}`;
  }
  if (spec.kind === "LOSSY" && spec.bitrate)
    return `${Math.round(spec.bitrate / 1000)} kbps`;
  return spec.codec?.toUpperCase() ?? "未知规格";
}

export function formatFullAudioSpec(spec: AudioSpec): string {
  const codec = spec.codec?.toUpperCase();
  if (spec.kind === "UNKNOWN") {
    return ["UNKNOWN", codec].filter(Boolean).join(" · ");
  }
  if (spec.kind === "DSD") {
    const mhz = spec.sampleRate
      ? `${trimZeros(spec.sampleRate / 1_000_000)} MHz`
      : null;
    return [spec.dsdRate ?? "DSD", "1-bit", mhz, codec]
      .filter(Boolean)
      .join(" · ");
  }
  if (spec.kind === "LOSSY") {
    return [
      codec,
      spec.bitrate ? `${Math.round(spec.bitrate / 1000)} kbps` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const classification =
    spec.kind === "DXD" ? "DXD" : isHiResPcm(spec) ? "HI-RES" : "LOSSLESS";
  return [
    classification,
    spec.bitDepth ? `${spec.bitDepth}-bit` : null,
    spec.sampleRate ? `${formatSampleRate(spec.sampleRate)} kHz` : null,
    codec,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function isCdQuality(spec: AudioSpec): boolean {
  return (
    spec.kind === "PCM" && spec.bitDepth === 16 && spec.sampleRate === 44_100
  );
}

export function isHiResPcm(spec: AudioSpec): boolean {
  return (
    spec.kind === "PCM" &&
    spec.lossless === true &&
    spec.bitDepth !== null &&
    spec.bitDepth >= 24 &&
    spec.sampleRate !== null &&
    spec.sampleRate >= 44_100
  );
}

function formatSampleRate(value: number): string {
  return trimZeros(value / 1000);
}

function trimZeros(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(1).replace(/\.0$/, "");
}
