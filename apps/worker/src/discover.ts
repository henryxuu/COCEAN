import { opendir, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { classifyAudioPath } from "@cocean/media-scanner";

const AUXILIARY_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".bup",
  ".cue",
  ".doc",
  ".docx",
  ".gif",
  ".jpeg",
  ".jpg",
  ".ifo",
  ".lrc",
  ".log",
  ".m3u",
  ".m3u8",
  ".md5",
  ".nfo",
  ".pdf",
  ".png",
  ".tif",
  ".tiff",
  ".txt",
  ".url",
  ".webp",
]);

// FNOS and common NAS/indexing tools keep generated cover thumbnails in these
// directories. Some thumbnails retain the source track's .flac/.dsf suffix,
// so extension-only discovery must treat the directory boundary as stronger
// evidence than the filename. They remain part of the immutable Music
// manifest/regular-file count, but are never opened as audio candidates.
const RESERVED_AUXILIARY_DIRECTORY_NAMES = new Set([
  ".@__thumb",
  ".appledouble",
  "@eadir",
]);

export interface TraversalIssue {
  path: string;
  code: "DIRECTORY_UNREADABLE";
}

export interface AudioInventory {
  supported: string[];
  unsupported: string[];
  symlinks: string[];
  traversalIssues: TraversalIssue[];
  excludedDirectories: string[];
  regularFiles: number;
  auxiliaryFiles: number;
  ignoredFiles: number;
  fileFacts: Array<{
    path: string;
    sizeBytes: number;
    modifiedAtMs: number;
  }>;
}

export type DiscoveredLibraryEntry =
  | {
      path: string;
      kind:
        | "SUPPORTED_AUDIO"
        | "KNOWN_UNSUPPORTED_AUDIO"
        | "AUXILIARY"
        | "IGNORED"
        | "EXCLUDED_DIRECTORY"
        | "SYMLINK";
      sizeBytes?: number;
      modifiedAtMs?: number;
    }
  | { path: string; kind: "TRAVERSAL_ERROR"; code: "DIRECTORY_UNREADABLE" };

export async function* discoverLibraryEntries(
  rootPath: string,
  signal?: AbortSignal,
  excludedRelativeDirectories: readonly string[] = [],
): AsyncGenerator<DiscoveredLibraryEntry> {
  const root = resolve(rootPath);
  const excluded = new Set(excludedRelativeDirectories);
  const pending = [root];
  while (pending.length) {
    if (signal?.aborted) return;
    const current = pending.pop()!;
    let directory;
    try {
      directory = await opendir(current);
    } catch {
      yield {
        path: current,
        kind: "TRAVERSAL_ERROR",
        code: "DIRECTORY_UNREADABLE",
      };
      continue;
    }
    try {
      for await (const entry of directory) {
        if (signal?.aborted) return;
        const path = join(current, entry.name);
        if (entry.isSymbolicLink()) {
          yield { path, kind: "SYMLINK" };
          continue;
        }
        if (entry.isDirectory()) {
          const relativeDirectory = relative(root, path).split(sep).join("/");
          if (excluded.has(relativeDirectory)) {
            yield { path, kind: "EXCLUDED_DIRECTORY" };
            continue;
          }
          pending.push(path);
          continue;
        }
        if (!entry.isFile()) continue;
        let information;
        try {
          information = await stat(path);
        } catch {
          yield {
            path,
            kind: "TRAVERSAL_ERROR",
            code: "DIRECTORY_UNREADABLE",
          };
          continue;
        }
        const fact = {
          sizeBytes: information.size,
          modifiedAtMs: information.mtimeMs,
        };
        if (isReservedAuxiliaryPath(root, path)) {
          yield { path, kind: "AUXILIARY", ...fact };
          continue;
        }
        const classification = classifyAudioPath(path);
        if (classification === "SUPPORTED") {
          yield { path, kind: "SUPPORTED_AUDIO", ...fact };
        } else if (classification === "KNOWN_UNSUPPORTED") {
          yield { path, kind: "KNOWN_UNSUPPORTED_AUDIO", ...fact };
        } else if (AUXILIARY_EXTENSIONS.has(extname(path).toLowerCase())) {
          yield { path, kind: "AUXILIARY", ...fact };
        } else {
          yield { path, kind: "IGNORED", ...fact };
        }
      }
    } catch {
      yield {
        path: current,
        kind: "TRAVERSAL_ERROR",
        code: "DIRECTORY_UNREADABLE",
      };
    }
  }
}

export async function* discoverAudioFiles(
  rootPath: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  for await (const entry of discoverLibraryEntries(rootPath, signal))
    if (entry.kind === "SUPPORTED_AUDIO") yield entry.path;
}

export async function collectAudioFiles(
  rootPath: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const files: string[] = [];
  for await (const file of discoverAudioFiles(rootPath, signal))
    files.push(file);
  return files.sort((a, b) => a.localeCompare(b));
}

export async function collectAudioInventory(
  rootPath: string,
  signal?: AbortSignal,
  excludedRelativeDirectories: readonly string[] = [],
): Promise<AudioInventory> {
  const inventory: AudioInventory = {
    supported: [],
    unsupported: [],
    symlinks: [],
    traversalIssues: [],
    excludedDirectories: [],
    regularFiles: 0,
    auxiliaryFiles: 0,
    ignoredFiles: 0,
    fileFacts: [],
  };
  for await (const entry of discoverLibraryEntries(
    rootPath,
    signal,
    excludedRelativeDirectories,
  )) {
    if (
      "sizeBytes" in entry &&
      entry.sizeBytes !== undefined &&
      entry.modifiedAtMs !== undefined
    )
      inventory.fileFacts.push({
        path: entry.path,
        sizeBytes: entry.sizeBytes,
        modifiedAtMs: entry.modifiedAtMs,
      });
    switch (entry.kind) {
      case "SUPPORTED_AUDIO":
        inventory.regularFiles += 1;
        inventory.supported.push(entry.path);
        break;
      case "KNOWN_UNSUPPORTED_AUDIO":
        inventory.regularFiles += 1;
        inventory.unsupported.push(entry.path);
        break;
      case "AUXILIARY":
        inventory.regularFiles += 1;
        inventory.auxiliaryFiles += 1;
        break;
      case "IGNORED":
        inventory.regularFiles += 1;
        inventory.ignoredFiles += 1;
        break;
      case "EXCLUDED_DIRECTORY":
        inventory.excludedDirectories.push(entry.path);
        break;
      case "SYMLINK":
        inventory.symlinks.push(entry.path);
        break;
      case "TRAVERSAL_ERROR":
        inventory.traversalIssues.push({ path: entry.path, code: entry.code });
        break;
    }
  }
  inventory.supported.sort((a, b) => a.localeCompare(b));
  inventory.unsupported.sort((a, b) => a.localeCompare(b));
  inventory.symlinks.sort((a, b) => a.localeCompare(b));
  inventory.traversalIssues.sort((a, b) => a.path.localeCompare(b.path));
  inventory.excludedDirectories.sort((a, b) => a.localeCompare(b));
  inventory.fileFacts.sort((a, b) => a.path.localeCompare(b.path));
  return inventory;
}

function isReservedAuxiliaryPath(root: string, path: string): boolean {
  const parts = relative(root, path).split(sep);
  return parts
    .slice(0, -1)
    .some((part) =>
      RESERVED_AUXILIARY_DIRECTORY_NAMES.has(part.toLocaleLowerCase("en-US")),
    );
}
