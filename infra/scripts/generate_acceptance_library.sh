#!/bin/sh
set -eu

target_dir=${1:?usage: generate_acceptance_library.sh ABSOLUTE_EMPTY_DIRECTORY}

case "$target_dir" in
  /*) ;;
  *) echo "target must be an absolute path" >&2; exit 64 ;;
esac

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required" >&2
  exit 69
fi

mkdir -p "$target_dir"
if find "$target_dir" -mindepth 1 -print -quit | grep -q .; then
  echo "target must be empty: $target_dir" >&2
  exit 73
fi

album_dir="$target_dir/COCEAN Test Artist/Glass Rooms"
mkdir -p "$album_dir/CD 1" "$album_dir/CD 2"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0xd8d2c8:s=640x640:d=0.1" \
  -frames:v 1 "$album_dir/cover.jpg"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=0.5" \
  -ac 2 -c:a flac -sample_fmt s16 \
  -metadata title="Opening" -metadata artist="COCEAN Test Artist" \
  -metadata album_artist="COCEAN Test Artist" -metadata album="Glass Rooms" \
  -metadata track="1/2" -metadata disc="1/2" -metadata date="1994" \
  -metadata genre="Ambient" -metadata label="Still Test Pressing" \
  "$album_dir/CD 1/01 Opening.flac"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=880:sample_rate=96000:duration=0.5" \
  -ac 2 -c:a flac -sample_fmt s32 -bits_per_raw_sample 24 \
  -metadata title="Return" -metadata artist="COCEAN Test Artist" \
  -metadata album_artist="COCEAN Test Artist" -metadata album="Glass Rooms" \
  -metadata track="2/2" -metadata disc="2/2" -metadata date="1994" \
  -metadata genre="Ambient" -metadata label="Still Test Pressing" \
  "$album_dir/CD 2/02 Return.flac"

dxd_dir="$target_dir/COCEAN DXD Ensemble/DXD Study"
mkdir -p "$dxd_dir"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=1000:sample_rate=352800:duration=0.1" \
  -ac 2 -c:a pcm_s24le \
  -metadata title="DXD Study" -metadata artist="COCEAN DXD Ensemble" \
  -metadata album_artist="COCEAN DXD Ensemble" -metadata album="DXD Study" \
  -metadata track="1/1" -metadata disc="1/1" -metadata date="2026" \
  "$dxd_dir/01 DXD Study.wav"

broken_dir="$target_dir/COCEAN Broken/Unreadable Album"
mkdir -p "$broken_dir"
dd if=/dev/zero of="$broken_dir/01 Broken.flac" bs=32 count=1 2>/dev/null

echo "Generated COCEAN acceptance library: $target_dir"
