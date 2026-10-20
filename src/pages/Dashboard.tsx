import { useMemo, useState, type DragEvent } from 'react';
import { BarChart3, Printer, Trash2, Upload } from 'lucide-react';
import { useApp } from '../state';
import { MAX_FILES, addResultFiles, monthly, ruleWarnings, trend, type ResultFile } from '../lib/dashboard';
import { Alert, Empty, pct, period, periodShort } from '../components/ui';
import { HBars, Histogram, LineChart } from '../components/charts';

/** Threshold from the file's own rule snapshot (e.g. "20 %"), used to tint histogram bars. */
const thresholdBin = (f: ResultFile, label: string) => {
  const v = f.audit.find((a) => a[1] === label)?.[2];
  const n = v ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? Math.floor(n / 5) : undefined;
};

function Monthly({ file }: { file: ResultFile }) {
  const m = useMemo(() => monthly(file), [file]);
  const total = m.byCategory.reduce((s, c) => s + c.kritis + c.informatif, 0);
  const maxDept = Math.max(0.25, ...m.byDept.map((d) => Math.max(d.complete ?? 0, d.late ?? 0)));
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="grid-4">
        {[['Karyawan', String(m.n), `${m.office.toLocaleString('id-ID')} hari kantor`],
          ['Rata-rata % Complete', pct(m.avgComplete), m.min && m.max ? `terendah ${pct(m.min.v)} · tertinggi ${pct(m.max.v)} (ID ${m.max.id})` : '–'],
          ['Rata-rata % Keterlambatan', pct(m.avgLate), `periode ${periodShort(file.period)}`],
          ['Perlu Evaluasi', String(m.evaluate), `${m.n ? pct(m.evaluate / m.n, 0) : '–'} karyawan`],
          ['Late di atas ambang', String(m.lateOver), `${m.n ? pct(m.lateOver / m.n, 0) : '–'} karyawan`]].map(([k, v, s], i) => (
          <div key={k} className="card stat" style={{ '--i': i } as React.CSSProperties}><span className="k">{k}</span><span className="v">{v}</span><span className="s">{s}</span></div>
        ))}
      </div>
      <div className="grid-2">
        <section className="card" aria-labelledby="h-dist">
          <div className="card-head"><h2 id="h-dist">Distribusi % Complete</h2></div>
          <div className="card-pad"><Histogram bins={m.binsComplete} warnFrom={thresholdBin(file, 'Ambang "Perlu Evaluasi"')} /></div>
        </section>
        <section className="card" aria-labelledby="h-late">
          <div className="card-head"><h2 id="h-late">Distribusi % Keterlambatan Clock In</h2></div>
          <div className="card-pad"><Histogram bins={m.binsLate} warnFrom={thresholdBin(file, 'Ambang keterlambatan')} /></div>
        </section>
      </div>
      <div className="grid-2">
        <section className="card" aria-labelledby="h-dept">
          <div className="card-head"><h2 id="h-dept">% Complete per departemen</h2></div>
          <div className="card-pad"><HBars max={maxDept} items={m.byDept.map((d) => ({ label: d.dept, value: d.complete, n: d.n }))} /></div>
        </section>
        <section className="card" aria-labelledby="h-dept2">
          <div className="card-head"><h2 id="h-dept2">% Keterlambatan per departemen</h2></div>
          <div className="card-pad"><HBars max={maxDept} items={m.byDept.map((d) => ({ label: d.dept, value: d.late, n: d.n }))} /></div>
        </section>
      </div>
      <section className="card" aria-labelledby="h-exc">
        <div className="card-head"><h2 id="h-exc">Ringkasan exception</h2><span className="muted">{total} flag diputuskan · {m.byAction.map((a) => `${a.action} ${a.n}`).join(' · ') || 'tidak ada'}</span></div>
        {total === 0 ? <Empty icon={<BarChart3 />} title="Tidak ada exception pada periode ini" /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Kategori</th><th className="r">Kritis</th><th className="r">Informatif</th><th className="r">Total</th></tr></thead>
            <tbody>{m.byCategory.map((c) => <tr key={c.category}><td>{c.category}</td><td className="r num">{c.kritis}</td><td className="r num">{c.informatif}</td><td className="r num"><b>{c.kritis + c.informatif}</b></td></tr>)}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}

export default function Dashboard() {
  const { dash, setDash } = useApp();
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [detail, setDetail] = useState('');

  const add = async (list: FileList | File[]) => {
    setBusy(true);
    const r = await addResultFiles(dash, [...list]);
    setDash(r.files); setErrors(r.errors); setBusy(false);
  };
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); void add(e.dataTransfer.files); };

  const tampered = dash.filter((f) => !f.intact);
  const warns = useMemo(() => (dash.length > 1 ? ruleWarnings(dash) : []), [dash]);
  const tr = useMemo(() => (dash.length > 1 ? trend(dash) : null), [dash]);
  const shown = dash.find((f) => f.period === detail) ?? dash[dash.length - 1];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>Unggah file .xlsx hasil Tenflow (sheet Final Data). Satu file menampilkan dashboard bulanan, dua file atau lebih menampilkan tren. Data tidak disimpan di server.</p>
        </div>
        <button className="btn no-print" onClick={() => window.print()} disabled={!dash.length}><Printer />Cetak / simpan PDF</button>
      </div>

      <div className="no-print stack">
        <label className="drop" data-over={over} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
          <Upload aria-hidden="true" />
          <b>{busy ? 'Membaca file…' : 'Unggah file hasil'}</b>
          <span className="hint">Klik atau seret satu atau beberapa file .xlsx (maks. {MAX_FILES}; satu file per bulan)</span>
          <input type="file" accept=".xlsx" multiple aria-label="Pilih file hasil Tenflow" onChange={(e) => { if (e.target.files?.length) void add(e.target.files); e.target.value = ''; }} />
        </label>
        {errors.length > 0 && <Alert kind="error" title={`${errors.length} file ditolak`}><ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul></Alert>}
        {dash.length > 0 && (
          <div className="row">
            {dash.map((f) => (
              <span key={f.period} className="file-chip" style={{ maxWidth: 340 }}>
                <b>{periodShort(f.period)}</b>
                <span title={f.name}>{f.name}</span>
                <span className="badge brand">rule v{f.ruleVersion}</span>
                {!f.intact && <span className="badge bad">diubah</span>}
                <button className="btn ghost sm" aria-label={`Hapus ${f.name}`} onClick={() => setDash(dash.filter((x) => x !== f))}><Trash2 /></button>
              </span>
            ))}
          </div>
        )}
      </div>

      {tampered.length > 0 && (
        <Alert kind="warn" title="File terdeteksi diubah setelah export">
          Checksum tidak cocok untuk: {tampered.map((f) => `${period(f.period)} (${f.name})`).join(', ')}. Angka pada dashboard mungkin tidak sama dengan hasil proses yang disetujui.
        </Alert>
      )}
      {warns.length > 0 && (
        <Alert kind="warn" title="Perbandingan tidak apple-to-apple: rule berbeda antar periode">
          {warns.map((w) => (
            <details key={w.to}>
              <summary>{periodShort(w.from)} → {periodShort(w.to)} (rule v{w.versions[0]} → v{w.versions[1]})</summary>
              {w.lines.length ? <ul>{w.lines.map((l) => <li key={l}>{l}</li>)}</ul> : <p>Versi berbeda tetapi isi aturan identik.</p>}
            </details>
          ))}
        </Alert>
      )}

      {dash.length === 0 && <div className="card"><Empty icon={<BarChart3 />} title="Belum ada file">Unggah file hasil dari halaman Proses Attendance untuk melihat dashboard.</Empty></div>}

      {dash.length === 1 && <><h2>{period(dash[0].period)}</h2><Monthly file={dash[0]} /></>}

      {tr && dash.length > 1 && (
        <>
          <div className="grid-2">
            <section className="card" aria-labelledby="h-trend">
              <div className="card-head"><h2 id="h-trend">Tren rata-rata % Complete</h2></div>
              <div className="card-pad"><LineChart points={tr.points} get={(p) => p.complete} label="Tren rata-rata % Complete" /></div>
            </section>
            <section className="card" aria-labelledby="h-trend2">
              <div className="card-head"><h2 id="h-trend2">Tren rata-rata % Keterlambatan</h2></div>
              <div className="card-pad"><LineChart points={tr.points} get={(p) => p.late} label="Tren rata-rata % Keterlambatan" /></div>
            </section>
          </div>
          {tr.points.some((p) => p.complete == null) && <p className="hint">Garis putus-putus menandai bulan tanpa file (tidak diinterpolasi).</p>}
          <section className="card" aria-labelledby="h-tbl">
            <div className="card-head"><h2 id="h-tbl">Tabel tren</h2><span className="muted">{period(tr.points[0].period)} – {period(tr.points[tr.points.length - 1].period)}</span></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Periode</th><th className="r">Karyawan</th><th className="r">% Complete</th><th className="r">% Keterlambatan</th>{tr.depts.map((d) => <th key={d.dept} className="r">{d.dept}</th>)}</tr></thead>
              <tbody>{tr.points.map((p, i) => (
                <tr key={p.period}><td>{period(p.period)}</td><td className="r num">{p.n ?? '–'}</td>
                  {p.complete == null ? <td className="r muted" colSpan={2}>tidak ada file</td> : <><td className="r num"><b>{pct(p.complete)}</b></td><td className="r num"><b>{pct(p.late)}</b></td></>}
                  {tr.depts.map((d) => <td key={d.dept} className="r num">{pct(d.complete[i])}</td>)}</tr>
              ))}</tbody>
            </table></div>
          </section>
          <div className="page-head" style={{ marginTop: 8 }}>
            <h2>Detail periode</h2>
            <select className="select no-print" style={{ width: 'auto' }} aria-label="Pilih periode" value={shown.period} onChange={(e) => setDetail(e.target.value)}>
              {dash.map((f) => <option key={f.period} value={f.period}>{period(f.period)}</option>)}
            </select>
          </div>
          <Monthly file={shown} />
        </>
      )}
    </div>
  );
}
