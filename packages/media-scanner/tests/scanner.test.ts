import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MediaScanError } from "../src/errors.js";
import { runFfprobe } from "../src/ffprobe.js";
import {
  classifyAudioPath,
  isSupportedAudioPath,
  scanMediaFile,
  scanMediaFiles,
} from "../src/scanner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("scanner validation", () => {
  it("recognizes supported paths case-insensitively", () => {
    expect(isSupportedAudioPath("Album/Track.FLAC")).toBe(true);
    expect(isSupportedAudioPath("Album/Track.dsf")).toBe(true);
    expect(isSupportedAudioPath("Album/Track.mka")).toBe(true);
    expect(isSupportedAudioPath("Album/cover.jpg")).toBe(false);
    expect(classifyAudioPath("Album/SACD.iso")).toBe("KNOWN_UNSUPPORTED");
    expect(classifyAudioPath("Album/AUDIO_TS/ATS_01_1.AOB")).toBe(
      "KNOWN_UNSUPPORTED",
    );
    expect(classifyAudioPath("Album/VIDEO_TS/VTS_01_1.VOB")).toBe(
      "KNOWN_UNSUPPORTED",
    );
    expect(classifyAudioPath("Album/booklet.pdf")).toBe("NON_AUDIO");
  });

  it("classifies a missing file before starting metadata tools", async () => {
    const missingPath = resolve("/tmp/cocean-definitely-missing-audio.flac");
    await expect(scanMediaFile(missingPath)).rejects.toMatchObject<
      Partial<MediaScanError>
    >({
      name: "MediaScanError",
      code: "FILE_NOT_FOUND",
      stage: "stat",
      filePath: missingPath,
    });
  });

  it("classifies cancellation before touching the source", async () => {
    const controller = new AbortController();
    controller.abort("test cancellation");
    await expect(
      scanMediaFile("/tmp/cocean-cancelled.flac", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject<Partial<MediaScanError>>({
      code: "ABORTED",
      stage: "validate",
    });
  });

  it("classifies a missing ffprobe executable", async () => {
    await expect(
      runFfprobe("/tmp/cocean-probe-input.flac", {
        executable: "/cocean/does-not-exist/ffprobe",
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject<Partial<MediaScanError>>({
      code: "FFPROBE_NOT_FOUND",
      stage: "probe",
      recoverable: false,
    });
  });

  it("rejects a lexical path outside the configured library root", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "cocean-root-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "cocean-outside-"));
    temporaryDirectories.push(rootDirectory, outsideDirectory);
    const outsideFile = join(outsideDirectory, "outside.flac");
    await writeFile(outsideFile, "not audio");

    await expect(
      scanMediaFile(outsideFile, {
        rootPath: rootDirectory,
        ffprobePath: "/cocean/should-not-run/ffprobe",
      }),
    ).rejects.toMatchObject<Partial<MediaScanError>>({
      code: "PATH_OUTSIDE_ROOT",
      stage: "validate",
      filePath: outsideFile,
    });
  });

  it("rejects an in-root symlink whose canonical target escapes the root", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "cocean-root-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "cocean-outside-"));
    temporaryDirectories.push(rootDirectory, outsideDirectory);
    const outsideFile = join(outsideDirectory, "outside.flac");
    const linkedFile = join(rootDirectory, "linked.flac");
    await writeFile(outsideFile, "not audio");
    await symlink(outsideFile, linkedFile);

    await expect(
      scanMediaFile(linkedFile, {
        rootPath: rootDirectory,
        ffprobePath: "/cocean/should-not-run/ffprobe",
      }),
    ).rejects.toMatchObject<Partial<MediaScanError>>({
      code: "PATH_OUTSIDE_ROOT",
      stage: "validate",
      filePath: linkedFile,
    });
  });

  it("returns per-file errors from the batch iterator", async () => {
    const outcomes = [];
    for await (const outcome of scanMediaFiles([
      "/tmp/cocean-missing-one.flac",
    ])) {
      outcomes.push(outcome);
    }
    expect(outcomes).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "FILE_NOT_FOUND" }),
      }),
    ]);
  });
});
