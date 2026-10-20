import type { Decision, DayRecord, EngineResult, FinalRow, Flag, MasterRow } from './types';
import type { RuleSet } from './rules';

export type Decisions = Record<string, Decision>;

export const undecided = (flags: Flag[], d: Decisions) => flags.filter((f) => !d[f.id]);

/**
 * Final result of one employee-day. A day with any undecided flag is `pending` and counts nowhere (FR-13/14):
 * exclude beats override, override beats accept; accept keeps the tentative (company-formula) result.
 */
export function resolveDay(day: DayRecord, d: Decisions): { counted: boolean; late: boolean; early: boolean; pending: boolean } {
  if (day.flagIds.some((id) => !d[id])) return { counted: false, late: false, early: false, pending: true };
  const ds = day.flagIds.map((id) => d[id]);
  if (ds.some((x) => x.action === 'exclude')) return { counted: false, late: false, early: false, pending: false };
  const ov = ds.filter((x) => x.action === 'override' && x.outcome).pop();
  if (ov) return { counted: true, late: ov.outcome === 'late' || ov.outcome === 'late_early_out', early: ov.outcome === 'early_out' || ov.outcome === 'late_early_out', pending: false };
  return { counted: true, late: day.late, early: day.early, pending: false };
}

/** Week 1..5 of the month for a weekday (weeks start Monday; only weeks containing a weekday are numbered); 0 for weekends. */
export function weekOf(date: string, period: string): number {
  const [y, m] = period.split('-').map(Number);
  const dow = (iso: string) => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  if (dow(date) > 4) return 0;
  const monday = (iso: string) => Date.parse(`${iso}T00:00:00Z`) - dow(iso) * 864e5;
  const mondays = new Set<number>();
  for (let d = 1; new Date(Date.UTC(y, m - 1, d)).getUTCMonth() === m - 1; d++) {
    const iso = `${period}-${String(d).padStart(2, '0')}`;
    if (dow(iso) <= 4) mondays.add(monday(iso));
  }
  return [...mondays].sort((a, b) => a - b).indexOf(monday(date)) + 1;
}

const byId = (a: { id: string }, b: { id: string }) => (Number(a.id) - Number(b.id)) || (a.id < b.id ? -1 : 1);

/** Final Data rows, computed with the same formulas as the company sheet (see exporter for the Excel formulas). */
export function summarizeEmployees(res: EngineResult, d: Decisions, rules: RuleSet): FinalRow[] {
  const dropped = new Set(res.flags.filter((f) => f.scope === 'employee' && d[f.id]?.action === 'exclude').map((f) => f.empId));
  const rows = new Map<string, FinalRow>();
  for (const e of res.employees) {
    if (dropped.has(e.id) || !e.hasTaps) continue;
    rows.set(e.id, { no: 0, id: e.id, name: e.name, dept: e.dept, manager: e.manager, clockIn: 0, late: 0, clockOut: 0, early: 0, complete: 0, remark: '', weeks: [0, 0, 0, 0, 0], office: 0, schedule: e.schedule ?? '', lateRate: null, lateRemark: '', pending: 0 });
  }
  for (const day of res.days) {
    const r = rows.get(day.empId);
    if (!r) continue;
    const x = resolveDay(day, d);
    if (x.pending) { r.pending++; continue; }
    if (!x.counted) continue;
    r.clockIn++; r.clockOut++;
    if (x.late) r.late++;
    if (x.early) r.early++;
    const w = weekOf(day.date, res.period);
    if (w > 0 && w <= 5) r.weeks[w - 1]++;
  }
  const out = [...rows.values()].filter((r) => r.clockIn > 0 || r.pending > 0).sort(byId);
  out.forEach((r, i) => {
    r.no = i + 1;
    r.complete = r.clockIn + r.clockOut === 0 ? 0 : (r.late + r.early) / (r.clockIn + r.clockOut);
    r.remark = r.complete > rules.params.evalThresholdPct / 100 ? 'Perlu Evaluasi' : 'Normal';
    r.office = r.weeks.reduce((s, v) => s + v, 0);
    r.lateRate = r.clockIn ? r.late / r.clockIn : null;
    r.lateRemark = r.lateRate == null ? '' : r.lateRate > rules.params.lateThresholdPct / 100 ? `Late >${rules.params.lateThresholdPct}%` : 'On Time';
  });
  return out;
}

/** Master Data rows of every counted day (after decisions), with statuses as in the company sheet. */
export function masterRows(res: EngineResult, d: Decisions, rules: RuleSet): MasterRow[] {
  const emp = new Map(res.employees.map((e) => [e.id, e]));
  const sc = new Map(rules.schedules.map((s) => [s.name.toLowerCase(), s]));
  const dropped = new Set(res.flags.filter((f) => f.scope === 'employee' && d[f.id]?.action === 'exclude').map((f) => f.empId));
  const out: MasterRow[] = [];
  for (const day of res.days) {
    const e = emp.get(day.empId)!;
    const x = resolveDay(day, d);
    if (!x.counted || dropped.has(e.id)) continue;
    const s = e.schedule ?? '';
    const shifting = !!s && s.toUpperCase() !== 'REGULER' && sc.has(s.toLowerCase());
    out.push({
      id: e.id, name: e.name, dept: e.dept, date: day.date, first: day.first % 1440, last: day.last % 1440,
      statusIn: x.late ? 'Telat' : 'On Time', statusOut: x.early ? 'Early Clock Out' : 'Normal', schedule: s,
      statusInShift: shifting ? (x.late ? 'TELAT' : 'TIDAK TELAT') : '', statusOutShift: shifting ? (x.early ? 'Early Clock Out' : 'Normal') : '',
    });
  }
  return out.sort((a, b) => byId({ id: a.id }, { id: b.id }) || (a.date < b.date ? -1 : 1));
}

export interface Summary {
  employees: number;
  flags: { total: number; decided: number; undecided: number; kritis: number; informatif: number };
  flagRatio: number; // flags / employee-days with taps
  avgComplete: number | null;
  avgLate: number | null;
  min: { v: number; id: string } | null;
  max: { v: number; id: string } | null;
  evaluate: number; // employees marked "Perlu Evaluasi"
  lateOver: number; // employees marked "Late >x%"
  days: number;
}

export function summarize(res: EngineResult, rows: FinalRow[], d: Decisions): Summary {
  const pick = (better: (a: number, b: number) => boolean) => rows.reduce<{ v: number; id: string } | null>((m, e) => (!m || better(e.complete, m.v) ? { v: e.complete, id: e.id } : m), null);
  const late = rows.filter((r) => r.lateRate != null);
  const done = res.flags.filter((f) => d[f.id]).length;
  return {
    employees: rows.length,
    flags: { total: res.flags.length, decided: done, undecided: res.flags.length - done, kritis: res.flags.filter((f) => f.severity === 'kritis').length, informatif: res.flags.filter((f) => f.severity === 'informatif').length },
    flagRatio: res.days.length ? res.flags.length / res.days.length : 0,
    avgComplete: rows.length ? rows.reduce((s, e) => s + e.complete, 0) / rows.length : null,
    avgLate: late.length ? late.reduce((s, e) => s + e.lateRate!, 0) / late.length : null,
    min: pick((a, b) => a < b), max: pick((a, b) => a > b),
    evaluate: rows.filter((r) => r.remark === 'Perlu Evaluasi').length,
    lateOver: rows.filter((r) => r.lateRemark.startsWith('Late')).length,
    days: rows.reduce((s, r) => s + r.clockIn, 0),
  };
}
