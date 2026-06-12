# -*- coding: utf-8 -*-
"""NAVI BGM 合成 — 軽やかな和風 60 秒シームレスループ。

出力: renderer/assets/bgm.wav (mono 22050 Hz 16bit, 60.0 s ≈ 2.5 MB)

- D の陽音階ペンタトニック (D E G A B)、テンポ 84 BPM (= 84 拍 = 21 小節 = ちょうど 60 s)
- 琴風の爪弾き: Karplus-Strong (初期ノイズを 2 回ローパスして倍音少なめ、短い減衰)
  を主旋律 + 低音の二声で。8 小節フレーズ A/B + 5 小節コーダを軽い変奏付きで配置
- まれに風鈴: 高域の正弦クラスタ + 急減衰 + ディレイ 3 連の余韻 (リバーブ風)
- シームレスループ: 60 s より先 (62 s) まで描画し、はみ出した末尾 2 s を
  先頭 2 s に等パワークロスフェードで折り返す (ループ点でサンプル連続)
- ピーク -12 dBFS、乱数 seed 固定 (再現性)
"""
import os
import wave

import numpy as np

SR = 22050
BPM = 84.0
BEAT = 60.0 / BPM            # 1 拍 ≈ 0.714 s
LOOP_SEC = 60.0              # 84 拍 = 21 小節ちょうど
XFADE_SEC = 2.0              # ループ継ぎ目のクロスフェード長
PEAK = 10 ** (-12 / 20)      # -12 dBFS ≈ 0.251

OUT = os.path.join(os.path.dirname(__file__), '..', 'renderer', 'assets', 'bgm.wav')

rng = np.random.default_rng(20260612)

# ---- 音階: D 陽音階ペンタトニック (D E G A B) ----
PENT = [62, 64, 67, 69, 71]  # MIDI: D4 E4 G4 A4 B4


def deg_hz(d, octave=0):
    """スケール度数 d (0=D4, 5=D5, 負も可) → 周波数 Hz"""
    midi = PENT[d % 5] + 12 * (d // 5) + 12 * octave
    return 440.0 * 2 ** ((midi - 69) / 12)


# ---- 琴風の爪弾き (Karplus-Strong、ブロック近似) ----
def pluck(freq, dur, damp=0.996):
    n = int(SR * dur)
    L = max(2, int(round(SR / freq)))
    buf = rng.uniform(-1.0, 1.0, L)
    for _ in range(2):                       # 倍音少なめ: 初期ノイズを 2 回ローパス
        buf = 0.5 * (buf + np.roll(buf, 1))
    buf -= buf.mean()
    periods = n // L + 2
    sig = np.empty(periods * L)
    cur = buf
    for p in range(periods):                 # 周期単位の KS 更新 (平均 + 減衰)
        sig[p * L:(p + 1) * L] = cur
        cur = damp * 0.5 * (cur + np.roll(cur, -1))
    sig = sig[:n]
    t = np.arange(n) / SR
    env = np.exp(-t * 2.2)                   # 短めの全体減衰 (琴の爪弾き)
    a = min(n, int(0.003 * SR))              # 3 ms アタックでクリック防止
    env[:a] *= np.linspace(0.0, 1.0, a)
    r = min(n, int(0.02 * SR))               # 末尾 20 ms フェード
    env[-r:] *= np.linspace(1.0, 0.0, r)
    return sig * env


# ---- 風鈴 (高域正弦クラスタ + 急減衰 + ディレイの余韻) ----
def chime():
    dur = 3.2
    n = int(SR * dur)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    degs = rng.choice([10, 11, 12, 13, 14], size=3, replace=False)  # D6 帯域
    for k, d in enumerate(degs):
        f = deg_hz(int(d)) * (1 + rng.uniform(-0.002, 0.002))       # 微小デチューン
        onset = int((0.13 * k + rng.uniform(0, 0.08)) * SR)
        m = n - onset
        tt = t[:m]
        part = np.sin(2 * np.pi * f * tt) * np.exp(-tt * 3.5)       # 急減衰
        part[:int(0.002 * SR)] *= np.linspace(0, 1, int(0.002 * SR))
        sig[onset:] += part * rng.uniform(0.5, 0.8)
    wet = sig.copy()                          # リバーブ風: 減衰ディレイ 3 連
    for delay, g in ((0.151, 0.40), (0.317, 0.24), (0.479, 0.13)):
        d = int(delay * SR)
        wet[d:] += g * sig[:-d]
    wet[-int(0.3 * SR):] *= np.linspace(1, 0, int(0.3 * SR))
    return wet


# ---- 譜面 (拍, スケール度数, 長さ拍) — 8 小節フレーズ A / B + 5 小節コーダ ----
PHRASE_A = [
    (0, 0, 1), (1, 1, 1), (2, 2, 1), (3, 3, 1),
    (4, 4, 2), (6, 3, 1), (7, 2, 1),
    (8, 1, 2), (10, 2, 1), (11, 1, 1),
    (12, 0, 3.5),
    (16, 3, 1), (17, 4, 1), (18, 5, 2),
    (20, 4, 1), (21, 3, 1), (22, 2, 2),
    (24, 1, 1), (25, 2, 1), (26, 3, 1.5), (27.5, 2, 0.5),
    (28, 0, 3.5),
]
PHRASE_B = [
    (0, 5, 1), (1, 6, 1), (2, 5, 1), (3, 4, 1),
    (4, 3, 2), (6, 4, 1), (7, 5, 1),
    (8, 6, 2), (10, 5, 1), (11, 4, 1),
    (12, 5, 3), (15, 4, 1),
    (16, 3, 1), (17, 2, 1), (18, 3, 2),
    (20, 4, 2), (22, 3, 1), (23, 2, 1),
    (24, 1, 2), (26, 2, 1), (27, 1, 1),
    (28, 0, 3.5),
]
CODA = [
    (0, 2, 1), (1, 3, 1), (2, 4, 2),
    (4, 5, 2), (6, 4, 1), (7, 3, 1),
    (8, 2, 2), (10, 1, 1), (11, 2, 1),
    (12, 0, 2), (14, 1, 1), (15, 2, 1),
    (16, 0, 3.5),
]
# 21 小節 = フレーズ A (8) + B (8) + コーダ (5)
SECTIONS = [(0, PHRASE_A), (32, PHRASE_B), (64, CODA)]

# 低音 (各小節の根音、D3 帯域): 拍 0 と 2 に置く
BASS_ROOTS = [0, 0, 2, 3, 0, 0, 1, 3, 0, 2, 3, 0, 0, 0, 2, 3, 0, 2, 3, 0, 0]


def add(mix, t_sec, sig, gain):
    i0 = int(t_sec * SR)
    seg = sig[: max(0, len(mix) - i0)]
    mix[i0:i0 + len(seg)] += gain * seg


def main():
    total = int((LOOP_SEC + XFADE_SEC + 1.5) * SR)   # 余韻のはみ出し分まで描画
    mix = np.zeros(total)

    # 主旋律 (軽い変奏: 音量ゆらぎ / まれにオクターブ上げ / 装飾音)
    for base_beat, phrase in SECTIONS:
        for beat, d, dur in phrase:
            t = (base_beat + beat) * BEAT
            dd = d
            if dur <= 1 and rng.random() < 0.10:
                dd += 5                                    # まれにオクターブ上
            gain = rng.uniform(0.55, 0.75)
            if rng.random() < 0.15:                        # 装飾音 (直前に 1 度下)
                add(mix, max(0.0, t - 0.07), pluck(deg_hz(dd - 1), 0.25, 0.992), gain * 0.4)
            add(mix, t, pluck(deg_hz(dd), min(dur * BEAT + 0.4, 2.2)), gain)

    # 低音の爪弾き (各小節の拍 0 と拍 2)
    for bar, root in enumerate(BASS_ROOTS):
        t0 = bar * 4 * BEAT
        add(mix, t0, pluck(deg_hz(root, -1), 1.6, 0.997), 0.50)
        d2 = root + (2 if rng.random() < 0.5 else 0)       # 拍 2 は根音か 2 度数上
        add(mix, t0 + 2 * BEAT, pluck(deg_hz(d2, -1), 1.4, 0.997), 0.38)

    # まれの風鈴 (60 秒に 3 回、seed 固定)
    for t in sorted(rng.uniform(6.0, 54.0, 3)):
        add(mix, float(t), chime(), 0.16)

    # ---- シームレスループ: はみ出した末尾 2 s を先頭 2 s へ等パワークロスフェード ----
    nloop = int(LOOP_SEC * SR)
    nx = int(XFADE_SEC * SR)
    x = np.linspace(0.0, 1.0, nx, endpoint=False)
    out = mix[:nloop].copy()
    out[:nx] = mix[nloop:nloop + nx] * np.cos(0.5 * np.pi * x) \
        + out[:nx] * np.sin(0.5 * np.pi * x)
    # x=0 で fade_in=0 / fade_out=1 → out[0] は末尾の自然な続き = ループ点でサンプル連続

    out *= PEAK / np.max(np.abs(out))                      # ピーク -12 dBFS
    pcm = np.clip(out * 32767.0, -32767, 32767).astype('<i2')

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with wave.open(OUT, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())

    # ---- 簡易検証: 長さ / クリッピング / ループ点の連続性 ----
    with wave.open(OUT, 'rb') as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2 and w.getframerate() == SR
        y = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype(float) / 32767.0
    sec = len(y) / SR
    peak_db = 20 * np.log10(np.max(np.abs(y)))
    seam = abs(y[0] - y[-1])                               # ループ折返しの段差
    size = os.path.getsize(OUT)
    print(f'duration : {sec:.3f} s')
    print(f'peak     : {peak_db:.2f} dBFS (max |y| = {np.max(np.abs(y)):.4f})')
    print(f'loop seam: |y[0]-y[-1]| = {seam:.5f}')
    print(f'size     : {size} bytes ({size / 1e6:.2f} MB)')
    assert 59.0 <= sec <= 61.0, 'duration out of range'
    assert np.max(np.abs(y)) < 0.99, 'clipping detected'
    assert seam < 0.05, 'loop seam discontinuity'
    print('OK: renderer/assets/bgm.wav')


if __name__ == '__main__':
    main()
