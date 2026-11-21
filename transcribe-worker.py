# Turns a recording from the phone's microphone into text, on this PC, with Whisper.
# The cockpit starts it once and keeps it while it is used, so the model loads only once.
# Protocol: one JSON line in  {"id": ..., "file": "<path>", "lang": "es" | ""}  or  {"id": ..., "warm": true}
#           one JSON line out {"id": ..., "text": "...", "language": "en"}  or  {"id": ..., "error": "..."}
# Engine: faster-whisper when this Python has it (as OM Studio does: int8 on the CPU, greedy, the voice filter on,
# temperature 0, about 4x faster than openai-whisper), else openai-whisper. The language is detected for each
# recording unless one is given. The model: COCKPIT_WHISPER_MODEL (default "small").
import json
import os
import sys

MODEL = os.environ.get("COCKPIT_WHISPER_MODEL", "small")
engine = None
kind = ""


def load():
    global engine, kind
    if engine is None:
        try:
            from faster_whisper import WhisperModel
            engine, kind = WhisperModel(MODEL, device="cpu", compute_type="int8"), "faster-whisper"
        except ModuleNotFoundError:
            import whisper  # imported here so a missing package is reported per request, not as a crash
            engine, kind = whisper.load_model(MODEL), "openai-whisper"
    return engine


def hear(file, lang):
    e = load()
    if kind == "faster-whisper":
        # Without the voice filter and temperature 0 a cut-off clip can take 20 s and invent words (OM Studio, measured).
        segments, info = e.transcribe(file, language=lang or None, beam_size=1, vad_filter=True, temperature=0.0,
                                      condition_on_previous_text=False, word_timestamps=False)
        text = " ".join(t for t in (str(s.text).strip() for s in segments) if t)
        return {"text": text, "language": getattr(info, "language", None)}
    result = e.transcribe(file, language=lang or None, fp16=False, temperature=0.0, condition_on_previous_text=False)
    return {"text": (result.get("text") or "").strip(), "language": result.get("language")}


out = sys.stdout
sys.stdout = sys.stderr  # library chatter goes to stderr; stdout carries only the answers


def say(item):
    out.write(json.dumps(item, ensure_ascii=False) + "\n")
    out.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = {}
    try:
        req = json.loads(line)
        if req.get("warm"):  # the mic was tapped: load the model while the person speaks
            load()
            say({"id": req.get("id"), "text": "", "engine": kind})
            continue
        say({"id": req.get("id"), "engine": kind, **hear(req["file"], req.get("lang"))})
    except Exception as e:  # one bad recording must not end the worker
        say({"id": req.get("id"), "error": f"{type(e).__name__}: {e}"[:300]})
