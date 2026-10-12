import { describe, expect, it } from 'vitest';
import { pickVoiceMimeType, voiceFileName } from './recorder';

describe('pickVoiceMimeType', () => {
  it('prefers webm+opus, then plain webm, then mp4, then ogg', () => {
    const supported = new Set([
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg',
    ]);
    expect(
      pickVoiceMimeType({ isTypeSupported: (t) => supported.has(t) }),
    ).toBe('audio/webm;codecs=opus');
  });

  it('skips unsupported candidates', () => {
    const supported = new Set(['audio/mp4', 'audio/ogg']);
    expect(
      pickVoiceMimeType({ isTypeSupported: (t) => supported.has(t) }),
    ).toBe('audio/mp4');
  });

  it('returns empty string when nothing is supported', () => {
    expect(pickVoiceMimeType({ isTypeSupported: () => false })).toBe('');
  });

  it('ignores a candidate that throws (malformed type)', () => {
    let calls = 0;
    const recorder = {
      isTypeSupported(type: string): boolean {
        calls += 1;
        if (calls === 1) throw new TypeError('bad type');
        return type === 'audio/ogg';
      },
    };
    expect(pickVoiceMimeType(recorder)).toBe('audio/ogg');
  });

  it('defaults to the real MediaRecorder probing when no recorder is injected', () => {
    // In the node test env MediaRecorder is undefined, so this must not throw.
    expect(() => pickVoiceMimeType()).not.toThrow();
  });
});

describe('voiceFileName', () => {
  it('derives an extension from the container', () => {
    expect(voiceFileName('audio/webm')).toMatch(/\.webm$/);
    expect(voiceFileName('audio/ogg')).toMatch(/\.ogg$/);
    expect(voiceFileName('audio/mp4')).toMatch(/\.m4a$/);
  });

  it('produces a stable, human-readable name', () => {
    const at = new Date(2026, 9, 11, 9, 5);
    expect(voiceFileName('audio/webm', at)).toBe('Voice message 09:05.webm');
  });

  it('pads minutes and hours', () => {
    const at = new Date(2026, 9, 11, 0, 7);
    expect(voiceFileName('audio/webm', at)).toBe('Voice message 00:07.webm');
  });
});