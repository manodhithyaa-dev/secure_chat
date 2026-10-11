import { useState } from 'react';
import { useChat } from '../features/chat/ChatContext';
import type { FriendRequestUser, SearchResult } from '../types';

type Tab = 'chats' | 'friends' | 'requests';

function describe(user: FriendRequestUser | { id: string } | null | undefined): {
  name: string;
  username: string;
} {
  if (user && 'displayName' in user) {
    return { name: user.displayName, username: user.username };
  }
  return { name: 'User', username: '' };
}

export default function Sidebar({ onOpenProfile }: { onOpenProfile: () => void }) {
  const chat = useChat();
  const [tab, setTab] = useState<Tab>('chats');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const conversationIds = new Set(chat.conversations.map((c) => c.id));

  // Conversations plus friends with no history yet.
  const chatRows = [
    ...chat.conversations,
    ...chat.friends
      .filter((f) => !conversationIds.has(f.id))
      .map((f) => ({
        id: f.id,
        peerId: f.id,
        peerUsername: f.username,
        peerDisplayName: f.displayName,
        lastMessageAt: 0,
        lastMessagePreview: 'No messages yet',
        unread: 0,
      })),
  ].sort((a, b) => b.lastMessageAt - a.lastMessageAt);

  async function runSearch(value: string) {
    setQuery(value);
    if (value.trim().length < 1) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      setResults(await chat.search(value.trim()));
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function addFriend(username: string) {
    setNotice(null);
    try {
      await chat.addFriend(username);
      setNotice(`Friend request sent to @${username}`);
      setQuery('');
      setResults([]);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not send request');
    }
  }

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <div className="brand">
          <span className="brand-mark">SC</span>
          <strong>SecureChat</strong>
        </div>
        <button className="icon-btn" onClick={onOpenProfile} title="Profile & settings">
          ⚙
        </button>
      </header>

      <div className="tabs">
        <button className={tab === 'chats' ? 'active' : ''} onClick={() => setTab('chats')}>
          Chats
        </button>
        <button className={tab === 'friends' ? 'active' : ''} onClick={() => setTab('friends')}>
          Friends
        </button>
        <button
          className={tab === 'requests' ? 'active' : ''}
          onClick={() => setTab('requests')}
        >
          Requests
          {chat.incoming.length > 0 && <span className="badge">{chat.incoming.length}</span>}
        </button>
      </div>

      {tab !== 'chats' && (
        <div className="search-box">
          <input
            value={query}
            onChange={(e) => void runSearch(e.target.value)}
            placeholder="Search by username…"
          />
        </div>
      )}

      {notice && <div className="notice">{notice}</div>}

      <div className="sidebar-body">
        {tab === 'chats' &&
          (chatRows.length === 0 ? (
            <p className="empty">No conversations yet. Add a friend to start chatting.</p>
          ) : (
            chatRows.map((row) => (
              <button
                key={row.id}
                className={`row ${chat.activePeerId === row.peerId ? 'selected' : ''}`}
                onClick={() => void chat.openConversation(row.peerId)}
              >
                <Avatar name={row.peerDisplayName || row.peerUsername} />
                <div className="row-main">
                  <div className="row-top">
                    <span className="row-name">{row.peerDisplayName || row.peerUsername}</span>
                    {row.unread > 0 && <span className="unread">{row.unread}</span>}
                  </div>
                  <span className="row-sub">{row.lastMessagePreview}</span>
                </div>
              </button>
            ))
          ))}

        {tab === 'friends' && (
          <>
            {searching && <p className="muted small pad">Searching…</p>}
            {results.map((r) => (
              <div key={r.id} className="row static">
                <Avatar name={r.displayName} />
                <div className="row-main">
                  <span className="row-name">{r.displayName}</span>
                  <span className="row-sub">@{r.username}</span>
                </div>
                {r.relationship === 'none' && (
                  <button className="mini" onClick={() => void addFriend(r.username)}>
                    Add
                  </button>
                )}
                {r.relationship === 'pending' && <span className="tag">Pending</span>}
                {r.relationship === 'friends' && <span className="tag ok">Friends</span>}
              </div>
            ))}

            <div className="section-title">Your friends</div>
            {chat.friends.length === 0 && <p className="empty">No friends yet.</p>}
            {chat.friends.map((f) => (
              <button
                key={f.id}
                className={`row ${chat.activePeerId === f.id ? 'selected' : ''}`}
                onClick={() => void chat.openConversation(f.id)}
              >
                <Avatar name={f.displayName} />
                <div className="row-main">
                  <span className="row-name">{f.displayName}</span>
                  <span className="row-sub">
                    @{f.username}
                    {chat.onlineUsers.includes(f.id) ? ' · online' : ''}
                  </span>
                </div>
              </button>
            ))}
          </>
        )}

        {tab === 'requests' && (
          <>
            <div className="section-title">Incoming</div>
            {chat.incoming.length === 0 && <p className="empty">No incoming requests.</p>}
            {chat.incoming.map((r) => {
              const from = describe('from' in r ? r.from : null);
              return (
                <div key={r.id} className="row static">
                  <Avatar name={from.name} />
                  <div className="row-main">
                    <span className="row-name">{from.name}</span>
                    <span className="row-sub">@{from.username}</span>
                  </div>
                  <button className="mini" onClick={() => void chat.acceptRequest(r.id)}>
                    Accept
                  </button>
                  <button className="mini ghost" onClick={() => void chat.rejectRequest(r.id)}>
                    Reject
                  </button>
                </div>
              );
            })}

            <div className="section-title">Outgoing</div>
            {chat.outgoing.length === 0 && <p className="empty">No outgoing requests.</p>}
            {chat.outgoing.map((r) => {
              const to = describe('to' in r ? r.to : null);
              return (
                <div key={r.id} className="row static">
                  <Avatar name={to.name} />
                  <div className="row-main">
                    <span className="row-name">{to.name}</span>
                    <span className="row-sub">Pending</span>
                  </div>
                  <button className="mini ghost" onClick={() => void chat.cancelRequest(r.id)}>
                    Cancel
                  </button>
                </div>
              );
            })}
          </>
        )}
      </div>

      <footer className="sidebar-footer">
        <span className={`dot ${chat.connection}`} />
        {chat.connection === 'connected'
          ? 'Connected'
          : chat.connection === 'connecting'
            ? 'Connecting…'
            : 'Offline'}
      </footer>
    </aside>
  );
}

export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return <span className="avatar">{initials || '?'}</span>;
}
