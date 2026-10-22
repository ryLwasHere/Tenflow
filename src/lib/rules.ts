// Rule set = structured parameters only (FR-39), versioned and logged (FR-36/37).
// Persistence is localStorage: there is no backend in this prototype.
import { hhmm } from './format';

export type Treatment = 'present' | 'leave' | 'wfh' | 'dinas';

export interface Params {
  dedupeWindowMin: number;
  outOfShiftAfterMin: number;
  minWorkMin: number;
  maxWorkMin: number;
  flagRatioPct: number;
  evalThresholdPct: number;
  lateThresholdPct: number;
  // --- schedule basis, leave interpretation and WFO policy (all flagged for HR confirmation, see README) ---
  scheduleBasis: number; // 1 = judge against the HRIS shift of that day, 0 = employee-level Work Schedule thresholds (company sheet)
  lateToleranceMin: number; // basis 1: late when the first tap is later than Schedule In + this
  earlyToleranceMin: number; // basis 1: early out when the last tap is earlier than Schedule Out - this
  lunchStartMin: number; // half-day leave without clock times: AM leave resumes at lunchEnd, PM leave starts at lunchStart
  lunchEndMin: number;
  leaveTapToleranceMin: number; // a tap this close to the edge of a leave period is not a conflict
  missingApprovalAsApproved: number; // 1 = a leave row without approval status counts as approved
  inferHalfDayAlr: number; // 1 = ALR without a period: on-time in + out before/at lunch = afternoon leave; late in after lunch + on-time out = morning leave
  leaveWorkedFullDay: number; // 1 = a leave code (full day) with taps that cover the whole shift (not late, not early out) is a worked day: presence from the fingerprint, no conflict flag
  forgotTapWhenPresent: number; // 1 = HRIS code is present (H) and only a clock-in or only a clock-out exists: forgot to tap, counts as present, no flag, the missing side is not judged
  missingOutAsEarly: number; // 1 = a day that counts as present despite a missing clock-out (HRIS H / flexible department) is counted as Early Clock Out, without a flag
  inferWfhFromTalenta: number; // 1 = a Talenta attendance record without fingerprint is WFH (edge-case doc §1)
  talentaFillsMissingTap: number; // 1 = a day with only a clock-in (or only a clock-out) takes the other time from Talenta Check Out (Check In); presence stays the fingerprint
  ignoreDayOffTaps: number; // 1 = taps on a day off / national holiday are treated as non-existent (no day row, no flag, no presence)
  hrisOnlyPresence: number; // 1 = for an employee with no fingerprint at all in the period, a Talenta Check In counts as office presence (takes precedence over inferWfhFromTalenta)
  wfoDaysPerWeek: number;
  wfhDaysPerWeek: number;
  leaveConsumesWfhAllowance: number; // 1 = approved leave days reduce the WFO obligation only below the WFH allowance
  wfoCompliancePct: number; // employee is compliant when credited WFO days / required WFO days >= this
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
/** flexDepts: departments whose staff are in and out of the office for meetings; optional so older stored versions stay valid (migrate adds it). */
export interface RuleSet { version: number; createdAt: string; params: Params; schedules: ScheduleRule[]; shiftMap: ShiftMap[]; attendance: AttendanceRule[]; flexDepts?: string[] }
/** "[AB] COM", "com" and "COM" are the same department: the bracketed company prefix and case are ignored. */
const deptKey = (s: string) => s.replace(/^\s*\[[^\]]*\]\s*/, '').trim().toLowerCase();
export const isFlexDept = (rs: RuleSet, dept: string) => !!dept && (rs.flexDepts ?? []).some((d) => deptKey(d) === deptKey(dept));
export interface LogEntry { version: number; at: string; by: string; action: 'create' | 'update' | 'delete'; target: string; detail: string }
export interface RuleStore { versions: RuleSet[]; log: LogEntry[] }

export const TREATMENT_LABEL: Record<Treatment, string> = {
  present: 'Hadir (tidak berkonflik dengan tap)',
  leave: 'Cuti / izin / sakit (tap pada hari ini di-flag konflik)',
  wfh: 'WFH menurut Talenta (tap fingerprint pada hari ini di-flag konflik)',
  dinas: 'Dinas / meeting luar kantor (bukan WFO atau WFH; bila disetujui mengurangi kewajiban WFO, tap yang hanya sebelah tidak di-flag)',
};

/** Leave types named in the edge-case document; every other code is shown as its own code, never guessed. */
export const LEAVE_LABEL: Record<string, string> = { ALR: 'Annual Leave Reguler', ALE: 'Annual Leave Executive' };

export const PARAM_META: { key: keyof Params; label: string; unit: string; help: string; max?: number }[] = [
  { key: 'evalThresholdPct', label: 'Ambang "Perlu Evaluasi"', unit: '%', max: 100, help: '% Complete di atas nilai ini diberi Remarks "Perlu Evaluasi".' },
  { key: 'lateThresholdPct', label: 'Ambang keterlambatan', unit: '%', max: 100, help: '% Keterlambatan Clock In di atas nilai ini diberi Remarks "Late >…%".' },
  { key: 'dedupeWindowMin', label: 'Jendela duplikasi tap', unit: 'menit', help: 'Tap sejenis dalam jendela ini dianggap satu tap (cleaning).' },
  { key: 'outOfShiftAfterMin', label: 'Batas tap pulang shift lintas hari', unit: 'menit', help: 'Shift yang melewati tengah malam: tap pulang keesokan harinya sampai batas ini setelah Schedule Out dihitung milik shift tersebut.' },
  { key: 'minWorkMin', label: 'Durasi kerja minimum wajar', unit: 'menit', help: 'Selisih tap pertama–terakhir di bawah ini di-flag (hari dengan satu tap sudah di-flag tersendiri).' },
  { key: 'maxWorkMin', label: 'Durasi kerja maksimum wajar', unit: 'menit', help: 'Selisih tap pertama–terakhir di atas ini di-flag.' },
  { key: 'flagRatioPct', label: 'Ambang proporsi flag', unit: '%', max: 100, help: 'Jika flag melebihi persentase ini dari hari ber-tap, tampilkan peringatan kualitas data (FR-19).' },
  { key: 'scheduleBasis', label: 'Dasar jadwal terlambat/pulang awal', unit: '0/1', max: 1, help: '1 = jam shift HRIS pada hari itu (sesuai dokumen edge case). 0 = ambang Work Schedule per karyawan seperti sheet Final Data perusahaan. Perlu konfirmasi HR.' },
  { key: 'lateToleranceMin', label: 'Toleransi terlambat (dasar shift HRIS)', unit: 'menit', help: 'Terlambat jika tap masuk lebih lambat dari Schedule In + nilai ini. Nilai awal 15 menit diturunkan dari ambang 09:15/07:15/06:15 pada sheet perusahaan. Perlu konfirmasi HR.' },
  { key: 'earlyToleranceMin', label: 'Toleransi pulang awal (dasar shift HRIS)', unit: 'menit', help: 'Pulang awal jika tap pulang lebih awal dari Schedule Out - nilai ini. Nilai awal 0, sesuai sheet perusahaan.' },
  { key: 'lunchStartMin', label: 'Mulai istirahat siang', unit: 'menit dari 00:00', max: 1439, help: 'Dipakai bila cuti setengah hari tidak membawa jam: cuti setelah makan siang dianggap mulai pada jam ini. 720 = 12:00. Perlu konfirmasi HR.' },
  { key: 'lunchEndMin', label: 'Selesai istirahat siang', unit: 'menit dari 00:00', max: 1439, help: 'Cuti sebelum makan siang dianggap selesai pada jam ini; kewajiban kerja dilanjutkan dari sini. 780 = 13:00. Perlu konfirmasi HR.' },
  { key: 'leaveTapToleranceMin', label: 'Toleransi tap di tepi periode cuti', unit: 'menit', help: 'Tap fingerprint yang jatuh di dalam periode cuti disetujui dianggap konflik, kecuali berjarak kurang dari ini dari tepinya.' },
  { key: 'missingApprovalAsApproved', label: 'Cuti tanpa status persetujuan dianggap disetujui', unit: '0/1', max: 1, help: '0 = tidak ada pengecualian otomatis tanpa status Approved (disarankan). Ubah ke 1 hanya jika ekspor Talenta hanya memuat cuti yang sudah disetujui.' },
  { key: 'inferHalfDayAlr', label: 'ALR tanpa periode: simpulkan cuti setengah hari dari tap', unit: '0/1', max: 1, help: '1 = HRIS berkode ALR tanpa periode/jam: masuk tepat waktu lalu pulang sebelum/saat istirahat siang (tidak sampai jam pulang) = cuti sore; masuk setelah istirahat siang lalu pulang tepat waktu = cuti pagi. Hanya bila kedua tap ada, tidak berlaku untuk shift lintas hari, dan status Pending/Rejected tetap konflik. 0 = ALR tanpa periode dibaca cuti seharian (konflik bila ada tap). Perlu konfirmasi HR.' },
  { key: 'leaveWorkedFullDay', label: 'Kode cuti + tap penuh seharian = hadir (tidak di-flag)', unit: '0/1', max: 1, help: '1 = HRIS berkode cuti/izin/sakit seharian tetapi tap pertama tidak terlambat dan tap terakhir tidak pulang awal (tap menutup seluruh jam shift): dianggap hadir menurut fingerprint, tanpa flag konflik; kode cuti tidak dinilai. 0 = selalu di-flag untuk keputusan HR. Perlu konfirmasi HR (dampak ke saldo cuti ada di luar aplikasi ini).' },
  { key: 'forgotTapWhenPresent', label: 'HRIS Hadir (H) + tap sebelah saja = lupa tap, dianggap hadir', unit: '0/1', max: 1, help: '1 = hari berkode Hadir di HRIS yang hanya punya tap masuk (atau hanya tap pulang), dan tidak bisa dilengkapi Talenta: dianggap lupa tap. Hari dianggap hadir, tanpa flag; sisi yang kosong tidak dinilai terlambat/pulang awal. 0 = di-flag seperti rumus sheet perusahaan. Perlu konfirmasi HR.' },
  { key: 'missingOutAsEarly', label: 'Lupa tap pulang = Early Clock Out', unit: '0/1', max: 1, help: '1 = hari berkode H atau divisi fleksibel yang tidak punya tap pulang tetap dianggap hadir, tanpa flag, tetapi dihitung Early Clock Out (bukan hanya Actual Clock Out). Tap masuk yang hilang tetap tidak dinilai terlambat. Cuti sore/dinas disetujui tidak terkena. 0 = sisi yang hilang tidak dinilai. Perlu konfirmasi HR.' },
  { key: 'inferWfhFromTalenta', label: 'Catatan Talenta tanpa fingerprint = WFH', unit: '0/1', max: 1, help: '1 = hari kerja dengan Check In Talenta tetapi tanpa tap fingerprint dikategorikan WFH (contoh dokumen edge case). Selalu bukan actual WFO. Perlu konfirmasi HR.' },
  { key: 'talentaFillsMissingTap', label: 'Check In/Out Talenta melengkapi tap yang hilang', unit: '0/1', max: 1, help: '1 = hari yang hanya punya tap masuk (atau hanya tap pulang) memakai Check Out (Check In) Talenta sebagai jam yang hilang, asalkan masuk akal (setelah tap masuk / sebelum tap pulang). Kehadiran fisik tetap dari fingerprint; hari ini tidak di-flag dan ditandai "dilengkapi Talenta". 0 = di-flag seperti rumus sheet perusahaan.' },
  { key: 'ignoreDayOffTaps', label: 'Tap di hari libur dianggap tidak ada', unit: '0/1', max: 1, help: '1 = tap pada hari berstatus dayoff / national holiday di HRIS diabaikan: tidak di-flag, tidak masuk Final Data, dan bukan kehadiran fisik (keputusan HR). 0 = tap tersebut di-flag dan dihitung seperti rumus sheet perusahaan.' },
  { key: 'hrisOnlyPresence', label: 'Karyawan tanpa fingerprint: Check In Talenta = hadir di kantor', unit: '0/1', max: 1, help: '1 = karyawan yang tidak punya satu pun tap fingerprint pada periode dinilai dari data HRIS: Check In Talenta dihitung sebagai kehadiran kantor untuk kepatuhan WFO (keputusan HR). Status WFH eksplisit dan cuti tetap berlaku. 0 = catatan Talenta tanpa fingerprint mengikuti pengaturan WFH di atas.' },
  { key: 'wfoDaysPerWeek', label: 'Hari WFO per minggu', unit: 'hari', max: 7, help: 'Ketentuan 4 hari WFO.' },
  { key: 'wfhDaysPerWeek', label: 'Jatah WFH per minggu', unit: 'hari', max: 7, help: 'Ketentuan 1 hari WFH. Kewajiban WFO per minggu = min(hari WFO, hari kerja terjadwal - cuti disetujui - jatah WFH).' },
  { key: 'leaveConsumesWfhAllowance', label: 'Cuti menghabiskan jatah WFH dahulu', unit: '0/1', max: 1, help: '1 = kewajiban WFO per minggu = min(hari WFO, hari kerja - cuti disetujui), jatah WFH tidak dikurangi. 0 = jatah WFH tetap dikurangkan. Interpretasi belum ditetapkan HR.' },
  { key: 'wfoCompliancePct', label: 'Ambang kepatuhan WFO', unit: '%', max: 100, help: 'Karyawan patuh bila hari WFO terkredit ÷ hari WFO wajib ≥ nilai ini. Perlu konfirmasi HR.' },
];

export const defaultParams = (): Params => ({
  dedupeWindowMin: 5, outOfShiftAfterMin: 360, minWorkMin: 60, maxWorkMin: 960, flagRatioPct: 10, evalThresholdPct: 20, lateThresholdPct: 20,
  scheduleBasis: 1, lateToleranceMin: 15, earlyToleranceMin: 0, lunchStartMin: 12 * 60, lunchEndMin: 13 * 60, leaveTapToleranceMin: 15, missingApprovalAsApproved: 0,
  inferHalfDayAlr: 1, leaveWorkedFullDay: 1, forgotTapWhenPresent: 1, missingOutAsEarly: 1, inferWfhFromTalenta: 1, talentaFillsMissingTap: 1, ignoreDayOffTaps: 1, hrisOnlyPresence: 1, wfoDaysPerWeek: 4, wfhDaysPerWeek: 1, leaveConsumesWfhAllowance: 0, wfoCompliancePct: 100,
});

const t = (h: number, m = 0) => h * 60 + m;

// Example rule set taken from the company's own workbook (Master Data formulas, Work Schedule column).
export function defaultStore(): RuleStore {
  const at = new Date().toISOString();
  const map = (schedule: string, shifts: string[]) => shifts.map((shift) => ({ shift, schedule }));
  const v1: RuleSet = {
    version: 1,
    createdAt: at,
    params: defaultParams(),
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
    flexDepts: ['COM'],
    attendance: [
      { id: 'a0', code: 'H', treatment: 'present' },
      ...['ALR', 'CL', 'SLD', 'CM', 'CKA', 'ALE'].map((code, i) => ({ id: `a${i + 1}`, code, treatment: 'leave' as Treatment })),
    ],
  };
  return { versions: [v1], log: [{ version: 1, at, by: 'sistem', action: 'create', target: 'Set aturan contoh', detail: 'Diturunkan dari rumus sheet Master Data/Final Data pada data contoh: ambang REGULER 09:15/18:00, SHIFTING 07:15/16:00, SHIFTING OB 06:15/15:00 (tap masuk ≥10:00: 10:15/19:00); Work Schedule karyawan = prioritas tertinggi dari shift HRIS. Parameter evaluasi (dasar jadwal shift HRIS, toleransi, istirahat siang, WFO 4:1, perlakuan cuti dan WFH) adalah interpretasi dokumen edge case yang perlu dikonfirmasi HR.' }] };
}

/**
 * A store saved before a parameter existed gets one new version that adds the missing keys with their defaults,
 * logged as 'sistem'. History is never rewritten, and the version a past result used stays as it was.
 */
export function migrate(s: RuleStore): RuleStore {
  const missing = (Object.keys(defaultParams()) as (keyof Params)[]).filter((k) => typeof activeRules(s).params[k] !== 'number');
  const noFlex = !activeRules(s).flexDepts;
  if (!missing.length && !noFlex) return s;
  const d = defaultParams();
  return commit(s, 'sistem', (draft) => {
    for (const k of missing) draft.params[k] = d[k];
    if (noFlex) draft.flexDepts = ['COM'];
    return { action: 'update', target: noFlex ? 'Parameter dan Divisi fleksibel' : 'Parameter', detail: `Migrasi: ${missing.length ? `parameter baru ditambahkan dengan nilai awal (${missing.join(', ')}). ` : ''}${noFlex ? 'Divisi fleksibel ditambahkan dengan nilai awal COM. ' : ''}Nilai lain tidak diubah.` };
  });
}

const KEY = 'tenflow.rules.v2';
export function loadStore(): RuleStore {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const s = JSON.parse(raw) as RuleStore; if (s.versions?.length) { const m = migrate(s); if (m !== s) saveStore(m); return m; } }
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
    ...(rs.flexDepts ?? []).map((r): [string, string, string] => ['Rule: Divisi Fleksibel', r, 'tap sebelah dan durasi tidak wajar dianggap hadir']),
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
