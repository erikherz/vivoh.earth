-- The green room: a standby page the scheduler designs, and a curtain the broadcaster lifts.
--
-- Two halves of one idea. Until now a viewer who opened a scheduled link early saw a title, a
-- time and a countdown, and the moment the broadcaster's first frame reached the relay every
-- one of them was watching it. That is the wrong order for an event: a host wants to start
-- publishing, look at their own framing, get the deck on screen, and only THEN let people in.
--
-- So: `curtain_lifted_at` separates "I am live" from "the audience may watch", and the standby
-- columns give the scheduler something worth looking at in the meantime.
--
-- The curtain is a REAL gate, not a screen. /api/streams/:id/route refuses to mint a viewer
-- token while it is down, so a viewer who skips our page and drives the relay directly is
-- refused by the relay for want of a token. A curtain that only hid a <div> would be a
-- curtain painted on glass.
ALTER TABLE scheduled_events ADD COLUMN standby_headline TEXT;
ALTER TABLE scheduled_events ADD COLUMN standby_message TEXT;

-- One accent colour, stored as a #rrggbb string and validated as one before it is written.
-- Deliberately NOT free CSS: this value is interpolated into the standby page's styling, and
-- "let the scheduler write CSS" is a stylesheet injection with extra steps. The overlay editor
-- accepts markup because a broadcaster is trusted with their own broadcast; the standby page
-- is shown to people who have not been let in yet.
ALTER TABLE scheduled_events ADD COLUMN standby_accent TEXT;

-- Does the standby page count down? On by default, because it answers the question most
-- early arrivals actually have. Off for the event that starts "when we are ready".
ALTER TABLE scheduled_events ADD COLUMN standby_countdown INTEGER NOT NULL DEFAULT 1;

-- When the broadcaster last lifted the curtain, ISO-8601 UTC, NULL while it is down.
--
-- A timestamp rather than a boolean because of recurrence. A standing weekly town hall is ONE
-- row: a flag set last Thursday would still read "up" this Thursday, and the whole audience
-- would walk in on the host's empty green room. Stored as an instant, it is compared against
-- the occurrence currently in play -- see curtainUp() in the Worker.
ALTER TABLE scheduled_events ADD COLUMN curtain_lifted_at TEXT;

-- The /route hot path asks "is there an uncancelled event at this stream id, and is its
-- curtain up" on every viewer poll, once every 1.5 seconds per waiting attendee. The existing
-- idx_scheduled_events_stream covers the lookup; this is the covering half, so the answer
-- comes out of the index without touching the row.
CREATE INDEX IF NOT EXISTS idx_scheduled_events_curtain
  ON scheduled_events(stream_id, canceled_at, curtain_lifted_at);
