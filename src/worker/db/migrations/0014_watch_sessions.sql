-- Turn watch_events from a presence ping into a measured session.
--
-- Before this, a row was opened on page load and closed only by a beforeunload handler.
-- beforeunload does not fire on iOS backgrounding, tab crashes, force-quit or network loss,
-- and nothing reaped the survivors, so rows accumulated with ended_at IS NULL forever. The
-- live-viewer badge counted those ghosts, and any duration computed from them was unbounded.
--
-- THE PRIVACY LINE, because it is the whole reason this table looks the way it does:
-- a row is a SESSION, never a person. Nothing here is stable across sessions — no IP, no
-- IP hash, no cookie, no fingerprint. Two rows cannot be shown to be the same human, on the
-- same stream or across streams, by us or by anyone who later holds this database. That is
-- deliberate and it is the constraint every future column has to clear: the moment one
-- stable per-viewer identifier lands here, this table stops being audience measurement and
-- becomes an audience register, which is exactly what a journalist's viewers cannot afford.
-- "How many and for how long" is answerable without it. "Which of these is the same person"
-- is not, and must stay unanswerable.

-- Heartbeat watermark. The client pings every 30s; the reaper closes anything silent for
-- 150s. Closing uses THIS value, not the reap time, so a crashed viewer is credited with
-- what we actually observed rather than with the reaper's latency.
ALTER TABLE watch_events ADD COLUMN last_seen_at TEXT;

-- SHA-256 of an opaque per-session token held only in the viewer's page memory.
--
-- Session ids are sequential integers, so the old unauthenticated end endpoint let anyone
-- POST /api/stats/watch/12345/end and close a session they had nothing to do with — walk the
-- range and you zero out every stream's audience. The token is the fix: you can only end,
-- or heartbeat, a session you opened.
--
-- The HASH is stored, never the token, so this column leaking does not let the holder forge
-- either call. It is per-session and never written to storage in the browser: reusing one
-- across streams, or persisting it, would rebuild precisely the cross-session identifier the
-- comment above forbids.
ALTER TABLE watch_events ADD COLUMN session_hash TEXT;

-- 'client' (a real pagehide/unload) or 'reaped' (heartbeat lapsed). Kept because the two
-- mean different things when reading a report: a wall of 'reaped' rows is a client bug or a
-- flaky network, not viewers who all left at once.
ALTER TABLE watch_events ADD COLUMN end_reason TEXT;

-- The reaper's scan: open sessions ordered by silence.
CREATE INDEX IF NOT EXISTS idx_watch_events_open
  ON watch_events(ended_at, last_seen_at);

-- Per-stream reporting: both the live count and the completed-session history.
CREATE INDEX IF NOT EXISTS idx_watch_events_stream_ended
  ON watch_events(stream_id, ended_at);
