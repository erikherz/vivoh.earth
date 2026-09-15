-- The content key moves from the share link into this database.
--
-- Vivoh.Earth diverges here from e2emoq.com and wallflower.tv, deliberately and knowingly.
-- Those products carry the link secret in the `#k=` fragment, which browsers never transmit,
-- so their operator structurally cannot decrypt a broadcast. That property is GONE from this
-- deployment as of migration 0020, and every page that claimed it has been rewritten.
--
-- What it buys: a link a person can actually be given. A virtual event is circulated in a
-- calendar invite, a Slack message, an intranet page — several of which mangle or drop
-- fragments, and none of which a 60-character secret survives being read down a phone. The
-- link is now https://vivoh.earth/mooed and nothing else.
--
-- What it costs, written here because the marketing copy now has to say it too: media is
-- still encrypted in the browser and the CDN still carries only ciphertext, but WE hold the
-- key material. A subpoena, or a breach of this table combined with a relay capture, would
-- yield plaintext. That was impossible before and is possible now.
--
-- Access control is therefore load-bearing in a way it was not. `streams.require_auth`
-- defaults to 1 and fails closed (see the /route handler), and the key endpoint enforces the
-- identical gate, so a stream nobody configured is sign-in-only.
CREATE TABLE IF NOT EXISTS stream_keys (
  stream_id TEXT PRIMARY KEY,
  -- base64url link secret: the same value that used to ride in `#k=`. HKDF input for the
  -- media, chat, room and link-watermark keys — see deriveMediaKey() and its siblings.
  link_secret TEXT NOT NULL,
  -- Who minted it. Nullable because a key can outlive the account that made it, and the
  -- viewer path has to keep working when it does.
  user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  -- Bumped by New link. Rotating re-keys the stream for everyone deriving afterwards; a
  -- viewer already connected keeps the old key until they reconnect, exactly as before.
  rotated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_stream_keys_user ON stream_keys(user_id);
