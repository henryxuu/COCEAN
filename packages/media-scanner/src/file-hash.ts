import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import { MediaScanError, throwIfAborted } from "./errors.js";

export async function sha256File(
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal, filePath, "hash");
  const digest = createHash("sha256");
  try {
    const stream = createReadStream(filePath, signal ? { signal } : undefined);
    for await (const chunk of stream) {
      throwIfAborted(signal, filePath, "hash");
      digest.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch (error) {
    if (signal?.aborted) throwIfAborted(signal, filePath, "hash");
    throw new MediaScanError("无法计算音频文件校验值", {
      code: "FILE_HASH_FAILED",
      stage: "hash",
      filePath,
      recoverable: true,
      cause: error,
    });
  }
  return digest.digest("hex");
}
