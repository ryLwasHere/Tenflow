import type { DayRecord, EmployeeInfo, EngineResult, Flag, Category, Severity, Tap, HrisRow } from './types';
import { TREATMENT_LABEL, type RuleSet, type ScheduleRule } from './rules';
import { isNonWork } from './ingest';
import { dmy, dur, hhmm } from './format';

const addDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const lc = (s: string) => s.trim().toLowerCase();

interface Bucket { in: Tap[]; out: Tap[]; other: Tap[] }

/** Late/early thresholds of a Work Schedule for a given first tap (the optional split window picks the second set). */
export function thresholds(s: ScheduleRule, first: number) {
  const w = s.split && first >= s.split.atMin ? s.split : s;
  return { lateAfter: w.lateAfterMin, earlyBefore: w.earlyBeforeMin };
}

/**
 * Mirrors the company workbook: every employee-day with a tap is one Master Data row whose clock-in is the
 * earliest tap and clock-out the latest tap; late / early-out are judged against the employee's Work Schedule.
 * Anything uncertain becomes a Flag; the DayRecord only carries a *tentative* result that counts after a human
 * decision (review.ts), so nothing is guessed silently.
 */
export function runEngine(
  taps: Tap[], hris: HrisRow[], rules: RuleSet, period: string,
  raw: { fpRows: number; hrisRows: number; statusAliased: number; tapsOutsidePeriod: number },
): EngineResult {
  const P = rules.params;
  const schedByName = new Map(rules.schedules.map((s) => [lc(s.name), s]));
  const shiftMap = new Map(rules.shiftMap.map((m) => [lc(m.shift), schedByName.get(lc(m.schedule))]));
  const leaveCode = new Map(rules.attendance.map((a) => [lc(a.code), a]));

  // --- employees + Work Schedule (highest-priority schedule among the employee's HRIS shifts) ---
  const emp = new Map<string, EmployeeInfo>();
  const mapped = new Map<string, Map<string, ScheduleRule>>();
  for (const r of hris) {
    const e = emp.get(r.id) ?? { id: r.id, name: r.name, dept: r.org, manager: r.manager, schedule: null, hasTaps: false };
    e.name ||= r.name; e.dept ||= r.org; e.manager ||= r.manager;
    emp.set(r.id, e);
    const sc = isNonWork(r.shift) ? undefined : shiftMap.get(lc(r.shift));
    if (sc) (mapped.get(r.id) ?? mapped.set(r.id, new Map()).get(r.id)!).set(sc.name, sc);
  }
  const tapCount = new Map<string, number>();
  for (const t of taps) tapCount.set(t.id, (tapCount.get(t.id) ?? 0) + 1);
  for (const e of emp.values()) {
    e.hasTaps = tapCount.has(e.id);
    e.schedule = [...(mapped.get(e.id)?.values() ?? [])].sort((a, b) => b.priority - a.priority)[0]?.name ?? null;
  }

  // --- cleaning: collapse duplicate taps (first-in / last-out of each cluster) ---
  const sorted = [...taps].sort((a, b) => cmp(a.id, b.id) || cmp(a.date, b.date) || a.min - b.min);
  const buckets = new Map<string, Bucket>();
  let dupRemoved = 0, kept = 0;
  for (const t of sorted) {
    const k = `${t.id}|${t.date}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = { in: [], out: [], other: [] }));
    const list = t.kind === 'in' ? b.in : t.kind === 'out' ? b.out : b.other;
    const last = list[list.length - 1];
    if (last && t.kind && t.min - last.min <= P.dedupeWindowMin) { dupRemoved++; if (t.kind === 'out') list[list.length - 1] = t; continue; }
    list.push(t); kept++;
  }

  // --- flags ---
  const flagMap = new Map<string, Flag>();
  const addFlag = (category: Category, severity: Severity, scope: Flag['scope'], empId: string, date: string, reason: string, who?: { name: string; dept: string }) => {
    const id = `${category}|${empId}|${date}`;
    const f = flagMap.get(id);
    if (f) { f.reason += `; ${reason}`; if (severity === 'kritis') f.severity = 'kritis'; }
    else { const e = emp.get(empId); flagMap.set(id, { id, category, severity, scope, empId, name: who?.name ?? e?.name ?? '', dept: who?.dept ?? e?.dept ?? '', date, reason }); }
    return id;
  };

  // --- one DayRecord per employee-day with taps ---
  const rowAt = new Map<string, HrisRow>();
  for (const r of hris) rowAt.set(`${r.id}|${r.date}`, r);
  const claimed = new Set<Tap>();
  const days: DayRecord[] = [];

  for (const [k, b] of buckets) {
    const [id, date] = k.split('|');
    const e = emp.get(id);
    if (!e) continue; // fingerprint-only ID: flagged below
    const row = rowAt.get(k);
    const work = !!row && !isNonWork(row.shift);
    const cross = work && row!.schedOut! <= row!.schedIn!; // midnight-crossing shift (FR-10)

    const all = [...b.in, ...b.out, ...b.other].filter((t) => !claimed.has(t)).map((t) => ({ t, abs: t.min }));
    if (cross) for (const t of buckets.get(`${id}|${addDay(date)}`)?.out ?? []) if (!claimed.has(t) && t.min <= row!.schedOut! + P.outOfShiftAfterMin) all.push({ t, abs: 1440 + t.min });
    all.forEach((x) => claimed.add(x.t));
    if (!all.length) continue;
    if (!date.startsWith(period)) continue; // spill-over day after the period that no shift claimed

    const first = Math.min(...all.map((x) => x.abs)), last = Math.max(...all.map((x) => x.abs));
    const ins = all.filter((x) => x.t.kind === 'in'), outs = all.filter((x) => x.t.kind === 'out');
    const flagIds: string[] = [];
    const flag = (c: Category, s: Severity, reason: string) => { const fid = addFlag(c, s, 'day', id, date, reason); if (!flagIds.includes(fid)) flagIds.push(fid); };
    const where = `${dmy(date)}${row ? `, shift ${row.shift}` : ''}`;

    for (const x of all) if (!x.t.kind) flag('ambiguous', 'kritis', `Status tap tidak dikenal "${x.t.raw}" pada ${hhmm(x.abs)} (tetap dihitung sebagai tap)`);
    if (!row) flag('ambiguous', 'informatif', `Tap pada tanggal tanpa jadwal HRIS (${hhmm(first)}–${hhmm(last)})`);
    else if (!work) flag('ambiguous', 'informatif', `Tap pada hari libur (${row.shift}) pukul ${hhmm(first)}–${hhmm(last)}`);
    if (work) {
      if (!shiftMap.get(lc(row!.shift))) flag('no_rule', 'kritis', `Shift "${row!.shift}" belum dipetakan ke Work Schedule`);
      if (cross) flag('no_rule', 'kritis', `Shift lintas hari ${row!.shift} (${hhmm(row!.schedIn!)}–${hhmm(row!.schedOut!)}) belum punya rule jam; dihitung sementara dengan Work Schedule ${e.schedule ?? '–'}`);
      const code = row!.code;
      if (code) {
        const ar = leaveCode.get(lc(code));
        if (!ar) flag('no_rule', 'kritis', `Kode kehadiran "${code}" belum punya rule`);
        else if (ar.treatment === 'leave') flag('conflict', 'kritis', `Fingerprint menunjukkan hadir (${hhmm(first)}–${hhmm(last)}) tetapi HRIS berkode ${code} (${TREATMENT_LABEL.leave.split(' (')[0]})`);
      }
    }
    if (!ins.length) flag('incomplete', 'kritis', `Tap masuk tidak ditemukan pada ${where}; jam masuk = tap paling awal ${hhmm(first)}`);
    if (!outs.length) flag('incomplete', 'kritis', `Tap pulang tidak ditemukan pada ${where}; jam pulang = tap paling akhir ${hhmm(last)}`);
    if (work && !cross) {
      const si = row!.schedIn!, so = row!.schedOut!;
      if (ins.length > 1 && ins[ins.length - 1].abs - ins[0].abs > P.doubleTapGapMin)
        flag('ambiguous', 'informatif', `Tap masuk ganda ${hhmm(ins[0].abs)} dan ${hhmm(ins[ins.length - 1].abs)} (selisih ${dur(ins[ins.length - 1].abs - ins[0].abs)})`);
      if (outs.length > 1 && outs[outs.length - 1].abs - outs[0].abs > P.doubleTapGapMin)
        flag('ambiguous', 'informatif', `Tap pulang ganda ${hhmm(outs[0].abs)} dan ${hhmm(outs[outs.length - 1].abs)} (selisih ${dur(outs[outs.length - 1].abs - outs[0].abs)})`);
      if (ins.length && (ins[0].abs < si - P.outOfShiftBeforeMin || ins[0].abs > so)) flag('ambiguous', 'informatif', `Tap masuk ${hhmm(ins[0].abs)} di luar jam shift ${hhmm(si)}–${hhmm(so)}`);
      if (outs.length && (outs[outs.length - 1].abs < si || outs[outs.length - 1].abs > so + P.outOfShiftAfterMin)) flag('ambiguous', 'informatif', `Tap pulang ${hhmm(outs[outs.length - 1].abs)} di luar jam shift ${hhmm(si)}–${hhmm(so)}`);
    }
    if (last > first && (last - first < P.minWorkMin || last - first > P.maxWorkMin)) flag('out_of_range', 'kritis', `Durasi tap pertama–terakhir ${dur(last - first)} di luar batas wajar (${P.minWorkMin}–${P.maxWorkMin} mnt)`);

    const sc = e.schedule ? schedByName.get(lc(e.schedule)) : undefined;
    const th = sc ? thresholds(sc, first) : null;
    days.push({ empId: id, date, shift: row?.shift ?? '', code: row?.code ?? '', first, last, late: !!th && first > th.lateAfter, early: !!th && last < th.earlyBefore, flagIds });
  }

  // --- employee-level flags ---
  const fpOnlyOrg = new Map<string, string>();
  for (const [k, b] of buckets) { const id = k.split('|')[0]; if (!emp.has(id) && !fpOnlyOrg.has(id)) fpOnlyOrg.set(id, [...b.in, ...b.out, ...b.other][0].org); }
  for (const [id, n] of tapCount) if (!emp.has(id))
    addFlag('mismatch', 'kritis', 'employee', id, '', `ID ada di Fingerprint (${n} tap) tetapi tidak ada di HRIS; tidak masuk Final Data`, { name: '', dept: fpOnlyOrg.get(id) ?? '' });
  for (const e of emp.values()) {
    if (!e.hasTaps) addFlag('mismatch', 'informatif', 'employee', e.id, '', 'ID ada di HRIS tetapi tidak punya satu pun tap di Fingerprint; tidak masuk Final Data');
    if (!e.dept) addFlag('incomplete', 'kritis', 'employee', e.id, '', 'Karyawan tanpa departemen');
    if (e.hasTaps && !e.schedule) addFlag('no_rule', 'kritis', 'employee', e.id, '', 'Tidak ada shift HRIS karyawan yang terpetakan ke Work Schedule; ambang telat/pulang awal tidak dapat ditentukan');
    const names = [...(mapped.get(e.id)?.keys() ?? [])];
    if (e.hasTaps && names.length > 1) addFlag('ambiguous', 'informatif', 'employee', e.id, '', `Jadwal campuran (${names.join(', ')}); dipakai prioritas tertinggi: ${e.schedule}`);
  }

  const flags = [...flagMap.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'kritis' ? -1 : 1) || cmp(a.category, b.category) || cmp(a.date, b.date) || cmp(a.empId, b.empId));
  return { period, ruleVersion: rules.version, employees: [...emp.values()], days, flags, stats: { ...raw, tapsKept: kept, dupRemoved } };
}
