-- Adds the two AI-pipeline bookkeeping columns the Python ORM model has
-- expected since day one but that drifted out of the live schema:
--   * ai_retry_count — how many times AI processing has been attempted
--     for this row (so we can stop after N failures instead of looping)
--   * ai_error       — last failure message captured by services/ai.py
--
-- Without these the PostgREST schema cache rejects every sheets-sync
-- upsert with PGRST204 "Could not find the 'ai_error' column", which is
-- why the scheduler's sheets/30s job has been silently no-op'ing.
--
-- Apply via the Supabase MCP `apply_migration` tool, NOT psql.

ALTER TABLE chat_rows
  ADD COLUMN IF NOT EXISTS ai_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_error       text;

-- Force PostgREST to re-introspect the table so the column appears in
-- the schema cache immediately (otherwise the very next sync still
-- 404s for a few seconds).
NOTIFY pgrst, 'reload schema';
