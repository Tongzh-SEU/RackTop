#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
TARGET="${RACKTOP_MACOS_TARGET:-aarch64-apple-darwin}"
SKIP_BUILD="${RACKTOP_SKIP_BUILD:-0}"
SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
MARK_UNSIGNED="${RACKTOP_MARK_UNSIGNED:-0}"

case "$TARGET" in
  aarch64-apple-darwin) ARCH_LABEL="arm64" ;;
  x86_64-apple-darwin) ARCH_LABEL="x64" ;;
  *)
    printf 'Unsupported macOS target: %s\n' "$TARGET" >&2
    exit 1
    ;;
esac

TARGET_ROOT="${CARGO_TARGET_DIR:-$ROOT_DIR/src-tauri/target}"
TARGET_DIR="$TARGET_ROOT/$TARGET/release/bundle"
APP_PATH="$TARGET_DIR/macos/RackTop.app"
NOTARY_VALUES=0
for value in "${APPLE_ID:-}" "${APPLE_PASSWORD:-}" "${APPLE_TEAM_ID:-}"; do
  if [ -n "$value" ]; then
    NOTARY_VALUES=$((NOTARY_VALUES + 1))
  fi
done
if [ "$NOTARY_VALUES" -ne 0 ] && [ "$NOTARY_VALUES" -ne 3 ]; then
  printf 'APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID must be configured together.\n' >&2
  exit 1
fi
if [ "$NOTARY_VALUES" -eq 3 ] && [ "$SIGNING_IDENTITY" = "-" ]; then
  printf 'A Developer ID signing identity is required for notarization.\n' >&2
  exit 1
fi
DMG_SUFFIX=""
if [ "$SIGNING_IDENTITY" = "-" ] && [ "$MARK_UNSIGNED" = "1" ]; then
  DMG_SUFFIX="-unsigned"
elif [ "$SIGNING_IDENTITY" != "-" ] && [ "$NOTARY_VALUES" -ne 3 ]; then
  DMG_SUFFIX="-unnotarized"
fi
DMG_PATH="$TARGET_DIR/dmg/RackTop_${APP_VERSION}_macos-${ARCH_LABEL}${DMG_SUFFIX}.dmg"
CHECKSUM_PATH="$DMG_PATH.sha256"
SIGNING_INFO_PATH="$DMG_PATH.signing.txt"
UPDATER_PATH="$TARGET_DIR/macos/RackTop_${APP_VERSION}_macos-${ARCH_LABEL}.app.tar.gz"
DMG_BACKGROUND_SVG="$ROOT_DIR/src-tauri/dmg-background.svg"
DMG_BACKGROUND_RENDERER="$ROOT_DIR/scripts/render-dmg-background.swift"
DMG_VOLUME_NAME="安装 RackTop ${APP_VERSION}"
STAGE_DIR="$(mktemp -d /private/tmp/racktop-dmg.XXXXXX)"
MOUNT_DIR=""
RW_DMG_PATH=""

cleanup() {
  if [ -n "$MOUNT_DIR" ] && mount | grep -Fq "on $MOUNT_DIR "; then
    hdiutil detach "$MOUNT_DIR" >/dev/null || true
  fi
  case "$STAGE_DIR" in
    /private/tmp/racktop-dmg.*) rm -rf "$STAGE_DIR" ;;
  esac
  case "$MOUNT_DIR" in
    /private/tmp/racktop-mount.*) rmdir "$MOUNT_DIR" 2>/dev/null || true ;;
  esac
  case "$RW_DMG_PATH" in
    /private/tmp/racktop-dmg.*.dmg) rm -f "$RW_DMG_PATH" ;;
  esac
}
trap cleanup EXIT

cd "$ROOT_DIR"
if [ "$SKIP_BUILD" != "1" ]; then
  env -u APPLE_SIGNING_IDENTITY -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID \
    npm run tauri build -- --target "$TARGET" --bundles app \
      --config '{"bundle":{"createUpdaterArtifacts":false}}'
fi

if [ ! -d "$APP_PATH" ]; then
  printf 'RackTop.app was not found at %s\n' "$APP_PATH" >&2
  exit 1
fi

# Seal the complete bundle after removing metadata that invalidates strict
# signature verification when a workspace is synced by iCloud or another tool.
xattr -cr "$APP_PATH"
if [ "$SIGNING_IDENTITY" = "-" ]; then
  codesign --force --deep --sign - "$APP_PATH"
  SIGNING_MODE="ad-hoc (not notarizable)"
else
  codesign --force --deep --options runtime --timestamp \
    --sign "$SIGNING_IDENTITY" "$APP_PATH"
  SIGNING_MODE="Developer ID: $SIGNING_IDENTITY"
fi
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || [ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
  rm -f "$UPDATER_PATH" "$UPDATER_PATH.sig"
  COPYFILE_DISABLE=1 tar -czf "$UPDATER_PATH" -C "$(dirname "$APP_PATH")" "$(basename "$APP_PATH")"
  npm run tauri -- signer sign "$UPDATER_PATH"
else
  printf 'Updater signing key not configured; skipping macOS updater artifact.\n'
fi

if [ ! -f "$DMG_BACKGROUND_SVG" ]; then
  printf 'DMG background was not found at %s\n' "$DMG_BACKGROUND_SVG" >&2
  exit 1
fi
if [ ! -f "$DMG_BACKGROUND_RENDERER" ]; then
  printf 'DMG background renderer was not found at %s\n' "$DMG_BACKGROUND_RENDERER" >&2
  exit 1
fi

ditto --norsrc --noextattr --noqtn "$APP_PATH" "$STAGE_DIR/RackTop.app"
ln -s /Applications "$STAGE_DIR/应用程序"
mkdir -p "$STAGE_DIR/.background"
swift "$DMG_BACKGROUND_RENDERER" "$DMG_BACKGROUND_SVG" "$STAGE_DIR/.background/background.png" 1
swift "$DMG_BACKGROUND_RENDERER" "$DMG_BACKGROUND_SVG" "$STAGE_DIR/.background/background@2x.png" 2
chflags hidden "$STAGE_DIR/.background"
mkdir -p "$(dirname "$DMG_PATH")"
RW_DMG_PATH="$(mktemp /private/tmp/racktop-dmg.XXXXXX.dmg)"
rm -f "$RW_DMG_PATH"
hdiutil create -volname "$DMG_VOLUME_NAME" -srcfolder "$STAGE_DIR" -ov -format UDRW "$RW_DMG_PATH"
MOUNT_DIR="/Volumes/$DMG_VOLUME_NAME"
if [ -e "$MOUNT_DIR" ]; then
  printf 'A volume is already mounted at %s\n' "$MOUNT_DIR" >&2
  exit 1
fi
hdiutil attach "$RW_DMG_PATH" -readwrite -noverify -noautoopen -nobrowse -mountpoint "$MOUNT_DIR" >/dev/null

osascript - "$DMG_VOLUME_NAME" <<'APPLESCRIPT'
on run argv
set volumeName to item 1 of argv
tell application "Finder"
  tell disk volumeName
    open
    delay 2
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set pathbar visible of container window to false
    set bounds of container window to {120, 120, 840, 544}
    set theViewOptions to the icon view options of container window
    set arrangement of theViewOptions to not arranged
    set icon size of theViewOptions to 96
    set text size of theViewOptions to 13
    set background picture of theViewOptions to file ".background:background.png"
    set position of item "RackTop.app" of container window to {205, 188}
    set position of item "应用程序" of container window to {515, 188}
    close container window
    open
    update without registering applications
    delay 2
  end tell
end tell
end run
APPLESCRIPT

sync
hdiutil detach "$MOUNT_DIR" >/dev/null
MOUNT_DIR=""
hdiutil convert "$RW_DMG_PATH" -format UDZO -imagekey zlib-level=9 -o "$DMG_PATH" -ov
rm -f "$RW_DMG_PATH"
RW_DMG_PATH=""

if [ "$SIGNING_IDENTITY" != "-" ]; then
  codesign --force --timestamp --sign "$SIGNING_IDENTITY" "$DMG_PATH"
  codesign --verify --verbose=2 "$DMG_PATH"
fi

NOTARIZATION_MODE="not notarized"
if [ "$NOTARY_VALUES" -eq 3 ]; then
  xcrun notarytool submit "$DMG_PATH" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
  xcrun stapler staple "$DMG_PATH"
  xcrun stapler validate "$DMG_PATH"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG_PATH"
  NOTARIZATION_MODE="notarized and stapled"
fi

hdiutil verify "$DMG_PATH"
MOUNT_DIR="$(mktemp -d /private/tmp/racktop-mount.XXXXXX)"
hdiutil attach "$DMG_PATH" -readonly -nobrowse -mountpoint "$MOUNT_DIR" >/dev/null
codesign --verify --deep --strict --verbose=2 "$MOUNT_DIR/RackTop.app"
if [ "$NOTARIZATION_MODE" = "notarized and stapled" ]; then
  spctl --assess --type execute --verbose=2 "$MOUNT_DIR/RackTop.app"
fi
hdiutil detach "$MOUNT_DIR" >/dev/null
rmdir "$MOUNT_DIR"
MOUNT_DIR=""

shasum -a 256 "$DMG_PATH" | tee "$CHECKSUM_PATH"
{
  printf 'version=%s\n' "$APP_VERSION"
  printf 'target=%s\n' "$TARGET"
  printf 'signing=%s\n' "$SIGNING_MODE"
  printf 'notarization=%s\n' "$NOTARIZATION_MODE"
} | tee "$SIGNING_INFO_PATH"
printf 'DMG=%s\n' "$DMG_PATH"
if [ -f "$UPDATER_PATH" ]; then
  printf 'UPDATER=%s\n' "$UPDATER_PATH"
fi
