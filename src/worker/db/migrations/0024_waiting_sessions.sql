-- Tell a waiting audience apart from a watching one.
--
-- Until now a viewing session was opened only once the route resolved and the player had
-- something to play, so somebody sitting on the standby page behind a lowered curtain was
-- counted as nobody at all. A host with forty people already waiting saw "0 watching", which
-- is the least useful moment to be told nothing — it is exactly when you are deciding whether
-- to start.
--
-- WHY A COLUMN AND NOT AN INFERENCE. The broadcaster's page could work this out for itself: it
-- knows whether it is live and whether its own curtain is up, so "not live yet" would have
-- implied "everyone is waiting" with no schema change at all. That reading is right almost
-- always and wrong exactly when it matters — in the seconds after the curtain lifts, when some
-- viewers have switched over and some have not, which is the one moment a host is watching
-- this number. It would also have quietly redefined what `watch_events` MEANS: a row that
-- never watched a frame would have been indistinguishable from one that watched an hour, and
-- the audience page reads this table.
--
-- 'watching' is the default so every existing row keeps the meaning it was written with. A
-- session only ever moves waiting -> watching, never back: the reaper closes stale sessions,
-- and a viewer whose stream drops out opens a new one rather than reverting this.
ALTER TABLE watch_events ADD COLUMN state TEXT NOT NULL DEFAULT 'watching';

-- The badge asks "how many of each, on this stream, right now" every five seconds while a
-- broadcast runs. `ended_at` leads because open sessions are the small minority of the table.
CREATE INDEX IF NOT EXISTS idx_watch_state ON watch_events(stream_id, ended_at, state);
