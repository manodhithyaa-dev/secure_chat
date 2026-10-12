import { describe, it, expect } from 'vitest';
import {
  ATTACHMENT_CHUNK_SIZE,
  ATTACHMENT_FORMAT_VERSION,
  CHUNK_PREFIX_BYTES,
  aadFor,
  base64ToBytes,
  buildHeader,
  bytesToBase64,
  decryptAttachmentBlob,
  deriveNonce,
  encryptAttachmentBlob,
  parseHeader,
} from './attachment';
import { utf8Encode } from './encoding';

describe('chunked attachment encryption', () => {
  it('round trips a multi-chunk blob and reports progress', async () => {
    const content = new Uint8Array(ATTACHMENT_CHUNK_SIZE * 2 + 12345);
    for (let i = 0; i < content.length; i += 1) {
      content[i] = (i * 31 + 7) % 256;
    }
    const source = new Blob([content]);
    const progress: number[] = [];
    const encrypted = await encryptAttachmentBlob(source, (p) => {
      progress.push(p.done / p.total);
    });
    expect(encrypted.plainSize).toBe(content.length);
    expect(encrypted.cipherSize).toBeGreaterThan(content.length);
    expect(encrypted.key.length).toBe(32);
    expect(encrypted.salt).toBeTruthy();
    expect(progress.length).toBeGreaterThan(1);
    expect(progress[progress.length - 1]).toBe(1);

    const decrypted = await decryptAttachmentBlob(
      encrypted.ciphertext,
      encrypted.key,
      encrypted.salt,
    );
    expect(decrypted.size).toBe(content.length);
    const round = new Uint8Array(await decrypted.arrayBuffer());
    expect(Buffer.from(round).equals(Buffer.from(content))).toBe(true);
  });

  it('derives unique nonces per chunk index and per salt', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const n0 = await deriveNonce(key, salt, 0);
    const n1 = await deriveNonce(key, salt, 1);
    const n0b = await deriveNonce(key, salt, 0);
    expect(bytesToBase64(n0)).not.toBe(bytesToBase64(n1));
    expect(bytesToBase64(n0)).toBe(bytesToBase64(n0b));
    const salt2 = crypto.getRandomValues(new Uint8Array(16));
    expect(bytesToBase64(await deriveNonce(key, salt2, 0))).not.toBe(bytesToBase64(n0));
  });

  it('rejects tampered ciphertext', async () => {
    const source = new Blob([utf8Encode('this must be protected')]);
    const encrypted = await encryptAttachmentBlob(source);
    const arr = new Uint8Array(await encrypted.ciphertext.arrayBuffer());
    arr[arr.length - 1] ^= 0xff;
    await expect(
      decryptAttachmentBlob(new Blob([arr]), encrypted.key, encrypted.salt),
    ).rejects.toThrow();
  });

  it('rejects a corrupted header', async () => {
    const source = new Blob([utf8Encode('hello')]);
    const encrypted = await encryptAttachmentBlob(source);
    const arr = new Uint8Array(await encrypted.ciphertext.arrayBuffer());
    arr[0] = 0x58; // 'X' instead of 'S'
    await expect(decryptAttachmentBlob(new Blob([arr]), encrypted.key, encrypted.salt)).rejects.toThrow(
      'not a SecureChat attachment',
    );
  });

  it('rejects chunks sent out of order', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const chunkSize = 10;
    const chunkCount = 2;
    const totalSize = 20;
    const header = buildHeader(chunkSize, totalSize, chunkCount, salt);

    const aesKey = await crypto.subtle.importKey(
      'raw',
      key as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['encrypt'],
    );
    async function encryptChunk(index: number, text: string) {
      const nonce = await deriveNonce(key, salt, index);
      return new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv: nonce as BufferSource,
            additionalData: aadFor(
              ATTACHMENT_FORMAT_VERSION,
              chunkSize,
              chunkCount,
              totalSize,
              index,
            ) as BufferSource,
          },
          aesKey,
          utf8Encode(text) as BufferSource,
        ),
      );
    }
    const c0 = await encryptChunk(0, 'chunk-zero');
    const c1 = await encryptChunk(1, 'chunk-one!');
    function prefix(index: number, nonce: Uint8Array): Uint8Array<ArrayBuffer> {
      const p = new Uint8Array(CHUNK_PREFIX_BYTES);
      new DataView(p.buffer).setUint32(0, index);
      p.set(nonce, 4);
      return p;
    }
    const n0 = await deriveNonce(key, salt, 0);
    const n1 = await deriveNonce(key, salt, 1);

    // Correct order decrypts fine.
    const good = new Blob([
      header,
      prefix(0, n0), c0,
      prefix(1, n1), c1,
    ]);
    const ok = await decryptAttachmentBlob(good, key, salt);
    expect(await ok.text()).toBe('chunk-zerochunk-one!');

    // Swapped order is rejected.
    const swapped = new Blob([
      header,
      prefix(1, n1), c1,
      prefix(0, n0), c0,
    ]);
    await expect(decryptAttachmentBlob(swapped, key, salt)).rejects.toThrow('out of order');
  });

  it('rejects truncation and wrong key', async () => {
    const source = new Blob([utf8Encode('sensitive payload here')]);
    const encrypted = await encryptAttachmentBlob(source);
    const arr = new Uint8Array(await encrypted.ciphertext.arrayBuffer());
    const truncated = new Blob([arr.slice(0, arr.length - 20)]);
    await expect(decryptAttachmentBlob(truncated, encrypted.key, encrypted.salt)).rejects.toThrow();

    const wrong = crypto.getRandomValues(new Uint8Array(32));
    await expect(
      decryptAttachmentBlob(encrypted.ciphertext, wrong, encrypted.salt),
    ).rejects.toThrow();
  });

  it('round trips base64 key/salt helpers', () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    expect(bytesToBase64(base64ToBytes(bytesToBase64(raw)))).toBe(bytesToBase64(raw));
  });

  it('parses a built header', () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const header = buildHeader(64, 100, 2, salt);
    const parsed = parseHeader(header);
    expect(parsed.chunkSize).toBe(64);
    expect(parsed.totalSize).toBe(100);
    expect(parsed.chunkCount).toBe(2);
    expect(bytesToBase64(parsed.salt)).toBe(bytesToBase64(salt));
  });
});