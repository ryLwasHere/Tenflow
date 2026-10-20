import { readTable, normHeader, type Cell, type Row } from './xlsx';
import type { HrisRow, Issue, Tap } from './types';

export const MAX_FILE_BYTES = 64 * 1024 * 1024; // FR-08

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export function parseDate(c: Cell): string | null {
  if (c instanceof Date) return isNaN(+c) ? null : ymd(c);
  if (typeof c === 'number') return c > 20000 && c < 80000 ? ymd(new Date(Date.UTC(1899, 11, 30) + c * 864e5)) : null; // Excel serial
  if (typeof c !== 'string') return null;
  let m = c.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = c.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  return m ? valid(+m[3], +m[2], +m[1]) : null;
}
function valid(y: number, mo: number, d: number): string | null {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null;
}

/** Minutes since midnight (fractional when seconds exist). */
export function parseTime(c: Cell): number | null {
  if (c instanceof Date) return isNaN(+c) ? null : c.getUTCHours() * 60 + c.getUTCMinutes() + c.getUTCSeconds() / 60;
  if (typeof c === 'number') return c >= 0 && c < 1 ? Math.round(c * 86400) / 60 : null;
  if (typeof c !== 'string') return null;
  const m = c.match(/^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?$/);
  if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] ?? 0) > 59) return null;
  return +m[1] * 60 + +m[2] + +(m[3] ?? 0) / 60;
}

export function parseId(c: Cell): string | null {
  if (typeof c === 'number') return Number.isFinite(c) ? String(Math.trunc(c)) : null;
  return typeof c === 'string' && c ? c.replace(/\.0+$/, '') : null;
}

const NON_WORK = new Set(['dayoff', 'national holiday']);
export const isNonWork = (shift: string) => NON_WORK.has(shift.trim().toLowerCase());

export interface Ingested {
  taps: Tap[];
  hris: HrisRow[];
  period: string; // YYYY-MM
  issues: Issue[];
  stats: { fpRows: number; hrisRows: number; statusAliased: number; tapsOutsidePeriod: number };
}

const MAX_ISSUES = 500;
const FP_REQ = ['Employee ID', 'Organization', 'Tanggal', 'Waktu', 'Status'];
const HR_REQ = ['Employee ID', 'Full Name', 'Organization', 'Date', 'Shift', 'Schedule In', 'Schedule Out', 'Attendance Code'];

function statusKind(raw: string): { kind: Tap['kind']; aliased: boolean } {
  const s = raw.toLowerCase().replace(/\s+/g, '');
  if (s === 'c/masuk') return { kind: 'in', aliased: false };
  if (s === 'c/keluar') return { kind: 'out', aliased: false };
  if (s === 'masuk') return { kind: 'in', aliased: true };
  if (s === 'keluar') return { kind: 'out', aliased: true };
  return { kind: null, aliased: false };
}

export async function ingest(fpBuf: ArrayBuffer, hrBuf: ArrayBuffer): Promise<Ingested> {
  const issues: Issue[] = [];
  let dropped = 0;
  const add = (i: Issue) => { if (issues.length < MAX_ISSUES) issues.push(i); else dropped++; };
  const out: Ingested = { taps: [], hris: [], period: '', issues, stats: { fpRows: 0, hrisRows: 0, statusAliased: 0, tapsOutsidePeriod: 0 } };

  const [fp, hr] = await Promise.all([
    readTable(fpBuf, FP_REQ, ['Full Name']).catch((e) => { add({ level: 'error', file: 'Fingerprint', where: 'File', message: `File tidak dapat dibaca sebagai .xlsx (${e.message})` }); return null; }),
    readTable(hrBuf, HR_REQ, ['Check In', 'Check Out', 'Line Manager']).catch((e) => { add({ level: 'error', file: 'HRIS', where: 'File', message: `File tidak dapat dibaca sebagai .xlsx (${e.message})` }); return null; }),
  ]);
  if (fp && !fp.table) add({ level: 'error', file: 'Fingerprint', where: `Sheet: ${fp.sheets.join(', ')}`, message: `Kolom wajib tidak ditemukan: ${fp.missing.join(', ')}` });
  if (hr && !hr.table) add({ level: 'error', file: 'HRIS', where: `Sheet: ${hr.sheets.join(', ')}`, message: `Kolom wajib tidak ditemukan: ${hr.missing.join(', ')}` });
  if (!fp?.table || !hr?.table) return out;

  const loc = (t: { sheet: string }, n: number, col: string) => `${t.sheet}, baris ${n}, kolom ${col}`;
  const g = (r: Row, h: string) => r[normHeader(h)] ?? null;

  // HRIS (schedule backbone)
  for (const { n, cells } of hr.table.rows) {
    const id = parseId(g(cells, 'Employee ID'));
    const date = parseDate(g(cells, 'Date'));
    const shift = String(g(cells, 'Shift') ?? '').trim();
    if (!id) { add({ level: 'error', file: 'HRIS', where: loc(hr.table, n, 'Employee ID'), message: 'Employee ID kosong atau tidak terbaca' }); continue; }
    if (!date) { add({ level: 'error', file: 'HRIS', where: loc(hr.table, n, 'Date'), message: `Tanggal tidak terbaca: "${g(cells, 'Date') ?? ''}"` }); continue; }
    if (!shift) { add({ level: 'error', file: 'HRIS', where: loc(hr.table, n, 'Shift'), message: 'Shift kosong' }); continue; }
    let schedIn: number | null = null, schedOut: number | null = null;
    if (!isNonWork(shift)) {
      schedIn = parseTime(g(cells, 'Schedule In'));
      schedOut = parseTime(g(cells, 'Schedule Out'));
      if (schedIn == null) { add({ level: 'error', file: 'HRIS', where: loc(hr.table, n, 'Schedule In'), message: `Jam jadwal masuk tidak terbaca untuk shift ${shift}` }); continue; }
      if (schedOut == null) { add({ level: 'error', file: 'HRIS', where: loc(hr.table, n, 'Schedule Out'), message: `Jam jadwal pulang tidak terbaca untuk shift ${shift}` }); continue; }
    }
    const org = String(g(cells, 'Organization') ?? '').trim();
    if (!org) add({ level: 'warning', file: 'HRIS', where: loc(hr.table, n, 'Organization'), message: `Departemen kosong untuk ID ${id} (akan di-flag)` });
    out.hris.push({ id, name: String(g(cells, 'Full Name') ?? '').trim(), org, date, shift, schedIn, schedOut, code: String(g(cells, 'Attendance Code') ?? '').trim(), manager: String(g(cells, 'Line Manager') ?? '').trim() });
  }
  out.stats.hrisRows = hr.table.rows.length;

  const months = [...new Set(out.hris.map((r) => r.date.slice(0, 7)))].sort();
  if (months.length > 1) add({ level: 'error', file: 'HRIS', where: 'Kolom Date', message: `File HRIS memuat lebih dari satu periode (${months.join(', ')}). Unggah satu bulan per proses.` });
  if (!out.hris.length && !issues.some((i) => i.file === 'HRIS')) add({ level: 'error', file: 'HRIS', where: hr.table.sheet, message: 'Tidak ada baris data' });
  out.period = months[0] ?? '';

  // Fingerprint
  const dupKey = new Set<string>();
  for (const { n, cells } of fp.table.rows) {
    const id = parseId(g(cells, 'Employee ID'));
    const date = parseDate(g(cells, 'Tanggal'));
    const min = parseTime(g(cells, 'Waktu'));
    if (!id) { add({ level: 'error', file: 'Fingerprint', where: loc(fp.table, n, 'Employee ID'), message: 'Employee ID kosong atau tidak terbaca' }); continue; }
    if (!date) { add({ level: 'error', file: 'Fingerprint', where: loc(fp.table, n, 'Tanggal'), message: `Tanggal tidak terbaca: "${g(cells, 'Tanggal') ?? ''}"` }); continue; }
    if (min == null) { add({ level: 'error', file: 'Fingerprint', where: loc(fp.table, n, 'Waktu'), message: `Jam tidak terbaca: "${g(cells, 'Waktu') ?? ''}"` }); continue; }
    const raw = String(g(cells, 'Status') ?? '').trim();
    const { kind, aliased } = statusKind(raw);
    if (aliased) out.stats.statusAliased++;
    if (!kind) { add({ level: 'warning', file: 'Fingerprint', where: loc(fp.table, n, 'Status'), message: `Status tap tidak dikenal: "${raw}" (tap di-flag)` }); }
    dupKey.add(id);
    out.taps.push({ id, org: String(g(cells, 'Organization') ?? '').trim(), date, min, kind, raw });
  }
  out.stats.fpRows = fp.table.rows.length;
  if (out.stats.statusAliased) add({ level: 'warning', file: 'Fingerprint', where: 'Kolom Status', message: `${out.stats.statusAliased} tap berstatus "Keluar"/"Masuk" dinormalisasi menjadi C/Keluar / C/Masuk` });

  // Drop taps outside the HRIS period (+1 day: the out-tap of a shift crossing midnight on the last day)
  if (out.period) {
    const [y, m] = out.period.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); // first day of next month
    const before = out.taps.length;
    out.taps = out.taps.filter((t) => t.date.slice(0, 7) === out.period || t.date === last);
    out.stats.tapsOutsidePeriod = before - out.taps.length;
    if (out.stats.tapsOutsidePeriod) add({ level: 'warning', file: 'Fingerprint', where: 'Kolom Tanggal', message: `${out.stats.tapsOutsidePeriod} tap berada di luar periode ${out.period} dan diabaikan` });
  }

  // FR-06: join-key mismatches (reported here, flagged in the engine)
  const hrIds = new Set(out.hris.map((r) => r.id));
  const fpOnly = [...dupKey].filter((i) => !hrIds.has(i));
  const hrOnly = [...hrIds].filter((i) => !dupKey.has(i));
  const sample = (a: string[]) => a.slice(0, 8).join(', ') + (a.length > 8 ? `, … (+${a.length - 8})` : '');
  if (fpOnly.length) add({ level: 'warning', file: 'Antar file', where: 'Employee ID', message: `${fpOnly.length} ID ada di Fingerprint tetapi tidak di HRIS: ${sample(fpOnly)}` });
  if (hrOnly.length) add({ level: 'warning', file: 'Antar file', where: 'Employee ID', message: `${hrOnly.length} ID ada di HRIS tetapi tidak di Fingerprint: ${sample(hrOnly)}` });

  if (dropped) issues.push({ level: 'warning', file: 'Antar file', where: 'Laporan', message: `${dropped} temuan tambahan tidak ditampilkan (batas ${MAX_ISSUES}).` });
  return out;
}
