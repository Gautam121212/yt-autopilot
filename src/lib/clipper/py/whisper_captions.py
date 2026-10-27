#!/usr/bin/env python3
"""Transcribe a clip's audio with faster-whisper and emit an SRT file suitable for ffmpeg
subtitles burn-in. Writes word-level timestamps when the model returns them so captions can be
split into readable 2-line chunks that stay in sync with the actual speech.

Design choices:
  - CPU-only + "base" model: ~30s per 60s audio on a 4-core CI runner. "tiny" is 2-3x faster but
    noticeably worse on fast speech / music backgrounds.
  - 2 lines max, ~32 chars per line (standard YT Shorts caption geometry).
  - Each caption cue covers at most 3s of speech so caption changes aren't choppy on fast delivery.

Usage: whisper_captions.py --input polished.mp4 --out captions.srt [--model base] [--lang en]
"""
import argparse, sys, pathlib, re

LINE_CHAR_MAX = 32
LINES_MAX = 2
CUE_MAX_SEC = 3.0
CUE_MIN_SEC = 0.5
# M9.2 — silence gap in seconds that we treat as a speaker-change / paragraph boundary. When
# the gap between the end of one word and the start of the next exceeds this, we force a cue
# break so the viewer sees the caption clear visually. Proxy for speaker diarization without
# pulling in pyannote.audio (which needs an HF token + model download).
SPEAKER_GAP_SEC = 1.0

def fmt_ts(sec: float) -> str:
    if sec < 0: sec = 0
    ms = int(round((sec - int(sec)) * 1000))
    h = int(sec) // 3600
    m = (int(sec) % 3600) // 60
    s = int(sec) % 60
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def wrap_two_lines(words: list[str]) -> str:
    """Pack words into at most LINES_MAX lines of LINE_CHAR_MAX each. Break on word boundaries."""
    lines: list[str] = []
    cur = ""
    for w in words:
        trial = (cur + " " + w).strip() if cur else w
        if len(trial) <= LINE_CHAR_MAX:
            cur = trial
        else:
            if cur: lines.append(cur)
            cur = w
            if len(lines) >= LINES_MAX:
                # Overflow — truncate the rest onto the last line with an ellipsis.
                remaining = " ".join([cur, *words[words.index(w)+1:]])
                lines[-1] = (lines[-1] + " " + remaining)[:LINE_CHAR_MAX * LINES_MAX - 1] + "…"
                return "\n".join(lines)
    if cur: lines.append(cur)
    return "\n".join(lines[:LINES_MAX])

def chunk_words_to_cues(word_segments: list[dict]) -> list[tuple[float, float, str]]:
    """word_segments is a flat list of {word, start, end} from faster-whisper. Group them into
    cues of at most CUE_MAX_SEC and at most LINE_CHAR_MAX * LINES_MAX characters.

    M9.2: when the gap between the previous word's end and the next word's start exceeds
    SPEAKER_GAP_SEC, we force-break the current cue BEFORE adding the new word. The result is
    that captions visibly clear between speakers / paragraphs instead of running words from
    different speakers into one line.
    """
    cues: list[tuple[float, float, str]] = []
    cur_words: list[str] = []
    cur_start = None
    cur_last_end = None
    for w in word_segments:
        word = (w.get("word") or "").strip()
        if not word: continue
        start = float(w.get("start") or 0)
        end = float(w.get("end") or start + 0.2)
        # M9.2 — speaker-gap break: if there's a long silence between the previous word and this
        # one, close out the current cue immediately so viewers see a clear gap.
        gap = (start - cur_last_end) if cur_last_end is not None else 0
        force_break = cur_words and gap >= SPEAKER_GAP_SEC
        if cur_start is None:
            cur_start = start
        projected = wrap_two_lines(cur_words + [word])
        projected_len = sum(len(l) for l in projected.split("\n"))
        dur = end - cur_start
        if (force_break or dur > CUE_MAX_SEC or projected_len > LINE_CHAR_MAX * LINES_MAX) and cur_words:
            cues.append((cur_start, cur_last_end or end, wrap_two_lines(cur_words)))
            cur_words = [word]
            cur_start = start
            cur_last_end = end
        else:
            cur_words.append(word)
            cur_last_end = end
    if cur_words and cur_start is not None:
        cues.append((cur_start, cur_last_end or (cur_start + CUE_MIN_SEC), wrap_two_lines(cur_words)))
    # Enforce minimum duration so very short cues don't flash.
    cues = [(s, max(e, s + CUE_MIN_SEC), text) for (s, e, text) in cues]
    return cues

def write_srt(path: str, cues: list[tuple[float, float, str]]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for i, (s, e, text) in enumerate(cues, 1):
            f.write(f"{i}\n{fmt_ts(s)} --> {fmt_ts(e)}\n{text}\n\n")

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="base", help="tiny | base | small (base recommended)")
    ap.add_argument("--lang", default=None, help="ISO 639-1 code, or None to auto-detect")
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError as e:
        print(f"error: faster-whisper not installed ({e}). pip install faster-whisper", file=sys.stderr)
        return 2

    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    segments, info = model.transcribe(args.input, language=args.lang, word_timestamps=True, vad_filter=True)
    # Flatten to word list.
    words: list[dict] = []
    for seg in segments:
        if seg.words:
            for w in seg.words:
                words.append({"word": w.word, "start": w.start, "end": w.end})
        else:
            # No word-level timestamps for this segment — fall back to the segment as one chunk.
            words.append({"word": seg.text.strip(), "start": seg.start, "end": seg.end})
    cues = chunk_words_to_cues(words)
    pathlib.Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    write_srt(args.out, cues)
    print(f"wrote {len(cues)} cues to {args.out} (lang={info.language}, dur={info.duration:.1f}s)", file=sys.stderr)
    return 0

if __name__ == "__main__":
    sys.exit(main())
