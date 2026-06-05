# Convo AI

SaaS dashboard for clients (Nest, Rove, etc.) that pulls chat logs from Google
Sheets + GA4 analytics, runs Claude over the chats for sentiment / topics /
intent, and renders a private shareable dashboard per client at a tokenised URL.

Source spec: `../SPEC.md`. Meeting context: `../haseeb meeting with mohsin may 15/`.

## Current state — "DB later" build

Per Haseeb's 2026-05-18 note ("for now we can add data base later and do rest
of work"), this scaffold defers Postgres + SQLAlchemy + Alembic. The data layer
lives in `backend/app/store.py` as an in-memory dict that mirrors the table
shapes from SPEC §5. When DB work resumes, swap `store.py` for SQLAlchemy
sessions; nothing else has to change.

What's wired up:

- FastAPI app with every router from SPEC §11 (admin clients, dashboards, GA4,
  public)
- Field aggregation for every type in SPEC §7 (`metric`, `gauge`, `line`,
  `bar`, `pie`, `tag_cloud`, `table`)
- Mock AI service — deterministic fake sentiment / topics / intent so the
  pipeline runs end-to-end without an `ANTHROPIC_API_KEY`
- Mock Sheets + GA4 fetchers seeded with Nest Hotel demo data (chat rows,
  GA4 metrics, language mix, country distribution)
- React public dashboard at `/d/:shareToken` rendering all field types,
  polling `/data?since=...` every 30s
- Admin panel: client list, client detail, dashboard config (JSON editor for
  field_config + column map, manual sync button, sync log viewer)

What's deferred:

- Real Google Sheets API + GA4 Data API integrations
- Real Anthropic API calls (set `ANTHROPIC_API_KEY` and flip
  `USE_MOCK_AI=false` to enable — code path is implemented but untested
  against the live API)
- Postgres, Alembic, encrypted GA4 credentials, rate-limiting
- Deployment (`render.yaml` / Vercel) — Phase 5

## Run it

PowerShell, two terminals:

```powershell
# backend
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
copy .env.example .env
uvicorn app.main:app --reload --port 8000
```

```powershell
# frontend
cd frontend
pnpm install
copy .env.example .env
pnpm dev
```

Frontend: http://localhost:5173. Backend: http://localhost:8000.

The seed runs on backend startup and prints one demo share token like:

```
[seed] Nest Hotel share link: http://localhost:5173/d/<token>
[seed] Admin token: dev-admin-token-change-me
```

Open the share link to see the public dashboard.

## Repo layout

```
convo-ai/
├── backend/                  FastAPI + in-memory store
│   ├── app/
│   │   ├── main.py
│   │   ├── config.py
│   │   ├── store.py          ← replaces models/ + database.py for now
│   │   ├── auth.py
│   │   ├── scheduler.py
│   │   ├── routers/
│   │   ├── services/
│   │   └── schemas/
│   └── tests/
├── frontend/                 Vite + React + TS + Tailwind
│   └── src/
│       ├── pages/
│       ├── components/
│       └── lib/
└── QUESTIONS.md              Open questions for Mohsin (SPEC §17)
```
