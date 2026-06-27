-- Phase 3 (deferred): milestones, custom fields, and templates.

ALTER TABLE tasks ADD COLUMN milestone_id  TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN custom_fields TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS milestones (
    id          TEXT    PRIMARY KEY,
    project_id  TEXT    DEFAULT NULL,
    name        TEXT    NOT NULL,
    due         TEXT    DEFAULT '',
    created_at  TEXT    NOT NULL,
    sort_order  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS templates (
    id          TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL,
    data        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
);
