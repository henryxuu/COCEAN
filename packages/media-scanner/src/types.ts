import type { ObservedMediaFile } from "@cocean/contracts";

export interface ScanMediaFileOptions {
  /** Root used to calculate relativePath. Defaults to the file's parent directory. */
  readonly rootPath?: string;
  /** Executable name or absolute path. No shell is involved. */
  readonly ffprobePath?: string;
  /** Hard limit for one ffprobe process. Defaults to 30 seconds. */
  readonly ffprobeTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type MediaScanStage =
  "validate" | "stat" | "hash" | "metadata" | "probe" | "artwork" | "normalize";

export type MediaScanErrorCode =
  | "ABORTED"
  | "FILE_NOT_FOUND"
  | "PATH_NOT_FILE"
  | "PATH_OUTSIDE_ROOT"
  | "FILE_CHANGED_DURING_SCAN"
  | "FILE_HASH_FAILED"
  | "PERMISSION_DENIED"
  | "UNSUPPORTED_MEDIA"
  | "CONTENT_TYPE_MISMATCH"
  | "METADATA_PARSE_FAILED"
  | "FFPROBE_NOT_FOUND"
  | "FFPROBE_TIMEOUT"
  | "FFPROBE_FAILED"
  | "FFPROBE_INVALID_OUTPUT"
  | "INVALID_ARGUMENT"
  | "UNKNOWN";

export interface SerializedMediaScanError {
  readonly name: "MediaScanError";
  readonly code: MediaScanErrorCode;
  readonly stage: MediaScanStage;
  readonly filePath: string | null;
  readonly message: string;
  readonly recoverable: boolean;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export type MediaScanOutcome =
  | { readonly ok: true; readonly value: ObservedMediaFile }
  | {
      readonly ok: false;
      readonly filePath: string;
      readonly error: SerializedMediaScanError;
    };

export interface ScanWarning {
  readonly code: string;
  readonly message: string;
}
