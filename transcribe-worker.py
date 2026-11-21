# Turns a recording from the phone's microphone into text, on this PC, with Whisper (openai-whisper).
# The cockpit starts it once and keeps it while it is used, so the model loads only once.
# Protocol: one JSON line in  {"id": ..., "file": "<path>", "lang": "es" | ""}
#           one JSON line out {"id": ..., "text": "..."}  or  {"id": ..., "error": "..."}
# The model: COCKPIT_WHISPER_MODEL (default "small"; "base" is faster, "large-v3" better and much slower).
import json
import os
import sys

model = None


def load():
    global model
    if model is None:
        import whisper  # imported here so a missing package is reported per request, not as a crash
        model = whisper.load_model(os.environ.get("COCKPIT_WHISPER_MODEL", "small"))
    return model


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = {}
    try:
        req = json.loads(line)
        result = load().transcribe(req["file"], language=req.get("lang") or None, fp16=False)
        out = {"id": req.get("id"), "text": (result.get("text") or "").strip()}
    except Exception as e:  # one bad recording must not end the worker
        out = {"id": req.get("id"), "error": f"{type(e).__name__}: {e}"}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
