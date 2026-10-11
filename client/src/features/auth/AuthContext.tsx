import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../../services/api';
import { onSessionInvalid } from '../../services/session';
import { signChallenge } from '../../crypto/device';
import { ensureDeviceAuth, describeDevice } from './deviceAuth';
import type { DeviceProof, DeviceRegistration, User } from '../../types';

export interface LoginOptions {
  /** Explicitly replace the already-registered device on this account. */
  replace?: boolean;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  /** Set when the browser was signed out involuntarily (e.g. device replaced). */
  sessionNotice: string | null;
  login: (username: string, password: string, options?: LoginOptions) => Promise<void>;
  register: (username: string, displayName: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function buildDeviceCredential(
  username: string,
): Promise<{ device: DeviceRegistration; proof: DeviceProof }> {
  const auth = await ensureDeviceAuth();
  const { challengeId, challenge } = await api.challenge(username);
  const signature = await signChallenge(auth.privateKey, challenge);
  return {
    device: {
      clientDeviceId: auth.clientDeviceId,
      name: describeDevice(),
      signingPublicKey: auth.signingPublicKey,
    },
    proof: { challengeId, signature },
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  useEffect(
    () =>
      onSessionInvalid((notice) => {
        setUser(null);
        setSessionNotice(notice.message);
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((res) => {
        if (!cancelled) setUser(res.user);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(
    async (username: string, password: string, options?: LoginOptions) => {
      const { device, proof } = await buildDeviceCredential(username);
      const res = await api.login({
        username,
        password,
        device,
        proof,
        replace: options?.replace === true,
      });
      setSessionNotice(null);
      setUser(res.user);
    },
    [],
  );

  const register = useCallback(
    async (username: string, displayName: string, password: string) => {
      const { device, proof } = await buildDeviceCredential(username);
      const res = await api.register({ username, displayName, password, device, proof });
      setSessionNotice(null);
      setUser(res.user);
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setSessionNotice(null);
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, sessionNotice, login, register, logout }),
    [user, loading, sessionNotice, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
