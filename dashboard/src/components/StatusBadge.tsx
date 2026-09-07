import type { ConversationStatus } from '../lib/types';
import styles from './StatusBadge.module.css';

const LABELS: Record<ConversationStatus, string> = {
  AI: 'AI',
  WAITING: 'Needs human',
  AGENT: 'Agent',
  CLOSED: 'Closed',
};

export function StatusBadge({ status }: { status: ConversationStatus }) {
  return (
    <span className={`${styles.badge} ${styles[status.toLowerCase()]}`}>{LABELS[status]}</span>
  );
}
