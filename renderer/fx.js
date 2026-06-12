// 境内の演出レイヤー (v0.5) — 流れ星 / 掃除の塵 / 新奇演出の天候 (雪・雨・蛍・花びら)
// 論理 95x45 (背景と同じ格子) を CSS で 4 倍拡大。常に1種類の演出のみ稼働。

class NaviFX {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = canvas.width;   // 95
    this.H = canvas.height;  // 45
    this.timer = null;
  }

  _clear() { this.ctx.clearRect(0, 0, this.W, this.H); }

  _stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this._clear();
  }

  get busy() { return this.timer !== null; }

  // 流れ星: 上空を斜めに流れて消える。終了後 onDone を呼ぶ
  shootingStar(onDone) {
    if (this.busy) { if (onDone) onDone(); return; }
    const x0 = 8 + Math.random() * 45;
    const y0 = 3 + Math.random() * 8;
    let i = 0;
    this.timer = setInterval(() => {
      this._clear();
      i++;
      if (i > 14) { this._stop(); if (onDone) onDone(); return; }
      const x = x0 + i * 2.4;
      const y = y0 + i * 0.8;
      // 尾 → 頭の順に描く
      for (let t = 3; t >= 0; t--) {
        this.ctx.fillStyle = t === 0 ? '#ffffff' : ['#cfe6ff', '#9fc4ef', '#5f7fa8'][t - 1];
        this.ctx.fillRect(Math.round(x - t * 2.2), Math.round(y - t * 0.7), 1, 1);
      }
    }, 55);
  }

  // 掃除の塵: 足元 (箒の先あたり) に小さな砂埃
  startDust() {
    if (this.busy) return;
    this.timer = setInterval(() => {
      this._clear();
      for (let i = 0; i < 6; i++) {
        const x = 50 + Math.random() * 10;
        const y = 38 + Math.random() * 5;
        this.ctx.fillStyle = Math.random() < 0.5 ? '#c9cdd4' : '#9aa0a9';
        this.ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
      }
    }, 160);
  }

  stopDust() { this._stop(); }

  // 新奇演出の天候: snow / rain / fireflies / petals
  weather(type, durationMs = 25000) {
    if (this.busy) return;
    const spec = {
      snow:      { n: 26, colors: ['#ffffff', '#dfe8f5'], dy: 0.5,  dx: 0.15, len: 1, zone: 'sky' },
      rain:      { n: 30, colors: ['#7fa8d9', '#5f7fa8'], dy: 2.2,  dx: 0.3,  len: 3, zone: 'sky' },
      fireflies: { n: 12, colors: ['#ffe87a', '#c8e87a'], dy: 0,    dx: 0,    len: 1, zone: 'low' },
      petals:    { n: 20, colors: ['#ffc0cb', '#ffaec0'], dy: 0.45, dx: 0.6,  len: 1, zone: 'sky' },
    }[type];
    if (!spec) return;

    const parts = Array.from({ length: spec.n }, () => ({
      x: Math.random() * this.W,
      y: spec.zone === 'low' ? 22 + Math.random() * 20 : Math.random() * this.H,
      ph: Math.random() * Math.PI * 2,
    }));

    const start = Date.now();
    this.timer = setInterval(() => {
      if (Date.now() - start > durationMs) { this._stop(); return; }
      this._clear();
      for (const p of parts) {
        if (spec.zone === 'low') {
          // 蛍: その場でゆらぎ + 明滅
          p.x += Math.sin(p.ph + Date.now() / 700) * 0.3;
          p.y += Math.cos(p.ph + Date.now() / 900) * 0.2;
          if (Math.sin(p.ph + Date.now() / 350) < -0.2) continue; // 明滅で消える瞬間
        } else {
          p.y += spec.dy;
          p.x += spec.dx * Math.sin(p.ph + Date.now() / 600) + (type === 'petals' ? 0.25 : 0);
          if (p.y > this.H) { p.y = -1; p.x = Math.random() * this.W; }
          if (p.x > this.W) p.x = 0;
        }
        this.ctx.fillStyle = spec.colors[Math.floor(Math.random() * spec.colors.length)];
        this.ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, spec.len);
      }
    }, 100);
  }
}

window.NaviFX = NaviFX;
