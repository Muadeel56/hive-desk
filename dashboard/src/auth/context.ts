import { createContext, useContext } from 'react';
import type { AgentIdentity } from '../lib/types';

export interface AuthValue {
  token: string | null;
  agent: AgentIdentity | null;
  login: (token: string) => void;
  logout: () => void;
}

export const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within <AuthProvider>');
  }
  return ctx;
}
