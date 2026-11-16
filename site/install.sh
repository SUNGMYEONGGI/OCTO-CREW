#!/bin/sh
# Installs the latest OCTO CREW into /Applications.
# curl downloads carry no quarantine flag, so Gatekeeper doesn't block the unsigned build.
set -eu
[ "$(uname -s)" = Darwin ] || { echo "OCTO CREW runs on macOS only." >&2; exit 1; }
# uname -m says x86_64 in a Rosetta terminal; ask the hardware.
[ "$(sysctl -in hw.optional.arm64)" = 1 ] || { echo "OCTO CREW needs a Mac with Apple silicon." >&2; exit 1; }

LATEST=https://github.com/SUNGMYEONGGI/OCTO-CREW/releases/latest/download
TMP=$(mktemp -d)
MNT="$TMP/mnt"
trap 'hdiutil detach -quiet "$MNT" 2>/dev/null || true; rm -rf "$TMP"' EXIT

echo "Downloading OCTO CREW..."
# Releases before the rename only have PixelBot-arm64.dmg.
URL="$LATEST/OCTO-CREW-arm64.dmg"
curl -fL --progress-bar "$URL" -o "$TMP/app.dmg" || { URL="$LATEST/PixelBot-arm64.dmg"; curl -fL --progress-bar "$URL" -o "$TMP/app.dmg"; }
# The release publishes the DMG's SHA-256 next to it; refuse a download that doesn't match.
curl -fsL "$URL.sha256" -o "$TMP/app.dmg.sha256" || { echo "Couldn't download the checksum." >&2; exit 1; }
[ "$(shasum -a 256 "$TMP/app.dmg" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$TMP/app.dmg.sha256")" ] || { echo "Checksum mismatch: the download is damaged or was changed." >&2; exit 1; }
# The checksum sits next to the DMG, so it only catches a damaged download. The
# build provenance is signed by the release workflow itself (Sigstore): check it
# whenever the GitHub CLI is signed in, and refuse a DMG that fails it.
REPO=SUNGMYEONGGI/OCTO-CREW
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "Checking the build provenance..."
  gh attestation verify "$TMP/app.dmg" --repo "$REPO" --signer-workflow "$REPO/.github/workflows/release.yml" >/dev/null \
    || { echo "This DMG was not built by OCTO CREW's release workflow. Not installing." >&2; exit 1; }
  echo "Built by $REPO's release workflow."
elif [ "${OCTOCREW_REQUIRE_PROVENANCE:-}" = 1 ]; then
  echo "OCTOCREW_REQUIRE_PROVENANCE=1 needs the GitHub CLI, signed in (gh auth login)." >&2; exit 1
else
  echo "Note: install the GitHub CLI and run 'gh auth login' to also check that this build came from OCTO CREW's release workflow."
fi
hdiutil attach -quiet -nobrowse -mountpoint "$MNT" "$TMP/app.dmg"
APP=$(ls -d "$MNT"/*.app | head -n 1)
NAME=$(basename "$APP")

# OCTO CREW was called PixelBot, and CharacterBot before v0.2.0; it moves the old data over on first launch.
for old in "OCTO CREW" PixelBot CharacterBot; do osascript -e "quit app \"$old\"" 2>/dev/null || true; done
rm -rf "/Applications/OCTO CREW.app" /Applications/PixelBot.app /Applications/CharacterBot.app
ditto "$APP" "/Applications/$NAME"
xattr -dr com.apple.quarantine "/Applications/$NAME" 2>/dev/null || true

echo "Installed to /Applications/$NAME"
open "/Applications/$NAME"
