import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  convertLegacyStillCore,
  serializeRuntimeStillCatalog,
} from "../packages/still-catalog/dist/index.js";

const inputIndex = process.argv.indexOf("--input");
const outputIndex = process.argv.indexOf("--output");
const input = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (!input || !output) {
  console.error(
    "usage: pnpm catalog:prepare -- --input <Still core JSON> --output <COCEAN runtime JSON>",
  );
  process.exit(64);
}
const source = JSON.parse(await readFile(resolve(input), "utf8"));
const catalog = convertLegacyStillCore(source);
await writeFile(resolve(output), serializeRuntimeStillCatalog(catalog), {
  flag: "wx",
});
console.log(
  `COCEAN Still runtime catalog: ${catalog.recordCount} records, ${catalog.source.contentVersion}`,
);
