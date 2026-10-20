import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useApp } from '../state';
import {
  PARAM_META, TREATMENT_LABEL, activeRules, commit, loadStore, saveStore, scheduleText,
  type AttendanceRule, type Params, type RuleSet, type RuleStore, type ScheduleRule, type ShiftMap, type Treatment,
} from '../lib/rules';
import { hhmm, parseHm } from '../lib/format';
import { Alert, Dialog } from '../components/ui';

type Tab = 'params' | 'schedules' | 'map' | 'codes' | 'flex' | 'log';
type Editing =
  | { kind: 'schedule'; item: ScheduleRule | null }
  | { kind: 'map'; item: ShiftMap | null }
  | { kind: 'code'; item: AttendanceRule | null }
  | { kind: 'dept'; item: string | null }
  | { kind: 'delete'; what: 'schedule' | 'map' | 'code' | 'dept'; id: string; label: string; note?: string };

const dt = (iso: string) => new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
const nid = () => Math.random().toString(36).slice(2, 9);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function ParamsForm({ params, readOnly, onSave }: { params: Params; readOnly: boolean; onSave: (p: Params) => void }) {
  const [p, setP] = useState(params);
  const errs: Partial<Record<keyof Params, string>> = {};
  for (const m of PARAM_META) {
    const v = p[m.key];
    if (!Number.isFinite(v) || v < 0) errs[m.key] = 'Harus angka ≥ 0';
    else if (m.max && v > m.max) errs[m.key] = `Maksimum ${m.max}`;
  }
  if (!errs.minWorkMin && p.minWorkMin >= p.maxWorkMin) errs.minWorkMin = 'Harus lebih kecil dari durasi maksimum';
  for (const m of PARAM_META) if (m.unit === '0/1' && !errs[m.key] && p[m.key] !== 0 && p[m.key] !== 1) errs[m.key] = 'Harus 0 atau 1';
  if (!errs.lunchStartMin && !errs.lunchEndMin && p.lunchStartMin >= p.lunchEndMin) errs.lunchStartMin = 'Harus lebih awal dari selesai istirahat';
  const dirty = JSON.stringify(p) !== JSON.stringify(params);
  return (
    <form className="card-pad stack" onSubmit={(e) => { e.preventDefault(); if (!Object.keys(errs).length) onSave(p); }} noValidate>
      <div className="grid-2">
        {PARAM_META.map((m) => (
          <div className="field" key={m.key}>
            <label htmlFor={m.key}>{m.label} ({m.unit})</label>
            <input id={m.key} className="input num" type="number" min={0} max={m.max} step="any" disabled={readOnly} value={Number.isNaN(p[m.key]) ? '' : p[m.key]}
              onChange={(e) => setP({ ...p, [m.key]: e.target.value === '' ? NaN : Number(e.target.value) })} aria-invalid={!!errs[m.key]} aria-describedby={`${m.key}-h`} />
            <span id={`${m.key}-h`} className={errs[m.key] ? 'err' : 'hint'}>{errs[m.key] ?? m.help}</span>
          </div>
        ))}
      </div>
      {!readOnly && <div className="row"><button className="btn primary" type="submit" disabled={!dirty || !!Object.keys(errs).length}>Simpan sebagai versi baru</button>{dirty && <button type="button" className="btn ghost" onClick={() => setP(params)}>Batalkan perubahan</button>}</div>}
    </form>
  );
}

function TimeField({ id, label, value, onChange, invalid }: { id: string; label: string; value: string; onChange: (v: string) => void; invalid: boolean }) {
  return <div className="field"><label htmlFor={id}>{label}</label><input id={id} type="time" className="input num" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} /></div>;
}

function ScheduleDialog({ item, rs, onSave, onClose }: { item: ScheduleRule | null; rs: RuleSet; onSave: (v: ScheduleRule) => void; onClose: () => void }) {
  const [name, setName] = useState(item?.name ?? '');
  const [prio, setPrio] = useState(String(item?.priority ?? rs.schedules.length + 1));
  const [late, setLate] = useState(item ? hhmm(item.lateAfterMin) : '09:15');
  const [early, setEarly] = useState(item ? hhmm(item.earlyBeforeMin) : '18:00');
  const [hasSplit, setHasSplit] = useState(!!item?.split);
  const [at, setAt] = useState(item?.split ? hhmm(item.split.atMin) : '10:00');
  const [late2, setLate2] = useState(item?.split ? hhmm(item.split.lateAfterMin) : '10:15');
  const [early2, setEarly2] = useState(item?.split ? hhmm(item.split.earlyBeforeMin) : '19:00');
  const [touched, setTouched] = useState(false);
  const n = name.trim();
  const dup = rs.schedules.some((s) => s.id !== item?.id && same(s.name, n));
  const nameErr = !n ? 'Wajib diisi' : dup ? 'Sudah ada' : '';
  const prioOk = Number.isInteger(+prio) && +prio >= 1;
  const times = [late, early, ...(hasSplit ? [at, late2, early2] : [])].map(parseHm);
  const bad = !!nameErr || !prioOk || times.some((t) => t == null);
  const submit = () => {
    setTouched(true);
    if (bad) return;
    const [l, e, a, l2, e2] = times as number[];
    onSave({ id: item?.id ?? nid(), name: n, priority: +prio, lateAfterMin: l, earlyBeforeMin: e, ...(hasSplit ? { split: { atMin: a, lateAfterMin: l2, earlyBeforeMin: e2 } } : {}) });
  };
  return (
    <form className="dlg" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
      <h2>{item ? 'Ubah' : 'Tambah'} Work Schedule</h2>
      <div className="grid-2">
        <div className="field"><label htmlFor="sn">Nama</label><input id="sn" className="input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={touched && !!nameErr} autoFocus />{touched && nameErr && <span className="err">{nameErr}</span>}</div>
        <div className="field"><label htmlFor="sp">Prioritas</label><input id="sp" type="number" min={1} className="input num" value={prio} onChange={(e) => setPrio(e.target.value)} aria-invalid={touched && !prioOk} /><span className="hint">Karyawan dengan beberapa shift memakai prioritas tertinggi.</span></div>
        <TimeField id="sl" label="Terlambat jika tap masuk setelah" value={late} onChange={setLate} invalid={touched && parseHm(late) == null} />
        <TimeField id="se" label="Pulang awal jika tap pulang sebelum" value={early} onChange={setEarly} invalid={touched && parseHm(early) == null} />
      </div>
      <label className="row"><input type="checkbox" checked={hasSplit} onChange={(e) => setHasSplit(e.target.checked)} />Jendela kedua untuk tap masuk yang lebih siang</label>
      {hasSplit && (
        <div className="grid-2">
          <TimeField id="sa" label="Berlaku jika tap masuk pukul ≥" value={at} onChange={setAt} invalid={touched && parseHm(at) == null} />
          <span />
          <TimeField id="sl2" label="Terlambat setelah" value={late2} onChange={setLate2} invalid={touched && parseHm(late2) == null} />
          <TimeField id="se2" label="Pulang awal sebelum" value={early2} onChange={setEarly2} invalid={touched && parseHm(early2) == null} />
        </div>
      )}
      <p className="hint">Menyimpan membuat versi rule baru. Tidak berlaku surut: file hasil lama tetap memuat snapshot aturannya sendiri.</p>
      <div className="dlg-foot"><button type="button" className="btn" onClick={onClose}>Batal</button><button className="btn primary" type="submit">Simpan sebagai versi baru</button></div>
    </form>
  );
}

function SimpleDialog({ kind, item, rs, onSave, onClose }: { kind: 'map' | 'code'; item: ShiftMap | AttendanceRule | null; rs: RuleSet; onSave: (key: string, val: string) => void; onClose: () => void }) {
  const isMap = kind === 'map';
  const cur = item as (ShiftMap & AttendanceRule) | null;
  const [key, setKey] = useState((isMap ? cur?.shift : cur?.code) ?? '');
  const [val, setVal] = useState((isMap ? cur?.schedule : cur?.treatment) ?? (isMap ? rs.schedules[0]?.name ?? '' : 'leave'));
  const [touched, setTouched] = useState(false);
  const k = key.trim();
  const list = isMap ? rs.shiftMap.map((m) => [m.id, m.shift]) : rs.attendance.map((a) => [a.id, a.code]);
  const err = !k ? 'Wajib diisi' : list.some(([id, v]) => id !== cur?.id && same(v, k)) ? 'Sudah ada' : isMap && !val ? 'Buat Work Schedule terlebih dahulu' : '';
  return (
    <form className="dlg" onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!err) onSave(k, val); }} noValidate>
      <h2>{item ? 'Ubah' : 'Tambah'} {isMap ? 'pemetaan shift' : 'rule kode kehadiran'}</h2>
      <div className="field"><label htmlFor="rk">{isMap ? 'Kode shift (kolom Shift di HRIS)' : 'Kode kehadiran (kolom Attendance Code di HRIS)'}</label>
        <input id="rk" className="input" value={key} onChange={(e) => setKey(e.target.value)} aria-invalid={touched && !!err} autoFocus />{touched && err && <span className="err">{err}</span>}</div>
      <div className="field"><label htmlFor="rv">{isMap ? 'Work Schedule' : 'Perlakuan'}</label>
        <select id="rv" className="select" value={val} onChange={(e) => setVal(e.target.value)}>
          {isMap ? rs.schedules.map((s) => <option key={s.id} value={s.name}>{s.name}</option>) : (Object.keys(TREATMENT_LABEL) as Treatment[]).map((t) => <option key={t} value={t}>{TREATMENT_LABEL[t]}</option>)}
        </select></div>
      <p className="hint">Menyimpan membuat versi rule baru. Tidak berlaku surut.</p>
      <div className="dlg-foot"><button type="button" className="btn" onClick={onClose}>Batal</button><button className="btn primary" type="submit">Simpan sebagai versi baru</button></div>
    </form>
  );
}

function DeptDialog({ item, rs, onSave, onClose }: { item: string | null; rs: RuleSet; onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(item ?? '');
  const [touched, setTouched] = useState(false);
  const n = name.trim();
  const err = !n ? 'Wajib diisi' : (rs.flexDepts ?? []).some((d) => d !== item && same(d, n)) ? 'Sudah ada' : '';
  return (
    <form className="dlg" onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!err) onSave(n); }} noValidate>
      <h2>{item ? 'Ubah' : 'Tambah'} divisi fleksibel</h2>
      <div className="field"><label htmlFor="dn">Nama divisi (kolom Organization di HRIS)</label>
        <input id="dn" className="input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={touched && !!err} autoFocus />
        {touched && err ? <span className="err">{err}</span> : <span className="hint">Awalan perusahaan dalam kurung dan huruf besar/kecil diabaikan: "COM" cocok dengan "[AB] COM".</span>}</div>
      <p className="hint">Menyimpan membuat versi rule baru. Tidak berlaku surut.</p>
      <div className="dlg-foot"><button type="button" className="btn" onClick={onClose}>Batal</button><button className="btn primary" type="submit">Simpan sebagai versi baru</button></div>
    </form>
  );
}

export default function Config() {
  const { session } = useApp();
  const [store, setStore] = useState<RuleStore>(loadStore);
  const [tab, setTab] = useState<Tab>('params');
  const [viewV, setViewV] = useState<number | null>(null);
  const [edit, setEdit] = useState<Editing | null>(null);
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState('');
  const latest = activeRules(store);
  const rs = store.versions.find((v) => v.version === viewV) ?? latest;
  const readOnly = rs.version !== latest.version;
  const by = session!.email;

  const apply = (e: Parameters<typeof commit>[2], msg: string) => {
    const next = commit(store, by, e);
    saveStore(next); setStore(next); setViewV(null); setOpen(false);
    setFlash(`${msg} Versi aktif sekarang v${next.versions[next.versions.length - 1].version}.`);
  };
  const show = (e: Editing) => { setEdit(e); setOpen(true); };

  const saveSchedule = (v: ScheduleRule) => apply((d) => {
    const old = d.schedules.find((s) => s.id === v.id);
    if (old) {
      d.shiftMap.forEach((m) => { if (same(m.schedule, old.name)) m.schedule = v.name; }); // renaming keeps the mappings
      Object.assign(old, v); if (!v.split) delete old.split;
      return { action: 'update', target: `Work Schedule ${v.name}`, detail: scheduleText(v) };
    }
    d.schedules.push(v);
    return { action: 'create', target: `Work Schedule ${v.name}`, detail: scheduleText(v) };
  }, 'Work Schedule disimpan.');

  const saveMap = (shift: string, schedule: string) => apply((d) => {
    const it = edit?.kind === 'map' ? edit.item : null;
    const r = it && d.shiftMap.find((m) => m.id === it.id);
    if (r) { const o = `${r.shift} → ${r.schedule}`; r.shift = shift; r.schedule = schedule; return { action: 'update', target: `Shift ${shift}`, detail: `${o} ⇒ ${shift} → ${schedule}` }; }
    d.shiftMap.push({ id: nid(), shift, schedule });
    return { action: 'create', target: `Shift ${shift}`, detail: `Dipetakan ke ${schedule}` };
  }, 'Pemetaan shift disimpan.');

  const saveCode = (code: string, treatment: string) => apply((d) => {
    const it = edit?.kind === 'code' ? edit.item : null;
    const r = it && d.attendance.find((a) => a.id === it.id);
    if (r) { const o = `${r.code}: ${TREATMENT_LABEL[r.treatment]}`; r.code = code; r.treatment = treatment as Treatment; return { action: 'update', target: `Kode ${code}`, detail: `${o} ⇒ ${TREATMENT_LABEL[treatment as Treatment]}` }; }
    d.attendance.push({ id: nid(), code, treatment: treatment as Treatment });
    return { action: 'create', target: `Kode ${code}`, detail: TREATMENT_LABEL[treatment as Treatment] };
  }, 'Rule kode kehadiran disimpan.');

  const saveDept = (name: string) => apply((d) => {
    const old = edit?.kind === 'dept' ? edit.item : null;
    const list = d.flexDepts ?? [];
    d.flexDepts = old ? list.map((x) => (x === old ? name : x)) : [...list, name];
    return { action: old ? 'update' : 'create', target: `Divisi fleksibel ${name}`, detail: old ? `${old} ⇒ ${name}` : 'Tap sebelah dan durasi tidak wajar dianggap hadir' };
  }, 'Divisi fleksibel disimpan.');

  const del = () => {
    if (edit?.kind !== 'delete') return;
    const { what, id, label } = edit;
    apply((d) => {
      if (what === 'schedule') d.schedules = d.schedules.filter((s) => s.id !== id);
      else if (what === 'map') d.shiftMap = d.shiftMap.filter((m) => m.id !== id);
      else if (what === 'dept') d.flexDepts = (d.flexDepts ?? []).filter((x) => x !== id);
      else d.attendance = d.attendance.filter((a) => a.id !== id);
      return { action: 'delete', target: label, detail: 'Dihapus permanen' };
    }, 'Rule dihapus.');
  };
  const saveParams = (p: Params) => apply((d) => {
    const ch = PARAM_META.filter((m) => p[m.key] !== d.params[m.key]).map((m) => `${m.label}: ${d.params[m.key]} → ${p[m.key]}`);
    d.params = p;
    return { action: 'update', target: 'Parameter', detail: ch.join('; ') };
  }, 'Parameter disimpan.');

  const tabs: [Tab, string][] = [['params', 'Parameter'], ['schedules', `Work Schedule (${rs.schedules.length})`], ['map', `Pemetaan shift (${rs.shiftMap.length})`], ['codes', `Kode kehadiran (${rs.attendance.length})`], ['flex', `Divisi fleksibel (${(rs.flexDepts ?? []).length})`], ['log', `Log perubahan (${store.log.length})`]];
  const actions = (e: Editing, label: string, note?: string) => !readOnly && (
    <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
      <button className="btn sm" aria-label={`Ubah ${label}`} onClick={() => show(e)}><Pencil />Ubah</button>
      <button className="btn sm ghost" aria-label={`Hapus ${label}`} onClick={() => show({ kind: 'delete', what: e.kind as 'schedule' | 'map' | 'code', id: (e as { item: { id: string } }).item.id, label, note })}><Trash2 /></button>
    </div>
  );
  const addBar = (label: string, e: Editing, hint: string) => !readOnly && <div className="toolbar"><button className="btn primary sm" onClick={() => show(e)}><Plus />{label}</button><span className="hint">{hint}</span></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings &amp; Config</h1>
          <p>Aturan perhitungan berupa parameter terstruktur. Setiap perubahan membuat versi baru dan tercatat di log.</p>
        </div>
        <div className="field" style={{ minWidth: 200 }}>
          <label htmlFor="ver">Versi rule</label>
          <select id="ver" className="select" value={rs.version} onChange={(e) => setViewV(+e.target.value)}>
            {[...store.versions].reverse().map((v) => <option key={v.version} value={v.version}>v{v.version}{v.version === latest.version ? ' (aktif)' : ''} · {dt(v.createdAt)}</option>)}
          </select>
        </div>
      </div>
      {flash && <Alert kind="ok">{flash}</Alert>}
      {readOnly && <Alert kind="info" title={`Melihat v${rs.version} (hanya baca)`}>Versi lama tetap dapat dirujuk tetapi tidak dapat diubah. <button className="btn sm" onClick={() => setViewV(null)}>Kembali ke versi aktif</button></Alert>}

      <div className="card">
        <div className="tabs" role="tablist" aria-label="Bagian config">
          {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        {tab === 'params' && <ParamsForm key={rs.version} params={rs.params} readOnly={readOnly} onSave={saveParams} />}
        {tab === 'schedules' && (
          <>
            {addBar('Tambah Work Schedule', { kind: 'schedule', item: null }, 'Ambang ini hanya dipakai bila "Dasar jadwal" = 0 (rumus sheet perusahaan). Dengan "Dasar jadwal" = 1, jam diambil dari shift HRIS hari itu dan Work Schedule menentukan kategori saja.')}
            <div className="table-wrap"><table>
              <thead><tr><th>Work Schedule</th><th>Aturan</th><th /></tr></thead>
              <tbody>{rs.schedules.map((s) => <tr key={s.id}><td><b>{s.name}</b></td><td className="reason">{scheduleText(s)}</td><td>{actions({ kind: 'schedule', item: s }, `Work Schedule ${s.name}`, `${rs.shiftMap.filter((m) => same(m.schedule, s.name)).length} pemetaan shift memakai jadwal ini dan akan di-flag "tidak ada rule".`)}</td></tr>)}</tbody>
            </table></div>
          </>
        )}
        {tab === 'map' && (
          <>
            {addBar('Tambah pemetaan', { kind: 'map', item: null }, 'Work Schedule karyawan = jadwal berprioritas tertinggi dari shift HRIS-nya. Shift yang tidak terpetakan di-flag saat proses.')}
            <div className="table-wrap"><table>
              <thead><tr><th>Shift HRIS</th><th>Work Schedule</th><th /></tr></thead>
              <tbody>{rs.shiftMap.map((m) => <tr key={m.id}><td><b>{m.shift}</b></td><td>{m.schedule}</td><td>{actions({ kind: 'map', item: m }, `shift ${m.shift}`)}</td></tr>)}</tbody>
            </table></div>
          </>
        )}
        {tab === 'codes' && (
          <>
            {addBar('Tambah kode', { kind: 'code', item: null }, 'Kode cuti/izin/sakit atau WFH yang bertemu tap di-flag sebagai konflik antar sumber (cuti sebagian hari yang disetujui dan konsisten dengan tap tidak di-flag). Kode tanpa rule di-flag saat proses.')}
            <div className="table-wrap"><table>
              <thead><tr><th>Attendance Code</th><th>Perlakuan</th><th /></tr></thead>
              <tbody>{rs.attendance.map((a) => <tr key={a.id}><td><b>{a.code}</b></td><td>{TREATMENT_LABEL[a.treatment]}</td><td>{actions({ kind: 'code', item: a }, `kode ${a.code}`)}</td></tr>)}</tbody>
            </table></div>
          </>
        )}
        {tab === 'flex' && (
          <>
            {addBar('Tambah divisi', { kind: 'dept', item: null }, 'Karyawan divisi ini sering keluar-masuk kantor (meeting). Hari kerja dengan tap hanya sebelah (masuk saja / pulang saja) dianggap hadir tanpa flag, dan durasi tap yang tidak wajar tidak di-flag. Terlambat/pulang awal tetap dinilai bila kedua tap ada. Hari bertanda cuti, WFH atau dinas tetap mengikuti rule kodenya.')}
            <div className="table-wrap"><table>
              <thead><tr><th>Divisi</th><th /></tr></thead>
              <tbody>{(rs.flexDepts ?? []).map((n) => <tr key={n}><td><b>{n}</b></td><td>{!readOnly && (
                <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                  <button className="btn sm" aria-label={`Ubah divisi ${n}`} onClick={() => show({ kind: 'dept', item: n })}><Pencil />Ubah</button>
                  <button className="btn sm ghost" aria-label={`Hapus divisi ${n}`} onClick={() => show({ kind: 'delete', what: 'dept', id: n, label: `divisi ${n}` })}><Trash2 /></button>
                </div>)}</td></tr>)}</tbody>
            </table></div>
          </>
        )}
        {tab === 'log' && (
          <div className="table-wrap"><table>
            <thead><tr><th>Versi</th><th>Waktu</th><th>Oleh</th><th>Aksi</th><th>Target</th><th>Perubahan</th></tr></thead>
            <tbody>{[...store.log].reverse().map((l, i) => (
              <tr key={i}><td className="num">v{l.version}</td><td className="num" style={{ whiteSpace: 'nowrap' }}>{dt(l.at)}</td><td>{l.by}</td>
                <td><span className={`badge ${l.action === 'delete' ? 'bad' : l.action === 'create' ? 'ok' : 'info'}`}>{{ create: 'Tambah', update: 'Ubah', delete: 'Hapus' }[l.action]}</span></td><td>{l.target}</td><td className="reason">{l.detail}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <p className="hint">Prototipe: aturan dan log disimpan di localStorage browser ini. Produksi memerlukan penyimpanan server agar dibagikan antar pengguna.</p>

      <Dialog open={open} onClose={() => setOpen(false)} title="Rule">
        {edit?.kind === 'schedule' && <ScheduleDialog key={`s-${edit.item?.id ?? 'new'}-${store.versions.length}`} item={edit.item} rs={rs} onSave={saveSchedule} onClose={() => setOpen(false)} />}
        {(edit?.kind === 'map' || edit?.kind === 'code') && <SimpleDialog key={`${edit.kind}-${edit.item?.id ?? 'new'}-${store.versions.length}`} kind={edit.kind} item={edit.item} rs={rs} onSave={edit.kind === 'map' ? saveMap : saveCode} onClose={() => setOpen(false)} />}
        {edit?.kind === 'dept' && <DeptDialog key={`d-${edit.item ?? 'new'}-${store.versions.length}`} item={edit.item} rs={rs} onSave={saveDept} onClose={() => setOpen(false)} />}
        {edit?.kind === 'delete' && (
          <div className="dlg">
            <h2>Hapus {edit.label}?</h2>
            <p>Penghapusan bersifat permanen dan tercatat di log (siapa, kapan, aturan apa). Hasil lama tidak berubah karena file hasil menyimpan snapshot aturannya sendiri.</p>
            {edit.note && <Alert kind="warn">{edit.note}</Alert>}
            <div className="dlg-foot"><button className="btn" onClick={() => setOpen(false)} autoFocus>Batal</button><button className="btn danger" onClick={del}>Hapus permanen</button></div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
