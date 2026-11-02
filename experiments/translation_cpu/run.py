#!/usr/bin/env python3
"""Isolated CPU-only speech translation smoke test for I’MON Meets.

Commands: python run.py prepare | bench | all
Uses generated sample speech, not real call audio. Not a streaming benchmark.
"""
import json
import os
import sys
import time
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
MODELS = DATA / "models"
VOICES = MODELS / "piper"
WHISPER = MODELS / "whisper"
os.environ["HF_HOME"] = str(DATA / "hf_cache")
os.environ["XDG_DATA_HOME"] = str(DATA / "xdg_data")
os.environ["XDG_CACHE_HOME"] = str(DATA / "xdg_cache")
os.environ["ARGOS_PACKAGES_DIR"] = str(MODELS / "argos")
os.environ["ARGOS_DEVICE_TYPE"] = "cpu"
os.environ["ARGOS_INTRA_THREADS"] = "1"
os.environ["ARGOS_INTER_THREADS"] = "1"
os.environ["ARGOS_CHUNK_TYPE"] = "ARGOSTRANSLATE"
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
for folder in [DATA, MODELS, VOICES, WHISPER, MODELS / "argos"]:
    folder.mkdir(parents=True, exist_ok=True)

SAMPLES = {
    "en": "Hello, Sergey. We can start the meeting now. The price is twelve thousand dollars.",
    "ru": "Добрый день, Сергей. Мы можем начать встречу сейчас. Цена составляет двенадцать тысяч долларов.",
    "zh": "你好，谢尔盖。我们现在可以开始会议。价格是一万两千美元。",
    "ar": "مرحباً سيرغي. يمكننا بدء الاجتماع الآن. السعر اثنا عشر ألف دولار.",
}
TARGET_VOICES = {
    "en": "en_US-lessac-medium",
    "ru": "ru_RU-ruslan-medium",
    "zh": "zh_CN-huayan-medium",
    "ar": "ar_JO-kareem-medium",
}
PAIRS = [("en", "ru"), ("ru", "en"), ("en", "zh"), ("zh", "en"),
         ("en", "ar"), ("ar", "en")]


def stamp(label, extra=None):
    print(json.dumps({"event": label, "time": time.strftime("%H:%M:%S UTC", time.gmtime()),
                      "detail": extra}, ensure_ascii=False), flush=True)


def prepare():
    import requests
    from piper.download_voices import download_voice
    from argostranslate import package
    from faster_whisper import WhisperModel
    stamp("prepare_start")
    voice_index = requests.get(
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json",
        timeout=45).json()
    voice_names = sorted(voice_index.keys())
    voices = {}
    for lang, preferred in TARGET_VOICES.items():
        candidates = [v for v in voice_names if v.startswith(
            {"en": "en_US-", "ru": "ru_RU-", "zh": "zh_CN-", "ar": "ar_"}[lang])]
        chosen = preferred if preferred in voice_names else (
            next((x for x in candidates if x.endswith("-medium")), candidates[0] if candidates else None))
        if chosen:
            stamp("voice_download", {"lang": lang, "model": chosen})
            try:
                download_voice(chosen, VOICES)
                voices[lang] = chosen
            except Exception as exc:
                stamp("voice_error", {"lang": lang, "error": str(exc)})
        else:
            stamp("voice_unavailable", {"lang": lang})
    (DATA / "voices.json").write_text(json.dumps(voices, indent=2), encoding="utf-8")
    stamp("argos_index")
    package.update_package_index()
    available = package.get_available_packages()
    installed = {(p.from_code, p.to_code) for p in package.get_installed_packages()}
    for src, dst in PAIRS:
        if (src, dst) in installed:
            stamp("argos_ready", [src, dst])
            continue
        candidate = next((p for p in available if p.from_code == src and p.to_code == dst), None)
        if candidate is None:
            stamp("argos_unavailable", [src, dst])
            continue
        stamp("argos_download", [src, dst])
        package.install_from_path(candidate.download())
        stamp("argos_installed", [src, dst])
    stamp("whisper_download", "base multilingual CPU int8")
    t0 = time.perf_counter()
    WhisperModel("base", device="cpu", compute_type="int8", cpu_threads=1,
                 num_workers=1, download_root=str(WHISPER))
    stamp("prepare_done", {"seconds": round(time.perf_counter() - t0, 2),
                           "voices": voices})


def voice_for(lang):
    from piper import PiperVoice
    voices = json.loads((DATA / "voices.json").read_text(encoding="utf-8"))
    name = voices[lang]
    t0 = time.perf_counter()
    obj = PiperVoice.load(VOICES / f"{name}.onnx", use_cuda=False)
    return obj, round(time.perf_counter() - t0, 3), name


def synth(voice, utterance, path):
    t0 = time.perf_counter()
    with wave.open(str(path), "wb") as stream:
        voice.synthesize_wav(utterance, stream)
    elapsed = time.perf_counter() - t0
    with wave.open(str(path), "rb") as stream:
        duration = stream.getnframes() / stream.getframerate()
    return round(elapsed, 3), round(duration, 3)


def translate_via_en(text, src, dst):
    from argostranslate import translate
    if src == dst:
        return text
    try:
        return translate.translate(text, src, dst)
    except Exception:
        if src != "en" and dst != "en":
            return translate.translate(translate.translate(text, src, "en"), "en", dst)
        raise


def bench():
    from faster_whisper import WhisperModel
    whisper_size = sys.argv[2] if len(sys.argv) > 2 else "base"
    if whisper_size not in ("base", "small"):
        raise SystemExit("Whisper model must be base or small")
    result_file = DATA / f"results_{whisper_size}_warm.json"
    result = {"machine": {"cpu_limit": "imon-job: 1 CPU, 2 GiB RAM",
                          "whisper": f"{whisper_size} int8", "speech": "Piper-generated clean sample"},
              "pipelines": [], "text_translation": []}
    t0 = time.perf_counter()
    model = WhisperModel(whisper_size, device="cpu", compute_type="int8",
                         cpu_threads=1, num_workers=1, download_root=str(WHISPER))
    result["whisper_load_seconds"] = round(time.perf_counter() - t0, 3)
    stamp("whisper_loaded", result["whisper_load_seconds"])
    voices = {}
    for lang in json.loads((DATA / "voices.json").read_text(encoding="utf-8")):
        obj, seconds, name = voice_for(lang)
        voices[lang] = obj
        stamp("tts_loaded", {"lang": lang, "seconds": seconds, "name": name})
    warm_start = time.perf_counter()
    for src, dst in [("en", "ru"), ("ru", "en"), ("zh", "ru"), ("ar", "ru")]:
        translate_via_en(SAMPLES[src], src, dst)
    result["mt_warmup_seconds"] = round(time.perf_counter() - warm_start, 3)
    stamp("mt_warmup_done", result["mt_warmup_seconds"])
    for src, dst in [("en", "ru"), ("ru", "en"), ("zh", "ru"), ("ar", "ru")]:
        if src not in voices or dst not in voices:
            stamp("pipeline_skipped", [src, dst])
            continue
        entry = {"from": src, "to": dst}
        try:
            input_file = DATA / f"input_{src}.wav"
            output_file = DATA / f"translated_{src}_to_{dst}.wav"
            entry["input_tts_seconds"], entry["input_audio_seconds"] = synth(
                voices[src], SAMPLES[src], input_file)
            stamp("asr_start", [src, dst])
            t0 = time.perf_counter()
            segments, info = model.transcribe(str(input_file), language=src,
                                              beam_size=2, vad_filter=False,
                                              condition_on_previous_text=False)
            recognized = " ".join(s.text.strip() for s in segments).strip()
            entry["asr_seconds"] = round(time.perf_counter() - t0, 3)
            entry["recognized"] = recognized
            t0 = time.perf_counter()
            translated = translate_via_en(recognized, src, dst)
            entry["mt_seconds"] = round(time.perf_counter() - t0, 3)
            entry["translated"] = translated
            entry["output_tts_seconds"], entry["output_audio_seconds"] = synth(
                voices[dst], translated, output_file)
            entry["total_seconds"] = round(
                entry["asr_seconds"] + entry["mt_seconds"] + entry["output_tts_seconds"], 3)
            entry["realtime_ratio"] = round(
                entry["total_seconds"] / entry["input_audio_seconds"], 3)
            entry["output_wav"] = str(output_file)
            stamp("pipeline_done", entry)
        except Exception as exc:
            entry["error"] = f"{type(exc).__name__}: {exc}"
            stamp("pipeline_error", entry)
        result["pipelines"].append(entry)
        (result_file).write_text(json.dumps(result, ensure_ascii=False, indent=2),
                                          encoding="utf-8")
    for src, dst in [("en", "zh"), ("en", "ar"), ("zh", "ru"), ("ar", "ru")]:
        entry = {"from": src, "to": dst, "input": SAMPLES[src]}
        try:
            t0 = time.perf_counter()
            entry["output"] = translate_via_en(SAMPLES[src], src, dst)
            entry["seconds"] = round(time.perf_counter() - t0, 3)
        except Exception as exc:
            entry["error"] = f"{type(exc).__name__}: {exc}"
        result["text_translation"].append(entry)
    (result_file).write_text(json.dumps(result, ensure_ascii=False, indent=2),
                                      encoding="utf-8")
    stamp("bench_done", {"results": str(result_file)})
    if any("error" in item for item in result["pipelines"]):
        raise SystemExit("One or more speech pipelines failed")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"
    if mode not in ("all", "prepare", "bench"):
        raise SystemExit("Usage: python run.py prepare | bench | all")
    if mode in ("all", "prepare"):
        prepare()
    if mode in ("all", "bench"):
        bench()
