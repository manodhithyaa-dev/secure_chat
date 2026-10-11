import {
  consumeChallenge,
  verifyDeviceProof,
} from '../auth/challenges.js';
import { revokeAllSessions } from '../auth/sessions.js';
import {
  deviceAlreadyRegistered,
  deviceNotAuthorized,
} from '../middleware/errors.js';
import {
  getActiveDeviceRow,
  insertDevice,
  revokeDeviceRow,
  touchDevice,
  upgradeLegacyDevice,
} from './service.js';

function proofPayload(deviceInput, proof) {
  return {
    signingPublicKey: deviceInput?.signingPublicKey,
    challenge: consumeChallenge(proof?.challengeId),
    signature: proof?.signature,
  };
}

function assertProof(payload) {
  if (!verifyDeviceProof(payload)) {
    throw deviceNotAuthorized('device proof verification failed');
  }
}

/**
 * Bind the account's first (and only) device at registration time.
 * Verifies the client actually holds the private key it is registering.
 */
export function bindDeviceOnRegister(userId, deviceInput, proof) {
  assertProof(proofPayload(deviceInput, proof));
  return { device: insertDevice(userId, deviceInput), replaced: false };
}

/**
 * Resolve which device a login is authorized for.
 *
 *  - No active device            -> enroll this device.
 *  - Same device (verified key)  -> refresh and reuse it.
 *  - Legacy device (no key)      -> upgrade in place (controlled enrollment).
 *  - Different device, no replace-> reject with `device_already_registered`.
 *  - Different device, replace   -> revoke the old device + all old sessions.
 */
export function resolveLoginDevice(userId, deviceInput, proof, { replace = false } = {}) {
  const active = getActiveDeviceRow(userId);
  const supplied = proofPayload(deviceInput, proof);

  if (!active) {
    assertProof(supplied);
    return { device: insertDevice(userId, deviceInput), replaced: false, replacedDeviceId: null };
  }

  const sameClient =
    Boolean(active.client_device_id) && active.client_device_id === deviceInput?.clientDeviceId;

  // Returning, already-proven device.
  if (active.signing_public_key && sameClient) {
    if (
      !verifyDeviceProof({
        signingPublicKey: active.signing_public_key,
        challenge: supplied.challenge,
        signature: supplied.signature,
      })
    ) {
      throw deviceNotAuthorized('device proof verification failed');
    }
    touchDevice(active.id);
    return { device: active, replaced: false, replacedDeviceId: null };
  }

  // Legacy enrollment: the active device predates proofs. Bind a proof key to
  // it rather than creating a competing device row.
  if (!active.signing_public_key) {
    assertProof(supplied);
    revokeAllSessions(userId);
    return {
      device: upgradeLegacyDevice(active, deviceInput),
      replaced: true,
      replacedDeviceId: null,
    };
  }

  // A different device is already registered.
  if (!replace) {
    throw deviceAlreadyRegistered({
      activeDevice: { id: active.id, name: active.name, createdAt: active.created_at },
    });
  }

  assertProof(supplied);
  // Revoke the previous device. Its still-valid sessions are rejected by the
  // per-request device check (DEVICE_REVOKED); we deliberately avoid deleting
  // the device row so history and the account's single-device invariant hold.
  revokeDeviceRow(active.id);
  return {
    device: insertDevice(userId, deviceInput),
    replaced: true,
    replacedDeviceId: active.id,
  };
}
