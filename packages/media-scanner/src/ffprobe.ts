import { execFile } from "node:child_process";

import { getErrorCode, MediaScanError, throwIfAborted } from "./errors.js";

export interface FfprobeDocument {
  readonly format: Readonly<Record<string, unknown>> | null;
  readonly audioStream: Readonly<Record<string, unknown>> | null;
  readonly streams: readonly Readonly<Record<string, unknown>>[];
}

interface RunFfprobeOptions {
  readonly executable: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Logical library path used in errors when filePath is a canonical target. */
  readonly reportedFilePath?: string;
}

const MAX_FFPROBE_OUTPUT_BYTES = 8 * 1024 * 1024;

export async function runFfprobe(
  filePath: string,
  options: RunFfprobeOptions,
): Promise<FfprobeDocument> {
  const reportedFilePath = options.reportedFilePath ?? filePath;
  throwIfAborted(options.signal, reportedFilePath, "probe");

  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ];

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      options.executable,
      args,
      {
        encoding: "utf8",
        maxBuffer: MAX_FFPROBE_OUTPUT_BYTES,
        timeout: options.timeoutMs,
        signal: options.signal,
      },
      (error, processStdout, processStderr) => {
        if (!error) {
          resolve(processStdout);
          return;
        }

        if (options.signal?.aborted || error.name === "AbortError") {
          reject(
            new MediaScanError("ffprobe 已取消", {
              code: "ABORTED",
              stage: "probe",
              filePath: reportedFilePath,
              recoverable: true,
              cause: error,
            }),
          );
          return;
        }

        const code = getErrorCode(error);
        if (code === "ENOENT") {
          reject(
            new MediaScanError("找不到 ffprobe，请在 NAS 系统中安装 ffmpeg", {
              code: "FFPROBE_NOT_FOUND",
              stage: "probe",
              filePath: reportedFilePath,
              recoverable: false,
              details: { executable: options.executable },
              cause: error,
            }),
          );
          return;
        }

        if (error.killed || code === "ETIMEDOUT") {
          reject(
            new MediaScanError("ffprobe 解析超时", {
              code: "FFPROBE_TIMEOUT",
              stage: "probe",
              filePath: reportedFilePath,
              recoverable: true,
              details: { timeoutMs: options.timeoutMs },
              cause: error,
            }),
          );
          return;
        }

        reject(
          new MediaScanError("ffprobe 无法解析音频流", {
            code: "FFPROBE_FAILED",
            stage: "probe",
            filePath: reportedFilePath,
            recoverable: true,
            details: {
              exitCode: typeof code === "number" ? code : null,
              stderr: truncate(processStderr.trim(), 600),
            },
            cause: error,
          }),
        );
      },
    );
  });

  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch (error) {
    throw new MediaScanError("ffprobe 返回了无效 JSON", {
      code: "FFPROBE_INVALID_OUTPUT",
      stage: "probe",
      filePath: reportedFilePath,
      recoverable: true,
      cause: error,
    });
  }

  if (!isRecord(decoded)) {
    throw new MediaScanError("ffprobe 返回结构不正确", {
      code: "FFPROBE_INVALID_OUTPUT",
      stage: "probe",
      filePath: reportedFilePath,
      recoverable: true,
    });
  }

  const streams = Array.isArray(decoded.streams)
    ? decoded.streams
        .filter(isRecord)
        .map((stream) => Object.freeze({ ...stream }))
    : [];
  const audioStream =
    streams.find((stream) => stream.codec_type === "audio") ?? null;
  const format = isRecord(decoded.format)
    ? Object.freeze({ ...decoded.format })
    : null;

  return Object.freeze({ format, audioStream, streams });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}
