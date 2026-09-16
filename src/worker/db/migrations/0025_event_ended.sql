-- The curtain gets a third position, and the event gets a last word.
--
-- Migration 0022 gave it two: down (the standby page) and up (watching). Two was not enough for
-- either of the things a host actually does at the end. Pausing mid-event and finishing an
-- event are different acts with different right answers on screen, and collapsing them would
-- have meant one of them showing the wrong page.
--
--   before  -> the standby page, counting down
--   up      -> watching
--   ended   -> the ended page, which the scheduler writes
--
-- LOWERING IS COOPERATIVE, AND THE UI SAYS SO. Dropping the curtain refuses new viewer tokens
-- outright — that half is absolute, enforced at /route like the lift. What it cannot do is
-- revoke a subscription somebody already holds: their relay token stays valid until it expires,
-- and a browser running our client stops because it polls and complies. This is exactly the
-- guarantee the kill switch makes, no weaker and no stronger, and the control is worded to
-- promise that rather than a sealed room.
--
-- `ended_at` is a timestamp and occurrence-scoped for the same reason `curtain_lifted_at` is: a
-- standing weekly town hall is ONE row, and ending last Thursday's occurrence must not leave
-- this Thursday's looking finished before it starts. Both go through occurrenceFor().
ALTER TABLE scheduled_events ADD COLUMN ended_at TEXT;

-- What the ended page says. Defaults are live text rather than columns — an event nobody styled
-- still gets a sentence — so NULL here means "use the default", not "show nothing".
ALTER TABLE scheduled_events ADD COLUMN ended_headline TEXT;
ALTER TABLE scheduled_events ADD COLUMN ended_message TEXT;

-- The phase lookup runs on the /route hot path and on every watching viewer's settings poll.
CREATE INDEX IF NOT EXISTS idx_scheduled_events_phase
  ON scheduled_events(stream_id, canceled_at, ended_at, curtain_lifted_at);
