import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/context';
import { ReconnectBanner } from './ReconnectBanner';
import styles from './AppLayout.module.css';

export function AppLayout() {
  const { agent, logout } = useAuth();
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  const closeNav = () => setNavOpen(false);

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <button
          type="button"
          className={styles.hamburger}
          aria-label="Toggle navigation"
          onClick={() => setNavOpen((v) => !v)}
        >
          ☰
        </button>
        <span className={styles.brand}>HiveDesk</span>
      </header>

      <aside className={`${styles.sidebar} ${navOpen ? styles.sidebarOpen : ''}`}>
        <div className={styles.brandFull}>HiveDesk</div>
        <nav className={styles.nav} onClick={closeNav}>
          <NavLink
            to="/"
            end
            className={({ isActive }) => (isActive ? `${styles.link} ${styles.linkActive}` : styles.link)}
          >
            Conversations
          </NavLink>
          <NavLink
            to="/analytics"
            className={({ isActive }) => (isActive ? `${styles.link} ${styles.linkActive}` : styles.link)}
          >
            Analytics
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) => (isActive ? `${styles.link} ${styles.linkActive}` : styles.link)}
          >
            Settings
          </NavLink>
        </nav>
        <div className={styles.footer}>
          {agent && <span className={styles.agentId} title={agent.agentId}>#{agent.agentId.slice(0, 8)}</span>}
          <button type="button" className="btn" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </aside>

      {navOpen && <div className={styles.scrim} onClick={closeNav} />}

      <main className={styles.main}>
        <ReconnectBanner />
        <Outlet />
      </main>
    </div>
  );
}
