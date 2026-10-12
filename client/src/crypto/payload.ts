/**
 * Message-plaintext envelope for attachments.
 *
 * The MESSAGE ciphertext is the usual E2EE text envelope. For attachments the
 * plaintext is a small JSON object describing the attachment; it carries the
 * opaque server id, display metadata, and — most importantly — the content key
 * and salt required to decrypt the uploaded ciphertext. Everything below
 * travels inside the existing encrypted message, so the server never sees the
 * key or salt.
 */
export interface AttachmentMeta {
  /** Opaque server-side attachment id (from the upload ticket). */
  id: string;
  kind: 'file' | 'image' | 'audio';
  name: string;
  mime: string;
  /** Plaintext size in bytes. */
  size: number;
  /** Encrypted (on-disk/server) size in bytes. */
  cipherSize: number;
  /** base64 raw content key. */
  key: string;
  /** base64 salt for chunk-nonce derivation. */
  salt: string;
}

const ENVELOPE_VERSION = 1;

export function buildAttachmentPayload(meta: AttachmentMeta): string {
  return JSON.stringify({ v: ENVELOPE_VERSION, t: 'att', a: meta });
}

export type ParsedPayload =
  | { type: 'text'; text: string }
  | { type: 'attachment'; meta: AttachmentMeta };

export function parseMessagePayload(plaintext: string): ParsedPayload {
  if (plaintext.startsWith('{')) {
    try {
      const parsed = JSON.parse(plaintext) as {
        v?: number;
        t?: string;
        a?: AttachmentMeta;
      };
      if (parsed && parsed.v === ENVELOPE_VERSION && parsed.t === 'att' && parsed.a) {
        return { type: 'attachment', meta: parsed.a };
      }
    } catch {
      // fall through to text
    }
  }
  return { type: 'text', text: plaintext };
}

/** Human preview used for conversations and unread summaries. */
export function attachmentPreview(meta: AttachmentMeta): string {
  if (meta.kind === 'image') return '[Photo]';
  if (meta.kind === 'audio') return '[Voice message]';
  return `[File] ${meta.name}`;
}

export default { buildAttachmentPayload, parseMessagePayload, attachmentPreview };