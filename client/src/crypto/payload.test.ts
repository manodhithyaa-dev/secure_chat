import { describe, it, expect } from 'vitest';
import {
  attachmentPreview,
  buildAttachmentPayload,
  parseMessagePayload,
  type AttachmentMeta,
} from './payload';

function meta(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    id: 'a'.repeat(32),
    kind: 'file',
    name: 'report.pdf',
    mime: 'application/pdf',
    size: 1234,
    cipherSize: 2000,
    key: 'key',
    salt: 'salt',
    ...overrides,
  };
}

describe('attachment message payload', () => {
  it('builds and parses an attachment envelope', () => {
    const m = meta();
    const parsed = parseMessagePayload(buildAttachmentPayload(m));
    expect(parsed.type).toBe('attachment');
    if (parsed.type === 'attachment') {
      expect(parsed.meta).toEqual(m);
    }
  });

  it('leaves ordinary text untouched even when it is JSON', () => {
    const text = '{"hello":1}';
    const parsed = parseMessagePayload(text);
    expect(parsed.type).toBe('text');
    if (parsed.type === 'text') expect(parsed.text).toBe(text);
  });

  it('falls back to text for malformed envelopes', () => {
    const parsed = parseMessagePayload('{"v":1,"t":"att"}'); // missing a
    expect(parsed.type).toBe('text');
  });

  it('produces human previews per kind', () => {
    expect(attachmentPreview(meta({ kind: 'image', name: 'pic.png' }))).toBe('[Photo]');
    expect(attachmentPreview(meta({ kind: 'audio', name: 'note.webm' }))).toBe('[Voice message]');
    expect(attachmentPreview(meta({ kind: 'file', name: 'report.pdf' }))).toBe('[File] report.pdf');
  });
});