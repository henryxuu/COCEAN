import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectAudioInventory } from "./discover.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("audio discovery inventory", () => {
  it("counts supported and known-unsupported audio without treating artwork as audio", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-discover-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "Artist", "Album"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "Artist", "Album", "01.flac"), "audio"),
      writeFile(join(root, "Artist", "Album", "02.MKA"), "audio"),
      writeFile(join(root, "Artist", "Album", "SACD.iso"), "image"),
      writeFile(join(root, "Artist", "Album", "concert.VOB"), "disc"),
      writeFile(join(root, "Artist", "Album", "cover.jpg"), "cover"),
      writeFile(join(root, "Artist", "Album", "booklet.pdf"), "booklet"),
      writeFile(join(root, "Artist", "Album", "album.cue"), "cue"),
      writeFile(join(root, "Artist", "Album", "rip.log"), "log"),
      writeFile(join(root, "Artist", "Album", "VIDEO_TS.IFO"), "index"),
      writeFile(join(root, "Artist", "Album", "VIDEO_TS.BUP"), "backup"),
    ]);

    const inventory = await collectAudioInventory(root);
    expect(
      inventory.supported.map((path) => path.slice(root.length + 1)),
    ).toEqual(["Artist/Album/01.flac", "Artist/Album/02.MKA"]);
    expect(
      inventory.unsupported.map((path) => path.slice(root.length + 1)),
    ).toEqual(["Artist/Album/concert.VOB", "Artist/Album/SACD.iso"]);
    expect(inventory.regularFiles).toBe(10);
    expect(inventory.auxiliaryFiles).toBe(6);
    expect(inventory.ignoredFiles).toBe(0);
  });

  it("records symlinks without following them", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-discover-link-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "track.flac"), "audio");
    await symlink("track.flac", join(root, "linked.flac"));

    const inventory = await collectAudioInventory(root);
    expect(inventory.supported).toEqual([join(root, "track.flac")]);
    expect(inventory.symlinks).toEqual([join(root, "linked.flac")]);
  });

  it("skips only explicitly configured relative directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-discover-exclude-"));
    temporaryDirectories.push(root);
    await Promise.all([
      mkdir(join(root, "Artist", "Album"), { recursive: true }),
      mkdir(join(root, "RoonBackups", "database"), { recursive: true }),
      mkdir(join(root, "from-qobuz", "qobuz-venv"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "Artist", "Album", "01.flac"), "audio"),
      writeFile(
        join(root, "RoonBackups", "database", "track.flac"),
        "not music",
      ),
      writeFile(join(root, "from-qobuz", "qobuz-venv", "runtime.py"), "code"),
    ]);

    const inventory = await collectAudioInventory(root, undefined, [
      "RoonBackups",
      "from-qobuz/qobuz-venv",
    ]);

    expect(inventory.supported).toEqual([
      join(root, "Artist", "Album", "01.flac"),
    ]);
    expect(inventory.regularFiles).toBe(1);
    expect(inventory.ignoredFiles).toBe(0);
    expect(
      inventory.excludedDirectories.map((path) => path.slice(root.length + 1)),
    ).toEqual(["from-qobuz/qobuz-venv", "RoonBackups"]);
  });

  it("treats NAS thumbnail files with audio suffixes as auxiliary", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocean-discover-thumb-"));
    temporaryDirectories.push(root);
    const album = join(root, "Artist", "Album");
    const fnosThumbs = join(album, ".@__thumb");
    const synologyThumbs = join(album, "@eaDir", "nested");
    await Promise.all([
      mkdir(fnosThumbs, { recursive: true }),
      mkdir(synologyThumbs, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(album, "01 Real.flac"), "audio"),
      writeFile(join(fnosThumbs, "s10001 Real.flac"), "jpeg thumbnail"),
      writeFile(join(fnosThumbs, "s10002 Real.dsf"), "jpeg thumbnail"),
      writeFile(join(synologyThumbs, "01 Real.wav"), "thumbnail"),
    ]);

    const inventory = await collectAudioInventory(root);
    expect(inventory.supported).toEqual([join(album, "01 Real.flac")]);
    expect(inventory.unsupported).toEqual([]);
    expect(inventory.regularFiles).toBe(4);
    expect(inventory.auxiliaryFiles).toBe(3);
    expect(inventory.ignoredFiles).toBe(0);
  });

  it("turns an unreadable or missing root into traversal evidence", async () => {
    const root = join(tmpdir(), `cocean-missing-${Date.now()}`);
    const inventory = await collectAudioInventory(root);
    expect(inventory.traversalIssues).toEqual([
      { path: root, code: "DIRECTORY_UNREADABLE" },
    ]);
  });
});
