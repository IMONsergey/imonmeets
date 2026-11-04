from dataclasses import dataclass, field
from pathlib import Path
import os
import json
import stat


class PilotError(Exception):
    """A stable, content-free error safe to put in an operator receipt."""


ROUTES = frozenset((a, b) for a, b in (
    ("ru", "en"), ("en", "ru"), ("ru", "zh"),
    ("zh", "ru"), ("ru", "ar"), ("ar", "ru"),
))
STT_URL = "wss://stt-rt.soniox.com/transcribe-websocket"
TTS_URL = "wss://tts-rt.soniox.com/tts-websocket"


def load_private_env(path: Path) -> dict[str, str]:
    # Never evaluate shell syntax, interpolate values, or print this file.
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 16384:
        raise PilotError("ENV_FILE_MUST_BE_PRIVATE_REGULAR_FILE")
    result = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, sep, value = line.partition("=")
        if not sep or not name.startswith(("SONIOX_", "MEETS_TRANSLATION_")):
            raise PilotError("INVALID_ENV_SETTING")
        if name in result:
            raise PilotError("DUPLICATE_ENV_SETTING")
        result[name] = value.strip().strip('"').strip("'")
    return result


def load_context(path: Path):
    """Read explicitly supplied meeting vocabulary; never guess a transcript."""
    info = path.lstat()
    if not path.is_absolute() or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 16384:
        raise PilotError("CONTEXT_MUST_BE_PRIVATE_REGULAR_FILE")
    try:
        value = json.loads(path.read_text())
    except (ValueError, UnicodeError):
        raise PilotError("INVALID_CONTEXT") from None
    if not isinstance(value, dict) or set(value) - {"general", "text", "terms", "translation_terms"}:
        raise PilotError("INVALID_CONTEXT")
    def string(text, maximum):
        if not isinstance(text, str) or not 1 <= len(text) <= maximum or any(ord(c) < 32 and c not in "\n\t" for c in text):
            raise PilotError("INVALID_CONTEXT")
    if "text" in value:
        string(value["text"], 4000)
    for name, keys, maximum in (("general", {"key", "value"}, 8),
                                ("translation_terms", {"source", "target"}, 100),
                                ("terms", None, 100)):
        if name not in value:
            continue
        items = value[name]
        if not isinstance(items, list) or len(items) > maximum:
            raise PilotError("INVALID_CONTEXT")
        for item in items:
            if keys is None:
                string(item, 100)
            else:
                if not isinstance(item, dict) or set(item) != keys:
                    raise PilotError("INVALID_CONTEXT")
                for text in item.values():
                    string(text, 500 if name == "general" else 100)
    return value


@dataclass(frozen=True)
class Settings:
    enabled: bool = False
    api_key: str = field(default="", repr=False)
    voice: str = "Adrian"
    max_input_seconds: int = 300
    max_output_seconds: int = 600
    max_text_chars: int = 6000
    max_wall_seconds: int = 360
    queue_seconds: float = 5.0
    reservation_cents: int = 50
    budget_cents: int = 500
    state_dir: Path = Path("ops-state/soniox-pilot")
    stt_model: str = "stt-rt-v6"
    tts_model: str = "tts-rt-v2"
    endpoint_delay_ms: int = 2000
    context: dict | None = field(default=None, repr=False)

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        def integer(name, default, maximum):
            try:
                value = int(env.get(name, default))
            except (ValueError, TypeError):
                raise PilotError("INVALID_LIMIT") from None
            if not 1 <= value <= maximum:
                raise PilotError("INVALID_LIMIT")
            return value
        seconds = integer("MEETS_TRANSLATION_MAX_INPUT_SECONDS", 300, 900)
        settings = cls(
            enabled=env.get("MEETS_TRANSLATION_ENABLED") == "true",
            api_key=env.get("SONIOX_API_KEY", ""),
            voice=env.get("SONIOX_VOICE", "Adrian"),
            stt_model=env.get("SONIOX_STT_MODEL", "stt-rt-v6"),
            endpoint_delay_ms=integer("SONIOX_ENDPOINT_DELAY_MS", 2000, 3000),
            context=load_context(Path(env["SONIOX_CONTEXT_FILE"])) if env.get("SONIOX_CONTEXT_FILE") else None,
            max_input_seconds=seconds,
            max_output_seconds=integer("MEETS_TRANSLATION_MAX_OUTPUT_SECONDS", 600, 1800),
            max_text_chars=integer("MEETS_TRANSLATION_MAX_TEXT_CHARS", 6000, 24000),
            max_wall_seconds=seconds + 60,
            reservation_cents=integer("MEETS_TRANSLATION_RESERVATION_CENTS", 50, 10000),
            budget_cents=integer("MEETS_TRANSLATION_BUDGET_CENTS", 500, 10000),
            state_dir=Path(env.get("MEETS_TRANSLATION_STATE_DIR", "ops-state/soniox-pilot")).resolve(),
        )
        if not 1 <= len(settings.voice) <= 100 or any(ord(c) < 32 for c in settings.voice):
            raise PilotError("INVALID_VOICE")
        if settings.stt_model not in ("stt-rt-v6", "stt-rt-v5"):
            raise PilotError("UNSUPPORTED_STT_MODEL")
        if settings.endpoint_delay_ms < 500:
            raise PilotError("INVALID_ENDPOINT_DELAY")
        if settings.reservation_cents > settings.budget_cents:
            raise PilotError("RESERVATION_EXCEEDS_BUDGET")
        return settings

    def require_enabled(self):
        if not self.enabled:
            raise PilotError("TRANSLATION_DISABLED")
        if not self.api_key or len(self.api_key) > 250 or any(c.isspace() for c in self.api_key):
            raise PilotError("SONIOX_KEY_REQUIRED")


def validate_route(source: str, target: str):
    if (source, target) not in ROUTES:
        raise PilotError("UNSUPPORTED_ROUTE")
