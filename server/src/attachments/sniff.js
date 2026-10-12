/**
 * Server-side content-type constraints for encrypted attachments.
 *
 * The stored blob is CIPHERTEXT, so the server cannot sniff plaintext magic
 * bytes (it never decrypts). Instead:
 *  - the sender validates actual bytes locally before encryption (see the
 *    client's crypto/attachments layer) and declares a MIME type;
 *  - the server constrains that declaration to a fixed, safe allowlist, so a
 *    malicious/buggy client cannot smuggle renderable HTML/SVG/XHTML types;
 *  - the allowlist is deliberately small and never includes executable or
 *    scriptable types.
 */

/** Safe, bounded set of MIME types per attachment kind. */
export const ALLOWED_CONTENT_TYPES = new Set([
  // files
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/javascript',
  'application/x-zip-compressed',
  'application/octet-stream',
  // images
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  // audio
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  // Denormalised but harmless; normalised on the way out.
]);

/** Kinds whose content is inherently risky to auto-render. */
export const DANGEROUS_TYPES = new Set([
  'text/html',
  'text/xml',
  'image/svg+xml',
  'application/xhtml+xml',
]);

/** Normalise a client-supplied display MIME against the allowlist. */
export function normalizeContentType(kind, declared) {
  const normalized = (declared || '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (!normalized) return null;
  if (!ALLOWED_CONTENT_TYPES.has(normalized)) return null;
  if (DANGEROUS_TYPES.has(normalized)) return null;
  if (kind === 'image' && !normalized.startsWith('image/')) return null;
  if (kind === 'audio' && !normalized.startsWith('audio/')) return null;
  return { kind: kind === 'file' ? 'file' : kind, contentType: normalized };
}

/**
 * Map a normalized content type to the attachment kind if it was not
 * provided explicitly.
 */
export function kindForContentType(contentType) {
  if (!contentType) return null;
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audio';
  if (DANGEROUS_TYPES.has(contentType)) return null;
  return 'file';
}

export default { ALLOWED_CONTENT_TYPES, normalizeContentType, kindForContentType };