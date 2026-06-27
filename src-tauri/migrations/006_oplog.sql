-- Act 2 — The Sync Spine: the CRDT operation log.
-- Append-only source of truth; the tasks table becomes a projection of this.
CREATE TABLE IF NOT EXISTS oplog (
    id      TEXT PRIMARY KEY,   -- content-addressed op id (dedupes on merge)
    wall    INTEGER NOT NULL,   -- HLC physical time (ms)
    counter INTEGER NOT NULL,   -- HLC tiebreak counter
    actor   TEXT NOT NULL,      -- originating device/install id
    kind    TEXT NOT NULL,      -- 'set' | 'del'
    entity  TEXT NOT NULL,      -- target id (a task id)
    field   TEXT,               -- field name for 'set' ops
    value   TEXT                -- JSON-encoded value for 'set' ops
);
CREATE INDEX IF NOT EXISTS idx_oplog_order  ON oplog(wall, counter, actor);
CREATE INDEX IF NOT EXISTS idx_oplog_entity ON oplog(entity);
