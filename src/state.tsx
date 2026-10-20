import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Ingested } from './lib/ingest';
import type { Decisions } from './lib/review';
import type { RuleSet } from './lib/rules';
import type { EngineResult } from './lib/types';
import type { ResultFile } from './lib/dashboard';

export type Role = 'hr' | 'admin';
// Dummy login (PRD §4): no password, fixed accounts. Real auth needs a backend.
export const DEMO_USERS: Record<string, Role> = { 'hr@tenflow.demo': 'hr', 'admin@tenflow.demo': 'admin' };
export const SESSION_MS = (Number(import.meta.env.VITE_SESSION_MINUTES) || 180) * 60_000; // FR-03
export const WARN_MS = Math.min(5 * 60_000, SESSION_MS / 2);

interface Session { email: string; role: Role; startedAt: number }
const KEY = 'tenflow.session';

function readSession(): Session | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Session | null;
    return s && DEMO_USERS[s.email] === s.role && Date.now() - s.startedAt < SESSION_MS ? s : null;
  } catch { return null; }
}

export interface ProcState {
  step: 'upload' | 'review' | 'preview' | 'done';
  fp: File | null;
  hr: File | null;
  ing: Ingested | null;
  res: EngineResult | null;
  rules: RuleSet | null;
  decisions: Decisions;
  confirmed: boolean;
  out: { filename: string; checksum: string } | null;
}
export const emptyProc: ProcState = { step: 'upload', fp: null, hr: null, ing: null, res: null, rules: null, decisions: {}, confirmed: false, out: null };

interface Ctx {
  session: Session | null;
  login: (email: string) => string | null;
  logout: (expired?: boolean) => void;
  expired: boolean; // last logout was the 3-hour timeout (FR-03)
  proc: ProcState;
  setProc: (p: Partial<ProcState> | ((p: ProcState) => Partial<ProcState>)) => void;
  dash: ResultFile[];
  setDash: (f: ResultFile[]) => void;
  wipe: () => void;
}
const C = createContext<Ctx>(null!);
export const useApp = () => useContext(C);

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(readSession);
  const [proc, setProcState] = useState<ProcState>(emptyProc);
  const [dash, setDash] = useState<ResultFile[]>([]);
  const [expired, setExpired] = useState(false);

  // Employee data lives only in these two states (FR-27): clearing them is the whole "delete".
  const wipe = useCallback(() => { setProcState(emptyProc); setDash([]); }, []);
  const login = useCallback((email: string) => {
    const e = email.trim().toLowerCase();
    const role = DEMO_USERS[e];
    if (!role) return 'Email tidak terdaftar. Gunakan akun demo di bawah.';
    const s = { email: e, role, startedAt: Date.now() };
    try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch { /* session lives in memory only */ }
    setSession(s);
    setExpired(false);
    return null;
  }, []);
  const logout = useCallback((byTimeout = false) => {
    try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
    setSession(null);
    setExpired(byTimeout);
    wipe();
  }, [wipe]);
  const setProc = useCallback((p: Parameters<Ctx['setProc']>[0]) => setProcState((s) => ({ ...s, ...(typeof p === 'function' ? p(s) : p) })), []);

  const value = useMemo(() => ({ session, login, logout, expired, proc, setProc, dash, setDash, wipe }), [session, login, logout, expired, proc, setProc, dash, wipe]);
  return <C.Provider value={value}>{children}</C.Provider>;
}
