-- 004: Soft-delete (Trash) support.
-- Tasks are never hard-deleted by the UI; they are stamped with deleted_at and
-- swept out of every live query. This both gives us a recoverable Trash and
-- seeds the inverse-op / op-log mental model the sync spine (Act 2) builds on.
ALTER TABLE tasks ADD COLUMN deleted_at TEXT DEFAULT NULL;

-- Live reads filter on deleted_at constantly; index keeps them cheap.
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON tasks (deleted_at);
