/*
 * Token storage — deliberately NOT localStorage.
 *
 * The server returns a bare JWT in the login response body (no cookie, no
 * refresh endpoint — see dashboard/README.md). We keep it in memory (React
 * context) and mirror it to sessionStorage only: it survives a reload but not a
 * tab close, and has a smaller XSS blast radius than localStorage. On any 401 or
 * socket connect_error the token is cleared and the user is sent to /login.
 * A real refresh-token flow is a follow-up.
 */
import type { AgentIdentity } from './types';

const KEY = 'hivedesk.token';

export function readToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string): void {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    /* private mode / storage disabled — in-memory context still holds it */
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Decode a JWT payload without verifying the signature (client-side only). */
export function decodeToken(token: string): AgentIdentity | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json) as Partial<AgentIdentity>;
    if (!payload.agentId || !payload.tenantId || typeof payload.exp !== 'number') {
      return null;
    }
    return {
      agentId: payload.agentId,
      tenantId: payload.tenantId,
      role: payload.role ?? 'AGENT',
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

/** True when the token is missing, malformed, or within `skewMs` of expiry. */
export function isExpired(token: string | null, skewMs = 30_000): boolean {
  if (!token) return true;
  const decoded = decodeToken(token);
  if (!decoded) return true;
  return decoded.exp * 1000 - skewMs <= Date.now();
}
