-- Phase 3: projects, recurrence, and subtask hierarchy.

ALTER TABLE tasks ADD COLUMN project_id TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN parent_id  TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'none';

CREATE TABLE IF NOT EXISTS projects (
    id          TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL,
    color       TEXT    DEFAULT '',
    created_at  TEXT    NOT NULL,
    sort_order  INTEGER DEFAULT 0
);
