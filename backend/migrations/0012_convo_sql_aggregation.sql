-- 0012_convo_sql_aggregation.sql
--
-- Phase 1 of the scaling fix (docs/SCALING.md): aggregate dashboard data in
-- Postgres instead of loading every chat_row into the app's Python memory
-- (which OOM'd on large clients — a 281k-row dashboard was 163s / 610MB).
--
-- This file is the authoritative schema for the SQL aggregation path:
--   1. Precompute columns on chat_rows (session-level rule flags + language /
--      country / faq, cached from the EXACT widget logic via services/precompute.py).
--   2. The aggregator RPC `convo_core_aggregates` (one call → all chat-row widgets).
--   3. Helper RPCs for the long-tail widgets + the flag writer + session fetch.
--
-- Verified field-by-field against the Python path (verify_sql_aggregation.py):
-- the `all` window matches 29/29; windowed differs only on boundary-straddling
-- sessions, where flags are computed over the full conversation (a refinement).

-- ── 1. Precompute columns ───────────────────────────────────────────────────
alter table public.chat_rows
  add column if not exists escalation_sentiment text,   -- 'Positive'|'Negative'|'Unknown'|null
  add column if not exists is_in_house           boolean,
  add column if not exists has_booking_link       boolean,
  add column if not exists detected_language      text,
  add column if not exists country                text,   -- ISO alpha-2 from phone
  add column if not exists faq_question           text;   -- normalized question (user rows)

create index if not exists chat_rows_flags_todo_idx
  on public.chat_rows (dashboard_id) where is_in_house is null;

-- ── 2. Flag writer (backfill + sync) ────────────────────────────────────────
create or replace function public.set_chat_row_flags(updates jsonb)
returns integer language plpgsql as $$
declare n integer;
begin
  update public.chat_rows c set
    escalation_sentiment = (u->>'escalation_sentiment'),
    is_in_house          = (u->>'is_in_house')::boolean,
    has_booking_link     = (u->>'has_booking_link')::boolean,
    detected_language    = (u->>'detected_language'),
    country              = (u->>'country'),
    faq_question         = (u->>'faq_question')
  from jsonb_array_elements(updates) as u
  where c.id = (u->>'id')::uuid;
  get diagnostics n = row_count;
  return n;
end; $$;
grant execute on function public.set_chat_row_flags(jsonb) to service_role;

-- ── 3. Core aggregator: all chat-row widgets in one call ────────────────────
-- topics/intent/faq use min(source_row_index) tiebreak so top-N ties match the
-- Python `Counter.most_common` first-seen order exactly.
create or replace function public.convo_core_aggregates(
  p_dashboard_id uuid, p_from timestamptz default null, p_to timestamptz default null
) returns jsonb language sql stable as $$
  with r as (
    select id, occurred_at, source_row_index, ai_sentiment_score, ai_intent, ai_topics,
      escalation_sentiment, is_in_house, has_booking_link, detected_language, country, faq_question,
      nullif(raw->>'Session ID','') as sid, lower(raw->>'Role') as role,
      coalesce(nullif(raw->>'User Email',''), nullif(raw->>'User Phone',''),
               nullif(raw->>'User Name',''),  nullif(raw->>'Session ID','')) as uid
    from public.chat_rows
    where dashboard_id = p_dashboard_id
      and (p_from is null or occurred_at >= p_from) and (p_to is null or occurred_at <= p_to)
  ),
  agg as (
    select count(distinct sid) total_chats,
      count(*) filter (where role='user') user_messages,
      count(distinct uid) unique_users,
      round((count(*) filter (where sid is not null))::numeric / nullif(count(distinct sid),0),1) avg_msgs,
      round(avg(ai_sentiment_score)::numeric,3) sentiment,
      count(distinct sid) filter (where escalation_sentiment is not null) escalations,
      count(distinct sid) filter (where escalation_sentiment='Positive') esc_pos,
      count(distinct sid) filter (where escalation_sentiment='Negative') esc_neg,
      count(distinct sid) filter (where escalation_sentiment='Unknown')  esc_unk,
      count(distinct sid) filter (where is_in_house) in_house_guests,
      count(distinct sid) filter (where has_booking_link) booking_links_shared
    from r
  ),
  resp as (
    select round(avg(d)::numeric,1) as avg_response_time
    from (select extract(epoch from (occurred_at - lag(occurred_at) over w)) d, role, lag(role) over w prev_role
          from r where occurred_at is not null and sid is not null
          window w as (partition by sid order by occurred_at, source_row_index)) x
    where prev_role='user' and role='assistant' and d between 0 and 600
  ),
  vol as (
    select coalesce(jsonb_agg(jsonb_build_object('x',d,'y',c) order by d),'[]'::jsonb) v
    from (select (occurred_at at time zone 'UTC')::date d, count(distinct sid) c
          from r where occurred_at is not null and sid is not null group by 1) s
  ),
  intent as (
    select coalesce(jsonb_agg(jsonb_build_object('label',ai_intent,'value',c,
             'pct',round((c::numeric/nullif(tot,0))*100,1)) order by c desc, mn),'[]'::jsonb) v
    from (select ai_intent, count(*) c, min(source_row_index) mn, sum(count(*)) over () tot
          from r where nullif(ai_intent,'') is not null group by ai_intent) x
  ),
  topics as (
    select coalesce(jsonb_agg(jsonb_build_object('label',topic,'weight',c) order by c desc, mn),'[]'::jsonb) v
    from (select topic, count(*) c, min(source_row_index) mn
          from r cross join lateral jsonb_array_elements_text(r.ai_topics) topic
          where jsonb_typeof(r.ai_topics)='array'
          group by topic order by count(*) desc, min(source_row_index) limit 40) t
  ),
  langs as (
    select coalesce(jsonb_agg(jsonb_build_object('label',lang,'value',c) order by c desc, mn),'[]'::jsonb) v
    from (select detected_language lang, count(distinct sid) c, min(source_row_index) mn
          from r where detected_language is not null and sid is not null group by 1) x
  ),
  countries as (
    select coalesce(jsonb_agg(jsonb_build_object('country',cc,'value',c) order by c desc, mn),'[]'::jsonb) pts,
           coalesce(sum(c),0) total
    from (select country cc, count(distinct sid) c, min(source_row_index) mn
          from r where country is not null and sid is not null group by 1) x
  ),
  faq as (
    select coalesce(jsonb_agg(jsonb_build_object('Question',disp,'Conversations',c) order by c desc, mn),'[]'::jsonb) v
    from (
      select faq_question,
             upper(left(faq_question,1)) || substr(faq_question,2)
               || case when right(faq_question,1) in ('?','؟') then '' else '?' end as disp,
             count(distinct coalesce(sid, id::text)) c, min(source_row_index) mn
      from r where faq_question is not null
      group by faq_question order by count(distinct coalesce(sid, id::text)) desc, min(source_row_index) limit 20
    ) x
  )
  select jsonb_build_object(
    'total_chats',total_chats,'user_messages',user_messages,'unique_users',unique_users,
    'avg_messages_per_chat',avg_msgs,'sentiment_avg',sentiment,'avg_response_time',coalesce(resp.avg_response_time,0),
    'escalations',escalations,'escalated_positive',esc_pos,'escalated_negative',esc_neg,'escalated_neutral',esc_unk,
    'in_house_guests',in_house_guests,'booking_links_shared',booking_links_shared,
    'volume_sessions_by_day',vol.v,'intent',intent.v,'topics',topics.v,
    'languages',langs.v,'countries',jsonb_build_object('points',countries.pts,'total',countries.total),'faq',faq.v
  ) from agg, resp, vol, intent, topics, langs, countries, faq;
$$;
grant execute on function public.convo_core_aggregates(uuid, timestamptz, timestamptz) to service_role, anon, authenticated;

-- ── 4. Long-tail helpers ────────────────────────────────────────────────────
-- Generic raw-field group-by (role_pie / language_pie / channel_bar / country_bar).
create or replace function public.convo_field_breakdown(
  p_dashboard_id uuid, p_field text, p_from timestamptz default null, p_to timestamptz default null
) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('label', v, 'value', c) order by c desc, v), '[]'::jsonb)
  from (select raw->>p_field as v, count(*) c
        from public.chat_rows
        where dashboard_id = p_dashboard_id and nullif(raw->>p_field,'') is not null
          and (p_from is null or occurred_at >= p_from) and (p_to is null or occurred_at <= p_to)
        group by 1) x;
$$;
grant execute on function public.convo_field_breakdown(uuid, text, timestamptz, timestamptz) to service_role, anon, authenticated;

-- keyword_count metric.
create or replace function public.convo_keyword_count(
  p_dashboard_id uuid, p_keywords text[], p_content_field text default 'Content',
  p_from timestamptz default null, p_to timestamptz default null
) returns integer language sql stable as $$
  select count(*)::int from public.chat_rows
  where dashboard_id = p_dashboard_id
    and (p_from is null or occurred_at >= p_from) and (p_to is null or occurred_at <= p_to)
    and exists (select 1 from unnest(p_keywords) kw
                where lower(coalesce(raw->>p_content_field,'')) like '%' || lower(kw) || '%');
$$;
grant execute on function public.convo_keyword_count(uuid, text[], text, timestamptz, timestamptz) to service_role, anon, authenticated;

-- windowed row count (chat_count metric).
create or replace function public.convo_row_count(
  p_dashboard_id uuid, p_from timestamptz default null, p_to timestamptz default null
) returns integer language sql stable as $$
  select count(*)::int from public.chat_rows
  where dashboard_id = p_dashboard_id
    and (p_from is null or occurred_at >= p_from) and (p_to is null or occurred_at <= p_to);
$$;
grant execute on function public.convo_row_count(uuid, timestamptz, timestamptz) to service_role, anon, authenticated;

-- all rows of given sessions (sync recomputes their flags when new messages arrive).
create or replace function public.convo_session_rows(
  p_dashboard_id uuid, p_session_ids text[]
) returns setof public.chat_rows language sql stable as $$
  select * from public.chat_rows
  where dashboard_id = p_dashboard_id and (raw->>'Session ID') = any(p_session_ids);
$$;
grant execute on function public.convo_session_rows(uuid, text[]) to service_role;
