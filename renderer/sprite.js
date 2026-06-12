// NAVI のドット絵スプライト (v0.6 テーマ機構: データ駆動)
// NaviSprite は (canvas, charData) を受け取り、charData = { palette, frames } で描く。
// 以下の PALETTE / FRAMES は izanami の既定データ (charData 省略時のフォールバック兼検証用)。
// 文字 → 色 の対応で 1 ピクセルずつ描く。

const PALETTE = {
  k: '#1a1a24', // アウトライン (黒)
  h: '#261f2d', // 髪 (黒髪ベース)
  H: '#3e3552', // 髪ハイライト
  s: '#f2cfae', // 肌
  S: '#d9ac88', // 肌の影
  e: '#262631', // 目
  b: '#ffffff', // 髪のリボン (白)
  w: '#f2f0e8', // 小袖 (白)
  W: '#d8d4c8', // 小袖の影
  r: '#c4302e', // 緋袴 (赤)
  R: '#992423', // 緋袴の影
  p: '#9c4343', // 口・頬
  B: '#ff9b9b', // 頬染め
  T: '#7fb2ff', // 涙
  y: '#8a6b43', // 箒の柄
  a: '#ffb02e', // 箒の穂 (アンバー)
};

const FRAME_IDLE = [
  '........................',
  '........................',
  '.........kkkkkk.........',
  '.......kkhhhhhhkk.......',
  '......khhHHhhhhhhk......',
  '.....khHHhhhhhhbbhk.....',
  '.....khhhhhhhhhbbhk.....',
  '.....khhsshsshsshhk.....',
  '.....khsebssssebshk.....',
  '.....khseesssseeshk.....',
  '.....krssssssssssrk.....',
  '.....khSsssppsssShk.....',
  '......khksssssskhk......',
  '.......kwwksskwwk.......',
  '......kwwwrwwrwwwk......',
  '....kwwwwwwrrwwwwwwk....',
  '...kwwWwwwwkkwwwwWwwk...',
  '...kWWWkrrrwwrrrkWWWk...',
  '....kWkrrrrrrrrrrkWk....',
  '......kRrrrrrrrRk.......',
  '......kRrrRRrrrRk.......',
  '.....kRrrrrRRrrrrRk.....',
  '.....kRrrrrRRrrrrRk.....',
  '.....kkkkkkkkkkkkkk.....',
];

// 行差し替えヘルパ: {行番号: 新しい行} で派生フレームを作る
function variant(rows) {
  return FRAME_IDLE.map((row, i) => rows[i] ?? row);
}

const FRAME_BLINK = variant({ 8: '.....khsssssssssshk.....' });
const FRAME_TALK = variant({ 12: '......khkssppsskhk......' });

// 感情フレーム
const FRAME_JOY = variant({
  8: '.....khsssssssssshk.....',
  11: '.....khSssppppssShk.....',
});
const FRAME_BLUSH = variant({
  10: '.....krsBssssssBsrk.....',
});
const FRAME_SAD = variant({
  8: '.....khsssssssssshk.....',
  10: '.....krsTssssssssrk.....',
  11: '.....khSsssspsssShk.....',
});

// 所作フレーム: 祈り (目を閉じ、胸の前で手を合わせる)
const FRAME_PRAY = variant({
  8: '.....khsssssssssshk.....',
  15: '....kwwwwwwsswwwwwwk....',
  16: '...kwwWwwwwsswwwwWwwk...',
});

// 所作フレーム: 掃除 (右手側に箒、2フレームで掃く)
const FRAME_SWEEP1 = variant({
  14: '......kwwwrwwrwwwk..y...',
  15: '....kwwwwwwrrwwwwwwk.y..',
  16: '...kwwWwwwwkkwwwwWwwky..',
  17: '...kWWWkrrrwwrrrkWWWk.y.',
  18: '....kWkrrrrrrrrrrkWk..y.',
  19: '......kRrrrrrrrRk.....y.',
  20: '......kRrrRRrrrRk......y',
  21: '.....kRrrrrRRrrrrRk...aa',
  22: '.....kRrrrrRRrrrrRk..aaa',
  23: '.....kkkkkkkkkkkkkk..aa.',
});
const FRAME_SWEEP2 = variant({
  14: '......kwwwrwwrwwwk.y....',
  15: '....kwwwwwwrrwwwwwwky...',
  16: '...kwwWwwwwkkwwwwWwwk.y.',
  17: '...kWWWkrrrwwrrrkWWWky..',
  18: '....kWkrrrrrrrrrrkWk.y..',
  19: '......kRrrrrrrrRk....y..',
  20: '......kRrrRRrrrRk.....y.',
  21: '.....kRrrrrRRrrrrRk..aa.',
  22: '.....kRrrrrRRrrrrRk.aaa.',
  23: '.....kkkkkkkkkkkkkk.aa..',
});

const FRAMES = {
  idle: FRAME_IDLE,
  blink: FRAME_BLINK,
  talk: FRAME_TALK,
  joy: FRAME_JOY,
  blush: FRAME_BLUSH,
  sad: FRAME_SAD,
  pray: FRAME_PRAY,
  sweep1: FRAME_SWEEP1,
  sweep2: FRAME_SWEEP2,
};

// 状態機械: idle / talking / emotion(数秒) / action(掃除・祈り)
// charData (= theme.char) の格子サイズはフレームデータから導出する
// (izanami 24x24 / kaguya 26x24 など)。1:1 でオフスクリーンに描き、
// 最近傍補間で canvas にはめ込む (足元は下端に揃える)。
class NaviSprite {
  constructor(canvas, charData) {
    const data = charData && charData.frames && charData.palette
      ? charData
      : { palette: PALETTE, frames: FRAMES };
    this.palette = data.palette;
    this.frames = data.frames;
    const idle = this.frames.idle;
    this.gridW = idle[0].length;
    this.gridH = idle.length;

    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._off = document.createElement('canvas');
    this._off.width = this.gridW;
    this._off.height = this.gridH;
    this._offCtx = this._off.getContext('2d');

    const scale = Math.min(canvas.width / this.gridW, canvas.height / this.gridH);
    this._drawW = Math.round(this.gridW * scale);
    this._drawH = Math.round(this.gridH * scale);
    this._drawX = Math.floor((canvas.width - this._drawW) / 2);
    this._drawY = canvas.height - this._drawH;

    this.mode = 'idle';
    this.emotion = null;
    this.action = null;
    this._tick = 0;
    this._render('idle');

    setInterval(() => this._step(), 130);
    // まばたき (idle 時のみ)
    setInterval(() => {
      if (this.mode !== 'idle') return;
      this._render('blink');
      setTimeout(() => { if (this.mode === 'idle') this._render('idle'); }, 140);
    }, 3200);
  }

  _step() {
    this._tick++;
    if (this.mode === 'talking') {
      this._render(this._tick % 2 ? 'talk' : 'idle');
    } else if (this.mode === 'action' && this.action === 'sweep') {
      this._render(Math.floor(this._tick / 3) % 2 ? 'sweep1' : 'sweep2');
    } else if (this.mode === 'action' && this.action === 'pray') {
      this._render('pray');
    } else if (this.mode === 'emotion' && this.emotion) {
      this._render(this.emotion);
    }
  }

  _render(name) {
    const frame = this.frames[name] ?? this.frames.idle;
    const octx = this._offCtx;
    octx.clearRect(0, 0, this.gridW, this.gridH);
    for (let y = 0; y < this.gridH; y++) {
      const row = frame[y] ?? '';
      for (let x = 0; x < this.gridW; x++) {
        const c = this.palette[row[x]];
        if (c) {
          octx.fillStyle = c;
          octx.fillRect(x, y, 1, 1);
        }
      }
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this._off, this._drawX, this._drawY, this._drawW, this._drawH);
  }

  isBusy() { return this.mode !== 'idle'; }

  setTalking(on) {
    if (on) {
      this._clearTimers();
      this.mode = 'talking';
    } else if (this.mode === 'talking') {
      this.mode = 'idle';
      this._render('idle');
    }
  }

  // 感情表示 (joy / blush / sad)。durationMs 後に idle へ戻る
  showEmotion(name, durationMs = 4500) {
    if (!this.frames[name] || this.mode === 'talking') {
      if (this.mode === 'talking') { this._pendingEmotion = { name, durationMs }; }
      if (!this.frames[name]) return;
    }
    this._clearTimers();
    this.mode = 'emotion';
    this.emotion = name;
    this._render(name);
    this._emoTimer = setTimeout(() => {
      if (this.mode === 'emotion') { this.mode = 'idle'; this.emotion = null; this._render('idle'); }
    }, durationMs);
  }

  // 会話終了後に保留した感情があれば表示
  flushPendingEmotion() {
    if (this._pendingEmotion && this.mode === 'idle') {
      const { name, durationMs } = this._pendingEmotion;
      this._pendingEmotion = null;
      this.showEmotion(name, durationMs);
    }
  }

  // 所作 (sweep / pray)。durationMs 後に idle へ戻り onEnd を呼ぶ
  playAction(name, durationMs, onEnd) {
    if (this.mode !== 'idle') return false;
    this._clearTimers();
    this.mode = 'action';
    this.action = name;
    this._actTimer = setTimeout(() => {
      if (this.mode === 'action') { this.mode = 'idle'; this.action = null; this._render('idle'); }
      if (onEnd) onEnd();
    }, durationMs);
    return true;
  }

  _clearTimers() {
    clearTimeout(this._emoTimer);
    clearTimeout(this._actTimer);
  }
}

window.NaviSprite = NaviSprite;
window.__NAVI_FRAMES = FRAMES;   // izanami 既定データ (フレーム検証・フォールバック用)
window.__NAVI_PALETTE = PALETTE;
