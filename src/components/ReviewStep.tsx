import { useMemo, useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import type { Action, Category, EngineResult, Flag, Outcome, Severity } from '../lib/types';
import { ACTION_LABEL, CATEGORY_LABEL, OUTCOME_LABEL } from '../lib/types';
import type { Decisions } from '../lib/review';
import { Alert, Dialog, Empty, pct } from './ui';
import { dmy } from '../lib/format';

const PAGE = 25;
type Status = 'all' | 'open' | 'done';
type Sort = 'severity' | 'date' | 'category' | 'employee';

/** Quick answers for the most common reasons behind a single tap; they only prefill the form, the reason stays editable and mandatory. */
const TEMPLATES: { id: string; label: string; action: Action; outcome?: Outcome; reason: string; dayOnly: boolean }[] = [
  { id: 'meeting', label: 'Meeting / dinas di luar kantor', action: 'override', outcome: 'compliant', reason: 'Meeting/dinas di luar kantor sehingga hanya satu tap tercatat. ', dayOnly: true },
  { id: 'half', label: 'Cuti setengah hari (1 ALR = 2 setengah hari)', action: 'override', outcome: 'compliant', reason: 'Cuti setengah hari (pagi/sore) yang tidak tercatat di Talenta. ', dayOnly: true },
  { id: 'sick', label: 'Sakit setengah hari', action: 'override', outcome: 'compliant', reason: 'Sakit di tengah hari kerja, pulang lebih awal. ', dayOnly: true },
  { id: 'forgot', label: 'Lupa tap, dikonfirmasi atasan', action: 'override', outcome: 'compliant', reason: 'Lupa tap, dikonfirmasi atasan. ', dayOnly: true },
  { id: 'invalid', label: 'Data tidak valid, keluarkan dari perhitungan', action: 'exclude', reason: 'Data tidak valid, dikeluarkan dari perhitungan. ', dayOnly: false },
];

const sevBadge =(s: Severity) => <span className={`badge ${s === 'kritis' ? 'bad' : 'info'}`}>{s === 'kritis' ? 'Kritis' : 'Informatif'}</span>;

function DecisionDialog({ flags, user, onSave, onClose }: { flags: Flag[]; user: string; onSave: (d: Record<string, import('../lib/types').Decision>) => void; onClose: () => void }) {
  const [action, setAction] = useState<Action>('accept');
  const [outcome, setOutcome] = useState<Outcome>('compliant');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const sameKind = new Set(flags.map((f) => f.category)).size <= 1;
  const canOverride = flags.every((f) => f.scope === 'day');
  const reasonOk = reason.trim().length >= 3;
  const [tpl, setTpl] = useState('');
  const applyTemplate = (id: string) => {
    setTpl(id);
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setAction(t.action); setReason(t.reason);
    if (t.outcome) setOutcome(t.outcome);
  };
  const submit = () => {
    setTouched(true);
    if (!reasonOk || !sameKind) return;
    const at = new Date().toISOString();
    onSave(Object.fromEntries(flags.map((f) => [f.id, { action, reason: reason.trim(), outcome: action === 'override' ? outcome : undefined, by: user, at }])));
  };
  const opt = (a: Action, title: string, text: string, disabled = false) => (
    <label className="radio">
      <input type="radio" name="action" value={a} checked={action === a} disabled={disabled} onChange={() => setAction(a)} />
      <span><b>{title}</b><small>{text}</small></span>
    </label>
  );
  return (
    <div className="dlg" role="group" aria-labelledby="dlg-title">
      <div>
        <h2 id="dlg-title">{flags.length === 1 ? 'Putuskan flag' : `Putuskan ${flags.length} flag`}</h2>
        {flags.length === 1 && <p className="muted" style={{ marginTop: 4 }}>{flags[0].reason}</p>}
      </div>
      {!sameKind && <Alert kind="error">Aksi massal hanya untuk flag sejenis. Pilih flag dari satu kategori yang sama.</Alert>}
      <div className="field">
        <label htmlFor="tpl">Template alasan (opsional)</label>
        <select id="tpl" className="select" value={tpl} onChange={(e) => applyTemplate(e.target.value)}>
          <option value="">Tanpa template</option>
          {TEMPLATES.filter((t) => canOverride || !t.dayOnly).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <span className="hint">Mengisi keputusan dan alasan; lengkapi alasan (siapa yang mengonfirmasi, jam, dll.) sebelum menyimpan.</span>
      </div>
      <div className="stack" style={{ gap: 8 }} role="radiogroup" aria-label="Keputusan">
        {opt('accept', 'Accept', 'Terima hasil sementara sistem apa adanya.')}
        {opt('override', 'Override', canOverride ? 'Tetapkan hasil hari secara manual.' : 'Hanya untuk flag per hari (bukan per karyawan).', !canOverride)}
        {opt('exclude', 'Exclude', 'Keluarkan dari perhitungan (hari atau karyawan tidak dinilai).')}
      </div>
      {action === 'override' && (
        <div className="field">
          <label htmlFor="outcome">Hasil hari ini</label>
          <select id="outcome" className="select" value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome)}>
            {(Object.keys(OUTCOME_LABEL) as Outcome[]).map((o) => <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>)}
          </select>
        </div>
      )}
      <div className="field">
        <label htmlFor="reason">Alasan (wajib)</label>
        <textarea id="reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={touched && !reasonOk} aria-describedby="reason-hint" placeholder="Mis. “Lupa tap pulang, dikonfirmasi atasan”" />
        <span id="reason-hint" className={touched && !reasonOk ? 'err' : 'hint'}>{touched && !reasonOk ? 'Alasan wajib diisi (minimal 3 karakter).' : 'Alasan tercatat di sheet Exception pada file hasil.'}</span>
      </div>
      <div className="dlg-foot">
        <button className="btn" onClick={onClose}>Batal</button>
        <button className="btn primary" onClick={submit} disabled={!sameKind}>Simpan keputusan</button>
      </div>
    </div>
  );
}

export default function ReviewStep({ res, decisions, user, onDecide, onNext }: { res: EngineResult; decisions: Decisions; user: string; onDecide: (d: Decisions) => void; onNext: () => void }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<Category | ''>('');
  const [sev, setSev] = useState<Severity | ''>('');
  const [status, setStatus] = useState<Status>('open');
  const [sort, setSort] = useState<Sort>('severity');
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [dlg, setDlg] = useState<{ flags: Flag[]; key: number } | null>(null); // kept after close so the exit animation has content
  const [dlgOpen, setDlgOpen] = useState(false);

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = res.flags.filter((f) =>
      (!cat || f.category === cat) && (!sev || f.severity === sev) &&
      (status === 'all' || (status === 'open') === !decisions[f.id]) &&
      (!t || `${f.empId} ${f.name} ${f.dept} ${f.reason}`.toLowerCase().includes(t)));
    const k: Record<Sort, (a: Flag, b: Flag) => number> = {
      severity: (a, b) => (a.severity === b.severity ? 0 : a.severity === 'kritis' ? -1 : 1),
      date: (a, b) => a.date.localeCompare(b.date),
      category: (a, b) => a.category.localeCompare(b.category),
      employee: (a, b) => a.empId.localeCompare(b.empId),
    };
    return [...list].sort(k[sort]);
  }, [res.flags, decisions, q, cat, sev, status, sort]);

  const open = res.flags.filter((f) => !decisions[f.id]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const cur = Math.min(page, pages - 1);
  const view = rows.slice(cur * PAGE, cur * PAGE + PAGE);
  const selected = rows.filter((f) => sel.has(f.id)); // only rows currently visible under the filters can be bulk-decided
  const allSel = rows.length > 0 && rows.every((f) => sel.has(f.id));
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(0); };
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const openDlg = (flags: Flag[]) => { setDlg({ flags, key: (dlg?.key ?? 0) + 1 }); setDlgOpen(true); };

  if (!res.flags.length) return (
    <div className="card"><Empty icon={<CheckCircle2 />} title="Tidak ada flag">Semua data dapat dihitung secara pasti. Lanjutkan ke evaluasi.</Empty>
      <div className="pager"><span /><button className="btn primary" onClick={onNext}>Lanjut ke evaluasi</button></div></div>
  );

  return (
    <div className="card">
      <div className="toolbar" role="search">
        <div style={{ position: 'relative' }}>
          <Search aria-hidden="true" style={{ position: 'absolute', left: 10, top: 10, width: 16, height: 16, color: 'var(--muted)' }} />
          <input className="input" style={{ paddingLeft: 32 }} placeholder="Cari ID, nama, alasan…" aria-label="Cari flag" value={q} onChange={(e) => reset(setQ)(e.target.value)} />
        </div>
        <select className="select" aria-label="Kategori" value={cat} onChange={(e) => reset(setCat)(e.target.value as Category | '')}>
          <option value="">Semua kategori</option>
          {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </select>
        <select className="select" aria-label="Severity" value={sev} onChange={(e) => reset(setSev)(e.target.value as Severity | '')}>
          <option value="">Semua severity</option><option value="kritis">Kritis</option><option value="informatif">Informatif</option>
        </select>
        <select className="select" aria-label="Status keputusan" value={status} onChange={(e) => reset(setStatus)(e.target.value as Status)}>
          <option value="open">Belum diputuskan</option><option value="done">Sudah diputuskan</option><option value="all">Semua status</option>
        </select>
        <select className="select" aria-label="Urutkan" value={sort} onChange={(e) => reset(setSort)(e.target.value as Sort)}>
          <option value="severity">Urut: severity</option><option value="date">Urut: tanggal</option><option value="category">Urut: kategori</option><option value="employee">Urut: karyawan</option>
        </select>
      </div>
      {selected.length > 0 && (
        <div className="sel-bar">
          <b>{selected.length} dipilih</b>
          <button className="btn sm primary" onClick={() => openDlg(selected)}>Putuskan terpilih…</button>
          <button className="btn sm ghost" onClick={() => setSel(new Set())}>Batal pilih</button>
        </div>
      )}
      {rows.length === 0 ? (
        <Empty icon={<CheckCircle2 />} title={open.length === 0 ? 'Semua flag sudah diputuskan' : 'Tidak ada flag yang cocok'}>
          {open.length === 0 ? 'Lanjutkan ke evaluasi dan approval.' : 'Ubah filter untuk melihat flag lain.'}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th style={{ width: 36 }}><input type="checkbox" aria-label="Pilih semua hasil filter" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(rows.map((f) => f.id)))} /></th>
              <th>Severity</th><th>Kategori</th><th>Karyawan</th><th>Tanggal</th><th>Alasan sistem</th><th>Keputusan</th><th><span className="sr-only">Aksi</span></th>
            </tr></thead>
            <tbody>
              {view.map((f) => {
                const d = decisions[f.id];
                return (
                  <tr key={f.id}>
                    <td><input type="checkbox" aria-label={`Pilih flag ${f.empId} ${f.date}`} checked={sel.has(f.id)} onChange={() => toggle(f.id)} /></td>
                    <td>{sevBadge(f.severity)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{CATEGORY_LABEL[f.category]}</td>
                    <td><b className="num">{f.empId}</b><div className="muted">{f.name || '—'} · {f.dept || 'tanpa departemen'}</div></td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{f.date ? dmy(f.date) : 'Karyawan'}</td>
                    <td className="reason">{f.reason}</td>
                    <td>{d ? <span className="badge ok" title={d.reason} style={{ whiteSpace: 'normal' }}>{ACTION_LABEL[d.action]}{d.outcome ? `: ${OUTCOME_LABEL[d.outcome]}` : ''}</span> : <span className="badge warn">Belum ditentukan</span>}</td>
                    <td><button className="btn sm" onClick={() => openDlg([f])}>{d ? 'Ubah' : 'Putuskan'}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="pager">
        <span className="muted num">{rows.length} flag · {open.length} belum diputuskan</span>
        <div className="row">
          <button className="btn sm" onClick={() => setPage(cur - 1)} disabled={cur === 0} aria-label="Halaman sebelumnya"><ChevronLeft /></button>
          <span className="num">{cur + 1} / {pages}</span>
          <button className="btn sm" onClick={() => setPage(cur + 1)} disabled={cur >= pages - 1} aria-label="Halaman berikutnya"><ChevronRight /></button>
          <button className="btn primary" onClick={onNext}>Lanjut ke evaluasi{open.length ? ` (${pct(1 - open.length / res.flags.length, 0)} selesai)` : ''}</button>
        </div>
      </div>
      <Dialog open={dlgOpen} onClose={() => setDlgOpen(false)} title="Putuskan flag">
        {dlg && <DecisionDialog key={dlg.key} flags={dlg.flags} user={user} onClose={() => setDlgOpen(false)} onSave={(d) => { onDecide(d); setDlgOpen(false); setSel(new Set()); }} />}
      </Dialog>
    </div>
  );
}
