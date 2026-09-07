/** Shared API/domain types, mirrored from the server's Prisma schema. */

export type ConversationStatus = 'AI' | 'WAITING' | 'AGENT' | 'CLOSED';
export type MessageRole = 'VISITOR' | 'AI' | 'AGENT';

export interface Conversation {
  id: string;
  tenantId: string;
  visitorSessionId: string;
  status: ConversationStatus;
  assignedAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface ConversationWithMessages extends Conversation {
  messages: Message[];
}

export interface Pagination {
  total: number;
  take: number;
  skip: number;
}

export interface WidgetSettings {
  displayName: string;
  welcomeMessage: string;
  brandColor: string;
}

export interface KbEntry {
  id: string;
  tenantId: string;
  question: string;
  answer: string;
  createdAt: string;
  updatedAt: string;
}

/** Decoded JWT payload minted by the server (`POST /auth/login`). */
export interface AgentIdentity {
  agentId: string;
  tenantId: string;
  role: string;
  /** epoch seconds */
  exp: number;
}
