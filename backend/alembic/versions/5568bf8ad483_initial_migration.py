"""initial migration

Revision ID: 5568bf8ad483
Revises: 
Create Date: 2026-05-26 12:12:29.250304

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '5568bf8ad483'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Clients
    op.create_table(
        'clients',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('contact_email', sa.Text(), nullable=True),
        sa.Column('is_active', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id')
    )

    # Dashboards
    op.create_table(
        'dashboards',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('client_id', sa.UUID(), nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('share_token', sa.Text(), nullable=False),
        sa.Column('sheet_id', sa.Text(), nullable=True),
        sa.Column('sheet_tab_name', sa.Text(), server_default='Sheet1', nullable=False),
        sa.Column('sheet_column_map', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False),
        sa.Column('field_config', postgresql.JSONB(astext_type=sa.Text()), server_default='[]', nullable=False),
        sa.Column('poll_interval_seconds', sa.Integer(), server_default='30', nullable=False),
        sa.Column('is_active', sa.Boolean(), server_default='true', nullable=False),
        # Branding (from 0006)
        sa.Column('brand_name', sa.Text(), nullable=True),
        sa.Column('brand_logo_url', sa.Text(), nullable=True),
        sa.Column('brand_primary_color', sa.Text(), nullable=True),
        sa.Column('brand_accent_color', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['client_id'], ['clients.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('share_token')
    )
    op.create_index('dashboards_client_id_idx', 'dashboards', ['client_id'])
    op.create_index('dashboards_share_token_idx', 'dashboards', ['share_token'])

    # GA4 Integrations
    op.create_table(
        'ga4_integrations',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('client_id', sa.UUID(), nullable=False),
        sa.Column('property_id', sa.Text(), nullable=False),
        sa.Column('credentials_json', sa.Text(), nullable=False),
        sa.Column('conversion_event_name', sa.Text(), server_default='purchase', nullable=False),
        sa.Column('lookback_days', sa.Integer(), server_default='30', nullable=False),
        sa.Column('sync_users', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('sync_pageviews', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('sync_events', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('sync_conversions', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('sync_traffic_sources', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('sync_devices', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('last_synced_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['client_id'], ['clients.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('client_id')
    )

    # Chat Rows
    op.create_table(
        'chat_rows',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('dashboard_id', sa.UUID(), nullable=False),
        sa.Column('source_row_index', sa.Integer(), nullable=False),
        sa.Column('raw', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('ai_sentiment', sa.Text(), nullable=True),
        sa.Column('ai_sentiment_score', sa.Float(), nullable=True),
        sa.Column('ai_topics', postgresql.JSONB(astext_type=sa.Text()), server_default='[]', nullable=False),
        sa.Column('ai_intent', sa.Text(), nullable=True),
        sa.Column('ai_processed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('occurred_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['dashboard_id'], ['dashboards.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('dashboard_id', 'source_row_index')
    )
    op.create_index('chat_rows_dashboard_time_idx', 'chat_rows', ['dashboard_id', sa.text('occurred_at DESC')])
    op.create_index('chat_rows_unprocessed_idx', 'chat_rows', ['dashboard_id'], postgresql_where=sa.text('ai_processed_at IS NULL'))

    # GA4 Snapshots
    op.create_table(
        'ga4_snapshots',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('ga4_integration_id', sa.UUID(), nullable=False),
        sa.Column('metric_type', sa.Text(), nullable=False),
        sa.Column('date', sa.Date(), nullable=False),
        sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(['ga4_integration_id'], ['ga4_integrations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('ga4_integration_id', 'metric_type', 'date')
    )
    op.create_index('ga4_snapshots_integration_date_idx', 'ga4_snapshots', ['ga4_integration_id', sa.text('date DESC')])

    # Sync Logs
    op.create_table(
        'sync_logs',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('dashboard_id', sa.UUID(), nullable=True),
        sa.Column('ga4_integration_id', sa.UUID(), nullable=True),
        sa.Column('source', sa.Text(), nullable=False),
        sa.Column('status', sa.Text(), nullable=False),
        sa.Column('message', sa.Text(), server_default='', nullable=False),
        sa.Column('rows_processed', sa.Integer(), nullable=True),
        sa.Column('duration_ms', sa.Integer(), nullable=True),
        sa.Column('occurred_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['dashboard_id'], ['dashboards.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['ga4_integration_id'], ['ga4_integrations.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('sync_logs_dashboard_time_idx', 'sync_logs', ['dashboard_id', sa.text('occurred_at DESC')])
    op.create_index('sync_logs_time_idx', 'sync_logs', [sa.text('occurred_at DESC')])


def downgrade() -> None:
    op.drop_table('sync_logs')
    op.drop_table('ga4_snapshots')
    op.drop_table('chat_rows')
    op.drop_table('ga4_integrations')
    op.drop_table('dashboards')
    op.drop_table('clients')
