// Rule set = structured parameters only (FR-39), versioned and logged (FR-36/37).
// Persistence is localStorage: there is no backend in this prototype.
import { hhmm } from './format';

export type Treatment = 'present' | 'leave';

export interface Params {
  dedupeWindowMin: number;
  doubleTapGapMin: number;
  outOfShiftBeforeMin: number;
  outOfShiftAfterMin: number;
  minWorkMin: number;
  maxWorkMin: number;
  flagRatioPct: number;
  evalThresholdPct: number;
  lateThresholdPct: number;
}
/** A Work Schedule: late if first tap > lateAfter, early out if last tap < earlyBefore. `split` applies when the first tap is at/after `atMin`. Higher priority wins when an employee has several. */
export interface ScheduleRule {
  id: string;
  name: string;
  priority: number;
  lateAfterMin: number;
  earlyBeforeMin: number;
  split?: { atMin: number; lateAfterMin: number; earlyBeforeMin: number };
}
export interface ShiftMap { id: string; shift: string; schedule: string }
export interface AttendanceRule { id: string; code: string; treatment: Treatment }
export interface RuleSet { version: number; createdAt: string; params: Params; schedules: ScheduleRule[]; shiftMap: ShiftMap[]; attendance: AttendanceRule[] }
export interface LogEntry { version: number; at: string; by: string; action: 'create' | 'update' | 'delete'; target: string; detail: string }
export interface RuleStore { versions: RuleSet[]; log: LogEntry[] }

export const TREATMENT_LABEL: Record<Treatment, string> = {
  present: 'Hadir (tidak berkonflik dengan tap)',
  leave: 'Cuti / izin / sakit (tap pada hari ini di-flag konflik)',
};

export const PARAM_META: { key: keyof Params; label: string; unit: string; help: string; max?: number }[] = [
  { key: 'evalThresholdPct', label: 'Ambang "Perlu Evaluasi"', unit: '%', max: 100, help: '% Complete di atas nilai ini diberi Remarks "Perlu Evaluasi".' },
  { key: 'lateThresholdPct', label: 'Ambang keterlambatan', unit: '%', max: 100, help: '% Keterlambatan Clock In di atas nilai ini diberi Remarks "Late >…%".' },
  { key: 'dedupeWindowMin', label: 'Jendela duplikasi tap', unit: 'menit', help: 'Tap sejenis dalam jendela ini dianggap satu tap (cleaning).' },
  { key: 'doubleTapGapMin', label: 'Selisih tap ganda tidak wajar', unit: 'menit', help: 'Tap masuk/pulang ganda dengan selisih lebih dari ini di-flag sebagai ambigu.' },
  { key: 'outOfShiftBeforeMin', label: 'Tap masuk terlalu awal', unit: 'menit', help: 'Tap masuk lebih awal dari jam masuk jadwal HRIS sebanyak ini di-flag.' },
  { key: 'outOfShiftAfterMin', label: 'Tap pulang terlalu lambat', unit: 'menit', help: 'Tap pulang lebih lambat dari jam pulang jadwal HRIS sebanyak ini di-flag.' },
  { key: 'minWorkMin', label: 'Durasi kerja minimum wajar', unit: 'menit', help: 'Selisih tap pertama–terakhir di bawah ini di-flag (hari dengan satu tap sudah di-flag tersendiri).' },
  { key: 'maxWorkMin', label: 'Durasi kerja maksimum wajar', unit: 'menit', help: 'Selisih tap pertama–terakhir di atas ini di-flag.' },
  { key: 'flagRatioPct', label: 'Ambang proporsi flag', unit: '%', max: 100, help: 'Jika flag melebihi persentase ini dari hari ber-tap, tampilkan peringatan kualitas data (FR-19).' },
];

const t = (h: number, m = 0) => h * 60 + m;

// Example rule set taken from the company's own workbook (Master Data formulas, Work Schedule column).
export function defaultStore(): RuleStore {
  const at = new Date().toISOString();
  const map = (schedule: string, shifts: string[]) => shifts.map((shift) => ({ shift, schedule }));
  const v1: RuleSet = {
    version: 1,
    createdAt: at,
    params: { dedupeWindowMin: 5, doubleTapGapMin: 120, outOfShiftBeforeMin: 180, outOfShiftAfterMin: 360, minWorkMin: 60, maxWorkMin: 960, flagRatioPct: 10, evalThresholdPct: 20, lateThresholdPct: 20 },
    schedules: [
      { id: 'w1', name: 'REGULER', priority: 1, lateAfterMin: t(9, 15), earlyBeforeMin: t(18) },
      { id: 'w2', name: 'SHIFTING', priority: 2, lateAfterMin: t(7, 15), earlyBeforeMin: t(16) },
      { id: 'w3', name: 'SHIFTING OB', priority: 3, lateAfterMin: t(6, 15), earlyBeforeMin: t(15), split: { atMin: t(10), lateAfterMin: t(10, 15), earlyBeforeMin: t(19) } },
    ],
    shiftMap: [
      ...map('REGULER', ['N']),
      ...map('SHIFTING', ['S1', 'S1-SO', 'S2', 'S2-SO', 'S3', 'Shifting SO 1']),
      ...map('SHIFTING OB', ['S1 OP', 'S2-OP']),
    ].map((m, i) => ({ id: `m${i + 1}`, ...m })),
    attendance: [
      { id: 'a0', code: 'H', treatment: 'present' },
      ...['ALR', 'CL', 'SLD', 'CM', 'CKA', 'ALE'].map((code, i) => ({ id: `a${i + 1}`, code, treatment: 'leave' as Treatment })),
    ],
  };
  return { versions: [v1], log: [{ version: 1, at, by: 'sistem', action: 'create', target: 'Set aturan contoh', detail: 'Diturunkan dari rumus sheet Master Data/Final Data pada data contoh: ambang REGULER 09:15/18:00, SHIFTING 07:15/16:00, SHIFTING OB 06:15/15:00 (tap masuk ≥10:00: 10:15/19:00); Work Schedule karyawan = prioritas tertinggi dari shift HRIS.' }] };
}

const KEY = 'tenflow.rules.v2';
export function loadStore(): RuleStore {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const s = JSON.parse(raw) as RuleStore; if (s.versions?.length) return s; }
  } catch { /* fall through to defaults */ }
  return defaultStore();
}
export function saveStore(s: RuleStore) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked: changes live for this tab only */ }
}

export const activeRules = (s: RuleStore) => s.versions[s.versions.length - 1];

/** Applies one edit to a copy of the latest version and appends it as version N+1 with a log entry. */
export function commit(
  s: RuleStore, by: string,
  edit: (draft: RuleSet) => { action: LogEntry['action']; target: string; detail: string },
): RuleStore {
  const draft: RuleSet = structuredClone(activeRules(s));
  const { action, target, detail } = edit(draft);
  draft.version += 1;
  draft.createdAt = new Date().toISOString();
  return { versions: [...s.versions, draft], log: [...s.log, { version: draft.version, at: draft.createdAt, by, action, target, detail }] };
}

export const scheduleText = (r: ScheduleRule) =>
  `terlambat jika tap masuk > ${hhmm(r.lateAfterMin)}, pulang awal jika tap pulang < ${hhmm(r.earlyBeforeMin)}` +
  (r.split ? `; bila tap masuk ≥ ${hhmm(r.split.atMin)}: terlambat > ${hhmm(r.split.lateAfterMin)}, pulang awal < ${hhmm(r.split.earlyBeforeMin)}` : '') + `; prioritas ${r.priority}`;

/** Flat [section, key, value] rows: written to the Audit Trail sheet and read back for diffs (FR-25/31). */
export function snapshotRows(rs: RuleSet): [string, string, string][] {
  return [
    ...PARAM_META.map((m): [string, string, string] => ['Rule: Parameter', m.label, `${rs.params[m.key]} ${m.unit}`]),
    ...rs.schedules.map((r): [string, string, string] => ['Rule: Work Schedule', r.name, scheduleText(r)]),
    ...rs.shiftMap.map((r): [string, string, string] => ['Rule: Pemetaan Shift', r.shift, r.schedule]),
    ...rs.attendance.map((r): [string, string, string] => ['Rule: Kehadiran', r.code, TREATMENT_LABEL[r.treatment]]),
  ];
}

/** Human-readable differences between two snapshots (as written by snapshotRows). */
export function diffSnapshots(a: [string, string, string][], b: [string, string, string][]): string[] {
  const m = (rows: [string, string, string][]) => new Map(rows.map(([s, k, v]) => [`${s} · ${k}`, v]));
  const ma = m(a), mb = m(b), out: string[] = [];
  for (const [k, v] of mb) {
    if (!ma.has(k)) out.push(`+ ${k}: ${v}`);
    else if (ma.get(k) !== v) out.push(`~ ${k}: ${ma.get(k)} → ${v}`);
  }
  for (const k of ma.keys()) if (!mb.has(k)) out.push(`− ${k}`);
  return out;
}
