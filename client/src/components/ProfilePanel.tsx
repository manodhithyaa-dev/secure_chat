import { useEffect, useState } from 'react';
import { useChat } from '../features/chat/ChatContext';
import { useAuth } from '../features/auth/AuthContext';
import { base64ToBytes } from '../crypto';

async function fingerprint(publicKeyBase64: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', base64ToBytes(publicKeyBase64));
  const bytes = new Uint8Array(digest).slice(0, 16);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(':');
}

export default function ProfilePanel({ onClose }: { onClose: () => void }) {
  const chat = useChat();
  const { logout } = useAuth();
  const [print, setPrint] = useState('');

  useEffect(() => {
    if (chat.identity) {
      void fingerprint(chat.identity.publicKeyBase64).then(setPrint);
    }
  }, [chat.identity]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Profile & settings</h2>

        <dl className="profile-list">
          <dt>Display name</dt>
          <dd>{chat.user.displayName}</dd>
          <dt>Username</dt>
          <dd>@{chat.user.username}</dd>
          <dt>Connection</dt>
          <dd>{chat.connection}</dd>
          <dt>Encryption</dt>
          <dd>ECDH P-256 + HKDF-SHA-256 + AES-256-GCM</dd>
          <dt>Identity key fingerprint</dt>
          <dd className="mono">{print || '…'}</dd>
        </dl>

        <p className="muted small">
          Your private identity key is stored only in this browser's IndexedDB and is never sent to
          the server. One device can be signed in per account; signing in elsewhere requires an
          explicit replacement and signs this device out.
        </p>

        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            Close
          </button>
          <button className="danger" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
