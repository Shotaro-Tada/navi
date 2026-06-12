// 祈りの力のオーラ (v0.4) — モデル階梯に応じてイザナミから立ち上るドット絵エフェクト
// sonnet: なし / opus: 金色の炎 / fable: より大きな光輝の炎 + 立ち昇る火の粉
// 論理 80x80 px を CSS で 2 倍拡大 (pixelated)。8fps 程度の再抽選でちらつかせる。

class NaviAura {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tier = 'sonnet';
    setInterval(() => this._draw(), 120);
  }

  setTier(tier) {
    this.tier = tier;
    if (tier === 'sonnet') this._clear();
  }

  _clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _draw() {
    this._clear();
    if (this.tier === 'sonnet') return;

    const P = this.tier === 'opus'
      ? { n: 60, rx: 18, ry: 24, cy: 50, sparks: 2,
          colors: ['#ffb02e', '#ffd76e', '#fff3c0', '#e8821e'] }
      : { n: 140, rx: 27, ry: 33, cy: 48, sparks: 12,
          colors: ['#3ef0c8', '#7ff0ff', '#c9a6ff', '#ffffff', '#9fd9ff'] };

    const ctx = this.ctx;
    const cx = 40;

    // 本体を囲む炎の帯: 楕円リング上に上向きの短い火柱をばらまく
    for (let i = 0; i < P.n; i++) {
      const a = Math.random() * Math.PI * 2;
      const w = 0.82 + Math.random() * 0.3;
      const x = Math.round(cx + Math.cos(a) * P.rx * w);
      const y = Math.round(P.cy + Math.sin(a) * P.ry * w);
      const len = 1 + Math.floor(Math.random() * 4);
      ctx.fillStyle = P.colors[Math.floor(Math.random() * P.colors.length)];
      ctx.fillRect(x, y - len, 1, len);
    }

    // 頭上へ立ち昇る火の粉 (fable で顕著)
    for (let s = 0; s < P.sparks; s++) {
      const x = Math.round(cx + (Math.random() * 2 - 1) * P.rx * 1.1);
      const y = Math.round(P.cy - P.ry - Math.random() * 16);
      ctx.fillStyle = P.colors[Math.floor(Math.random() * P.colors.length)];
      ctx.fillRect(x, y, 1, 2);
    }
  }
}

window.NaviAura = NaviAura;
