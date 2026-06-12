#!/usr/bin/env python3
"""transcribe.py — faster-whisper による音声文字起こし CLI (NAVI 議事録用)。

Usage:
    python scripts/transcribe.py <audio> [--language ja|en|auto] [--model small|medium] [--out <txt>]

- faster-whisper (CPU, compute_type='int8')。多言語モデル (small/medium) を使用。
- webm/opus は同梱 av (PyAV) が直接デコードするため外部 ffmpeg 不要。
- 出力: [mm:ss] タイムスタンプ付き行を UTF-8 テキストで保存 (既定 <audio拡張子を.txtに置換>)。
- 進捗 (処理済み秒数) と検出言語は stderr に出力。終了コード 0=成功 / 1=失敗。
"""

import argparse
import os
import sys
from pathlib import Path

# Anaconda (MKL) と ctranslate2/onnxruntime が各々 libiomp5md.dll を持ち込み
# OMP Error #15 で落ちるため、重複ロードを許可する (Windows + conda の定番回避策)。
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")


def format_ts(seconds: float) -> str:
    total = int(seconds)
    return f"[{total // 60:02d}:{total % 60:02d}]"


def resolve_model(size: str) -> str:
    """ローカルに展開済みの CTranslate2 モデルがあればそのパスを返す。

    huggingface.co がネットワーク側で遮断される環境 (SNI フィルタ) があるため、
    %LOCALAPPDATA%/navi/whisper-models/faster-whisper-<size>/ または
    環境変数 NAVI_WHISPER_MODEL_DIR 配下に model.bin があればそれを優先する。
    無ければモデル名をそのまま返し、faster-whisper の HF 自動取得に任せる。
    """
    candidates = []
    env_dir = os.environ.get("NAVI_WHISPER_MODEL_DIR")
    if env_dir:
        candidates.append(Path(env_dir) / f"faster-whisper-{size}")
    local_app = os.environ.get("LOCALAPPDATA")
    if local_app:
        candidates.append(Path(local_app) / "navi" / "whisper-models" / f"faster-whisper-{size}")
    for cand in candidates:
        if (cand / "model.bin").is_file():
            return str(cand)
    return size


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe audio with faster-whisper (CPU int8).")
    parser.add_argument("audio", help="input audio file (wav/webm/opus/mp3/m4a ...)")
    parser.add_argument("--language", default="auto", choices=["ja", "en", "auto"],
                        help="transcription language (default: auto-detect)")
    parser.add_argument("--model", default="small", choices=["small", "medium"],
                        help="multilingual Whisper model size (default: small)")
    parser.add_argument("--out", default=None, help="output txt path (default: <audio>.txt)")
    args = parser.parse_args()

    audio_path = Path(args.audio)
    if not audio_path.is_file():
        print(f"error: audio file not found: {audio_path}", file=sys.stderr)
        return 1

    out_path = Path(args.out) if args.out else audio_path.with_suffix(".txt")
    language = None if args.language == "auto" else args.language

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        print(f"error: faster-whisper not installed: {exc}", file=sys.stderr)
        return 1

    try:
        model_ref = resolve_model(args.model)
        print(f"loading model '{args.model}' ({model_ref}) (CPU, int8) ...", file=sys.stderr)
        model = WhisperModel(model_ref, device="cpu", compute_type="int8")

        segments, info = model.transcribe(str(audio_path), language=language, vad_filter=False)
        print(f"detected language: {info.language} "
              f"(probability {info.language_probability:.2f}), "
              f"duration {info.duration:.1f}s", file=sys.stderr)

        lines = []
        for seg in segments:
            text = seg.text.strip()
            if text:
                lines.append(f"{format_ts(seg.start)} {text}")
            print(f"progress: {seg.end:.1f}s / {info.duration:.1f}s", file=sys.stderr)

        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
        print(f"wrote {len(lines)} line(s) -> {out_path}", file=sys.stderr)
        return 0
    except Exception as exc:  # noqa: BLE001 — CLI boundary: report and fail
        print(f"error: transcription failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
