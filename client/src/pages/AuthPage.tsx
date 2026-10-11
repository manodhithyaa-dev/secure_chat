import { useState, type FormEvent } from 'react';
import { useAuth } from '../features/auth/AuthContext';
import { ApiError } from '../services/api';

export default function AuthPage() {
  const { login, register, sessionNotice } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needsReplace, setNeedsReplace] = useState(false);
  const [busy, setBusy] = useState(false);

  function resetPrompts() {
    setError(null);
    setNeedsReplace(false);
  }

  async function doLogin(replace: boolean) {
    setError(null);
    setBusy(true);
    try {
      await login(username.trim(), password, { replace });
    } catch (err) {
      if (!replace && err instanceof ApiError && err.code === 'device_already_registered') {
        setNeedsReplace(true);
        setError(
          'This account already has a registered device. Signing in here will sign that device out.',
        );
      } else {
        setError(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    resetPrompts();
    if (mode === 'login') {
      await doLogin(false);
      return;
    }
    setBusy(true);
    try {
      await register(username.trim(), displayName.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={onSubmit}>
        <div className="auth-brand">
          <span className="brand-mark">SC</span>
          <div>
            <h1>SecureChat</h1>
            <p className="muted">End-to-end encrypted messaging</p>
          </div>
        </div>

        <div className="auth-tabs">
          <button
            type="button"
            className={mode === 'login' ? 'active' : ''}
            onClick={() => {
              setMode('login');
              resetPrompts();
            }}
          >
            Log in
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'active' : ''}
            onClick={() => {
              setMode('register');
              resetPrompts();
            }}
          >
            Register
          </button>
        </div>

        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="lowercase, numbers, underscores"
            autoComplete="username"
            required
          />
        </label>

        {mode === 'register' && (
          <label>
            Display name
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              required
            />
          </label>
        )}

        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
          />
        </label>

        {sessionNotice && <div className="form-notice">{sessionNotice}</div>}

        {error && <div className="form-error">{error}</div>}

        {needsReplace ? (
          <button
            className="danger"
            type="button"
            disabled={busy}
            onClick={() => void doLogin(true)}
          >
            {busy ? 'Please wait…' : 'Sign out the other device and continue'}
          </button>
        ) : (
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        )}

        <p className="muted small">
          Messages are encrypted on your device. Your private key never leaves this browser. One
          device can be signed in per account.
        </p>
      </form>
    </div>
  );
}
