"""The only supported launcher for the private, single-model llama.cpp service."""
from __future__ import annotations
import hashlib
import os
import sys
from provenance import fingerprint, verify_models


def bounded_integer(name, default, minimum, maximum):
    raw = os.environ.get(name, str(default))
    if not raw.isdecimal() or not minimum <= int(raw) <= maximum:
        raise RuntimeError("Invalid summary resource setting")
    return str(int(raw))


def prepare_launch(models, server="/app/llama-server"):
    """Keep the measured inode open across exec; a path replacement cannot swap it."""
    models.assert_unchanged()
    if not models.summary:
        raise RuntimeError("Summary artifact is required")
    fd = os.open(models.summary["path"], os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        digest = hashlib.sha256()
        while block := os.read(fd, 1024 * 1024):
            digest.update(block)
        if digest.hexdigest() != models.summary["sha256"] or fingerprint(before) != fingerprint(os.fstat(fd)):
            raise RuntimeError("Summary artifact changed before launch")
        os.lseek(fd, 0, os.SEEK_SET)
        models.assert_unchanged()
        os.set_inheritable(fd, True)
        arguments = [
            server, "--model", "/proc/self/fd/" + str(fd),
            "--alias", "gguf-sha256-" + digest.hexdigest(),
            "--host", "0.0.0.0", "--port", "8080", "--parallel", "1",
            "--ctx-size", bounded_integer("SUMMARY_CONTEXT_TOKENS", 8192, 2048, 32768),
            "--threads", bounded_integer("SUMMARY_THREADS", 2, 1, 8),
            "--n-gpu-layers", "0", "--no-webui",
        ]
        environment = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "HOME", "LD_LIBRARY_PATH") if key in os.environ}
        environment.update({"HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "OMP_NUM_THREADS": arguments[arguments.index("--threads") + 1]})
        return fd, arguments, environment
    except BaseException:
        os.close(fd)
        raise


def main():
    if len(sys.argv) != 1:
        raise RuntimeError("Extra summary server arguments are forbidden")
    models = verify_models(require_summary=True)
    fd, arguments, environment = prepare_launch(models)
    try:
        os.execve(arguments[0], arguments, environment)
    finally:
        os.close(fd)


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except Exception:
        raise SystemExit("Summary model verification or launch failed")
