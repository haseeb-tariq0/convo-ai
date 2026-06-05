# Admin auth — Supabase Auth + Google OAuth

The Convo AI admin panel supports two sign-in paths:

| Path | Who uses it | Where the secret lives |
|---|---|---|
| **Sign in with Google** | Browser admin users (you, teammates) | Nowhere on your machine — Supabase holds the session |
| **Admin token (Bearer)** | CLI / CI / curl scripts | `backend/.env` → `ADMIN_TOKEN` |

The browser flow is the **primary** way to sign in. The Bearer token is kept
around so existing automation doesn't break — it's hidden behind a small
"Sign in with admin token instead" disclosure on the login page.

---

## One-time setup (Supabase dashboard + Google Cloud Console)

You need to do this ONCE per Supabase project. After this, anyone in your
`ADMIN_EMAILS` allowlist can sign in.

### 1. Create a Google OAuth Client

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Click **Create credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Name: `Convo AI Admin` (or whatever you like).
5. **Authorized redirect URIs** — add this exact URL:
   ```
   https://wwpkjayzddjzrvewakue.supabase.co/auth/v1/callback
   ```
   (replace the project ref if you're using a different Supabase project)
6. Click **Create**. Google shows a modal with **Client ID** + **Client secret** —
   keep this open, you'll paste both into Supabase next.

### 2. Enable Google in Supabase

1. Open the Supabase dashboard for your project: <https://supabase.com/dashboard/project/wwpkjayzddjzrvewakue>.
2. Navigate to **Authentication → Providers**.
3. Find **Google** in the list, click to expand.
4. Toggle **Enable Google provider** on.
5. Paste:
   - **Client ID** (from the Google modal in step 1)
   - **Client secret** (from the Google modal in step 1)
6. Leave **Skip nonce check** off and **Authorized Client IDs** empty unless you
   know you need them.
7. Click **Save**.

### 3. Configure redirect URLs in Supabase

In **Authentication → URL Configuration**:

- **Site URL** — `http://localhost:5173` (dev) or your prod origin
- **Redirect URLs** (add each one):
  - `http://localhost:5173`
  - `http://localhost:5173/admin`
  - `http://localhost:5173/login`
  - Your production origin + `/admin` and `/login`

If any of these are missing, the post-OAuth redirect will land on a Supabase
error page instead of `/admin`.

### 4. Set the allowlist in `backend/.env`

```env
ADMIN_EMAILS=webteam@digitalnexa.com,other@digitalnexa.com
```

Anyone who completes the OAuth dance with an email outside this list gets
**HTTP 403** with the message:

```
{your-email} is not authorized for admin access. Ask an existing admin to
add you to ADMIN_EMAILS.
```

Restart the backend after changing the allowlist.

---

## How the runtime flow works

```
┌─ Browser ──────────────────────────────────────────────────────────┐
│                                                                    │
│  /login  → "Sign in with Google" button                            │
│             │                                                      │
│             ▼  supabase.auth.signInWithOAuth({provider:'google'})  │
│                                                                    │
│  Browser redirects to: accounts.google.com/o/oauth2/auth?...       │
│  User picks their Nexa Google account                              │
│                                                                    │
│  Google redirects to: {supabase-url}/auth/v1/callback?code=...     │
│  Supabase exchanges the code for an ID token                       │
│  Supabase issues its OWN JWT for the user                          │
│                                                                    │
│  Final redirect back to: http://localhost:5173/admin#access_token= │
│  Supabase JS SDK parses the fragment, persists the session in      │
│  localStorage, calls onAuthStateChange('SIGNED_IN')                │
│                                                                    │
│  Every subsequent admin API call:                                  │
│    Authorization: Bearer <supabase-jwt>                            │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─ Backend (FastAPI) ────────────────────────────────────────────────┐
│                                                                    │
│  require_admin dependency:                                         │
│    1. Try Bearer == ADMIN_TOKEN  → allow as {kind:'token'}         │
│    2. Else hit Supabase /auth/v1/user with the JWT                 │
│       → if 200, extract email                                      │
│       → if email in ADMIN_EMAILS → allow as {kind:'user', email}   │
│       → else 403 with explanatory message                          │
│    3. Else 401                                                     │
│                                                                    │
│  Verified user objects cached in memory for 60 seconds so a busy   │
│  admin session doesn't hammer Supabase's /auth/v1/user endpoint.   │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## Rotating / revoking admin access

- **Add an admin**: append their email to `ADMIN_EMAILS` in `backend/.env` and
  restart the backend. They can then sign in via Google (no per-user setup —
  Supabase issues them a JWT on first sign-in).
- **Remove an admin**: drop their email from `ADMIN_EMAILS` and restart. Their
  existing browser session keeps working until the JWT cache expires
  (≤60 seconds), then every API call returns 403.
- **Rotate the legacy token**: change `ADMIN_TOKEN` in `backend/.env`, restart.
  Anyone using the old token (CLI scripts) needs the new value.
- **Lock everyone out fast**: in the Supabase dashboard, **Authentication →
  Providers → Google → Disable**. Existing tokens become unverifiable
  immediately.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `redirect_uri_mismatch` on the Google consent screen | Forgot to add the Supabase callback URL in step 1.5 |
| Post-OAuth lands on a Supabase error page, not `/admin` | Missing entry in **Redirect URLs** (step 3) |
| `403 you@domain is not authorized` | Email not in `ADMIN_EMAILS`; or the env var wasn't reloaded after editing |
| Sign-in works but every API call returns 401 | `SUPABASE_ANON_KEY` not set in backend `.env` |
| Login button does nothing | Check the browser console — usually `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` is missing in frontend `.env` |
