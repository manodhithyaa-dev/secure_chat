-- 003_device_identity_optional.sql
-- Relax the device encryption-key columns.
--
-- A device is bound during login, but its E2EE identity key is only published
-- afterwards (it is generated per account, client-side). So `identity_public_key`
-- and `algorithm` must be nullable on a freshly bound device. 002 created them
-- NOT NULL; this rebuilds the table to allow NULL while preserving every row
-- (including revoked devices) and re-creating the one-active-device indexes.

CREATE TABLE devices_v3 (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  client_device_id    TEXT,
  identity_public_key TEXT,
  algorithm           TEXT,
  signing_public_key  TEXT,
  created_at          INTEGER NOT NULL,
  last_seen_at        INTEGER,
  revoked_at          INTEGER
);

INSERT INTO devices_v3 (
  id, user_id, name, client_device_id, identity_public_key, algorithm,
  signing_public_key, created_at, last_seen_at, revoked_at
)
SELECT
  id, user_id, name, client_device_id, identity_public_key, algorithm,
  signing_public_key, created_at, last_seen_at, revoked_at
FROM devices;

DROP TABLE devices;
ALTER TABLE devices_v3 RENAME TO devices;

CREATE INDEX idx_devices_user ON devices(user_id);
CREATE UNIQUE INDEX idx_devices_one_active ON devices(user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX idx_devices_client ON devices(user_id, client_device_id)
  WHERE client_device_id IS NOT NULL;
