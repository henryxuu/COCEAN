import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
      ? ["start.mjs", "healthcheck.mjs", "backup.mjs", "acceptance-session.mjs"]
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
if (app === "server") {
  const acceptanceWrapper = resolve(runtimeDirectory, "acceptance-session.mjs");
  await access(acceptanceWrapper);
  await access(
    resolve(runtimeDirectory, "node_modules", "better-sqlite3", "package.json"),
  );
  const smokeRoot = await mkdtemp(resolve(tmpdir(), "cocean-session-smoke-"));
  try {
    const databaseModule = await import(
      pathToFileURL(
        resolve(
          runtimeDirectory,
          "node_modules",
          "@cocean",
          "database",
          "dist",
          "index.js",
        ),
      ).href
    );
    const database = new databaseModule.CoceanDatabase(
      resolve(smokeRoot, "cocean.sqlite"),
    );
    const now = new Date().toISOString();
    database.createUser(
      {
        id: "container-smoke-admin",
        username: "container-smoke-admin",
        displayName: "Container Smoke Admin",
        role: "ADMIN",
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      },
      "unused",
    );
    database.close();
    const smokeEnvironment = {
      ...process.env,
      NODE_ENV: "test",
      COCEAN_ACCEPTANCE_SESSION_TEST_ROOT: smokeRoot,
    };
    run(process.execPath, [acceptanceWrapper, "issue"], {
      cwd: runtimeDirectory,
      env: smokeEnvironment,
    });
    run(process.execPath, [acceptanceWrapper, "revoke"], {
      cwd: runtimeDirectory,
      env: smokeEnvironment,
    });
    const inspection = new databaseModule.CoceanDatabase(
      resolve(smokeRoot, "cocean.sqlite"),
    );
    const remaining = inspection.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM app_sessions WHERE id='cocean-acceptance-admin-session-v1'",
      )
      .get();
    inspection.close();
    if (Number(remaining.count) !== 0)
      throw new Error("acceptance Session runtime smoke did not revoke");
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

console.log(`COCEAN ${app} runtime: ${runtimeDirectory}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    stdio: "inherit",
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
