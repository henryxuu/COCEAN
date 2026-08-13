#!/usr/bin/env python3
"""Black-box tests for the path-safe API acceptance runner."""

from __future__ import annotations

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
from pathlib import Path
from socketserver import TCPServer
import subprocess
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlsplit


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "fnos_api_acceptance.py"
ART_BYTES = b"not-a-real-jpeg-but-checksummed"
ART_HASH = hashlib.sha256(ART_BYTES).hexdigest()


class LocalThreadingHTTPServer(ThreadingHTTPServer):
    """HTTP test server that never performs host-name/DNS discovery."""

    def server_bind(self) -> None:
        TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = self.server_address[1]


def album_summary(album_id: str, artwork: bool) -> dict[str, object]:
    return {
        "id": album_id,
        "title": f"Album {album_id}",
        "albumArtist": "Artist",
        "year": 2026,
        "artwork": {
            "source": "EMBEDDED" if artwork else "NONE",
            "url": f"/api/v1/artwork/{ART_HASH}" if artwork else None,
            "mimeType": "image/jpeg" if artwork else None,
            "width": 100 if artwork else None,
            "height": 100 if artwork else None,
        },
        "audioBadge": "24-bit / 96 kHz",
        "audioSummary": {"kind": "PCM"},
        "mixedAudioSpecs": False,
        "hasDigital": True,
        "physicalMedia": [],
        "matchStatus": "UNMATCHED",
        "trackCount": 1,
        "discCount": 1,
    }


def album_detail(
    album_id: str,
    artwork: bool,
    *,
    unknown_audio: bool = False,
    warning_codes: list[str] | None = None,
    local_version_count: int = 1,
) -> dict[str, object]:
    result = album_summary(album_id, artwork)
    result.update(
        {
            "release": {
                "label": None,
                "catalogNumber": None,
                "barcode": None,
                "country": None,
                "releaseDate": None,
                "musicBrainzReleaseId": None,
            },
            "tracks": [
                {
                    "id": f"track-{album_id}",
                    "title": "Track",
                    "artist": "Artist",
                    "discNumber": 1,
                    "trackNumber": 1,
                    "durationSeconds": 60,
                    "sizeBytes": 10,
                    "audioSpec": {
                        "kind": "PCM",
                        "codec": "flac",
                        "container": "flac",
                        "lossless": True,
                        "bitDepth": 24,
                        "sampleRate": 96_000,
                        "bitrate": 2_000_000,
                        "channels": 2,
                        "dsdRate": None,
                    },
                    "relativePath": f"Artist/{album_id}/01.flac",
                    "warningCodes": warning_codes or [],
                }
            ],
            "physicalCopies": [],
            "sourceRoot": {
                "id": "music",
                "name": "Music",
                "containerPath": "/library/music",
                "readOnly": True,
            },
            "sourceVersionCount": local_version_count,
            "duplicateFileCount": local_version_count - 1,
            "localVersions": [
                {
                    "id": f"{album_id}-version-{index + 1}",
                    "title": f"Album {album_id}",
                    "albumArtist": "Artist",
                    "year": 2026,
                    "isPrimary": index == 0,
                    "relationshipStatus": "USER_CONFIRMED",
                    "sourceRoot": {
                        "id": "music",
                        "name": "Music",
                        "containerPath": "/library/music",
                        "readOnly": True,
                    },
                    "relativePath": f"Artist/{album_id}",
                    "audioBadge": "24-bit / 96 kHz",
                    "mixedAudioSpecs": False,
                    "trackCount": 1,
                    "fileCount": 1,
                    "sourceVersionCount": 1,
                    "duplicateFileCount": 0,
                    "sizeBytes": 10,
                    "completeness": "COMPLETE",
                    "issues": [],
                }
                for index in range(local_version_count)
            ],
        }
    )
    if unknown_audio:
        tracks = result["tracks"]
        assert isinstance(tracks, list)
        track = tracks[0]
        assert isinstance(track, dict)
        audio = track["audioSpec"]
        assert isinstance(audio, dict)
        audio["kind"] = "UNKNOWN"
    return result


class MockState:
    def __init__(
        self,
        *,
        incomplete_failures: bool = False,
        bad_range: bool = False,
        unknown_audio: bool = False,
        bad_artwork_hash: bool = False,
        ignored_files: int = 0,
        cue_files: int = 0,
        warning_codes: list[str] | None = None,
        ledger_warning_codes: list[str] | None = None,
        unsupported_extension: str = ".iso",
        unsupported_error_code: str = "UNSUPPORTED_MEDIA",
        grouped_local_versions: bool = False,
    ):
        self.incomplete_failures = incomplete_failures
        self.bad_range = bad_range
        self.unknown_audio = unknown_audio
        self.bad_artwork_hash = bad_artwork_hash
        self.warning_codes = warning_codes or []
        self.ledger_warning_codes = (
            self.warning_codes
            if ledger_warning_codes is None
            else ledger_warning_codes
        )
        self.post_requests = 0
        self.grouped_local_versions = grouped_local_versions
        self.albums = [album_summary("one", True)]
        if not grouped_local_versions:
            self.albums.append(album_summary("two", False))
        failure_count = 2 if incomplete_failures else 1
        self.job = {
            "id": "scan-test",
            "rootId": "music",
            "status": "COMPLETED_WITH_WARNINGS",
            "totalFiles": 2 + failure_count,
            "processedFiles": 2 + failure_count,
            "parsedFiles": 2,
            "failedFiles": failure_count,
            "createdAt": "2026-08-12T00:00:00Z",
            "startedAt": "2026-08-12T00:00:01Z",
            "finishedAt": "2026-08-12T00:00:02Z",
            "error": None,
        }
        self.failures = [
            {
                "relativePath": "/volume1/private/Token-Cookie.iso",
                "code": "UNSUPPORTED_MEDIA",
                "stage": "discover",
                "message": "Cookie=secret Token=secret",
                "recoverable": True,
            }
        ]
        self.file_results = [
            {
                "id": 1,
                "scanJobId": "scan-test",
                "rootId": "music",
                "relativePath": "Artist/One/01.flac",
                "extension": ".flac",
                "candidateKind": "SUPPORTED_AUDIO",
                "outcome": "PARSED",
                "mediaFileId": "track-one",
                "sizeBytes": 10,
                "modifiedAtMs": 1_700_000_000_000,
                "errorCode": None,
                "errorStage": None,
                "warningCodes": self.ledger_warning_codes,
                "createdAt": "2026-08-12T00:00:02Z",
            },
            {
                "id": 2,
                "scanJobId": "scan-test",
                "rootId": "music",
                "relativePath": "Artist/Two/01.flac",
                "extension": ".flac",
                "candidateKind": "SUPPORTED_AUDIO",
                "outcome": "PARSED",
                "mediaFileId": "track-two",
                "sizeBytes": 10,
                "modifiedAtMs": 1_700_000_000_001,
                "errorCode": None,
                "errorStage": None,
                "warningCodes": [],
                "createdAt": "2026-08-12T00:00:02Z",
            },
            {
                "id": 3,
                "scanJobId": "scan-test",
                "rootId": "music",
                "relativePath": f"Artist/Broken/01{unsupported_extension}",
                "extension": unsupported_extension,
                "candidateKind": "KNOWN_UNSUPPORTED_AUDIO",
                "outcome": "UNSUPPORTED",
                "mediaFileId": None,
                "sizeBytes": 10,
                "modifiedAtMs": 1_700_000_000_002,
                "errorCode": unsupported_error_code,
                "errorStage": "discover",
                "warningCodes": [],
                "createdAt": "2026-08-12T00:00:02Z",
            },
        ]
        if incomplete_failures:
            self.file_results.append(
                {
                    "id": 4,
                    "scanJobId": "scan-test",
                    "rootId": "music",
                    "relativePath": "Artist/Broken/02.flac",
                    "extension": ".flac",
                    "candidateKind": "SUPPORTED_AUDIO",
                    "outcome": "FAILED",
                    "mediaFileId": None,
                    "sizeBytes": 10,
                    "modifiedAtMs": 1_700_000_000_003,
                    "errorCode": "METADATA_PARSE_FAILED",
                    "errorStage": "probe",
                    "warningCodes": [],
                    "createdAt": "2026-08-12T00:00:02Z",
                }
            )
        parsed_count = 2
        unsupported_count = 1
        failed_count = 1 if incomplete_failures else 0
        report_counts = {
            "candidates": len(self.file_results),
            "processed": len(self.file_results),
            "parsed": parsed_count,
            "unsupported": unsupported_count,
            "failed": failed_count,
            "unprocessed": 0,
            "regularFiles": len(self.file_results) + ignored_files + cue_files,
            "auxiliaryFiles": cue_files,
            "ignoredFiles": ignored_files,
            "skippedSymlinks": 0,
            "traversalErrors": 0,
        }
        summary = {
            "scanJobId": "scan-test",
            "rootId": "music",
            "status": "COMPLETED_WITH_WARNINGS",
            "rulesVersion": "cocean-library-scan/v1",
            **report_counts,
            "boundaryEvidence": True,
            "albumCount": 2,
            "albumIssueCount": 0,
        }
        digest = hashlib.sha256(js_json(summary).encode("utf-8"))
        for item in sorted(
            self.file_results,
            key=lambda value: (
                str(value["candidateKind"]),
                str(value["relativePath"]),
                int(value["id"]),
            ),
        ):
            line = [
                item["relativePath"],
                item["extension"],
                item["candidateKind"],
                item["outcome"],
                item["mediaFileId"],
                item["sizeBytes"],
                item["modifiedAtMs"],
                item["errorCode"],
                item["errorStage"],
                js_json(item["warningCodes"]),
            ]
            digest.update(b"\n")
            digest.update(js_json(line).encode("utf-8"))
        self.scan_report = {
            "scanJobId": "scan-test",
            "rootId": "music",
            "status": "COMPLETED_WITH_WARNINGS",
            "rulesVersion": "cocean-library-scan/v1",
            "summaryHash": digest.hexdigest(),
            "candidateScope": "SUPPORTED_AND_KNOWN_UNSUPPORTED_AUDIO",
            **report_counts,
            "albumCount": 2,
            "albumIssueCount": 0,
            "trackSemantics": "ONE_AUDIO_FILE_ONE_TRACK",
            "cueSheetSupport": "AUXILIARY_ONLY",
            "invariants": {
                "candidateBalance": True,
                "outcomeBalance": True,
                "regularFileBalance": True,
                "boundaryEvidence": True,
                "valid": True,
            },
            "startedAt": "2026-08-12T00:00:01Z",
            "finishedAt": "2026-08-12T00:00:02Z",
            "durationMs": 1000,
            "createdAt": "2026-08-12T00:00:02Z",
        }
        self.manifest_records = [
            {
                "path": item["relativePath"],
                "type": "file",
                "size": item["sizeBytes"],
                "mtime_ns": int(item["modifiedAtMs"]) * 1_000_000,
                "sha256": "a" * 64,
            }
            for item in self.file_results
        ]
        self.manifest_records.extend(
            {
                "path": f"Artist/Notes/ignored-{index}.bin",
                "type": "file",
                "size": 1,
                "mtime_ns": 1_700_000_000_000_000_000 + index,
                "sha256": "b" * 64,
            }
            for index in range(ignored_files)
        )
        self.manifest_records.extend(
            {
                "path": f"Artist/Cue/disc-{index}.cue",
                "type": "file",
                "size": 1,
                "mtime_ns": 1_700_000_000_100_000_000 + index,
                "sha256": "c" * 64,
            }
            for index in range(cue_files)
        )


def js_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def handler_for(state: MockState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: object) -> None:
            return

        def json_response(self, status: int, payload: object) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("content-length", "0"))
            self.rfile.read(length)
            if self.path == "/api/v1/scans":
                state.post_requests += 1
                queued = dict(state.job)
                queued["status"] = "QUEUED"
                queued["totalFiles"] = 0
                queued["processedFiles"] = 0
                queued["parsedFiles"] = 0
                queued["failedFiles"] = 0
                self.json_response(202, queued)
                return
            self.json_response(404, {})

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlsplit(self.path)
            query = parse_qs(parsed.query)
            path = parsed.path
            if path == "/api/v1/readiness":
                self.json_response(
                    200,
                    {
                        "status": "ready",
                        "database": "ready",
                        "musicRoot": {
                            "path": "/library/music",
                            "readable": True,
                            "kind": "directory",
                            "readOnlyPolicy": True,
                        },
                    },
                )
                return
            if path == "/api/v1/scans/scan-test":
                self.json_response(200, state.job)
                return
            if path == "/api/v1/scans/scan-test/report":
                self.json_response(200, state.scan_report)
                return
            if path == "/api/v1/scans/scan-test/files":
                offset = int(query.get("offset", ["0"])[0])
                limit = int(query.get("limit", ["500"])[0])
                self.json_response(
                    200,
                    {
                        "items": state.file_results[offset : offset + limit],
                        "limit": limit,
                        "offset": offset,
                        "total": len(state.file_results),
                    },
                )
                return
            if path == "/api/v1/scans/scan-test/failures":
                offset = int(query.get("offset", ["0"])[0])
                limit = int(query.get("limit", ["500"])[0])
                items = state.failures[offset : offset + limit]
                self.json_response(
                    200,
                    {
                        "items": items,
                        "limit": limit,
                        "offset": offset,
                        "total": state.job["failedFiles"],
                    },
                )
                return
            if path == "/api/v1/library/stats":
                self.json_response(
                    200,
                    {
                        "albums": len(state.albums),
                        "tracks": len(state.albums),
                        "files": 2,
                        "needsReview": len(state.albums),
                        "missingArtwork": sum(
                            1
                            for album in state.albums
                            if album["artwork"]["source"] == "NONE"
                        ),
                        "parseFailures": state.job["failedFiles"],
                        "lastScanAt": "2026-08-12T00:00:02Z",
                    },
                )
                return
            if path == "/api/v1/albums":
                offset = int(query.get("offset", ["0"])[0])
                limit = int(query.get("limit", ["500"])[0])
                self.json_response(
                    200,
                    {
                        "items": state.albums[offset : offset + limit],
                        "limit": limit,
                        "offset": offset,
                        "total": len(state.albums),
                    },
                )
                return
            if path in {"/api/v1/albums/one", "/api/v1/albums/two"}:
                album_id = path.rsplit("/", 1)[-1]
                self.json_response(
                    200,
                    album_detail(
                        album_id,
                        album_id == "one",
                        unknown_audio=state.unknown_audio and album_id == "one",
                        warning_codes=(
                            state.warning_codes if album_id == "one" else []
                        ),
                        local_version_count=(
                            2
                            if state.grouped_local_versions and album_id == "one"
                            else 1
                        ),
                    ),
                )
                return
            if path == f"/api/v1/artwork/{ART_HASH}":
                body = b"changed-after-index" if state.bad_artwork_hash else ART_BYTES
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if path in {"/api/v1/tracks/track-one/listen", "/api/v1/tracks/track-two/listen"}:
                body = b"0"
                status = 200 if state.bad_range else 206
                self.send_response(status)
                self.send_header("Content-Type", "audio/flac")
                self.send_header("Accept-Ranges", "bytes")
                if status == 206:
                    self.send_header("Content-Range", "bytes 0-0/10")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.json_response(404, {})

    return Handler


@contextmanager
def mock_server(state: MockState):  # type: ignore[no-untyped-def]
    server = LocalThreadingHTTPServer(("127.0.0.1", 0), handler_for(state))
    server.daemon_threads = True
    server.block_on_close = False
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class ApiAcceptanceTests(unittest.TestCase):
    def run_acceptance(
        self,
        state: MockState,
        *,
        allowed_unsupported_extensions: dict[str, int] | None = None,
        existing_scan_id: str | None = None,
        max_failures: int = 0,
    ) -> tuple[subprocess.CompletedProcess[str], dict[str, object], str]:
        with tempfile.TemporaryDirectory() as directory, mock_server(state) as base_url:
            report_path = Path(directory) / "report.json"
            manifest_path = Path(directory) / "music-before.jsonl"
            with manifest_path.open("w", encoding="utf-8", newline="\n") as stream:
                stream.write(
                    json.dumps(
                        {
                            "schema": "cocean.music-manifest/v2",
                            "hash": "sha256",
                            "excludedDirectories": [],
                        },
                        separators=(",", ":"),
                    )
                    + "\n"
                )
                for record in state.manifest_records:
                    stream.write(json.dumps(record, separators=(",", ":")) + "\n")
            arguments = [
                    "python3",
                    str(SCRIPT),
                    "--base-url",
                    base_url,
                    "--report",
                    str(report_path),
                    "--manifest",
                    str(manifest_path),
                    "--request-timeout",
                    "2",
                    "--scan-timeout",
                    "2",
                    "--poll-interval",
                    "0.01",
                    "--max-failures",
                    str(max_failures),
                    "--allowed-unsupported-extensions-json",
                    json.dumps(
                        {".iso": 1}
                        if allowed_unsupported_extensions is None
                        else allowed_unsupported_extensions,
                        separators=(",", ":"),
                    ),
                    "--max-missing-artworks",
                    "1",
                    "--max-album-issues",
                    "0",
                    "--listen-mode",
                    "each-track",
                    "--page-size",
                    "1",
                ]
            if existing_scan_id is not None:
                arguments.extend(["--existing-scan-id", existing_scan_id])
            process = subprocess.run(
                arguments,
                check=False,
                capture_output=True,
                text=True,
                timeout=10,
            )
            report_text = report_path.read_text(encoding="utf-8")
            return process, json.loads(report_text), report_text

    def assert_report_is_private(self, report_text: str) -> None:
        self.assertNotIn("/volume1/private", report_text)
        self.assertNotIn("Token=secret", report_text)
        self.assertNotIn("Cookie=secret", report_text)
        self.assertNotIn("127.0.0.1", report_text)
        self.assertNotIn("Artist/", report_text)

    def test_full_success_pages_albums_and_checks_every_track_range(self) -> None:
        state = MockState()
        process, report, report_text = self.run_acceptance(state)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(state.post_requests, 1)
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["coverage"]["albumPages"], 2)  # type: ignore[index]
        self.assertEqual(report["coverage"]["albumDetails"], 2)  # type: ignore[index]
        self.assertEqual(report["coverage"]["listenRangeResponses"], 2)  # type: ignore[index]
        self.assertEqual(report["scan"]["failureRecordsFetched"], 1)  # type: ignore[index]
        self.assertEqual(report["scan"]["failedFiles"], 1)  # type: ignore[index]
        self.assertEqual(report["scan"]["unsupportedFiles"], 1)  # type: ignore[index]
        self.assertEqual(report["scan"]["trueFailedFiles"], 0)  # type: ignore[index]
        self.assertEqual(report["evidence"]["unsupportedByExtension"], {".iso": 1})  # type: ignore[index]
        self.assertEqual(report["evidence"]["fileResultsFetched"], 3)  # type: ignore[index]
        self.assertRegex(str(report["evidence"]["summaryHash"]), r"^[a-f0-9]{64}$")  # type: ignore[index]
        self.assert_report_is_private(report_text)

    def test_existing_scan_is_reused_without_creating_a_new_scan(self) -> None:
        state = MockState()
        process, report, report_text = self.run_acceptance(
            state, existing_scan_id="scan-test"
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(state.post_requests, 0)
        self.assertTrue(report["policy"]["reusedExistingScan"])  # type: ignore[index]
        self.assertTrue(report["scan"]["reusedExistingScan"])  # type: ignore[index]
        self.assertNotIn("scan-test", report_text)
        self.assert_report_is_private(report_text)

    def test_grouped_album_reconciles_scan_count_against_local_versions(self) -> None:
        state = MockState(grouped_local_versions=True)
        process, report, report_text = self.run_acceptance(state)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["coverage"]["albumDetails"], 1)  # type: ignore[index]
        self.assert_report_is_private(report_text)

    def test_unsupported_extension_requires_an_explicit_policy_entry(self) -> None:
        process, report, report_text = self.run_acceptance(
            MockState(), allowed_unsupported_extensions={}
        )
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(report["failure"]["gate"], "scan-outcome-policy")  # type: ignore[index]
        self.assert_report_is_private(report_text)

    def test_unsupported_extension_cannot_exceed_its_explicit_limit(self) -> None:
        process, report, report_text = self.run_acceptance(
            MockState(), allowed_unsupported_extensions={".iso": 0}
        )
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(report["failure"]["gate"], "scan-outcome-policy")  # type: ignore[index]
        self.assert_report_is_private(report_text)

    def test_unsupported_outcome_requires_the_exact_error_code(self) -> None:
        process, report, report_text = self.run_acceptance(
            MockState(unsupported_error_code="METADATA_PARSE_FAILED")
        )
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(report["failure"]["gate"], "scan-outcome-policy")  # type: ignore[index]
        self.assert_report_is_private(report_text)

    def test_corrupt_flac_cannot_be_treated_as_a_known_unsupported_format(self) -> None:
        process, report, report_text = self.run_acceptance(
            MockState(unsupported_extension=".flac"),
            allowed_unsupported_extensions={".iso": 999},
            max_failures=999,
        )
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(report["failure"]["gate"], "scan-outcome-policy")  # type: ignore[index]
        self.assert_report_is_private(report_text)

    def test_true_flac_failure_is_not_consumed_by_unsupported_allowance(self) -> None:
        state = MockState(incomplete_failures=True)
        state.failures.append(
            {
                "relativePath": "/volume1/private/Broken.flac",
                "code": "METADATA_PARSE_FAILED",
                "stage": "probe",
                "message": "private failure detail",
                "recoverable": True,
            }
        )
        process, report, report_text = self.run_acceptance(
            state,
            allowed_unsupported_extensions={".iso": 1},
            max_failures=0,
        )
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(report["failure"]["gate"], "scan-count-reconciliation")  # type: ignore[index]
        self.assert_report_is_private(report_text)

    def test_incomplete_failure_pagination_fails_closed(self) -> None:
        process, report, report_text = self.run_acceptance(
            MockState(incomplete_failures=True)
        )
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["failure"]["gate"], "scan-failure-pagination")  # type: ignore[index]
        self.assert_report_is_private(report_text)

    def test_listen_requires_partial_content(self) -> None:
        process, report, report_text = self.run_acceptance(MockState(bad_range=True))
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(report["failure"]["gate"], "listen-range")  # type: ignore[index]
        self.assert_report_is_private(report_text)

    def test_evidence_hash_must_match_every_file_result(self) -> None:
        state = MockState()
        state.scan_report["summaryHash"] = "b" * 64
        process, report, report_text = self.run_acceptance(state)
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(report["failure"]["gate"], "scan-evidence-ledger")  # type: ignore[index]
        self.assert_report_is_private(report_text)

    def test_unknown_track_audio_facts_fail_closed(self) -> None:
        process, report, report_text = self.run_acceptance(
            MockState(unknown_audio=True)
        )
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(report["failure"]["gate"], "album-details")  # type: ignore[index]
        self.assert_report_is_private(report_text)

    def test_artwork_body_must_match_url_checksum(self) -> None:
        process, report, report_text = self.run_acceptance(
            MockState(bad_artwork_hash=True)
        )
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(report["failure"]["gate"], "artwork-get")  # type: ignore[index]
        self.assert_report_is_private(report_text)

    def test_ignored_regular_files_fail_the_manifest_boundary(self) -> None:
        process, report, report_text = self.run_acceptance(MockState(ignored_files=1))
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(report["failure"]["gate"], "manifest-scan-boundary")  # type: ignore[index]
        self.assert_report_is_private(report_text)

    def test_cue_files_require_an_explicit_acceptance_exception(self) -> None:
        process, report, report_text = self.run_acceptance(MockState(cue_files=1))
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(report["failure"]["gate"], "manifest-scan-boundary")  # type: ignore[index]
        self.assert_report_is_private(report_text)

    def test_missing_required_tags_fail_the_quality_gate(self) -> None:
        process, report, report_text = self.run_acceptance(
            MockState(warning_codes=["MISSING_ALBUM_TAG"])
        )
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(report["failure"]["gate"], "library-count-reconciliation")  # type: ignore[index]
        self.assert_report_is_private(report_text)

    def test_technical_fact_warnings_fail_the_quality_gate(self) -> None:
        process, report, report_text = self.run_acceptance(
            MockState(warning_codes=["TECHNICAL_METADATA_CONFLICT"])
        )
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(report["failure"]["gate"], "library-count-reconciliation")  # type: ignore[index]
        self.assert_report_is_private(report_text)

    def test_album_detail_cannot_drop_scan_warning_evidence(self) -> None:
        process, report, report_text = self.run_acceptance(
            MockState(
                warning_codes=[], ledger_warning_codes=["MISSING_ALBUM_TAG"]
            )
        )
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(report["failure"]["gate"], "library-count-reconciliation")  # type: ignore[index]
        self.assert_report_is_private(report_text)


if __name__ == "__main__":
    unittest.main()
