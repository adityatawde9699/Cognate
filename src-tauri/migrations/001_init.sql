CREATE TABLE IF NOT EXISTS tasks (
    id               TEXT    PRIMARY KEY,
    title            TEXT    NOT NULL,
    description      TEXT    DEFAULT '',
    tags             TEXT    DEFAULT '[]',
    deadline         TEXT    DEFAULT '',
    importance       INTEGER DEFAULT 3,
    effort           INTEGER DEFAULT 3,
    done             INTEGER DEFAULT 0,
    created_at       TEXT    NOT NULL,
    completed_at     TEXT    DEFAULT NULL,
    pomodoros_spent  INTEGER DEFAULT 0,
    priority         TEXT    DEFAULT 'medium',
    sort_order       INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
