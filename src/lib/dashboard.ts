import { readSheets } from './xlsx';
import { AUDIT_COLS, CHECKSUM_KEY, EXCEPTION_COLS, FINAL_COLS, MASTER_COLS, META_COLS, SCHEMA, SHEET, checksumOf } from './exporter';
import { diffSnapshots } from './rules';

export const MAX_FILES = 12; // FR-30

export interface ResultEmployee {
  id: string; dept: string; schedule: string;
  complete: number; // "% Complete"
  lateRate: number | null; // "% Keterlambatan Clock In"
  remark: string; lateRemark: string; office: number;
}
export interface ResultFile {
  name: string; period: string; ruleVersion: number; createdAt: string; intact: boolean;
  employees: ResultEmployee[];
  exceptions: { category: string; severity: string; action: string }[];
  audit: [string, string, string][];
}

const sameCols = (row: unknown[] | undefined, cols: string[]) => !!row && cols.every((c, i) => row[i] === c);

/** Throws an Error with a user-readable message when the file is not a Tenflow result (FR-28). */
export async function parseResult(buf: ArrayBuffer, name: string): Promise<ResultFile> {
  let sheets: Record<string, unknown[][]>;
  try { sheets = await readSheets(buf); } catch { throw new Error('Bukan file .xlsx yang valid.'); }
  for (const s of Object.values(SHEET)) if (!sheets[s]) throw new Error(`Bukan file hasil Tenflow: sheet "${s}" tidak ditemukan.`);
  const [fin, master, exc, audit, meta] = [sheets[SHEET.final], sheets[SHEET.master], sheets[SHEET.exception], sheets[SHEET.audit], sheets[SHEET.meta]] as (string | number)[][][];
  const m = new Map(meta.slice(1).map((r) => [String(r[0]), r[1]]));
  if (m.get('Schema Version') !== SCHEMA) throw new Error(`Versi skema tidak didukung (${m.get('Schema Version') ?? 'tidak ada'}; diharapkan ${SCHEMA}).`);
  for (const [rows, cols, label] of [[fin, FINAL_COLS, SHEET.final], [master, MASTER_COLS, SHEET.master], [exc, EXCEPTION_COLS, SHEET.exception], [audit, AUDIT_COLS, SHEET.audit], [meta, META_COLS, SHEET.meta]] as const)
    if (!sameCols(rows[0], cols as string[])) throw new Error(`Struktur sheet "${label}" tidak sesuai skema.`);
  const period = String(m.get('Periode') ?? '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error(`Periode pada Metadata tidak valid: "${period}".`);
  const intact = (await checksumOf(fin, master, exc, audit, meta)) === m.get(CHECKSUM_KEY);
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  const z = (v: unknown) => (typeof v === 'number' ? v : 0); // formula cells whose cached result is 0 read back empty
  return {
    name, period, intact, ruleVersion: Number(m.get('Versi Rule')), createdAt: String(m.get('Dibuat') ?? ''),
    employees: fin.slice(1).map((r) => ({
      id: String(r[1]), dept: String(r[3]) || '(tanpa departemen)', schedule: String(r[17]), complete: z(r[9]), lateRate: num(r[18]) ?? (z(r[5]) > 0 ? 0 : null),
      remark: String(r[10]), lateRemark: String(r[19]), office: z(r[16]),
    })),
    exceptions: exc.slice(1).map((r) => ({ category: String(r[1]), severity: String(r[2]), action: String(r[8]) })),
    audit: audit.slice(1).filter((r) => String(r[0]).startsWith('Rule') && r[0] !== 'Rule: Versi').map((r) => [String(r[0]), String(r[1]), String(r[2])]),
  };
}

/** Adds files one by one, rejecting duplicates (same period) and anything over the cap, with a message per rejection (FR-30/33). */
export async function addResultFiles(current: ResultFile[], files: File[]): Promise<{ files: ResultFile[]; errors: string[] }> {
  const out = [...current], errors: string[] = [];
  for (const f of files) {
    if (out.length >= MAX_FILES) { errors.push(`${f.name}: batas ${MAX_FILES} file tercapai.`); continue; }
    if (!f.name.toLowerCase().endsWith('.xlsx')) { errors.push(`${f.name}: hanya file .xlsx hasil Tenflow yang diterima.`); continue; }
    try {
      const r = await parseResult(await f.arrayBuffer(), f.name);
      const dup = out.find((o) => o.period === r.period);
      if (dup) errors.push(`${f.name}: periode ${r.period} sudah ada (${dup.name}). Dua file untuk periode yang sama ditolak.`);
      else out.push(r);
    } catch (e) { errors.push(`${f.name}: ${(e as Error).message}`); }
  }
  return { files: out.sort((a, b) => (a.period < b.period ? -1 : 1)), errors };
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
export const BIN_WIDTH = 0.05; // histograms: 0–5 %, …, 40–45 %, ≥ 45 %
export const BIN_COUNT = 10;
const bin = (v: number) => Math.min(BIN_COUNT - 1, Math.floor(v / BIN_WIDTH + 1e-9));

export interface Monthly {
  n: number; avgComplete: number | null; avgLate: number | null;
  min: { v: number; id: string } | null; max: { v: number; id: string } | null;
  evaluate: number; lateOver: number; office: number;
  binsComplete: number[]; binsLate: number[];
  byDept: { dept: string; n: number; complete: number | null; late: number | null }[];
  byCategory: { category: string; kritis: number; informatif: number }[];
  byAction: { action: string; n: number }[];
}

export function monthly(f: ResultFile): Monthly {
  const es = f.employees;
  const binsComplete = Array<number>(BIN_COUNT).fill(0), binsLate = Array<number>(BIN_COUNT).fill(0);
  for (const e of es) { binsComplete[bin(e.complete)]++; if (e.lateRate != null) binsLate[bin(e.lateRate)]++; }
  const ext = (better: (a: number, b: number) => boolean) => es.reduce<{ v: number; id: string } | null>((m, e) => (!m || better(e.complete, m.v) ? { v: e.complete, id: e.id } : m), null);
  const late = (xs: ResultEmployee[]) => mean(xs.filter((e) => e.lateRate != null).map((e) => e.lateRate!));
  const depts = [...new Set(es.map((e) => e.dept))].sort();
  const cats = [...new Set(f.exceptions.map((x) => x.category))].sort();
  const acts = [...new Set(f.exceptions.map((x) => x.action))].sort();
  return {
    n: es.length, avgComplete: mean(es.map((e) => e.complete)), avgLate: late(es), min: ext((a, b) => a < b), max: ext((a, b) => a > b),
    evaluate: es.filter((e) => e.remark === 'Perlu Evaluasi').length, lateOver: es.filter((e) => e.lateRemark.startsWith('Late')).length,
    office: es.reduce((s, e) => s + e.office, 0), binsComplete, binsLate,
    byDept: depts.map((d) => { const x = es.filter((e) => e.dept === d); return { dept: d, n: x.length, complete: mean(x.map((e) => e.complete)), late: late(x) }; }),
    byCategory: cats.map((c) => ({ category: c, kritis: f.exceptions.filter((x) => x.category === c && x.severity === 'kritis').length, informatif: f.exceptions.filter((x) => x.category === c && x.severity !== 'kritis').length })),
    byAction: acts.map((a) => ({ action: a, n: f.exceptions.filter((x) => x.action === a).length })),
  };
}

export const monthsBetween = (a: string, b: string): string[] => {
  const out: string[] = [];
  let [y, m] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  while (y < y2 || (y === y2 && m <= m2)) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } }
  return out;
};

export interface TrendPoint { period: string; n: number | null; complete: number | null; late: number | null }
/** One point per calendar month between the first and last file; missing months stay null so the chart shows a gap (FR-33). */
export function trend(files: ResultFile[]): { points: TrendPoint[]; depts: { dept: string; complete: (number | null)[] }[] } {
  const sorted = [...files].sort((a, b) => (a.period < b.period ? -1 : 1));
  const months = monthsBetween(sorted[0].period, sorted[sorted.length - 1].period);
  const by = new Map(sorted.map((f) => [f.period, f]));
  const points = months.map((p): TrendPoint => { const f = by.get(p); if (!f) return { period: p, n: null, complete: null, late: null }; const m = monthly(f); return { period: p, n: m.n, complete: m.avgComplete, late: m.avgLate }; });
  const depts = [...new Set(sorted.flatMap((f) => f.employees.map((e) => e.dept)))].sort();
  return { points, depts: depts.map((d) => ({ dept: d, complete: months.map((p) => { const f = by.get(p); return f ? monthly(f).byDept.find((x) => x.dept === d)?.complete ?? null : null; }) })) };
}

export interface RuleWarning { from: string; to: string; versions: [number, number]; lines: string[] }
/** FR-31: periods computed with different rule versions are not apple-to-apple; show what changed. */
export function ruleWarnings(files: ResultFile[]): RuleWarning[] {
  const s = [...files].sort((a, b) => (a.period < b.period ? -1 : 1)), out: RuleWarning[] = [];
  for (let i = 1; i < s.length; i++) {
    const lines = diffSnapshots(s[i - 1].audit, s[i].audit);
    if (s[i - 1].ruleVersion !== s[i].ruleVersion || lines.length) out.push({ from: s[i - 1].period, to: s[i].period, versions: [s[i - 1].ruleVersion, s[i].ruleVersion], lines });
  }
  return out;
}
