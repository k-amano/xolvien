"""add test_type to test_case_items

Revision ID: a1b2c3d4e5f6
Revises: 36b358383232
Create Date: 2026-04-28 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'a1b2c3d4e5f6'
down_revision = '36b358383232'
branch_labels = None
depends_on = None

testtype_tci = sa.Enum('UNIT', 'INTEGRATION', 'E2E', name='testtype_tci')


def upgrade() -> None:
    testtype_tci.create(op.get_bind(), checkfirst=True)
    op.add_column(
        'test_case_items',
        sa.Column(
            'test_type',
            testtype_tci,
            nullable=False,
            server_default='UNIT',
        )
    )


def downgrade() -> None:
    op.drop_column('test_case_items', 'test_type')
    testtype_tci.drop(op.get_bind(), checkfirst=True)
