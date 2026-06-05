"""Per-session boolean signals — verbatim port of the Apps Script's
in-house and booking-link rules.

These are keyword-matched flags, NOT LLM-derived. Mohsin wants the LLM
swap for intent/sentiment/topics (#5 on the punch list); these are simple
URL / phrase checks that are accurate as keyword rules and don't need an
API call.

The script applies these per session-text (full conversation log
concatenated), with negation guards on in-house so "I want to book a
room" doesn't get flagged as a current guest.
"""
from __future__ import annotations

import re

IN_HOUSE_KEYWORDS: tuple[str, ...] = (
    "my room number is", "i am in room", "staying in room", "checked into room",
    "currently in room", "i'm in room", "room number:", "guest in room",
    "staying here now", "checked in today", "just checked in",
)
# If any of these appear, the IN_HOUSE_KEYWORDS match is suppressed —
# the user is talking about a future stay, not their current one.
IN_HOUSE_NEGATIONS: tuple[str, ...] = (
    "want to book", "planning to", "will be staying", "going to stay",
)

BOOKING_LINK_KEYWORDS: tuple[str, ...] = (
    "booking.com", "book.", "reservation link", "booking link",
    "reserve here", "book here", "https://", "http://", "www.",
    ".com/book", "agoda", "expedia", "hotels.com",
)

_ROOM_NUMBER_DIGITS = re.compile(r"\d{3,4}")


def is_in_house(session_text: str) -> bool:
    """True if any message in the session indicates the user is currently
    staying at the hotel. Two paths: (a) a literal "room number" phrase
    plus a numeric / qualifier nearby, (b) a phrase from IN_HOUSE_KEYWORDS
    not overridden by a future-stay negation."""
    low = session_text.lower()
    if "room number" in low and (
        " is " in low
        or ":" in low
        or _ROOM_NUMBER_DIGITS.search(session_text)
    ):
        return True
    if any(kw in low for kw in IN_HOUSE_KEYWORDS):
        if not any(neg in low for neg in IN_HOUSE_NEGATIONS):
            return True
    return False


def has_booking_link(session_text: str) -> bool:
    """True if the session log contains a booking-link signal — explicit
    URLs, OTA names (Agoda/Expedia/Hotels.com), or referral phrases."""
    low = session_text.lower()
    return any(kw in low for kw in BOOKING_LINK_KEYWORDS)
