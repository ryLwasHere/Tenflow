import type { EngineResult, FinalRow, MasterRow } from './types';
import { ACTION_LABEL, CATEGORY_LABEL, OUTCOME_LABEL } from './types';
import { snapshotRows, type RuleSet } from './rules';
import { masterRows, type Decisions } from './review';
import { canon, writeXlsx, type CellIn } from './xlsx';

export const SCHEMA = 'tenflow.result/2';
export const SHEET = { final: 'Final Data', master: 'Master Data', exception: 'Exception', audit: 'Audit Trail', meta: 'Metadata' } as const;
// Final Data / Master Data keep the exact column names and order of the company workbook.
export const FINAL_COLS = ['No', 'Employee ID', 'Full Name', 'Organization', 'Line Manager', 'Actual Clock In', 'Late Arrival Count', 'Actual Clock Out', 'Early Clock Out Count', '% Complete', 'Remarks', 'Week 1', 'Week 2', 'Week 3', 'Week 4', 'Week 5', 'Total Office Attendance', 'Work Schedule', '% Keterlambatan Clock In', 'Remarks Late Clock In'];
export const MASTER_COLS = ['Employee ID', 'Nama', 'Departemen', 'Tanggal', 'Jam Masuk', 'Jam Pulang', 'Aktual Jam Masuk', 'Aktual Jam Pulang', 'Status Masuk', 'Status Pulang', 'Work Schedule', 'Status Masuk Shifting', 'Status Pulang Shifting'];
export const EXCEPTION_COLS = ['ID Flag', 'Kategori', 'Severity', 'Employee ID', 'Nama', 'Departemen', 'Tanggal', 'Alasan Sistem', 'Keputusan', 'Outcome Override', 'Alasan Keputusan', 'Diputuskan Oleh', 'Waktu Keputusan'];
export const AUDIT_COLS = ['Bagian', 'Kunci', 'Nilai'];
export const META_COLS = ['Kunci', 'Nilai'];
export const CHECKSUM_KEY = 'Checksum';

type Rows = (string | number)[][];
const numId = (id: string) => (/^[1-9]\d{0,14}$/.test(id) ? Number(id) : id);
// exceljs does not persist a cached formula result of 0 (the cell reads back empty), so hash it as empty too.
const plain = (c: CellIn) => (c && typeof c === 'object' && 'formula' in c ? (c.result === 0 ? '' : c.result) : c);
const toHash = (rows: CellIn[][]): Rows => rows.map((r) => r.map((c) => canon(plain(c))));

export async function sha256(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Integrity mark over every data sheet + metadata (minus the checksum row itself). Detects edits, it is not a signature. */
export const checksumOf = (final: Rows, master: Rows, exception: Rows, audit: Rows, meta: Rows) =>
  sha256(JSON.stringify([final, master, exception, audit, meta.filter((r) => r[0] !== CHECKSUM_KEY)]));

const MASTER = `'${SHEET.master}'`;
/** Final Data rows: same formulas as the company sheet (counts from Master Data), matched on Employee ID, with cached results. */
function finalSheet(rows: FinalRow[], rules: RuleSet): CellIn[][] {
  const ev = rules.params.evalThresholdPct / 100, lt = rules.params.lateThresholdPct / 100;
  return [FINAL_COLS, ...rows.map((e, i): CellIn[] => {
    const r = i + 2, id = `B${r}`;
    const cnt = (col: string, crit: string) => `COUNTIFS(${MASTER}!A:A,${id},${MASTER}!${col}:${col},${crit})`;
    return [
      e.no, numId(e.id), e.name, e.dept, e.manager,
      { formula: cnt('G', '"<>"'), result: e.clockIn },
      { formula: cnt('I', '"Telat"'), result: e.late },
      { formula: cnt('H', '"<>"'), result: e.clockOut },
      { formula: cnt('J', '"Early Clock Out"'), result: e.early },
      { formula: `IF((F${r}+H${r})=0,0,(G${r}+I${r})/(F${r}+H${r}))`, result: e.complete },
      { formula: `IF(J${r}>${ev},"Perlu Evaluasi","Normal")`, result: e.remark },
      ...e.weeks,
      { formula: `SUM(L${r}:P${r})`, result: e.office },
      e.schedule,
      { formula: `IF(F${r}=0,"",G${r}/F${r})`, result: e.lateRate ?? '' },
      { formula: `IF(S${r}="","",IF(S${r}>${lt},"Late >${rules.params.lateThresholdPct}%","On Time"))`, result: e.lateRemark },
    ];
  })];
}

const day = (d: string) => new Date(`${d}T00:00:00Z`);
const clock = (min: number) => new Date(Date.UTC(1899, 11, 30) + Math.round(min * 60000)); // Excel time-of-day (read back as a Date too)
function masterSheet(rows: MasterRow[]): CellIn[][] {
  return [MASTER_COLS, ...rows.map((m): CellIn[] => [
    numId(m.id), m.name, m.dept, day(m.date), clock(m.first), clock(m.last), clock(m.first), clock(m.last),
    m.statusIn, m.statusOut, m.schedule, m.statusInShift, m.statusOutShift,
  ])];
}

export interface ExportInput { res: EngineResult; emps: FinalRow[]; decisions: Decisions; rules: RuleSet; user: string }

export async function buildResult({ res, emps, decisions, rules, user }: ExportInput): Promise<{ buffer: ArrayBuffer; checksum: string; filename: string }> {
  const now = new Date().toISOString();
  const final = finalSheet(emps, rules);
  const master = masterSheet(masterRows(res, decisions, rules));
  const exception: CellIn[][] = [EXCEPTION_COLS, ...res.flags.map((f): CellIn[] => {
    const d = decisions[f.id];
    return [f.id, CATEGORY_LABEL[f.category], f.severity, f.empId, f.name, f.dept, f.date, f.reason, ACTION_LABEL[d.action], d.outcome ? OUTCOME_LABEL[d.outcome] : '', d.reason, d.by, d.at];
  })];
  const count = (a: string) => Object.values(decisions).filter((d) => d.action === a).length;
  const audit: CellIn[][] = [AUDIT_COLS,
    ['Proses', 'Periode', res.period],
    ['Proses', 'Waktu proses', now],
    ['Proses', 'Diproses oleh', user],
    ['Proses', 'Versi rule', rules.version],
    ['Proses', 'Baris Fingerprint', res.stats.fpRows],
    ['Proses', 'Baris HRIS', res.stats.hrisRows],
    ['Proses', 'Tap duplikat digabung', res.stats.dupRemoved],
    ['Proses', 'Status tap dinormalisasi', res.stats.statusAliased],
    ['Proses', 'Tap di luar periode diabaikan', res.stats.tapsOutsidePeriod],
    ['Proses', 'Jumlah flag', res.flags.length],
    ['Proses', 'Keputusan accept / override / exclude', `${count('accept')} / ${count('override')} / ${count('exclude')}`],
    ['Rumus', 'Master Data', 'Satu baris per karyawan per hari yang punya tap. Jam Masuk = tap paling awal, Jam Pulang = tap paling akhir.'],
    ['Rumus', 'Final Data', 'Rumus Excel pada sheet Final Data menghitung dari Master Data: % Complete = (Late + Early Clock Out) ÷ (Actual Clock In + Actual Clock Out).'],
    ['Rule: Versi', 'Dibuat pada', rules.createdAt],
    ...snapshotRows(rules),
  ];
  const metaBase: CellIn[][] = [META_COLS,
    ['Schema Version', SCHEMA], ['Platform', 'Tenflow'], ['Periode', res.period], ['Versi Rule', rules.version],
    ['Dibuat', now], ['Jumlah Karyawan', emps.length], ['Algoritma Checksum', 'SHA-256'],
  ];
  const checksum = await checksumOf(toHash(final), toHash(master), toHash(exception), toHash(audit), toHash(metaBase));
  const buffer = await writeXlsx([
    { name: SHEET.final, rows: final, widths: [6, 14, 28, 24, 26, 12, 12, 12, 14, 12, 16, 8, 8, 8, 8, 8, 14, 14, 16, 18], fmts: { 9: '0.00%', 18: '0.00%' } },
    { name: SHEET.master, rows: master, widths: [14, 28, 24, 12, 11, 11, 14, 14, 12, 16, 14, 18, 18], fmts: { 3: 'd-mmm-yyyy', 4: 'h:mm', 5: 'h:mm', 6: 'h:mm', 7: 'h:mm' } },
    { name: SHEET.exception, rows: exception, widths: [34, 24, 11, 14, 26, 18, 12, 60, 11, 20, 40, 22, 24] },
    { name: SHEET.audit, rows: audit, widths: [18, 40, 90] },
    { name: SHEET.meta, rows: [...metaBase, [CHECKSUM_KEY, checksum]], widths: [22, 70] },
  ]);
  return { buffer, checksum, filename: `Tenflow_Final-Data_${res.period}_rule-v${rules.version}.xlsx` };
}
