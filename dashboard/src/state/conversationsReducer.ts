/*
 * Reducer for the conversation list. Every live socket event is applied as a
 * "patch in place + re-sort" here — the list is never re-fetched wholesale in
 * response to an event. The active filter tab is applied at render time by the
 * component (see ConversationList), so a row that no longer matches simply stops
 * showing without being dropped from state.
 */
import type { Conversation, ConversationStatus } from '../lib/types';

export interface ListState {
  items: Conversation[];
  /** conversation ids pulsed by a recent `conversation-needs-human` event */
  flagged: string[];
}

export type ListAction =
  | { type: 'reset'; items: Conversation[] }
  | { type: 'append'; items: Conversation[] }
  | { type: 'created'; conversation: Conversation }
  | {
      type: 'updated';
      conversationId: string;
      status?: ConversationStatus;
      assignedAgentId?: string | null;
    }
  | { type: 'needs-human'; conversationId: string }
  | { type: 'bump'; conversationId: string }
  | { type: 'unflag'; conversationId: string };

export const initialListState: ListState = { items: [], flagged: [] };

function byUpdatedDesc(a: Conversation, b: Conversation): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function sorted(items: Conversation[]): Conversation[] {
  return [...items].sort(byUpdatedDesc);
}

export function listReducer(state: ListState, action: ListAction): ListState {
  switch (action.type) {
    case 'reset':
      return { items: sorted(action.items), flagged: [] };

    case 'append': {
      const known = new Set(state.items.map((c) => c.id));
      const merged = [...state.items, ...action.items.filter((c) => !known.has(c.id))];
      return { ...state, items: sorted(merged) };
    }

    case 'created': {
      if (state.items.some((c) => c.id === action.conversation.id)) return state;
      return { ...state, items: sorted([action.conversation, ...state.items]) };
    }

    case 'updated': {
      let hit = false;
      const items = state.items.map((c) => {
        if (c.id !== action.conversationId) return c;
        hit = true;
        return {
          ...c,
          status: action.status ?? c.status,
          assignedAgentId:
            action.assignedAgentId === undefined ? c.assignedAgentId : action.assignedAgentId,
          updatedAt: new Date().toISOString(),
        };
      });
      if (!hit) return state;
      return { ...state, items: sorted(items) };
    }

    case 'needs-human': {
      const items = state.items.map((c) =>
        c.id === action.conversationId
          ? { ...c, status: 'WAITING' as ConversationStatus, updatedAt: new Date().toISOString() }
          : c,
      );
      const flagged = state.flagged.includes(action.conversationId)
        ? state.flagged
        : [...state.flagged, action.conversationId];
      return { items: sorted(items), flagged };
    }

    case 'bump': {
      let hit = false;
      const items = state.items.map((c) => {
        if (c.id !== action.conversationId) return c;
        hit = true;
        return { ...c, updatedAt: new Date().toISOString() };
      });
      if (!hit) return state;
      return { ...state, items: sorted(items) };
    }

    case 'unflag':
      return { ...state, flagged: state.flagged.filter((id) => id !== action.conversationId) };

    default:
      return state;
  }
}
