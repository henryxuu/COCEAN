import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const app = process.argv[2];
if (!app || !new Set(["web", "server", "worker"]).has(app)) {
  console.error("usage: node scripts/build-container.mjs <web|server|worker>");
  process.exit(64);
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const appDirectory = resolve(repositoryRoot, "apps", app);
const runtimeDirectory = resolve(appDirectory, ".cocean-runtime");

await rm(resolve(appDirectory, "dist"), { recursive: true, force: true });
run("pnpm", ["--filter", `@cocean/${app}...`, "run", "build"]);
await rm(runtimeDirectory, { recursive: true, force: true });

if (app === "web") {
  await mkdir(runtimeDirectory, { recursive: true });
  await cp(resolve(appDirectory, "dist"), resolve(runtimeDirectory, "public"), {
    recursive: true,
  });
  await writeFile(
    resolve(runtimeDirectory, "package.json"),
    `${JSON.stringify({ name: "@cocean/web-runtime", version: "0.1.0", private: true, type: "module" }, null, 2)}\n`,
  );
} else {
  run("pnpm", [
    "--filter",
    `@cocean/${app}`,
    "deploy",
    "--prod",
    runtimeDirectory,
  ]);
}

const wrapperNames =
  app === "worker"
    ? [
        "start.mjs",
        "healthcheck.mjs",
        "provider.mjs",
        "provider-healthcheck.mjs",
      ]
    : app === "server"
      ? ["start.mjs", "healthcheck.mjs", "backup.mjs"]
      : ["start.mjs", "healthcheck.mjs"];
for (const name of wrapperNames) {
  await cp(
    resolve(appDirectory, "container", name),
    resolve(runtimeDirectory, name),
  );
}
if (app === "web") {
  await cp(
    resolve(appDirectory, "container", "security.mjs"),
    resolve(runtimeDirectory, "security.mjs"),
  );
}

for (const required of ["start.mjs", "healthcheck.mjs", "package.json"]) {
  await access(resolve(runtimeDirectory, required));
}

console.log(`COCEAN ${app} runtime: ${runtimeDirectory}`);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
