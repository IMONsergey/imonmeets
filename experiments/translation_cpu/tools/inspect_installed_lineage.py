#!/usr/bin/env python3
"""Read-only provenance inventory for installed Argos and Whisper artifacts."""
from __future__ import annotations
import hashlib, importlib.metadata as md, json, pathlib, requests

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODELS = ROOT / "data" / "models"
OUT = ROOT / "data" / "lineage" / "installed_artifacts.json"

def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

def record(path, base):
    resolved = path.resolve()
    return {"path": str(path.relative_to(base)), "bytes": resolved.stat().st_size,
            "sha256": sha256(resolved)}

def distribution(name):
    try:
        d = md.distribution(name)
        return {"version": d.version, "license": d.metadata.get("License"),
                "license_expression": d.metadata.get("License-Expression"),
                "home_page": d.metadata.get("Home-page")}
    except md.PackageNotFoundError:
        return None

def main():
    result = {
        "observed_from": str(ROOT),
        "python_distributions": {n: distribution(n) for n in (
            "argostranslate", "faster-whisper", "ctranslate2", "huggingface-hub",
            "torch", "transformers", "safetensors", "sentencepiece", "sacremoses")},
        "argos": {}, "whisper": {}
    }
    argos_root = MODELS / "argos"
    for package_dir in sorted(x for x in argos_root.iterdir() if x.is_dir()):
        meta_path = package_dir / "metadata.json"
        metadata = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
        readme = package_dir / "README.md"
        config = package_dir / "model" / "config.json"
        wanted = {"metadata.json", "README.md", "config.json", "model.bin",
                  "shared_vocabulary.json", "shared_vocabulary.txt", "sentencepiece.model"}
        files = [record(f, package_dir) for f in sorted(package_dir.rglob("*"))
                 if f.is_file() and f.name in wanted]
        model_hash = next((f["sha256"] for f in files if f["path"].endswith("model.bin")), None)
        result["argos"][package_dir.name] = {
            "metadata": metadata,
            "readme_excerpt": readme.read_text(encoding="utf-8", errors="replace")[:2500] if readme.exists() else None,
            "model_config": json.loads(config.read_text(encoding="utf-8")) if config.exists() else None,
            "files": files, "model_bin_sha256": model_hash
        }

    whisper_root = MODELS / "whisper"
    for model_dir in sorted(whisper_root.glob("models--*")):
        refs = {}
        refs_dir = model_dir / "refs"
        if refs_dir.exists():
            for ref in refs_dir.iterdir():
                refs[ref.name] = ref.read_text(encoding="utf-8").strip()
        snapshots = {}
        for snapshot in sorted((model_dir / "snapshots").glob("*")):
            files = []
            for f in sorted(snapshot.iterdir()):
                if f.is_file():
                    files.append(record(f, snapshot))
            snapshots[snapshot.name] = files
        repo_name = model_dir.name.replace("models--", "").replace("--", "/")
        api = None
        for revision in refs.values():
            try:
                response = requests.get(
                    f"https://huggingface.co/api/models/{repo_name}/revision/{revision}",
                    timeout=20
                )
                if response.ok:
                    data = response.json()
                    api = {"sha": data.get("sha"), "cardData": data.get("cardData"),
                           "tags": data.get("tags"), "pipeline_tag": data.get("pipeline_tag")}
                break
            except Exception as exc:
                api = {"lookup_error": repr(exc)}
        result["whisper"][repo_name] = {"refs": refs, "snapshots": snapshots, "hub_api": api}

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("ARGOS_PACKAGES")
    for name, item in result["argos"].items():
        print(name, json.dumps(item["metadata"], ensure_ascii=False),
              "model_sha256", item["model_bin_sha256"])
    print("WHISPER_MODELS")
    for name, item in result["whisper"].items():
        print(name, "refs", item["refs"], "hub_api", item["hub_api"])
        for revision, files in item["snapshots"].items():
            print("SNAPSHOT", revision, [(f["path"], f["bytes"], f["sha256"]) for f in files])
    print("DIST", json.dumps(result["python_distributions"], ensure_ascii=False))
    print("MANIFEST", OUT, "sha256", sha256(OUT))

if __name__ == "__main__":
    main()
