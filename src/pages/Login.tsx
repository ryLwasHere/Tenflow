import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { DEMO_USERS, useApp } from '../state';
import { Alert, Logo } from '../components/ui';

export default function Login() {
  const { session, login, expired } = useApp();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (session) return <Navigate to={session.role === 'admin' ? '/config' : '/proses'} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err = login(email);
    setError(err);
    if (!err) nav('/', { replace: true });
  };

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit} noValidate>
        <Logo />
        <div>
          <h1>Masuk</h1>
          <p className="muted">Platform attendance performance. Hanya untuk penggunaan internal.</p>
        </div>
        {expired && <Alert kind="warn" title="Sesi berakhir">Sesi 3 jam telah habis dan seluruh data sesi dihapus. Silakan masuk kembali.</Alert>}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!error} aria-describedby={error ? 'email-err' : undefined} placeholder="nama@tenflow.demo" />
          {error && <span id="email-err" className="err" role="alert">{error}</span>}
        </div>
        <button className="btn primary" type="submit" disabled={!email.trim()}>Masuk</button>
        <div className="demo">
          <span className="hint">Prototipe portofolio: login memakai email dummy tanpa kata sandi. Pilih akun demo:</span>
          {Object.entries(DEMO_USERS).map(([e, role]) => (
            <button key={e} type="button" className="btn sm" onClick={() => { setEmail(e); setError(null); }}>
              <span>{e}</span><span className="muted">{role === 'hr' ? 'HR' : 'Admin'}</span>
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
