import { useMemo, useState, type DragEvent } from 'react';
import { Check, CheckCircle2, Download, FileSpreadsheet, Lock, Trash2, Upload } from 'lucide-react';
import { useApp } from '../state';
import { MAX_FILE_BYTES, ingest } from '../lib/ingest';
import { runEngine } from '../lib/engine';
import { activeRules, loadStore } from '../lib/rules';
import { summarize, summarizeEmployees } from '../lib/review';
import { buildResult } from '../lib/exporter';
import { Alert, bytes, download, pct, period } from '../components/ui';
import ReviewStep from '../components/ReviewStep';
import ComplianceView from '../components/ComplianceView';

const STEPS = [['upload', 'Upload & validasi'], ['review', 'Review exception'], ['evaluate', 'Evaluasi & WFO'], ['preview', 'Pratinjau & approval'], ['done', 'Export']] as const;
const PROCESS_TIMEOUT_MS = 120_000; // FR-08: processing must not hang

function FileDrop({ label, hint, file, error, onFile }: { label: string; hint: string; file: File | null; error?: string; onFile: (f: File | null) => void }) {
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <label className="drop" data-over={over} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
        <Upload aria-hidden="true" />
        <b>{label}</b>
        <span className="hint">{hint}</span>
        <span className="hint">Klik atau seret file .xlsx (maks. 64 MB)</span>
        <input type="file" accept=".xlsx" aria-label={`Pilih file ${label}`} onChange={(e) => { onFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
      </label>
      {file && (
        <div className="file-chip">
          <FileSpreadsheet aria-hidden="true" width={18} height={18} />
          <span title={file.name}>{file.name}</span><span className="muted num" style={{ flex: 'none' }}>{bytes(file.size)}</span>
          <button className="btn ghost sm" onClick={() => onFile(null)} aria-label={`Hapus ${file.name}`}><Trash2 /></button>
        </div>
      )}
      {error && <span className="err" role="alert">{error}</span>}
    </div>
  );
}

export default function Process() {
  const { proc, setProc, wipe, session } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState<{ fp?: string; hr?: string }>({});
  const [exporting, setExporting] = useState(false);
  const { res, rules, decisions, ing } = proc;

  const emps = useMemo(() => (res && rules ? summarizeEmployees(res, decisions, rules) : []), [res, rules, decisions]);
  const sum = useMemo(() => (res ? summarize(res, emps, decisions) : null), [res, emps, decisions]);
  const reached = { upload: true, review: !!res, evaluate: !!res, preview: !!res, done: !!proc.out };

  const pick = (k: 'fp' | 'hr', f: File | null) => {
    if (f && !f.name.toLowerCase().endsWith('.xlsx')) return setFileErr((e) => ({ ...e, [k]: 'Hanya file .xlsx yang diterima.' }));
    if (f && f.size > MAX_FILE_BYTES) return setFileErr((e) => ({ ...e, [k]: `Ukuran ${bytes(f.size)} melebihi batas 64 MB. Pecah atau kecilkan file.` }));
    setFileErr((e) => ({ ...e, [k]: undefined }));
    setErr(null);
    setProc({ [k]: f, ing: null, res: null, rules: null, decisions: {}, confirmed: false, out: null, step: 'upload' });
  };

  const run = async () => {
    if (!proc.fp || !proc.hr) return;
    setBusy(true); setErr(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = (async () => {
        const [a, b] = await Promise.all([proc.fp!.arrayBuffer(), proc.hr!.arrayBuffer()]);
        return ingest(a, b);
      })();
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('Pemrosesan melebihi batas waktu 2 menit. File mungkin terlalu berat atau rusak.')), PROCESS_TIMEOUT_MS); });
      const i = await Promise.race([work, timeout]);
      if (i.issues.some((x) => x.level === 'error')) { setProc({ ing: i, res: null, rules: null }); return; }
      const rs = activeRules(loadStore()); // FR-12: the rule version used is recorded in the output
      setProc({ ing: i, rules: rs, res: runEngine(i.taps, i.hris, rs, i.period, i.stats), decisions: {}, confirmed: false, out: null });
    } catch (e) {
      setErr((e as Error).message);
    } finally { clearTimeout(timer); setBusy(false); }
  };

  const doExport = async () => {
    if (!res || !rules || !session) return;
    setExporting(true); setErr(null);
    try {
      const { buffer, checksum, filename } = await buildResult({ res, hris: ing!.hris, emps, decisions, rules, user: session.email });
      download(buffer, filename);
      setProc({ out: { filename, checksum }, step: 'done' });
    } catch (e) { setErr(`Export gagal: ${(e as Error).message}`); } finally { setExporting(false); }
  };

  const errors = ing?.issues.filter((i) => i.level === 'error') ?? [];
  const warnings = ing?.issues.filter((i) => i.level === 'warning') ?? [];
  const openFlags = sum?.flags.undecided ?? 0;
  const locked = openFlags > 0 || !proc.confirmed;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Proses Attendance</h1>
          <p>Unggah file Fingerprint dan HRIS, putuskan setiap kasus yang di-flag, lalu ekspor hasil. Data hanya ada di sesi ini dan dihapus saat sesi berakhir.</p>
        </div>
        <span className="badge brand" data-tip="Dikelola Admin di Settings & Config">Rule aktif: v{(rules ?? activeRules(loadStore())).version}</span>
      </div>

      <ol className="steps" aria-label="Langkah proses">
        {STEPS.map(([k, label], i) => (
          <li key={k} aria-current={proc.step === k ? 'step' : undefined} className={STEPS.findIndex(([s]) => s === proc.step) > i ? 'done' : ''}>
            <button disabled={!reached[k]} onClick={() => setProc({ step: k })}>
              <i>{STEPS.findIndex(([s]) => s === proc.step) > i ? <Check aria-hidden="true" /> : i + 1}</i>{label}
            </button>
          </li>
        ))}
      </ol>

      {err && <Alert kind="error" title="Terjadi kesalahan">{err}</Alert>}

      {proc.step === 'upload' && (
        <>
          <div className="grid-2">
            <FileDrop label="File Fingerprint" hint="Kolom: Employee ID, Organization, Tanggal, Waktu, Status" file={proc.fp} error={fileErr.fp} onFile={(f) => pick('fp', f)} />
            <FileDrop label="File HRIS" hint="Kolom: Employee ID, Full Name, Organization, Date, Shift, Schedule In/Out, Attendance Code. Opsional: Approval Status, Leave Period (Full/AM/PM), Leave Start/End, Work Location, Check In/Out" file={proc.hr} error={fileErr.hr} onFile={(f) => pick('hr', f)} />
          </div>
          <div className="row">
            <button className="btn primary" onClick={run} disabled={!proc.fp || !proc.hr || busy}>{busy ? <><span className="spin" aria-hidden="true" />Memproses…</> : 'Validasi & proses'}</button>
            {!proc.fp || !proc.hr ? <span className="hint">Unggah kedua file untuk melanjutkan.</span> : null}
          </div>

          {ing && (
            <div className="card" aria-live="polite">
              <div className="card-head">
                <h2>Laporan validasi</h2>
                <div className="row">
                  <span className={`badge ${errors.length ? 'bad' : 'ok'}`}>{errors.length} error</span>
                  <span className={`badge ${warnings.length ? 'warn' : 'ok'}`}>{warnings.length} peringatan</span>
                  {ing.period && <span className="badge brand">Periode {period(ing.period)}</span>}
                </div>
              </div>
              <div className="card-pad stack">
                {errors.length > 0 && <Alert kind="error" title="Proses dihentikan">Perbaiki file sumber lalu unggah ulang. Tidak ada data yang diproses.</Alert>}
                {errors.length === 0 && res && (
                  <Alert kind="ok" title="Validasi lulus">
                    {ing.stats.fpRows.toLocaleString('id-ID')} baris Fingerprint dan {ing.stats.hrisRows.toLocaleString('id-ID')} baris HRIS digabung. {res.stats.dupRemoved.toLocaleString('id-ID')} tap duplikat atau mendekati duplikat digabung ({res.stats.exactDup.toLocaleString('id-ID')} persis sama; semuanya tetap tercatat sebagai bukti).{res.stats.dayOffDays ? ` Tap pada ${res.stats.dayOffDays} hari libur dianggap tidak ada.` : ''} {res.flags.length} kasus di-flag untuk review.
                  </Alert>
                )}
                {[...errors, ...warnings].length > 0 && (
                  <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
                    <table>
                      <thead><tr><th>Level</th><th>File</th><th>Lokasi</th><th>Masalah</th></tr></thead>
                      <tbody>{[...errors, ...warnings].slice(0, 200).map((i, n) => (
                        <tr key={n}><td><span className={`badge ${i.level === 'error' ? 'bad' : 'warn'}`}>{i.level === 'error' ? 'Error' : 'Peringatan'}</span></td><td>{i.file}</td><td className="muted">{i.where}</td><td>{i.message}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
                {res && <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={() => setProc({ step: 'review' })}>{res.flags.length ? `Lanjut ke review (${res.flags.length} flag)` : 'Lanjut ke evaluasi'}</button></div>}
              </div>
            </div>
          )}
        </>
      )}

      {proc.step === 'review' && res && sum && (
        <>
          <div className="metrics">
            <div className="stat"><span className="k">Total flag</span><span className="v">{sum.flags.total}</span><span className="s">{sum.flags.kritis} kritis · {sum.flags.informatif} informatif</span></div>
            <div className="stat"><span className="k">Belum diputuskan</span><span className="v">{sum.flags.undecided}</span><span className="s">{sum.flags.undecided ? 'Export terkunci' : 'Siap dipratinjau'}</span></div>
            <div className="stat"><span className="k">Rasio flag</span><span className="v">{pct(sum.flagRatio)}</span><span className="s">dari {res.days.length.toLocaleString('id-ID')} hari ber-tap · ambang {rules!.params.flagRatioPct}%</span></div>
          </div>
          {sum.flagRatio * 100 > rules!.params.flagRatioPct && (
            <Alert kind="warn" title="Peringatan kualitas data input">Proporsi flag ({pct(sum.flagRatio)}) melebihi ambang {rules!.params.flagRatioPct}% (setelan Config). Periksa file sumber sebelum memutuskan satu per satu, misalnya tap pulang yang hilang atau status tap yang tidak konsisten.</Alert>
          )}
          <ReviewStep res={res} decisions={decisions} user={session!.email} onDecide={(d) => setProc((p) => ({ decisions: { ...p.decisions, ...d }, confirmed: false }))} onNext={() => setProc({ step: 'evaluate' })} />
        </>
      )}

      {proc.step === 'evaluate' && res && rules && ing && (
        <>
          <Alert kind="info" title="Evaluasi memakai tiga sumber yang dipisahkan">Kehadiran fisik hanya dari fingerprint, status cuti/WFH dari Talenta, jam kerja dari jadwal HRIS hari itu. Data yang belum pasti ditandai &quot;Perlu review&quot;, bukan dianggap pelanggaran. Angka di sini sama persis dengan sheet Daily Evaluation dan WFO Compliance pada file export.</Alert>
          <ComplianceView res={res} hris={ing.hris} rules={rules} decisions={decisions} onReview={() => setProc({ step: 'review' })} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setProc({ step: 'review' })}>Kembali ke review</button>
            <button className="btn primary" onClick={() => setProc({ step: 'preview' })}>Lanjut ke pratinjau</button>
          </div>
        </>
      )}

      {proc.step === 'preview' && res && sum && (
        <>
          <div className="metrics">
            {[['Karyawan di Final Data', String(sum.employees), `${sum.days.toLocaleString('id-ID')} hari ber-tap`],
              ['Rata-rata % Complete', pct(sum.avgComplete), `rata-rata % Keterlambatan ${pct(sum.avgLate)}`],
              ['Rentang % Complete', `${pct(sum.min?.v, 0)}–${pct(sum.max?.v, 0)}`, sum.max ? `tertinggi ID ${sum.max.id}` : '–'],
              ['Perlu Evaluasi', String(sum.evaluate), `${sum.lateOver} dengan keterlambatan di atas ambang`],
              ['Flag', `${sum.flags.decided}/${sum.flags.total}`, sum.flags.undecided ? `${sum.flags.undecided} belum diputuskan` : 'semua diputuskan']].map(([k, v, s]) => (
              <div key={k} className="stat"><span className="k">{k}</span><span className="v">{v}</span><span className="s">{s}</span></div>
            ))}
          </div>
          <Alert kind="info" title="Periksa panel ini untuk kesalahan yang tidak di-flag">Sistem yakin tetapi bisa salah: bandingkan rata-rata dan rentang % Complete dengan harapan Anda sebelum approval. Catatan: % Complete = (Late + Early Clock Out) ÷ (Clock In + Clock Out), sesuai rumus sheet Final Data perusahaan.</Alert>
          <div className="card">
            <div className="card-head"><h2>Final Data: 10 baris pertama</h2><span className="muted">Periode {period(res.period)} · rule v{rules!.version}</span></div>
            <div className="table-wrap">
              <table className="dense">
                <thead><tr><th>No</th><th>Employee ID</th><th>Full Name</th><th>Organization</th><th>Work Schedule</th><th className="r">Clock In</th><th className="r">Late</th><th className="r">Clock Out</th><th className="r">Early</th><th className="r">% Complete</th><th>Remarks</th><th className="r">% Keterlambatan</th><th>Remarks Late</th></tr></thead>
                <tbody>{emps.slice(0, 10).map((e) => (
                  <tr key={e.id}><td className="num">{e.no}</td><td className="num">{e.id}</td><td>{e.name}</td><td>{e.dept}</td><td>{e.schedule}</td><td className="r num">{e.clockIn}</td><td className="r num">{e.late}</td><td className="r num">{e.clockOut}</td><td className="r num">{e.early}</td><td className="r num"><b>{pct(e.complete, 2)}</b></td><td>{e.remark}</td><td className="r num">{pct(e.lateRate, 2)}</td><td>{e.lateRemark}{e.pending ? ` · ${e.pending} hari menunggu keputusan` : ''}{e.unevaluated ? ` · ${e.unevaluated} hari belum dihitung (jadwal tidak jelas)` : ''}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </div>
          <div className="card card-pad stack">
            <label className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <input type="checkbox" checked={proc.confirmed} onChange={(e) => setProc({ confirmed: e.target.checked })} style={{ marginTop: 4 }} />
              <span>Saya telah memeriksa pratinjau dan ringkasan, serta menyetujui hasil ini untuk diekspor.</span>
            </label>
            {openFlags > 0 && <Alert kind="warn" title="Export terkunci"><span>{openFlags} flag belum diputuskan. </span><button className="btn sm" onClick={() => setProc({ step: 'review' })}>Kembali ke review</button></Alert>}
            <div className="row">
              <button className="btn primary" onClick={doExport} disabled={locked || exporting} aria-describedby="lock-why">
                {exporting ? <><span className="spin" aria-hidden="true" />Menyusun file…</> : locked ? <><Lock />Ekspor .xlsx</> : <><Download />Ekspor .xlsx</>}
              </button>
              <span id="lock-why" className="hint">{openFlags > 0 ? 'Putuskan semua flag terlebih dahulu.' : !proc.confirmed ? 'Centang konfirmasi untuk mengaktifkan export.' : 'File berisi sheet Final Data (format perusahaan), Master Data, Exception, Audit Trail, dan Metadata.'}</span>
            </div>
          </div>
        </>
      )}

      {proc.step === 'done' && proc.out && (
        <div className="card card-pad stack">
          <Alert kind="ok" title="Export berhasil"><span className="num">{proc.out.filename}</span> telah diunduh. Checksum: <code className="num">{proc.out.checksum.slice(0, 16)}…</code></Alert>
          <p className="muted">Unggah file ini di halaman Dashboard untuk melihat ringkasan bulanan atau tren. Jika file diubah manual setelah export, Dashboard akan memperingatkan. Setelah selesai, akhiri sesi data agar data karyawan dihapus dari browser.</p>
          <div className="row">
            <button className="btn" onClick={doExport} disabled={exporting}><Download />Unduh ulang</button>
            <button className="btn primary" onClick={wipe}><CheckCircle2 />Akhiri sesi data &amp; mulai baru</button>
          </div>
        </div>
      )}
    </div>
  );
}
