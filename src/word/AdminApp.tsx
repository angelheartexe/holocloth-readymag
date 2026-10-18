import { useEffect, useState } from 'react';

interface Entry {
  id: string;
  word: string;
  image: string;
  createdAt: string;
}
interface Data {
  total: number;
  counts: { word: string; count: number }[];
  entries: Entry[];
}

const STORAGE_KEY = 'words-admin-password';

function loadPassword(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function savePassword(value: string) {
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY, value);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked — the password just won't survive a reload.
  }
}

function downloadCsv(entries: Entry[]) {
  const rows = [['date', 'word'], ...entries.map((e) => [e.createdAt, e.word])];
  const csv = rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `words-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function AdminApp() {
  const [password, setPassword] = useState(loadPassword);
  const [input, setInput] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (pw: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/words', { headers: { authorization: `Bearer ${pw}` } });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to load.');
      setData(body);
      setPassword(pw);
      savePassword(pw);
    } catch (err) {
      setError((err as Error).message);
      if (pw === password) {
        setPassword('');
        savePassword('');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (password) load(password);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (id: string) => {
    if (!confirm('Delete this entry?')) return;
    const res = await fetch(`/api/words?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${password}` },
    });
    if (res.ok) load(password);
    else setError('Delete failed.');
  };

  if (!data) {
    return (
      <main className="admin admin--login">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            load(input);
          }}
        >
          <h1>Words</h1>
          <input
            type="password"
            placeholder="Admin password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoFocus
          />
          <button type="submit" className="word__btn word__btn--primary" disabled={loading || !input}>
            {loading ? 'Loading…' : 'Open'}
          </button>
          {error && <p className="word__error">{error}</p>}
        </form>
      </main>
    );
  }

  const max = data.counts[0]?.count ?? 1;

  return (
    <main className="admin">
      <header className="admin__head">
        <h1>
          Words <span className="admin__muted">{data.total} responses</span>
        </h1>
        <div className="admin__actions">
          <button type="button" className="word__btn" onClick={() => load(password)} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" className="word__btn" onClick={() => downloadCsv(data.entries)}>
            Export CSV
          </button>
          <button
            type="button"
            className="word__btn"
            onClick={() => {
              savePassword('');
              setPassword('');
              setData(null);
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      {error && <p className="word__error">{error}</p>}

      <section>
        <h2>Most common</h2>
        {data.counts.length === 0 && <p className="admin__muted">No words yet.</p>}
        <ol className="admin__counts">
          {data.counts.map(({ word, count }) => (
            <li key={word}>
              <span className="admin__word">{word}</span>
              <span className="admin__bar" style={{ width: `${(count / max) * 100}%` }} />
              <span className="admin__count">{count}</span>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2>All responses</h2>
        <ul className="admin__grid">
          {data.entries.map((e) => (
            <li key={e.id} className="admin__card">
              <img src={e.image} alt={`Drawing of “${e.word}”`} loading="lazy" />
              <div className="admin__meta">
                <strong>{e.word}</strong>
                <time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString()}</time>
              </div>
              <button type="button" className="admin__delete" onClick={() => remove(e.id)} aria-label="Delete">
                ×
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
