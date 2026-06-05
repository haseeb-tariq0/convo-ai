"""Language detection — verbatim port of the Apps Script's `detectLanguage`.

Four-step decision tree:
  1. Native-script keyword hit (Arabic / Hindi / Russian / Urdu words written
     in their own scripts) → that language wins.
  2. For short or no-Latin text, fall back to a Unicode-range probe
     (cyrillic / devanagari / arabic / cjk / hiragana / hangul ranges).
  3. For Latin-script text, score romanized phrases per language. Highest
     score ≥ 3 wins. (Each phrase word adds 2 to the score, so a
     two-word phrase like "merci beaucoup" contributes 4.)
  4. If still undecided AND <50 % of non-whitespace chars are Latin, the
     text is non-Latin → return whichever Unicode range matched, else
     "Other (Non-Latin)". Otherwise default to English.

Same priority/order as the script, including the script's ties (later
entries in the romanized dict win when scores tie).
"""
from __future__ import annotations

import re

ARABIC_NATIVE: tuple[str, ...] = (
    "مرحبا", "شكرا", "بكم", "السلام", "من فضلك",
    "نعم", "لا", "كيف", "غرفة", "حجز", "سعر",
)
HINDI_NATIVE: tuple[str, ...] = (
    "नमस्ते", "धन्यवाद", "कैसे", "हाँ", "नहीं", "कृपया", "कमरा", "बुकिंग",
)
RUSSIAN_NATIVE: tuple[str, ...] = (
    "здравствуйте", "спасибо", "пожалуйста", "да", "нет",
    "привет", "комната", "бронирование",
)
URDU_NATIVE: tuple[str, ...] = (
    "شکریہ", "خوش", "کمرہ", "بکنگ", "قیمت",
)

ARABIC_ROMAN: tuple[str, ...] = (
    "marhaba", "shukran", "salam alaikum", "inshallah", "mashallah",
    "wallah", "habibi", "yalla", "mumkin", "min fadlak",
    "afwan", "ahlan", "jazakallah", "alhamdulillah",
)
HINDI_ROMAN: tuple[str, ...] = (
    "namaste", "dhanyavad", "shukriya", "kripya", "theek hai",
    "kaise ho", "kahan hai", "chahiye", "milega", "zaroor",
    "bilkul", "bahut accha", "koi baat nahi",
)
URDU_ROMAN: tuple[str, ...] = (
    "shukriya", "meherbani", "janab", "khuda hafiz",
    "bismillah", "tashreef", "huzoor",
)
FRENCH_WORDS: tuple[str, ...] = (
    "merci beaucoup", "bonjour", "excusez-moi", "bonne journee",
    "au revoir", "pardon", "je voudrais", "reservation",
)
GERMAN_WORDS: tuple[str, ...] = (
    "guten tag", "guten morgen", "auf wiedersehen",
    "entschuldigung", "ich mochte", "reservierung",
)
SPANISH_WORDS: tuple[str, ...] = (
    "buenos dias", "buenas tardes", "muchas gracias", "por favor",
    "de nada", "habitacion", "reservacion", "quisiera",
)
PORTUGUESE_WORDS: tuple[str, ...] = (
    "bom dia", "boa tarde", "muito obrigado", "muito obrigada",
    "por gentileza", "gostaria de", "reserva",
)
ITALIAN_WORDS: tuple[str, ...] = (
    "buongiorno", "buonasera", "grazie mille", "per favore",
    "mi scusi", "quanto costa", "vorrei", "prenotazione",
)
CHINESE_ROMAN: tuple[str, ...] = (
    "ni hao", "xie xie", "zai jian", "duo shao qian", "wo xiang yao",
)

_LATIN = re.compile(r"[a-zA-Z]")
_RANGE_AR = re.compile(r"[؀-ۿ]")  # Arabic
_RANGE_HI = re.compile(r"[ऀ-ॿ]")  # Devanagari (Hindi)
_RANGE_RU = re.compile(r"[Ѐ-ӿ]")  # Cyrillic (Russian)
_RANGE_CN = re.compile(r"[一-鿿]")  # CJK
_RANGE_JP = re.compile(r"[぀-ゟ゠-ヿ]")  # Hiragana / Katakana
_RANGE_KR = re.compile(r"[가-힯]")  # Hangul
_WHITESPACE = re.compile(r"\s")

_ROMANIZED: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Arabic (Rom)", ARABIC_ROMAN),
    ("Hindi (Rom)", HINDI_ROMAN),
    ("Urdu (Rom)", URDU_ROMAN),
    ("French", FRENCH_WORDS),
    ("German", GERMAN_WORDS),
    ("Spanish", SPANISH_WORDS),
    ("Portuguese", PORTUGUESE_WORDS),
    ("Italian", ITALIAN_WORDS),
    ("Chinese (Pinyin)", CHINESE_ROMAN),
)


def _range_match(text: str) -> str | None:
    """Probe the standard Unicode ranges in script's order — first hit wins."""
    if _RANGE_AR.search(text):
        return "Arabic"
    if _RANGE_HI.search(text):
        return "Hindi"
    if _RANGE_RU.search(text):
        return "Russian"
    if _RANGE_CN.search(text):
        return "Chinese"
    if _RANGE_JP.search(text):
        return "Japanese"
    if _RANGE_KR.search(text):
        return "Korean"
    return None


def detect_language(text: str) -> str:
    if not text:
        return "English"

    # 1) Native-script keyword hit
    if any(kw in text for kw in ARABIC_NATIVE):
        return "Arabic"
    if any(kw in text for kw in HINDI_NATIVE):
        return "Hindi"
    if any(kw in text for kw in RUSSIAN_NATIVE):
        return "Russian"
    if any(kw in text for kw in URDU_NATIVE):
        return "Urdu"

    text_lower = text.lower()

    # 2) Short messages or no-Latin → trust the Unicode range probe
    if not _LATIN.search(text) or len(text) < 20:
        match = _range_match(text)
        if match:
            return match

    # 3) Romanized phrase scoring on Latin-script input
    best_lang = "English"
    best_score = 0
    for lang, phrases in _ROMANIZED:
        score = 0
        for phrase in phrases:
            pattern = r"\b" + re.escape(phrase) + r"\b"
            if re.search(pattern, text_lower):
                score += len(phrase.split()) * 2
        # ">" not ">=" so earlier entries don't get overwritten by ties —
        # matches the script's behavior since JS for...of of an Object's
        # entries preserves insertion order.
        if score > best_score:
            best_lang = lang
            best_score = score
    if best_score >= 3:
        return best_lang

    # 4) Latin ratio fallback
    latin_count = len(_LATIN.findall(text))
    non_ws = len(_WHITESPACE.sub("", text))
    if non_ws > 0 and latin_count / non_ws < 0.5:
        match = _range_match(text)
        if match:
            return match
        return "Other (Non-Latin)"

    return "English"
