import styles from './States.module.css';

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className={styles.center} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      <span className={styles.muted}>{label}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className={styles.center}>
      <p className={styles.error}>{message}</p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className={styles.center}>
      <p className={styles.emptyTitle}>{title}</p>
      {hint && <p className={styles.muted}>{hint}</p>}
    </div>
  );
}
