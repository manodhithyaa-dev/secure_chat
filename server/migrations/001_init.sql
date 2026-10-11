-- 001_init.sql
-- Core schema for SecureChat MVP.
-- Server stores only metadata, public keys, hashed credentials/sessions,
-- and the temporary ciphertext offline queue. No private keys, no plaintext.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS devices (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  identity_public_key TEXT NOT NULL,
  algorithm           TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  revoked_at          INTEGER,
  UNIQUE(user_id, identity_public_key)
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- Friendship is stored once with (user_a_id < user_b_id) enforced in code.
CREATE TABLE IF NOT EXISTS friendships (
  user_a_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_a_id, user_b_id),
  CHECK (user_a_id < user_b_id)
);

CREATE TABLE IF NOT EXISTS friend_requests (
  id           TEXT PRIMARY KEY,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at   INTEGER NOT NULL,
  responded_at INTEGER,
  CHECK (from_user_id <> to_user_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_user_id, status);
-- Only one outstanding pending request per ordered pair.
CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_pending
  ON friend_requests(from_user_id, to_user_id)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS messages (
  message_id   TEXT PRIMARY KEY,
  sender_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    TEXT,
  ciphertext   TEXT,
  iv           TEXT,
  alg          TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'acked')),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  delivered_at INTEGER,
  acked_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(sender_id, recipient_id, created_at);
