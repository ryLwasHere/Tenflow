import type { EngineResult, FinalRow, HrisRow, MasterRow } from './types';
import { ACTION_LABEL, CATEGORY_LABEL, OUTCOME_LABEL } from './types';
import { snapshotRows, type RuleSet } from './rules';
import { masterRows, type Decisions } from './review';
import { MODE_LABEL, WFO_STATUS_LABEL, evaluateAttendance, type DayStatus, type WfoRow } from './compliance';
import { canon, writeXlsx, type CellIn } from './xlsx';

export const SCHEMA = 'tenflow.result/3';
export const LEGACY_SCHEMA = 'tenflow.result/2'; // files without the two evaluation sheets still load on the Dashboard
export const SHEET = { final: 'Final Data', master: 'Master Data', exception: 'Exception', audit: 'Audit Trail', meta: 'Metadata' } as const;
export const EVAL_SHEET = { daily: 'Daily Evaluation', wfo: 'WFO Compliance' } as const;
export const DAILY_COLS = ['Employee ID', 'Nama', 'Departemen', 'Tanggal', 'Minggu (Senin)', 'Shift HRIS', 'Kategori Jadwal', 'Jam Jadwal', 'Mode Kerja', 'Kehadiran Fisik', 'Bukti Tap Fingerprint', 'Status Talenta', 'Cuti / Izin', 'Dikecualikan', 'Terlambat', 'Pulang Awal', 'Hasil Sistem Terlambat', 'Hasil Sistem Pulang Awal', 'Event Hilang', 'Perlu Review', 'Alasan Review', 'Keputusan HR', 'Dasar Penilaian', 'Sumber Data'];
export const WFO_COLS = ['Employee ID', 'Nama', 'Departemen', 'Work Schedule', 'Hari Terjadwal', 'Cuti Disetujui (dikecualikan)', 'WFH', 'WFO Fisik', 'Hari Belum Pasti', 'WFO Wajib', 'WFO Terkredit', 'Kepatuhan WFO', 'Status', 'Penjelasan', 'Rincian per Minggu'];
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

/** Integrity mark over every data sheet + metadata (minus the checksum row itself). Detects edits, it is not a signature. `extra` = the evaluation sheets (absent in schema /2 files). */
export const checksumOf = (final: Rows, master: Rows, exception: Rows, audit: Rows, meta: Rows, extra: Rows[] = []) =>
  sha256(JSON.stringify([final, master, exception, audit, meta.filter((r) => r[0] !== CHECKSUM_KEY), ...extra]));

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

const yn = (b: boolean) => (b ? 'Ya' : 'Tidak');
function dailySheet(days: DayStatus[]): CellIn[][] {
  return [DAILY_COLS, ...days.map((d): CellIn[] => [
    numId(d.empId), d.name, d.dept, day(d.date), day(d.weekStart), d.shift, d.category ?? '', d.hours, MODE_LABEL[d.mode], yn(d.physical), d.evidence, d.talenta, d.leave,
    yn(d.excused), d.late, d.early, d.sysLate == null ? '' : yn(d.sysLate), d.sysEarly == null ? '' : yn(d.sysEarly), d.missing, yn(d.unresolved || d.openFlags > 0), d.review, d.decision, d.basis, d.source,
  ])];
}
function wfoSheet(rows: WfoRow[]): CellIn[][] {
  return [WFO_COLS, ...rows.map((r): CellIn[] => [
    numId(r.id), r.name, r.dept, r.schedule, r.scheduled, r.excused, r.wfh, r.attended, r.unresolved, r.required, r.credited, r.rate ?? '', WFO_STATUS_LABEL[r.status], r.explanation,
    r.weeks.map((w) => `${w.weekStart}: wajib ${w.required}, WFO ${w.attended}, terkredit ${w.credited}, cuti ${w.excused}, WFH ${w.wfh}, belum pasti ${w.unresolved}, terjadwal ${w.scheduled}`).join(' | '),
  ])];
}

export interface ExportInput { res: EngineResult; hris: HrisRow[]; emps: FinalRow[]; decisions: Decisions; rules: RuleSet; user: string }

export async function buildResult({ res, hris, emps, decisions, rules, user }: ExportInput): Promise<{ buffer: ArrayBuffer; checksum: string; filename: string }> {
  const now = new Date().toISOString();
  const final = finalSheet(emps, rules);
  const master = masterSheet(masterRows(res, decisions, rules));
  const { days, rows: wfo } = evaluateAttendance(res, hris, rules, decisions);
  const daily = dailySheet(days), wfoRows = wfoSheet(wfo);
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
    ['Proses', 'Tap duplikat digabung (semua, termasuk persis sama)', res.stats.dupRemoved],
    ['Proses', 'Di antaranya duplikat persis (ID, tanggal, jam, status sama)', res.stats.exactDup],
    ['Proses', 'Hari libur ber-tap (tap dianggap tidak ada)', rules.params.ignoreDayOffTaps === 1 ? res.stats.dayOffDays : 'tidak diabaikan (Config)'],
    ['Proses', 'Catatan tap', 'Tap yang digabung tidak dihapus dari bukti: tetap tercantum pada kolom Bukti Tap Fingerprint di Daily Evaluation.'],
    ['Proses', 'Dasar jadwal terlambat/pulang awal', rules.params.scheduleBasis === 1 ? 'Jam shift HRIS pada hari itu' : 'Work Schedule karyawan (rumus sheet perusahaan)'],
    ['Rumus', 'WFO Compliance', 'Wajib per minggu = max(0, min(hari WFO, hari terjadwal - cuti disetujui - jatah WFH)); terkredit = min(WFO fisik, wajib); kepatuhan = Σ terkredit ÷ Σ wajib. WFH dan catatan Talenta tidak pernah dihitung sebagai WFO.'],
    ['Rumus', 'Daily Evaluation', 'Satu baris per karyawan per hari terjadwal atau ber-tap. Kehadiran fisik hanya dari fingerprint; status cuti/WFH dari Talenta; jam dari jadwal HRIS hari itu.'],
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
  const checksum = await checksumOf(toHash(final), toHash(master), toHash(exception), toHash(audit), toHash(metaBase), [toHash(daily), toHash(wfoRows)]);
  const buffer = await writeXlsx([
    { name: SHEET.final, rows: final, widths: [6, 14, 28, 24, 26, 12, 12, 12, 14, 12, 16, 8, 8, 8, 8, 8, 14, 14, 16, 18], fmts: { 9: '0.00%', 18: '0.00%' } },
    { name: SHEET.master, rows: master, widths: [14, 28, 24, 12, 11, 11, 14, 14, 12, 16, 14, 18, 18], fmts: { 3: 'd-mmm-yyyy', 4: 'h:mm', 5: 'h:mm', 6: 'h:mm', 7: 'h:mm' } },
    { name: SHEET.exception, rows: exception, widths: [34, 24, 11, 14, 26, 18, 12, 60, 11, 20, 40, 22, 24] },
    { name: SHEET.audit, rows: audit, widths: [18, 40, 90] },
    { name: SHEET.meta, rows: [...metaBase, [CHECKSUM_KEY, checksum]], widths: [22, 70] },
    { name: EVAL_SHEET.daily, rows: daily, widths: [14, 24, 20, 12, 12, 12, 14, 12, 26, 10, 44, 34, 40, 11, 14, 14, 12, 12, 10, 10, 60, 50, 60, 40], fmts: { 3: 'd-mmm-yyyy', 4: 'd-mmm-yyyy' } },
    { name: EVAL_SHEET.wfo, rows: wfoRows, widths: [14, 24, 20, 14, 10, 14, 8, 10, 10, 10, 10, 12, 20, 70, 90], fmts: { 11: '0.00%' } },
  ]);
  return { buffer, checksum, filename: `Tenflow_Final-Data_${res.period}_rule-v${rules.version}.xlsx` };
}
