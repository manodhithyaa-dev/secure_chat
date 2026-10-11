import { describe, it, expect } from 'vitest';
import { generateIdentity } from './identity';
import { getSessionKey, clearSessionCache } from './index';
import { encryptMessage, decryptMessage } from './message';
import { base64ToBytes } from './encoding';

describe('E2EE crypto', () => {
  it('generates a public key and a non-extractable private key', async () => {
    const id = await generateIdentity();
    expect(id.publicKeyBase64.length).toBeGreaterThan(20);
    expect(id.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', id.privateKey)).rejects.toBeTruthy();
  });

  it('derives identical session keys on both sides (ECDH + HKDF)', async () => {
    clearSessionCache();
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const aKey = await getSessionKey({
      myUserId: 'alice',
      myPrivateKey: alice.privateKey,
      peerUserId: 'bob',
      peerPublicKeyBase64: bob.publicKeyBase64,
    });
    const bKey = await getSessionKey({
      myUserId: 'bob',
      myPrivateKey: bob.privateKey,
      peerUserId: 'alice',
      peerPublicKeyBase64: alice.publicKeyBase64,
    });
    const ctx = { senderId: 'alice', recipientId: 'bob', messageId: 'm1' };
    const payload = await encryptMessage(aKey, 'hello bob', ctx);
    const decrypted = await decryptMessage(bKey, payload, ctx);
    expect(decrypted).toBe('hello bob');
  });

  it('ciphertext never equals plaintext', async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const key = await getSessionKey({
      myUserId: 'a',
      myPrivateKey: alice.privateKey,
      peerUserId: 'b',
      peerPublicKeyBase64: bob.publicKeyBase64,
    });
    const payload = await encryptMessage(key, 'secret message', {
      senderId: 'a',
      recipientId: 'b',
      messageId: 'm2',
    });
    expect(payload.ciphertext).not.toContain('secret');
    expect(base64ToBytes(payload.ciphertext).length).toBeGreaterThan(0);
  });

  it('rejects tampered ciphertext / context (integrity verified)', async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const key = await getSessionKey({
      myUserId: 'a',
      myPrivateKey: alice.privateKey,
      peerUserId: 'b',
      peerPublicKeyBase64: bob.publicKeyBase64,
    });
    const payload = await encryptMessage(key, 'hi', {
      senderId: 'a',
      recipientId: 'b',
      messageId: 'm3',
    });

    await expect(
      decryptMessage(key, payload, { senderId: 'a', recipientId: 'b', messageId: 'm4' }),
    ).rejects.toBeTruthy();

    const tampered = { ...payload, ciphertext: payload.ciphertext.slice(0, -4) + 'AAAA' };
    await expect(
      decryptMessage(key, tampered, { senderId: 'a', recipientId: 'b', messageId: 'm3' }),
    ).rejects.toBeTruthy();
  });

  it('fails to decrypt with the wrong key', async () => {
    clearSessionCache();
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const mallory = await generateIdentity();
    const aliceKey = await getSessionKey({
      myUserId: 'alice',
      myPrivateKey: alice.privateKey,
      peerUserId: 'bob',
      peerPublicKeyBase64: bob.publicKeyBase64,
    });
    // Mallory attempts a session with Bob, which yields a different key.
    const malloryKey = await getSessionKey({
      myUserId: 'mallory',
      myPrivateKey: mallory.privateKey,
      peerUserId: 'bob',
      peerPublicKeyBase64: bob.publicKeyBase64,
    });
    const payload = await encryptMessage(aliceKey, 'for bob only', {
      senderId: 'alice',
      recipientId: 'bob',
      messageId: 'm5',
    });
    await expect(
      decryptMessage(malloryKey, payload, {
        senderId: 'alice',
        recipientId: 'bob',
        messageId: 'm5',
      }),
    ).rejects.toBeTruthy();
  });
});
