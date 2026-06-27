-- 005: The Planner Engine (Act 1).
-- Scheduling attributes on tasks + a calendar_events table for busy times.
-- Work hours live in app_state settings (work_start_min / work_end_min).

ALTER TABLE tasks ADD COLUMN duration_min     INTEGER DEFAULT 0;     -- estimated minutes (0 = derive from effort)
ALTER TABLE tasks ADD COLUMN scheduled_start  TEXT    DEFAULT NULL;  -- ISO datetime the planner assigned
ALTER TABLE tasks ADD COLUMN scheduled_end    TEXT    DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN energy           TEXT    DEFAULT 'med'; -- 'hi' | 'med' | 'lo'
ALTER TABLE tasks ADD COLUMN pinned           INTEGER DEFAULT 0;     -- 1 = keep scheduled_start fixed across re-plans
ALTER TABLE tasks ADD COLUMN min_block        INTEGER DEFAULT 0;     -- minimum contiguous minutes (0 = unset)
ALTER TABLE tasks ADD COLUMN max_block        INTEGER DEFAULT 0;     -- maximum contiguous minutes (0 = unset)

-- Busy times the scheduler must route around (from .ics / Google / manual entry).
CREATE TABLE IF NOT EXISTS calendar_events (
    id          TEXT PRIMARY KEY,
    title       TEXT DEFAULT '',
    start       TEXT NOT NULL,            -- ISO datetime
    end         TEXT NOT NULL,            -- ISO datetime
    source      TEXT DEFAULT 'manual',    -- 'ics' | 'google' | 'outlook' | 'manual'
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events (start);
