#!/usr/bin/env node

import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  convertLegacyStillCore,
  serializeRuntimeStillCatalog,
} from "../../packages/still-catalog/dist/index.js";

const outputArgument = process.argv[2];
if (!outputArgument) {
  console.error(
    "usage: node infra/scripts/generate_acceptance_catalog.mjs ABSOLUTE_NEW_FILE",
  );
  process.exit(64);
}
const output = resolve(outputArgument);
if (output !== outputArgument) {
  console.error("output must be an absolute path");
  process.exit(64);
}
try {
  await access(output);
  console.error(`output already exists: ${output}`);
  process.exit(73);
} catch {
  // Expected: this fixture generator never overwrites an existing file.
}

const fixtures = [
  [
    "glass-rooms",
    "Glass Rooms",
    "COCEAN Test Artist",
    ["ambient"],
    ["musical.timbre:warm", "musical.dynamics:soft", "musical.form:album-arc"],
  ],
  [
    "midnight-lines",
    "Midnight Lines",
    "Fixture Quartet",
    ["jazz"],
    ["musical.timbre:dark", "musical.density:spacious"],
  ],
  [
    "quiet-current",
    "Quiet Current",
    "Fixture Ensemble",
    ["ambient"],
    ["musical.dynamics:soft", "musical.rhythm:pulse-free"],
  ],
  [
    "warm-circuit",
    "Warm Circuit",
    "Fixture Machines",
    ["electronic"],
    ["musical.timbre:warm", "musical.timbre:electronic"],
  ],
  [
    "clear-forms",
    "Clear Forms",
    "Fixture Soloist",
    ["classical"],
    ["musical.timbre:clear", "musical.form:suite"],
  ],
  [
    "open-field",
    "Open Field",
    "Fixture Trio",
    ["world"],
    ["musical.density:spacious", "musical.timbre:acoustic"],
  ],
  [
    "soft-focus",
    "Soft Focus",
    "Fixture Group",
    ["pop"],
    ["musical.dynamics:soft", "musical.rhythm:steady"],
  ],
  [
    "dark-screen",
    "Dark Screen",
    "Fixture Composer",
    ["soundtrack"],
    ["musical.timbre:dark", "musical.form:continuous"],
  ],
  [
    "air-study",
    "Air Study",
    "Fixture Winds",
    ["classical"],
    ["musical.timbre:airy", "musical.density:sparse"],
  ],
  [
    "steady-room",
    "Steady Room",
    "Fixture Rhythm",
    ["jazz"],
    ["musical.rhythm:steady", "musical.density:balanced"],
  ],
  [
    "lyrical-map",
    "Lyrical Map",
    "Fixture Voice",
    ["world"],
    ["musical.melody:lyrical", "musical.timbre:acoustic"],
  ],
  [
    "album-arc",
    "An Album Arc",
    "Fixture Orchestra",
    ["classical"],
    ["musical.form:album-arc", "musical.dynamics:wide"],
  ],
];

const source = {
  schemaID: "still.local-curated-catalog",
  schemaVersion: "0.8.0",
  contentVersion: "cocean-acceptance-fixture-v1",
  recordCount: fixtures.length,
  contentChecksum: "f".repeat(64),
  records: fixtures.map(([id, title, artist, domains, features]) => ({
    stableEntityID: `album:cocean-fixture:${id}`,
    entityKind: "album",
    canonicalTitle: title,
    primaryArtist: artist,
    releaseFamilyID: `release-family:cocean-fixture:${id}`,
    recordingFamilyID: `recording-family:cocean-fixture:${id}`,
    musicDomains: domains,
    eligibleDomains: domains,
    features,
    sourceKind: "acceptance_fixture",
    sourceRef: `fixture:cocean:${id}`,
    verificationStatus: "verified",
    editorialStatus: "accepted",
    contentVersion: "cocean-acceptance-fixture-v1",
    verifiedAt: "2026-08-12T00:00:00.000Z",
  })),
};

await writeFile(
  output,
  serializeRuntimeStillCatalog(convertLegacyStillCore(source)),
  { flag: "wx" },
);
console.log(`Generated COCEAN acceptance catalog: ${output}`);
