#!/usr/bin/env python3
"""Prepare deterministic sentence-ID-linked FLEURS held-out metadata."""
from __future__ import annotations
import hashlib, json
from collections import defaultdict
from pathlib import Path

REVISION = "70bb2e84b976b7e960aa89f1c648e09c59f894dd"
LANGUAGES = ("ru_ru", "en_us", "cmn_hans_cn", "ar_eg")
ROOT = Path(__file__).resolve().parents[1] / "data" / "fleurs_subset"
TSV_DIR = ROOT / "source_tsv"
OUT = ROOT / "selection_manifest.json"
MAX_PER_LANGUAGE = 40
MAX_TOTAL_SECONDS = 1800
SAMPLE_RATE = 16000

def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

def parse_tsv(path):
    by_id = defaultdict(list)
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        first = line.split("\t", 4)
        if len(first) != 5:
            raise ValueError(f"{path}:{line_no}: invalid leading TSV columns")
        tail = first[4].rsplit("\t", 2)
        if len(tail) != 3:
            raise ValueError(f"{path}:{line_no}: invalid trailing TSV columns")
        sid, filename, transcript, raw_transcript = first[:4]
        phonetic, num_samples, gender = tail
        rec = {
            "sentence_id": int(sid), "file": filename,
            "transcription": transcript, "raw_transcription": raw_transcript,
            "num_samples": int(num_samples),
            "duration_seconds": round(int(num_samples) / SAMPLE_RATE, 3),
            "gender": gender, "source_line": line_no
        }
        if rec["num_samples"] <= 0:
            raise ValueError(f"{path}:{line_no}: invalid sample count")
        by_id[sid].append(rec)
    return by_id

def choose_record(records):
    return next((r for r in records if r["gender"] == "MALE"), records[0])

def main():
    maps, source_hashes = {}, {}
    for lang in LANGUAGES:
        path = TSV_DIR / f"{lang}.test.tsv"
        if not path.is_file():
            raise FileNotFoundError(path)
        source_hashes[lang] = sha256(path)
        maps[lang] = parse_tsv(path)
    shared = sorted(set.intersection(*(set(maps[x]) for x in LANGUAGES)), key=int)
    if len(shared) < MAX_PER_LANGUAGE:
        raise RuntimeError(f"Only {len(shared)} common IDs")
    selected, records, total = [], [], 0.0
    for count in range(MAX_PER_LANGUAGE, 0, -1):
        indices = [round(i * (len(shared)-1)/(count-1)) for i in range(count)] if count > 1 else [len(shared)//2]
        candidate_ids = [shared[i] for i in indices]
        candidate, candidate_total = [], 0.0
        for sid in candidate_ids:
            langs = {}
            for lang in LANGUAGES:
                rec = choose_record(maps[lang][sid])
                langs[lang] = rec
                candidate_total += rec["duration_seconds"]
            candidate.append({"sentence_id": int(sid), "languages": langs})
        if candidate_total <= MAX_TOTAL_SECONDS:
            selected, records, total = candidate_ids, candidate, candidate_total
            break
    if not selected:
        raise RuntimeError("Unable to meet the 30-minute cap")
    manifest = {
        "dataset": "google/fleurs",
        "dataset_revision": REVISION,
        "dataset_license": "CC-BY-4.0",
        "dataset_card": "https://huggingface.co/datasets/google/fleurs",
        "split": "test",
        "configs": list(LANGUAGES),
        "parallel_key": "FLEURS TSV id field, not row number; exact intersection across all four language configs",
        "selection_method": "Evenly spaced numeric IDs from common-ID intersection; one MALE recording per ID if available, else first recording",
        "common_ids_available": len(shared),
        "records_per_language": len(selected),
        "total_audio_seconds": round(total, 3),
        "total_audio_minutes": round(total/60, 3),
        "source_tsv_sha256": source_hashes,
        "sentences": records
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(json.dumps({
        "common_ids": len(shared), "selected_ids": [int(x) for x in selected],
        "records_per_language": len(selected), "total_seconds": round(total, 3),
        "total_minutes": round(total/60, 3), "under_30min": total <= MAX_TOTAL_SECONDS,
        "sample_parallel_text": {lang: records[0]["languages"][lang]["transcription"] for lang in LANGUAGES},
        "manifest": str(OUT), "manifest_sha256": sha256(OUT)
    }, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
