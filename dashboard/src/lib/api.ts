/*
 * Central REST client for the HiveDesk server.
 *  - prepends VITE_API_URL
 *  - injects `Authorization: Bearer <token>` from sessionStorage
 *  - parses the server's `{ error: { message, code } }` envelope into a typed ApiError
 *  - routes every 401 to the registered handler (clears token + redirects to /login)
 */
import { readToken } from './token';
import type {
  Conversation,
  ConversationWithMessages,
  KbEntry,
  Pagination,
  WidgetSettings,
} from './types';

export const API_BASE = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized: () => void = () => {};

/** Registered by AuthProvider — invoked on any 401 response. */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** set false for the login call (no token yet) */
  auth?: boolean;
}

function isErrorEnvelope(value: unknown): value is { error: { message?: string; code?: string } } {
  return typeof value === 'object' && value !== null && 'error' in value;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = readToken();
  if (opts.auth !== false && token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Is it running?');
  }

  if (res.status === 401) {
    onUnauthorized();
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON body — leave data null */
    }
  }

  if (!res.ok) {
    const envelope = isErrorEnvelope(data) ? data.error : {};
    throw new ApiError(
      res.status,
      envelope.code ?? 'REQUEST_ERROR',
      envelope.message ?? `Request failed (${res.status})`,
    );
  }

  return data as T;
}

/* --- endpoints ----------------------------------------------------------- */

export function login(email: string, password: string): Promise<{ token: string }> {
  return request('/auth/login', { method: 'POST', body: { email, password }, auth: false });
}

export interface ConversationFilter {
  status?: string;
  assignedAgentId?: string;
  take?: number;
  skip?: number;
}

export function getConversations(
  filter: ConversationFilter = {},
): Promise<{ conversations: Conversation[]; pagination: Pagination }> {
  const qs = new URLSearchParams();
  if (filter.status) qs.set('status', filter.status);
  if (filter.assignedAgentId) qs.set('assignedAgentId', filter.assignedAgentId);
  qs.set('take', String(filter.take ?? 25));
  qs.set('skip', String(filter.skip ?? 0));
  return request(`/conversations?${qs.toString()}`);
}

export function getConversation(id: string): Promise<{ conversation: ConversationWithMessages }> {
  return request(`/conversations/${encodeURIComponent(id)}`);
}

export function takeoverConversation(id: string): Promise<{ conversation: Conversation }> {
  return request(`/conversations/${encodeURIComponent(id)}/takeover`, { method: 'POST' });
}

export function getSettings(): Promise<WidgetSettings> {
  return request('/tenants/me/settings');
}

export function patchSettings(patch: Partial<WidgetSettings>): Promise<WidgetSettings> {
  return request('/tenants/me/settings', { method: 'PATCH', body: patch });
}

export function listKbEntries(
  take = 25,
  skip = 0,
): Promise<{ entries: KbEntry[]; pagination: Pagination }> {
  return request(`/knowledge-base?take=${take}&skip=${skip}`);
}

export function createKbEntry(input: {
  question: string;
  answer: string;
}): Promise<{ entry: KbEntry }> {
  return request('/knowledge-base', { method: 'POST', body: input });
}

export function updateKbEntry(
  id: string,
  patch: { question?: string; answer?: string },
): Promise<{ entry: KbEntry }> {
  return request(`/knowledge-base/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
}

export function deleteKbEntry(id: string): Promise<void> {
  return request(`/knowledge-base/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
