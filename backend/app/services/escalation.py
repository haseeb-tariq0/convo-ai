"""Escalation detection — verbatim port of the Rove Apps Script's
ESCALATION / ESCALATION_POSITIVE / ESCALATION_NEGATIVE keyword lists.

The script counts a session as "escalated" when ANY message in it contains
a trigger phrase (speak to human, manager, callback, etc.). The sentiment
is computed from the 2 lines before the trigger + everything after, scanning
for positive vs negative keyword evidence. Negative wins ties.

This replaces our prior `ai_intent == "complaint"` heuristic — escalations
and complaints aren't the same thing (a happy thanks-for-the-help is still
an escalation if the user explicitly asked for a human; an angry "your wifi
sucks" isn't if they never asked for a person).
"""
from __future__ import annotations

ESCALATION_TRIGGERS: tuple[str, ...] = (
    "speak to human", "speak to a human", "talk to human",
    "speak to a person", "talk to a person",
    "speak to someone", "talk to someone",
    "speak to manager", "talk to manager", "get me a manager",
    "speak to staff", "talk to staff",
    "speak to reception", "call reception",
    "live agent", "human agent", "human support",
    "real person", "actual person",
    "need a human", "want a human",
    "connect me to", "transfer me to", "put me through to",
    "request a callback", "request a call back",
    "need someone to call", "someone call me",
    "call me back", "please call me",
    "phone me", "give me a call",
    "human please", "person please",
)

ESCALATION_POSITIVE: tuple[str, ...] = (
    "thank you", "thanks", "thank u", "thx", "ty", "thnx", "thankyou",
    "many thanks", "much appreciated", "greatly appreciated", "truly appreciate",
    "appreciate it", "appreciate your help", "appreciate the help",
    "thanks a lot", "thanks so much", "thank you so much", "thank you very much",
    "shukran", "jazakallah", "shukriya", "dhanyavad", "merci", "gracias", "danke",
    "resolved", "sorted", "fixed", "done", "completed", "all good", "all set",
    "issue resolved", "problem solved", "problem resolved", "taken care of",
    "been resolved", "has been fixed", "was fixed", "got fixed", "got sorted",
    "satisfied", "happy now", "happy with", "pleased", "glad", "relieved",
    "that works", "that helped", "very helpful", "so helpful", "great help",
    "great service", "excellent service", "good service", "wonderful",
    "amazing", "fantastic", "brilliant", "superb", "outstanding",
    "perfect", "excellent", "great", "awesome",
    "ok great", "okay great", "sounds good", "sounds great", "no problem",
    "will do", "understood", "noted", "got it", "no worries", "no issue",
    "looking forward", "see you soon", "see you there",
)

ESCALATION_NEGATIVE: tuple[str, ...] = (
    "still waiting", "been waiting", "waiting since", "waiting for hours",
    "waiting long", "how long", "no response", "no reply", "not replied",
    "not responding", "didnt reply", "didn't reply", "didnt respond",
    "didn't respond", "no one replied", "nobody replied", "no one responded",
    "nobody responded", "havent heard", "haven't heard", "heard nothing",
    "still no response", "still no reply", "zero response", "complete silence",
    "ignoring me", "being ignored", "no answer", "no one answered",
    "no one called", "nobody called", "didnt call", "didn't call",
    "havent called", "haven't called", "no call", "never called",
    "no one came", "nobody came", "no one showed", "nobody showed up",
    "no one visited", "no one checked", "no staff came",
    "not resolved", "still not resolved", "unresolved", "not fixed",
    "still broken", "still not working", "still dirty", "still noisy",
    "still happening", "issue persists", "problem persists", "same problem",
    "same issue", "nothing done", "nothing happened", "no action",
    "not done yet", "not sorted", "not helped", "not helping",
    "nothing has changed", "situation unchanged", "still the same",
    "not happy", "very unhappy", "not satisfied", "very dissatisfied",
    "extremely disappointed", "very disappointed", "so disappointed",
    "really frustrated", "so frustrated", "very frustrated", "beyond frustrated",
    "really angry", "very angry", "so angry", "absolutely furious", "furious",
    "livid", "outraged", "disgusted", "appalled", "horrified",
    "terrible experience", "horrible experience", "awful experience",
    "worst experience", "very bad experience", "bad experience",
    "terrible service", "horrible service", "awful service", "worst service",
    "poor service", "bad service", "shameful", "disgraceful",
    "unacceptable", "totally unacceptable", "absolutely unacceptable",
    "this is ridiculous", "this is absurd", "this is a joke", "what a joke",
    "this is pathetic", "pathetic", "embarrassing", "shocking",
    "cannot believe", "can't believe", "i cant believe", "i can't believe",
    "give up", "giving up", "forget it", "forget about it", "never mind",
    "useless", "pointless", "waste of time", "wasted my time",
    "waste of money", "wasted money", "complete waste", "total waste",
    "not worth it", "not worth anything", "hopeless",
    "will complain", "going to complain", "filing a complaint", "raise a complaint",
    "making a complaint", "formal complaint", "written complaint",
    "bad review", "negative review", "leaving a review", "will review",
    "tripadvisor", "google review", "booking.com review", "trust pilot",
    "social media", "will post", "going to post", "tell everyone",
    "want refund", "need refund", "requesting refund", "demand refund",
    "want compensation", "need compensation", "expecting compensation",
    "want to check out", "checking out early", "leaving early",
    "cancel my booking", "cancel reservation", "cancellation",
    "never coming back", "will not return", "wont return", "won't return",
    "not recommending", "will not recommend", "wont recommend",
    "very bad", "so bad", "too bad", "really bad", "quite bad",
    "worst", "terrible", "horrible", "dreadful", "atrocious",
    "not acceptable", "not good enough", "not good at all",
    "this is too much", "enough is enough", "had enough",
    "no professionalism", "unprofessional", "incompetent",
    "no one cares", "nobody cares", "dont care", "don't care",
    "not my problem anymore", "sort it out", "fix this now",
    "demand", "immediately", "right now", "asap or",
    # Multi-language tail
    "bahut bura", "bohot bura", "acha nahi", "accha nahi",
    "mujhe nahin chahiye", "wapis chahiye", "paisa wapis",
    "mafi nahi", "sahi nahi hai",
    "mish tamam", "mish kwayes", "mesh mabsout",
    "pas content", "pas satisfait", "inacceptable",
    "muy malo", "muy mal", "no es aceptable", "muy insatisfecho",
    "sehr schlecht", "nicht gut", "inakzeptabel",
)


def classify_escalation(
    messages: list[tuple[str, str]],
) -> str | None:
    """messages: ordered list of (role, content) tuples for ONE session.

    Returns "Positive" / "Negative" / "Unknown" if any message contains an
    escalation trigger; returns None if the session never escalated.

    Mirrors the script's algorithm: render messages as `ROLE: content`
    lines, find the first trigger line, take the 2 lines before it through
    the end of the conversation as context, scan that window for negative
    keywords first (they win ties), then positive, otherwise Unknown.
    """
    lines: list[str] = []
    for role, content in messages:
        r = role.lower()
        if r == "user":
            lines.append(f"USER: {content}")
        elif r in ("assistant", "bot"):
            lines.append(f"BOT: {content}")
        else:
            lines.append(f"{r.upper()}: {content}")

    trigger_idx = -1
    for i, line in enumerate(lines):
        low = line.lower()
        if any(kw in low for kw in ESCALATION_TRIGGERS):
            trigger_idx = i
            break

    if trigger_idx == -1:
        return None

    context_start = max(0, trigger_idx - 2)
    context = " ".join(lines[context_start:]).lower()

    if any(kw in context for kw in ESCALATION_NEGATIVE):
        return "Negative"
    if any(kw in context for kw in ESCALATION_POSITIVE):
        return "Positive"
    return "Unknown"
