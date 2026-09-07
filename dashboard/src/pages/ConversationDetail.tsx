import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/context';
import { useToast } from '../components/toast-context';
import { StatusBadge } from '../components/StatusBadge';
import { ErrorState, Spinner } from '../components/States';
import { ApiError, getConversation, takeoverConversation } from '../lib/api';
import { formatTime } from '../lib/time';
import type { Conversation, Message } from '../lib/types';
import { emit, subscribe } from '../realtime/socket';
import styles from './ConversationDetail.module.css';

type UiMessage = Message & { pending?: boolean };

interface JoinAck {
  ok: boolean;
  conversation?: Conversation;
  messages?: Message[];
  error?: { code: string; message: string };
}

interface SendAck {
  ok: boolean;
  id?: string;
  error?: { code: string; message: string };
}

function mergeIncoming(list: UiMessage[], incoming: Message): UiMessage[] {
  if (list.some((m) => m.id === incoming.id)) return list;
  const optimisticIdx = list.findIndex(
    (m) => m.pending && m.role === incoming.role && m.content === incoming.content,
  );
  if (optimisticIdx >= 0) {
    const next = list.slice();
    next[optimisticIdx] = { ...incoming };
    return next;
  }
  return [...list, incoming];
}

const ROLE_LABEL: Record<Message['role'], string> = { VISITOR: 'Visitor', AI: 'AI', AGENT: 'Agent' };

export function ConversationDetail() {
  const { id = '' } = useParams();
  const { agent } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aiTyping, setAiTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [takingOver, setTakingOver] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const tempSeq = useRef(0);
  const typingTimer = useRef<number | undefined>(undefined);

  // --- initial load: join over the socket, fall back to REST ---------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMessages([]);
    setConversation(null);
    stick.current = true;

    emit<JoinAck>('join-conversation', { conversationId: id })
      .then((ack) => {
        if (cancelled) return;
        if (ack.ok && ack.conversation) {
          setConversation(ack.conversation);
          setMessages((ack.messages ?? []).map((m) => ({ ...m })));
          setLoading(false);
        } else {
          throw new Error(ack.error?.message ?? 'join failed');
        }
      })
      .catch(async () => {
        try {
          const { conversation: conv } = await getConversation(id);
          if (cancelled) return;
          setConversation(conv);
          setMessages(conv.messages.map((m) => ({ ...m })));
          setLoading(false);
        } catch {
          if (!cancelled) {
            setError('Could not open this conversation.');
            setLoading(false);
          }
        }
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  // --- live events -------------------------------------------------------
  useEffect(() => {
    const offs = [
      subscribe<Message & { conversationId: string }>('new-message', (msg) => {
        if (msg.conversationId !== id) return;
        setMessages((list) => mergeIncoming(list, msg));
        setAiTyping(false);
      }),
      subscribe<{ conversationId: string }>('ai-typing', (p) => {
        if (p.conversationId !== id) return;
        setAiTyping(true);
        window.clearTimeout(typingTimer.current);
        typingTimer.current = window.setTimeout(() => setAiTyping(false), 4000);
      }),
      subscribe<{ conversationId: string; status?: Conversation['status']; assignedAgentId?: string | null }>(
        'conversation-updated',
        ({ conversationId, status, assignedAgentId }) => {
          if (conversationId !== id) return;
          setConversation((c) =>
            c
              ? {
                  ...c,
                  status: status ?? c.status,
                  assignedAgentId:
                    assignedAgentId === undefined ? c.assignedAgentId : assignedAgentId,
                }
              : c,
          );
        },
      ),
    ];
    return () => {
      offs.forEach((off) => off());
      window.clearTimeout(typingTimer.current);
    };
  }, [id]);

  // --- auto-scroll unless the user scrolled up --------------------------
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useLayoutEffect(() => {
    if (stick.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, aiTyping]);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSendError(null);
    setSending(true);

    tempSeq.current += 1;
    const tempId = `temp-${tempSeq.current}`;
    const optimistic: UiMessage = {
      id: tempId,
      conversationId: id,
      role: 'AGENT',
      content,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setMessages((list) => [...list, optimistic]);
    setDraft('');
    stick.current = true;

    try {
      const ack = await emit<SendAck>('send-message', { conversationId: id, content });
      if (!ack.ok) throw new Error(ack.error?.message ?? 'Send failed');
      // Mark delivered; the echoed `new-message` (same id) will replace it,
      // or reconcile by id here if the echo already landed.
      setMessages((list) =>
        list.map((m) =>
          m.id === tempId ? { ...m, id: ack.id ?? m.id, pending: false } : m,
        ),
      );
    } catch (err) {
      setMessages((list) => list.filter((m) => m.id !== tempId));
      setDraft(content);
      setSendError(err instanceof Error ? err.message : 'Could not send message.');
    } finally {
      setSending(false);
    }
  }, [draft, sending, id]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const doTakeover = async () => {
    setTakingOver(true);
    try {
      const { conversation: conv } = await takeoverConversation(id);
      setConversation(conv);
      toast.push('You have taken over this conversation.', 'success');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.push('Already assigned to another agent.', 'error');
        try {
          const { conversation: conv } = await getConversation(id);
          setConversation(conv);
        } catch {
          /* leave state as-is */
        }
      } else {
        toast.push(err instanceof ApiError ? err.message : 'Could not take over.', 'error');
      }
    } finally {
      setTakingOver(false);
    }
  };

  if (loading) return <Spinner label="Opening conversation…" />;
  if (error || !conversation) {
    return <ErrorState message={error ?? 'Not found.'} onRetry={() => navigate(0)} />;
  }

  const mine = conversation.assignedAgentId && conversation.assignedAgentId === agent?.agentId;
  const canTakeOver =
    conversation.status === 'WAITING' ||
    (conversation.status === 'AI' && !conversation.assignedAgentId);

  return (
    <div className={styles.pane}>
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={() => navigate(-1)} aria-label="Back">
          ‹
        </button>
        <span className={styles.hId}>#{conversation.id.slice(0, 8)}</span>
        <StatusBadge status={conversation.status} />
        <span className={styles.assignee}>
          {conversation.status === 'AGENT'
            ? mine
              ? 'Assigned to you'
              : `Assigned to #${conversation.assignedAgentId?.slice(0, 8)}`
            : ''}
        </span>
        {canTakeOver && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={doTakeover}
            disabled={takingOver}
          >
            {takingOver ? 'Taking over…' : 'Take over'}
          </button>
        )}
      </header>

      <div className={styles.messages} ref={scrollRef} onScroll={onScroll}>
        {messages.map((m) => (
          <div
            key={m.id}
            className={`${styles.msg} ${styles[`role_${m.role}`]} ${m.pending ? styles.pending : ''}`}
          >
            <div className={styles.msgMeta}>
              <span className={styles.msgRole}>{ROLE_LABEL[m.role]}</span>
              <span className={styles.msgTime}>{formatTime(m.createdAt)}</span>
            </div>
            <div className={styles.msgBody}>{m.content}</div>
          </div>
        ))}
        {aiTyping && <div className={styles.typing}>AI is typing…</div>}
      </div>

      <div className={styles.composer}>
        {sendError && <p className="form-msg form-msg-error">{sendError}</p>}
        <div className={styles.composerRow}>
          <textarea
            className="textarea"
            placeholder="Type a reply — Enter to send, Shift+Enter for a new line"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void send()}
            disabled={sending || draft.trim().length === 0}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
