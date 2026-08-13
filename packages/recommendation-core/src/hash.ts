import { createHash } from "node:crypto";

/** JSON canonicalization with lexicographically ordered object keys. Array order is preserved. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new TypeError("Canonical JSON cannot encode undefined");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/** Matches the v0.10 baseline's SHA-256 first-64-bit deterministic rotation. */
export function stableUnitInterval(value: string): number {
  const digest = createHash("sha256").update(value).digest();
  const prefix = digest.readBigUInt64BE(0);
  return Number(prefix) / Number(0xffff_ffff_ffff_ffffn);
}
