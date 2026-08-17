-- Abuse reports, and the revocation levers for per-person publish codes.
--
-- Two features, one migration, because they are two halves of the same loop: a report is the
-- only way we can learn a stream is a problem, and a code is the only thing we can decline to
-- reissue afterwards.
--
-- Note what is NOT in either table. No IP address, no viewer identifier, no session, no
-- reporter handle. We are blind to stream content by construction, and adding a reporting
-- path must not quietly hand us an identity graph as a consolation prize.

-- ── Abuse reports ────────────────────────────────────────────────────────────────────────
-- A report is a SENSOR, not a trigger. Nothing here kills anything; an operator reads the
-- queue and decides. An auto-kill threshold would be a harassment tool aimed at exactly the
-- broadcasters this app exists to protect, because reporting requires only a share link and a
-- single hostile invitee can file repeatedly.
--
-- Deliberately absent: the reporter's viewing link. A viewer may choose to attach one so we
-- can actually verify the accusation (we cannot decrypt anything otherwise), but that link
-- carries the content key, so it is forwarded to the operator's webhook and NEVER written
-- here. The property that this database yields no way to decrypt any broadcast survives the
-- addition of a report button — which it would not if we stored the evidence link.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT NOT NULL,
  -- One of a fixed set (see REPORT_CATEGORIES in the Worker). Free text is capped separately.
  category TEXT NOT NULL,
  -- Optional, length-capped, viewer-supplied. Viewers are told not to put personal details
  -- here; that cannot be enforced, only not invited.
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  -- Set when an operator has looked at it, so the queue does not re-present the same rows.
  handled_at TEXT
);

-- The rate limiter counts recent rows per stream, and the queue reads newest-first.
CREATE INDEX IF NOT EXISTS idx_reports_stream_time ON reports (stream_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_unhandled ON reports (handled_at, created_at);

-- ── Publish code revocation ──────────────────────────────────────────────────────────────
-- Codes are stateless: they carry their own not-before, expiry and batch, sealed with an
-- HMAC, so issuing one writes nothing down and there is no per-person row to correlate
-- against broadcast_events. These two tables exist only to cut a code short of its expiry.

-- Revoke an entire issuance cohort at once. Cheap, and identity-free: a batch number says
-- how many codes were minted around the same time and nothing about who holds them.
CREATE TABLE IF NOT EXISTS revoked_batches (
  batch INTEGER PRIMARY KEY,
  revoked_at TEXT DEFAULT (datetime('now')),
  note TEXT
);

-- Revoke ONE code without knowing whose it is. We store the SHA-256 of the code, never the
-- code itself: the hash is enough to reject a presented code and useless for anything else.
-- Keeping revocation and identity-logging separate is the whole point — a deny list is not a
-- reason to start recording who requested what.
CREATE TABLE IF NOT EXISTS revoked_codes (
  code_hash TEXT PRIMARY KEY,   -- base64url SHA-256 of the full code string
  revoked_at TEXT DEFAULT (datetime('now')),
  note TEXT
);
