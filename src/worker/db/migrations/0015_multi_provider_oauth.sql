-- 0015: Microsoft and Discord sign-in alongside Google.
--
-- Vivoh.Earth diverges from Wallflower here on purpose: OAuth is on, and it is the only
-- publisher door. Wallflower ships the same Worker with sign-in commented out and a single
-- google_id column; this adds the other two provider columns its upsertUser already expects
-- (it builds the column name as `${provider}_id`, so without these a Microsoft or Discord
-- callback fails on an unknown column rather than anything more legible).
--
-- Both are nullable and UNIQUE. Nullable because most rows will only ever have one provider
-- set; UNIQUE because a provider id must map to at most one account. SQLite permits many
-- NULLs in a UNIQUE column, which is what makes that combination work at all.
--
-- Account LINKING is in the Worker, not here: upsertUser matches on email first, so a person
-- who signs in with Google and later with Microsoft lands on one row. Nothing in this
-- migration enforces that — if you change the upsert, re-read this note, because the thing
-- that would break is broadcaster_access silently not applying to the duplicate account.

ALTER TABLE users ADD COLUMN microsoft_id TEXT;
ALTER TABLE users ADD COLUMN discord_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_microsoft_id ON users(microsoft_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id);
