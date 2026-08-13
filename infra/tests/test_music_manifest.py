#!/usr/bin/env python3
"""Contract tests for the exclusion-aware immutable Music manifest."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "music_manifest.py"


class MusicManifestTests(unittest.TestCase):
    def test_excluded_directory_is_absent_but_policy_is_in_header(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "music"
            data = Path(directory) / "data"
            album = root / "Artist" / "Album"
            backup = root / "RoonBackups"
            album.mkdir(parents=True)
            backup.mkdir()
            (album / "01.flac").write_bytes(b"audio")
            (backup / "database").write_bytes(b"private runtime data")
            baseline = data / "before.jsonl"
            after = data / "after.jsonl"

            snapshot = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "snapshot",
                    "--root",
                    str(root),
                    "--output",
                    str(baseline),
                    "--hash",
                    "none",
                    "--exclude-directories-json",
                    '["RoonBackups"]',
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(snapshot.returncode, 0, snapshot.stderr)
            lines = baseline.read_text(encoding="utf-8").splitlines()
            self.assertEqual(
                json.loads(lines[0]),
                {
                    "excludedDirectories": ["RoonBackups"],
                    "hash": "none",
                    "schema": "cocean.music-manifest/v2",
                },
            )
            self.assertEqual(
                [json.loads(line)["path"] for line in lines[1:]],
                ["Artist/Album/01.flac"],
            )

            (backup / "database").write_bytes(b"changed but explicitly excluded")
            verify = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "verify",
                    "--root",
                    str(root),
                    "--baseline",
                    str(baseline),
                    "--output",
                    str(after),
                    "--exclude-directories-json",
                    '["RoonBackups"]',
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(verify.returncode, 0, verify.stderr)

    def test_policy_change_or_included_file_change_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "music"
            data = Path(directory) / "data"
            root.mkdir()
            (root / "track.flac").write_bytes(b"before")
            baseline = data / "before.jsonl"
            after = data / "after.jsonl"
            subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "snapshot",
                    "--root",
                    str(root),
                    "--output",
                    str(baseline),
                    "--hash",
                    "none",
                    "--exclude-directories-json",
                    "[]",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            (root / "track.flac").write_bytes(b"after")
            changed = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "verify",
                    "--root",
                    str(root),
                    "--baseline",
                    str(baseline),
                    "--output",
                    str(after),
                    "--exclude-directories-json",
                    "[]",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(changed.returncode, 2)

            mismatch = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "verify",
                    "--root",
                    str(root),
                    "--baseline",
                    str(baseline),
                    "--output",
                    str(after),
                    "--exclude-directories-json",
                    '["new-policy"]',
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(mismatch.returncode, 64)


if __name__ == "__main__":
    unittest.main()
