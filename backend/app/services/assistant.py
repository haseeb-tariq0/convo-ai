"""Admin AI assistant — a chat that can answer questions about a dashboard's
data AND take actions (today: add a widget). It's grounded in the dashboard's
current computed values, and any widget it adds goes through the same fixed
recipe catalog as the one-shot builder, so it can't create something the
engine can't render.

Returns {"reply": str, "widget": field_config | None}. The router appends the
widget (if any) to field_config; nothing persists until the operator saves.
"""
from __future__ import annotations

import json
import logging
from typing import Any

log = logging.getLogger(__name__)

ASSISTANT_SYSTEM = """You are the AI assistant inside the admin workspace of "Convo AI", a conversational-analytics dashboard platform. You are helping the operator manage the dashboard for the client "{dashboard_name}".

You can:
1. Answer questions about THIS dashboard's data (current values are listed below).
2. Add a widget/metric/chart to the dashboard when the operator asks.
3. Answer general questions about using the product.

Respond with ONLY a JSON object of this shape:
{{"reply": "<your conversational answer>", "add_widget": {{"recipe": "<catalog id>", "label": "<short title>", "window_days": <int or null>, "keywords": [<strings>]}} OR null}}

Rules:
- reply: ALWAYS present. Be friendly, concise, and specific — cite real numbers from the data when answering data questions. If you add a widget, say what you added in the reply.
- add_widget: include ONLY when the operator asks to add/create/show a widget, metric, or chart. Choose the single best recipe id from the catalog. window_days maps time phrases (today=1, this week=7, this month=30, this quarter=90, else null). keywords ONLY for the keyword_count recipe. Otherwise set add_widget to null.

CURRENT DASHBOARD DATA (last 30 days):
{summary}

WIDGET CATALOG (id: description [type]):
{catalog}
"""


def _summarize(data: dict[str, Any]) -> str:
    lines: list[str] = []
    for f in data.get("fields", []):
        v = f.get("value")
        label = f.get("label")
        t = f.get("type")
        if isinstance(v, dict) and "error" in v:
            continue
        if t == "metric" and isinstance(v, dict):
            unit = v.get("unit") or ""
            d = v.get("delta_pct")
            extra = f" ({d:+.1f}% vs prev)" if isinstance(d, (int, float)) else ""
            lines.append(f"- {label}: {v.get('value')}{(' ' + unit) if unit else ''}{extra}")
        elif t == "gauge" and isinstance(v, dict):
            lines.append(f"- {label}: {v.get('value')} (range {v.get('min')}..{v.get('max')})")
        elif t == "pie" and isinstance(v, dict):
            parts = ", ".join(f"{s.get('label')} {s.get('pct')}%" for s in v.get("slices", [])[:6])
            lines.append(f"- {label}: {parts}")
        elif t == "bar" and isinstance(v, dict):
            parts = ", ".join(f"{b.get('label')} {b.get('value')}" for b in v.get("bars", [])[:6])
            lines.append(f"- {label}: {parts}")
        elif t == "line" and isinstance(v, dict):
            pts = v.get("points", [])
            if pts:
                total = sum(p.get("y", 0) or 0 for p in pts)
                lines.append(f"- {label}: {len(pts)} days, total {total}, latest {pts[-1].get('y')}")
        elif t == "tag_cloud" and isinstance(v, dict):
            parts = ", ".join(str(tg.get("label")) for tg in v.get("tags", [])[:8])
            lines.append(f"- {label}: {parts}")
        else:
            lines.append(f"- {label}: (available)")
    return "\n".join(lines) or "(no data yet)"


def chat(messages: list[dict[str, Any]], dashboard: Any, *, client_id: str | None = None) -> dict[str, Any]:
    from .aggregations import compute_dashboard_data
    from .ai import _resolve_credentials
    from .widget_ai import WIDGET_CATALOG, assemble_widget

    data = compute_dashboard_data(dashboard.id, range_days=30)
    catalog = "\n".join(f"- {r['id']}: {r['desc']} [{r['type']}]" for r in WIDGET_CATALOG)
    system = ASSISTANT_SYSTEM.format(
        dashboard_name=dashboard.name,
        summary=_summarize(data),
        catalog=catalog,
    )

    provider, api_key, model, _ = _resolve_credentials(client_id)
    raw = _ask_chat(provider, api_key, model, system, messages)

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {"reply": (raw or "").strip()[:1200] or "Sorry, I couldn't generate a reply.", "widget": None}

    reply = (parsed.get("reply") or "").strip()
    widget = None
    aw = parsed.get("add_widget")
    if isinstance(aw, dict) and aw.get("recipe"):
        try:
            widget = assemble_widget(aw)
        except ValueError as e:
            reply = (reply + f"\n\n(I couldn't add that widget: {e})").strip()
    return {"reply": reply or "Done.", "widget": widget}


def _ask_chat(provider: str, api_key: str, model: str, system: str, messages: list[dict[str, Any]]) -> str:
    # Keep the last dozen turns to bound tokens.
    history = [
        {"role": "assistant" if m.get("role") == "assistant" else "user", "content": str(m.get("content", ""))}
        for m in messages
    ][-12:]
    if provider == "openai":
        from openai import OpenAI  # type: ignore

        client = OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system}, *history],
            temperature=0.3,
            max_tokens=600,
            response_format={"type": "json_object"},
        )
        return resp.choices[0].message.content or "{}"
    if provider in ("claude", "anthropic"):
        from anthropic import Anthropic  # type: ignore

        client = Anthropic(api_key=api_key)
        resp = client.messages.create(
            model=model,
            max_tokens=600,
            system=system + "\n\nRespond with ONLY the JSON object, no prose around it.",
            messages=history or [{"role": "user", "content": "Hello"}],
        )
        return resp.content[0].text  # type: ignore[attr-defined]
    raise RuntimeError(f"Unknown AI provider {provider!r}")
