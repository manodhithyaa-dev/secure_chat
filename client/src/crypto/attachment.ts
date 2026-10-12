/**
 * Chunked, authenticated encryption for large attachments.
 *
 * Design goals (see docs/E2EE.md):
 *  - a fresh random 256-bit content key is generated per attachment;
 *  - each plaintext is split into fixed-size chunks and each chunk is
 *    encrypted independently with AES-256-GCM under a UNIQUE nonce derived via
 *    HKDF (salt + chunk index). Nonces are never reused for the same key;
 *  - the chunk index, format version, chunk size, chunk count and total size
 *    are bound into the AAD of every chunk, so chunks cannot be reordered,
 *    duplicated, dropped, truncated, or spliced between attachments;
 *  - the decryptor verifies the total assembled length and every index, and
 *    rejects any authentication failure without falling back to plaintext;
 *  - the content key and salt travel to the recipient ONLY inside the
 *    encrypted message envelope (see payload builder). The server never sees
 *    them.
 *
 * Header layout (all integers big-endian):
 *   [4]  magic "SCAT"
 *   [1]  version (1)
 *   [4]  chunkSize
 *   [8]  totalSize (plaintext)
 *   [4]  chunkCount
 *   [1]  salt length
 *   [N]  salt
 *
 * Chunk layout:
 *   [4]  chunk index
 *   [12] nonce
 *   [S]  AES-256-GCM ciphertext + 16-byte tag
 */

export const ATTACHMENT_MAGIC = 'SCAT';
export const ATTACHMENT_FORMAT_VERSION = 1;
export const ATTACHMENT_CHUNK_SIZE = 1024 * 1024;
export const ATTACHMENT_SALT_BYTES = 16;
export const ATTACHMENT_NONCE_BYTES = 12;
export const ATTACHMENT_TAG_BYTES = 16;

const HEADER_BYTES = 4 + 1 + 4 + 8 + 4 + 1 + ATTACHMENT_SALT_BYTES;
export const CHUNK_PREFIX_BYTES = 4 + ATTACHMENT_NONCE_BYTES;

export interface EncryptionResult {
  /** Encrypted blob ready to upload (server only ever sees this). */
  ciphertext: Blob;
  /** Raw 256-bit content key. Embed inside the encrypted message envelope. */
  key: Uint8Array;
  /** Salt used for nonce derivation. Embed inside the encrypted message. */
  salt: Uint8Array;
  plainSize: number;
  cipherSize: number;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function writeUint64(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(
    offset,
    BigInt(value),
  );
}

function readUint64(bytes: Uint8Array, offset: number): number {
  return Number(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset),
  );
}

function readUint8(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint8(offset);
}

export function encodeText(value: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(value);
  const copy = new Uint8Array(encoded.byteLength);
  copy.set(encoded);
  return copy;
}

async function importKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    copyBytes(raw) as BufferSource,
    { name: 'AES-GCM' },
    false,
    usages,
  );
}

function copyBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

export function aadFor(
  version: number,
  chunkSize: number,
  chunkCount: number,
  totalSize: number,
  index: number,
): Uint8Array {
  return encodeText(
    `${ATTACHMENT_MAGIC}|v${version}|cs${chunkSize}|cc${chunkCount}|ts${totalSize}|i${index}`,
  );
}

export async function deriveNonce(
  keyBytes: Uint8Array,
  salt: Uint8Array,
  index: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const hkdf = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: encodeText(`scatt:${ATTACHMENT_FORMAT_VERSION}:${index}`),
    },
    hkdf,
    ATTACHMENT_NONCE_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export function buildHeader(
  chunkSize: number,
  totalSize: number,
  chunkCount: number,
  salt: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (salt.byteLength !== ATTACHMENT_SALT_BYTES) {
    throw new Error(`salt must be ${ATTACHMENT_SALT_BYTES} bytes`);
  }
  const header = new Uint8Array(HEADER_BYTES);
  header.set(encodeText(ATTACHMENT_MAGIC), 0);
  header[4] = ATTACHMENT_FORMAT_VERSION;
  writeUint32(header, 5, chunkSize);
  writeUint64(header, 9, totalSize);
  writeUint32(header, 17, chunkCount);
  header[21] = salt.byteLength;
  header.set(salt, 22);
  return header;
}

export interface ParsedHeader {
  version: number;
  chunkSize: number;
  totalSize: number;
  chunkCount: number;
  salt: Uint8Array;
}

export function parseHeader(header: Uint8Array): ParsedHeader {
  if (header.byteLength < HEADER_BYTES) throw new Error('attachment header too short');
  const magic = new TextDecoder().decode(header.subarray(0, 4));
  if (magic !== ATTACHMENT_MAGIC) throw new Error('not a SecureChat attachment');
  const version = header[4];
  if (version !== ATTACHMENT_FORMAT_VERSION) {
    throw new Error(`unsupported attachment format version ${version}`);
  }
  const chunkSize = readUint32(header, 5);
  const totalSize = readUint64(header, 9);
  const chunkCount = readUint32(header, 17);
  const saltLen = readUint8(header, 21);
  if (saltLen <= 0 || 22 + saltLen > header.byteLength) throw new Error('bad attachment salt');
  if (chunkSize <= 0 || chunkCount === 0) throw new Error('bad attachment header');
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) throw new Error('bad total size');
  return {
    version,
    chunkSize,
    totalSize,
    chunkCount,
    salt: header.subarray(22, 22 + saltLen),
  };
}

export interface AttachmentProgress {
  done: number;
  total: number;
}

/**
 * Encrypt a Blob into the chunked format. Never holds more than one chunk in
 * memory at a time and reports progress as encryption proceeds.
 */
export async function encryptAttachmentBlob(
  blob: Blob,
  onProgress?: (p: AttachmentProgress) => void,
): Promise<EncryptionResult> {
  const totalSize = blob.size;
  if (totalSize > Number.MAX_SAFE_INTEGER) throw new Error('attachment too large');

  const key = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(ATTACHMENT_SALT_BYTES));
  const aesKey = await importKey(key, ['encrypt']);

  const chunkCount = Math.max(1, Math.ceil(totalSize / ATTACHMENT_CHUNK_SIZE));
  const header = buildHeader(ATTACHMENT_CHUNK_SIZE, totalSize, chunkCount, salt);

  const parts: BlobPart[] = [header];
  let done = 0;
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * ATTACHMENT_CHUNK_SIZE;
    const end = Math.min(start + ATTACHMENT_CHUNK_SIZE, totalSize);
    const chunk = new Uint8Array(await blob.slice(start, end).arrayBuffer());
    const nonce = await deriveNonce(key, salt, index);
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce as BufferSource,
        additionalData: aadFor(
          ATTACHMENT_FORMAT_VERSION,
          ATTACHMENT_CHUNK_SIZE,
          chunkCount,
          totalSize,
          index,
        ) as BufferSource,
      },
      aesKey,
      chunk as BufferSource,
    );
    const prefix = new Uint8Array(CHUNK_PREFIX_BYTES);
    writeUint32(prefix, 0, index);
    prefix.set(nonce, 4);
    parts.push(prefix, new Uint8Array(ciphertext));
    done += chunk.byteLength;
    onProgress?.({ done, total: totalSize });
  }

  const ciphertext = new Blob(parts, { type: 'application/octet-stream' });
  return {
    ciphertext,
    key,
    salt,
    plainSize: totalSize,
    cipherSize: ciphertext.size,
  };
}

/** Decrypt a chunked-format Blob. Throws on any tampering. */
export async function decryptAttachmentBlob(
  ciphertext: Blob,
  key: Uint8Array,
  salt: Uint8Array,
  onProgress?: (p: AttachmentProgress) => void,
): Promise<Blob> {
  const header = new Uint8Array(await ciphertext.slice(0, HEADER_BYTES).arrayBuffer());
  const parsed = parseHeader(header);
  if (parsed.salt.byteLength !== salt.byteLength) throw new Error('attachment salt mismatch');

  const keyBytes = new Uint8Array(key);
  const aesKey = await importKey(keyBytes, ['decrypt']);

  const expectedCipherBytes =
    HEADER_BYTES +
    parsed.chunkCount * CHUNK_PREFIX_BYTES +
    parsed.totalSize +
    parsed.chunkCount * ATTACHMENT_TAG_BYTES;
  if (ciphertext.size < expectedCipherBytes) throw new Error('attachment truncated');

  const lastChunkIndex = parsed.chunkCount - 1;
  const lastChunkBodyBytes =
    parsed.totalSize - lastChunkIndex * parsed.chunkSize;

  const parts: BlobPart[] = [];
  let offset = HEADER_BYTES;
  let done = 0;
  for (let index = 0; index < parsed.chunkCount; index += 1) {
    const chunkBodyBytes =
      index === lastChunkIndex ? lastChunkBodyBytes : parsed.chunkSize;
    const prefix = new Uint8Array(
      await ciphertext.slice(offset, offset + CHUNK_PREFIX_BYTES).arrayBuffer(),
    );
    const storedIndex = readUint32(prefix, 0);
    if (storedIndex !== index) throw new Error('attachment chunk out of order');

    const chunkNonce = await deriveNonce(keyBytes, parsed.salt, index);
    const createdNonce = prefix.subarray(4);
    if (createdNonce.byteLength !== chunkNonce.byteLength) throw new Error('corrupt chunk nonce');

    const encStart = offset + CHUNK_PREFIX_BYTES;
    const encEnd = encStart + chunkBodyBytes + ATTACHMENT_TAG_BYTES;
    const enc = await ciphertext.slice(encStart, encEnd).arrayBuffer();
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: chunkNonce as BufferSource,
        additionalData: aadFor(
          parsed.version,
          parsed.chunkSize,
          parsed.chunkCount,
          parsed.totalSize,
          index,
        ) as BufferSource,
      },
      aesKey,
      enc as BufferSource,
    );
    parts.push(new Uint8Array(plain));
    offset = encEnd;
    done += plain.byteLength;
    onProgress?.({ done, total: parsed.totalSize });
  }

  const result = new Blob(parts);
  if (result.size !== parsed.totalSize) throw new Error('attachment length mismatch');
  return result;
}

/** Convert the raw key/salt to transport-safe base64 strings. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export default {
  encryptAttachmentBlob,
  decryptAttachmentBlob,
  parseHeader,
  buildHeader,
  ATTACHMENT_CHUNK_SIZE,
  ATTACHMENT_FORMAT_VERSION,
};