// 背景描画 (v0.6 テーマ機構: データ駆動)
// window.drawNaviBg(canvas, bgData) — bgData = theme.bg = { palette, pixels } を
// #bg-canvas に整数拡大で描く (45行 x 95列 を 380x180 なら 4 倍)。
// ピクセルデータはテーマ JSON (themes/<id>/theme.json) が持つ。

(function () {
  function drawNaviBg(canvas, bgData) {
    if (!canvas || !bgData || !bgData.palette || !Array.isArray(bgData.pixels)) return;
    const ctx = canvas.getContext('2d');
    const pixels = bgData.pixels;
    const palette = bgData.palette;
    const cols = pixels[0]?.length ?? 0;
    if (!cols) return;
    const scale = Math.min(canvas.width / cols, canvas.height / pixels.length);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < pixels.length; y++) {
      const row = pixels[y];
      for (let x = 0; x < row.length; x++) {
        const c = palette[row[x]];
        if (c) {
          ctx.fillStyle = c;
          ctx.fillRect(x * scale, y * scale, scale, scale);
        }
      }
    }
  }

  window.drawNaviBg = drawNaviBg;
})();
