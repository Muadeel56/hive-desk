import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useToast } from '../components/toast-context';
import { ConfirmButton } from '../components/ConfirmButton';
import { ErrorState, Spinner } from '../components/States';
import {
  ApiError,
  createKbEntry,
  deleteKbEntry,
  getSettings,
  listKbEntries,
  patchSettings,
  updateKbEntry,
} from '../lib/api';
import type { KbEntry, WidgetSettings } from '../lib/types';
import styles from './Settings.module.css';

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const KB_PAGE = 25;

export function Settings() {
  return (
    <div className={styles.page}>
      <h1 className={styles.h1}>Settings</h1>
      <WidgetSettingsCard />
      <KnowledgeBaseCard />
    </div>
  );
}

function WidgetSettingsCard() {
  const toast = useToast();
  const [form, setForm] = useState<WidgetSettings | null>(null);
  const [base, setBase] = useState<WidgetSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    getSettings()
      .then((s) => {
        setForm(s);
        setBase(s);
      })
      .catch(() => setLoadError('Could not load widget settings.'));
  }, []);

  useEffect(load, [load]);

  if (loadError) return <ErrorState message={loadError} onRetry={load} />;
  if (!form || !base) return <Spinner label="Loading settings…" />;

  const brandValid = HEX.test(form.brandColor);
  const nameValid = form.displayName.trim().length >= 1 && form.displayName.trim().length <= 120;
  const welcomeValid = form.welcomeMessage.length <= 500;
  const dirty =
    form.displayName !== base.displayName ||
    form.welcomeMessage !== base.welcomeMessage ||
    form.brandColor !== base.brandColor;
  const canSave = dirty && brandValid && nameValid && welcomeValid && !saving;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    const patch: Partial<WidgetSettings> = {};
    if (form.displayName !== base.displayName) patch.displayName = form.displayName.trim();
    if (form.welcomeMessage !== base.welcomeMessage) patch.welcomeMessage = form.welcomeMessage;
    if (form.brandColor !== base.brandColor) patch.brandColor = form.brandColor;
    try {
      const updated = await patchSettings(patch);
      setForm(updated);
      setBase(updated);
      toast.push('Widget settings saved.', 'success');
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not save settings.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={`card ${styles.card}`} onSubmit={onSubmit}>
      <h2 className={styles.h2}>Widget</h2>

      <div className="field">
        <label htmlFor="displayName">Display name</label>
        <input
          id="displayName"
          className="input"
          value={form.displayName}
          maxLength={120}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="welcomeMessage">Welcome message</label>
        <textarea
          id="welcomeMessage"
          className="textarea"
          value={form.welcomeMessage}
          maxLength={500}
          onChange={(e) => setForm({ ...form, welcomeMessage: e.target.value })}
        />
        <span className={styles.counter}>{form.welcomeMessage.length}/500</span>
      </div>

      <div className="field">
        <label htmlFor="brandColor">Brand color</label>
        <div className={styles.colorRow}>
          <input
            id="brandColor"
            type="color"
            value={brandValid ? form.brandColor : '#2563eb'}
            onChange={(e) => setForm({ ...form, brandColor: e.target.value })}
          />
          <input
            className="input"
            value={form.brandColor}
            onChange={(e) => setForm({ ...form, brandColor: e.target.value })}
            aria-label="Brand color hex"
          />
        </div>
        {!brandValid && <span className="form-msg form-msg-error">Enter a hex color like #2563eb.</span>}
      </div>

      <button type="submit" className="btn btn-primary" disabled={!canSave}>
        {saving ? 'Saving…' : 'Save widget settings'}
      </button>
    </form>
  );
}

function KnowledgeBaseCard() {
  const toast = useToast();
  const [entries, setEntries] = useState<KbEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [creating, setCreating] = useState(false);

  const loadFirst = useCallback(() => {
    setLoading(true);
    setError(null);
    listKbEntries(KB_PAGE, 0)
      .then((res) => {
        setEntries(res.entries);
        setTotal(res.pagination.total);
      })
      .catch(() => setError('Could not load the knowledge base.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(loadFirst, [loadFirst]);

  const loadMore = async () => {
    try {
      const res = await listKbEntries(KB_PAGE, entries.length);
      setEntries((cur) => {
        const known = new Set(cur.map((e) => e.id));
        return [...cur, ...res.entries.filter((e) => !known.has(e.id))];
      });
      setTotal(res.pagination.total);
    } catch {
      toast.push('Could not load more entries.', 'error');
    }
  };

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    const a = answer.trim();
    if (q.length < 3 || a.length < 1 || creating) return;
    setCreating(true);
    try {
      const { entry } = await createKbEntry({ question: q, answer: a });
      setEntries((cur) => [entry, ...cur]);
      setTotal((n) => n + 1);
      setQuestion('');
      setAnswer('');
      toast.push('Entry added.', 'success');
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not add entry.', 'error');
    } finally {
      setCreating(false);
    }
  };

  const onSaveEntry = async (id: string, patch: { question: string; answer: string }) => {
    const { entry } = await updateKbEntry(id, patch);
    setEntries((cur) => cur.map((e) => (e.id === id ? entry : e)));
    toast.push('Entry updated.', 'success');
  };

  const onDeleteEntry = async (id: string) => {
    try {
      await deleteKbEntry(id);
      setEntries((cur) => cur.filter((e) => e.id !== id));
      setTotal((n) => Math.max(0, n - 1));
      toast.push('Entry deleted.', 'success');
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not delete entry.', 'error');
    }
  };

  return (
    <section className={`card ${styles.card}`}>
      <h2 className={styles.h2}>Knowledge base</h2>

      <form className={styles.createForm} onSubmit={onCreate}>
        <div className="field">
          <label htmlFor="kb-q">Question</label>
          <input
            id="kb-q"
            className="input"
            value={question}
            maxLength={500}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What are your opening hours?"
          />
        </div>
        <div className="field">
          <label htmlFor="kb-a">Answer</label>
          <textarea
            id="kb-a"
            className="textarea"
            value={answer}
            maxLength={5000}
            onChange={(e) => setAnswer(e.target.value)}
          />
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={creating || question.trim().length < 3 || answer.trim().length < 1}
        >
          {creating ? 'Adding…' : 'Add entry'}
        </button>
      </form>

      <div className={styles.kbList}>
        {loading ? (
          <Spinner label="Loading entries…" />
        ) : error ? (
          <ErrorState message={error} onRetry={loadFirst} />
        ) : entries.length === 0 ? (
          <p className={styles.muted}>No entries yet. Add the FAQs your AI should answer from.</p>
        ) : (
          <>
            {entries.map((entry) => (
              <KbRow
                key={entry.id}
                entry={entry}
                onSave={onSaveEntry}
                onDelete={onDeleteEntry}
              />
            ))}
            {entries.length < total && (
              <button type="button" className="btn" onClick={loadMore}>
                Load more
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function KbRow({
  entry,
  onSave,
  onDelete,
}: {
  entry: KbEntry;
  onSave: (id: string, patch: { question: string; answer: string }) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState(entry.question);
  const [a, setA] = useState(entry.answer);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await onSave(entry.id, { question: q.trim(), answer: a.trim() });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className={styles.kbRow}>
        <p className={styles.kbQ}>{entry.question}</p>
        <p className={styles.kbA}>{entry.answer}</p>
        <div className={styles.kbActions}>
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            Edit
          </button>
          <ConfirmButton label="Delete" confirmLabel="Delete?" onConfirm={() => onDelete(entry.id)} />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.kbRow}>
      <div className="field">
        <label htmlFor={`q-${entry.id}`}>Question</label>
        <input
          id={`q-${entry.id}`}
          className="input"
          value={q}
          maxLength={500}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`a-${entry.id}`}>Answer</label>
        <textarea
          id={`a-${entry.id}`}
          className="textarea"
          value={a}
          maxLength={5000}
          onChange={(e) => setA(e.target.value)}
        />
      </div>
      <div className={styles.kbActions}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={saving || q.trim().length < 3 || a.trim().length < 1}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setQ(entry.question);
            setA(entry.answer);
            setEditing(false);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
