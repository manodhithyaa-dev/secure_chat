-- 002_device_binding.sql
-- Enforce one active device per account and bind sessions to a device.
--
-- Design:
--  * `devices` gains a client-supplied stable identifier (`client_device_id`)
--    and the public half of the device's proof-of-possession signing key
--    (`signing_public_key`). The private half never leaves the client.
--  * At most ONE active (non-revoked) device per user is enforced by a partial
--    unique index. Existing rows with more than one active device are resolved
--    by keeping the most recently created active device and revoking the rest.
--  * `sessions.device_id` records which device a session belongs to. Legacy
--    sessions keep a NULL device_id and are rejected until the user signs in
--    again from a device (controlled enrollment).
--  * `auth_challenges` stores short-lived nonces used for device
--    proof-of-possession. It is server-only state; no secret is persisted.
--
-- The `devices` table is rebuilt because SQLite cannot drop the old
-- UNIQUE(user_id, identity_public_key) constraint in place, which conflicts
-- with re-enrolling the same browser key after a device replacement.

CREATE TABLE devices_new (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  client_device_id    TEXT,
  identity_public_key TEXT NOT NULL,
  algorithm           TEXT NOT NULL,
  signing_public_key  TEXT,
  created_at          INTEGER NOT NULL,
  last_seen_at        INTEGER,
  revoked_at          INTEGER
);

-- Copy every device, revoking all but the newest active device per user.
-- Revoked rows are preserved exactly (so status history is intact).
INSERT INTO devices_new (
  id, user_id, name, client_device_id, identity_public_key, algorithm,
  signing_public_key, created_at, last_seen_at, revoked_at
)
SELECT
  id, user_id, name, NULL, identity_public_key, algorithm,
  NULL, created_at, NULL,
  CASE
    WHEN revoked_at IS NULL AND rn > 1 THEN unixepoch() * 1000
    ELSE revoked_at
  END
FROM (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY (revoked_at IS NULL) DESC, created_at DESC, id DESC
    ) AS rn
  FROM devices
);

DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;

CREATE INDEX idx_devices_user ON devices(user_id);
-- At most one active device per account.
CREATE UNIQUE INDEX idx_devices_one_active ON devices(user_id) WHERE revoked_at IS NULL;
-- A stable client identifier is unique per account when present.
CREATE UNIQUE INDEX idx_devices_client ON devices(user_id, client_device_id)
  WHERE client_device_id IS NOT NULL;

ALTER TABLE sessions ADD COLUMN device_id TEXT;
CREATE INDEX idx_sessions_device ON sessions(device_id);

CREATE TABLE auth_challenges (
  id          TEXT PRIMARY KEY,
  challenge   TEXT NOT NULL,
  username    TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

CREATE INDEX idx_auth_challenges_expires ON auth_challenges(expires_at);
