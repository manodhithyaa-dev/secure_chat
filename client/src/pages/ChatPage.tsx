import { useState } from 'react';
import Sidebar from '../components/Sidebar';
import ChatWindow from '../components/ChatWindow';
import ProfilePanel from '../components/ProfilePanel';
import CallScreen from '../components/CallScreen';
import IncomingCallOverlay from '../components/IncomingCallOverlay';
import { useChat } from '../features/chat/ChatContext';

export default function ChatPage() {
  const chat = useChat();
  const [profileOpen, setProfileOpen] = useState(false);

  return (
    <div className="app-shell">
      <Sidebar onOpenProfile={() => setProfileOpen(true)} />
      <ChatWindow />
      {!chat.ready && (
        <div className="boot-overlay">
          <p>Setting up end-to-end encryption…</p>
        </div>
      )}
      {chat.bootError && <div className="boot-error">Startup issue: {chat.bootError}</div>}
      {chat.callError && <div className="notice error call-error">{chat.callError}</div>}
      {chat.callNotice && <div className="call-notice">{chat.callNotice}</div>}
      {chat.call && <CallScreen />}
      {chat.incomingCall && <IncomingCallOverlay />}
      {profileOpen && <ProfilePanel onClose={() => setProfileOpen(false)} />}
    </div>
  );
}
