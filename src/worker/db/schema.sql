-- Users table for OAuth authentication
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_id TEXT UNIQUE,
  microsoft_id TEXT UNIQUE,
  discord_id TEXT UNIQUE,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for fast provider ID lookups during OAuth
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_users_microsoft_id ON users(microsoft_id);
CREATE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id);

-- Broadcast events - logged when a user starts broadcasting
CREATE TABLE IF NOT EXISTS broadcast_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  stream_id TEXT NOT NULL,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT,
  -- Geolocation data from Cloudflare
  geo_country TEXT,
  geo_city TEXT,
  geo_region TEXT,
  geo_latitude TEXT,
  geo_longitude TEXT,
  geo_timezone TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_broadcast_events_user_id ON broadcast_events(user_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_events_stream_id ON broadcast_events(stream_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_events_started_at ON broadcast_events(started_at);

-- Watch events - logged when someone watches a stream
CREATE TABLE IF NOT EXISTS watch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  stream_id TEXT NOT NULL,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT,
  -- Geolocation data from Cloudflare
  geo_country TEXT,
  geo_city TEXT,
  geo_region TEXT,
  geo_latitude TEXT,
  geo_longitude TEXT,
  geo_timezone TEXT
);

CREATE INDEX IF NOT EXISTS idx_watch_events_user_id ON watch_events(user_id);
CREATE INDEX IF NOT EXISTS idx_watch_events_stream_id ON watch_events(stream_id);
CREATE INDEX IF NOT EXISTS idx_watch_events_started_at ON watch_events(started_at);

-- Stream settings - stores per-stream configuration
CREATE TABLE IF NOT EXISTS streams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  require_auth INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_streams_stream_id ON streams(stream_id);
CREATE INDEX IF NOT EXISTS idx_streams_user_id ON streams(user_id);
