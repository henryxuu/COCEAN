import type {
  MediaScanErrorCode,
  MediaScanStage,
  SerializedMediaScanError,
} from "./types.js";

type ErrorDetail = string | number | boolean | null;

interface MediaScanErrorOptions {
  readonly code: MediaScanErrorCode;
  readonly stage: MediaScanStage;
  readonly filePath?: string | null;
  readonly recoverable?: boolean;
  readonly details?: Readonly<Record<string, ErrorDetail>>;
  readonly cause?: unknown;
}

export class MediaScanError extends Error {
  public readonly code: MediaScanErrorCode;
  public readonly stage: MediaScanStage;
  public readonly filePath: string | null;
  public readonly recoverable: boolean;
  public readonly details: Readonly<Record<string, ErrorDetail>>;

  public constructor(message: string, options: MediaScanErrorOptions) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "MediaScanError";
    this.code = options.code;
    this.stage = options.stage;
    this.filePath = options.filePath ?? null;
    this.recoverable = options.recoverable ?? false;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }

  public toJSON(): SerializedMediaScanError {
    return {
      name: "MediaScanError",
      code: this.code,
      stage: this.stage,
      filePath: this.filePath,
      message: this.message,
      recoverable: this.recoverable,
      details: this.details,
    };
  }
}

export function throwIfAborted(
  signal: AbortSignal | undefined,
  filePath: string | null,
  stage: MediaScanStage,
): void {
  if (!signal?.aborted) return;
  throw new MediaScanError("媒体扫描已取消", {
    code: "ABORTED",
    stage,
    filePath,
    recoverable: true,
    cause: signal.reason,
  });
}

export function mapFileSystemError(
  error: unknown,
  filePath: string,
  stage: MediaScanStage,
): MediaScanError {
  if (error instanceof MediaScanError) return error;

  const code = getErrorCode(error);
  if (code === "ENOENT") {
    return new MediaScanError("音频文件不存在", {
      code: "FILE_NOT_FOUND",
      stage,
      filePath,
      recoverable: true,
      cause: error,
    });
  }
  if (code === "EACCES" || code === "EPERM") {
    return new MediaScanError("没有权限读取音频文件", {
      code: "PERMISSION_DENIED",
      stage,
      filePath,
      recoverable: true,
      cause: error,
    });
  }
  return new MediaScanError("读取音频文件时发生未知错误", {
    code: "UNKNOWN",
    stage,
    filePath,
    recoverable: true,
    cause: error,
  });
}

export function mapMetadataError(
  error: unknown,
  filePath: string,
): MediaScanError {
  if (error instanceof MediaScanError) return error;

  const code = getErrorCode(error);
  if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
    return mapFileSystemError(error, filePath, "metadata");
  }

  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (
    /CouldNotDetermineFileType|UnsupportedFileType/i.test(name) ||
    /unsupported|could not (?:determine|find)|invalid (?:file|format)/i.test(
      message,
    )
  ) {
    return new MediaScanError("文件不是受支持的音频格式", {
      code: "UNSUPPORTED_MEDIA",
      stage: "metadata",
      filePath,
      recoverable: true,
      cause: error,
    });
  }

  return new MediaScanError("无法解析音频标签", {
    code: "METADATA_PARSE_FAILED",
    stage: "metadata",
    filePath,
    recoverable: true,
    cause: error,
  });
}

export function ensureMediaScanError(
  error: unknown,
  filePath: string | null,
  stage: MediaScanStage,
): MediaScanError {
  if (error instanceof MediaScanError) return error;
  return new MediaScanError("媒体扫描失败", {
    code: "UNKNOWN",
    stage,
    filePath,
    recoverable: true,
    cause: error,
  });
}

export function getErrorCode(error: unknown): string | number | null {
  if (typeof error !== "object" || error === null || !("code" in error))
    return null;
  const code = error.code;
  return typeof code === "string" || typeof code === "number" ? code : null;
}
