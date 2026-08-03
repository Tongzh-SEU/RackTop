#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="$ROOT_DIR/src-tauri/target/release/bundle/macos/RackTop.app"
DMG_PATH="$ROOT_DIR/src-tauri/target/release/bundle/dmg/RackTop_0.2.0_aarch64.dmg"
STAGE_DIR="$(mktemp -d /private/tmp/racktop-dmg.XXXXXX)"

cleanup() {
  case "$STAGE_DIR" in
    /private/tmp/racktop-dmg.*) rm -rf "$STAGE_DIR" ;;
  esac
}
trap cleanup EXIT

cd "$ROOT_DIR"
npm run tauri build -- --bundles app

# An unsigned local build only carries the linker signature, which does not seal
# the app resources. Re-sign the complete bundle so on-disk verification is useful.
codesign --force --deep --sign - "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

ditto "$APP_PATH" "$STAGE_DIR/RackTop.app"
ln -s /Applications "$STAGE_DIR/Applications"
mkdir -p "$(dirname "$DMG_PATH")"
hdiutil create -volname RackTop -srcfolder "$STAGE_DIR" -ov -format UDZO "$DMG_PATH"
hdiutil verify "$DMG_PATH"
shasum -a 256 "$DMG_PATH"
