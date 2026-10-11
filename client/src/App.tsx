import { AuthProvider, useAuth } from './features/auth/AuthContext';
import { ChatProvider } from './features/chat/ChatContext';
import AuthPage from './pages/AuthPage';
import ChatPage from './pages/ChatPage';

function Shell() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="splash">
        <span className="brand-mark">SC</span>
        <p className="muted">Loading SecureChat…</p>
      </div>
    );
  }

  if (!user) {
    return <AuthPage />;
  }

  return (
    <ChatProvider key={user.id} user={user}>
      <ChatPage />
    </ChatProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
