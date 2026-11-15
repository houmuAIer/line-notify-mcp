-- Captured LINE notifications. One row per message.
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key   TEXT NOT NULL UNIQUE,
  chat        TEXT NOT NULL,
  sender      TEXT NOT NULL,
  body        TEXT NOT NULL,
  is_group    INTEGER NOT NULL DEFAULT 0,
  sent_at     INTEGER NOT NULL,           -- epoch ms, from the notification
  received_at INTEGER NOT NULL,           -- epoch ms, when the server stored it
  device_id   TEXT NOT NULL
);
CREATE INDEX idx_messages_sent_at ON messages (sent_at DESC);
CREATE INDEX idx_messages_chat_sent_at ON messages (chat, sent_at DESC);

-- Phones allowed to upload. Only the SHA-256 of each token is stored.
CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER
);

-- One-time codes that let a phone obtain a device token.
CREATE TABLE pairing_codes (
  code_hash  TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

-- Chats the user chose not to capture (names only). Synced with the phone so
-- the list survives a change of phone.
CREATE TABLE exclusions (
  chat       TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
