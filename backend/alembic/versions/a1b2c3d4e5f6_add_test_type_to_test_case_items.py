"""add test_type to test_case_items

Revision ID: a1b2c3d4e5f6
Revises: 36b358383232
Create Date: 2026-04-28 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ENUM


# revision identifiers, used by Alembic.
revision = 'a1b2c3d4e5f6'
down_revision = '36b358383232'
branch_labels = None
depends_on = None

# Reuse the existing 'testtype' enum (already created for test_runs)
testtype = ENUM('unit', 'integration', 'e2e', name='testtype', create_type=False)


def upgrade() -> None:
    op.add_column(
        'test_case_items',
        sa.Column(
            'test_type',
            testtype,
            nullable=False,
            server_default='unit',
        )
    )


def downgrade() -> None:
    op.drop_column('test_case_items', 'test_type')
