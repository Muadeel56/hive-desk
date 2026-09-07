import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { NavLink, Outlet, useMatch, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/context';
import { useToast } from '../components/toast-context';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState, ErrorState, Spinner } from '../components/States';
import { getConversations } from '../lib/api';
import type { ConversationFilter } from '../lib/api';
import { timeAgo } from '../lib/time';
import type { Conversation } from '../lib/types';
import { subscribe } from '../realtime/socket';
import { initialListState, listReducer } from '../state/conversationsReducer';
import styles from './ConversationsView.module.css';

const PAGE = 25;

type FilterKey = 'all' | 'waiting' | 'ai' | 'mine';

const TABS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'waiting', label: 'Needs human' },
  { key: 'ai', label: 'AI-handled' },
  { key: 'mine', label: 'Mine' },
];

const EMPTY_COPY: Record<FilterKey, string> = {
  all: 'No conversations yet.',
  waiting: 'Nothing waiting for a human right now.',
  ai: 'No AI-handled conversations.',
  mine: 'You have not taken over any conversations yet.',
};

function toParams(filter: FilterKey): ConversationFilter {
  switch (filter) {
    case 'waiting':
      return { status: 'WAITING' };
    case 'ai':
      return { status: 'AI' };
    case 'mine':
      return { assignedAgentId: 'me' };
    default:
      return {};
  }
}

export function ConversationsView() {
  const { agent } = useAuth();
  const toast = useToast();
  const agentId = agent?.agentId ?? '';

  const [searchParams, setSearchParams] = useSearchParams();
  const rawFilter = searchParams.get('filter');
  const filter: FilterKey = (TABS.some((t) => t.key === rawFilter) ? rawFilter : 'all') as FilterKey;

  const [state, dispatch] = useReducer(listReducer, initialListState);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);

  const detailMatch = useMatch('/conversations/:id');
  const activeId = detailMatch?.params.id ?? null;

  const matchesFilter = useCallback(
    (c: Conversation): boolean => {
      switch (filter) {
        case 'waiting':
          return c.status === 'WAITING';
        case 'ai':
          return c.status === 'AI';
        case 'mine':
          return c.assignedAgentId === agentId;
        default:
          return true;
      }
    },
    [filter, agentId],
  );

  // Keep the latest list in a ref for socket handlers that need to decide
  // whether an event concerns a row we are currently showing.
  const itemsRef = useRef<Conversation[]>([]);
  useEffect(() => {
    itemsRef.current = state.items;
  }, [state.items]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getConversations({ ...toParams(filter), take: PAGE, skip: 0 });
      dispatch({ type: 'reset', items: res.conversations });
      setTotal(res.pagination.total);
    } catch {
      setError('Could not load conversations.');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const res = await getConversations({
        ...toParams(filter),
        take: PAGE,
        skip: state.items.length,
      });
      dispatch({ type: 'append', items: res.conversations });
      setTotal(res.pagination.total);
    } catch {
      toast.push('Could not load more conversations.', 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  // Live updates — patch in place, never re-fetch the whole list.
  useEffect(() => {
    const offs = [
      subscribe<{ conversation: Conversation }>('conversation-created', ({ conversation }) => {
        dispatch({ type: 'created', conversation });
        if (matchesFilter(conversation)) {
          setTotal((n) => n + 1);
          toast.push('New conversation started.');
        }
      }),
      subscribe<{ conversationId: string }>('conversation-needs-human', ({ conversationId }) => {
        const known = itemsRef.current.some((c) => c.id === conversationId);
        dispatch({ type: 'needs-human', conversationId });
        window.setTimeout(() => dispatch({ type: 'unflag', conversationId }), 6000);
        toast.push('A conversation needs a human.', 'info');
        // Not in the current page and this tab would show it → one targeted reload.
        if (!known && (filter === 'all' || filter === 'waiting')) {
          void load();
        }
      }),
      subscribe<{ conversationId: string; status?: Conversation['status']; assignedAgentId?: string | null }>(
        'conversation-updated',
        ({ conversationId, status, assignedAgentId }) => {
          dispatch({ type: 'updated', conversationId, status, assignedAgentId });
        },
      ),
      subscribe<{ conversationId: string }>('new-message', ({ conversationId }) => {
        dispatch({ type: 'bump', conversationId });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [filter, matchesFilter, load, toast]);

  const visible = useMemo(() => state.items.filter(matchesFilter), [state.items, matchesFilter]);
  const canLoadMore = state.items.length < total;

  const selectTab = (key: FilterKey) => {
    setSearchParams(key === 'all' ? {} : { filter: key }, { replace: true });
  };

  return (
    <div className={`${styles.layout} ${activeId ? styles.detailOpen : ''}`}>
      <section className={styles.listPane}>
        <div className={styles.tabs}>
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`${styles.tab} ${filter === t.key ? styles.tabActive : ''}`}
              onClick={() => selectTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className={styles.list}>
          {loading ? (
            <Spinner label="Loading conversations…" />
          ) : error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : visible.length === 0 ? (
            <EmptyState title={EMPTY_COPY[filter]} hint="New conversations appear here live." />
          ) : (
            <>
              {visible.map((c) => (
                <NavLink
                  key={c.id}
                  to={`/conversations/${c.id}${filter === 'all' ? '' : `?filter=${filter}`}`}
                  className={({ isActive }) =>
                    `${styles.row} ${isActive ? styles.rowActive : ''}`
                  }
                >
                  <div className={styles.rowTop}>
                    <span className={styles.rowId}>#{c.id.slice(0, 8)}</span>
                    <span className={styles.rowTime}>{timeAgo(c.updatedAt)}</span>
                  </div>
                  <div className={styles.rowBottom}>
                    <StatusBadge status={c.status} />
                    {(c.status === 'WAITING' || state.flagged.includes(c.id)) && (
                      <span className={styles.unhandled} title="Needs a human">
                        ● unhandled
                      </span>
                    )}
                  </div>
                </NavLink>
              ))}
              {canLoadMore && (
                <button
                  type="button"
                  className={`btn ${styles.loadMore}`}
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              )}
            </>
          )}
        </div>
      </section>

      <section className={styles.detailPane}>
        <Outlet />
      </section>
    </div>
  );
}

export function SelectConversationPrompt() {
  return (
    <div className={styles.placeholder}>
      <p>Select a conversation to view the transcript.</p>
    </div>
  );
}
