import { useChat } from '../features/chat/ChatContext';
import { Avatar } from './Sidebar';

/** Ringing overlay shown to the callee before they accept. */
export default function IncomingCallOverlay() {
  const chat = useChat();
  const incoming = chat.incomingCall;
  if (!incoming) return null;

  return (
    <div
      className="incoming-call"
      role="dialog"
      aria-label={`Incoming call from ${incoming.caller.displayName}`}
      data-testid="incoming-call"
    >
      <div className="call-card">
        <Avatar name={incoming.caller.displayName} />
        <h2>{incoming.caller.displayName}</h2>
        <p className="call-status call-ringing">
          {incoming.video ? 'Incoming video call…' : 'Incoming call…'}
        </p>
        <div className="call-actions">
          <button
            className="mini danger"
            type="button"
            onClick={() => void chat.declineCall()}
            data-testid="decline-call"
          >
            ✕ Decline
          </button>
          <button
            className="primary"
            type="button"
            onClick={() => void chat.acceptCall()}
            data-testid="accept-call"
          >
            ✓ Accept
          </button>
        </div>
      </div>
    </div>
  );
}