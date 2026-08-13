import { createHash } from "node:crypto";
import {
  stillRuntimeCatalogSchema,
  type StillRuntimeCatalog,
} from "@cocean/contracts";
import { z } from "zod";

const legacyRecordSchema = z
  .object({
    stableEntityID: z.string().min(1),
    entityKind: z.string(),
    canonicalTitle: z.string().min(1),
    primaryArtist: z.string().min(1),
    releaseFamilyID: z.string().nullable().optional(),
    recordingFamilyID: z.string().nullable().optional(),
    musicDomains: z.array(z.string()).default([]),
    eligibleDomains: z.array(z.string()).default([]),
    features: z.array(z.string()).default([]),
    sourceKind: z.string().min(1),
    sourceRef: z.string().min(1),
    verificationStatus: z.string(),
    editorialStatus: z.string(),
    contentVersion: z.string().min(1),
    verifiedAt: z.string(),
  })
  .passthrough();

const legacyPackSchema = z
  .object({
    schemaID: z.string().min(1),
    schemaVersion: z.string().min(1),
    contentVersion: z.string().min(1),
    recordCount: z.number().int().nonnegative(),
    contentChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    records: z.array(legacyRecordSchema),
  })
  .passthrough();

export function convertLegacyStillCore(input: unknown): StillRuntimeCatalog {
  const source = legacyPackSchema.parse(input);
  if (source.recordCount !== source.records.length) {
    throw new Error(
      `Still catalog recordCount ${source.recordCount} does not match ${source.records.length} records`,
    );
  }
  const ids = new Set<string>();
  for (const record of source.records) {
    if (!ids.add(record.stableEntityID))
      throw new Error(
        `Duplicate Still album identity: ${record.stableEntityID}`,
      );
  }
  const eligible = source.records.filter(
    (record) =>
      record.entityKind === "album" &&
      record.verificationStatus === "verified" &&
      record.editorialStatus === "accepted",
  );
  const records = eligible.map((record) => ({
    id: record.stableEntityID,
    title: record.canonicalTitle,
    artist: record.primaryArtist,
    recordingFamilyId: record.recordingFamilyID ?? null,
    releaseFamilyId: record.releaseFamilyID ?? null,
    domains: stableUnique([...record.musicDomains, ...record.eligibleDomains]),
    features: stableUnique(record.features),
    sourceKind: record.sourceKind,
    sourceRef: record.sourceRef,
    verifiedAt: record.verifiedAt,
    contentVersion: source.contentVersion,
  }));
  const unsigned = {
    schemaId: "cocean.still-runtime-catalog" as const,
    schemaVersion: "1.0.0" as const,
    source: {
      schemaId: source.schemaID,
      schemaVersion: source.schemaVersion,
      contentVersion: source.contentVersion,
      contentChecksum: source.contentChecksum,
    },
    recordCount: records.length,
    rejectedRecordCount: source.records.length - records.length,
    records,
  };
  return stillRuntimeCatalogSchema.parse({
    ...unsigned,
    runtimeChecksum: checksum(unsigned),
  });
}

export function parseRuntimeStillCatalog(input: unknown): StillRuntimeCatalog {
  const catalog = stillRuntimeCatalogSchema.parse(input);
  if (catalog.recordCount !== catalog.records.length) {
    throw new Error(
      `Runtime catalog recordCount ${catalog.recordCount} does not match ${catalog.records.length} records`,
    );
  }
  const { runtimeChecksum, ...unsigned } = catalog;
  if (checksum(unsigned) !== runtimeChecksum)
    throw new Error(
      "Runtime Still catalog checksum does not match its content",
    );
  const ids = new Set<string>();
  for (const record of catalog.records) {
    if (record.contentVersion !== catalog.source.contentVersion)
      throw new Error(
        `Catalog record ${record.id} has a different contentVersion`,
      );
    if (!ids.add(record.id))
      throw new Error(`Duplicate runtime Still album identity: ${record.id}`);
  }
  return catalog;
}

export function serializeRuntimeStillCatalog(
  catalog: StillRuntimeCatalog,
): string {
  return `${JSON.stringify(parseRuntimeStillCatalog(catalog), null, 2)}\n`;
}

function checksum(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableUnique(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.normalize("NFKC").toLocaleLowerCase("en-US");
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(trimmed);
    }
  }
  return result;
}
