import type { DayRecord, EmployeeInfo, EngineResult, Flag, Category, Severity, Tap, HrisRow } from './types';
import { TREATMENT_LABEL, isFlexDept, type RuleSet, type ScheduleRule } from './rules';
import { isNonWork } from './ingest';
import { dmy, dur, hhmm } from './format';
import { isPartial, leaveInfo, tapsInLeave } from './leave';

const addDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const lc = (s: string) => s.trim().toLowerCase();
const sameRow = (a: HrisRow, b: HrisRow) => a.shift === b.shift && a.code === b.code && a.schedIn === b.schedIn && a.schedOut === b.schedOut;

interface Bucket { in: Tap[]; out: Tap[]; other: Tap[] }

/** Late/early thresholds of a Work Schedule for a given first tap (the optional split window picks the second set). Used when scheduleBasis = 0. */
export function thresholds(s: ScheduleRule, first: number) {
  const w = s.split && first >= s.split.atMin ? s.split : s;
  return { lateAfter: w.lateAfterMin, earlyBefore: w.earlyBeforeMin };
}

/**
 * Every employee-day with a tap is one Master Data row (as in the company workbook): clock-in is the earliest tap, clock-out the
 * latest tap. Late / early-out are judged against the HRIS shift of that day (scheduleBasis 1) or, to reproduce the company sheet,
 * the employee-level Work Schedule (scheduleBasis 0). Anything uncertain becomes a Flag; the DayRecord only carries a *tentative*
 * result that counts after a human decision (review.ts), so nothing is guessed silently. Source taps are never dropped:
 * near-duplicates are folded into one event but stay listed in `tapsText`.
 */
export function runEngine(
  taps: Tap[], hris: HrisRow[], rules: RuleSet, period: string,
  raw: { fpRows: number; hrisRows: number; statusAliased: number; tapsOutsidePeriod: number },
): EngineResult {
  const P = rules.params;
  const legacy = P.scheduleBasis === 0;
  const schedByName = new Map(rules.schedules.map((s) => [lc(s.name), s]));
  const shiftMap = new Map(rules.shiftMap.map((m) => [lc(m.shift), schedByName.get(lc(m.schedule))]));

  // --- employees + Work Schedule (highest-priority schedule among the employee's HRIS shifts; display + legacy basis) ---
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

  // --- cleaning: fold near-duplicate taps into the first-in / last-out of each cluster; the folded taps stay attached for display ---
  const sorted = [...taps].sort((a, b) => cmp(a.id, b.id) || cmp(a.date, b.date) || a.min - b.min);
  const buckets = new Map<string, Bucket>();
  const absorbed = new Map<Tap, Tap[]>();
  let dupRemoved = 0, exactDup = 0, kept = 0;
  for (const t of sorted) {
    const k = `${t.id}|${t.date}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = { in: [], out: [], other: [] }));
    const list = t.kind === 'in' ? b.in : t.kind === 'out' ? b.out : b.other;
    const last = list[list.length - 1];
    if (last && t.kind && t.min - last.min <= P.dedupeWindowMin) {
      dupRemoved++; if (t.min === last.min) exactDup++;
      if (t.kind === 'out') { list[list.length - 1] = t; absorbed.set(t, [...(absorbed.get(last) ?? []), last]); }
      else absorbed.set(last, [...(absorbed.get(last) ?? []), t]);
      continue;
    }
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
  const rowsAt = new Map<string, HrisRow[]>();
  for (const r of hris) { const k = `${r.id}|${r.date}`; rowsAt.set(k, [...(rowsAt.get(k) ?? []), r]); }
  const claimed = new Set<Tap>();
  const days: DayRecord[] = [];
  let dayOffDays = 0;

  for (const [k, b] of buckets) {
    const [id, date] = k.split('|');
    const e = emp.get(id);
    if (!e) continue; // fingerprint-only ID: flagged below
    const rows = rowsAt.get(k) ?? [];
    const row = rows[0];
    const work = !!row && !isNonWork(row.shift);
    const cross = work && row!.schedOut! <= row!.schedIn!; // midnight-crossing shift (FR-10)
    const cat = work ? shiftMap.get(lc(row!.shift)) : undefined;

    const all = [...b.in, ...b.out, ...b.other].filter((t) => !claimed.has(t)).map((t) => ({ t, abs: t.min }));
    if (cross) for (const t of buckets.get(`${id}|${addDay(date)}`)?.out ?? []) if (!claimed.has(t) && t.min <= row!.schedOut! + P.outOfShiftAfterMin) all.push({ t, abs: 1440 + t.min });
    all.forEach((x) => claimed.add(x.t));
    if (!all.length) continue;
    if (!date.startsWith(period)) continue; // spill-over day after the period that no shift claimed
    if (row && !work && P.ignoreDayOffTaps === 1) { dayOffDays++; continue; } // taps on a day off do not exist for attendance (their count is reported, nothing is silently lost)

    let first = Math.min(...all.map((x) => x.abs)), last = Math.max(...all.map((x) => x.abs));
    const ins = all.filter((x) => x.t.kind === 'in'), outs = all.filter((x) => x.t.kind === 'out');
    // A day with only one side: Talenta's Check Out (Check In) can supply the time, but only if it is plausible. Presence still comes from the fingerprint.
    let support: '' | 'in' | 'out' = '';
    if (P.talentaFillsMissingTap === 1 && work) {
      if (ins.length && !outs.length && row!.tOut != null) { const t = cross && row!.tOut < row!.schedIn! ? row!.tOut + 1440 : row!.tOut; if (t > last) { last = t; support = 'out'; } }
      else if (outs.length && !ins.length && row!.tIn != null && row!.tIn < first) { first = row!.tIn; support = 'in'; }
    }
    // A missing side explained by approved leave / dinas needs no tap, and that side is not judged
    let coverIn = false, coverOut = false;
    const flagIds: string[] = [];
    const flag = (c: Category, s: Severity, reason: string) => { const fid = addFlag(c, s, 'day', id, date, reason); if (!flagIds.includes(fid)) flagIds.push(fid); };
    const where = `${dmy(date)}${row ? `, shift ${row.shift}` : ''}`;

    for (const x of all) if (!x.t.kind) flag('ambiguous', 'kritis', `Status tap tidak dikenal "${x.t.raw}" pada ${hhmm(x.abs)} (tetap dihitung sebagai tap)`);
    if (!row) flag('ambiguous', 'informatif', `Tap pada tanggal tanpa jadwal HRIS (${hhmm(first)}–${hhmm(last)})`);
    else if (!work) flag('ambiguous', 'informatif', `Tap pada hari libur (${row.shift}) pukul ${hhmm(first)}–${hhmm(last)}`);
    if (rows.length > 1 && rows.some((r) => !sameRow(r, row!))) flag('conflict', 'kritis', `HRIS memuat ${rows.length} baris berbeda untuk hari ini (${rows.map((r) => `${r.shift}/${r.code || '-'}`).join(' vs ')}); baris pertama dipakai sementara`);

    // --- thresholds: the shift of THIS day, never the fingerprint category ---
    let evaluated = false, lateAfter: number | null = null, earlyBefore: number | null = null, note = '';
    if (legacy) {
      const sc = e.schedule ? schedByName.get(lc(e.schedule)) : undefined;
      if (sc) { ({ lateAfter, earlyBefore } = thresholds(sc, first)); evaluated = true; note = `Ambang Work Schedule karyawan ${sc.name} (rumus sheet perusahaan), bukan jam shift hari ini`; }
      else note = 'Work Schedule karyawan tidak dapat ditentukan; keterlambatan dan pulang awal belum dihitung';
    } else if (work && cat && row!.schedIn != null && row!.schedOut != null) {
      const so = cross ? row!.schedOut! + 1440 : row!.schedOut!;
      lateAfter = row!.schedIn! + P.lateToleranceMin; earlyBefore = so - P.earlyToleranceMin; evaluated = true;
      note = `Shift ${row!.shift} (${cat.name}) ${hhmm(row!.schedIn!)}–${hhmm(row!.schedOut!)}${cross ? ' lintas hari' : ''}: terlambat jika masuk > ${hhmm(lateAfter)}, pulang awal jika pulang < ${hhmm(earlyBefore)}`;
    } else note = `${!row ? 'Jadwal HRIS tidak ditemukan' : !work ? `Hari libur (${row.shift})` : `Shift ${row.shift} belum dipetakan ke Work Schedule`}; keterlambatan dan pulang awal belum dihitung`;

    if (work) {
      if (!cat) flag('no_rule', 'kritis', `Shift "${row!.shift}" belum dipetakan ke Work Schedule; keterlambatan dan pulang awal belum dihitung`);
      if (cross && legacy) flag('no_rule', 'kritis', `Shift lintas hari ${row!.shift} (${hhmm(row!.schedIn!)}–${hhmm(row!.schedOut!)}) belum punya rule jam; dihitung sementara dengan Work Schedule ${e.schedule ?? '–'}`);
      if (cat) for (const c of new Set(all.map((x) => x.t.category).filter((c): c is string => !!c)))
        if (lc(c) !== lc(cat.name)) flag('mismatch', 'kritis', `Kategori fingerprint "${c}" tidak sesuai jadwal HRIS (shift ${row!.shift} → ${cat.name}); data tidak dinyatakan melanggar, mohon konfirmasi HR Operations`);

      // in/out labels are unreliable, so the earliest and latest tap decide (same rule as clock-in / clock-out)
      const lv = leaveInfo(row, rules, last > first ? { first, last } : undefined);
      if (lv) {
        const p = `${hhmm(first)}–${hhmm(last)}`;
        if (lv.treatment === 'unknown') flag('no_rule', 'kritis', `Kode kehadiran "${lv.code}" belum punya rule`);
        else if (lv.treatment === 'wfh') flag('conflict', 'kritis', `Talenta menandai WFH (${lv.code}) tetapi fingerprint menunjukkan hadir di kantor (${p}); kehadiran fisik tetap dibaca dari fingerprint`);
        else if (lv.treatment === 'dinas') {
          // meeting / official duty outside the office: not a conflict with a tap; when approved, a missing side is explained
          if (lv.approved) { coverIn = true; coverOut = true; note += `; ${lv.label} disetujui (dinas/meeting luar): sisi tap yang tidak ada tidak dinilai`; }
          else note += `; ${lv.label} ${lv.approvalText}: tidak ada pengecualian`;
        } else if (lv.part === 'unsupported') flag('ambiguous', 'kritis', `Cuti ${lv.label} (${lv.approvalText}) pada shift lintas hari tanpa jam eksplisit tidak dapat dinilai (${p})`);
        else if (isPartial(lv) && lv.approved) {
          const inside = tapsInLeave(lv, all.map((x) => x.abs), P.leaveTapToleranceMin);
          if (inside.length) flag('conflict', 'kritis', `Tap ${inside.map(hhmm).join(', ')} jatuh di dalam periode ${lv.label} ${hhmm(lv.start!)}–${hhmm(lv.end!)} (${lv.approvalText}); fingerprint dan Talenta bertentangan`);
          else if (evaluated) {
            const si = row!.schedIn!, so = cross ? row!.schedOut! + 1440 : row!.schedOut!;
            const coversStart = lv.start! <= si, coversEnd = lv.end! >= so;
            if (coversStart && !coversEnd) { coverIn = true; lateAfter! += lv.end! - si; note += `; ${lv.label} ${hhmm(lv.start!)}–${hhmm(lv.end!)} disetujui (${lv.partSource}): kewajiban kerja dimulai ${hhmm(lv.end!)}, batas terlambat ${hhmm(lateAfter!)}`; }
            else if (coversEnd && !coversStart) { coverOut = true; earlyBefore! -= so - lv.start!; note += `; ${lv.label} ${hhmm(lv.start!)}–${hhmm(lv.end!)} disetujui (${lv.partSource}): kewajiban kerja selesai ${hhmm(lv.start!)}, batas pulang awal ${hhmm(earlyBefore!)}`; }
            else note += `; ${lv.label} ${hhmm(lv.start!)}–${hhmm(lv.end!)} disetujui di tengah hari: batas tidak berubah`;
          }
        } else if (P.leaveWorkedFullDay === 1 && lv.part === 'full' && evaluated && last > first && first <= lateAfter! && last >= earlyBefore!) {
          note += `; HRIS berkode ${lv.code} (${lv.label}, ${lv.approvalText}) tetapi tap ${p} menutup seluruh jam shift: hadir penuh menurut fingerprint, kode cuti tidak dinilai (Config)`;
        } else flag('conflict', 'kritis', `Fingerprint menunjukkan hadir (${p}) tetapi HRIS berkode ${lv.code} (${TREATMENT_LABEL.leave.split(' (')[0]}, ${lv.label}); ${lv.approvalText}${isPartial(lv) ? '' : `; ${lv.partSource}`}; pengecualian tidak diberikan otomatis`);
      }
    }

    if (support === 'out') note += `; tap pulang tidak ada, jam pulang ${hhmm(last)} dilengkapi Check Out Talenta (kehadiran fisik tetap dari fingerprint)`;
    if (support === 'in') note += `; tap masuk tidak ada, jam masuk ${hhmm(first)} dilengkapi Check In Talenta (kehadiran fisik tetap dari fingerprint)`;
    // HRIS says present (H) and only one side was tapped: the person forgot to clock in/out. Present, the missing side is not judged, no flag.
    const forgotH = work && P.forgotTapWhenPresent === 1 && !!row!.code && rules.attendance.find((a) => lc(a.code) === lc(row!.code))?.treatment === 'present';
    // flexible department (e.g. COM, in and out for meetings): a one-sided day is present whatever the code, unless a leave / WFH / dinas code explains the day itself
    const flex = work && isFlexDept(rules, e.dept) && !leaveInfo(row, rules);
    let why = 'cuti/dinas disetujui';
    // Mislabelled taps: when the first and last tap are at least minWorkMin apart, the last one IS the clock-out (earliest = in, latest = out) and is judged;
    // only a day with no such second tap is one-sided, and then the missing side is not judged.
    const spread = last - first >= P.minWorkMin;
    let relabelIn = false, relabelOut = false;
    if (forgotH || flex) {
      why = flex ? `divisi ${e.dept} keluar-masuk untuk meeting (Config: divisi fleksibel)` : `HRIS berstatus ${row!.code}, dianggap lupa tap`;
      if (!ins.length && support !== 'in') { if (spread) relabelIn = true; else coverIn = true; }
      if (!outs.length && support !== 'out') { if (spread) relabelOut = true; else coverOut = true; }
    }
    if (relabelOut) note += `; tidak ada tap berlabel pulang, tap terakhir ${hhmm(last)} dipakai sebagai jam pulang (${why})`;
    if (relabelIn) note += `; tidak ada tap berlabel masuk, tap pertama ${hhmm(first)} dipakai sebagai jam masuk (${why})`;
    const gapIn = !ins.length && support !== 'in' && !coverIn && !relabelIn, gapOut = !outs.length && support !== 'out' && !coverOut && !relabelOut;
    const waiveLate = !ins.length && coverIn, waiveEarly = !outs.length && coverOut; // the side that is missing but explained is not judged
    if (!ins.length && coverIn) note += `; tap masuk tidak ada (${why}), keterlambatan tidak dinilai`;
    if (!outs.length && coverOut) note += `; tap pulang tidak ada (${why}), pulang awal tidak dinilai`;
    if (gapIn) flag('incomplete', 'kritis', `Tap masuk tidak ditemukan pada ${where}${row?.tIn != null && P.talentaFillsMissingTap === 1 ? ' (Check In Talenta tidak masuk akal terhadap tap pulang)' : ''}; jam masuk = tap paling awal ${hhmm(first)}`);
    if (gapOut) flag('incomplete', 'kritis', `Tap pulang tidak ditemukan pada ${where}${row?.tOut != null && P.talentaFillsMissingTap === 1 ? ' (Check Out Talenta tidak masuk akal terhadap tap masuk)' : ''}; jam pulang = tap paling akhir ${hhmm(last)}`);
    // Not exceptions: several in/out taps, taps in an odd order, taps outside the shift hours. Clock-in is always the earliest
    // tap and clock-out the latest; every tap stays listed in tapsText, and a clearly absurd span is caught by the duration check below.
    if (!flex && last > first && (last - first < P.minWorkMin || last - first > P.maxWorkMin)) flag('out_of_range', 'kritis', `Durasi tap pertama–terakhir ${dur(last - first)} di luar batas wajar (${P.minWorkMin}–${P.maxWorkMin} mnt)`);

    const tapsText = [...all].sort((a, b) => a.abs - b.abs).map(({ t, abs }) => {
      const label = t.kind === 'in' ? 'masuk' : t.kind === 'out' ? 'pulang' : `status "${t.raw}"`;
      const folded = (absorbed.get(t) ?? []).map((a) => ` +${hhmm(a.min)} (${a.min === t.min ? 'duplikat persis' : 'mendekati duplikat'})`).join('');
      return `${hhmm(abs)} ${label}${folded}`;
    }).join(', ') + (support === 'out' ? `, ${hhmm(last)} pulang (dilengkapi Talenta)` : support === 'in' ? `, ${hhmm(first)} masuk (dilengkapi Talenta)` : '');

    days.push({
      empId: id, date, shift: row?.shift ?? '', code: row?.code ?? '', first, last,
      late: evaluated && !waiveLate && first > lateAfter!, early: evaluated && !waiveEarly && last < earlyBefore!, flagIds,
      hasIn: ins.length > 0, hasOut: outs.length > 0, support, gap: gapIn ? 'masuk' : gapOut ? 'pulang' : '', evaluated, category: cat?.name ?? null, lateAfter, earlyBefore, note, tapsText,
    });
  }

  // --- employee-level flags ---
  const fpOnlyOrg = new Map<string, string>();
  for (const [k, b] of buckets) { const id = k.split('|')[0]; if (!emp.has(id) && !fpOnlyOrg.has(id)) fpOnlyOrg.set(id, [...b.in, ...b.out, ...b.other][0].org); }
  for (const [id, n] of tapCount) if (!emp.has(id))
    addFlag('mismatch', 'kritis', 'employee', id, '', `ID ada di Fingerprint (${n} tap) tetapi tidak ada di HRIS; tidak masuk Final Data`, { name: '', dept: fpOnlyOrg.get(id) ?? '' });
  for (const e of emp.values()) {
    // an ID that exists only in HRIS simply has no fingerprint: not an exception (it stays out of Final Data, which is built from taps)
    if (!e.dept) addFlag('incomplete', 'kritis', 'employee', e.id, '', 'Karyawan tanpa departemen');
    if (e.hasTaps && !e.schedule) addFlag('no_rule', 'kritis', 'employee', e.id, '', 'Tidak ada shift HRIS karyawan yang terpetakan ke Work Schedule; ambang telat/pulang awal tidak dapat ditentukan');
    const names = [...(mapped.get(e.id)?.keys() ?? [])];
    if (legacy && e.hasTaps && names.length > 1) addFlag('ambiguous', 'informatif', 'employee', e.id, '', `Jadwal campuran (${names.join(', ')}); dipakai prioritas tertinggi: ${e.schedule}`);
  }

  const flags = [...flagMap.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'kritis' ? -1 : 1) || cmp(a.category, b.category) || cmp(a.date, b.date) || cmp(a.empId, b.empId));
  return { period, ruleVersion: rules.version, employees: [...emp.values()], days, flags, stats: { ...raw, tapsKept: kept, dupRemoved, exactDup, dayOffDays } };
}
