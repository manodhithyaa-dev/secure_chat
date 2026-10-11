import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useChat } from '../features/chat/ChatContext';
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

export default function ChatWindow() {
  const chat = useChat();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
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

  if (!chat.activePeerId || !peer) {
    return (
      <main className="chat-window empty-state">
        <div>
          <h2>Welcome to SecureChat</h2>
          <p className="muted">
            Select a conversation or add a friend. Messages are encrypted on your device before
            they are sent.
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
            <span className="bubble-text">
              {m.error ? <em className="decrypt-error">{m.plaintext || m.error}</em> : m.plaintext}
            </span>
            <span className="bubble-meta">
              {new Date(m.createdAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
              {m.error && <span title={m.error}> · {m.error}</span>}
              <span className="ticks">{statusLabel(m)}</span>
            </span>
          </div>
        ))}
      </div>

      {chat.peerError && <div className="notice error">{chat.peerError}</div>}

      <form className="composer" onSubmit={onSubmit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type an encrypted message…"
          autoFocus
        />
        <button className="primary" type="submit" disabled={sending || !draft.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
