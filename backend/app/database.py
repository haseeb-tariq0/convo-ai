from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import StaticPool

from .config import get_settings

settings = get_settings()

# We use the DATABASE_URL from env.
# For SQLite (tests/offline), we might need special flags, but SPEC says Postgres.
engine = create_engine(
    settings.database_url,
    # StaticPool is used for SQLite in-memory, but for Postgres we'll use default.
    # poolclass=StaticPool if settings.database_url.startswith("sqlite") else None,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
