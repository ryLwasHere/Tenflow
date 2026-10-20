// Day-level evaluation of every scheduled day (including days without any fingerprint) and the WFO compliance built on it.
// Keeps separate: physical presence (fingerprint), Talenta status, schedule category, compliance, and review state.
import type { EngineResult, Flag, HrisRow } from './types';
import { ACTION_LABEL, CATEGORY_LABEL, OUTCOME_LABEL } from './types';
import type { RuleSet } from './rules';
import { isNonWork } from './ingest';
import { leaveInfo } from './leave';
import { resolveDay, type Decisions } from './review';
import { hhmm } from './format';

export type Mode = 'wfo' | 'wfh' | 'dinas' | 'leave' | 'leave_partial' | 'no_evidence' | 'pending' | 'excluded' | 'off' | 'off_presence';
export const MODE_LABEL: Record<Mode, string> = {
  wfo: 'WFO terverifikasi',
  wfh: 'WFH (bukan WFO)',
  dinas: 'Dinas / meeting luar',
  leave: 'Cuti / izin seharian',
  leave_partial: 'Cuti sebagian hari, tanpa fingerprint',
  no_evidence: 'Tanpa bukti kehadiran',
  pending: 'Menunggu keputusan flag',
  excluded: 'Dikeluarkan oleh HR',
  off: 'Libur / bukan jadwal kerja',
  off_presence: 'Tap di luar jadwal kerja',
};

export interface DayStatus {
  empId: string; name: string; dept: string; date: string; weekStart: string;
  shift: string; category: string | null; hours: string; scheduled: boolean;
  mode: Mode;
  physical: boolean; // fingerprint presence that counts (decided, not excluded)
  evidence: string; // every source tap of the day
  talenta: string;
  leave: string;
  approved: boolean | null; // null = no leave record
  excused: boolean; // approved full-day leave without counted presence: lowers the WFO obligation
  unresolved: boolean; // could still change the compliance result once HR resolves it
  late: 'ya' | 'tidak' | 'belum dihitung' | 'n/a';
  early: 'ya' | 'tidak' | 'belum dihitung' | 'n/a';
  sysLate: boolean | null; sysEarly: boolean | null; // system result, untouched by overrides
  missing: '' | 'masuk' | 'pulang';
  flags: number; openFlags: number;
  decision: string;
  review: string; // why HR review is (or was) needed, "" = none
  basis: string; // how late/early was judged
  source: string; // data provenance
}

const weekStart = (d: string) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
const lc = (s: string) => s.trim().toLowerCase();

export function evaluateDays(res: EngineResult, hris: HrisRow[], rules: RuleSet, decisions: Decisions): DayStatus[] {
  const P = rules.params;
  const emp = new Map(res.employees.map((e) => [e.id, e]));
  const sched = new Map(rules.schedules.map((s) => [lc(s.name), s.name]));
  const catOf = new Map(rules.shiftMap.map((m) => [lc(m.shift), sched.get(lc(m.schedule)) ?? null]));
  const rowsAt = new Map<string, HrisRow[]>();
  for (const r of hris) { const k = `${r.id}|${r.date}`; rowsAt.set(k, [...(rowsAt.get(k) ?? []), r]); }
  const dayAt = new Map(res.days.map((d) => [`${d.empId}|${d.date}`, d]));
  const flagsAt = new Map<string, Flag[]>();
  for (const f of res.flags) if (f.scope === 'day') flagsAt.set(`${f.empId}|${f.date}`, [...(flagsAt.get(`${f.empId}|${f.date}`) ?? []), f]);

  const out: DayStatus[] = [];
  for (const k of [...new Set([...rowsAt.keys(), ...dayAt.keys()])].sort()) {
    const [id, date] = k.split('|');
    const e = emp.get(id);
    if (!e) continue; // fingerprint-only ID: reported as a reconciliation flag, there is no employee to evaluate
    const rows = rowsAt.get(k) ?? [], row = rows[0], day = dayAt.get(k);
    const work = !!row && !isNonWork(row.shift);
    const lv = work ? leaveInfo(row, rules, day && day.last > day.first ? { first: day.first, last: day.last } : undefined) : null;
    const fl = flagsAt.get(k) ?? [];
    const open = fl.filter((f) => !decisions[f.id]);
    const r = day ? resolveDay(day, decisions) : null;
    const review: string[] = [];
    const src = [day ? 'Fingerprint' : '', row ? 'HRIS (jadwal)' : '', row?.code ? `Talenta (kode ${row.code})` : '', row?.tIn != null ? 'Talenta (Check In)' : ''].filter(Boolean);

    if (day?.support) src.push(`Jam ${day.support === 'out' ? 'pulang' : 'masuk'} dilengkapi Check ${day.support === 'out' ? 'Out' : 'In'} Talenta`);
    let mode: Mode, unresolved = false, excused = false;
    if (day && r) {
      if (r.pending) { mode = 'pending'; unresolved = work; review.push(...open.map((f) => `${CATEGORY_LABEL[f.category]}: ${f.reason}`)); }
      else if (r.excluded) mode = 'excluded';
      else if (work) mode = 'wfo';
      else { mode = 'off_presence'; if (!row) review.push('Tap pada tanggal tanpa jadwal HRIS'); }
    } else if (!work) mode = 'off';
    else if (lv?.treatment === 'wfh' || row!.workMode === 'wfh') { mode = 'wfh'; src.push(lv?.treatment === 'wfh' ? 'WFH: kode Talenta' : 'WFH: kolom Work Location'); }
    else if (lv?.treatment === 'dinas') {
      mode = 'dinas';
      if (lv.approved) excused = true; // official duty outside the office: the day cannot be an office day, so it lowers the obligation like approved leave
      else { unresolved = true; review.push(`${lv.label}: ${lv.approvalText}; pengecualian tidak diberikan otomatis`); }
    } else if (lv?.treatment === 'leave') {
      if (lv.part === 'full' && lv.approved) { mode = 'leave'; excused = true; }
      else if (lv.part === 'full') { mode = 'leave'; unresolved = true; review.push(`${lv.label}: ${lv.approvalText}; pengecualian tidak diberikan otomatis`); }
      else { mode = 'leave_partial'; unresolved = true; review.push(lv.part === 'unsupported' ? `${lv.label}: ${lv.partSource}` : `${lv.label} sebagian hari (${hhmm(lv.start!)}–${hhmm(lv.end!)}, ${lv.approvalText}) tanpa fingerprint: hadir sebagian atau tidak tidak dapat dipastikan`); }
    } else if (lv?.treatment === 'unknown') { mode = 'no_evidence'; unresolved = true; review.push(`Kode kehadiran "${row!.code}" belum punya rule`); }
    else if (!e.hasTaps && P.hrisOnlyPresence === 1 && row!.tIn != null) { mode = 'wfo'; src.push('Kehadiran: Check In Talenta (karyawan tanpa fingerprint, kebijakan Config)'); }
    else if (row!.tIn != null && P.inferWfhFromTalenta === 1) { mode = 'wfh'; src.push('WFH: disimpulkan dari Check In Talenta tanpa fingerprint (Config)'); }
    else {
      mode = 'no_evidence'; unresolved = true;
      review.push(row!.tIn != null ? 'Ada Check In Talenta tanpa fingerprint: bukan WFO, status WFH belum dikonfirmasi (pengaturan Config)' : 'Tidak ada fingerprint maupun catatan Talenta pada hari kerja ini: tidak dianggap absen otomatis');
    }
    if (!day && rows.length > 1 && rows.some((x) => x.shift !== row!.shift || x.code !== row!.code)) { unresolved = unresolved || work; review.push(`HRIS memuat ${rows.length} baris berbeda untuk hari ini (${rows.map((x) => `${x.shift}/${x.code || '-'}`).join(' vs ')})`); }

    const dec = fl.filter((f) => decisions[f.id]).map((f) => { const d = decisions[f.id]; return `${ACTION_LABEL[d.action]}${d.outcome ? ` (${OUTCOME_LABEL[d.outcome]})` : ''}: ${d.reason} [${d.by}]`; });
    const part = lv ? ` · ${lv.approvalText}${lv.treatment === 'leave' ? ` · ${lv.part === 'full' ? 'seharian' : lv.part === 'unsupported' ? 'periode tidak didukung' : `${hhmm(lv.start!)}–${hhmm(lv.end!)}`} (${lv.partSource})` : ''}` : '';
    const state = (v: boolean): 'ya' | 'tidak' => (v ? 'ya' : 'tidak');
    out.push({
      empId: id, name: e.name, dept: e.dept, date, weekStart: weekStart(date),
      shift: row?.shift ?? '', category: day?.category ?? (row && work ? catOf.get(lc(row.shift)) ?? null : null),
      hours: row && work && row.schedIn != null ? `${hhmm(row.schedIn)}–${hhmm(row.schedOut!)}` : '', scheduled: work && mode !== 'excluded',
      mode, physical: mode === 'wfo' || mode === 'off_presence', evidence: day?.tapsText ?? '',
      talenta: row ? `${row.code || '(tanpa kode)'}${row.workMode === 'wfh' ? ' · Work Location WFH' : ''}${row.tIn != null ? ` · Check In ${hhmm(row.tIn)}${row.tOut != null ? `–${hhmm(row.tOut)}` : ''}` : ''}` : '',
      leave: lv ? `${lv.label}${part}` : '', approved: lv && lv.treatment === 'leave' ? lv.approved : null,
      excused, unresolved,
      late: !r || !r.counted ? 'n/a' : !r.evaluated ? 'belum dihitung' : state(r.late),
      early: !r || !r.counted ? 'n/a' : !r.evaluated ? 'belum dihitung' : state(r.early),
      sysLate: day ? day.late : null, sysEarly: day ? day.early : null,
      missing: day ? day.gap : '', // only a gap nothing explains: Talenta-completed or leave/dinas-explained sides are not missing
      flags: fl.length, openFlags: open.length, decision: dec.join(' | '), review: review.join('; '),
      basis: day?.note ?? '', source: src.join(' + '),
    });
  }
  return out;
}

export interface WeekRow { weekStart: string; scheduled: number; excused: number; wfh: number; attended: number; unresolved: number; required: number; credited: number }
export type WfoStatus = 'patuh' | 'tidak_patuh' | 'review' | 'tanpa_kewajiban';
export const WFO_STATUS_LABEL: Record<WfoStatus, string> = { patuh: 'Patuh', tidak_patuh: 'Tidak patuh', review: 'Perlu review HR', tanpa_kewajiban: 'Tanpa kewajiban WFO' };

export interface WfoRow {
  id: string; name: string; dept: string; schedule: string;
  weeks: WeekRow[];
  scheduled: number; excused: number; wfh: number; attended: number; unresolved: number;
  required: number; credited: number; open: number; // open = unresolved days that could still close the gap
  rate: number | null;
  status: WfoStatus;
  explanation: string;
  late: number; early: number;
}

/**
 * WFO compliance per employee, week by week (Mon–Sun, clipped to the period).
 *   required_w = max(0, min(wfoDaysPerWeek, scheduled_w − approvedLeave_w − wfhAllowance))   [Config: leaveConsumesWfhAllowance = 1 drops the allowance term]
 *   credited_w = min(attended_w, required_w)           attended = days with verified fingerprint presence on a scheduled day
 *   rate       = Σ credited ÷ Σ required
 * Patuh when rate ≥ wfoCompliancePct. Tidak patuh only when the gap stays open even if every unresolved day went in the employee's favour;
 * otherwise Perlu review HR. WFH never counts as WFO and missing fingerprint is never proof of absence.
 */
export function wfoCompliance(days: DayStatus[], res: EngineResult, rules: RuleSet, decisions: Decisions): WfoRow[] {
  const P = rules.params;
  const byEmp = new Map<string, DayStatus[]>();
  for (const d of days) byEmp.set(d.empId, [...(byEmp.get(d.empId) ?? []), d]);
  const rows: WfoRow[] = [];
  for (const e of res.employees) {
    // same rule as Final Data: an employee-level "exclude" decision removes the employee everywhere
    if (res.flags.some((f) => f.scope === 'employee' && f.empId === e.id && decisions[f.id]?.action === 'exclude')) continue;
    const mine = byEmp.get(e.id) ?? [];
    const weeks = new Map<string, WeekRow>();
    for (const d of mine) {
      const w = weeks.get(d.weekStart) ?? { weekStart: d.weekStart, scheduled: 0, excused: 0, wfh: 0, attended: 0, unresolved: 0, required: 0, credited: 0 };
      weeks.set(d.weekStart, w);
      if (!d.scheduled) continue;
      w.scheduled++;
      if (d.excused) w.excused++;
      if (d.mode === 'wfh') w.wfh++;
      if (d.mode === 'wfo') w.attended++;
      if (d.unresolved) w.unresolved++;
    }
    const wk = [...weeks.values()].sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
    for (const w of wk) {
      const avail = w.scheduled - w.excused;
      w.required = Math.max(0, Math.min(P.wfoDaysPerWeek, P.leaveConsumesWfhAllowance === 1 ? avail : avail - P.wfhDaysPerWeek));
      w.credited = Math.min(w.attended, w.required);
    }
    const sum = (f: (w: WeekRow) => number) => wk.reduce((s, w) => s + f(w), 0);
    const required = sum((w) => w.required), credited = sum((w) => w.credited);
    const open = sum((w) => Math.min(w.unresolved, w.required - w.credited));
    const rate = required ? credited / required : null;
    const need = P.wfoCompliancePct / 100;
    const status: WfoStatus = required === 0 ? 'tanpa_kewajiban' : rate! >= need - 1e-9 ? 'patuh' : (credited + open) / required >= need - 1e-9 ? 'review' : 'tidak_patuh';
    const notes: string[] = [];
    if (!e.hasTaps) notes.push(`Karyawan tidak punya data fingerprint pada periode ini; dinilai dari data HRIS saja${P.hrisOnlyPresence === 1 ? ' (Check In Talenta dihitung sebagai kehadiran kantor)' : ''}.`);
    const excused = sum((w) => w.excused), wfh = sum((w) => w.wfh), unresolved = sum((w) => w.unresolved);
    notes.unshift(required === 0
      ? `Tidak ada kewajiban WFO pada periode ini (${sum((w) => w.scheduled)} hari terjadwal, ${excused} cuti disetujui).`
      : `${credited} dari ${required} hari WFO wajib terpenuhi. Dikecualikan: ${excused} hari cuti disetujui. WFH: ${wfh} hari (bukan WFO). Belum pasti: ${unresolved} hari.`);
    if (status === 'review') notes.push(`Hasil dapat berubah setelah ${open} hari yang belum pasti diputuskan.`);
    rows.push({
      id: e.id, name: e.name, dept: e.dept, schedule: e.schedule ?? '', weeks: wk,
      scheduled: sum((w) => w.scheduled), excused, wfh, attended: sum((w) => w.attended), unresolved, required, credited, open, rate, status, explanation: notes.join(' '),
      late: mine.filter((d) => d.late === 'ya').length, early: mine.filter((d) => d.early === 'ya').length,
    });
  }
  return rows.sort((a, b) => (Number(a.id) - Number(b.id)) || (a.id < b.id ? -1 : 1));
}

/** The single entry point for the UI and the export: every table and total below is derived from the same `days` and `rows`, so they reconcile. */
export function evaluateAttendance(res: EngineResult, hris: HrisRow[], rules: RuleSet, decisions: Decisions) {
  const all = evaluateDays(res, hris, rules, decisions);
  const rows = wfoCompliance(all, res, rules, decisions);
  const ids = new Set(rows.map((r) => r.id));
  const days = all.filter((d) => ids.has(d.empId));
  return { days, rows, summary: summarizeWfo(days, rows, res) };
}

export interface WfoSummary {
  employees: number; physical: number; wfhEmployees: number;
  byMode: Record<Mode, number>;
  required: number; credited: number; rate: number | null; // Σ credited ÷ Σ required over every evaluated employee
  status: Record<WfoStatus, number>;
  late: number; early: number; lateEmployees: number; earlyEmployees: number;
  missing: number; reviewDays: number; mismatchDays: number; duplicateDays: number;
}

export function summarizeWfo(days: DayStatus[], rows: WfoRow[], res: EngineResult): WfoSummary {
  const ids = new Set(rows.map((r) => r.id));
  const mine = days.filter((d) => ids.has(d.empId)); // employees dropped by an "exclude" decision leave every total, so totals reconcile with the tables
  const byMode = Object.fromEntries((Object.keys(MODE_LABEL) as Mode[]).map((m) => [m, 0])) as Record<Mode, number>;
  for (const d of mine) byMode[d.mode]++;
  const status = { patuh: 0, tidak_patuh: 0, review: 0, tanpa_kewajiban: 0 } as Record<WfoStatus, number>;
  for (const r of rows) status[r.status]++;
  const required = rows.reduce((s, r) => s + r.required, 0), credited = rows.reduce((s, r) => s + r.credited, 0);
  const dayFlags = (c: string) => new Set(res.flags.filter((f) => f.scope === 'day' && f.category === c && ids.has(f.empId)).map((f) => `${f.empId}|${f.date}`)).size;
  return {
    employees: rows.length,
    physical: rows.filter((r) => r.attended > 0).length,
    wfhEmployees: rows.filter((r) => r.wfh > 0).length,
    byMode, required, credited, rate: required ? credited / required : null, status,
    late: mine.filter((d) => d.late === 'ya').length, early: mine.filter((d) => d.early === 'ya').length,
    lateEmployees: rows.filter((r) => r.late > 0).length, earlyEmployees: rows.filter((r) => r.early > 0).length,
    missing: mine.filter((d) => d.missing).length,
    reviewDays: mine.filter((d) => d.unresolved || d.openFlags > 0).length,
    mismatchDays: dayFlags('mismatch'),
    duplicateDays: mine.filter((d) => d.evidence.includes('duplikat')).length,
  };
}
