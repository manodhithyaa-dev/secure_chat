import { base64ToBytes, bytesToBase64, utf8Encode, utf8Decode } from './encoding';

export const MESSAGE_ALGORITHM = 'AES-256-GCM' as const;
const IV_BYTES = 12;

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  alg: typeof MESSAGE_ALGORITHM;
}

export interface MessageContext {
  senderId: string;
  recipientId: string;
  messageId: string;
}

/** Additional authenticated data binds ciphertext to its sender/recipient/id. */
function aad(ctx: MessageContext): Uint8Array {
  return utf8Encode(`${ctx.senderId}|${ctx.recipientId}|${ctx.messageId}`);
}

export async function encryptMessage(
  sessionKey: CryptoKey,
  plaintext: string,
  ctx: MessageContext,
): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES)) as Uint8Array<ArrayBuffer>;
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(ctx) as BufferSource },
    sessionKey,
    utf8Encode(plaintext) as BufferSource,
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
    alg: MESSAGE_ALGORITHM,
  };
}

/**
 * Decrypt a message. Throws on any authentication failure. Callers must NOT
 * fall back to plaintext.
 */
export async function decryptMessage(
  sessionKey: CryptoKey,
  payload: EncryptedPayload,
  ctx: MessageContext,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64ToBytes(payload.iv) as BufferSource,
      additionalData: aad(ctx) as BufferSource,
    },
    sessionKey,
    base64ToBytes(payload.ciphertext) as BufferSource,
  );
  return utf8Decode(plaintext);
}
