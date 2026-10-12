-- 004_attachments.sql
-- Encrypted attachment metadata for file/image/audio shares.
--
-- The server intentionally only ever stores CIPHERTEXT and opaque metadata
-- (id, kind, sizes, sniffed content type, expiry). Never plaintext keys,
-- plaintext content, or anything else decryptable server-side. The file's
-- content encryption key travels inside the E2EE message envelope.
--
-- Storage model:
--   * `id` is an opaque, unpredictable hex string; the file on disk is named
--     by this id inside the configured attachment directory (no user-supplied
--     path components are ever used).
--   * `status = 'pending'`: upload ticket created, data not yet stored.
--   * `status = 'ready'`: named ciphertext file is on disk, awaiting (or
--     bound to) a message.
--   * When the attachment is linked to a delivered message the recipient and
--     expiry are set from the message; pending/ticket/expired records are
--     garbage-collected by the cleanup job.

CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  sender_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  message_id    TEXT REFERENCES messages(message_id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('file', 'image', 'audio')),
  name          TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  plain_size    INTEGER NOT NULL CHECK (plain_size >= 0),
  cipher_size   INTEGER NOT NULL CHECK (cipher_size >= 0),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'ready')),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_sender ON attachments(sender_id, status);
CREATE INDEX IF NOT EXISTS idx_attachments_recipient ON attachments(recipient_id);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_expiry ON attachments(expires_at);