# Android ランチャーアイコン一式を themes/izanami/theme.json の idle フレームから生成する。
# - ic_launcher / ic_launcher_round: 背景 #0d1322 + ドット絵 (各密度 48/72/96/144/192)
# - ic_launcher_foreground (adaptive 前景): 透明背景 + セーフゾーン内ドット絵 (108dp 系 108..432)
# 既存の Capacitor 既定アイコンを上書きする。Windows 版 icon.ico と同じ顔。
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
THEME = ROOT / "themes" / "izanami" / "theme.json"
RES = ROOT / "android" / "app" / "src" / "main" / "res"
BG = (13, 19, 34, 255)  # #0d1322 (アプリの基調色)

DENSITIES = {
    "mdpi": (48, 108),
    "hdpi": (72, 162),
    "xhdpi": (96, 216),
    "xxhdpi": (144, 324),
    "xxxhdpi": (192, 432),
}


def hex_to_rgba(h):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)


def render_sprite():
    data = json.loads(THEME.read_text(encoding="utf-8"))
    char = data["char"]
    palette = {k: hex_to_rgba(v) for k, v in char["palette"].items()}
    frame = char["frames"]["idle"]
    h, w = len(frame), len(frame[0])
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = img.load()
    for y, row in enumerate(frame):
        for x, ch in enumerate(row):
            if ch in palette:
                px[x, y] = palette[ch]
    return img


def compose(sprite, canvas_px, sprite_ratio, background):
    canvas = Image.new("RGBA", (canvas_px, canvas_px), background)
    target = int(canvas_px * sprite_ratio)
    # 最近傍でドットを保ったまま拡大 (スプライトは正方 24x24 前提)
    scale = max(1, target // sprite.width)
    scaled = sprite.resize((sprite.width * scale, sprite.height * scale), Image.NEAREST)
    off = ((canvas_px - scaled.width) // 2, (canvas_px - scaled.height) // 2)
    canvas.alpha_composite(scaled, off)
    return canvas


def main():
    sprite = render_sprite()
    for density, (launcher_px, fg_px) in DENSITIES.items():
        d = RES / f"mipmap-{density}"
        d.mkdir(parents=True, exist_ok=True)
        launcher = compose(sprite, launcher_px, 0.86, BG)
        launcher.save(d / "ic_launcher.png")
        launcher.save(d / "ic_launcher_round.png")
        # adaptive 前景: 端はマスクで切られるためセーフゾーン (中央 ~60%) に収める
        fg = compose(sprite, fg_px, 0.52, (0, 0, 0, 0))
        fg.save(d / "ic_launcher_foreground.png")
        print(f"{density}: launcher {launcher_px}px / foreground {fg_px}px")
    print("done")


if __name__ == "__main__":
    main()
