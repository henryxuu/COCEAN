#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture_dir="${1:-${script_dir}/generated-fixtures}"
album_dir="${fixture_dir}/album-with-cover"
mixed_cover_dir="${fixture_dir}/有声唱片/嵌入封面优先"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required to generate media-scanner fixtures" >&2
  exit 1
fi

mkdir -p "${fixture_dir}" "${album_dir}" "${mixed_cover_dir}"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=0.5" \
  -ac 2 -c:a flac -sample_fmt s16 \
  -metadata title="Fixture Track" \
  -metadata artist="COCEAN Fixture Artist" \
  -metadata album_artist="COCEAN Fixture Artist" \
  -metadata album="Fixture Album" \
  -metadata track="1/1" \
  "${fixture_dir}/cd-quality.flac"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=880:sample_rate=96000:duration=0.25" \
  -ac 2 -c:a flac -sample_fmt s32 -bits_per_raw_sample 24 \
  "${fixture_dir}/hires-24-96.flac"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=1000:sample_rate=352800:duration=0.1" \
  -ac 2 -c:a pcm_s24le \
  "${fixture_dir}/dxd-24-352k.wav"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0xc8a96a:s=128x128:d=0.1" \
  -frames:v 1 "${album_dir}/cover.jpg"

# A common dirty-library case is cover art carrying an audio extension. Both
# music-metadata and ffprobe inspect the same bytes, but may describe the
# failure differently; these copies lock the scanner's precedence rule to the
# authoritative probe result.
cp "${album_dir}/cover.jpg" "${fixture_dir}/jpeg-disguised-as-audio.flac"
cp "${album_dir}/cover.jpg" "${fixture_dir}/jpeg-disguised-as-audio.dsf"

# A real media container without an audio stream remains unsupported media; it
# is not classified as a still-image filename/content mismatch.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0x253045:s=64x64:d=0.1" \
  -frames:v 1 -an -c:v mpeg4 \
  "${fixture_dir}/video-only.mp4"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=523.25:sample_rate=44100:duration=0.25" \
  -ac 2 -c:a flac -sample_fmt s16 \
  -metadata title="Sidecar Artwork" \
  -metadata album="Fixture With Cover" \
  "${album_dir}/01-track.flac"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=659.25:sample_rate=44100:duration=0.25" \
  -i "${album_dir}/cover.jpg" \
  -map 0:a -map 1:v \
  -c:a libmp3lame -q:a 5 -c:v mjpeg \
  -id3v2_version 3 \
  -metadata title="Embedded Artwork" \
  -metadata:s:v title="Album cover" \
  -metadata:s:v comment="Cover (front)" \
  -disposition:v attached_pic \
  "${fixture_dir}/embedded-cover.mp3"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=733:sample_rate=48000:duration=0.2" \
  -ac 2 -c:a alac -sample_fmt s32p \
  -metadata title="夜航" \
  -metadata artist="测试艺术家" \
  -metadata album_artist="测试艺术家" \
  -metadata album="海上录音" \
  -metadata track="2/3" -metadata disc="1/1" \
  "${fixture_dir}/有声唱片/02 夜航.m4a"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=311:sample_rate=96000:duration=0.2" \
  -ac 2 -c:a pcm_s24be \
  -metadata title="AIFF 24/96" \
  "${fixture_dir}/hires-24-96.aiff"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=277:sample_rate=44100:duration=0.2" \
  -ac 2 -c:a flac -sample_fmt s16 \
  -metadata title="Matroska Lossless" \
  "${fixture_dir}/lossless-audio.mka"

# Use visibly different images so the test can prove that an embedded Front
# Cover wins over the sibling sidecar without comparing private paths.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0x1e4f8a:s=160x160:d=0.1" \
  -frames:v 1 "${mixed_cover_dir}/cover.jpg"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0xb94a3d:s=192x192:d=0.1" \
  -frames:v 1 "${mixed_cover_dir}/embedded-front.jpg"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=415.3:sample_rate=44100:duration=0.2" \
  -i "${mixed_cover_dir}/embedded-front.jpg" \
  -map 0:a -map 1:v \
  -c:a libmp3lame -q:a 5 -c:v mjpeg \
  -id3v2_version 3 \
  -metadata title="封面优先级" \
  -metadata artist="测试艺术家" \
  -metadata album_artist="测试艺术家" \
  -metadata album="嵌入封面优先" \
  -metadata:s:v title="Front Cover" \
  -metadata:s:v comment="Cover (front)" \
  -disposition:v attached_pic \
  "${mixed_cover_dir}/01 封面优先级.mp3"

# Derive a deterministic broken input from a valid ffmpeg fixture. This keeps
# corruption coverage reproducible without committing binary samples.
dd if="${fixture_dir}/cd-quality.flac" \
  of="${fixture_dir}/corrupt-truncated.flac" \
  bs=1 count=64 status=none

echo "Generated media fixtures in ${fixture_dir}"
