-- 0004_bulk_mark_chat_rows_processed_rpc.sql
-- Bulk-update RPC for the AI processor. PostgREST upsert with a sparse
-- payload trips NOT NULL on dashboard_id (the INSERT row is evaluated
-- before ON CONFLICT). A SECURITY DEFINER function around a single UPDATE
-- ... FROM jsonb_to_recordset() does what we want in one round-trip.
--
-- Called from app/store.py::bulk_mark_chat_rows_processed.

create or replace function public.mark_chat_rows_processed(updates jsonb)
returns int
language plpgsql
security definer
as $$
declare
  affected int;
begin
  update public.chat_rows c
  set ai_sentiment       = u.ai_sentiment,
      ai_sentiment_score = u.ai_sentiment_score,
      ai_topics          = u.ai_topics,
      ai_intent          = u.ai_intent,
      ai_processed_at    = u.ai_processed_at
  from jsonb_to_recordset(updates) as u(
    id uuid,
    ai_sentiment text,
    ai_sentiment_score double precision,
    ai_topics jsonb,
    ai_intent text,
    ai_processed_at timestamptz
  )
  where c.id = u.id;
  get diagnostics affected = row_count;
  return affected;
end $$;

-- The service-role key bypasses RLS, but the function still needs grant.
grant execute on function public.mark_chat_rows_processed(jsonb) to service_role;
