import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { Client } from "basic-ftp";
import type {
  AlbumDeliveryBundle,
  CoceanDatabase,
  DeliveryConversionType,
  DeliveryFileLocation,
  FrozenAlbumDeliveryBundle,
  FrozenDeliveryArtwork,
  FrozenDeliveryFile,
} from "@cocean/database";
import type { CredentialVault } from "./credential-vault.js";

interface DeliveryCredential {
  password: string;
}

interface PreparedArtwork {
  source: string;
  sizeBytes: number;
  cleanup(): Promise<void>;
}

interface DeliveryFtpClient {
  access(options: {
    host: string;
    port: number;
    user: string;
    password: string;
    secure: false;
  }): Promise<unknown>;
  ensureDir(path: string): Promise<unknown>;
  list(path?: string): Promise<Array<{ name: string; isDirectory?: boolean }>>;
  trackProgress(
    handler: ((info: { bytesOverall: number }) => void) | undefined,
  ): void;
  uploadFrom(source: string, remotePath: string): Promise<unknown>;
  downloadTo(destination: string, remotePath: string): Promise<unknown>;
  size(path: string): Promise<number>;
  remove(path: string): Promise<unknown>;
  removeEmptyDir(path: string): Promise<unknown>;
  close(): void;
}

type DeliveryTransport =
  "USB_MOUNT" | "SMB" | "SFTP" | "FTP" | "AK_FILE_DROP" | "OTHER";

interface UploadedFtpFile {
  remoteDirectory: string;
  name: string;
  sizeBytes: number;
  sha256: string;
}

const execFileAsync = promisify(execFile);
const artworkExtensions = [
  ".avif",
  ".bmp",
  ".gif",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
] as const;

export class DeliveryRunner {
  private active = false;
  private recovered = false;

  constructor(
    private readonly database: CoceanDatabase,
    private readonly vault: CredentialVault,
    private readonly deliveryMountRoot = "/delivery/usb",
    private readonly cacheRoot = "/var/cache/cocean",
    private readonly ffmpegPath = "ffmpeg",
    private readonly ffprobePath = "ffprobe",
    private readonly createFtpClient: () => DeliveryFtpClient = () =>
      new Client(30_000),
  ) {}

  start(): void {
    if (!this.recovered) {
      this.database.recoverInterruptedDeliveries();
      this.recovered = true;
    }
    if (this.active) return;
    this.active = true;
    void this.loop();
  }

  async prepareAlbumDelivery(
    albumId: string,
    targetTransport: DeliveryTransport = "USB_MOUNT",
  ): Promise<FrozenAlbumDeliveryBundle> {
    const bundle = this.database.getAlbumDeliveryBundle(albumId);
    if (!bundle?.files.length) throw new Error("这张专辑没有可投送的数字文件");
    if (targetTransport !== "AK_FILE_DROP")
      return this.prepareLegacyDelivery(bundle);
    const targetAlbumPath = safeAlbumTargetPath(bundle);
    const observedDiscs = new Set(
      bundle.files
        .map((file) => file.discNumberOverride ?? file.discNumber)
        .filter((disc): disc is number => disc !== null),
    );
    const useDiscDirectories = observedDiscs.size >= 2;
    const files: FrozenDeliveryFile[] = [];
    for (const [index, file] of bundle.files.entries()) {
      const source = await safeSource(file, true);
      const sourceSha256 = file.sha256 ?? (await sha256File(source));
      const conversionType = deliveryConversionType(file, bundle);
      const outputExtension =
        conversionType === "APE_TO_FLAC"
          ? ".flac"
          : file.extension || extname(file.relativePath);
      const prepared = await prepareAudioCopy(
        source,
        sourceSha256,
        file,
        bundle,
        conversionType,
        this.cacheRoot,
        this.ffmpegPath,
        this.ffprobePath,
        outputExtension,
      );
      await assertSourceIdentity(source, file.sizeBytes, sourceSha256);
      const disc = file.discNumberOverride ?? file.discNumber;
      const discPath =
        useDiscDirectories && disc !== null
          ? `Disc ${String(disc).padStart(2, "0")}`
          : null;
      const targetName = safeTargetName(file, index, outputExtension);
      files.push({
        ...file,
        sha256: sourceSha256,
        preparedPath: prepared.path,
        outputSizeBytes: prepared.sizeBytes,
        outputSha256: prepared.sha256,
        conversionType,
        targetRelativePath: posix.join(
          targetAlbumPath,
          ...(discPath ? [discPath] : []),
          targetName,
        ),
      });
    }
    const artwork = await prepareCompatibleArtwork(
      bundle,
      this.cacheRoot,
      this.ffmpegPath,
    );
    if (bundle.artwork.url && !artwork)
      throw new Error(
        "专辑封面缓存不可用，已停止投送，避免生成没有封面的播放器副本",
      );
    return {
      ...bundle,
      deliveryProfileVersion: "organized-v2",
      targetAlbumPath,
      files,
      preparedArtwork: artwork
        ? {
            sourceIdentity: bundle.artwork,
            preparedPath: artwork.source,
            sizeBytes: artwork.sizeBytes,
            sha256: await sha256File(artwork.source),
            targetRelativePath: posix.join(targetAlbumPath, "cover.jpg"),
            conversionType: "ARTWORK_JPEG",
          }
        : null,
    };
  }

  private async prepareLegacyDelivery(
    bundle: AlbumDeliveryBundle,
  ): Promise<FrozenAlbumDeliveryBundle> {
    const files: FrozenDeliveryFile[] = [];
    for (const file of bundle.files) {
      const source = await safeSource(file, true);
      files.push({
        ...file,
        sha256: file.sha256 ?? (await sha256File(source)),
      });
    }
    const artwork = await prepareCompatibleArtwork(
      bundle,
      this.cacheRoot,
      this.ffmpegPath,
    );
    if (bundle.artwork.url && !artwork)
      throw new Error(
        "专辑封面缓存不可用，已停止投送，避免生成没有封面的播放器副本",
      );
    return {
      ...bundle,
      files,
      preparedArtwork: artwork
        ? {
            sourceIdentity: bundle.artwork,
            preparedPath: artwork.source,
            sizeBytes: artwork.sizeBytes,
            sha256: await sha256File(artwork.source),
          }
        : null,
    };
  }

  private async loop(): Promise<void> {
    try {
      while (true) {
        const next = this.database
          .listPendingDeliveryJobs()
          .find((job) => job.status === "QUEUED");
        if (!next) return;
        await this.run(next.id);
      }
    } finally {
      this.active = false;
      if (
        this.database
          .listPendingDeliveryJobs()
          .some((job) => job.status === "QUEUED")
      )
        this.start();
    }
  }

  private async run(id: string): Promise<void> {
    const job = this.database.claimDeliveryJob(id);
    if (!job) return;
    const stored = this.database.getStoredDeliveryTarget(job.targetId);
    const frozenBundle = this.database.getDeliveryJobSourceBundle(id);
    if (
      frozenBundle &&
      frozenBundle.deliveryProfileVersion !== undefined &&
      frozenBundle.deliveryProfileVersion !== "organized-v2"
    ) {
      this.database.finishDeliveryJob(id, {
        status: "FAILED",
        fileCount: job.fileCount,
        totalBytes: job.totalBytes,
        transferredBytes: 0,
        manifest: [],
        verified: false,
        error: "冻结投送配置版本不受支持，已停止投送",
      });
      return;
    }
    const bundle =
      frozenBundle ?? this.database.getAlbumDeliveryBundle(job.albumId);
    const files = bundle?.files ?? [];
    const organized = frozenBundle?.deliveryProfileVersion === "organized-v2";
    if (organized && stored?.target.transport !== "AK_FILE_DROP") {
      this.database.finishDeliveryJob(id, {
        status: "FAILED",
        fileCount: job.fileCount,
        totalBytes: job.totalBytes,
        transferredBytes: 0,
        manifest: [],
        verified: false,
        error: "organized-v2 仅允许用于 AK File Drop 目标",
      });
      return;
    }
    let artwork: PreparedArtwork | null = null;
    let totalBytes = frozenBundle
      ? job.totalBytes
      : files.reduce((total, file) => total + file.sizeBytes, 0);
    let fileCount = frozenBundle ? job.fileCount : files.length;
    let transferredBytes = 0;
    const manifest: Array<Record<string, unknown>> = [];
    try {
      if (!stored || !stored.target.enabled)
        throw new Error("投送目标不存在或已停用");
      if (!bundle || !files.length)
        throw new Error("这张专辑没有可投送的数字文件");
      artwork = frozenBundle?.preparedArtwork
        ? await frozenPreparedArtwork(
            frozenBundle.preparedArtwork,
            this.cacheRoot,
          )
        : await prepareCompatibleArtwork(
            bundle,
            this.cacheRoot,
            this.ffmpegPath,
          );
      if (bundle.artwork.url && !artwork)
        throw new Error(
          "专辑封面缓存不可用，已停止投送，避免生成没有封面的播放器副本",
        );
      if (artwork && !frozenBundle) {
        totalBytes += artwork.sizeBytes;
        fileCount += 1;
      }
      this.database.updateDeliveryProgress(id, {
        fileCount,
        totalBytes,
        transferredBytes: 0,
      });
      const albumDirectory = organized
        ? requireOrganizedAlbumPath(frozenBundle)
        : safeAlbumDirectoryName(bundle);
      if (stored.target.transport === "USB_MOUNT") {
        const root = resolve(stored.target.location);
        const allowedRoot = resolve(this.deliveryMountRoot);
        if (
          !isAbsolute(root) ||
          (root !== allowedRoot && !root.startsWith(`${allowedRoot}${sep}`))
        )
          throw new Error("USB 投送路径无效");
        await mkdir(root, { recursive: true });
        const allowedReal = await realpath(allowedRoot);
        const rootReal = await realpath(root);
        assertInside(allowedReal, rootReal, "USB 投送路径超出挂载边界");
        const albumTarget = join(rootReal, albumDirectory);
        await ensureEmptyLocalAlbumDirectory(albumTarget, rootReal);
        const albumTargetReal = await realpath(albumTarget);
        assertInside(rootReal, albumTargetReal, "专辑投送目录超出目标边界");
        for (const [index, file] of files.entries()) {
          const output = await deliveryOutput(
            file,
            frozenBundle,
            albumDirectory,
            index,
            this.cacheRoot,
          );
          const targetWithinAlbum = targetWithinAlbumPath(
            output.targetRelativePath,
            albumDirectory,
          );
          const target = join(albumTargetReal, ...targetWithinAlbum.split("/"));
          const targetParent = dirname(target);
          await mkdir(targetParent, { recursive: true });
          const targetParentReal = await realpath(targetParent);
          assertInside(
            albumTargetReal,
            targetParentReal,
            "音频投送目录超出专辑边界",
          );
          await BunlessCopy(output.source, target);
          transferredBytes += output.sizeBytes;
          manifest.push(
            await manifestEntry(output.source, target, output.sizeBytes, {
              relativePath: output.targetRelativePath,
              kind: "AUDIO",
              sourceRelativePath: file.relativePath,
              sourceSizeBytes: file.sizeBytes,
              sourceSha256: file.sha256,
              conversionType: output.conversionType,
            }),
          );
          this.database.updateDeliveryProgress(id, {
            fileCount,
            totalBytes,
            transferredBytes,
          });
        }
        if (artwork) {
          const artworkTarget = organized
            ? requireOrganizedArtworkPath(frozenBundle)
            : `${albumDirectory}/cover.jpg`;
          const artworkWithinAlbum = targetWithinAlbumPath(
            artworkTarget,
            albumDirectory,
          );
          const target = join(
            albumTargetReal,
            ...artworkWithinAlbum.split("/"),
          );
          await BunlessCopy(artwork.source, target);
          transferredBytes += artwork.sizeBytes;
          manifest.push(
            await manifestEntry(artwork.source, target, artwork.sizeBytes, {
              relativePath: artworkTarget,
              kind: "ARTWORK",
              conversionType: organized ? "ARTWORK_JPEG" : undefined,
            }),
          );
          this.database.updateDeliveryProgress(id, {
            fileCount,
            totalBytes,
            transferredBytes,
          });
        }
      } else if (
        stored.target.transport === "FTP" ||
        stored.target.transport === "AK_FILE_DROP"
      ) {
        if (!stored.credentialJson)
          throw new Error("AK File Drop 尚未配置密码");
        const credential = JSON.parse(
          this.vault.decrypt(stored.credentialJson),
        ) as DeliveryCredential;
        const url = new URL(stored.target.location);
        if (url.protocol !== "ftp:")
          throw new Error("AK File Drop 地址必须是 ftp://");
        const client = this.createFtpClient();
        const uploadedFiles: UploadedFtpFile[] = [];
        let createdAlbumDirectory = false;
        let directory = "/";
        try {
          await client.access({
            host: url.hostname,
            port: url.port ? Number(url.port) : 21,
            user: stored.target.username ?? "anonymous",
            password: credential.password,
            secure: false,
          });
          directory = ftpBaseDirectory(
            url,
            stored.target.transport === "AK_FILE_DROP",
          );
          await client.ensureDir(directory);
          createdAlbumDirectory = await ensureEmptyFtpAlbumDirectory(
            client,
            albumDirectory,
          );
          await client.ensureDir(directory);
          await client.ensureDir(albumDirectory);
          let lastProgressAt = 0;
          let lastPersistedBytes = 0;
          const progressHandler = (info: { bytesOverall: number }) => {
            const current = Math.min(
              totalBytes,
              Math.max(0, info.bytesOverall),
            );
            transferredBytes = Math.max(transferredBytes, current);
            const now = Date.now();
            if (
              current === totalBytes ||
              now - lastProgressAt >= 500 ||
              current - lastPersistedBytes >= 8 * 1024 * 1024
            ) {
              this.database.updateDeliveryProgress(id, {
                fileCount,
                totalBytes,
                transferredBytes: current,
              });
              lastProgressAt = now;
              lastPersistedBytes = current;
            }
          };
          client.trackProgress(progressHandler);
          for (const [index, file] of files.entries()) {
            const output = await deliveryOutput(
              file,
              frozenBundle,
              albumDirectory,
              index,
              this.cacheRoot,
            );
            const targetWithinAlbum = targetWithinAlbumPath(
              output.targetRelativePath,
              albumDirectory,
            );
            const remoteDirectory = posix.dirname(output.targetRelativePath);
            const name = posix.basename(output.targetRelativePath);
            await client.ensureDir(directory);
            await client.ensureDir(remoteDirectory);
            await client.uploadFrom(output.source, name);
            uploadedFiles.push({
              remoteDirectory,
              name,
              sizeBytes: output.sizeBytes,
              sha256: output.sha256,
            });
            const remoteSize = await client.size(name);
            if (remoteSize !== output.sizeBytes)
              throw new Error("FTP 上传后的文件大小校验失败");
            client.trackProgress(undefined);
            await verifyFtpFile(
              client,
              name,
              output.sizeBytes,
              output.sha256,
              this.cacheRoot,
              "FTP 上传后的文件哈希校验失败",
            );
            client.trackProgress(progressHandler);
            transferredBytes = Math.max(
              transferredBytes,
              transferredFromManifest(manifest) + output.sizeBytes,
            );
            manifest.push({
              relativePath: posix.join(albumDirectory, targetWithinAlbum),
              sizeBytes: output.sizeBytes,
              sha256: output.sha256,
              kind: "AUDIO",
              sourceRelativePath: file.relativePath,
              sourceSizeBytes: file.sizeBytes,
              sourceSha256: file.sha256,
              conversionType: output.conversionType,
              verified: true,
            });
            this.database.updateDeliveryProgress(id, {
              fileCount,
              totalBytes,
              transferredBytes,
            });
          }
          if (artwork) {
            const artworkTarget = organized
              ? requireOrganizedArtworkPath(frozenBundle)
              : `${albumDirectory}/cover.jpg`;
            const artworkWithinAlbum = targetWithinAlbumPath(
              artworkTarget,
              albumDirectory,
            );
            const artworkDirectory = posix.dirname(artworkTarget);
            const artworkName = posix.basename(artworkTarget);
            await client.ensureDir(directory);
            await client.ensureDir(artworkDirectory);
            await client.uploadFrom(artwork.source, artworkName);
            const artworkSha256 = organized
              ? frozenBundle.preparedArtwork!.sha256
              : await sha256File(artwork.source);
            uploadedFiles.push({
              remoteDirectory: artworkDirectory,
              name: artworkName,
              sizeBytes: artwork.sizeBytes,
              sha256: artworkSha256,
            });
            const remoteSize = await client.size(artworkName);
            if (remoteSize !== artwork.sizeBytes)
              throw new Error("FTP 封面上传后的文件大小校验失败");
            client.trackProgress(undefined);
            await verifyFtpFile(
              client,
              artworkName,
              artwork.sizeBytes,
              artworkSha256,
              this.cacheRoot,
              "FTP 封面上传后的文件哈希校验失败",
            );
            client.trackProgress(progressHandler);
            transferredBytes = Math.max(
              transferredBytes,
              transferredFromManifest(manifest) + artwork.sizeBytes,
            );
            manifest.push({
              relativePath: posix.join(albumDirectory, artworkWithinAlbum),
              sizeBytes: artwork.sizeBytes,
              sha256: artworkSha256,
              kind: "ARTWORK",
              conversionType: organized ? "ARTWORK_JPEG" : undefined,
              verified: true,
            });
            this.database.updateDeliveryProgress(id, {
              fileCount,
              totalBytes,
              transferredBytes,
            });
          }
        } catch (error) {
          await cleanupIncompleteFtpDelivery(
            client,
            directory,
            albumDirectory,
            createdAlbumDirectory,
            uploadedFiles,
            this.cacheRoot,
          );
          throw error;
        } finally {
          client.close();
        }
      } else {
        throw new Error(
          "该协议尚未实现真实投送；SP3000M 请使用 AK File Drop / FTP",
        );
      }
      assertDeliveryComplete(fileCount, totalBytes, transferredBytes, manifest);
      this.database.finishDeliveryJob(id, {
        status: "COMPLETED",
        fileCount,
        totalBytes,
        transferredBytes,
        manifest,
        verified: true,
        error: null,
      });
    } catch (error) {
      this.database.finishDeliveryJob(id, {
        status: "FAILED",
        fileCount,
        totalBytes,
        transferredBytes,
        manifest,
        verified: false,
        error: safeDeliveryError(error),
      });
    } finally {
      await artwork?.cleanup();
    }
  }
}

async function safeSource(
  file: DeliveryFileLocation,
  verifyFrozenIdentity: boolean,
): Promise<string> {
  const root = await realpath(file.rootPath);
  const candidate = await realpath(resolve(root, file.relativePath));
  assertInside(root, candidate, "投送源超出音乐库边界");
  const facts = await stat(candidate);
  if (!facts.isFile()) throw new Error("投送源不是普通文件");
  if (verifyFrozenIdentity && facts.size !== file.sizeBytes)
    throw new Error("投送源已在任务创建后变化，已停止投送");
  if (
    verifyFrozenIdentity &&
    file.sha256 &&
    (await sha256File(candidate)) !== file.sha256
  )
    throw new Error("投送源校验值已在任务创建后变化，已停止投送");
  return candidate;
}

async function assertSourceIdentity(
  source: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<void> {
  const facts = await stat(source);
  if (
    !facts.isFile() ||
    facts.size !== expectedSize ||
    (await sha256File(source)) !== expectedSha256
  )
    throw new Error("投送源在副本生成期间发生变化，已停止投送");
}

async function deliveryOutput(
  file: DeliveryFileLocation | FrozenDeliveryFile,
  frozenBundle: FrozenAlbumDeliveryBundle | null,
  albumDirectory: string,
  index: number,
  cacheRoot: string,
): Promise<{
  source: string;
  sizeBytes: number;
  sha256: string;
  targetRelativePath: string;
  conversionType: DeliveryConversionType | "LEGACY_COPY";
}> {
  const source = await safeSource(file, Boolean(frozenBundle));
  if (frozenBundle?.deliveryProfileVersion !== "organized-v2") {
    const sha256 = file.sha256 ?? (await sha256File(source));
    return {
      source,
      sizeBytes: file.sizeBytes,
      sha256,
      targetRelativePath: posix.join(
        albumDirectory,
        safeTargetName(file, index),
      ),
      conversionType: "LEGACY_COPY",
    };
  }
  const frozen = file as FrozenDeliveryFile;
  if (
    !frozen.preparedPath ||
    frozen.outputSizeBytes === undefined ||
    !frozen.outputSha256 ||
    !frozen.conversionType ||
    !frozen.targetRelativePath
  )
    throw new Error("organized-v2 冻结音频信息不完整，已停止投送");
  assertSafeTargetRelativePath(frozen.targetRelativePath);
  targetWithinAlbumPath(frozen.targetRelativePath, albumDirectory);
  const prepared = await safePreparedAudio(frozen, cacheRoot);
  return {
    source: prepared,
    sizeBytes: frozen.outputSizeBytes,
    sha256: frozen.outputSha256,
    targetRelativePath: frozen.targetRelativePath,
    conversionType: frozen.conversionType,
  };
}

async function safePreparedAudio(
  file: FrozenDeliveryFile,
  cacheRoot: string,
): Promise<string> {
  const allowedRootReal = await safeCacheSubdirectory(
    cacheRoot,
    "delivery-audio",
  );
  const source = await realpath(file.preparedPath!);
  assertInside(allowedRootReal, source, "冻结音频副本超出投送缓存边界");
  const facts = await stat(source);
  if (!facts.isFile() || facts.size !== file.outputSizeBytes)
    throw new Error("冻结音频副本已在任务创建后变化，已停止投送");
  if ((await sha256File(source)) !== file.outputSha256)
    throw new Error("冻结音频副本校验失败，已停止投送");
  return source;
}

function requireOrganizedAlbumPath(bundle: FrozenAlbumDeliveryBundle): string {
  if (!bundle.targetAlbumPath)
    throw new Error("organized-v2 冻结专辑路径缺失，已停止投送");
  assertSafeTargetRelativePath(bundle.targetAlbumPath);
  return bundle.targetAlbumPath;
}

function requireOrganizedArtworkPath(
  bundle: FrozenAlbumDeliveryBundle,
): string {
  const path = bundle.preparedArtwork?.targetRelativePath;
  if (!path) throw new Error("organized-v2 冻结封面路径缺失，已停止投送");
  assertSafeTargetRelativePath(path);
  targetWithinAlbumPath(path, requireOrganizedAlbumPath(bundle));
  return path;
}

function assertSafeTargetRelativePath(path: string): void {
  if (
    !path ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new Error("冻结目标相对路径无效，已停止投送");
}

function targetWithinAlbumPath(
  targetRelativePath: string,
  albumDirectory: string,
): string {
  const prefix = `${albumDirectory}/`;
  if (!targetRelativePath.startsWith(prefix))
    throw new Error("冻结目标路径超出专辑目录，已停止投送");
  const within = targetRelativePath.slice(prefix.length);
  assertSafeTargetRelativePath(within);
  return within;
}

function safeTargetName(
  file: DeliveryFileLocation,
  index: number,
  outputExtension = file.extension || extname(file.relativePath),
): string {
  const originalName = basename(file.relativePath);
  const originalExtension = extname(originalName);
  const outputName =
    outputExtension === originalExtension
      ? originalName
      : `${
          originalExtension
            ? originalName.slice(0, -originalExtension.length)
            : originalName
        }${outputExtension}`;
  const name = safeSegment(outputName, 220);
  return `${String(index + 1).padStart(3, "0")} ${name || `track-${index + 1}`}`;
}

export function safeAlbumTargetPath(bundle: AlbumDeliveryBundle): string {
  const artist = safeSegment(bundle.albumArtist, 125) || "未知专辑艺术家";
  const year = bundle.year ? ` (${bundle.year})` : "";
  const album = safeSegment(`${bundle.title}${year}`, 125) || "COCEAN Album";
  const readableId = safeSegment(bundle.albumId, 32) || "album";
  const idHash = createHash("sha256")
    .update(bundle.albumId)
    .digest("hex")
    .slice(0, 10);
  return posix.join(artist, `${album} [${readableId}-${idHash}]`);
}

export function safeAlbumDirectoryName(bundle: AlbumDeliveryBundle): string {
  const year = bundle.year ? ` (${bundle.year})` : "";
  const label =
    safeSegment(`${bundle.albumArtist} - ${bundle.title}${year}`, 125) ||
    "COCEAN Album";
  const readableId = safeSegment(bundle.albumId, 32) || "album";
  const idHash = createHash("sha256")
    .update(bundle.albumId)
    .digest("hex")
    .slice(0, 10);
  return `${label} [${readableId}-${idHash}]`;
}

function safeSegment(value: string, maxLength: number): string {
  const sanitized = value
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  const truncated = truncateUtf8(sanitized, maxLength).replace(/[. ]+$/g, "");
  return truncated === "." || truncated === ".." ? "" : truncated;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const point of value) {
    const pointBytes = Buffer.byteLength(point, "utf8");
    if (bytes + pointBytes > maxBytes) break;
    result += point;
    bytes += pointBytes;
  }
  return result;
}

function deliveryConversionType(
  file: DeliveryFileLocation,
  bundle: AlbumDeliveryBundle,
): DeliveryConversionType {
  const extension = file.extension || extname(file.relativePath);
  const format = (file.container ?? extension.replace(/^\./, ""))
    .trim()
    .toLowerCase();
  const isApe = format === "ape" || extension.toLowerCase() === ".ape";
  if (isApe) return "APE_TO_FLAC";
  const tagsMatch =
    normalizedIdentity(file.album) === normalizedIdentity(bundle.title) &&
    normalizedIdentity(file.albumArtist) ===
      normalizedIdentity(bundle.albumArtist);
  if (tagsMatch) return "COPY";
  const isFlac = format === "flac" || extension.toLowerCase() === ".flac";
  if (isFlac) return "FLAC_REMUX";
  throw new Error(
    `暂不支持安全标签规范：${file.relativePath}（${format || "未知格式"}）`,
  );
}

function normalizedIdentity(value: string | null): string {
  return (value ?? "").normalize("NFC").trim();
}

async function prepareAudioCopy(
  source: string,
  sourceSha256: string,
  file: DeliveryFileLocation,
  bundle: AlbumDeliveryBundle,
  conversionType: DeliveryConversionType,
  cacheRoot: string,
  ffmpegPath: string,
  ffprobePath: string,
  outputExtension: string,
): Promise<{ path: string; sizeBytes: number; sha256: string }> {
  const preparedRoot = await safeCacheSubdirectory(cacheRoot, "delivery-audio");
  const extension = safeOutputExtension(outputExtension);
  if (conversionType === "COPY") {
    const output = join(preparedRoot, `${sourceSha256}${extension}`);
    try {
      await copyFile(source, output, constants.COPYFILE_EXCL);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const facts = await stat(output);
    const outputReal = await realpath(output);
    assertInside(preparedRoot, outputReal, "播放器音频缓存超出允许边界");
    if (
      !facts.isFile() ||
      facts.size !== file.sizeBytes ||
      (await sha256File(output)) !== sourceSha256
    )
      throw new Error("播放器副本缓存与源身份不一致，已停止投送");
    return { path: outputReal, sizeBytes: facts.size, sha256: sourceSha256 };
  }

  const temporaryDirectory = await mkdtemp(join(preparedRoot, ".prepare-"));
  const temporaryOutput = join(temporaryDirectory, `output${extension}`);
  try {
    await execFileAsync(
      ffmpegPath,
      [
        "-v",
        "error",
        "-y",
        "-i",
        source,
        "-map",
        "0:a:0",
        "-vn",
        "-map_metadata",
        "-1",
        "-c:a",
        conversionType === "APE_TO_FLAC" ? "flac" : "copy",
        ...(conversionType === "APE_TO_FLAC"
          ? ["-compression_level", "8"]
          : []),
        ...normalizedAudioMetadata(file, bundle),
        temporaryOutput,
      ],
      { timeout: 10 * 60_000, maxBuffer: 1024 * 1024 },
    );
    const facts = await stat(temporaryOutput);
    if (!facts.isFile() || facts.size <= 0)
      throw new Error("播放器音频副本生成失败");
    const outputSha256 = await sha256File(temporaryOutput);
    const output = join(preparedRoot, `${outputSha256}${extension}`);
    try {
      await copyFile(temporaryOutput, output, constants.COPYFILE_EXCL);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const cachedFacts = await stat(output);
    const outputReal = await realpath(output);
    assertInside(preparedRoot, outputReal, "播放器音频缓存超出允许边界");
    if (
      !cachedFacts.isFile() ||
      cachedFacts.size !== facts.size ||
      (await sha256File(output)) !== outputSha256
    )
      throw new Error("播放器音频副本缓存漂移，已停止投送");
    await verifyNormalizedFlac(outputReal, file, bundle, ffprobePath);
    return {
      path: outputReal,
      sizeBytes: cachedFacts.size,
      sha256: outputSha256,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function safeCacheSubdirectory(
  cacheRoot: string,
  name: string,
): Promise<string> {
  const configuredRoot = resolve(cacheRoot);
  await mkdir(configuredRoot, { recursive: true });
  const realRoot = await realpath(configuredRoot);
  const configuredChild = join(configuredRoot, name);
  await mkdir(configuredChild, { recursive: true });
  const realChild = await realpath(configuredChild);
  assertInside(realRoot, realChild, `${name} 缓存超出 cacheRoot 边界`);
  return realChild;
}

async function verifyNormalizedFlac(
  path: string,
  file: DeliveryFileLocation,
  bundle: AlbumDeliveryBundle,
  ffprobePath: string,
): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "format=format_name:format_tags:stream=codec_name,codec_type",
        "-of",
        "json",
        path,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    ));
  } catch {
    throw new Error("播放器音频副本 ffprobe 校验失败");
  }
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error("播放器音频副本 ffprobe 输出无效");
  }
  const format = asRecord(document.format);
  const streams = Array.isArray(document.streams)
    ? document.streams.map(asRecord)
    : [];
  const formatNames = String(format.format_name ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase());
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (!formatNames.includes("flac") || audio?.codec_name !== "flac")
    throw new Error("播放器音频副本不是有效 FLAC");
  const tags = Object.fromEntries(
    Object.entries(asRecord(format.tags)).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  );
  const expected: Record<string, string | null> = {
    album: bundle.title,
    album_artist: bundle.albumArtist,
    title: file.title,
    artist: file.artists.length ? file.artists.join("; ") : null,
    disc: numberedTag(
      file.discNumberOverride ?? file.discNumber,
      file.discTotal,
    ),
    track: numberedTag(file.trackNumber, file.trackTotal),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (value === null) {
      if (tags[key] !== undefined)
        throw new Error(`播放器音频副本包含未观察到的 ${key} 标签`);
    } else if (tags[key] !== value) {
      throw new Error(`播放器音频副本 ${key} 标签校验失败`);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizedAudioMetadata(
  file: DeliveryFileLocation,
  bundle: AlbumDeliveryBundle,
): string[] {
  const metadata: Array<[string, string | null]> = [
    ["album", bundle.title],
    ["album_artist", bundle.albumArtist],
    ["title", file.title],
    ["artist", file.artists.length ? file.artists.join("; ") : null],
    [
      "disc",
      numberedTag(file.discNumberOverride ?? file.discNumber, file.discTotal),
    ],
    ["track", numberedTag(file.trackNumber, file.trackTotal)],
  ];
  return metadata.flatMap(([key, value]) =>
    value === null ? [] : ["-metadata", `${key}=${value}`],
  );
}

function numberedTag(
  value: number | null,
  total: number | null,
): string | null {
  if (!isPositiveInteger(value)) return null;
  return isPositiveInteger(total) && total >= value
    ? `${value}/${total}`
    : String(value);
}

function isPositiveInteger(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value > 0;
}

function safeOutputExtension(value: string): string {
  const extension = value.toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".audio";
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function ftpBaseDirectory(url: URL, akFileDrop: boolean): string {
  const configured = decodeURIComponent(url.pathname || "/").replace(
    /\/+$/g,
    "",
  );
  if (configured && configured !== "/") return configured;
  return akFileDrop ? "/Music" : "/";
}

async function prepareCompatibleArtwork(
  bundle: AlbumDeliveryBundle,
  cacheRoot: string,
  ffmpegPath: string,
): Promise<PreparedArtwork | null> {
  const hash = bundle.artwork.url?.match(
    /^\/api\/v1\/artwork\/([a-f0-9]{64})$/,
  )?.[1];
  if (!hash) return null;
  const artworkRoot = resolve(cacheRoot, "artwork");
  let source: string | null = null;
  for (const extension of artworkExtensions) {
    const candidate = join(artworkRoot, `${hash}${extension}`);
    try {
      await access(candidate);
      source = await realpath(candidate);
      assertInside(artworkRoot, source, "封面缓存超出允许边界");
      break;
    } catch {
      // Try the next supported cache extension.
    }
  }
  if (!source) return null;
  const preparedRoot = resolve(cacheRoot, "delivery-artwork");
  await mkdir(preparedRoot, { recursive: true });
  const output = join(preparedRoot, `${hash}-sp3000m-v1.jpg`);
  try {
    const cached = await stat(output);
    if (cached.isFile() && cached.size > 0)
      return {
        source: output,
        sizeBytes: cached.size,
        cleanup: async () => {},
      };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporaryDirectory = await mkdtemp(join(preparedRoot, ".prepare-"));
  const temporaryOutput = join(temporaryDirectory, "cover.jpg");
  try {
    await execFileAsync(
      ffmpegPath,
      [
        "-v",
        "error",
        "-y",
        "-i",
        source,
        "-vf",
        "scale=w='min(1400,iw)':h='min(1400,ih)':force_original_aspect_ratio=decrease:flags=lanczos",
        "-frames:v",
        "1",
        "-c:v",
        "mjpeg",
        "-q:v",
        "2",
        "-pix_fmt",
        "yuvj420p",
        temporaryOutput,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const result = await stat(temporaryOutput);
    if (!result.isFile() || result.size <= 0)
      throw new Error("兼容封面生成失败");
    await rename(temporaryOutput, output);
    await rm(temporaryDirectory, { recursive: true, force: true });
    return { source: output, sizeBytes: result.size, cleanup: async () => {} };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function frozenPreparedArtwork(
  artwork: FrozenDeliveryArtwork,
  cacheRoot: string,
): Promise<PreparedArtwork> {
  const allowedRoot = resolve(cacheRoot, "delivery-artwork");
  const allowedRootReal = await realpath(allowedRoot);
  const source = await realpath(artwork.preparedPath);
  assertInside(allowedRootReal, source, "冻结封面超出投送缓存边界");
  const facts = await stat(source);
  if (!facts.isFile() || facts.size !== artwork.sizeBytes)
    throw new Error("冻结封面已在任务创建后变化，已停止投送");
  if ((await sha256File(source)) !== artwork.sha256)
    throw new Error("冻结封面校验失败，已停止投送");
  return { source, sizeBytes: facts.size, cleanup: async () => {} };
}

async function ensureEmptyLocalAlbumDirectory(
  path: string,
  allowedRoot: string,
): Promise<void> {
  try {
    const linkFacts = await lstat(path);
    if (linkFacts.isSymbolicLink())
      throw new Error("专辑投送目录是符号链接，未写入目标");
    const existing = await realpath(path);
    assertInside(allowedRoot, existing, "专辑投送目录超出目标边界");
    const facts = await stat(path);
    if (!facts.isDirectory())
      throw new Error("专辑投送目录已被非目录条目占用，未覆盖旧文件");
    if ((await readdir(path)).length)
      throw new Error("专辑投送目录已存在内容，未覆盖或移动旧文件");
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(dirname(path), { recursive: true });
    const parent = await realpath(dirname(path));
    assertInside(allowedRoot, parent, "专辑投送目录父路径超出目标边界");
    await mkdir(path, { recursive: false });
  }
}

async function ensureEmptyFtpAlbumDirectory(
  client: DeliveryFtpClient,
  albumDirectory: string,
): Promise<boolean> {
  const segments = albumDirectory.split("/");
  let parent = "";
  for (const segment of segments.slice(0, -1)) {
    const entry = (await client.list(parent || undefined)).find(
      (item) => item.name === segment,
    );
    if (!entry) return true;
    if (entry.isDirectory === false)
      throw new Error("FTP 专辑目标父路径已被非目录条目占用，未覆盖旧文件");
    parent = posix.join(parent, segment);
  }
  const albumName = segments.at(-1)!;
  const entry = (await client.list(parent || undefined)).find(
    (item) => item.name === albumName,
  );
  if (!entry) return true;
  if (entry.isDirectory === false)
    throw new Error("FTP 专辑目标已被非目录条目占用，未覆盖旧文件");
  if ((await client.list(albumDirectory)).length)
    throw new Error("FTP 专辑目录已存在内容，未覆盖或移动旧文件");
  return false;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function assertInside(root: string, candidate: string, message: string): void {
  const inside = relative(root, candidate);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(message);
}

function transferredFromManifest(
  manifest: Array<Record<string, unknown>>,
): number {
  return manifest.reduce(
    (total, entry) => total + Number(entry.sizeBytes ?? 0),
    0,
  );
}

function assertDeliveryComplete(
  fileCount: number,
  totalBytes: number,
  transferredBytes: number,
  manifest: Array<Record<string, unknown>>,
): void {
  if (
    transferredBytes !== totalBytes ||
    manifest.length !== fileCount ||
    manifest.some((entry) => entry.verified !== true)
  )
    throw new Error("投送完成校验不完整，任务未标记为完成");
}

async function cleanupIncompleteFtpDelivery(
  client: DeliveryFtpClient,
  baseDirectory: string,
  albumDirectory: string,
  createdAlbumDirectory: boolean,
  uploadedFiles: UploadedFtpFile[],
  cacheRoot: string,
): Promise<void> {
  if (!createdAlbumDirectory) return;
  for (const uploaded of [...uploadedFiles].reverse()) {
    try {
      await client.ensureDir(baseDirectory);
      await client.ensureDir(uploaded.remoteDirectory);
      if (
        await ftpFileMatches(
          client,
          uploaded.name,
          uploaded.sizeBytes,
          uploaded.sha256,
          cacheRoot,
        )
      )
        await client.remove(uploaded.name);
    } catch {
      // Fail closed: leave anything that cannot be proven to be ours.
    }
  }
  try {
    await client.ensureDir(baseDirectory);
    if ((await client.list(albumDirectory)).length === 0)
      await client.removeEmptyDir(albumDirectory);
  } catch {
    // A retry will fail closed if unverified partial content remains.
  }
}

async function ftpFileMatches(
  client: DeliveryFtpClient,
  remoteName: string,
  expectedSize: number,
  expectedSha256: string,
  cacheRoot: string,
): Promise<boolean> {
  const verificationRoot = await safeCacheSubdirectory(
    cacheRoot,
    "delivery-verify",
  );
  const temporaryDirectory = await mkdtemp(join(verificationRoot, ".verify-"));
  const localCopy = join(temporaryDirectory, "remote-copy");
  try {
    await client.downloadTo(localCopy, remoteName);
    const facts = await stat(localCopy);
    return (
      facts.isFile() &&
      facts.size === expectedSize &&
      (await sha256File(localCopy)) === expectedSha256
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifyFtpFile(
  client: DeliveryFtpClient,
  remoteName: string,
  expectedSize: number,
  expectedSha256: string,
  cacheRoot: string,
  errorMessage: string,
): Promise<void> {
  const verificationRoot = await safeCacheSubdirectory(
    cacheRoot,
    "delivery-verify",
  );
  const temporaryDirectory = await mkdtemp(join(verificationRoot, ".verify-"));
  const localCopy = join(temporaryDirectory, "remote-copy");
  try {
    await client.downloadTo(localCopy, remoteName);
    const facts = await stat(localCopy);
    if (
      !facts.isFile() ||
      facts.size !== expectedSize ||
      (await sha256File(localCopy)) !== expectedSha256
    )
      throw new Error(errorMessage);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function BunlessCopy(source: string, target: string): Promise<void> {
  await copyFile(source, target, constants.COPYFILE_EXCL);
}

async function manifestEntry(
  source: string,
  path: string,
  sizeBytes: number,
  extra: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const [sourceHash, targetHash] = await Promise.all([
    sha256File(source),
    sha256File(path),
  ]);
  if (sourceHash !== targetHash) throw new Error("U 盘副本校验失败");
  return { ...extra, sizeBytes, sha256: targetHash, verified: true };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function safeDeliveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : "投送失败";
  return message
    .replace(/ftp:\/\/[^\s/@:]+:[^\s/@]+@/gi, "ftp://***:***@")
    .slice(0, 500);
}
