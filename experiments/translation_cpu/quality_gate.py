"""Conservative lexical diagnostics before experimental speech admission.

This is NOT a semantic verifier. No route has a voice grant in this revision.
Unsupported/ambiguous forms require review; source ASR errors are outside scope.
Original text is never edited, reconstructed, or replaced from a reference.
"""
from __future__ import annotations

import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

POLICY_VERSION = "experimental-lexical-v1"
EXPERIMENTAL_ROUTES = frozenset(
    (source, target)
    for peer in ("en", "zh", "ar")
    for source, target in (("ru", peer), (peer, "ru"))
)
MAX_TEXT_CHARS = 8000
MAX_NUMERIC_ITEMS = 32
MAX_NUMBER_CHARS = 64


@dataclass(frozen=True)
class QualityAssessment:
    policy_version: str
    route_status: str
    status: str
    reasons: tuple[str, ...]
    numeric_check: str
    currency_check: str
    negation_check: str

    @property
    def speech_allowed(self):
        # Removing this hard stop requires a separately reviewed route/voice grant
        # and evidence. There is deliberately no public allow-test/runtime flag.
        return False


@dataclass(frozen=True)
class _Facts:
    numbers: tuple[Decimal, ...]
    numeric_present: bool
    numeric_unresolved: bool
    currencies: tuple[str, ...]
    ambiguous_currency: bool
    negation: bool
    cancellation: bool
    percent: bool
    format_controls: bool
    bound_exceeded: bool


# Match candidate numeric spans, not an asserted locale grammar. Punctuation is
# accepted only by _parse_number below. No float conversion or digit reversal.
_NUMBER = re.compile(r"[+\-]?[0-9]+(?:[.,٫٬ :/\-][0-9]+)*")
_WORD_NUMBERS = {
    "en": re.compile(r"\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|minus)\b"),
    "ru": re.compile(r"\b(?:ноль|нул[ьяею]|один|одна|одно|одного|одной|два|две|двух|три|трех|четыре|четырех|пять|пяти|шесть|шести|семь|семи|восемь|восьми|девять|девяти|десять|десяти|одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать|восемнадцать|девятнадцать|двадцать|тридцать|сорок|пятьдесят|шестьдесят|семьдесят|восемьдесят|девяносто|сто|ста|двести|двести|тр[ие]ста|четыреста|пятьсот|шестьсот|семьсот|восемьсот|девятьсот|тысяч[а-я]*|миллион[а-я]*|миллиард[а-я]*|минус)\b"),
    "zh": re.compile(r"[零〇一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟萬億负]"),
    "ar": re.compile(r"(?<!\w)و?(?:صفر|واحد|واحدة|اثنان|اثنين|اثنا|اثني|اثنتان|اثنتين|اثنتا|اثنتي|ثلاث[ة]?|اربع[ة]?|خمس[ة]?|ست[ة]?|سبع[ة]?|ثمان[ية]*|تسع[ة]?|عشر[ة]?|عشرين|عشرون|ثلاثين|ثلاثون|اربعين|اربعون|خمسين|خمسون|ستين|ستون|سبعين|سبعون|ثمانين|ثمانون|تسعين|تسعون|مئة|مائة|مئتا|مئتي|مئتان|مئتين|الف|الفا|الفين|الاف|مليون|ملايين|مليار|سالب)(?!\w)"),
}
_NEGATION = {
    "en": re.compile(r"\b(?:no|not|never|without|cannot|neither|nor|unless|except)\b|n['’]t\b"),
    "ru": re.compile(r"\b(?:не|нет|ни|нельзя|никогда|без|запрещено|запрещается)\b"),
    "zh": re.compile(r"不|没|未|无|無|别|別|勿|禁止"),
    "ar": re.compile(r"(?<!\w)و?(?:لا|لم|لن|ليس|ليست|دون|بدون|بلا|غير|ممنوع)(?!\w)"),
}
_CANCELLATION = {
    "en": re.compile(r"\b(?:cancel(?:s|led|ed|ling|ing)?|cancellation|revoke(?:d|s)?|withdraw(?:n)?)\b"),
    "ru": re.compile(r"\b(?:отмен[а-я]*|аннулир[а-я]*|отозв[а-я]*)\b"),
    "zh": re.compile(r"取消|撤销|撤銷|作废|作廢"),
    "ar": re.compile(r"(?<!\w)و?(?:الغ[\w]*|الغي[\w]*)(?!\w)"),
}
# Longer explicit forms precede generic terms; overlapping matches are consumed
# once, so e.g. 美元 is not also classified as an unspecified 元.
_CURRENCY_PATTERNS = tuple(
    (name, re.compile(pattern))
    for name, pattern in (
        ("USD", r"(?<![a-z])usd(?![a-z])|\bu\.?s\.?\s*dollars?\b|доллар[а-я]*\s+сша|美元|دولار[اات]*\s+امريك[\w]*"),
        ("EUR", r"(?<![a-z])eur(?![a-z])|€|\beuros?\b|евро(?!цент)|欧元|歐元|يورو"),
        ("RUB", r"(?<![a-z])rub(?![a-z])|₽|\brou?bles?\b|рубл[а-я]*|卢布|盧布|روبل"),
        ("CNY", r"(?<![a-z])cny(?![a-z])|(?<![a-z])rmb(?![a-z])|\byuan\b|юан[а-я]*|人民币|人民幣|يوان"),
        ("USD_MINOR", r"\bus\s*cents?\b|美分"),
        ("EUR_MINOR", r"\beuro\s*cents?\b|\beurocents?\b|евроцент[а-я]*|欧分|歐分"),
        ("AMBIGUOUS_DOLLAR", r"\$|\bdollars?\b|доллар[а-я]*|دولار[اات]*"),
        ("AMBIGUOUS_YEN_YUAN", r"¥|元"),
        ("AMBIGUOUS_CENT", r"\bcents?\b|цент[а-я]*|سنت[\w]*"),
    )
)
_PERCENT = re.compile(r"%|\bpercent\b|процент[а-я]*|百分之|بالم[ائ][\w]*")


def _normalized(text):
    normalized = unicodedata.normalize("NFKC", text).casefold().replace("−", "-").replace("ё", "е")
    controls = any(unicodedata.category(char) == "Cf" for char in normalized)
    chars = []
    for char in normalized:
        if unicodedata.category(char) == "Cf":
            continue
        if char.isdecimal():
            chars.append(str(unicodedata.decimal(char)))
        elif "\u0600" <= char <= "\u06ff" and unicodedata.category(char).startswith("M"):
            continue  # lexical Arabic matching only; never edit returned text
        else:
            chars.append(char)
    normalized = "".join(chars).translate(str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ى": "ي"}))
    return " ".join(normalized.split()), controls


def _integer(text, separator=None):
    if separator is None:
        if not text or not text.isascii() or not text.isdigit():
            return None
        if len(text) > 1 and text.startswith("0"):
            return None  # could be an identifier or reversed RTL grouping
        return text
    groups = text.split(separator)
    if len(groups) < 2 or not (1 <= len(groups[0]) <= 3) or groups[0].startswith("0"):
        return None
    if not all(g.isascii() and g.isdigit() for g in groups) or any(len(g) != 3 for g in groups[1:]):
        return None
    return "".join(groups)


def _parse_number(token):
    if len(token) > MAX_NUMBER_CHARS:
        return None
    sign = ""
    if token[:1] in ("+", "-"):
        sign, token = token[0], token[1:]
    if not token or any(char in token for char in ":/-+"):
        return None  # time, date, fraction, range need semantic parsing
    decimal_separator = grouping_separator = None
    if "٫" in token or "٬" in token:
        if "." in token or "," in token or (" " in token and "٬" in token):
            return None
        if token.count("٫") > 1:
            return None
        decimal_separator = "٫" if "٫" in token else None
        grouping_separator = "٬" if "٬" in token else (" " if " " in token else None)
    elif "." in token and "," in token:
        decimal_separator = "." if token.rfind(".") > token.rfind(",") else ","
        grouping_separator = "," if decimal_separator == "." else "."
        if token.count(decimal_separator) != 1 or " " in token:
            return None
    elif "." in token or "," in token:
        separator = "." if "." in token else ","
        if token.count(separator) == 1:
            left, right = token.split(separator)
            if len(right) == 3:
                return None  # language != locale: 1,050 / 1.050 is ambiguous
            decimal_separator = separator
            grouping_separator = " " if " " in left else None
        else:
            if " " in token:
                return None
            grouping_separator = separator
    elif " " in token:
        grouping_separator = " "
    if decimal_separator is None:
        integer = _integer(token, grouping_separator)
        fraction = ""
    else:
        pieces = token.split(decimal_separator)
        if len(pieces) != 2:
            return None
        integer, fraction = pieces
        integer = _integer(integer, grouping_separator)
        if not fraction or not fraction.isascii() or not fraction.isdigit() or len(fraction) > 18:
            return None
    if integer is None:
        return None
    try:
        value = Decimal(sign + integer + ("." + fraction if fraction else ""))
        return value if value.is_finite() else None
    except InvalidOperation:
        return None


def _facts(text, language):
    normalized, controls = _normalized(text)
    if len(normalized) > MAX_TEXT_CHARS * 4:
        return _Facts((), True, True, (), True, False, False, False, controls, True)
    numbers, numeric_present, unresolved, bound = [], False, False, False
    count = 0
    for match in _NUMBER.finditer(normalized):
        count += 1
        numeric_present = True
        if count > MAX_NUMERIC_ITEMS:
            unresolved = bound = True
            break
        value = _parse_number(match.group())
        before = normalized[match.start() - 1:match.start()] if match.start() else ""
        if before in (".", ",", "٫"):
            value = None  # .5 must not silently become 5
        if value is None:
            unresolved = True
        else:
            numbers.append(value)
    words = _WORD_NUMBERS.get(language)
    if words is not None and words.search(normalized):
        numeric_present = unresolved = True
    if numeric_present and any(char in normalized for char in ("±", "≈", "~")):
        unresolved = True
    currencies, occupied = [], []
    for name, pattern in _CURRENCY_PATTERNS:
        for match in pattern.finditer(normalized):
            if any(match.start() < end and match.end() > start for start, end in occupied):
                continue
            occupied.append(match.span())
            currencies.append(name)
            if len(currencies) > MAX_NUMERIC_ITEMS:
                bound = True
                break
        if bound and len(currencies) > MAX_NUMERIC_ITEMS:
            break
    negative, cancel = _NEGATION.get(language), _CANCELLATION.get(language)
    return _Facts(
        tuple(numbers), numeric_present, unresolved, tuple(currencies),
        any(name.startswith("AMBIGUOUS_") for name in currencies),
        bool(negative and negative.search(normalized)), bool(cancel and cancel.search(normalized)),
        bool(_PERCENT.search(normalized)), controls, bound,
    )


def assess_translation(source_text, translated_text, source_language, target_language):
    for text in (source_text, translated_text):
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
            raise ValueError("Quality gate requires nonempty bounded text")
    if not isinstance(source_language, str) or not isinstance(target_language, str):
        raise TypeError("Explicit source and target languages are required")
    route = "experimental" if (source_language, target_language) in EXPERIMENTAL_ROUTES else "unsupported"
    source, target = _facts(source_text, source_language), _facts(translated_text, target_language)
    reasons = []
    if source_language not in _NEGATION or target_language not in _NEGATION:
        reasons.append("language_not_supported_for_lexical_screen")
    if source.format_controls or target.format_controls:
        reasons.append("format_controls_need_review")
    if source.bound_exceeded or target.bound_exceeded:
        reasons.append("lexical_budget_exceeded")
    if source.numeric_unresolved or target.numeric_unresolved:
        numeric_check = "unresolved"
        reasons.append("numeric_form_unresolved")
    elif Counter(source.numbers) != Counter(target.numbers):
        numeric_check = "mismatch"
        reasons.append("numeric_values_mismatch")
    else:
        numeric_check = "match" if source.numeric_present or target.numeric_present else "not_present"
    if source.numeric_present != target.numeric_present:
        reasons.append("numeric_content_missing_or_added")
    if len(source.numbers) > 1 or len(target.numbers) > 1:
        reasons.append("multiple_numeric_bindings_unverified")
    if source.percent != target.percent:
        reasons.append("percent_marker_mismatch")
    if Counter(source.currencies) != Counter(target.currencies):
        currency_check = "mismatch"
        reasons.append("currency_markers_mismatch")
    elif source.currencies or target.currencies:
        currency_check = "unresolved" if source.ambiguous_currency or target.ambiguous_currency else "match"
    else:
        currency_check = "not_present"
    if source.ambiguous_currency or target.ambiguous_currency:
        reasons.append("currency_identity_ambiguous")
    if len(source.currencies) > 1 or len(target.currencies) > 1:
        reasons.append("multiple_currency_bindings_unverified")
    if source.negation != target.negation:
        negation_check = "mismatch"
        reasons.append("negation_cue_missing_or_added")
    elif source.negation or target.negation:
        negation_check = "scope_unverified"
        reasons.append("negation_scope_unverified")
    else:
        negation_check = "not_present"
    if source.cancellation != target.cancellation:
        reasons.append("cancellation_cue_missing_or_added")
    elif source.cancellation or target.cancellation:
        reasons.append("cancellation_scope_unverified")
    status = "needs_review" if reasons else "no_risk_detected"
    # Route rejection is independent of lexical findings. A clean lexical screen
    # never turns a known-bad experimental model chain into an accepted voice.
    reasons.append("route_experimental_voice_blocked" if route == "experimental" else "route_unsupported_voice_blocked")
    return QualityAssessment(POLICY_VERSION, route, status, tuple(dict.fromkeys(reasons)),
                             numeric_check, currency_check, negation_check)
