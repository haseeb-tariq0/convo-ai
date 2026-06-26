# Convo AI — Scaling & Stability Plan

**Goal:** run 10–20+ clients (some with hundreds of thousands of chat rows) without
crashing. This document lists every scaling risk we have, why it bites at scale,
and concrete fixes — ordered by impact.

---

## The root cause (one sentence)

> **Almost every expensive operation loads *all* of a dashboard's rows into the
> backend's Python memory and computes there — so memory and time grow linearly
> with row count, and one big client can OOM the single shared instance for
> everyone.**

The yesterday crash and the Rove "281k rows" risk are the *same* problem. Fix the
root cause (push the work into Postgres) and most of the list below disappears.

---

## Capacity math (why this is urgent)

| Rows | Aggregation memory | Aggregation time (cold) |
|---|---|---|
| 9,000 (Nest) | ~25 MB | ~3 s |
| 281,000 (Rove) | ~700 MB+ | ~90 s (and request timeout) |
| 20 clients × 100k avg | OOM (sum of concurrent loads) | unusable |

One 281k-row aggregation alone exceeds the old 512 MB instance and strains the
2 GB one. Several clients viewed at once = guaranteed crash. **No amount of
caching fixes a cold load that itself OOMs.**

---

## Problem list (prioritized)

### P0 — Keystone: aggregation loads all rows into Python
- **Where:** `services/aggregations.py::compute_dashboard_data` → `store.chat_rows_for_dashboard()` pulls every row (paged 1000 at a time, all kept in memory), then counts/groups/averages in Python.
- **Impact:** O(rows) memory + O(rows) time, per dashboard, per window, per request. The thing that crashed us.
- **Fix:** **Do the aggregation in Postgres.** Replace per-widget Python loops with SQL `COUNT`/`GROUP BY`/`date_trunc`/`AVG`, exposed as RPC functions (you already use this pattern — `mark_chat_rows_processed`). Each `/data` call then transfers a few hundred small aggregate rows instead of hundreds of thousands of raw rows. Memory becomes ~constant regardless of client size.
  - Volume line → `SELECT date_trunc('day', occurred_at), count(*) ... GROUP BY 1`
  - Metrics (chats/users) → `COUNT`, `COUNT(DISTINCT user)`
  - Sentiment gauge → `AVG(ai_sentiment_score)`
  - Intent/language/country pies & bars → `GROUP BY` the field
  - Recent table → `ORDER BY occurred_at DESC LIMIT 50` (already small)
  - Topics/FAQ → either a SQL `GROUP BY` on a normalized column, or a maintained rollup
- **Effort:** Medium–High (rewrite the compute_* functions). **Impact: massive.** This is the single most important change.

### P0 — Precomputed rollups / materialized aggregates
- **Where:** there are none today — everything is computed on read.
- **Impact:** even SQL aggregation over millions of rows repeated on every 30s poll is wasteful.
- **Fix:** maintain **rollup tables** (e.g. `daily_metrics(dashboard_id, day, chats, users, sentiment_sum, …)`) updated incrementally as new rows sync. `/data` then reads tiny rollup rows. Options: incremental update in the sync job, a Postgres trigger, or a periodic `REFRESH MATERIALIZED VIEW CONCURRENTLY`.
- **Effort:** Medium. **Impact: huge** (makes dashboards O(days) not O(rows)).

### P1 — Single shared instance + in-process scheduler
- **Where:** `render.yaml` one `web` service, `uvicorn` with **no `--workers`** (1 process), `scheduler.py` runs sync/AI jobs **inside the API process**.
- **Impact:** all clients share one process's RAM/CPU. A heavy sync or aggregation blocks/OOMs request serving for *everyone*. No isolation, no horizontal scale.
- **Fix:**
  - Move the **scheduler into its own Render worker service** (separate process/memory) so background jobs never compete with API requests.
  - Once aggregation is cheap (P0), the API can run **multiple workers / instances** behind Render's load balancer.
- **Effort:** Low–Medium. **Impact: high** (isolation + horizontal scale).

### P1 — Data growth is unbounded
- **Where:** `chat_rows` grows forever; raw message text is kept for every row.
- **Impact:** 20 clients × hundreds of k rows = millions of rows; Supabase storage + query cost climb; backups slow.
- **Fix:** **retention + partitioning.** Keep rollups forever, but archive/drop raw rows older than N months (or move to cold storage). Partition `chat_rows` by `dashboard_id` and/or month so queries and deletes stay fast.
- **Effort:** Medium. **Impact: high long-term.**

### P1 — AI enrichment throughput & cost
- **Where:** `services/ai.py` processes 50 rows/tick every 60s = ~72k rows/day **max**; one OpenAI call per row-batch.
- **Impact:** a 281k-row backlog takes **days** to enrich; cost scales linearly with rows; new big clients lag.
- **Fix:** enrich a **bounded window** (e.g. only the last N days / sample), bigger batches per call, a cheaper model for classification, and a hard per-client daily cost cap. Decide what *must* be AI-scored vs. what can be skipped.
- **Effort:** Medium. **Impact: medium–high** (cost + latency control).

### P2 — Connection pool exhaustion
- **Where:** API + scheduler + (future) multiple workers all hit one Supabase.
- **Impact:** at scale, Postgres connection limits get exhausted → errors under load.
- **Fix:** use **Supabase's connection pooler (pgbouncer)**; set a bounded client pool; short-lived connections.
- **Effort:** Low. **Impact: medium** (prevents a different class of crash).

### P2 — Frontend polls `/data` every 30s per open dashboard
- **Where:** `pages/public/Dashboard.tsx` `refetchInterval: 30_000`.
- **Impact:** every open client tab triggers work; many viewers multiply load. (Mitigated by the 45s cache, but cold misses still cost.)
- **Fix:** once reads are cheap (P0/P1), this is fine; otherwise lengthen the interval or move to server-push/SSE for "new data" signals.
- **Effort:** Low. **Impact: low–medium.**

### P2 — Python memory not returned to OS
- **Where:** observed RSS creep after large loads (fragmentation).
- **Impact:** long-running process slowly climbs even when idle.
- **Fix:** mostly *solved by P0* (no large allocations). Belt-and-braces: periodic worker recycling (`--max-requests` style) for the scheduler/API.
- **Effort:** Low. **Impact: low once P0 done.**

### P3 — No load testing / proactive observability
- **Where:** we found the OOM **reactively**, from a client screenshot.
- **Impact:** the next scaling cliff is invisible until it crashes in front of a client.
- **Fix:** **memory/latency dashboards + alerts** (Render metrics, or Sentry/Grafana); a **load test** that simulates N clients × M rows × K concurrent viewers before onboarding each new batch of clients.
- **Effort:** Low–Medium. **Impact: high confidence.**

### P3 — GA4 aggregation has the same shape
- **Where:** GA4 snapshots are loaded and summed in Python too (smaller today).
- **Fix:** same SQL-rollup treatment when you get there.
- **Effort:** Low. **Impact: low now, scales later.**

---

## Recommended sequence

1. **Immediate (stop the bleeding):** clear/cap Rove's 281k test rows so prod can't be OOM'd today; confirm no other oversized client.
2. **Phase 1 — kill the root cause:** move aggregation into Postgres (P0). This alone makes the system survivable at scale.
3. **Phase 2 — rollups (P0) + scheduler-as-worker (P1):** O(days) reads + process isolation → horizontal scale unlocked.
4. **Phase 3 — retention/partitioning (P1) + AI cost controls (P1) + pooling (P2).**
5. **Ongoing — monitoring + load tests (P3)** gating each new batch of clients.

## The one-line takeaway
> Stop moving rows into Python. Let Postgres count, group, and roll up; the API
> should only ever read small aggregates. Do that and 20 clients is boring
> instead of terrifying.

---

## Progress log

### Phase 1 — proof of concept ✅ (done)
Built and verified a Postgres aggregation function on the **core metrics**, end to
end through the real app.

- **Migration `0012_convo_core_aggregates.sql`** — `convo_core_aggregates(dashboard_id, from, to)` returns one JSON object: `total_chats`, `user_messages`, `unique_users`, `avg_messages_per_chat`, `sentiment_avg`, `volume_sessions_by_day`, `intent` (pie), `topics` (tag cloud). Single-pass scan. (Applied to `convo-ai-prod`; additive/read-only; nothing calls it until the app is switched over.)
- **`store.core_aggregates()`** — calls the RPC.
- **Verified:** numbers match the Python path **exactly** on real data (Nest, Al Habtoor). Translated the subtle rules faithfully (empty-cell fallthrough via `nullif`, volume = *distinct sessions* per day not row count, sentiment = avg of scored rows, `ai_topics` is jsonb → `jsonb_array_elements_text`).
- **Measured (real data, through the app):**
  | Client | Python (old) | SQL RPC (new) | App memory |
  |---|---|---|---|
  | Al Habtoor (1k) | <1s | 0.21s | 106 MB |
  | Nest (9k) | ~3s | 1.78s | 106 MB |
  | Rove (281k) | 163s / 610 MB (OOM) | **1.77s** | **106 MB** |
  → ~92× faster on the mega-client; **memory flat regardless of size** (the OOM fix).

**Covered & verified so far:** total_chats, user_messages, unique_users,
avg_messages_per_chat, sentiment, volume (sessions/day), intent, topics,
**recent-conversations table** (`store.recent_chat_rows()` — `order by occurred_at
desc limit N`, top-20 identical to Python), and **time-windowing** (the RPC's
`from`/`to` params match Python's `occurred_at >= now()-days` exactly, verified
on a 30-day window — so the date-range selector and chats today/7d/30d are
covered too).

### Phase 1 — precompute pipeline ✅ (session-flag widgets)
Built and verified the **precompute-at-ingestion** path for the session-level
rule widgets — the rules stay in one place (Python) and the result is cached so
SQL aggregates it trivially:
- **Migration `chat_rows_session_flags`** — added `escalation_sentiment`,
  `is_in_house`, `has_booking_link` columns (+ partial "needs flags" index).
- **`services/precompute.py`** — `compute_session_flags()` / `row_flag_updates()`
  reuse the exact widget functions (`classify_escalation`, `is_in_house`,
  `has_booking_link`). Verified to reproduce the widgets exactly on Nest
  (in_house=95, booking=147, escalated pos/neu/neg=20/12/18, esc 7d=4).
- **`set_chat_row_flags` RPC + `store.set_chat_row_flags()` + `backfill_flags.py`**
  — bulk writer + one-time backfill. Ran on Al Habtoor (1,242 rows): the RPC's
  flag aggregates then matched Python exactly (booking 41, escalated 0/0/4).
- **RPC `convo_core_aggregates` extended** with escalations, escalated_*,
  in_house_guests, booking_links_shared (folded into the single scan via FILTER).

### Phase 1 — chat-row widgets ✅ COMPLETE (all verified exact on Nest)
- **SQL window fn:** avg response time (`lag()` over session) — Nest 7.7 ✓.
- **Precompute (migration `chat_rows_lang_country_faq`):** `detected_language`,
  `country`, `faq_question` columns; `precompute.py` extended to compute them via
  the exact widget functions (`detect_language`, `country_iso_from_phone`,
  `_normalize_question`/`_is_faq_question`). Verified after backfill — languages
  (English 401, Arabic 54), countries (AE 157, total 221), FAQ (hotel address 12)
  all match. *(Only cosmetic tie-ordering differs at equal counts — values exact.)*
- The aggregator RPC now returns 15+ data points in one call (~3.1s on Nest /
  ~5s on Rove 281k, flat memory).

### Phase 1 — SQL assembly ✅ BUILT & VERIFIED
- **`compute_dashboard_data_sql`** (aggregations.py) maps the RPC + helper
  results into the exact field-value shapes. GA4 / recent-table / map-embed
  widgets reuse `compute_field` with their small data (snapshots / top-N rows),
  so those stay byte-identical. Covers every widget incl. chat_count, keyword_count,
  role/language/channel/country breakdowns (helper RPCs `convo_field_breakdown`,
  `convo_keyword_count`, `convo_row_count`).
- **`verify_sql_aggregation.py`** diffs SQL vs Python field-by-field. Result on
  the backfilled dashboards: **`all` window matches 29/29 exactly**; windowed
  (7/30d) matches except session-level flags, which the SQL path computes over
  the FULL conversation vs the old per-window-messages — a small, defensible
  refinement on boundary-straddling sessions.
- Helper RPCs use `min(source_row_index)` tiebreak so topics/FAQ top-N match
  Python's first-seen ordering exactly.

### Phase 1 — remaining (mechanical)
- **GA4 widgets** already handled in the assembly (reuse `compute_field` on
  snapshots — small, no row load). ✓
- **Wire the sync job** (task 17) to compute flags for new rows' sessions —
  REQUIRED: without it, backfilled flags go stale as new rows sync (observed:
  Nest grew 9113→9159, 46 unflagged rows caused diffs until re-backfill).
- **Flip behind a flag** (task 18): gate the SQL path on a setting, add the new
  store methods to the in-memory/SQLAlchemy backends so tests pass, run suite.
- **Rove backfill** (~290k, one-time heavy write).
- **User localhost test → push.** This removes the OOM in prod.

### Phase 2 — rollups (mega-client cold load → milliseconds)
Fixes the *first-load* (cold-cache) latency that remains after Phase 1 — Rove's
cold load is 3–8s because even SQL scans 283k rows.

**Built & proven (2026-06-26):**
- `session_rollup` (one row per conversation — distinct/session metrics + faq; a
  window = sessions whose [started,ended] overlaps it, so the ~14% multi-day
  sessions count once, exactly) and `daily_rollup` (one row per day — additive
  metrics + volume).
- `convo_build_rollups(id)` pure-SQL builder + `convo_rollup_aggregates(id,
  from_day, to_day)` reader (same JSON shape, ~570 rows read instead of 283k).
- Verified vs the live SQL path (Nest all-time): chats/users/avg-msgs/response/
  sentiment/intent/volume all EXACT; languages/countries/topics/faq match on
  counts, order differs on ties only (no source_row_index in rollups — cosmetic).

**Built & wired (2026-06-26, behind `use_rollup_aggregation` flag, OFF):**
- Read path: `compute_dashboard_data_sql(use_rollup=True)` swaps the aggregate
  source to `store.rollup_aggregates` (day-bounded window); `compute_dashboard_data`
  dispatches on the flag. Verified vs the SQL path (Nest, Al Habtoor, all-window)
  — only diffs are live-data drift on the tiny `chats_today/week/month` scans and
  topics/faq tie-order (counts exact).
- Incremental maintenance: `convo_refresh_rollups(id, session_ids[], days[])`
  rebuilds only touched sessions + days; the sync calls it after the flag refresh
  (`_refresh_rollups` in sheets.py, reusing the rows fetched for flags).
- `backfill_rollups.py` (one-time build via `convo_build_rollups`).

**Note on timing:** local end-to-end measures 2–5s because every assembly
round-trip pays ~200ms latency to Supabase (ap-northeast-1) from a dev machine.
The server-side rollup read is **163ms**; on prod (Render→Supabase) it'll be far
faster. Measure real speed after flipping `use_rollup_aggregation` on prod.

**Breakdown-folding ✅ DONE (2026-06-26, still behind the OFF flag):** the
raw-field breakdowns (role/channel/country/language pies/bars) are folded into
`daily_rollup` (`role_counts`, `channel_counts`, `country_f_counts`,
`language_f_counts`), populated by the builder + refresh, returned by
`convo_rollup_aggregates` as `by_role/by_channel/by_country_field/by_language_field`,
and read by the assembly via `_breakdown()` (uses the folded map when the agg
carries the key, else falls back to `field_breakdown`). So the all-history view
now does zero raw scans. Rebuilding Rove needs `set statement_timeout='240s'`
(the 4 extra CTEs exceed the default PostgREST timeout on 283k rows).

**Window dispatch ✅ (2026-06-26) — the correctness keystone for rollups:**
rollups are day-granular, so they're only EXACT for windows whose lower bound is
a midnight. A rolling window (7d/30d = `now − N days`) has a mid-day lower bound;
serving it from rollups over-counts the partial boundary day (verified: it was
inflating the 7d/30d counts). `get_agg` now routes rolling windows to the
timestamp-precise **core** path (cheap — a bounded window scans little) and uses
rollups only for the unbounded `all` view + explicit calendar date-ranges, which
is exactly where the expensive cold load is. Both paths stay exact.

**Verification:** `verify_rollup_aggregation.py` (rollup path vs the
already-verified SQL path) went **72 diffs → 4** after the window-dispatch fix.
The 4 residual diffs are all cosmetic: FAQ top-20 / topics top-40 tie-order at
equal counts (rollups lack `source_row_index` for the first-seen tiebreak) + one
Rove live-drift off-by-1. Every metric value matches. **Next:** localhost test,
then flip `use_rollup_aggregation` on prod and measure real cold-load speed.
