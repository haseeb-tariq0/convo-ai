"""AI Widget Builder — turn a plain-English request into a validated
field_config entry the dashboard can render.

Safety by design: the model never writes a free-form field_config. It only
picks a `recipe` id from a fixed CATALOG of (type, source) combos that the
aggregation engine actually supports, plus a label / window / keywords. We
assemble the final field_config from the recipe, so the output is *always*
computable — the model can't invent an unsupported type or source.
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from ..config import get_settings

log = logging.getLogger(__name__)

# Each recipe = a known-good widget the engine can compute. `fields` is merged
# verbatim into the field_config; `needs` lists extra inputs the model supplies.
WIDGET_CATALOG: list[dict[str, Any]] = [
    {"id": "chats_total",       "type": "metric", "fields": {"source": "chat_count"},               "desc": "Total chats / conversations"},
    {"id": "unique_users",      "type": "metric", "fields": {"source": "unique_users"},             "desc": "Unique users"},
    {"id": "user_messages",     "type": "metric", "fields": {"source": "user_messages"},            "desc": "Total user messages"},
    {"id": "chat_sessions",     "type": "metric", "fields": {"source": "chat_sessions"},            "desc": "Number of chat sessions"},
    {"id": "avg_msgs",          "type": "metric", "fields": {"source": "avg_messages_per_chat"},    "desc": "Average messages per chat"},
    {"id": "avg_response",      "type": "metric", "fields": {"source": "avg_response_time_seconds"},"desc": "Average response time (seconds)"},
    {"id": "escalations",       "type": "metric", "fields": {"source": "human_escalations"},        "desc": "Human escalations / handoffs to staff"},
    {"id": "in_house",          "type": "metric", "fields": {"source": "in_house_guests"},          "desc": "In-house guests"},
    {"id": "booking_links",     "type": "metric", "fields": {"source": "booking_links_shared"},     "desc": "Booking links shared"},
    {"id": "keyword_count",     "type": "metric", "fields": {"source": "keyword_count"},            "needs": ["keywords"], "desc": "Count of messages containing given keywords"},
    {"id": "ga4_users",         "type": "metric", "fields": {"source": "ga4", "metric_type": "users"},       "desc": "Website users (GA4)"},
    {"id": "ga4_conversions",   "type": "metric", "fields": {"source": "ga4", "metric_type": "conversions"}, "desc": "Conversions / bookings (GA4)"},
    {"id": "sentiment_gauge",   "type": "gauge",  "fields": {"source": "ai_sentiment_score"},       "desc": "Overall sentiment gauge (-1 to 1)"},
    {"id": "chats_over_time",   "type": "line",   "fields": {"source": "chat", "aggregation": "count_by_day"}, "desc": "Conversations over time (daily)"},
    {"id": "ga4_users_trend",   "type": "line",   "fields": {"source": "ga4", "metric_type": "users"},        "desc": "Website users over time (GA4)"},
    {"id": "intent_pie",        "type": "pie",    "fields": {"source": "ai_intent"},                "desc": "Conversation intent breakdown (sales/service/complaint/…)"},
    {"id": "language_pie",      "type": "pie",    "fields": {"source": "language"},                 "desc": "Language mix (pie/donut)"},
    {"id": "language_bar",      "type": "bar",    "fields": {"source": "language"},                 "desc": "Languages ranked (bar)"},
    {"id": "traffic_bar",       "type": "bar",    "fields": {"source": "ga4_traffic"},              "desc": "Traffic sources (GA4)"},
    {"id": "faq_table",         "type": "table",  "fields": {"source": "faq_questions"},            "desc": "Top FAQ questions (table)"},
    {"id": "country_map",       "type": "map",    "fields": {"source": "phone_country"},            "desc": "Guest countries map (from phone numbers)"},
    {"id": "ga4_country_map",   "type": "map",    "fields": {"source": "ga4_country"},              "desc": "Visitor countries map (GA4)"},
]

_SYSTEM = """You convert a plain-English request for a dashboard widget into a JSON object that selects ONE widget recipe from a fixed catalog.

Respond with ONLY a JSON object:
{{"recipe": "<catalog id>", "label": "<short card title>", "window_days": <int or null>, "keywords": [<strings>]}}

Rules:
- recipe: the single best catalog id for the request. If nothing fits, use null.
- label: a concise human title for the card (e.g. "Bookings this month", "Top guest countries").
- window_days: map any time phrase — "today"=1, "yesterday"=1, "this week"/"7 days"=7, "this month"/"30 days"=30, "this quarter"/"90 days"=90. Use null if no time window is implied.
- keywords: ONLY include when recipe is "keyword_count"; the words/phrases to match. Otherwise return [].

Catalog (id: description [type]):
{catalog}
"""


def generate_widget_config(prompt: str, *, client_id: str | None = None) -> dict[str, Any]:
    """Return a validated field_config dict for the request, or raise
    ValueError if nothing in the catalog fits. Never returns an
    unsupported type/source — the recipe's `fields` are trusted, the model
    only chooses which recipe + supplies label/window/keywords."""
    catalog = "\n".join(f"- {r['id']}: {r['desc']} [{r['type']}]" for r in WIDGET_CATALOG)
    system = _SYSTEM.format(catalog=catalog)

    # Reuse the same provider/key resolution as the labelling pipeline so a
    # per-client key (or the platform OPENAI_API_KEY) is used consistently.
    from .ai import _resolve_credentials

    provider, api_key, model, _ = _resolve_credentials(client_id)
    raw = _ask_model(provider, api_key, model, system, prompt)

    try:
        sel = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError("The AI returned an unparseable response — try rephrasing.") from e
    return assemble_widget(sel)


def assemble_widget(sel: dict[str, Any]) -> dict[str, Any]:
    """Build a validated field_config from a model SELECTION (recipe id +
    label/window/keywords). Shared by the one-shot widget builder and the
    chat assistant. Raises ValueError if the recipe is unknown or required
    inputs are missing — so the output is always engine-computable."""
    recipe = next((r for r in WIDGET_CATALOG if r["id"] == sel.get("recipe")), None)
    if not recipe:
        raise ValueError(
            "Couldn't match that to a supported widget. Try something like "
            "'bookings this month' or 'top guest countries'."
        )
    field: dict[str, Any] = {
        "id": f"ai_{recipe['id']}_{uuid.uuid4().hex[:6]}",
        "type": recipe["type"],
        "label": (sel.get("label") or recipe["desc"]).strip()[:60],
        **recipe["fields"],
    }
    wd = sel.get("window_days")
    if isinstance(wd, int) and wd > 0:
        field["window_days"] = wd
    if "keywords" in recipe.get("needs", []):
        kws = [str(k).strip() for k in (sel.get("keywords") or []) if str(k).strip()]
        if not kws:
            raise ValueError("That widget needs keywords to match — please name them.")
        field["keywords"] = kws[:20]
    return field


def _ask_model(provider: str, api_key: str, model: str, system: str, prompt: str) -> str:
    # Retry transient network blips (Windows WinError 10035 socket flake, etc.).
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            if provider == "openai":
                from openai import OpenAI  # type: ignore

                client = OpenAI(api_key=api_key, max_retries=0)
                resp = client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": prompt},
                    ],
                    temperature=0,
                    max_tokens=300,
                    response_format={"type": "json_object"},
                )
                return resp.choices[0].message.content or "{}"
            if provider in ("claude", "anthropic"):
                from anthropic import Anthropic  # type: ignore

                client = Anthropic(api_key=api_key)
                resp = client.messages.create(
                    model=model,
                    max_tokens=300,
                    system=system,
                    messages=[{"role": "user", "content": prompt}],
                )
                return resp.content[0].text  # type: ignore[attr-defined]
            raise RuntimeError(f"Unknown AI provider {provider!r}")
        except Exception as e:  # noqa: BLE001 — retry transient errors
            last_err = e
            log.warning("widget AI call failed (attempt %d): %s", attempt + 1, e)
    raise last_err or RuntimeError("AI call failed")
