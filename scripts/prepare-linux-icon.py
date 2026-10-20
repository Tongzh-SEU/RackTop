#!/usr/bin/env python3
"""Extract the largest PNG image embedded in the shared Windows ICO asset."""

from pathlib import Path
import struct

source = Path("src-tauri/icons/icon.ico")
target = Path("src-tauri/icons/linux.png")
data = source.read_bytes()
reserved, image_type, count = struct.unpack_from("<HHH", data, 0)
if (reserved, image_type) != (0, 1) or count == 0:
    raise SystemExit(f"{source} is not a valid icon resource")

entries = []
for index in range(count):
    width, height, _colors, _reserved, _planes, _bits, size, offset = struct.unpack_from(
        "<BBBBHHII", data, 6 + index * 16
    )
    payload = data[offset : offset + size]
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        entries.append((max(width or 256, height or 256), payload))

if not entries:
    raise SystemExit(f"{source} has no embedded PNG image")

target.write_bytes(max(entries, key=lambda item: item[0])[1])
print(f"Prepared {target} from {source}")
