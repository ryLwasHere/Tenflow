// Shared domain types. Dates are 'YYYY-MM-DD' strings, times are minutes since midnight
// (fractional when seconds are present). Wall-clock time: no time-zone conversion is applied.

export type Severity = 'kritis' | 'informatif';
export type Category = 'incomplete' | 'mismatch' | 'ambiguous' | 'no_rule' | 'conflict' | 'out_of_range';
export type Outcome = 'compliant' | 'late' | 'early_out' | 'late_early_out';
export type Action = 'accept' | 'override' | 'exclude';

export const CATEGORY_LABEL: Record<Category, string> = {
  incomplete: 'Data tidak lengkap',
  mismatch: 'Data tidak cocok',
  ambiguous: 'Data ambigu',
  no_rule: 'Tidak ada rule yang cocok',
  conflict: 'Konflik antar sumber',
  out_of_range: 'Nilai di luar batas wajar',
};
export const OUTCOME_LABEL: Record<Outcome, string> = {
  compliant: 'Patuh',
  late: 'Terlambat',
  early_out: 'Pulang awal',
  late_early_out: 'Terlambat & pulang awal',
};
export const ACTION_LABEL: Record<Action, string> = { accept: 'Accept', override: 'Override', exclude: 'Exclude' };

export interface Tap {
  id: string;
  org: string;
  date: string;
  min: number;
  kind: 'in' | 'out' | null; // null = status not recognised
  raw: string;
  row?: number; // source row in the fingerprint sheet (traceability; never used for matching)
  category?: string; // fingerprint-machine category (REGULER / SHIFTING / SHIFTING OB), only when the file has the optional column
}

export type Approval = 'approved' | 'pending' | 'rejected' | '';
export type LeavePart = 'full' | 'am' | 'pm' | '';

export interface HrisRow {
  id: string;
  name: string;
  org: string;
  date: string;
  shift: string;
  schedIn: number | null;
  schedOut: number | null;
  code: string;
  manager: string;
  // Optional Talenta columns. Absent / blank = unknown: never read as approved, as a full day, or as WFH.
  approval?: Approval;
  leavePart?: LeavePart;
  leaveStart?: number | null; // minutes, explicit leave period (takes precedence over leavePart)
  leaveEnd?: number | null;
  workMode?: 'wfh' | 'wfo' | '';
  tIn?: number | null; // Talenta Check In / Check Out (minutes); evidence only, never physical presence
  tOut?: number | null;
  row?: number;
}

export interface Issue {
  level: 'error' | 'warning';
  file: 'Fingerprint' | 'HRIS' | 'Antar file';
  where: string;
  message: string;
}

export interface Flag {
  id: string;
  category: Category;
  severity: Severity;
  scope: 'day' | 'employee';
  empId: string;
  name: string;
  dept: string;
  date: string; // '' for employee-level flags
  reason: string;
}

export interface Decision {
  action: Action;
  reason: string;
  outcome?: Outcome; // only for action === 'override' on a day-level flag
  by: string;
  at: string;
}

/** One employee-day that has at least one tap (a Master Data row). `late`/`early` are the tentative result. */
export interface DayRecord {
  empId: string;
  date: string;
  shift: string;
  code: string;
  first: number; // earliest tap, minutes (next-day taps of a midnight-crossing shift are +1440)
  last: number; // latest tap
  late: boolean;
  early: boolean;
  flagIds: string[];
  // Why late/early came out as they did (FR-16 traceability)
  hasIn: boolean; // the fingerprint has a clock-in / clock-out event
  hasOut: boolean;
  support: '' | 'in' | 'out'; // the missing side's time was taken from Talenta (Check In / Check Out)
  gap: '' | 'masuk' | 'pulang'; // a missing side that is neither supported by Talenta nor explained by approved leave/dinas (flagged incomplete)
  evaluated: boolean; // false = no usable schedule, late/early were NOT calculated
  category: string | null; // Work Schedule of this day's HRIS shift (REGULER / SHIFTING / SHIFTING OB ...)
  lateAfter: number | null; // threshold actually applied (minutes)
  earlyBefore: number | null;
  note: string; // human-readable basis, incl. leave adjustments
  tapsText: string; // every source tap of the day, kept in order, duplicates marked
}

export interface EmployeeInfo {
  id: string;
  name: string;
  dept: string;
  manager: string;
  schedule: string | null; // Work Schedule (REGULER / SHIFTING / SHIFTING OB ...), null = could not be classified
  hasTaps: boolean;
}

export interface EngineResult {
  period: string;
  ruleVersion: number;
  employees: EmployeeInfo[];
  days: DayRecord[];
  flags: Flag[];
  stats: { fpRows: number; hrisRows: number; tapsKept: number; dupRemoved: number; exactDup: number; dayOffDays: number; statusAliased: number; tapsOutsidePeriod: number };
}

/** One row of the Final Data sheet. */
export interface FinalRow {
  no: number;
  id: string;
  name: string;
  dept: string;
  manager: string;
  clockIn: number;
  late: number;
  clockOut: number;
  early: number;
  complete: number; // "% Complete" = (late + early) / (clockIn + clockOut), as defined by the company sheet
  remark: string;
  weeks: number[]; // Week 1..5: distinct weekdays in the office
  office: number;
  schedule: string;
  lateRate: number | null; // "% Keterlambatan Clock In" = late / clockIn
  lateRemark: string;
  pending: number; // days left out because a flag is still undecided
  unevaluated: number; // counted days whose schedule could not be resolved: late/early were not calculated for them
}

/** One row of the Master Data sheet (a counted employee-day). */
export interface MasterRow {
  id: string; name: string; dept: string; date: string;
  first: number; last: number; // minutes within the day (0..1440)
  statusIn: string; statusOut: string; schedule: string; statusInShift: string; statusOutShift: string;
}
