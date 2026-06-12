# Generate build/icon.ico from themes/izanami/theme.json idle frame.
# 24x24 pixel art -> nearest-neighbor upscale to 256x256, ICO with 256/64/32/16.
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
THEME = ROOT / "themes" / "izanami" / "theme.json"
OUT = ROOT / "build" / "icon.ico"


def hex_to_rgba(h):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)


def main():
    data = json.loads(THEME.read_text(encoding="utf-8"))
    char = data["char"]
    palette = {k: hex_to_rgba(v) for k, v in char["palette"].items()}
    frame = char["frames"]["idle"]

    h = len(frame)
    w = len(frame[0])
    base = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = base.load()
    for y, row in enumerate(frame):
        for x, ch in enumerate(row):
            if ch != ".":
                px[x, y] = palette[ch]

    sizes = [256, 64, 32, 16]
    imgs = [base.resize((s, s), Image.NEAREST) for s in sizes]
    imgs[0].save(
        OUT,
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=imgs[1:],
    )
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes), frame {w}x{h}")


if __name__ == "__main__":
    main()
