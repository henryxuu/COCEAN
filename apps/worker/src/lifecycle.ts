import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  constants,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type {
  LibraryChangePlan,
  LibraryChangePlanItem,
} from "@cocean/contracts";
import type { CoceanDatabase } from "@cocean/database";
import type { WorkerConfig } from "./config.js";

interface FileIdentity {
  path: string;
  exists: boolean;
  regular: boolean;
  sizeBytes: number | null;
  sha256: string | null;
  error: string | null;
}

const execFileAsync = promisify(execFile);

export async function processNextLifecyclePlan(
  database: CoceanDatabase,
  config: WorkerConfig,
  logger: Logger,
  signal: AbortSignal,
): Promise<boolean> {
  const plan = database.claimNextLibraryChangePlan();
  if (!plan) return false;
  try {
    if (
      config.musicRootPolicy !== "MANAGED" ||
      plan.root.policy !== "MANAGED" ||
      plan.root.id !== "music"
    )
      throw new Error("来源目录不是明确授权的 MANAGED 目录");
    const execution = database.getLibraryChangePlanExecution(plan.id);
    if (!execution) throw new Error("冻结的生命周期计划不存在");
    if (
      resolve(config.musicRoot) !== resolve(execution.rootContainerPath) ||
      resolve(config.quarantineRoot) !== resolve(execution.quarantineRootPath)
    )
      throw new Error("当前来源或隔离目录与冻结计划不一致");
    const runtimeBlockers = database.revalidateRunningLibraryChangePlan(
      plan.id,
    );
    if (runtimeBlockers.length) {
      database.finishLibraryChangePlan(
        plan.id,
        "FAILED",
        runtimeBlockers.map((blocker) => blocker.message).join("；"),
      );
      return true;
    }
    const sourceRoot = await realpath(execution.rootContainerPath);
    const quarantineLexical = resolve(execution.quarantineRootPath);
    if (
      sourceRoot === quarantineLexical ||
      isWithin(sourceRoot, quarantineLexical) ||
      isWithin(quarantineLexical, sourceRoot)
    )
      throw new Error("隔离目录必须位于 Music 来源目录之外");
    const quarantineRoot = await realpath(execution.quarantineRootPath);
    if (
      sourceRoot === quarantineRoot ||
      isWithin(sourceRoot, quarantineRoot) ||
      isWithin(quarantineRoot, sourceRoot)
    )
      throw new Error("隔离目录必须位于 Music 来源目录之外");
    try {
      await Promise.all([
        access(sourceRoot, constants.W_OK),
        access(quarantineRoot, constants.W_OK),
      ]);
    } catch {
      database.finishLibraryChangePlan(
        plan.id,
        "FAILED",
        "来源或隔离目录当前不可写",
      );
      return true;
    }

    const namespaceProblem = await validateQuarantineNamespace(
      plan,
      quarantineRoot,
    );
    if (namespaceProblem) {
      database.finishLibraryChangePlan(
        plan.id,
        "RECOVERY_REQUIRED",
        namespaceProblem,
      );
      return true;
    }

    for (const item of plan.items) {
      if (signal.aborted) return true;
      const problem = await preflightItem(
        plan,
        item,
        sourceRoot,
        quarantineRoot,
      );
      if (problem) {
        const publicError = redactFilesystemPaths(
          problem.error,
          execution.rootContainerPath,
          execution.quarantineRootPath,
        );
        database.updateLibraryChangePlanItem(plan.id, item.ordinal, {
          status: problem.status,
          error: publicError,
        });
        database.finishLibraryChangePlan(
          plan.id,
          "RECOVERY_REQUIRED",
          publicError,
        );
        return true;
      }
    }

    for (const item of plan.items) {
      if (signal.aborted) return true;
      const result = await executeItem(plan, item, sourceRoot, quarantineRoot);
      database.updateLibraryChangePlanItem(plan.id, item.ordinal, result);
      if (result.status === "CONFLICT" || result.status === "MISSING") {
        database.finishLibraryChangePlan(
          plan.id,
          "RECOVERY_REQUIRED",
          result.error ?? "文件状态需要人工恢复",
        );
        return true;
      }
    }
    database.finishLibraryChangePlan(plan.id, "SUCCEEDED");
    logger.info(
      { planId: plan.id, action: plan.action, files: plan.fileCount },
      "library lifecycle plan completed",
    );
  } catch (error) {
    const message = redactFilesystemPaths(
      error instanceof Error ? error.message : String(error),
      config.musicRoot,
      config.quarantineRoot,
    );
    logger.error(
      { planId: plan.id, error: message },
      "library lifecycle plan failed",
    );
    const current = database.getLibraryChangePlan(plan.id);
    if (current?.status === "RUNNING")
      database.finishLibraryChangePlan(plan.id, "RECOVERY_REQUIRED", message);
  }
  return true;
}

async function validateQuarantineNamespace(
  plan: LibraryChangePlan,
  quarantineRoot: string,
): Promise<string | null> {
  const paths = plan.items.map((item) => item.quarantineRelativePath);
  const namespaces = new Set(paths.map((path) => path.split("/")[0]));
  if (namespaces.size !== 1 || namespaces.has(undefined))
    return "冻结清单中的隔离命名空间不一致";
  const namespace = [...namespaces][0]!;
  const namespacePath = safeResolve(quarantineRoot, namespace);
  const allowedFiles = new Set(paths);
  const allowedDirectories = new Set<string>([namespace]);
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1)
      allowedDirectories.add(parts.slice(0, index).join("/"));
  }
  try {
    const rootInfo = await lstat(namespacePath);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
      return "隔离命名空间已被符号链接或非目录节点占用";
  } catch (error) {
    if (isNotFound(error)) return null;
    return error instanceof Error ? error.message : String(error);
  }

  const pending = [namespace];
  while (pending.length) {
    const relativeDirectory = pending.pop()!;
    const entries = await readdir(
      safeResolve(quarantineRoot, relativeDirectory),
      { withFileTypes: true },
    );
    for (const entry of entries) {
      const relativeEntry = `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) return "隔离目录包含未知符号链接";
      if (entry.isDirectory()) {
        if (!allowedDirectories.has(relativeEntry))
          return "隔离目标包含冻结清单之外的目录";
        pending.push(relativeEntry);
      } else if (!entry.isFile() || !allowedFiles.has(relativeEntry)) {
        return "隔离目标包含冻结清单之外的内容";
      }
    }
  }
  return null;
}

async function preflightItem(
  plan: LibraryChangePlan,
  item: LibraryChangePlanItem,
  sourceRoot: string,
  quarantineRoot: string,
): Promise<{ status: "CONFLICT" | "MISSING"; error: string } | null> {
  if (!item.sha256)
    return { status: "CONFLICT", error: "冻结清单缺少 SHA-256" };
  const source = await inspect(
    sourceRoot,
    item.sourceRelativePath,
    item.sha256,
    item.sizeBytes,
  );
  const quarantine = await inspect(
    quarantineRoot,
    item.quarantineRelativePath,
    item.sha256,
    item.sizeBytes,
  );
  if (source.error || quarantine.error)
    return {
      status: "CONFLICT",
      error: source.error ?? quarantine.error ?? "文件状态冲突",
    };
  const sourceMatches = matches(source, item);
  const quarantineMatches = matches(quarantine, item);
  if (source.exists && !sourceMatches)
    return { status: "CONFLICT", error: "来源文件与预览时的校验值不一致" };
  if (quarantine.exists && !quarantineMatches)
    return { status: "CONFLICT", error: "隔离目标已被其他内容占用" };
  if (!source.exists && !quarantine.exists)
    return { status: "MISSING", error: "来源和隔离目录中都找不到冻结文件" };
  return null;
}

async function executeItem(
  plan: LibraryChangePlan,
  item: LibraryChangePlanItem,
  sourceRoot: string,
  quarantineRoot: string,
): Promise<{
  status: "QUARANTINED" | "RESTORED" | "CONFLICT" | "MISSING";
  finalSizeBytes?: number | null;
  finalSha256?: string | null;
  error?: string | null;
}> {
  const expected = item.sha256!;
  const sourcePath = safeResolve(sourceRoot, item.sourceRelativePath);
  const quarantinePath = safeResolve(
    quarantineRoot,
    item.quarantineRelativePath,
  );
  const source = await inspect(
    sourceRoot,
    item.sourceRelativePath,
    expected,
    item.sizeBytes,
  );
  const quarantine = await inspect(
    quarantineRoot,
    item.quarantineRelativePath,
    expected,
    item.sizeBytes,
  );
  const desiredPath =
    plan.action === "QUARANTINE_VERSION" ? quarantinePath : sourcePath;
  const undesiredPath =
    plan.action === "QUARANTINE_VERSION" ? sourcePath : quarantinePath;
  const desired = plan.action === "QUARANTINE_VERSION" ? quarantine : source;
  const undesired = plan.action === "QUARANTINE_VERSION" ? source : quarantine;
  if (desired.exists && undesired.exists) {
    return {
      status: "CONFLICT",
      error:
        matches(desired, item) && matches(undesired, item)
          ? "来源与目标同时存在，需要人工确认保留位置"
          : "来源与目标同时存在且内容不一致",
    };
  } else if (!desired.exists && undesired.exists) {
    await ensureSafeParent(
      plan.action === "QUARANTINE_VERSION" ? quarantineRoot : sourceRoot,
      plan.action === "QUARANTINE_VERSION"
        ? item.quarantineRelativePath
        : item.sourceRelativePath,
    );
    await copyFile(undesiredPath, desiredPath, constants.COPYFILE_EXCL);
    await preserveTimestamps(undesiredPath, desiredPath);
    const copied = await identity(desiredPath);
    if (copied.sizeBytes !== item.sizeBytes || copied.sha256 !== expected)
      return { status: "CONFLICT", error: "复制后的文件校验失败" };
    const unchanged = await identity(undesiredPath);
    if (unchanged.sizeBytes !== item.sizeBytes || unchanged.sha256 !== expected)
      return { status: "CONFLICT", error: "复制期间来源文件发生变化" };
    if (
      (await mtimeNanoseconds(undesiredPath)) !==
      (await mtimeNanoseconds(desiredPath))
    )
      return { status: "CONFLICT", error: "复制期间来源文件时间戳发生变化" };
    const beforeDelete = await lstat(undesiredPath);
    if (
      !beforeDelete.isFile() ||
      beforeDelete.dev !== unchanged.dev ||
      beforeDelete.ino !== unchanged.ino
    )
      return { status: "CONFLICT", error: "删除前来源文件身份发生变化" };
    await unlink(undesiredPath);
  } else if (!desired.exists && !undesired.exists) {
    return { status: "MISSING", error: "来源和目标文件都不存在" };
  }
  const final = await identity(desiredPath);
  if (final.sizeBytes !== item.sizeBytes || final.sha256 !== expected)
    return { status: "CONFLICT", error: "最终文件校验失败" };
  return {
    status: plan.action === "QUARANTINE_VERSION" ? "QUARANTINED" : "RESTORED",
    finalSizeBytes: final.sizeBytes,
    finalSha256: final.sha256,
    error: null,
  };
}

async function preserveTimestamps(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  await execFileAsync("/usr/bin/touch", ["-r", sourcePath, destinationPath], {
    timeout: 5_000,
    windowsHide: true,
  });
}

async function mtimeNanoseconds(path: string): Promise<bigint> {
  return (await stat(path, { bigint: true })).mtimeNs;
}

async function inspect(
  root: string,
  relativePath: string,
  expectedSha256: string,
  expectedSize: number,
): Promise<FileIdentity> {
  let path: string;
  try {
    path = safeResolve(root, relativePath);
  } catch (error) {
    return missingIdentity(relativePath, String(error));
  }
  try {
    const symlinkProblem = await pathSymlinkProblem(root, relativePath);
    if (symlinkProblem) return missingIdentity(path, symlinkProblem);
    const info = await lstat(path);
    if (info.isSymbolicLink()) return missingIdentity(path, "拒绝处理符号链接");
    if (!info.isFile()) return missingIdentity(path, "拒绝处理非普通文件");
    const canonical = await realpath(path);
    if (!isWithin(root, canonical))
      return missingIdentity(path, "文件真实路径越过来源目录边界");
    if (info.size !== expectedSize)
      return {
        path,
        exists: true,
        regular: true,
        sizeBytes: info.size,
        sha256: null,
        error: null,
      };
    const sha256 = await hashFile(path);
    return {
      path,
      exists: true,
      regular: true,
      sizeBytes: info.size,
      sha256,
      error: sha256 === expectedSha256 ? null : null,
    };
  } catch (error) {
    if (isNotFound(error)) return missingIdentity(path, null);
    return missingIdentity(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function pathSymlinkProblem(
  root: string,
  relativePath: string,
): Promise<string | null> {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink())
        return "拒绝处理包含符号链接的路径";
    } catch (error) {
      if (isNotFound(error)) return null;
      return error instanceof Error ? error.message : String(error);
    }
  }
  return null;
}

function matches(file: FileIdentity, item: LibraryChangePlanItem): boolean {
  return (
    file.exists &&
    file.regular &&
    file.sizeBytes === item.sizeBytes &&
    file.sha256 === item.sha256
  );
}

async function ensureSafeParent(
  root: string,
  relativePath: string,
): Promise<void> {
  const target = safeResolve(root, relativePath);
  const parent = dirname(target);
  const rel = relative(root, parent);
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("目标父目录包含符号链接或非目录节点");
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await mkdir(current);
    }
    const canonical = await realpath(current);
    if (!isWithin(root, canonical)) throw new Error("目标父目录越过隔离边界");
  }
}

function safeResolve(root: string, relativePath: string): string {
  if (
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  )
    throw new Error("冻结清单包含不安全的相对路径");
  const target = resolve(root, ...relativePath.split("/"));
  if (!isWithin(root, target)) throw new Error("冻结路径越过来源目录边界");
  return target;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

async function identity(
  path: string,
): Promise<{ sizeBytes: number; sha256: string; dev: number; ino: number }> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("目标不是普通文件");
  return {
    sizeBytes: info.size,
    sha256: await hashFile(path),
    dev: info.dev,
    ino: info.ino,
  };
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function missingIdentity(path: string, error: string | null): FileIdentity {
  return {
    path,
    exists: false,
    regular: false,
    sizeBytes: null,
    sha256: null,
    error,
  };
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT",
  );
}

function redactFilesystemPaths(
  message: string,
  sourceRoot: string,
  quarantineRoot: string,
): string {
  return (
    [
      [resolve(sourceRoot), "[来源目录]"],
      [resolve(quarantineRoot), "[隔离目录]"],
    ] as Array<[string, string]>
  ).reduce(
    (value, [path, replacement]) => value.split(path).join(replacement),
    message,
  );
}
