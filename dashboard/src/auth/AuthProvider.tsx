import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AuthContext } from './context';
import type { AuthValue } from './context';
import { clearToken, decodeToken, isExpired, readToken, writeToken } from '../lib/token';
import { setUnauthorizedHandler } from '../lib/api';
import { connectSocket, disconnectSocket, setSocketAuthErrorHandler } from '../realtime/socket';
import type { AgentIdentity } from '../lib/types';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    const existing = readToken();
    return existing && !isExpired(existing) ? existing : null;
  });

  const agent: AgentIdentity | null = useMemo(
    () => (token ? decodeToken(token) : null),
    [token],
  );

  const logout = useCallback(() => {
    clearToken();
    disconnectSocket();
    setToken(null);
  }, []);

  const login = useCallback((next: string) => {
    writeToken(next);
    connectSocket(next);
    setToken(next);
  }, []);

  // Open the socket as early as possible — synchronously here, before any child
  // effect runs — so a hydrated session has live updates on first paint.
  // connectSocket() is idempotent: a second call just refreshes the auth token.
  if (token) {
    connectSocket(token);
  }

  // A 401 from REST or a permanent socket auth error clears the session and,
  // unless we are already there, sends the agent to /login.
  useEffect(() => {
    const bounce = () => {
      logout();
      if (window.location.pathname !== '/login') {
        window.location.assign('/login');
      }
    };
    setUnauthorizedHandler(bounce);
    setSocketAuthErrorHandler(bounce);
  }, [logout]);

  // Schedule a logout at (exp - skew) so a near-expired token is treated as
  // logged out even without a server round-trip.
  useEffect(() => {
    if (!token) return;
    const decoded = decodeToken(token);
    if (!decoded) {
      logout();
      return;
    }
    const msUntilExpiry = decoded.exp * 1000 - 30_000 - Date.now();
    const timer = window.setTimeout(logout, Math.max(0, msUntilExpiry));
    return () => window.clearTimeout(timer);
  }, [token, logout]);

  const value: AuthValue = useMemo(
    () => ({ token, agent, login, logout }),
    [token, agent, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
