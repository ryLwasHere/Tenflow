import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from './state';
import Shell from './components/Shell';
import Login from './pages/Login';
import Process from './pages/Process';
import Dashboard from './pages/Dashboard';
import Config from './pages/Config';
import './styles.css';

// Admin can use everything HR can; only /config is admin-only (HR is redirected to its own home).
function Guard({ roles, children }: { roles: ('hr' | 'admin')[]; children: React.ReactNode }) {
  const { session } = useApp();
  return session && roles.includes(session.role) ? <>{children}</> : <Navigate to="/proses" replace />;
}
function Home() {
  const { session } = useApp();
  return <Navigate to={!session ? '/login' : session.role === 'admin' ? '/config' : '/proses'} replace />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <HashRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Shell />}>
            <Route path="/proses" element={<Guard roles={['hr', 'admin']}><Process /></Guard>} />
            <Route path="/dashboard" element={<Guard roles={['hr', 'admin']}><Dashboard /></Guard>} />
            <Route path="/config" element={<Guard roles={['admin']}><Config /></Guard>} />
          </Route>
          <Route path="*" element={<Home />} />
        </Routes>
      </HashRouter>
    </AppProvider>
  </StrictMode>,
);
