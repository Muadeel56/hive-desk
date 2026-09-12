import { useCallback, useEffect, useState } from 'react';
import { ApiError, getAnalyticsSummary } from '../lib/api';
import { EmptyState, ErrorState, Spinner } from '../components/States';
import type { AnalyticsSnapshot, AnalyticsSummary } from '../lib/types';
import styles from './AnalyticsView.module.css';

const RANGE = 24; // trailing snapshots to fetch for the trend chart

function formatMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return `${hours.toFixed(1)}h`;
}

function formatPct(pct: number): string {
  return `${Math.round(pct * 100)}%`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function AnalyticsView() {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getAnalyticsSummary(RANGE)
      .then(setSummary)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not load analytics.'),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  return (
    <div className={styles.page}>
      <h1 className={styles.h1}>Analytics</h1>

      {loading ? (
        <Spinner label="Loading analytics…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !summary?.latest ? (
        <EmptyState
          title="No analytics yet"
          hint="Check back after the first hourly rollup runs."
        />
      ) : (
        <AnalyticsContent summary={summary} />
      )}
    </div>
  );
}

function AnalyticsContent({ summary }: { summary: AnalyticsSummary }) {
  const { latest, series } = summary;
  if (!latest) return null;

  return (
    <>
      <div className={styles.tiles}>
        <StatTile label="Total conversations" value={String(latest.totalConversations)} />
        <StatTile label="AI-resolved" value={formatPct(latest.aiResolvedPct)} />
        <StatTile label="Avg first response" value={formatMs(latest.avgFirstResponseMs)} />
        <StatTile label="Active agents" value={String(latest.activeAgents)} />
      </div>

      <section className={`card ${styles.card}`}>
        <h2 className={styles.h2}>Conversations trend</h2>
        <ConversationsChart series={series} />
      </section>

      <p className={styles.footnote}>
        Each stat reflects a rolling 24h window as of {formatTime(latest.periodEnd)}. Snapshots
        overlap hour-to-hour, so bars are a trend, not additive daily totals.
      </p>
    </>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className={`card ${styles.tile}`}>
      <span className={styles.tileValue}>{value}</span>
      <span className={styles.tileLabel}>{label}</span>
    </div>
  );
}

function ConversationsChart({ series }: { series: AnalyticsSnapshot[] }) {
  if (series.length === 0) return null;

  const width = 640;
  const height = 160;
  const padding = 8;
  const max = Math.max(1, ...series.map((s) => s.totalConversations));
  const barWidth = (width - padding * 2) / series.length;

  return (
    <>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Conversations per rolling 24h window, from ${formatTime(series[0].periodEnd)} to ${formatTime(series[series.length - 1].periodEnd)}`}
      >
        {series.map((snapshot, i) => {
          const barHeight = (snapshot.totalConversations / max) * (height - padding * 2);
          const x = padding + i * barWidth;
          const y = height - padding - barHeight;
          return (
            <rect
              key={snapshot.id}
              x={x + 1}
              y={y}
              width={Math.max(1, barWidth - 2)}
              height={Math.max(1, barHeight)}
              fill="var(--c-primary)"
            >
              <title>
                {formatTime(snapshot.periodEnd)}: {snapshot.totalConversations} conversations
              </title>
            </rect>
          );
        })}
      </svg>
      <table className={styles.visuallyHidden}>
        <caption>Conversations per rolling 24h window</caption>
        <thead>
          <tr>
            <th>Period end</th>
            <th>Total conversations</th>
          </tr>
        </thead>
        <tbody>
          {series.map((snapshot) => (
            <tr key={snapshot.id}>
              <td>{formatTime(snapshot.periodEnd)}</td>
              <td>{snapshot.totalConversations}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
