# Linux / macOS / WSL targets. On native Windows PowerShell, see README for
# the equivalent commands.

.PHONY: backend frontend db migrate seed test

backend:
	cd backend && uvicorn app.main:app --reload --port 8000

frontend:
	cd frontend && pnpm dev

db:
	docker compose up -d postgres

migrate:
	cd backend && .venv/Scripts/alembic upgrade head

seed:
	@echo "Seed runs on backend startup. Restart uvicorn to re-seed."

test:
	cd backend && pytest -q
