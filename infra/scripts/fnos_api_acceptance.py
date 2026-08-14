#!/usr/bin/env python3
"""Run a full, path-safe COCEAN API acceptance and write a JSON report."""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from typing import Any, Callable
import urllib.error
import urllib.parse
import urllib.request


SCHEMA = "cocean.fnos-api-acceptance/v2"
MUSIC_MANIFEST_SCHEMA = "cocean.music-manifest/v2"
TERMINAL_SCAN_STATUSES = {
    "COMPLETED",
    "COMPLETED_WITH_WARNINGS",
    "FAILED",
    "CANCELLED",
}
SAFE_DIMENSION = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
SAFE_SCAN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
SAFE_EXTENSION = re.compile(r"^\.[a-z0-9]{1,16}$")
KNOWN_UNSUPPORTED_EXTENSIONS = frozenset(
    {
        ".aa",
        ".aax",
        ".aob",
        ".au",
        ".caf",
        ".dts",
        ".dtshd",
        ".iso",
        ".mlp",
        ".oma",
        ".ra",
        ".rm",
        ".sacd",
        ".snd",
        ".thd",
        ".vob",
    }
)
ARTWORK_PATH = re.compile(r"^/api/v1/artwork/[a-f0-9]{64}$")
SUMMARY_HASH = re.compile(r"^[a-f0-9]{64}$")
FILE_KINDS = {
    "SUPPORTED_AUDIO",
    "KNOWN_UNSUPPORTED_AUDIO",
    "SYMLINK",
    "TRAVERSAL_ERROR",
}
FILE_OUTCOMES = {"PARSED", "UNSUPPORTED", "FAILED", "SKIPPED"}


class AcceptanceError(RuntimeError):
    """An expected gate failure whose message contains no remote payload data."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):  # type: ignore[no-untyped-def]
        return None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def nonnegative(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be non-negative")
    return parsed


def positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def page_size(value: str) -> int:
    parsed = int(value)
    if parsed < 1 or parsed > 500:
        raise argparse.ArgumentTypeError("must be between 1 and 500")
    return parsed


def safe_dimension(value: object) -> str:
    candidate = str(value)
    return candidate if SAFE_DIMENSION.fullmatch(candidate) else "UNKNOWN"


def require_object(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AcceptanceError(f"{label} did not return a JSON object")
    return value


def require_list(value: object, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise AcceptanceError(f"{label} did not return a JSON array")
    return value


def require_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise AcceptanceError(f"{label} is missing a non-empty string")
    return value


def require_count(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise AcceptanceError(f"{label} is not a non-negative integer")
    return value


def require_relative_path(value: object, label: str) -> str:
    relative_path = require_string(value, label)
    normalized_parts = relative_path.replace("\\", "/").split("/")
    if (
        relative_path.startswith(("/", "\\"))
        or "\\" in relative_path
        or "\x00" in relative_path
        or any(part in {"", ".", ".."} for part in normalized_parts)
        or re.match(r"^[A-Za-z]:", relative_path)
    ):
        raise AcceptanceError(f"{label} is not a safe library-relative path")
    return relative_path


def require_positive_number(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise AcceptanceError(f"{label} is not a positive number")
    return float(value)


def js_json(value: object) -> str:
    """Match JSON.stringify for the ledger's JSON-compatible values."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def parse_excluded_directories(value: str) -> tuple[str, ...]:
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        raise AcceptanceError("scan exclusions are not valid JSON") from None
    if not isinstance(decoded, list) or len(decoded) > 128:
        raise AcceptanceError("scan exclusions are not a bounded JSON array")
    normalized: list[str] = []
    for item in decoded:
        if not isinstance(item, str):
            raise AcceptanceError("scan exclusions contain a non-string value")
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
            raise AcceptanceError("scan exclusions contain an unsafe relative path")
        normalized.append(directory)
    ordered = tuple(sorted(set(normalized)))
    if len(ordered) != len(normalized):
        raise AcceptanceError("scan exclusions contain a duplicate directory")
    for directory in ordered:
        if any(
            candidate != directory and directory.startswith(f"{candidate}/")
            for candidate in ordered
        ):
            raise AcceptanceError("scan exclusions contain overlapping directories")
    return ordered


def parse_optional_scan_id(value: str) -> str | None:
    if not value:
        return None
    if not SAFE_SCAN_ID.fullmatch(value):
        raise AcceptanceError("existing scan identifier is unsafe")
    return value


def parse_allowed_unsupported_extensions(value: str) -> dict[str, int]:
    if len(value) > 16 * 1024:
        raise AcceptanceError("allowed unsupported extensions policy is too large")

    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, item in pairs:
            if key in result:
                raise ValueError("duplicate JSON object key")
            result[key] = item
        return result

    try:
        decoded = json.loads(value, object_pairs_hook=unique_object)
    except (json.JSONDecodeError, ValueError):
        raise AcceptanceError(
            "allowed unsupported extensions policy is not valid JSON"
        ) from None
    if not isinstance(decoded, dict) or len(decoded) > 128:
        raise AcceptanceError(
            "allowed unsupported extensions policy is not a bounded JSON object"
        )
    normalized: dict[str, int] = {}
    for extension, limit in decoded.items():
        if (
            not SAFE_EXTENSION.fullmatch(extension)
            or extension not in KNOWN_UNSUPPORTED_EXTENSIONS
        ):
            raise AcceptanceError(
                "allowed unsupported extensions policy contains an unknown extension"
            )
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or limit < 0
            or limit > 2_147_483_647
        ):
            raise AcceptanceError(
                "allowed unsupported extensions policy contains an invalid limit"
            )
        normalized[extension] = limit
    return dict(sorted(normalized.items()))


class ApiClient:
    def __init__(self, base_url: str, timeout: float):
        parsed = urllib.parse.urlsplit(base_url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise AcceptanceError("API base URL violates the internal-only URL contract")
        normalized_path = parsed.path.rstrip("/")
        self.base_url = urllib.parse.urlunsplit(
            (parsed.scheme, parsed.netloc, normalized_path, "", "")
        )
        self.origin = (parsed.scheme, parsed.hostname, parsed.port)
        self.timeout = timeout
        self.opener = urllib.request.build_opener(NoRedirect())

    def url(self, path: str) -> str:
        if not path.startswith("/"):
            raise AcceptanceError("an acceptance endpoint was not absolute")
        return f"{self.base_url}{path}"

    def request_json(
        self,
        method: str,
        path: str,
        label: str,
        payload: dict[str, object] | None = None,
        expected: tuple[int, ...] = (200,),
    ) -> dict[str, Any]:
        body = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.url(path), data=body, headers=headers, method=method
        )
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                status = response.status
                final = urllib.parse.urlsplit(response.geturl())
                if (final.scheme, final.hostname, final.port) != self.origin:
                    raise AcceptanceError(f"{label} escaped the configured API origin")
                raw = response.read(2 * 1024 * 1024 + 1)
        except urllib.error.HTTPError as error:
            raise AcceptanceError(f"{label} returned HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise AcceptanceError(f"{label} could not be reached") from None
        if status not in expected:
            raise AcceptanceError(f"{label} returned unexpected HTTP {status}")
        if len(raw) > 2 * 1024 * 1024:
            raise AcceptanceError(f"{label} JSON response exceeded the safety limit")
        try:
            decoded = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise AcceptanceError(f"{label} returned invalid JSON") from None
        return require_object(decoded, label)

    def request_bytes(
        self,
        path: str,
        label: str,
        headers: dict[str, str] | None = None,
        expected: tuple[int, ...] = (200,),
        max_bytes: int = 64 * 1024 * 1024,
    ) -> tuple[int, dict[str, str], bytes]:
        request = urllib.request.Request(
            self.url(path), headers=headers or {}, method="GET"
        )
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                status = response.status
                final = urllib.parse.urlsplit(response.geturl())
                if (final.scheme, final.hostname, final.port) != self.origin:
                    raise AcceptanceError(f"{label} escaped the configured API origin")
                response_headers = {key.lower(): value for key, value in response.headers.items()}
                body = response.read(max_bytes + 1)
        except urllib.error.HTTPError as error:
            raise AcceptanceError(f"{label} returned HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise AcceptanceError(f"{label} could not be reached") from None
        if status not in expected:
            raise AcceptanceError(f"{label} returned unexpected HTTP {status}")
        if len(body) > max_bytes:
            raise AcceptanceError(f"{label} response exceeded the safety limit")
        return status, response_headers, body


class AcceptanceRun:
    def __init__(self, arguments: argparse.Namespace):
        self.arguments = arguments
        self.started_wall = utc_now()
        self.started_monotonic = time.monotonic()
        self.client = ApiClient(arguments.base_url, arguments.request_timeout)
        self.excluded_directories = parse_excluded_directories(
            arguments.exclude_directories_json
        )
        self.existing_scan_id = parse_optional_scan_id(arguments.existing_scan_id)
        self.allowed_unsupported_extensions = parse_allowed_unsupported_extensions(
            arguments.allowed_unsupported_extensions_json
        )
        exclusion_hash = hashlib.sha256(
            js_json(list(self.excluded_directories)).encode("utf-8")
        ).hexdigest()
        self.current_gate = "initialize"
        self.parsed_media_ids: set[str] = set()
        self.detail_track_ids: set[str] = set()
        self.parsed_warning_codes_by_media_id: dict[str, tuple[str, ...]] = {}
        self.detail_warning_codes_by_media_id: dict[str, tuple[str, ...]] = {}
        self.file_results: list[dict[str, Any]] = []
        self.track_warning_codes: list[str] = []
        self.report: dict[str, Any] = {
            "schema": SCHEMA,
            "status": "running",
            "startedAt": self.started_wall,
            "policy": {
                "maximumFailures": arguments.max_failures,
                "minimumAlbums": arguments.min_albums,
                "minimumArtworkResponses": arguments.min_artworks,
                "maximumMissingArtworks": arguments.max_missing_artworks,
                "maximumAlbumIssues": arguments.max_album_issues,
                "maximumIgnoredFiles": arguments.max_ignored_files,
                "maximumSkippedSymlinks": arguments.max_skipped_symlinks,
                "maximumCueFiles": arguments.max_cue_files,
                "maximumOtherEntries": arguments.max_other_entries,
                "maximumTagWarnings": arguments.max_tag_warnings,
                "maximumTechnicalWarnings": arguments.max_technical_warnings,
                "allowedUnsupportedExtensions": self.allowed_unsupported_extensions,
                "excludedDirectoryCount": len(self.excluded_directories),
                "excludedDirectoryPolicyHash": exclusion_hash,
                "manifestHash": arguments.manifest_hash,
                "listenCoverage": arguments.listen_mode,
                "reusedExistingScan": self.existing_scan_id is not None,
            },
            "gates": [],
        }

    def gate(self, name: str, operation: Callable[[], Any]) -> Any:
        self.current_gate = name
        result = operation()
        self.report["gates"].append({"name": name, "status": "passed"})
        return result

    def run(self) -> None:
        manifest = self.gate("music-manifest-baseline", self.read_music_manifest)
        readiness = self.gate(
            "readiness",
            lambda: self.client.request_json(
                "GET", "/api/v1/readiness", "readiness"
            ),
        )
        if readiness.get("status") != "ready":
            raise AcceptanceError("readiness did not report ready")
        music_root = require_object(readiness.get("musicRoot"), "readiness musicRoot")
        if (
            music_root.get("readable") is not True
            or music_root.get("kind") != "directory"
            or music_root.get("readOnlyPolicy") is not True
        ):
            raise AcceptanceError("readiness did not confirm the Music root policy")

        if self.existing_scan_id is None:
            scan = self.gate("scan-create", self.create_scan)
        else:
            scan = self.gate("scan-reuse", self.get_existing_scan)
        scan = self.gate("scan-complete", lambda: self.wait_for_scan(scan))
        failures, by_code, by_stage = self.gate(
            "scan-failure-pagination", lambda: self.fetch_failures(scan)
        )
        evidence = self.gate(
            "scan-evidence-ledger", lambda: self.fetch_scan_evidence(scan)
        )
        self.gate(
            "scan-outcome-policy",
            lambda: self.verify_scan_outcome_policy(evidence),
        )

        def reconcile_manifest() -> None:
            if evidence["regularFiles"] != manifest["regularFiles"]:
                raise AcceptanceError(
                    "scan regularFiles does not equal the immutable Music manifest"
                )
            if evidence["skippedSymlinks"] != manifest["symlinks"]:
                raise AcceptanceError(
                    "scan symlink count does not equal the immutable Music manifest"
                )
            if evidence["ignoredFiles"] > self.arguments.max_ignored_files:
                raise AcceptanceError("ignored files exceed the configured acceptance limit")
            if evidence["skippedSymlinks"] > self.arguments.max_skipped_symlinks:
                raise AcceptanceError(
                    "skipped symlinks exceed the configured acceptance limit"
                )
            if manifest["cueFiles"] > self.arguments.max_cue_files:
                raise AcceptanceError("CUE files exceed the configured acceptance limit")
            if manifest["otherEntries"] > self.arguments.max_other_entries:
                raise AcceptanceError(
                    "non-file Music entries exceed the configured acceptance limit"
                )
            files = manifest["filePaths"]
            symlinks = manifest["symlinkPaths"]
            for item in self.file_results:
                path = str(item["relativePath"])
                if item["candidateKind"] == "SYMLINK":
                    if path not in symlinks:
                        raise AcceptanceError(
                            "scan symlink ledger path is absent from the Music manifest"
                        )
                elif item["candidateKind"] != "TRAVERSAL_ERROR" and path not in files:
                    raise AcceptanceError(
                        "scan file ledger path is absent from the Music manifest"
                    )

        self.gate("manifest-scan-boundary", reconcile_manifest)

        total_files = require_count(scan.get("totalFiles"), "scan totalFiles")
        processed_files = require_count(
            scan.get("processedFiles"), "scan processedFiles"
        )
        parsed_files = require_count(scan.get("parsedFiles"), "scan parsedFiles")
        failed_files = require_count(scan.get("failedFiles"), "scan failedFiles")
        scan_status = safe_dimension(scan.get("status"))
        self.report["scan"] = {
            "status": scan_status,
            "reusedExistingScan": self.existing_scan_id is not None,
            "totalFiles": total_files,
            "processedFiles": processed_files,
            "parsedFiles": parsed_files,
            "failedFiles": failed_files,
            "unsupportedFiles": evidence["unsupported"],
            "trueFailedFiles": evidence["failed"],
            "failureRecordsFetched": len(failures),
            "failuresByCode": by_code,
            "failuresByStage": by_stage,
        }
        self.report["evidence"] = evidence
        self.report["manifest"] = {
            key: manifest[key]
            for key in (
                "hash",
                "regularFiles",
                "symlinks",
                "otherEntries",
                "cueFiles",
                "excludedDirectoryCount",
                "excludedDirectoryPolicyHash",
            )
        }

        def reconcile_scan() -> None:
            if scan_status in {"FAILED", "CANCELLED"}:
                raise AcceptanceError("scan ended in a failed terminal status")
            if scan_status not in {"COMPLETED", "COMPLETED_WITH_WARNINGS"}:
                raise AcceptanceError("scan ended in an unknown terminal status")
            if processed_files != total_files:
                raise AcceptanceError("scan processedFiles does not equal totalFiles")
            if parsed_files + failed_files != total_files:
                raise AcceptanceError("scan parsedFiles plus failedFiles does not equal totalFiles")
            if failed_files != len(failures):
                raise AcceptanceError("scan failedFiles does not equal fetched failure records")
            if evidence["failed"] > self.arguments.max_failures:
                raise AcceptanceError("scan failures exceed the configured acceptance limit")
            if evidence["candidates"] != total_files:
                raise AcceptanceError("scan report candidates does not equal totalFiles")
            if evidence["processed"] != processed_files:
                raise AcceptanceError("scan report processed does not equal processedFiles")
            if evidence["parsed"] != parsed_files:
                raise AcceptanceError("scan report parsed does not equal parsedFiles")
            if evidence["unsupported"] + evidence["failed"] != failed_files:
                raise AcceptanceError("scan report outcomes do not equal failedFiles")

        self.gate("scan-count-reconciliation", reconcile_scan)

        stats = self.gate(
            "library-stats",
            lambda: self.client.request_json(
                "GET", "/api/v1/library/stats", "library stats"
            ),
        )
        albums, album_pages = self.gate("album-pagination", self.fetch_albums)
        details, artwork_paths = self.gate(
            "album-details", lambda: self.fetch_album_details(albums)
        )
        artwork_count = self.gate(
            "artwork-get", lambda: self.fetch_artworks(artwork_paths)
        )
        listen_count = self.gate(
            "listen-range", lambda: self.check_listen_ranges(details)
        )

        stats_counts = {
            key: require_count(stats.get(key), f"library stats {key}")
            for key in (
                "albums",
                "tracks",
                "files",
                "needsReview",
                "missingArtwork",
                "parseFailures",
            )
        }

        def reconcile_library() -> None:
            if stats_counts["files"] != parsed_files:
                raise AcceptanceError("library files does not equal scan parsedFiles")
            if stats_counts["parseFailures"] != failed_files:
                raise AcceptanceError("library parseFailures does not equal scan failedFiles")
            if stats_counts["albums"] != len(albums):
                raise AcceptanceError("library albums does not equal fully paged Album count")
            detail_tracks = sum(len(require_list(item.get("tracks"), "Album tracks")) for item in details)
            if stats_counts["tracks"] != detail_tracks:
                raise AcceptanceError("library tracks does not equal detail track count")
            represented_local_versions = 0
            represented_local_files = 0
            for album, detail in zip(albums, details):
                if album.get("hasDigital") is not True:
                    continue
                local_versions = detail.get("localVersions")
                if local_versions is None:
                    # Backward compatibility for pre-governance Album details, where
                    # one digital Album always represented exactly one local version.
                    represented_local_versions += 1
                    represented_local_files += len(
                        require_list(detail.get("tracks"), "Album tracks")
                    ) + require_count(
                        detail.get("duplicateFileCount", 0),
                        "Album duplicateFileCount",
                    )
                    continue
                versions = require_list(local_versions, "Album localVersions")
                if not versions:
                    raise AcceptanceError(
                        "digital Album does not expose a represented local version"
                    )
                represented_local_versions += len(versions)
                represented_local_files += sum(
                    require_count(
                        require_object(version, "Album localVersion").get("fileCount"),
                        "Album localVersion fileCount",
                    )
                    for version in versions
                )
            if evidence["albumCount"] != represented_local_versions:
                raise AcceptanceError(
                    "scan report albumCount does not equal represented local versions"
                )
            album_issues = sum(
                len(require_list(item.get("aggregationIssues", []), "Album aggregationIssues"))
                for item in details
            )
            if album_issues > evidence["albumIssueCount"]:
                raise AcceptanceError(
                    "primary Album issues exceed the full scan issue ledger"
                )
            if evidence["albumIssueCount"] > self.arguments.max_album_issues:
                raise AcceptanceError("Album aggregation issues exceed the configured limit")
            if stats_counts["missingArtwork"] > self.arguments.max_missing_artworks:
                raise AcceptanceError("Albums without artwork exceed the configured limit")
            if not self.detail_track_ids.issubset(self.parsed_media_ids):
                raise AcceptanceError(
                    "Album detail Track ids are not a subset of parsed media ids"
                )
            if len(self.parsed_media_ids) != represented_local_files:
                raise AcceptanceError(
                    "represented local-version files do not reconcile with parsed media ids"
                )
            expected_detail_warnings = {
                media_id: self.parsed_warning_codes_by_media_id[media_id]
                for media_id in self.detail_track_ids
            }
            if self.detail_warning_codes_by_media_id != expected_detail_warnings:
                raise AcceptanceError(
                    "Album detail warning codes do not match primary scan evidence"
                )
            if len(albums) < self.arguments.min_albums:
                raise AcceptanceError("Album count is below the configured acceptance minimum")
            if artwork_count < self.arguments.min_artworks:
                raise AcceptanceError("artwork GET count is below the configured minimum")
            if listen_count < 1:
                raise AcceptanceError("no digital track completed a Listen Range check")
            tag_warnings = sum(
                1
                for code in self.track_warning_codes
                if code.startswith("MISSING_") and code.endswith("_TAG")
            )
            if tag_warnings > self.arguments.max_tag_warnings:
                raise AcceptanceError(
                    "required tag warnings exceed the configured acceptance limit"
                )
            technical_warnings = sum(
                1
                for code in self.track_warning_codes
                if code
                in {"TECHNICAL_METADATA_CONFLICT", "UNRECOGNIZED_DSD_RATE"}
            )
            if technical_warnings > self.arguments.max_technical_warnings:
                raise AcceptanceError(
                    "technical fact warnings exceed the configured acceptance limit"
                )

        self.gate("library-count-reconciliation", reconcile_library)
        self.report["library"] = stats_counts
        self.report["coverage"] = {
            "albumPages": album_pages,
            "albumSummaries": len(albums),
            "albumDetails": len(details),
            "trackFactsValidated": len(self.detail_track_ids),
            "duplicateFilesCollapsed": len(
                self.parsed_media_ids - self.detail_track_ids
            ),
            "artworkUrlsDeclared": len(artwork_paths),
            "artworkResponses": artwork_count,
            "listenRangeResponses": listen_count,
            "tagWarnings": sum(
                1
                for code in self.track_warning_codes
                if code.startswith("MISSING_") and code.endswith("_TAG")
            ),
            "technicalWarnings": sum(
                1
                for code in self.track_warning_codes
                if code in {"TECHNICAL_METADATA_CONFLICT", "UNRECOGNIZED_DSD_RATE"}
            ),
        }

    def read_music_manifest(self) -> dict[str, Any]:
        path = Path(self.arguments.manifest)
        try:
            stream = path.open("r", encoding="utf-8", newline="")
        except OSError:
            raise AcceptanceError("Music baseline manifest is unavailable") from None
        file_paths: set[str] = set()
        symlink_paths: set[str] = set()
        other_paths: set[str] = set()
        all_paths: set[str] = set()
        cue_files = 0
        with stream:
            header_line = stream.readline(1024 * 1024 + 1)
            if not header_line or len(header_line) > 1024 * 1024:
                raise AcceptanceError("Music baseline manifest header is invalid")
            try:
                header = json.loads(header_line)
            except json.JSONDecodeError:
                raise AcceptanceError("Music baseline manifest header is invalid") from None
            if (
                not isinstance(header, dict)
                or header.get("schema") != MUSIC_MANIFEST_SCHEMA
                or header.get("hash") != self.arguments.manifest_hash
                or header.get("excludedDirectories")
                != list(self.excluded_directories)
            ):
                raise AcceptanceError("Music baseline manifest contract does not match policy")
            for line in stream:
                if len(line) > 1024 * 1024:
                    raise AcceptanceError("Music baseline manifest record is too large")
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    raise AcceptanceError("Music baseline manifest record is invalid") from None
                record = require_object(record, "Music baseline manifest record")
                relative_path = require_relative_path(
                    record.get("path"), "Music baseline manifest path"
                )
                entry_type = record.get("type")
                if entry_type not in {"file", "symlink", "other"}:
                    raise AcceptanceError("Music baseline manifest entry type is invalid")
                size = record.get("size")
                mtime_ns = record.get("mtime_ns")
                if (
                    isinstance(size, bool)
                    or not isinstance(size, int)
                    or size < 0
                    or isinstance(mtime_ns, bool)
                    or not isinstance(mtime_ns, int)
                    or mtime_ns < 0
                ):
                    raise AcceptanceError("Music baseline manifest file facts are invalid")
                if relative_path in all_paths:
                    raise AcceptanceError("Music baseline manifest contains a duplicate path")
                all_paths.add(relative_path)
                if entry_type == "file":
                    if self.arguments.manifest_hash == "sha256" and not SUMMARY_HASH.fullmatch(
                        str(record.get("sha256", ""))
                    ):
                        raise AcceptanceError(
                            "Music baseline manifest is missing a file checksum"
                        )
                    file_paths.add(relative_path)
                    if Path(relative_path).suffix.lower() == ".cue":
                        cue_files += 1
                elif entry_type == "symlink":
                    if not isinstance(record.get("target"), str):
                        raise AcceptanceError(
                            "Music baseline symlink target evidence is invalid"
                        )
                    symlink_paths.add(relative_path)
                else:
                    other_paths.add(relative_path)
        return {
            "hash": self.arguments.manifest_hash,
            "excludedDirectoryCount": len(self.excluded_directories),
            "excludedDirectoryPolicyHash": hashlib.sha256(
                js_json(list(self.excluded_directories)).encode("utf-8")
            ).hexdigest(),
            "regularFiles": len(file_paths),
            "symlinks": len(symlink_paths),
            "otherEntries": len(other_paths),
            "cueFiles": cue_files,
            "filePaths": file_paths,
            "symlinkPaths": symlink_paths,
        }

    def create_scan(self) -> dict[str, Any]:
        scan = self.client.request_json(
            "POST",
            "/api/v1/scans",
            "scan create",
            {"rootId": "music"},
            expected=(202,),
        )
        self.validate_scan_identity(scan)
        if scan.get("rootId") != "music" or scan.get("status") != "QUEUED":
            raise AcceptanceError("scan create returned an invalid initial job")
        return scan

    def get_existing_scan(self) -> dict[str, Any]:
        scan_id = self.existing_scan_id
        if scan_id is None:
            raise AcceptanceError("existing scan reuse was not configured")
        encoded = urllib.parse.quote(scan_id, safe="")
        scan = self.client.request_json(
            "GET", f"/api/v1/scans/{encoded}", "existing scan"
        )
        self.validate_scan_identity(scan, scan_id)
        if scan.get("status") not in TERMINAL_SCAN_STATUSES | {"QUEUED", "RUNNING"}:
            raise AcceptanceError("existing scan returned an unknown status")
        return scan

    @staticmethod
    def validate_scan_identity(
        scan: dict[str, Any], expected_scan_id: str | None = None
    ) -> str:
        scan_id = require_string(scan.get("id"), "scan id")
        if not SAFE_SCAN_ID.fullmatch(scan_id):
            raise AcceptanceError("scan returned an unsafe identifier")
        if expected_scan_id is not None and scan_id != expected_scan_id:
            raise AcceptanceError("scan identity changed during acceptance")
        if scan.get("rootId") != "music":
            raise AcceptanceError("scan root identity is not music")
        return scan_id

    def wait_for_scan(self, initial: dict[str, Any]) -> dict[str, Any]:
        scan_id_raw = self.validate_scan_identity(initial)
        initial_status = initial.get("status")
        if initial_status in TERMINAL_SCAN_STATUSES:
            return initial
        if initial_status not in {"QUEUED", "RUNNING"}:
            raise AcceptanceError("scan returned an unknown status")
        scan_id = urllib.parse.quote(scan_id_raw, safe="")
        deadline = time.monotonic() + self.arguments.scan_timeout
        while True:
            job = self.client.request_json(
                "GET", f"/api/v1/scans/{scan_id}", "scan poll"
            )
            self.validate_scan_identity(job, scan_id_raw)
            status = job.get("status")
            if status in TERMINAL_SCAN_STATUSES:
                return job
            if status not in {"QUEUED", "RUNNING"}:
                raise AcceptanceError("scan poll returned an unknown status")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AcceptanceError("scan did not reach a terminal status before timeout")
            time.sleep(min(self.arguments.poll_interval, remaining))

    def fetch_failures(
        self, scan: dict[str, Any]
    ) -> tuple[list[dict[str, Any]], dict[str, int], dict[str, int]]:
        scan_id = urllib.parse.quote(require_string(scan.get("id"), "scan id"), safe="")
        expected_total = require_count(scan.get("failedFiles"), "scan failedFiles")
        failures: list[dict[str, Any]] = []
        offset = 0
        page_size = self.arguments.page_size
        endpoint_total: int | None = None
        while offset < expected_total or offset == 0:
            page = self.client.request_json(
                "GET",
                f"/api/v1/scans/{scan_id}/failures?limit={page_size}&offset={offset}",
                "scan failures",
            )
            items = require_list(page.get("items"), "scan failure items")
            total = require_count(page.get("total"), "scan failure total")
            if endpoint_total is None:
                endpoint_total = total
            elif total != endpoint_total:
                raise AcceptanceError("scan failure total changed during pagination")
            if require_count(page.get("offset"), "scan failure offset") != offset:
                raise AcceptanceError("scan failure pagination returned the wrong offset")
            if len(items) > page_size:
                raise AcceptanceError("scan failure page exceeded the requested limit")
            failures.extend(require_object(item, "scan failure") for item in items)
            offset += len(items)
            if offset >= total:
                break
            if not items:
                raise AcceptanceError("scan failure pagination stopped before total")
        if endpoint_total is None or endpoint_total != expected_total:
            raise AcceptanceError("scan failure endpoint total does not equal failedFiles")
        if len(failures) != endpoint_total:
            raise AcceptanceError("not every scan failure page was fetched")
        by_code = Counter(safe_dimension(item.get("code")) for item in failures)
        by_stage = Counter(safe_dimension(item.get("stage")) for item in failures)
        return failures, dict(sorted(by_code.items())), dict(sorted(by_stage.items()))

    def fetch_scan_evidence(self, scan: dict[str, Any]) -> dict[str, Any]:
        scan_id_raw = require_string(scan.get("id"), "scan id")
        scan_id = urllib.parse.quote(scan_id_raw, safe="")
        report = self.client.request_json(
            "GET", f"/api/v1/scans/{scan_id}/report", "scan evidence report"
        )
        if report.get("scanJobId") != scan_id_raw or report.get("rootId") != "music":
            raise AcceptanceError("scan evidence report identity does not match the job")
        if report.get("status") != scan.get("status"):
            raise AcceptanceError("scan evidence report status does not match the job")
        if report.get("candidateScope") != "SUPPORTED_AND_KNOWN_UNSUPPORTED_AUDIO":
            raise AcceptanceError("scan evidence report candidate scope is unknown")
        if report.get("trackSemantics") != "ONE_AUDIO_FILE_ONE_TRACK":
            raise AcceptanceError("scan evidence report track semantics are unknown")
        if report.get("cueSheetSupport") != "AUXILIARY_ONLY":
            raise AcceptanceError("scan evidence report CUE semantics are unknown")
        rules_version = require_string(report.get("rulesVersion"), "scan rulesVersion")
        summary_hash = require_string(report.get("summaryHash"), "scan summaryHash")
        if not SUMMARY_HASH.fullmatch(summary_hash):
            raise AcceptanceError("scan evidence report summaryHash is invalid")

        count_keys = (
            "candidates",
            "processed",
            "parsed",
            "unsupported",
            "failed",
            "unprocessed",
            "regularFiles",
            "auxiliaryFiles",
            "ignoredFiles",
            "skippedSymlinks",
            "traversalErrors",
        )
        counts = {
            key: require_count(report.get(key), f"scan report {key}")
            for key in count_keys
        }
        album_count = require_count(report.get("albumCount"), "scan report albumCount")
        album_issue_count = require_count(
            report.get("albumIssueCount"), "scan report albumIssueCount"
        )
        invariants = require_object(report.get("invariants"), "scan report invariants")
        for invariant in (
            "candidateBalance",
            "outcomeBalance",
            "regularFileBalance",
            "boundaryEvidence",
            "valid",
        ):
            if invariants.get(invariant) is not True:
                raise AcceptanceError(f"scan report invariant {invariant} is not true")
        if counts["unprocessed"] != 0:
            raise AcceptanceError("scan evidence contains unprocessed audio candidates")
        if counts["candidates"] != counts["processed"] + counts["unprocessed"]:
            raise AcceptanceError("scan evidence candidate balance is false")
        if counts["processed"] != counts["parsed"] + counts["unsupported"] + counts["failed"]:
            raise AcceptanceError("scan evidence outcome balance is false")
        if counts["regularFiles"] != counts["candidates"] + counts["auxiliaryFiles"] + counts["ignoredFiles"]:
            raise AcceptanceError("scan evidence regular-file balance is false")

        files = self.fetch_all_file_results(scan_id_raw, scan_id)
        self.file_results = files
        by_outcome = Counter(item["outcome"] for item in files)
        by_kind = Counter(item["candidateKind"] for item in files)
        audio_files = [
            item
            for item in files
            if item["candidateKind"]
            in {"SUPPORTED_AUDIO", "KNOWN_UNSUPPORTED_AUDIO"}
        ]
        audio_outcomes = Counter(item["outcome"] for item in audio_files)
        if len(audio_files) != counts["processed"]:
            raise AcceptanceError("file ledger audio count does not equal report processed")
        if audio_outcomes["PARSED"] != counts["parsed"]:
            raise AcceptanceError("file ledger PARSED count does not equal report parsed")
        if audio_outcomes["UNSUPPORTED"] != counts["unsupported"]:
            raise AcceptanceError("file ledger UNSUPPORTED count does not equal report unsupported")
        if audio_outcomes["FAILED"] != counts["failed"]:
            raise AcceptanceError("file ledger FAILED count does not equal report failed")
        if by_kind["SYMLINK"] != counts["skippedSymlinks"]:
            raise AcceptanceError("file ledger SYMLINK count does not equal report")
        if by_kind["TRAVERSAL_ERROR"] != counts["traversalErrors"]:
            raise AcceptanceError("file ledger TRAVERSAL_ERROR count does not equal report")
        expected_ledger = (
            counts["processed"]
            + counts["skippedSymlinks"]
            + counts["traversalErrors"]
        )
        if len(files) != expected_ledger:
            raise AcceptanceError("file ledger total does not match report evidence")

        parsed_media_ids: set[str] = set()
        parsed_warning_codes: dict[str, tuple[str, ...]] = {}
        for item in files:
            media_file_id = item.get("mediaFileId")
            if item["outcome"] == "PARSED":
                if not isinstance(media_file_id, str) or not media_file_id:
                    raise AcceptanceError("PARSED file ledger row is missing mediaFileId")
                if media_file_id in parsed_media_ids:
                    raise AcceptanceError("file ledger contains a duplicate parsed mediaFileId")
                parsed_media_ids.add(media_file_id)
                warning_codes = tuple(sorted(str(code) for code in item["warningCodes"]))
                parsed_warning_codes[media_file_id] = warning_codes
            elif media_file_id is not None:
                raise AcceptanceError("non-PARSED file ledger row has a mediaFileId")
        self.parsed_media_ids = parsed_media_ids
        self.parsed_warning_codes_by_media_id = parsed_warning_codes

        recomputed = self.hash_scan_evidence(
            scan_id_raw,
            str(report.get("rootId")),
            str(report.get("status")),
            rules_version,
            counts,
            bool(invariants.get("boundaryEvidence")),
            album_count,
            album_issue_count,
            files,
        )
        if recomputed != summary_hash:
            raise AcceptanceError("scan evidence summaryHash does not match the full ledger")

        return {
            "rulesVersion": safe_dimension(rules_version),
            "summaryHash": summary_hash,
            **counts,
            "albumCount": album_count,
            "albumIssueCount": album_issue_count,
            "fileResultsFetched": len(files),
            "fileResultsByOutcome": {
                outcome: by_outcome.get(outcome, 0) for outcome in sorted(FILE_OUTCOMES)
            },
            "fileResultsByCandidateKind": {
                kind: by_kind.get(kind, 0) for kind in sorted(FILE_KINDS)
            },
            "invariantsValid": True,
        }

    def verify_scan_outcome_policy(self, evidence: dict[str, Any]) -> None:
        unsupported_by_extension: Counter[str] = Counter()
        for item in self.file_results:
            outcome = item["outcome"]
            error_code = item.get("errorCode")
            if outcome == "UNSUPPORTED":
                extension = str(item["extension"])
                if not SAFE_EXTENSION.fullmatch(extension):
                    raise AcceptanceError(
                        "UNSUPPORTED ledger row has an unsafe extension"
                    )
                if error_code != "UNSUPPORTED_MEDIA":
                    raise AcceptanceError(
                        "UNSUPPORTED ledger row does not use UNSUPPORTED_MEDIA"
                    )
                if item["candidateKind"] != "KNOWN_UNSUPPORTED_AUDIO":
                    raise AcceptanceError(
                        "UNSUPPORTED ledger row is not a known unsupported audio candidate"
                    )
                if extension not in self.allowed_unsupported_extensions:
                    raise AcceptanceError(
                        "unsupported extension is absent from the explicit policy"
                    )
                unsupported_by_extension[extension] += 1
            elif outcome == "FAILED" and error_code == "UNSUPPORTED_MEDIA":
                raise AcceptanceError(
                    "FAILED ledger row incorrectly uses UNSUPPORTED_MEDIA"
                )

        if sum(unsupported_by_extension.values()) != evidence["unsupported"]:
            raise AcceptanceError(
                "unsupported extension aggregation does not equal scan evidence"
            )
        for extension, observed in unsupported_by_extension.items():
            if observed > self.allowed_unsupported_extensions[extension]:
                raise AcceptanceError(
                    "unsupported extension exceeds its explicit acceptance limit"
                )
        evidence["unsupportedByExtension"] = dict(
            sorted(unsupported_by_extension.items())
        )

    def fetch_all_file_results(
        self, scan_id_raw: str, scan_id: str
    ) -> list[dict[str, Any]]:
        files: list[dict[str, Any]] = []
        seen_ids: set[int] = set()
        offset = 0
        expected_total: int | None = None
        while expected_total is None or offset < expected_total:
            page = self.client.request_json(
                "GET",
                f"/api/v1/scans/{scan_id}/files?limit={self.arguments.page_size}&offset={offset}",
                "scan file ledger",
            )
            items = require_list(page.get("items"), "scan file ledger items")
            total = require_count(page.get("total"), "scan file ledger total")
            if expected_total is None:
                expected_total = total
            elif total != expected_total:
                raise AcceptanceError("scan file ledger total changed during pagination")
            if require_count(page.get("offset"), "scan file ledger offset") != offset:
                raise AcceptanceError("scan file ledger returned the wrong offset")
            if len(items) > self.arguments.page_size:
                raise AcceptanceError("scan file ledger page exceeded its requested limit")
            for raw in items:
                item = require_object(raw, "scan file result")
                item_id = require_count(item.get("id"), "scan file result id")
                if item_id < 1 or item_id in seen_ids:
                    raise AcceptanceError("scan file ledger contains an invalid or duplicate id")
                seen_ids.add(item_id)
                if item.get("scanJobId") != scan_id_raw or item.get("rootId") != "music":
                    raise AcceptanceError("scan file result identity does not match the job")
                relative_path = require_relative_path(
                    item.get("relativePath"), "scan file relativePath"
                )
                if not isinstance(item.get("extension"), str):
                    raise AcceptanceError("scan file result extension is invalid")
                kind = item.get("candidateKind")
                outcome = item.get("outcome")
                if kind not in FILE_KINDS or outcome not in FILE_OUTCOMES:
                    raise AcceptanceError("scan file result kind or outcome is unknown")
                allowed = {
                    "SUPPORTED_AUDIO": {"PARSED", "UNSUPPORTED", "FAILED"},
                    "KNOWN_UNSUPPORTED_AUDIO": {"UNSUPPORTED"},
                    "SYMLINK": {"SKIPPED"},
                    "TRAVERSAL_ERROR": {"FAILED"},
                }
                if outcome not in allowed[str(kind)]:
                    raise AcceptanceError("scan file result kind/outcome pairing is invalid")
                for nullable_string in ("mediaFileId", "errorCode", "errorStage"):
                    value = item.get(nullable_string)
                    if value is not None and not isinstance(value, str):
                        raise AcceptanceError("scan file result has an invalid nullable string")
                for nullable_number in ("sizeBytes", "modifiedAtMs"):
                    value = item.get(nullable_number)
                    if value is not None and (
                        isinstance(value, bool)
                        or not isinstance(value, (int, float))
                        or value < 0
                    ):
                        raise AcceptanceError("scan file result has an invalid nullable number")
                warnings = require_list(item.get("warningCodes"), "scan warningCodes")
                if (
                    any(not isinstance(code, str) or not code for code in warnings)
                    or len(set(warnings)) != len(warnings)
                ):
                    raise AcceptanceError("scan file result warningCodes are invalid")
                files.append(item)
            offset += len(items)
            if offset >= total:
                break
            if not items:
                raise AcceptanceError("scan file ledger stopped before total")
        if expected_total is None or len(files) != expected_total:
            raise AcceptanceError("not every scan file result was fetched")
        return files

    @staticmethod
    def hash_scan_evidence(
        scan_id: str,
        root_id: str,
        status: str,
        rules_version: str,
        counts: dict[str, int],
        boundary_evidence: bool,
        album_count: int,
        album_issue_count: int,
        files: list[dict[str, Any]],
    ) -> str:
        summary = {
            "scanJobId": scan_id,
            "rootId": root_id,
            "status": status,
            "rulesVersion": rules_version,
            "candidates": counts["candidates"],
            "processed": counts["processed"],
            "parsed": counts["parsed"],
            "unsupported": counts["unsupported"],
            "failed": counts["failed"],
            "unprocessed": counts["unprocessed"],
            "regularFiles": counts["regularFiles"],
            "auxiliaryFiles": counts["auxiliaryFiles"],
            "ignoredFiles": counts["ignoredFiles"],
            "skippedSymlinks": counts["skippedSymlinks"],
            "traversalErrors": counts["traversalErrors"],
            "boundaryEvidence": boundary_evidence,
            "albumCount": album_count,
            "albumIssueCount": album_issue_count,
        }
        digest = hashlib.sha256(js_json(summary).encode("utf-8"))
        ordered = sorted(
            files,
            key=lambda item: (
                str(item["candidateKind"]),
                str(item["relativePath"]),
                int(item["id"]),
            ),
        )
        for item in ordered:
            ledger_line = [
                item["relativePath"],
                item["extension"],
                item["candidateKind"],
                item["outcome"],
                item.get("mediaFileId"),
                item.get("sizeBytes"),
                item.get("modifiedAtMs"),
                item.get("errorCode"),
                item.get("errorStage"),
                js_json(item["warningCodes"]),
            ]
            digest.update(b"\n")
            digest.update(js_json(ledger_line).encode("utf-8"))
        return digest.hexdigest()

    def fetch_albums(self) -> tuple[list[dict[str, Any]], int]:
        albums: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        offset = 0
        expected_total: int | None = None
        pages = 0
        while expected_total is None or offset < expected_total:
            page = self.client.request_json(
                "GET",
                f"/api/v1/albums?limit={self.arguments.page_size}&offset={offset}",
                "Album page",
            )
            items = require_list(page.get("items"), "Album page items")
            total = require_count(page.get("total"), "Album page total")
            if expected_total is None:
                expected_total = total
            elif total != expected_total:
                raise AcceptanceError("Album total changed during pagination")
            if require_count(page.get("offset"), "Album page offset") != offset:
                raise AcceptanceError("Album pagination returned the wrong offset")
            if len(items) > self.arguments.page_size:
                raise AcceptanceError("Album page exceeded the requested limit")
            for raw in items:
                album = require_object(raw, "Album summary")
                album_id = require_string(album.get("id"), "Album id")
                if album_id in seen_ids:
                    raise AcceptanceError("Album pagination returned a duplicate id")
                seen_ids.add(album_id)
                albums.append(album)
            pages += 1
            offset += len(items)
            if offset >= total:
                break
            if not items:
                raise AcceptanceError("Album pagination stopped before total")
        if expected_total is None or len(albums) != expected_total:
            raise AcceptanceError("not every Album summary was fetched")
        return albums, pages

    def fetch_album_details(
        self, albums: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], list[str]]:
        details: list[dict[str, Any]] = []
        artwork_paths: list[str] = []
        track_ids: set[str] = set()
        detail_warning_codes: dict[str, tuple[str, ...]] = {}
        for album in albums:
            album_id = require_string(album.get("id"), "Album id")
            encoded_id = urllib.parse.quote(album_id, safe="")
            detail = self.client.request_json(
                "GET", f"/api/v1/albums/{encoded_id}", "Album detail"
            )
            if detail.get("id") != album_id:
                raise AcceptanceError("Album detail id does not match its summary")
            require_string(detail.get("title"), "Album detail title")
            require_string(detail.get("albumArtist"), "Album detail artist")
            tracks = require_list(detail.get("tracks"), "Album detail tracks")
            track_count = require_count(detail.get("trackCount"), "Album detail trackCount")
            if len(tracks) != track_count:
                raise AcceptanceError("Album detail trackCount does not match its tracks")
            source_version_count = require_count(
                detail.get("sourceVersionCount", 1),
                "Album detail sourceVersionCount",
            )
            duplicate_file_count = require_count(
                detail.get("duplicateFileCount", 0),
                "Album detail duplicateFileCount",
            )
            if source_version_count < 1:
                raise AcceptanceError("Album detail sourceVersionCount is not positive")
            if duplicate_file_count > 0 and source_version_count < 2:
                raise AcceptanceError(
                    "Album duplicate files require more than one source version"
                )
            for track in tracks:
                track_object = require_object(track, "Album track")
                track_id = require_string(track_object.get("id"), "Album track id")
                if track_id in track_ids:
                    raise AcceptanceError("Album details contain a duplicate Track id")
                track_ids.add(track_id)
                require_string(track_object.get("title"), "Album track title")
                require_string(track_object.get("artist"), "Album track artist")
                require_relative_path(
                    track_object.get("relativePath"), "Album track relativePath"
                )
                warning_codes = require_list(
                    track_object.get("warningCodes"), "Album track warningCodes"
                )
                if any(not isinstance(code, str) or not code for code in warning_codes):
                    raise AcceptanceError("Album track warningCodes are invalid")
                if len(set(warning_codes)) != len(warning_codes):
                    raise AcceptanceError("Album track warningCodes contain duplicates")
                self.track_warning_codes.extend(str(code) for code in warning_codes)
                detail_warning_codes[track_id] = tuple(
                    sorted(str(code) for code in warning_codes)
                )
                require_positive_number(track_object.get("sizeBytes"), "Album track sizeBytes")
                for position in ("discNumber", "trackNumber"):
                    value = track_object.get(position)
                    if value is not None and (
                        isinstance(value, bool)
                        or not isinstance(value, int)
                        or value <= 0
                    ):
                        raise AcceptanceError(f"Album track {position} is invalid")
                audio = require_object(
                    track_object.get("audioSpec"), "Album track audioSpec"
                )
                kind = audio.get("kind")
                if kind not in {"PCM", "DSD", "DXD", "LOSSY"}:
                    raise AcceptanceError("Album track audio kind is unknown")
                require_string(audio.get("codec"), "Album track codec")
                require_string(audio.get("container"), "Album track container")
                require_positive_number(
                    audio.get("sampleRate"), "Album track sampleRate"
                )
                require_positive_number(audio.get("channels"), "Album track channels")
                if kind in {"PCM", "DXD", "DSD"}:
                    require_positive_number(
                        audio.get("bitDepth"), "Album track bitDepth"
                    )
                if kind == "DSD":
                    if audio.get("dsdRate") not in {
                        "DSD64",
                        "DSD128",
                        "DSD256",
                        "DSD512",
                    }:
                        raise AcceptanceError("Album track DSD multiplier is invalid")
                    if audio.get("bitDepth") != 1:
                        raise AcceptanceError("Album track DSD bit depth is not 1")
            artwork = require_object(detail.get("artwork"), "Album artwork")
            artwork_url = artwork.get("url")
            if artwork.get("source") == "NONE":
                if artwork_url is not None:
                    raise AcceptanceError("Album artwork NONE unexpectedly has a URL")
            else:
                if not isinstance(artwork_url, str) or not ARTWORK_PATH.fullmatch(artwork_url):
                    raise AcceptanceError("Album artwork URL violates the same-origin contract")
                artwork_paths.append(artwork_url)
            details.append(detail)
        self.detail_track_ids = track_ids
        self.detail_warning_codes_by_media_id = detail_warning_codes
        return details, artwork_paths

    def fetch_artworks(self, artwork_paths: list[str]) -> int:
        fetched = 0
        for path in artwork_paths:
            _, headers, body = self.client.request_bytes(path, "artwork GET")
            if not headers.get("content-type", "").lower().startswith("image/"):
                raise AcceptanceError("artwork GET did not return an image content type")
            if not body:
                raise AcceptanceError("artwork GET returned an empty body")
            expected_hash = path.rsplit("/", 1)[-1]
            if hashlib.sha256(body).hexdigest() != expected_hash:
                raise AcceptanceError("artwork body checksum does not match its URL")
            fetched += 1
        return fetched

    def check_listen_ranges(self, details: list[dict[str, Any]]) -> int:
        selected: list[str] = []
        for detail in details:
            tracks = require_list(detail.get("tracks"), "Album detail tracks")
            if not tracks:
                continue
            selected_tracks = tracks if self.arguments.listen_mode == "each-track" else tracks[:1]
            for track in selected_tracks:
                track_object = require_object(track, "Album track")
                selected.append(
                    require_string(track_object.get("id"), "Album track id")
                )
            if self.arguments.listen_mode == "representative":
                break
        for track_id in selected:
            encoded_id = urllib.parse.quote(track_id, safe="")
            status, headers, body = self.client.request_bytes(
                f"/api/v1/tracks/{encoded_id}/listen",
                "Listen Range",
                headers={"Range": "bytes=0-0"},
                expected=(206,),
                max_bytes=1,
            )
            if status != 206:
                raise AcceptanceError("Listen Range did not return HTTP 206")
            if headers.get("accept-ranges", "").lower() != "bytes":
                raise AcceptanceError("Listen Range did not advertise byte ranges")
            content_range = re.fullmatch(
                r"bytes 0-([0-9]+)/([0-9]+)", headers.get("content-range", "")
            )
            if not content_range:
                raise AcceptanceError("Listen Range returned an invalid Content-Range")
            range_end = int(content_range.group(1))
            total_size = int(content_range.group(2))
            if range_end != 0 or total_size <= range_end or len(body) != 1:
                raise AcceptanceError("Listen Range byte counts do not match Content-Range")
            if not body:
                raise AcceptanceError("Listen Range returned an empty body")
        return len(selected)

    def finish(self, status: str, error: AcceptanceError | None = None) -> None:
        self.report["status"] = status
        self.report["finishedAt"] = utc_now()
        self.report["durationSeconds"] = round(
            time.monotonic() - self.started_monotonic, 3
        )
        if error is not None:
            self.report["gates"].append(
                {"name": self.current_gate, "status": "failed"}
            )
            self.report["failure"] = {
                "gate": self.current_gate,
                "message": str(error),
            }


def write_report(path_value: str, report: dict[str, Any]) -> None:
    path = Path(path_value)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            json.dump(report, stream, ensure_ascii=True, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "--base-url",
        default=os.environ.get("COCEAN_ACCEPTANCE_BASE_URL", "http://server:8080"),
    )
    result.add_argument(
        "--report",
        default=os.environ.get(
            "COCEAN_ACCEPTANCE_REPORT",
            "/var/lib/cocean/acceptance/api-report.json",
        ),
    )
    result.add_argument(
        "--manifest",
        default=os.environ.get(
            "COCEAN_ACCEPTANCE_MANIFEST",
            "/var/lib/cocean/acceptance/music-before.jsonl",
        ),
    )
    result.add_argument(
        "--manifest-hash",
        choices=("sha256", "none"),
        default=os.environ.get("COCEAN_ACCEPTANCE_MANIFEST_HASH", "sha256"),
    )
    result.add_argument(
        "--exclude-directories-json",
        default=os.environ.get("COCEAN_SCAN_EXCLUDE_DIRS", "[]"),
        help=argparse.SUPPRESS,
    )
    result.add_argument(
        "--existing-scan-id",
        default=os.environ.get("COCEAN_ACCEPTANCE_EXISTING_SCAN_ID", ""),
        help=argparse.SUPPRESS,
    )
    result.add_argument(
        "--allowed-unsupported-extensions-json",
        default=(
            os.environ.get("COCEAN_ACCEPTANCE_ALLOWED_UNSUPPORTED_EXTENSIONS", "")
            or "{}"
        ),
        help=argparse.SUPPRESS,
    )
    result.add_argument(
        "--request-timeout",
        type=positive_float,
        default=float(os.environ.get("COCEAN_ACCEPTANCE_REQUEST_TIMEOUT", "15")),
    )
    result.add_argument(
        "--scan-timeout",
        type=positive_float,
        default=float(os.environ.get("COCEAN_ACCEPTANCE_SCAN_TIMEOUT", "7200")),
    )
    result.add_argument(
        "--poll-interval",
        type=positive_float,
        default=float(os.environ.get("COCEAN_ACCEPTANCE_POLL_INTERVAL", "2")),
    )
    result.add_argument(
        "--max-failures",
        type=nonnegative,
        default=int(os.environ.get("COCEAN_ACCEPTANCE_MAX_FAILURES", "0")),
    )
    result.add_argument(
        "--min-albums",
        type=nonnegative,
        default=int(os.environ.get("COCEAN_ACCEPTANCE_MIN_ALBUMS", "1")),
    )
    result.add_argument(
        "--min-artworks",
        type=nonnegative,
        default=int(os.environ.get("COCEAN_ACCEPTANCE_MIN_ARTWORKS", "1")),
    )
    result.add_argument(
        "--max-missing-artworks",
        type=nonnegative,
        default=int(os.environ.get("COCEAN_ACCEPTANCE_MAX_MISSING_ARTWORKS", "0")),
    )
    result.add_argument(
        "--max-album-issues",
        type=nonnegative,
        default=int(os.environ.get("COCEAN_ACCEPTANCE_MAX_ALBUM_ISSUES", "0")),
    )
    result.add_argument(
        "--max-ignored-files",
        type=nonnegative,
        default=int(os.environ.get("COCEAN_ACCEPTANCE_MAX_IGNORED_FILES", "0")),
    )
    result.add_argument(
        "--max-skipped-symlinks",
        type=nonnegative,
        default=int(
            os.environ.get("COCEAN_ACCEPTANCE_MAX_SKIPPED_SYMLINKS", "0")
        ),
    )
    result.add_argument(
        "--max-cue-files",
        type=nonnegative,
        default=int(os.environ.get("COCEAN_ACCEPTANCE_MAX_CUE_FILES", "0")),
    )
    result.add_argument(
        "--max-other-entries",
        type=nonnegative,
        default=int(os.environ.get("COCEAN_ACCEPTANCE_MAX_OTHER_ENTRIES", "0")),
    )
    result.add_argument(
        "--max-tag-warnings",
        type=nonnegative,
        default=int(os.environ.get("COCEAN_ACCEPTANCE_MAX_TAG_WARNINGS", "0")),
    )
    result.add_argument(
        "--max-technical-warnings",
        type=nonnegative,
        default=int(
            os.environ.get("COCEAN_ACCEPTANCE_MAX_TECHNICAL_WARNINGS", "0")
        ),
    )
    result.add_argument(
        "--listen-mode",
        choices=("representative", "each-album", "each-track"),
        default=os.environ.get("COCEAN_ACCEPTANCE_LISTEN_MODE", "each-track"),
    )
    result.add_argument(
        "--page-size",
        type=page_size,
        default=int(os.environ.get("COCEAN_ACCEPTANCE_PAGE_SIZE", "500")),
        help=argparse.SUPPRESS,
    )
    return result


def main() -> int:
    arguments = parser().parse_args()
    try:
        run = AcceptanceRun(arguments)
    except AcceptanceError as error:
        print(f"api-acceptance: FAIL: {error}", file=sys.stderr)
        return 1
    try:
        run.run()
    except AcceptanceError as error:
        run.finish("failed", error)
        try:
            write_report(arguments.report, run.report)
        except OSError:
            print("api-acceptance: FAIL: report could not be written", file=sys.stderr)
            return 2
        print(f"api-acceptance: FAIL: {error}", file=sys.stderr)
        return 1
    except Exception:
        error = AcceptanceError("an unexpected local acceptance error occurred")
        run.finish("failed", error)
        try:
            write_report(arguments.report, run.report)
        except OSError:
            print("api-acceptance: FAIL: report could not be written", file=sys.stderr)
            return 2
        print(f"api-acceptance: FAIL: {error}", file=sys.stderr)
        return 1
    run.finish("passed")
    try:
        write_report(arguments.report, run.report)
    except OSError:
        print("api-acceptance: FAIL: report could not be written", file=sys.stderr)
        return 2
    coverage = run.report.get("coverage", {})
    print(
        "api-acceptance: PASS: "
        f"albums={coverage.get('albumSummaries', 0)} "
        f"details={coverage.get('albumDetails', 0)} "
        f"artwork={coverage.get('artworkResponses', 0)} "
        f"listen206={coverage.get('listenRangeResponses', 0)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
