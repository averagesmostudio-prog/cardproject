#!/bin/bash
# Copies the three release zips into the Google Drive for desktop folder that
# backs "Script App" on Drive. Overwriting in place keeps each file's Drive
# link/ID — Drive for desktop uploads the new bytes in the background.
#
#   scripts/publish-to-drive.sh [zip-dir]     (default: ./release)
set -euo pipefail
SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)/release}"
DEST="$HOME/Library/CloudStorage/GoogleDrive-averagesmostudio@gmail.com/My Drive/Script App"
[ -d "$DEST" ] || { echo "Drive folder not found (is Google Drive for desktop running?): $DEST" >&2; exit 1; }
for os in Mac Windows Linux; do
  f="Scripturas Alpha - Current - $os.zip"
  [ -f "$SRC/$f" ] || { echo "missing $SRC/$f" >&2; exit 1; }
  cp -f "$SRC/$f" "$DEST/$f"
  a=$(stat -f %z "$SRC/$f"); b=$(stat -f %z "$DEST/$f")
  [ "$a" = "$b" ] || { echo "size mismatch for $f ($a vs $b)" >&2; exit 1; }
  echo "$os: $b bytes"
done
echo "Copied. Drive for desktop will finish uploading in the background."
