import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, CheckCircle2, Search } from 'lucide-react';
import type { EngineResult, HrisRow } from '../lib/types';
import { CATEGORY_LABEL } from '../lib/types';
import type { RuleSet } from '../lib/rules';
import type { Decisions } from '../lib/review';
import { MODE_LABEL, WFO_STATUS_LABEL, evaluateAttendance, type DayStatus, type Mode, type WfoRow, type WfoStatus } from '../lib/compliance';
import { Alert, Empty, pct } from './ui';
import { dmy } from '../lib/format';

const PAGE = 25;
type Tab = 'ringkasan' | 'harian' | 'wfo' | 'shift' | 'kualitas';
const TABS: [Tab, string][] = [['ringkasan', 'Ringkasan'], ['harian', 'Harian'], ['wfo', 'Kepatuhan WFO'], ['shift', 'Shift & jadwal'], ['kualitas', 'Kualitas data']];

const MODE_TONE: Record<Mode, string> = { wfo: 'ok', wfh: 'info', dinas: 'info', leave: 'info', leave_partial: 'warn', no_evidence: 'warn', pending: 'warn', excluded: '', off: '', off_presence: 'warn' };
const STATUS_TONE: Record<WfoStatus, string> = { patuh: 'ok', tidak_patuh: 'bad', review: 'warn', tanpa_kewajiban: '' };
const timeBadge = (v: DayStatus['late'], label: string) => v === 'ya' ? <span className="badge bad">{label}</span> : v === 'belum dihitung' ? <span className="badge warn" title="Jadwal tidak dapat ditentukan: tidak dihitung">Belum dihitung</span> : <span className="muted">{v === 'tidak' ? '–' : 'n/a'}</span>;
const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort();

function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  return (
    <div className="pager">
      <span className="muted num">{total.toLocaleString('id-ID')} baris</span>
      <div className="row">
        <button className="btn sm" onClick={() => onPage(page - 1)} disabled={page === 0} aria-label="Halaman sebelumnya"><ChevronLeft /></button>
        <span className="num">{page + 1} / {pages}</span>
        <button className="btn sm" onClick={() => onPage(page + 1)} disabled={page >= pages - 1} aria-label="Halaman berikutnya"><ChevronRight /></button>
      </div>
    </div>
  );
}

const Stat = ({ k, v, s }: { k: string; v: ReactNode; s?: ReactNode }) => <div className="stat"><span className="k">{k}</span><span className="v">{v}</span>{s && <span className="s">{s}</span>}</div>;

export default function ComplianceView({ res, hris, rules, decisions, onReview }: { res: EngineResult; hris: HrisRow[]; rules: RuleSet; decisions: Decisions; onReview: () => void }) {
  const ev = useMemo(() => evaluateAttendance(res, hris, rules, decisions), [res, hris, rules, decisions]);
  const [tab, setTab] = useState<Tab>('ringkasan');
  const { summary: s, days, rows } = ev;
  const P = rules.params;
  const depts = useMemo(() => uniq(rows.map((r) => r.dept)), [rows]);

  return (
    <div className="card">
      <div className="tabs" role="tablist" aria-label="Evaluasi attendance">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <div role="tabpanel" aria-label={TABS.find(([k]) => k === tab)![1]}>
        {tab === 'ringkasan' && <Overview s={s} rows={rows} depts={depts} rules={rules} res={res} onReview={onReview} />}
        {tab === 'harian' && <Daily days={days} depts={depts} />}
        {tab === 'wfo' && <Wfo rows={rows} depts={depts} P={P} />}
        {tab === 'shift' && <Shifts days={days} basis={P.scheduleBasis} />}
        {tab === 'kualitas' && <Quality days={days} res={res} s={s} onReview={onReview} />}
      </div>
    </div>
  );
}

function Overview({ s, rows, depts, rules, res, onReview }: { s: ReturnType<typeof evaluateAttendance>['summary']; rows: WfoRow[]; depts: string[]; rules: RuleSet; res: EngineResult; onReview: () => void }) {
  const P = rules.params;
  const byDept = depts.map((d) => { const x = rows.filter((r) => r.dept === d); const req = x.reduce((a, r) => a + r.required, 0), cr = x.reduce((a, r) => a + r.credited, 0); return { d, n: x.length, req, cr, review: x.filter((r) => r.status === 'review').length, bad: x.filter((r) => r.status === 'tidak_patuh').length }; });
  const open = res.flags.filter((f) => f.severity === 'kritis').length;
  return (
    <div className="card-pad stack" style={{ gap: 16 }}>
      {s.status.review > 0 && <Alert kind="warn" title={`${s.status.review} karyawan berstatus "Perlu review HR"`}>Hasil kepatuhan mereka belum dapat dipastikan karena ada hari yang belum diputuskan atau data pendukung belum ada. Mereka tidak dihitung sebagai pelanggaran. <button className="btn sm" onClick={onReview}>Buka review exception</button></Alert>}
      <div className="metrics">
        <Stat k="Karyawan dievaluasi" v={s.employees} s={`${res.employees.length - s.employees} dikeluarkan oleh HR`} />
        <Stat k="Hadir fisik di kantor" v={s.physical} s={`karyawan dengan ≥1 hari WFO terverifikasi · ${s.byMode.wfo.toLocaleString('id-ID')} hari`} />
        <Stat k="WFH" v={s.wfhEmployees} s={`karyawan · ${s.byMode.wfh.toLocaleString('id-ID')} hari (bukan actual WFO)`} />
        <Stat k="Kepatuhan WFO" v={pct(s.rate)} s={`${s.credited.toLocaleString('id-ID')} hari terkredit ÷ ${s.required.toLocaleString('id-ID')} hari wajib`} />
        <Stat k="Patuh / Tidak patuh / Review" v={`${s.status.patuh} / ${s.status.tidak_patuh} / ${s.status.review}`} s={`${s.status.tanpa_kewajiban} tanpa kewajiban WFO`} />
      </div>
      <div className="metrics">
        <Stat k="Hari terlambat" v={s.late} s={`${s.lateEmployees} karyawan`} />
        <Stat k="Hari pulang awal" v={s.early} s={`${s.earlyEmployees} karyawan`} />
        <Stat k="Event tap hilang" v={s.missing} s="hari tanpa tap masuk atau pulang" />
        <Stat k="Hari perlu review HR" v={s.reviewDays} s={`${open} flag kritis pada periode ini`} />
        <Stat k="Tap duplikat" v={s.duplicateDays} s={`hari · ${res.stats.exactDup} persis sama, tetap tercatat`} />
      </div>
      <section aria-labelledby="ov-dept">
        <h3 id="ov-dept">Per departemen</h3>
        <div className="table-wrap"><table className="dense">
          <thead><tr><th>Departemen</th><th className="r">Karyawan</th><th className="r">WFO wajib</th><th className="r">Terkredit</th><th className="r">Kepatuhan</th><th className="r">Tidak patuh</th><th className="r">Perlu review</th></tr></thead>
          <tbody>{byDept.map((x) => <tr key={x.d}><td>{x.d || '(tanpa departemen)'}</td><td className="r num">{x.n}</td><td className="r num">{x.req}</td><td className="r num">{x.cr}</td><td className="r num"><b>{pct(x.req ? x.cr / x.req : null)}</b></td><td className="r num">{x.bad}</td><td className="r num">{x.review}</td></tr>)}</tbody>
        </table></div>
      </section>
      <details>
        <summary><b>Definisi metrik dan kebijakan yang dipakai</b></summary>
        <ul className="stack" style={{ gap: 6, marginTop: 8, paddingLeft: 20 }}>
          <li><b>Hadir fisik / WFO terverifikasi</b>: hari terjadwal yang punya tap fingerprint dan flag-nya sudah diputuskan. Catatan Talenta tidak dihitung sebagai WFO{P.hrisOnlyPresence === 1 ? ', kecuali untuk karyawan yang tidak punya satu pun tap fingerprint pada periode ini: Check In Talenta mereka dihitung hadir di kantor (kebijakan Config)' : ''}.</li>
          <li><b>WFH</b>: hari kerja tanpa tap fingerprint yang berstatus WFH di Talenta{P.inferWfhFromTalenta === 1 ? ', atau memiliki Check In Talenta (kebijakan aktif: catatan Talenta tanpa fingerprint = WFH)' : ' (kebijakan "catatan Talenta tanpa fingerprint = WFH" nonaktif: hari seperti itu berstatus "Tanpa bukti kehadiran")'}.</li>
          <li><b>WFO wajib</b> per minggu (Senin–Minggu, dipotong sesuai periode) = maks(0, min({P.wfoDaysPerWeek} hari WFO, hari terjadwal − cuti disetujui{P.leaveConsumesWfhAllowance === 1 ? '' : ` − jatah WFH ${P.wfhDaysPerWeek} hari`})). <b>Terkredit</b> = min(WFO fisik, wajib). <b>Kepatuhan</b> = Σ terkredit ÷ Σ wajib; patuh bila ≥ {P.wfoCompliancePct}%.</li>
          <li><b>Tidak patuh</b> hanya bila selisih tetap ada walau setiap hari yang belum pasti berpihak pada karyawan. Selain itu hasilnya <b>Perlu review HR</b>: tidak ada fingerprint bukan bukti absen.</li>
          <li><b>Cuti disetujui</b> mengurangi kewajiban hanya bila status Approved tersedia{P.missingApprovalAsApproved === 1 ? ' (Config: cuti tanpa status dianggap disetujui)' : '; tanpa status persetujuan, cuti belum memberi pengecualian'}.</li>
          <li><b>Terlambat / pulang awal</b>: {P.scheduleBasis === 1 ? `terhadap jam shift HRIS hari itu (toleransi masuk ${P.lateToleranceMin} menit, pulang ${P.earlyToleranceMin} menit)` : 'terhadap Work Schedule karyawan (rumus sheet perusahaan)'}; cuti sebagian hari yang disetujui menggeser batasnya. Hari tanpa jadwal yang jelas berstatus "Belum dihitung", bukan pelanggaran.</li>
        </ul>
        <p className="hint" style={{ marginTop: 8 }}>Butir bertanda perlu konfirmasi HR (dasar jadwal, toleransi, jatah WFH, perlakuan cuti, istirahat siang) dapat diubah Admin di Settings &amp; Config dan tercatat di versi rule.</p>
      </details>
    </div>
  );
}

function Daily({ days, depts }: { days: DayStatus[]; depts: string[] }) {
  const [q, setQ] = useState(''), [dept, setDept] = useState(''), [cat, setCat] = useState(''), [shift, setShift] = useState(''), [mode, setMode] = useState<Mode | ''>(''), [rev, setRev] = useState(''), [time, setTime] = useState('');
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [page, setPage] = useState(0), [openKey, setOpenKey] = useState<string | null>(null);
  const cats = useMemo(() => uniq(days.map((d) => d.category)), [days]), shifts = useMemo(() => uniq(days.map((d) => d.shift)), [days]);
  const f = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(0); };
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return days.filter((d) => (!t || `${d.empId} ${d.name}`.toLowerCase().includes(t)) && (!dept || d.dept === dept) && (!cat || d.category === cat) && (!shift || d.shift === shift) && (!mode || d.mode === mode)
      && (!from || d.date >= from) && (!to || d.date <= to)
      && (!rev || (rev === 'yes') === (d.unresolved || d.openFlags > 0))
      && (!time || (time === 'late' ? d.late === 'ya' : time === 'early' ? d.early === 'ya' : d.late === 'belum dihitung' || d.early === 'belum dihitung')));
  }, [days, q, dept, cat, shift, mode, rev, time, from, to]);
  const cur = Math.min(page, Math.max(0, Math.ceil(list.length / PAGE) - 1));
  const view = list.slice(cur * PAGE, cur * PAGE + PAGE);
  const ids = new Set(list.map((d) => d.empId));
  const one = ids.size === 1 && q.trim() ? list : null; // an employee search doubles as that employee's attendance history
  return (
    <>
      <div className="toolbar" role="search">
        <div style={{ position: 'relative' }}>
          <Search aria-hidden="true" style={{ position: 'absolute', left: 10, top: 10, width: 16, height: 16, color: 'var(--muted)' }} />
          <input className="input" style={{ paddingLeft: 32 }} placeholder="ID atau nama karyawan…" aria-label="Cari karyawan" value={q} onChange={(e) => f(setQ)(e.target.value)} />
        </div>
        <select className="select" aria-label="Departemen" value={dept} onChange={(e) => f(setDept)(e.target.value)}><option value="">Semua departemen</option>{depts.map((d) => <option key={d} value={d}>{d || '(tanpa departemen)'}</option>)}</select>
        <select className="select" aria-label="Kategori jadwal" value={cat} onChange={(e) => f(setCat)(e.target.value)}><option value="">Semua kategori</option>{cats.map((c) => <option key={c}>{c}</option>)}</select>
        <select className="select" aria-label="Shift" value={shift} onChange={(e) => f(setShift)(e.target.value)}><option value="">Semua shift</option>{shifts.map((c) => <option key={c}>{c}</option>)}</select>
        <select className="select" aria-label="Mode kerja" value={mode} onChange={(e) => f(setMode)(e.target.value as Mode | '')}><option value="">Semua mode</option>{(Object.keys(MODE_LABEL) as Mode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}</select>
        <select className="select" aria-label="Status review" value={rev} onChange={(e) => f(setRev)(e.target.value)}><option value="">Semua status review</option><option value="yes">Perlu review</option><option value="no">Tanpa review</option></select>
        <select className="select" aria-label="Ketepatan waktu" value={time} onChange={(e) => f(setTime)(e.target.value)}><option value="">Semua ketepatan waktu</option><option value="late">Terlambat</option><option value="early">Pulang awal</option><option value="na">Belum dihitung</option></select>
        <label className="row" style={{ gap: 4 }}><span className="hint">Dari</span><input type="date" className="input" style={{ width: 150 }} aria-label="Dari tanggal" value={from} onChange={(e) => f(setFrom)(e.target.value)} /></label>
        <label className="row" style={{ gap: 4 }}><span className="hint">Sampai</span><input type="date" className="input" style={{ width: 150 }} aria-label="Sampai tanggal" value={to} onChange={(e) => f(setTo)(e.target.value)} /></label>
      </div>
      {one && (
        <div className="sel-bar" role="status">
          <b>Riwayat ID {one[0].empId}</b><span>{one[0].name} · {one.filter((d) => d.mode === 'wfo').length} hari WFO · {one.filter((d) => d.mode === 'wfh').length} WFH · {one.filter((d) => d.mode === 'leave' || d.mode === 'leave_partial').length} cuti · {one.filter((d) => d.late === 'ya').length} terlambat · {one.filter((d) => d.early === 'ya').length} pulang awal</span>
        </div>
      )}
      {list.length === 0 ? <Empty icon={<CheckCircle2 />} title="Tidak ada hari yang cocok">Ubah filter untuk melihat data lain.</Empty> : (
        <div className="table-wrap">
          <table className="dense">
            <thead><tr><th>Tanggal</th><th>Karyawan</th><th>Jadwal</th><th>Mode kerja</th><th>Fingerprint</th><th>Talenta</th><th>Terlambat</th><th>Pulang awal</th><th>Review</th><th><span className="sr-only">Detail</span></th></tr></thead>
            <tbody>
              {view.flatMap((d) => {
                const k = `${d.empId}|${d.date}`, isOpen = openKey === k;
                const first = d.evidence.split(', ')[0], last = d.evidence.split(', ').slice(-1)[0];
                return [
                  <tr key={k}>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{dmy(d.date)}</td>
                    <td><b className="num">{d.empId}</b><div className="muted">{d.name || '—'} · {d.dept || 'tanpa departemen'}</div></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{d.shift || '—'}<div className="muted">{d.category ?? 'tidak terpetakan'}{d.hours ? ` · ${d.hours}` : ''}</div></td>
                    <td><span className={`badge ${MODE_TONE[d.mode]}`}>{MODE_LABEL[d.mode]}</span></td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }} title={d.evidence}>{d.evidence ? (first === last ? first : `${first.split(' ')[0]} … ${last.split(' ')[0]}`) : <span className="muted">tidak ada</span>}</td>
                    <td className="muted wrap">{d.leave || d.talenta || '—'}</td>
                    <td>{timeBadge(d.late, 'Terlambat')}</td>
                    <td>{timeBadge(d.early, 'Pulang awal')}</td>
                    <td className="reason">{d.unresolved || d.openFlags > 0 ? <span className="badge warn">Perlu review</span> : d.review ? <span className="badge">Catatan</span> : null}{d.review && <div className="muted">{d.review}</div>}</td>
                    <td><button className="btn sm ghost" aria-expanded={isOpen} aria-label={`Mengapa status ${d.empId} ${d.date}`} onClick={() => setOpenKey(isOpen ? null : k)}><ChevronDown style={{ transform: isOpen ? 'rotate(180deg)' : undefined }} /></button></td>
                  </tr>,
                  isOpen && (
                    <tr key={`${k}-d`}><td colSpan={10} className="detail">
                      <dl className="stack" style={{ gap: 4, margin: 0 }}>
                        <div><b>Mengapa status ini?</b> {MODE_LABEL[d.mode]}.{d.late === 'belum dihitung' ? ' Keterlambatan dan pulang awal belum dihitung karena jadwal tidak dapat ditentukan.' : ''}</div>
                        <div><b>Dasar penilaian waktu:</b> {d.basis || 'tidak ada tap pada hari ini'}</div>
                        <div><b>Bukti fingerprint:</b> {d.evidence || 'tidak ada tap'}</div>
                        <div><b>Talenta:</b> {d.talenta || '—'}{d.leave ? ` · ${d.leave}` : ''}</div>
                        <div><b>Hasil sistem:</b> terlambat {d.sysLate == null ? '–' : d.sysLate ? 'ya' : 'tidak'}, pulang awal {d.sysEarly == null ? '–' : d.sysEarly ? 'ya' : 'tidak'} (hasil sistem tidak berubah oleh keputusan HR)</div>
                        {d.decision && <div><b>Keputusan HR:</b> {d.decision}</div>}
                        <div><b>Sumber data:</b> {d.source || '—'}</div>
                        {d.review && <div><b>Perlu perhatian:</b> {d.review}</div>}
                      </dl>
                    </td></tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={cur} total={list.length} onPage={setPage} />
    </>
  );
}

function Wfo({ rows, depts, P }: { rows: WfoRow[]; depts: string[]; P: RuleSet['params'] }) {
  const [q, setQ] = useState(''), [dept, setDept] = useState(''), [st, setSt] = useState<WfoStatus | ''>(''), [page, setPage] = useState(0), [openId, setOpenId] = useState<string | null>(null);
  const f = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(0); };
  const list = useMemo(() => { const t = q.trim().toLowerCase(); return rows.filter((r) => (!t || `${r.id} ${r.name}`.toLowerCase().includes(t)) && (!dept || r.dept === dept) && (!st || r.status === st)); }, [rows, q, dept, st]);
  const cur = Math.min(page, Math.max(0, Math.ceil(list.length / PAGE) - 1));
  return (
    <>
      <div className="toolbar" role="search">
        <div style={{ position: 'relative' }}>
          <Search aria-hidden="true" style={{ position: 'absolute', left: 10, top: 10, width: 16, height: 16, color: 'var(--muted)' }} />
          <input className="input" style={{ paddingLeft: 32 }} placeholder="ID atau nama karyawan…" aria-label="Cari karyawan" value={q} onChange={(e) => f(setQ)(e.target.value)} />
        </div>
        <select className="select" aria-label="Departemen" value={dept} onChange={(e) => f(setDept)(e.target.value)}><option value="">Semua departemen</option>{depts.map((d) => <option key={d} value={d}>{d || '(tanpa departemen)'}</option>)}</select>
        <select className="select" aria-label="Status kepatuhan" value={st} onChange={(e) => f(setSt)(e.target.value as WfoStatus | '')}><option value="">Semua status</option>{(Object.keys(WFO_STATUS_LABEL) as WfoStatus[]).map((k) => <option key={k} value={k}>{WFO_STATUS_LABEL[k]}</option>)}</select>
        <span className="hint">Aturan: {P.wfoDaysPerWeek} hari WFO, jatah WFH {P.wfhDaysPerWeek} hari per minggu; patuh bila ≥ {P.wfoCompliancePct}% (perlu konfirmasi HR)</span>
      </div>
      {list.length === 0 ? <Empty icon={<CheckCircle2 />} title="Tidak ada karyawan yang cocok">Ubah filter untuk melihat data lain.</Empty> : (
        <div className="table-wrap">
          <table className="dense">
            <thead><tr><th>Karyawan</th><th>Work Schedule</th><th className="r">Terjadwal</th><th className="r">Cuti disetujui</th><th className="r">WFH</th><th className="r">WFO fisik</th><th className="r">Belum pasti</th><th className="r">Wajib</th><th className="r">Terkredit</th><th className="r">Kepatuhan</th><th>Status</th><th><span className="sr-only">Rincian</span></th></tr></thead>
            <tbody>
              {list.slice(cur * PAGE, cur * PAGE + PAGE).flatMap((r) => {
                const isOpen = openId === r.id;
                return [
                  <tr key={r.id}>
                    <td><b className="num">{r.id}</b><div className="muted">{r.name || '—'} · {r.dept || 'tanpa departemen'}</div></td>
                    <td>{r.schedule || '—'}</td>
                    <td className="r num">{r.scheduled}</td><td className="r num">{r.excused}</td><td className="r num">{r.wfh}</td><td className="r num">{r.attended}</td><td className="r num">{r.unresolved}</td><td className="r num">{r.required}</td><td className="r num">{r.credited}</td>
                    <td className="r num"><b>{pct(r.rate, 0)}</b></td>
                    <td><span className={`badge ${STATUS_TONE[r.status]}`}>{WFO_STATUS_LABEL[r.status]}</span></td>
                    <td><button className="btn sm ghost" aria-expanded={isOpen} aria-label={`Rincian kepatuhan ${r.id}`} onClick={() => setOpenId(isOpen ? null : r.id)}><ChevronDown style={{ transform: isOpen ? 'rotate(180deg)' : undefined }} /></button></td>
                  </tr>,
                  isOpen && (
                    <tr key={`${r.id}-d`}><td colSpan={12} className="detail">
                      <p style={{ marginBottom: 8 }}>{r.explanation}</p>
                      <table className="dense">
                        <thead><tr><th>Minggu (Senin)</th><th className="r">Terjadwal</th><th className="r">Cuti disetujui</th><th className="r">WFH</th><th className="r">WFO fisik</th><th className="r">Wajib</th><th className="r">Terkredit</th><th className="r">Belum pasti</th></tr></thead>
                        <tbody>{r.weeks.map((w) => <tr key={w.weekStart}><td className="num">{dmy(w.weekStart)}</td><td className="r num">{w.scheduled}</td><td className="r num">{w.excused}</td><td className="r num">{w.wfh}</td><td className="r num">{w.attended}</td><td className="r num">{w.required}</td><td className="r num">{w.credited}</td><td className="r num">{w.unresolved}</td></tr>)}</tbody>
                      </table>
                    </td></tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={cur} total={list.length} onPage={setPage} />
    </>
  );
}

function Shifts({ days, basis }: { days: DayStatus[]; basis: number }) {
  const groups = useMemo(() => {
    const m = new Map<string, { cat: string; shift: string; hours: Set<string>; scheduled: number; wfo: number; late: number; early: number; na: number; flagged: number; emps: Set<string> }>();
    for (const d of days) {
      if (!d.scheduled && d.mode !== 'off_presence') continue;
      const k = `${d.category ?? '(tidak terpetakan)'}|${d.shift || '(tanpa jadwal)'}`;
      const g = m.get(k) ?? { cat: d.category ?? '(tidak terpetakan)', shift: d.shift || '(tanpa jadwal)', hours: new Set<string>(), scheduled: 0, wfo: 0, late: 0, early: 0, na: 0, flagged: 0, emps: new Set<string>() };
      m.set(k, g);
      if (d.hours) g.hours.add(d.hours);
      g.scheduled += d.scheduled ? 1 : 0; g.wfo += d.mode === 'wfo' ? 1 : 0; g.late += d.late === 'ya' ? 1 : 0; g.early += d.early === 'ya' ? 1 : 0;
      g.na += d.late === 'belum dihitung' ? 1 : 0; g.flagged += d.flags > 0 ? 1 : 0; g.emps.add(d.empId);
    }
    return [...m.values()].sort((a, b) => a.cat.localeCompare(b.cat) || a.shift.localeCompare(b.shift));
  }, [days]);
  return (
    <div className="stack">
      <div className="card-pad"><Alert kind="info" title={basis === 1 ? 'Jam diambil dari shift HRIS pada hari itu' : 'Dasar jadwal: Work Schedule karyawan (rumus sheet perusahaan)'}>{basis === 1 ? 'Kategori fingerprint tidak dipakai sebagai acuan jam. Shift OB (Office Partner) dan shift Operations dipisahkan menurut pemetaan shift di Config.' : 'Seluruh hari seorang karyawan dinilai dengan ambang satu Work Schedule. Aktifkan "Dasar jadwal" = 1 di Config untuk memakai jam shift hari itu.'}</Alert></div>
      <div className="table-wrap"><table className="dense">
        <thead><tr><th>Kategori</th><th>Shift HRIS</th><th>Jam jadwal</th><th className="r">Karyawan</th><th className="r">Hari terjadwal</th><th className="r">Hari WFO</th><th className="r">Terlambat</th><th className="r">Pulang awal</th><th className="r">Belum dihitung</th><th className="r">Hari ber-flag</th></tr></thead>
        <tbody>{groups.map((g) => <tr key={`${g.cat}|${g.shift}`}><td>{g.cat}</td><td>{g.shift}</td><td className="num">{[...g.hours].join(', ') || '—'}</td><td className="r num">{g.emps.size}</td><td className="r num">{g.scheduled}</td><td className="r num">{g.wfo}</td><td className="r num">{g.late}</td><td className="r num">{g.early}</td><td className="r num">{g.na}</td><td className="r num">{g.flagged}</td></tr>)}</tbody>
      </table></div>
    </div>
  );
}

function Quality({ days, res, s, onReview }: { days: DayStatus[]; res: EngineResult; s: ReturnType<typeof evaluateAttendance>['summary']; onReview: () => void }) {
  const byCat = (Object.keys(CATEGORY_LABEL) as (keyof typeof CATEGORY_LABEL)[]).map((c) => { const x = res.flags.filter((f) => f.category === c); return { c, total: x.length, kritis: x.filter((f) => f.severity === 'kritis').length }; }).filter((x) => x.total);
  const review = days.filter((d) => d.unresolved || d.openFlags > 0 || d.review);
  const [page, setPage] = useState(0);
  const cur = Math.min(page, Math.max(0, Math.ceil(review.length / PAGE) - 1));
  return (
    <div className="stack">
      <div className="card-pad stack">
        <div className="metrics">
          <Stat k="Tap persis sama" v={res.stats.exactDup} s="digabung, bukti tetap tercatat di export" />
          <Stat k="Tap mendekati duplikat" v={res.stats.dupRemoved - res.stats.exactDup} s="dalam jendela duplikasi Config; tidak dihapus dari bukti" />
          <Stat k="Hari tanpa tap masuk/pulang" v={s.missing} s="belum terjelaskan, di-flag (bukan otomatis absen)" />
          <Stat k="Tap dilengkapi Talenta" v={days.filter((d) => d.source.includes('dilengkapi Check')).length} s="hari: jam yang hilang dari Check In/Out Talenta, tidak di-flag" />
          <Stat k="Hari tanpa bukti kehadiran" v={s.byMode.no_evidence} s="tidak dihitung WFO, WFH, maupun absen" />
          <Stat k="Hari menunggu keputusan" v={s.byMode.pending} s="belum dihitung sampai flag diputuskan" />
          <Stat k="Kategori fingerprint ≠ jadwal" v={s.mismatchDays} s="hari, dikirim ke HR Operations" />
        </div>
        <div className="row"><b>Flag per kategori:</b>{byCat.length ? byCat.map((x) => <span key={x.c} className="badge">{CATEGORY_LABEL[x.c]}: {x.total} ({x.kritis} kritis)</span>) : <span className="muted">tidak ada</span>}<button className="btn sm" onClick={onReview}>Buka review exception</button></div>
      </div>
      {review.length === 0 ? <Empty icon={<CheckCircle2 />} title="Tidak ada hari yang perlu review">Semua hari dapat dinilai dengan pasti.</Empty> : (
        <>
          <div className="table-wrap"><table className="dense">
            <thead><tr><th>Tanggal</th><th>Karyawan</th><th>Mode kerja</th><th>Alasan</th></tr></thead>
            <tbody>{review.slice(cur * PAGE, cur * PAGE + PAGE).map((d) => (
              <tr key={`${d.empId}|${d.date}`}><td className="num" style={{ whiteSpace: 'nowrap' }}>{dmy(d.date)}</td><td><b className="num">{d.empId}</b><div className="muted">{d.name || '—'}</div></td><td><span className={`badge ${MODE_TONE[d.mode]}`}>{MODE_LABEL[d.mode]}</span></td><td className="reason">{d.review || `${d.openFlags} flag belum diputuskan`}</td></tr>
            ))}</tbody>
          </table></div>
          <Pager page={cur} total={review.length} onPage={setPage} />
        </>
      )}
    </div>
  );
}
