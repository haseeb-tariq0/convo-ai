-- Admin user management. Replaces the static ADMIN_EMAILS env-var
-- allowlist with a DB-backed table + roles + magic-link invites +
-- per-action audit trail.
--
-- Two tables:
--   admin_users      — who's allowed to sign in, with role + status
--   admin_audit_log  — what each admin did, when, against which target
--
-- The env var stays a bootstrap fallback: if admin_users is empty when
-- the auth helper runs (fresh install, no rows yet), it falls back to
-- the env list so we don't lock ourselves out. Once any row is in the
-- table, only the table matters.
--
-- Apply via the Supabase MCP `apply_migration` tool, NOT psql.

-- ─── admin_users ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lowercased before storage. Lookup is always lower(email).
  email                text NOT NULL UNIQUE,
  -- 'super_admin' | 'admin'. Kept as text (not enum) so adding a future
  -- role (e.g. 'viewer') doesn't need ALTER TYPE.
  role                 text NOT NULL DEFAULT 'admin',
  -- Linked once the user first signs in via Google. No FK to auth.users
  -- on purpose: cross-schema FKs across Supabase's auth schema are
  -- brittle and Supabase docs explicitly discourage them. We sync this
  -- column from the auth helper instead.
  supabase_user_id     uuid,
  invited_by_email     text,
  invited_at           timestamptz NOT NULL DEFAULT now(),
  -- Mirrored from auth.users.last_sign_in_at on every verified call.
  -- NULL means "invited but never signed in" — surfaces as "pending"
  -- in the admin UI.
  last_signed_in_at    timestamptz,
  -- Soft delete. Keeps audit-log foreign references stable.
  is_active            boolean NOT NULL DEFAULT true,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER admin_users_set_updated_at
  BEFORE UPDATE ON admin_users
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

CREATE INDEX IF NOT EXISTS admin_users_role_idx
  ON admin_users (role) WHERE is_active = true;

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

-- ─── admin_audit_log ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Snapshotted at write time (text, not FK) so soft-deleting an admin
  -- doesn't lose their history. Set to '(token)' for legacy
  -- ADMIN_TOKEN bearer-token requests (CLI / CI).
  actor_email   text NOT NULL,
  actor_role    text,
  -- Dot-namespaced action name. Examples:
  --   client.create / client.update / client.delete
  --   dashboard.create / dashboard.delete / dashboard.sync / dashboard.rotate_token
  --   ga4.upsert / ga4.delete / ga4.sync
  --   ai.upsert / ai.delete
  --   admin.invite / admin.role_change / admin.remove / admin.signout
  action        text NOT NULL,
  target_type   text,
  target_id     text,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_log_occurred_at_idx
  ON admin_audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_log_actor_idx
  ON admin_audit_log (actor_email, occurred_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_log_action_idx
  ON admin_audit_log (action, occurred_at DESC);

ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

-- ─── Bootstrap: seed the current env allowlist as super_admins ───────
-- One-shot insert from the known existing admin emails. After this
-- migration, the env var becomes a fallback only for fresh installs.
-- Idempotent — ON CONFLICT skips if the row already exists (e.g. if
-- the migration is re-run).
INSERT INTO admin_users (email, role, invited_by_email, notes)
VALUES
  ('webteam@digitalnexa.com', 'super_admin', 'bootstrap', 'Seeded from ADMIN_EMAILS during 0010 migration.'),
  ('haseeb.t@digitalnexa.com', 'super_admin', 'bootstrap', 'Seeded from auth.users (first real sign-in).')
ON CONFLICT (email) DO NOTHING;

NOTIFY pgrst, 'reload schema';
