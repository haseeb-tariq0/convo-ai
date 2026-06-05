-- Per-client AI provider credentials. Mirrors `ga4_integrations` so admins
-- have a familiar mental model: one row per client, one provider per row,
-- secret stored encrypted-at-rest (Fernet via services/encryption.py).
--
-- Why per-CLIENT not per-dashboard:
--   One client = one billing relationship. All of a client's dashboards
--   share the same chat sources in practice (same hotel brand, same Sheet,
--   same OpenAI/Anthropic invoice). Per-dashboard would multiply the data
--   model 3-5× for no observed real-world need.
--
-- Apply via the Supabase MCP `apply_migration` tool, NOT psql.

CREATE TABLE IF NOT EXISTS ai_integrations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL UNIQUE
                        REFERENCES clients(id) ON DELETE CASCADE,
  -- Provider key: 'openai' | 'claude' (string column on purpose — keeps
  -- it forward-compatible if we add more without an ALTER TYPE).
  provider            text NOT NULL,
  -- Fernet ciphertext of the raw API key. NEVER store plaintext.
  api_key_encrypted   text NOT NULL,
  -- Optional model override; NULL means "use platform default for provider".
  model               text,
  is_active           boolean NOT NULL DEFAULT true,
  last_used_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Reuse the updated_at trigger function from 0001_initial.
CREATE TRIGGER ai_integrations_set_updated_at
  BEFORE UPDATE ON ai_integrations
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

-- Service-role-only access (matches ga4_integrations). The public dashboard
-- never reads this table; admin endpoints use the service-role JWT.
ALTER TABLE ai_integrations ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
