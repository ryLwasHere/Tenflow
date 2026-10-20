import type { HrisRow } from './types';
import { LEAVE_LABEL, type RuleSet, type Treatment } from './rules';
import { hhmm } from './format';

const lc = (s: string) => s.trim().toLowerCase();

export interface LeaveInfo {
  code: string;
  label: string; // Annual Leave Reguler / Executive when documented, otherwise "Kode X"
  treatment: Treatment | 'unknown'; // unknown = the code has no rule in Config
  approved: boolean;
  approvalText: string;
  part: 'full' | 'am' | 'pm' | 'time' | 'unsupported';
  partSource: string; // where the period came from (explicit times / Leave Period column / assumed full day)
  start: number | null; // leave period in minutes of the shift day (end > 1440 on a midnight-crossing shift)
  end: number | null;
}

/** First / last tap of the day (minutes of the shift day); only passed when both a clock-in and a clock-out exist. */
export interface DayTaps { first: number; last: number }

export const isPartial = (l: LeaveInfo) => l.part === 'am' || l.part === 'pm' || l.part === 'time';

/**
 * Reads one HRIS row as a leave / WFH record. null = ordinary present day (code H or empty).
 * Approval and period are never guessed: a missing approval is not "approved" (unless Config says so)
 * and a leave code without a period is read as a full day, which is the only reading the code itself supports.
 */
export function leaveInfo(row: HrisRow | undefined, rules: RuleSet, taps?: DayTaps): LeaveInfo | null {
  if (!row?.code) return null;
  const rule = rules.attendance.find((a) => lc(a.code) === lc(row.code));
  if (rule?.treatment === 'present') return null;
  const P = rules.params;
  const label = LEAVE_LABEL[row.code.toUpperCase()] ?? `Kode ${row.code}`;
  const appr = row.approval ?? '';
  const approved = appr === 'approved' || (appr === '' && P.missingApprovalAsApproved === 1);
  const approvalText = appr === 'approved' ? 'disetujui' : appr === 'pending' ? 'menunggu persetujuan' : appr === 'rejected' ? 'ditolak' : P.missingApprovalAsApproved === 1 ? 'tanpa status (dianggap disetujui sesuai Config)' : 'status persetujuan tidak tersedia';
  const base = { code: row.code, label, treatment: rule?.treatment ?? 'unknown', approved, approvalText } as const;
  if (rule?.treatment === 'wfh' || rule?.treatment === 'dinas') return { ...base, part: 'full', partSource: 'status harian', start: null, end: null };

  const si = row.schedIn, so0 = row.schedOut;
  if (si == null || so0 == null) return { ...base, part: 'full', partSource: 'tidak ada jadwal HRIS pada hari ini', start: null, end: null };
  const cross = so0 <= si, so = cross ? so0 + 1440 : so0;
  if (row.leaveStart != null && row.leaveEnd != null) {
    const full = row.leaveStart <= si && row.leaveEnd >= so;
    return { ...base, part: full ? 'full' : 'time', partSource: 'jam cuti eksplisit dari HRIS', start: row.leaveStart, end: row.leaveEnd };
  }
  const part = row.leavePart ?? '';
  if (part === 'am' || part === 'pm') {
    if (cross) return { ...base, part: 'unsupported', partSource: 'cuti setengah hari pada shift lintas hari tanpa jam eksplisit', start: null, end: null };
    return part === 'am'
      ? { ...base, part: 'am', partSource: `kolom Leave Period; dianggap selesai ${hhmm(P.lunchEndMin)} (istirahat siang di Config)`, start: si, end: Math.min(so, P.lunchEndMin) }
      : { ...base, part: 'pm', partSource: `kolom Leave Period; dianggap mulai ${hhmm(P.lunchStartMin)} (istirahat siang di Config)`, start: Math.max(si, P.lunchStartMin), end: so };
  }
  if (part === '' && !cross && taps && P.inferHalfDayAlr === 1 && row.code.toUpperCase() === 'ALR' && appr !== 'pending' && appr !== 'rejected') {
    // HR rule: ALR without a period. On time in + leaves around lunch = afternoon leave; late in after lunch + on time out = morning leave.
    // The tap that shows presence sits at the edge of the inferred period, so it is never a conflict. Taps only suggest the period; no approval is invented.
    const { first, last } = taps, inOnTime = first <= si + P.lateToleranceMin, outOnTime = last >= so - P.earlyToleranceMin;
    const inferred = { ...base, approved: true, approvalText: `${approvalText}; cuti setengah hari disimpulkan dari tap (Config)` };
    if (inOnTime && !outOnTime && last <= P.lunchEndMin) return { ...inferred, part: 'pm', partSource: `periode tidak tersedia; masuk ${hhmm(first)} dan pulang ${hhmm(last)} sebelum/saat istirahat siang, dibaca sebagai cuti sore`, start: Math.max(si, last), end: so };
    if (!inOnTime && outOnTime && first >= P.lunchStartMin) return { ...inferred, part: 'am', partSource: `periode tidak tersedia; masuk ${hhmm(first)} setelah istirahat siang dan pulang ${hhmm(last)} tepat waktu, dibaca sebagai cuti pagi`, start: si, end: Math.min(so, P.lunchEndMin, first) };
  }
  return { ...base, part: 'full', partSource: part === 'full' ? 'kolom Leave Period' : 'periode tidak tersedia, kode dibaca sebagai cuti seharian', start: si, end: so };
}

/** Taps (minutes of the shift day) that fall inside the leave period, beyond the tolerance at its edges. Approved partial leave only. */
export const tapsInLeave = (l: LeaveInfo, taps: number[], tol: number) =>
  l.start == null || l.end == null ? [] : taps.filter((t) => t > l.start! + tol && t < l.end! - tol);
