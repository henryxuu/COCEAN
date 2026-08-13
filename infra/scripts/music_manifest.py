#!/usr/bin/env python3
"""Create and compare a read-only metadata/SHA-256 manifest for a Music library."""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import os
from pathlib import Path
import stat
import sys
from typing import Iterator, TextIO


SCHEMA = "cocean.music-manifest/v2"


def fail(message: str, code: int = 1) -> "None":
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(code)


def resolved(path: Path) -> Path:
    return path.expanduser().resolve(strict=False)


def ensure_external_output(root: Path, output: Path) -> None:
    root_real = resolved(root)
    output_real = resolved(output)
    if output_real == root_real or root_real in output_real.parents:
        fail("manifest output must be outside the read-only Music root")


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalize_excluded_directories(value: str) -> tuple[str, ...]:
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        fail("excluded directories must be a JSON string array", 64)
    if not isinstance(decoded, list) or len(decoded) > 128:
        fail("excluded directories must contain at most 128 entries", 64)
    normalized: list[str] = []
    for item in decoded:
        if not isinstance(item, str):
            fail("excluded directories may contain only strings", 64)
        directory = item.strip()
        parts = directory.split("/")
        if (
            not directory
            or len(directory) > 500
            or directory.startswith("/")
            or directory.endswith("/")
            or "\\" in directory
            or "\x00" in directory
            or any(part in {"", ".", ".."} for part in parts)
        ):
            fail("excluded directories must be safe library-relative paths", 64)
        normalized.append(directory)
    ordered = tuple(sorted(set(normalized)))
    if len(ordered) != len(normalized):
        fail("excluded directories must be unique", 64)
    for directory in ordered:
        if any(
            candidate != directory and directory.startswith(f"{candidate}/")
            for candidate in ordered
        ):
            fail("excluded directories must not overlap", 64)
    return ordered


def scan_entries(
    root: Path, hash_mode: str, excluded_directories: tuple[str, ...]
) -> Iterator[dict[str, object]]:
    excluded = set(excluded_directories)

    def visit(directory: Path, relative: Path) -> Iterator[dict[str, object]]:
        entries = sorted(os.scandir(directory), key=lambda entry: os.fsencode(entry.name))
        for entry in entries:
            entry_path = Path(entry.path)
            relative_path = relative / entry.name
            metadata = entry.stat(follow_symlinks=False)

            if stat.S_ISDIR(metadata.st_mode) and not entry.is_symlink():
                if relative_path.as_posix() in excluded:
                    continue
                yield from visit(entry_path, relative_path)
                continue

            if stat.S_ISREG(metadata.st_mode):
                entry_type = "file"
            elif stat.S_ISLNK(metadata.st_mode):
                entry_type = "symlink"
            else:
                entry_type = "other"

            record: dict[str, object] = {
                "path": relative_path.as_posix(),
                "type": entry_type,
                "size": metadata.st_size,
                "mtime_ns": metadata.st_mtime_ns,
            }
            if entry_type == "symlink":
                record["target"] = os.readlink(entry_path)
            elif entry_type == "file" and hash_mode == "sha256":
                record["sha256"] = digest_file(entry_path)
            yield record

    yield from visit(root, Path())


def json_line(value: object) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def write_manifest(
    root: Path,
    output: Path,
    hash_mode: str,
    excluded_directories: tuple[str, ...],
) -> int:
    ensure_external_output(root, output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp-{os.getpid()}")
    count = 0
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            stream.write(
                json_line(
                    {
                        "schema": SCHEMA,
                        "hash": hash_mode,
                        "excludedDirectories": list(excluded_directories),
                    }
                )
                + "\n"
            )
            for record in scan_entries(root, hash_mode, excluded_directories):
                stream.write(json_line(record) + "\n")
                count += 1
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()
    return count


def read_header(stream: TextIO, source: Path) -> dict[str, object]:
    line = stream.readline()
    if not line:
        fail(f"empty manifest: {source}")
    try:
        header = json.loads(line)
    except json.JSONDecodeError as error:
        fail(f"invalid manifest header in {source}: {error}")
    if (
        header.get("schema") != SCHEMA
        or header.get("hash") not in {"none", "sha256"}
        or not isinstance(header.get("excludedDirectories"), list)
    ):
        fail(f"unsupported manifest schema or hash mode in {source}")
    normalized = normalize_excluded_directories(
        json.dumps(header["excludedDirectories"], separators=(",", ":"))
    )
    if list(normalized) != header["excludedDirectories"]:
        fail(f"manifest exclusions are not canonical in {source}")
    return header


def records(stream: TextIO, source: Path) -> Iterator[dict[str, object]]:
    for line_number, line in enumerate(stream, start=2):
        try:
            yield json.loads(line)
        except json.JSONDecodeError as error:
            fail(f"invalid JSON at {source}:{line_number}: {error}")


def compare_manifests(baseline: Path, current: Path, max_diffs: int) -> int:
    differences = 0
    with baseline.open("r", encoding="utf-8") as before, current.open("r", encoding="utf-8") as after:
        baseline_header = read_header(before, baseline)
        current_header = read_header(after, current)
        if baseline_header != current_header:
            fail("baseline and current manifest use different policies")

        pairs = itertools.zip_longest(records(before, baseline), records(after, current))
        for previous, latest in pairs:
            if previous == latest:
                continue
            differences += 1
            if differences <= max_diffs:
                previous_path = previous.get("path") if previous else "<missing>"
                latest_path = latest.get("path") if latest else "<missing>"
                print(f"changed: before={previous_path!r} after={latest_path!r}", file=sys.stderr)
    return differences


def checked_root(value: str) -> Path:
    root = resolved(Path(value))
    if not root.is_dir():
        fail(f"Music root is not a readable directory: {root}")
    if not os.access(root, os.R_OK | os.X_OK):
        fail(f"Music root is not readable: {root}")
    return root


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    snapshot = subparsers.add_parser("snapshot", help="write a baseline manifest")
    snapshot.add_argument("--root", required=True)
    snapshot.add_argument("--output", required=True)
    snapshot.add_argument("--hash", choices=("none", "sha256"), default="sha256")
    snapshot.add_argument(
        "--exclude-directories-json",
        default=os.environ.get("COCEAN_SCAN_EXCLUDE_DIRS", "[]"),
    )

    verify = subparsers.add_parser("verify", help="compare the current library to a baseline")
    verify.add_argument("--root", required=True)
    verify.add_argument("--baseline", required=True)
    verify.add_argument("--output", required=True, help="where to write the post-scan manifest")
    verify.add_argument("--max-diffs", type=int, default=20)
    verify.add_argument(
        "--exclude-directories-json",
        default=os.environ.get("COCEAN_SCAN_EXCLUDE_DIRS", "[]"),
    )
    return parser


def main() -> int:
    arguments = build_parser().parse_args()
    root = checked_root(arguments.root)
    excluded_directories = normalize_excluded_directories(
        arguments.exclude_directories_json
    )

    if arguments.command == "snapshot":
        output = resolved(Path(arguments.output))
        count = write_manifest(root, output, arguments.hash, excluded_directories)
        print(f"snapshot ok: entries={count} output={output}")
        return 0

    baseline = resolved(Path(arguments.baseline))
    if not baseline.is_file():
        fail(f"baseline manifest does not exist: {baseline}")
    with baseline.open("r", encoding="utf-8") as stream:
        header = read_header(stream, baseline)
    if header["excludedDirectories"] != list(excluded_directories):
        fail("baseline manifest exclusions do not match current policy", 64)
    output = resolved(Path(arguments.output))
    count = write_manifest(
        root, output, str(header["hash"]), excluded_directories
    )
    differences = compare_manifests(baseline, output, max(0, arguments.max_diffs))
    if differences:
        print(f"verification failed: differences={differences} entries={count}", file=sys.stderr)
        return 2
    print(f"verification ok: unchanged entries={count} output={output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
