import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type MouseEvent } from 'react';
import { useChat } from '../features/chat/ChatContext';
import {
  startVoiceRecording,
  type VoiceRecording,
} from '../services/recorder';
import type { LocalMessage } from '../types';
import { Avatar } from './Sidebar';

function statusLabel(message: LocalMessage): string {
  if (message.direction !== 'out') return '';
  switch (message.status) {
    case 'pending':
      return '🕓';
    case 'sent':
      return '✓';
    case 'delivered':
      return '✓✓';
    case 'failed':
      return '⚠';
    default:
      return '';
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function AttachmentBody({
  message,
  onOpen,
}: {
  message: LocalMessage;
  onOpen: (message: LocalMessage) => void;
}) {
  const chat = useChat();
  const att = message.attachment;
  if (!att) return null;

  const failed = att.status === 'failed';
  const busy = att.status === 'downloading' || att.status === 'uploading' || att.status === 'preparing';

  if (failed) {
    return (
      <div className="att failed">
        <span className="muted">{att.error || 'Attachment unavailable'}</span>
        <button
          className="mini"
          onClick={() =>
            void (message.direction === 'out'
              ? chat.retryAttachment(message.conversationId, message.id)
              : chat.retryAttachmentDownload(message.conversationId, message.id))
          }
        >
          Retry
        </button>
      </div>
    );
  }

  if (busy) {
    const label =
      att.status === 'preparing' ? 'Preparing…' : att.status === 'uploading' ? 'Uploading…' : 'Downloading…';
    const pct = Math.round((att.progress || 0) * 100);
    return (
      <div className="att busy">
        <span className="muted">{label} {pct}%</span>
        <div className="att-progress"><div style={{ width: `${pct}%` }} /></div>
      </div>
    );
  }

  const objectUrl = att.objectUrl;
  const label = att.kind === 'image' ? '[Photo]' : att.kind === 'audio' ? '[Voice message]' : `[File] ${att.name}`;

  if (att.kind === 'image' && objectUrl) {
    return (
      <div className="att image">
        <img
          className="att-image"
          src={objectUrl}
          alt={att.name}
          onClick={() => onOpen(message)}
        />
        <span className="muted small">{label}</span>
      </div>
    );
  }

  if (att.kind === 'audio' && objectUrl) {
    return (
      <div className="att audio">
        <audio controls src={objectUrl} preload="metadata">
          Your browser does not support audio playback.
        </audio>
        <span className="muted small">{label}{att.meta ? ` · ${formatSize(att.size)}` : ''}</span>
      </div>
    );
  }

  if (objectUrl) {
    return (
      <div className="att file">
        <a
          className="att-download"
          href={objectUrl}
          download={att.name}
          title={`Download ${att.name}`}
        >
          <span className="att-name">{att.name}</span>
          <span className="muted small">{formatSize(att.size)}{message.direction === 'out' ? '' : ''}</span>
        </a>
      </div>
    );
  }

  // Object URL missing but metadata present (e.g. state not yet hydrated).
  return (
    <div className="att stale">
      <span className="muted">[{label}]</span>
      {message.direction === 'in' && (
        <button
          className="mini"
          onClick={() => void chat.retryAttachmentDownload(message.conversationId, message.id)}
        >
          Download
        </button>
      )}
    </div>
  );
}

export default function ChatWindow() {
  const chat = useChat();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [lightbox, setLightbox] = useState<LocalMessage | null>(null);
  const [recording, setRecording] = useState<VoiceRecording | null>(null);
  const [recSeconds, setRecSeconds] = useState(0);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const peer = chat.friends.find((f) => f.id === chat.activePeerId) || null;
  const thread = chat.activePeerId ? chat.messages[chat.activePeerId] ?? [] : [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [thread.length, chat.activePeerId]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = draft;
    setDraft('');
    setSending(true);
    await chat.sendMessage(text);
    setSending(false);
  }

  function onPickFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    for (const file of files) {
      void chat.sendAttachment(file);
    }
  }

  async function beginRecording() {
    setRecordingError(null);
    setRecSeconds(0);
    try {
      const rec = await startVoiceRecording({
        onTick: (ms) => setRecSeconds(Math.floor(ms / 1000)),
      });
      setRecording(rec);
    } catch (err) {
      setRecordingError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Microphone access was denied.'
          : 'Could not start recording. Check your microphone.',
      );
    }
  }

  async function finishRecording() {
    const rec = recording;
    if (!rec) return;
    setRecording(null);
    try {
      const voice = await rec.stop();
      await chat.sendAttachment(voice.file);
    } catch (err) {
      setRecordingError(err instanceof Error ? err.message : 'Recording failed.');
    }
  }

  function cancelRecording() {
    recording?.cancel();
    setRecording(null);
    setRecSeconds(0);
  }

  const closeLightbox = useCallback(() => setLightbox(null), []);
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  useEffect(() => {
    return () => {
      recording?.cancel();
    };
    // Only tear down the microphone when the window unmounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!chat.activePeerId || !peer) {
    return (
      <main className="chat-window empty-state">
        <div>
          <h2>Welcome to SecureChat</h2>
          <p className="muted">
            Select a conversation or add a friend. Messages and files are encrypted on your device
            before they are sent.
          </p>
        </div>
      </main>
    );
  }

  const online = chat.onlineUsers.includes(peer.id);

  return (
    <main className="chat-window">
      <header className="chat-header">
        <Avatar name={peer.displayName} />
        <div className="chat-peer">
          <strong>{peer.displayName}</strong>
          <span className="muted small">{online ? 'online' : 'offline'}</span>
        </div>
        {online && (
          <>
            <button
              className="mini"
              onClick={() => void chat.startCall(peer.id, 'video')}
              title={`Start a video call with ${peer.displayName}`}
              data-testid="start-video-call"
            >
              📹 Video
            </button>
            <button
              className="mini"
              onClick={() => void chat.startCall(peer.id, 'audio')}
              title={`Start an audio call with ${peer.displayName}`}
              data-testid="start-call"
            >
              📞 Call
            </button>
          </>
        )}
        <button className="mini" onClick={() => void chat.retryOutbox()} title="Retry failed sends">
          Retry
        </button>
      </header>

      <div className="message-list" ref={scrollRef}>
        {thread.length === 0 && (
          <p className="empty pad">No messages yet. Say hello — it will be encrypted end to end.</p>
        )}
        {thread.map((m) => (
          <div key={m.id} className={`bubble ${m.direction}`}>
            {m.attachment ? (
              <AttachmentBody message={m} onOpen={setLightbox} />
            ) : (
              <span className="bubble-text">
                {m.error ? <em className="decrypt-error">{m.plaintext || m.error}</em> : m.plaintext}
              </span>
            )}
            <span className="bubble-meta">
              {new Date(m.createdAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
              {m.attachment?.status === 'failed' && attErrorLabel(m)}
              <span className="ticks">{statusLabel(m)}</span>
            </span>
          </div>
        ))}
      </div>

      {chat.peerError && <div className="notice error">{chat.peerError}</div>}
      {recordingError && <div className="notice error">{recordingError}</div>}

      <form className="composer" onSubmit={onSubmit}>
        {recording ? (
          <div className="recorder" role="group" aria-label="Recording in progress">
            <span className="recorder-dot" aria-hidden>●</span>
            <span className="recorder-timer" data-testid="recorder-timer">
              {formatClock(recSeconds)}
            </span>
            <span className="muted small">max 1 minute — it will be encrypted before it is sent.</span>
            <button
              className="mini danger"
              type="button"
              onClick={cancelRecording}
              aria-label="Cancel recording"
            >
              Cancel
            </button>
            <button className="mini" type="button" onClick={() => void finishRecording()}>
              Send
            </button>
          </div>
        ) : (
          <>
            <button
              className="composer-mic"
              type="button"
              title="Record a voice message"
              aria-label="Record a voice message"
              onClick={() => void beginRecording()}
            >
              <span aria-hidden>🎤</span>
            </button>
            <label className="composer-att" title="Attach a file, image or recording">
              <span className="composer-att-icon" aria-hidden>📎</span>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={onPickFiles}
              />
            </label>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type an encrypted message…"
              autoFocus
            />
            <button className="primary" type="submit" disabled={sending || !draft.trim()}>
              Send
            </button>
          </>
        )}
      </form>

      {lightbox?.attachment?.objectUrl && (
        <div className="lightbox" onClick={closeLightbox} role="dialog" aria-label="Image viewer">
          <button className="lightbox-close" onClick={closeLightbox} aria-label="Close">×</button>
          <img
            src={lightbox.attachment.objectUrl}
            alt={lightbox.attachment.name}
            onClick={(e: MouseEvent) => e.stopPropagation()}
          />
          <span className="lightbox-caption">{lightbox.attachment.name}</span>
        </div>
      )}
    </main>
  );
}

function attErrorLabel(message: LocalMessage): string {
  const err = message.attachment?.error;
  return err ? ` · ${err}` : ' · failed';
}