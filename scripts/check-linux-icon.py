"""Reject opaque borders in generated and packaged RackTop icons (CI only)."""
from pathlib import Path
import sys
from PIL import Image

for argument in sys.argv[1:]:
    path = Path(argument)
    icons = [path] if path.is_file() else list(path.rglob("racktop.png"))
    if not icons:
        raise SystemExit(f"No RackTop PNG icons found in {path}")
    for icon in icons:
        with Image.open(icon) as image:
            width, height = image.size
            if width != height or "A" not in image.getbands():
                raise SystemExit(f"Expected square RGBA icon: {icon}")
            alpha = image.getchannel("A")
            border = [alpha.getpixel((x, y)) for x in range(width) for y in (0, height - 1)]
            border += [alpha.getpixel((x, y)) for y in range(height) for x in (0, width - 1)]
            if any(border) or alpha.getextrema()[1] != 255:
                raise SystemExit(f"Opaque border or missing artwork: {icon}")
        print(f"Transparent border verified: {icon}")
