-- Breakout rooms: an attendee opens a side conversation off a live broadcast.
--
-- This migration carries the single most consequential change in the deployment's history of
-- WHO MAY PUBLISH, so it is written down here rather than left in the endpoint.
--
-- Until now publishing needed two things: an account, and a row in `broadcaster_access` with
-- status 'allowed'. An operator granted it by hand. That is a deliberately narrow door and it
-- is why `canBroadcast()` default-denies a brand-new account.
--
-- A breakout room cannot work behind that door. The whole point is that an ORDINARY ATTENDEE
-- of a town hall — someone who will never be on an allow list — opens a side room and becomes
-- its broadcaster. So this table is a SECOND, NARROWER DOOR, and every column below exists to
-- keep it narrow:
--
--   * `stream_id` scopes the grant to ONE broadcast name. It is not "this person may publish";
--     it is "this person may publish THIS id". Minted by us, never chosen by the caller.
--   * `user_id` scopes it to one account, so a leaked link grants nothing.
--   * `parent_stream_id` records where the authority came from. A breakout exists only because
--     a broadcaster who IS on the allow list ticked "let attendees open breakout rooms" on
--     their own stream. The grant is delegated, and this column is the audit trail of it.
--   * `expires_at` bounds it in time. Without this, one open row is a standing publish
--     permission that outlives the event, the tab and the day.
--   * `closed_at` ends it early, and is what the kill path and the end-of-broadcast hook set.
--
-- The delegation is revocable at the source: clearing `streams.breakouts_enabled` stops new
-- rooms immediately. Rooms already open keep their grant until they close or expire, because
-- cutting a conversation mid-sentence to enforce a toggle nobody re-read is worse than letting
-- it finish.
ALTER TABLE streams ADD COLUMN breakouts_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS breakout_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The broadcast this room broke out of. Not a foreign key: `streams` rows are written lazily
  -- and a parent may legitimately have none yet.
  parent_stream_id TEXT NOT NULL,
  -- The breakout's own broadcast name, minted server-side. UNIQUE because this row is a
  -- publish grant for that name and two grants for one name is two owners.
  stream_id TEXT NOT NULL UNIQUE,
  -- Who may publish it. The grant is to this account and no other.
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  -- ISO-8601 UTC. Past this the grant is dead even if nothing closed the row.
  expires_at TEXT NOT NULL,
  -- Set when the broadcast ends, when the creator closes the tab, or by the kill path.
  closed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- The admission check on the go-live hot path: "is this (stream, user) an open grant?"
CREATE INDEX IF NOT EXISTS idx_breakout_grant ON breakout_rooms(stream_id, user_id, closed_at);

-- "What rooms have broken out of this broadcast", for the parent's own list.
CREATE INDEX IF NOT EXISTS idx_breakout_parent ON breakout_rooms(parent_stream_id, closed_at);
