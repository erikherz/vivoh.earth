-- Scheduled events: a broadcast that exists before anyone goes live.
--
-- The ad hoc path is unchanged — press Broadcast, get a stream id, go live. This adds the
-- other half of a virtual-events product: an event with a name, a time and a link you can put
-- in a calendar invite weeks ahead. The link works from the moment the event is created,
-- which is the whole reason migration 0020 had to land first: a scheduled stream needs its
-- key to exist before its first broadcast.
--
-- PRIVACY NOTE, stated because it is a real change and not an oversight: `title` and
-- `description` are stored in plaintext and are readable by this operator. They have to be —
-- the waiting room shows them to a viewer who has not yet been handed anything, and a
-- calendar invite is not a confidential document. Media is still encrypted; the event's NAME
-- is not. A broadcaster who does not want us to know what the meeting is called should name
-- it something else.
CREATE TABLE IF NOT EXISTS scheduled_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  -- The broadcast name this event will go live under. Reserved at creation so the link in the
  -- invite is the link that works on the day.
  stream_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  -- ISO-8601 UTC, always. The broadcaster's zone is kept alongside for display and for
  -- recurrence, but every comparison in the Worker is done in UTC so a DST boundary cannot
  -- silently move an event.
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  -- IANA zone the broadcaster chose, e.g. "Asia/Manila". Display and recurrence only.
  timezone TEXT NOT NULL DEFAULT 'UTC',
  -- NULL | 'daily' | 'weekly' | 'monthly'. Deliberately not RRULE: three options cover the
  -- standing town hall, and a half-implemented RRULE parser is worse than no recurrence.
  recurrence TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  -- Set rather than deleted, so a viewer holding the invite is told it was cancelled instead
  -- of meeting a blank page.
  canceled_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- The waiting room's lookup: given a stream id, is there an event, and when is it?
CREATE INDEX IF NOT EXISTS idx_scheduled_events_stream ON scheduled_events(stream_id);

-- The broadcaster's own list, newest-upcoming first.
CREATE INDEX IF NOT EXISTS idx_scheduled_events_user_start ON scheduled_events(user_id, starts_at);
