/**
 * Voice recording built on the native MediaRecorder API (no runtime deps).
 *
 * The recorded blob is a normal attachment payload: it goes through the same
 * client-side chunked encryption + upload pipeline as images/files, so this
 * module never touches keys, salt, or ciphertext.
 */

export const VOICE_MAX_MS = 60_000;

const VOICE_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg',
];

interface MediaRecorderLike {
  isTypeSupported(type: string): boolean;
}

function defaultIsTypeSupported(type: string): boolean {
  return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type);
}

/**
 * Pick the best supported audio container, in preference order. Returns an
 * empty string when none of the candidates is supported so `MediaRecorder`
 * falls back to its own default. Testable via the injected recorder.
 */
export function pickVoiceMimeType(
  recorder: MediaRecorderLike = { isTypeSupported: defaultIsTypeSupported },
): string {
  for (const candidate of VOICE_MIME_CANDIDATES) {
    try {
      if (recorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // Malformed candidate string: skip.
    }
  }
  return '';
}

export function voiceFileName(mimeType: string, at = new Date()): string {
  const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Voice message ${pad(at.getHours())}:${pad(at.getMinutes())}.${ext}`;
}

export interface RecordedVoice {
  /** Playable audio file, ready to be encrypted and sent. */
  file: File;
  mimeType: string;
  durationMs: number;
}

export interface VoiceRecording {
  /** Resolves with the recorded audio once the user stops recording. */
  stop(): Promise<RecordedVoice>;
  /** Discards the recording and releases the microphone without producing audio. */
  cancel(): void;
  /** Milliseconds recorded so far (updates ~4x per second). */
  durationMs: number;
}

export interface StartVoiceRecordingOptions {
  maxMs?: number;
  onTick?(durationMs: number): void;
  onLimitReached?(): void;
}

export async function startVoiceRecording(
  opts: StartVoiceRecordingOptions = {},
): Promise<VoiceRecording> {
  const maxMs = opts.maxMs ?? VOICE_MAX_MS;
  const mimeType = pickVoiceMimeType();

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  let finished = false;
  let cancelled = false;
  let currentDuration = 0;
  let finishPromise: Promise<RecordedVoice> | null = null;

  const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const startedAt = Date.now();

  function stopTracks(): void {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  function resolveFile(): RecordedVoice {
    const recordedMime = mediaRecorder.mimeType || mimeType || 'audio/webm';
    const mime = recordedMime.split(';')[0]?.trim() || 'audio/webm';
    const blob = new Blob(chunks, { type: recordedMime });
    const file = new File([blob], voiceFileName(mime), { type: blob.type });
    return { file, mimeType: mime, durationMs: currentDuration };
  }

  function finish(): Promise<RecordedVoice> {
    if (!finishPromise) {
      finished = true;
      finishPromise = new Promise((resolve, reject) => {
        mediaRecorder.onstop = () => {
          stopTracks();
          resolve(resolveFile());
        };
        mediaRecorder.onerror = () => {
          stopTracks();
          reject(new Error('Recording failed'));
        };
        try {
          mediaRecorder.stop();
        } catch (err) {
          stopTracks();
          reject(err instanceof Error ? err : new Error('Recording failed'));
        }
      });
    }
    return finishPromise;
  }

  const timer = window.setInterval(() => {
    if (finished || cancelled) return;
    currentDuration = Date.now() - startedAt;
    opts.onTick?.(currentDuration);
    if (currentDuration >= maxMs) {
      opts.onLimitReached?.();
      void finish().catch(() => {
        // The caller's stop() surfaces the rejection.
      });
    }
  }, 250);

  mediaRecorder.start();

  return {
    get durationMs() {
      return currentDuration;
    },
    stop: () => {
      if (cancelled) return Promise.reject(new Error('Recording was cancelled'));
      window.clearInterval(timer);
      return finish();
    },
    cancel: () => {
      if (finished) return;
      cancelled = true;
      window.clearInterval(timer);
      try {
        mediaRecorder.stop();
      } catch {
        // Never started or already stopped.
      }
      stopTracks();
    },
  };
}