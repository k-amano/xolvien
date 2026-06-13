"""remove_failed_stopped_from_taskstatus

Revision ID: e74383bc60a3
Revises: a1b2c3d4e5f6
Create Date: 2026-06-13 16:51:14.503961

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e74383bc60a3'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Move any lingering failed/stopped tasks to idle before altering the enum
    op.execute("UPDATE tasks SET status = 'IDLE' WHERE status IN ('FAILED', 'STOPPED')")

    op.execute("ALTER TYPE taskstatus RENAME TO taskstatus_old")
    op.execute("CREATE TYPE taskstatus AS ENUM ('PENDING', 'INITIALIZING', 'IDLE', 'RUNNING', 'TESTING', 'COMPLETED')")
    op.execute("ALTER TABLE tasks ALTER COLUMN status TYPE taskstatus USING status::text::taskstatus")
    op.execute("DROP TYPE taskstatus_old")


def downgrade() -> None:
    op.execute("ALTER TYPE taskstatus RENAME TO taskstatus_old")
    op.execute("CREATE TYPE taskstatus AS ENUM ('PENDING', 'INITIALIZING', 'IDLE', 'RUNNING', 'TESTING', 'COMPLETED', 'FAILED', 'STOPPED')")
    op.execute("ALTER TABLE tasks ALTER COLUMN status TYPE taskstatus USING status::text::taskstatus")
    op.execute("DROP TYPE taskstatus_old")
