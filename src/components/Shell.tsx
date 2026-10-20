import { useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet } from 'react-router-dom';
import { FileSpreadsheet, LayoutDashboard, LogOut, Moon, PanelLeftClose, PanelLeftOpen, Settings2, Sun } from 'lucide-react';
import { useApp, SESSION_MS, WARN_MS } from '../state';
import { Dialog, Logo } from './ui';

const mmss = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

/** Own tick state so the per-second re-render never touches the page tree. */
function SessionGuard() {
  const { session, logout } = useApp();
  const [left, setLeft] = useState(SESSION_MS);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const tick = () => {
      const l = session ? SESSION_MS - (Date.now() - session.startedAt) : SESSION_MS;
      setLeft(l);
      if (session && l <= 0) logout(true);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [session, logout]);
  const warn = left <= WARN_MS && left > 0;
  return (
    <>
      <Dialog open={warn && !dismissed} onClose={() => setDismissed(true)} title="Sesi akan berakhir">
        <div className="dlg">
          <h2>Sesi akan berakhir</h2>
          <p>Sesi berakhir dalam <b className="num">{mmss(left)}</b>. Setelah itu seluruh data karyawan yang sedang diproses dihapus dan Anda keluar otomatis. Selesaikan dan ekspor pekerjaan Anda sekarang.</p>
          <div className="dlg-foot"><button className="btn primary" onClick={() => setDismissed(true)} autoFocus>Mengerti</button></div>
        </div>
      </Dialog>
      {warn && dismissed && <div className="badge warn no-print" role="timer" style={{ position: 'fixed', right: 16, bottom: 16, padding: '6px 12px', boxShadow: 'var(--shadow)' }}>Sesi berakhir dalam {mmss(left)}</div>}
    </>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
  const toggle = () => {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('tenflow.theme', next); } catch { /* theme just won't persist */ }
    setDark(!dark);
  };
  return <button className="btn ghost sm" onClick={toggle} aria-label={dark ? 'Gunakan tema terang' : 'Gunakan tema gelap'} data-tip={dark ? 'Tema terang' : 'Tema gelap'}>{dark ? <Sun /> : <Moon />}</button>;
}

const NAV_KEY = 'tenflow.nav';

export default function Shell() {
  const { session, logout } = useApp();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(NAV_KEY) === '1'; } catch { return false; } });
  if (!session) return <Navigate to="/login" replace />;
  const toggle = () => {
    try { localStorage.setItem(NAV_KEY, collapsed ? '0' : '1'); } catch { /* preference just won't persist */ }
    setCollapsed(!collapsed);
  };
  const link = (to: string, Icon: typeof Settings2, label: string) => (
    <NavLink to={to} title={collapsed ? label : undefined} aria-label={label}><Icon aria-hidden="true" /><span className="lbl">{label}</span></NavLink>
  );
  return (
    <div className="shell" data-collapsed={collapsed}>
      <aside className="side">
        <Logo />
        <nav className="nav" id="main-nav" aria-label="Navigasi utama">
          {link('/proses', FileSpreadsheet, 'Proses Attendance')}
          {link('/dashboard', LayoutDashboard, 'Dashboard')}
          {session.role === 'admin' && link('/config', Settings2, 'Settings & Config')}
        </nav>
        <div className="side-foot">
          <div className="who"><b title={session.email}>{session.email}</b><span className="muted">{session.role === 'hr' ? 'HR (User)' : 'Admin'}</span></div>
          <div className="row">
            <button className="btn ghost sm" onClick={toggle} aria-expanded={!collapsed} aria-controls="main-nav" aria-label={collapsed ? 'Tampilkan navigasi' : 'Sembunyikan navigasi'} data-tip={collapsed ? 'Tampilkan navigasi' : 'Sembunyikan navigasi'}>{collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button>
            <ThemeToggle />
            <button className="btn ghost sm" onClick={() => logout()} aria-label="Keluar dan hapus data sesi" data-tip="Keluar &amp; hapus data sesi"><LogOut /></button>
          </div>
        </div>
      </aside>
      <main className="main"><Outlet /></main>
      <SessionGuard />
    </div>
  );
}
