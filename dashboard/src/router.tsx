import { createBrowserRouter, Link } from 'react-router-dom'

// Placeholder routes only — the real agent dashboard is built in Phase 5.
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

function Shell({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 560,
        margin: '10vh auto',
        padding: 24,
      }}
    >
      <h1 style={{ marginBottom: 4 }}>HiveDesk</h1>
      <p style={{ color: '#64748b', marginTop: 0 }}>{title}</p>
      {children}
      <nav style={{ marginTop: 24, display: 'flex', gap: 12 }}>
        <Link to="/">Home</Link>
        <Link to="/login">Login</Link>
      </nav>
      <p style={{ color: '#94a3b8', fontSize: 12, marginTop: 32 }}>API: {API_URL}</p>
    </main>
  )
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: (
      <Shell title="Agent dashboard — placeholder. Real UI lands in Phase 5.">
        <p>Nothing here yet. This scaffold just proves the app builds and serves.</p>
      </Shell>
    ),
  },
  {
    path: '/login',
    element: (
      <Shell title="Login — placeholder">
        <form
          onSubmit={(e) => e.preventDefault()}
          style={{ display: 'grid', gap: 8, maxWidth: 280 }}
        >
          <input placeholder="Email" type="email" />
          <input placeholder="Password" type="password" />
          <button type="submit">Sign in (not wired yet)</button>
        </form>
      </Shell>
    ),
  },
])
