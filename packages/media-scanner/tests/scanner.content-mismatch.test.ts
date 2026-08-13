import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dependencyMocks = vi.hoisted(() => ({
  parseFile: vi.fn(),
  runFfprobe: vi.fn(),
}));

vi.mock("music-metadata", () => ({
  parseFile: dependencyMocks.parseFile,
}));

vi.mock("../src/ffprobe.js", () => ({
  runFfprobe: dependencyMocks.runFfprobe,
}));

import { MediaScanError } from "../src/errors.js";
import { scanMediaFile } from "../src/scanner.js";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  dependencyMocks.parseFile.mockReset();
  dependencyMocks.runFfprobe.mockReset();

  const metadataError = new Error(
    'FourCC contains invalid characters: ff d8 ff e0 "ÿØÿà"',
  );
  metadataError.name = "FieldDecodingError";
  dependencyMocks.parseFile.mockRejectedValue(metadataError);
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("no-audio probe classification", () => {
  it.each([
    ["jpeg_pipe", "mjpeg"],
    ["png_pipe", "png"],
    ["gif", "gif"],
    ["webp_pipe", "webp"],
  ])(
    "prefers %s image evidence over a metadata decoder failure",
    async (formatName, codecName) => {
      const { filePath, rootPath } = await createInput(".flac");
      dependencyMocks.runFfprobe.mockResolvedValue(
        probeWithoutAudio(formatName, codecName),
      );

      await expect(scanMediaFile(filePath, { rootPath })).rejects.toMatchObject(
        {
          code: "CONTENT_TYPE_MISMATCH",
          stage: "probe",
          recoverable: true,
          details: {
            extension: ".flac",
            detectedFormat: formatName,
          },
        },
      );
      expect(dependencyMocks.parseFile).toHaveBeenCalledOnce();
      expect(dependencyMocks.runFfprobe).toHaveBeenCalledOnce();
    },
  );

  it("keeps a video-only general container as unsupported media", async () => {
    const { filePath, rootPath } = await createInput(".mp4");
    dependencyMocks.runFfprobe.mockResolvedValue(
      probeWithoutAudio("mov,mp4,m4a,3gp,3g2,mj2", "h264"),
    );

    await expect(scanMediaFile(filePath, { rootPath })).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA",
      stage: "probe",
      recoverable: true,
    });
  });

  it("preserves a genuine metadata failure when an audio stream exists", async () => {
    const { filePath, rootPath } = await createInput(".flac");
    const audioStream = Object.freeze({
      codec_type: "audio",
      codec_name: "flac",
    });
    dependencyMocks.runFfprobe.mockResolvedValue(
      Object.freeze({
        format: Object.freeze({ format_name: "flac" }),
        audioStream,
        streams: Object.freeze([audioStream]),
      }),
    );

    await expect(scanMediaFile(filePath, { rootPath })).rejects.toMatchObject({
      code: "METADATA_PARSE_FAILED",
      stage: "metadata",
      recoverable: true,
    });
  });

  it("preserves an ffprobe failure for corrupt audio", async () => {
    const { filePath, rootPath } = await createInput(".flac");
    dependencyMocks.runFfprobe.mockRejectedValue(
      new MediaScanError("ffprobe 无法解析音频流", {
        code: "FFPROBE_FAILED",
        stage: "probe",
        filePath,
        recoverable: true,
      }),
    );

    await expect(scanMediaFile(filePath, { rootPath })).rejects.toMatchObject({
      code: "FFPROBE_FAILED",
      stage: "probe",
      recoverable: true,
    });
  });
});

async function createInput(
  extension: string,
): Promise<{ filePath: string; rootPath: string }> {
  const rootPath = await mkdtemp(join(tmpdir(), "cocean-content-type-"));
  temporaryDirectories.push(rootPath);
  const filePath = join(rootPath, `disguised${extension}`);
  await writeFile(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  return { filePath, rootPath };
}

function probeWithoutAudio(formatName: string, codecName: string) {
  const stream = Object.freeze({
    codec_type: "video",
    codec_name: codecName,
  });
  return Object.freeze({
    format: Object.freeze({ format_name: formatName }),
    audioStream: null,
    streams: Object.freeze([stream]),
  });
}
