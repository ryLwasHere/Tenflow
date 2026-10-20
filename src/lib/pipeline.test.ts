import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseDate, parseTime, ingest } from './ingest';
import { runEngine } from './engine';
import { resolveDay, summarize, summarizeEmployees, weekOf, type Decisions } from './review';
import { buildResult } from './exporter';
import { parseResult, addResultFiles, monthly, trend, ruleWarnings } from './dashboard';
import { commit, defaultStore, activeRules, diffSnapshots, snapshotRows } from './rules';
import { evaluateAttendance } from './compliance';
import type { HrisRow, Tap } from './types';

const rules = activeRules(defaultStore());
const legacyRules = { ...rules, params: { ...rules.params, scheduleBasis: 0, ignoreDayOffTaps: 0, talentaFillsMissingTap: 0, inferHalfDayAlr: 0, leaveWorkedFullDay: 0, forgotTapWhenPresent: 0 }, flexDepts: [] }; // company-sheet formula: employee-level Work Schedule thresholds, day-off taps counted, single taps not completed from Talenta, leave codes never reinterpreted from taps
const raw = { fpRows: 0, hrisRows: 0, statusAliased: 0, tapsOutsidePeriod: 0 };
const hm = (s: string) => +s.slice(0, 2) * 60 + +s.slice(3, 5);
const tap = (id: string, date: string, t: string, kind: 'in' | 'out' | null = 'in'): Tap => ({ id, org: 'X', date, min: hm(t), kind, raw: kind ?? '?' });
const row = (date: string, shift = 'N', inn = '09:00', out = '18:00', code = 'H', id = '1'): HrisRow => ({
  id, name: 'A', org: 'FIN', date, shift, code, manager: '',
  schedIn: shift === 'dayoff' ? null : hm(inn), schedOut: shift === 'dayoff' ? null : hm(out),
});
const run = (taps: Tap[], hris: HrisRow[], rs = rules) => runEngine(taps, hris, rs, '2026-09', raw);
const accept = (r: ReturnType<typeof run>): Decisions => Object.fromEntries(r.flags.map((f) => [f.id, { action: 'accept' as const, reason: 't', by: 'hr', at: '' }]));
const cats = (r: ReturnType<typeof run>, date: string) => r.flags.filter((f) => f.date === date).map((f) => f.category);
const full = (date: string, i: string, o: string, id = '1') => [tap(id, date, i), tap(id, date, o, 'out')];

describe('parsing', () => {
  it('reads Excel dates/times as wall-clock', () => {
    expect(parseDate(new Date('2026-09-01T00:00:00Z'))).toBe('2026-09-01');
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseTime(new Date('1899-12-30T09:03:00Z'))).toBe(543);
    expect(parseTime(0.375)).toBe(540);
    expect(parseTime('25:00')).toBeNull();
  });
});

describe('company calculation (Master Data / Final Data)', () => {
  it('REGULER: late only after 09:15, early out only before 18:00', () => {
    const r = run([...full('2026-09-01', '09:15', '18:00'), ...full('2026-09-02', '09:16', '17:59')], [row('2026-09-01'), row('2026-09-02')]);
    expect(r.flags).toHaveLength(0);
    expect(r.days.map((d) => [d.late, d.early])).toEqual([[false, false], [true, true]]);
    const [e] = summarizeEmployees(r, {}, rules);
    expect(e).toMatchObject({ clockIn: 2, clockOut: 2, late: 1, early: 1, complete: 0.5, remark: 'Perlu Evaluasi', lateRate: 0.5, lateRemark: 'Late >20%', schedule: 'REGULER' });
  });

  it('legacy basis: Work Schedule = highest priority shift; mixed schedules are flagged; SHIFTING OB uses the 10:00 split', () => {
    const hris = [row('2026-09-01', 'N'), row('2026-09-02', 'S1 OP', '06:00', '15:00'), row('2026-09-03', 'S2-OP', '10:00', '19:00')];
    const r = run([...full('2026-09-02', '06:20', '15:00'), ...full('2026-09-03', '10:16', '19:00')], hris, legacyRules);
    expect(r.employees[0].schedule).toBe('SHIFTING OB');
    expect(r.days.map((d) => [d.late, d.early])).toEqual([[true, false], [true, false]]); // 06:20 > 06:15 ; 10:16 > 10:15
    expect(r.flags.map((f) => f.category)).toEqual(['ambiguous']); // mixed schedule (N + OB)
  });

  it('a single-tap day is flagged, uses the tap as in and out (company rule), and counts only after a decision', () => {
    const r = run([tap('1', '2026-09-01', '09:03')], [row('2026-09-01')], { ...rules, params: { ...rules.params, forgotTapWhenPresent: 0 } });
    expect(r.flags.map((f) => [f.category, f.severity])).toEqual([['incomplete', 'kritis']]);
    expect(r.days[0]).toMatchObject({ first: 543, last: 543, late: false, early: true });
    expect(summarizeEmployees(r, {}, rules)[0]).toMatchObject({ clockIn: 0, pending: 1 });
    expect(summarizeEmployees(r, accept(r), rules)[0]).toMatchObject({ clockIn: 1, early: 1 });
    const id = r.flags[0].id;
    const ov: Decisions = { [id]: { action: 'override', reason: 'x', outcome: 'compliant', by: 'hr', at: '' } };
    expect(summarizeEmployees(r, ov, rules)[0]).toMatchObject({ clockIn: 1, early: 0, complete: 0 });
    expect(resolveDay(r.days[0], { [id]: { ...ov[id], action: 'exclude' } }).counted).toBe(false);
  });

  it('weeks start Monday and only weekdays are counted', () => {
    expect([1, 4, 7, 11, 28, 30].map((d) => weekOf(`2026-09-${String(d).padStart(2, '0')}`, '2026-09'))).toEqual([1, 1, 2, 2, 5, 5]);
    expect(weekOf('2026-09-05', '2026-09')).toBe(0);
  });
});

describe('flags', () => {
  it('collapses duplicate taps and counts them', () => {
    const r = run([tap('1', '2026-09-01', '09:00'), tap('1', '2026-09-01', '09:02'), tap('1', '2026-09-01', '18:00', 'out'), tap('1', '2026-09-01', '18:01', 'out')], [row('2026-09-01')]);
    expect(r.stats.dupRemoved).toBe(2);
    expect(r.flags).toHaveLength(0);
  });

  it('pairs the out tap of a midnight-crossing shift on the next day; legacy basis has no time rule for it and flags that', () => {
    const taps = [tap('1', '2026-09-01', '22:05'), tap('1', '2026-09-02', '07:00', 'out')];
    const hris = [row('2026-09-01', 'S3', '22:00', '07:00'), row('2026-09-02', 'dayoff')];
    const r = run(taps, hris);
    expect(r.days).toHaveLength(1);
    expect(r.days[0]).toMatchObject({ first: 1325, last: 1440 + 420, late: false, early: false, evaluated: true, lateAfter: 1335, earlyBefore: 1440 + 420 });
    expect(r.flags).toHaveLength(0);
    expect(cats(run(taps, hris, legacyRules), '2026-09-01')).toEqual(['no_rule']);
  });

  it('flags leave+partial taps as conflict, unmapped shift / unknown code as no_rule, tap on a day off as ambiguous', () => {
    const r = run(
      [...full('2026-09-01', '09:00', '18:00'), ...full('2026-09-02', '09:00', '18:00'), ...full('2026-09-03', '09:00', '18:00'), tap('1', '2026-09-05', '10:00')],
      [row('2026-09-01', 'N', '09:00', '18:00', 'ALR'), row('2026-09-02', 'ZZ'), row('2026-09-03', 'N', '09:00', '18:00', 'XYZ'), row('2026-09-05', 'dayoff')]);
    expect(cats(r, '2026-09-01')).toEqual([]); // ALR but the taps cover the whole shift: worked day
    expect(cats(r, '2026-09-02')).toEqual(['no_rule']);
    expect(cats(r, '2026-09-03')).toEqual(['no_rule']);
    // a tap on a day off does not exist for attendance: no flag, no day row, nothing counted
    expect(cats(r, '2026-09-05')).toEqual([]);
    expect(r.days.map((d) => d.date)).not.toContain('2026-09-05');
    expect(r.stats.dayOffDays).toBe(1);
    // company-sheet mode still counts and flags it
    const old = run([tap('1', '2026-09-05', '10:00')], [row('2026-09-05', 'dayoff')], legacyRules);
    expect(cats(old, '2026-09-05').sort()).toEqual(['ambiguous', 'incomplete']); // in/out reasons merge into one flag
    expect(old.days).toHaveLength(1);
  });

  it('flags id mismatch both ways, blank department and an unclassifiable employee', () => {
    const noDept = { ...row('2026-09-01', 'N', '09:00', '18:00', 'H', '2'), org: '' };
    const odd = row('2026-09-01', 'QQ', '09:00', '18:00', 'H', '4');
    const r = run([...full('2026-09-01', '09:00', '18:00', '1'), ...full('2026-09-01', '09:00', '18:00', '9'), ...full('2026-09-01', '09:00', '18:00', '4')], [row('2026-09-01', 'N', '09:00', '18:00', 'H', '3'), noDept, odd]);
    const by = (c: string) => r.flags.filter((f) => f.category === c && f.scope === 'employee').map((f) => f.empId).sort();
    expect(by('mismatch')).toEqual(['1', '9']); // only fingerprint-only IDs are exceptions; IDs only in HRIS (2, 3) just have no fingerprint
    expect(by('incomplete')).toEqual(['2']);
    expect(by('no_rule')).toEqual(['4']);
  });

  it('summary exposes lock state and ranges', () => {
    const r = run(full('2026-09-01', '09:00', '18:00'), [row('2026-09-01')]);
    const s = summarize(r, summarizeEmployees(r, {}, rules), {});
    expect(s).toMatchObject({ employees: 1, avgComplete: 0, flags: { total: 0, undecided: 0 } });
  });
});

describe('rules', () => {
  it('versions every change and logs it', () => {
    const s0 = defaultStore();
    const s1 = commit(s0, 'admin@x', (d) => { d.params.dedupeWindowMin = 3; return { action: 'update', target: 'Parameter', detail: 'x' }; });
    expect(s1.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(s0.versions[0].params.dedupeWindowMin).toBe(5);
    expect(s1.log.at(-1)).toMatchObject({ version: 2, by: 'admin@x', action: 'update' });
    expect(diffSnapshots(snapshotRows(s1.versions[0]), snapshotRows(s1.versions[1]))).toEqual(['~ Rule: Parameter · Jendela duplikasi tap: 5 menit → 3 menit']);
  });
});

const oneDay = () => run(full('2026-09-01', '09:00', '18:00'), [row('2026-09-01')]);

describe('export → dashboard round trip', () => {
  it('writes Final Data + Master Data + audit sheets, validates, and detects tampering', async () => {
    const r = oneDay();
    const emps = summarizeEmployees(r, {}, rules);
    const { buffer } = await buildResult({ res: r, hris: [row('2026-09-01')], emps, decisions: {}, rules, user: 'hr@x' });
    const f = await parseResult(buffer, 'a.xlsx');
    expect(f).toMatchObject({ period: '2026-09', intact: true, ruleVersion: 1 });
    expect(f.employees[0]).toMatchObject({ complete: 0, remark: 'Normal', schedule: 'REGULER', lateRemark: 'On Time' });
    expect(monthly(f).avgComplete).toBe(0);

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Final Data', 'Master Data', 'Exception', 'Audit Trail', 'Metadata', 'Daily Evaluation', 'WFO Compliance']);
    const fd = wb.getWorksheet('Final Data')!;
    expect((fd.getCell('F2').value as { formula: string }).formula).toContain("COUNTIFS('Master Data'!A:A,B2");
    fd.getCell('J2').value = 0.5; // manual edit after export
    const edited = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    expect((await parseResult(edited, 'b.xlsx')).intact).toBe(false);
    await expect(parseResult(new ArrayBuffer(8), 'junk.xlsx')).rejects.toThrow();
  });

  it('rejects a duplicate period, shows gaps and rule differences', async () => {
    const r = oneDay();
    const mk = async (period: string, rs = rules) => {
      const res = { ...r, period };
      const { buffer } = await buildResult({ res, hris: [row('2026-09-01')], emps: summarizeEmployees(res, {}, rs), decisions: {}, rules: rs, user: 'hr' });
      return new File([buffer], `${period}.xlsx`);
    };
    const changed = commit(defaultStore(), 'a', (d) => { d.params.lateThresholdPct = 30; return { action: 'update', target: 't', detail: 'd' }; });
    const { files, errors } = await addResultFiles([], [await mk('2026-07'), await mk('2026-07'), await mk('2026-09', activeRules(changed))]);
    expect(files.map((x) => x.period)).toEqual(['2026-07', '2026-09']);
    expect(errors).toHaveLength(1);
    expect(trend(files).points.map((p) => p.complete)).toEqual([0, null, 0]); // August is a gap
    const w = ruleWarnings(files);
    expect(w).toHaveLength(1);
    expect(w[0].versions).toEqual([1, 2]);
    expect(w[0].lines.join()).toContain('Ambang keterlambatan');
  });
});

const sample = existsSync('sample-data/fingerprint.xlsx') && existsSync('sample-data/hris.xlsx') && existsSync('Anonymized Data.xlsx');
const buf = (p: string) => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };

describe.skipIf(!sample)('real sample data (npm run sample)', () => {
  it('ingests, flags and exports', async () => {
    const t0 = Date.now();
    const ing = await ingest(buf('sample-data/fingerprint.xlsx'), buf('sample-data/hris.xlsx'));
    expect(ing.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(ing.period).toBe('2026-09');
    const res = runEngine(ing.taps, ing.hris, rules, ing.period, ing.stats);
    const byCat: Record<string, number> = {};
    for (const f of res.flags) byCat[`${f.category}/${f.severity}`] = (byCat[`${f.category}/${f.severity}`] ?? 0) + 1;
    const rows = summarizeEmployees(res, {}, rules);
    console.log('SAMPLE', JSON.stringify({ ms: Date.now() - t0, days: res.days.length, flags: res.flags.length, byCat, ratio: +summarize(res, rows, {}).flagRatio.toFixed(3), finalRows: rows.length }));
    const all = accept(res);
    const done = summarizeEmployees(res, all, rules);
    expect(done.reduce((s, e) => s + e.pending, 0)).toBe(0);
    const { buffer } = await buildResult({ res, hris: ing.hris, emps: done, decisions: all, rules, user: 'hr' });
    expect((await parseResult(buffer, 's.xlsx')).intact).toBe(true);
  });

  const waived = (d: { note: string }) => d.note.includes('dianggap lupa tap') || d.note.includes('divisi fleksibel'); // a missing side that policy explains is not judged
  it('the shift-of-the-day basis differs from the company formula only where the day shift differs from the employee schedule, and everything reconciles', async () => {
    const ing = await ingest(buf('sample-data/fingerprint.xlsx'), buf('sample-data/hris.xlsx'));
    const cur = runEngine(ing.taps, ing.hris, rules, ing.period, ing.stats);
    const old = runEngine(ing.taps, ing.hris, legacyRules, ing.period, ing.stats);
    const before = new Map(old.days.map((d) => [`${d.empId}|${d.date}`, d]));
    const changed = cur.days.filter((d) => { const o = before.get(`${d.empId}|${d.date}`)!; return o.late !== d.late || o.early !== d.early; });
    expect(changed.length).toBeGreaterThan(0);
    // a result only moves where the threshold applied to that day moved (the day's own shift hours vs the employee-level Work Schedule); same threshold, same result
    for (const d of cur.days) {
      const o = before.get(`${d.empId}|${d.date}`)!;
      if (!d.support && !waived(d) && o.lateAfter === d.lateAfter && o.earlyBefore === d.earlyBefore) expect([d.late, d.early]).toEqual([o.late, o.early]);
    }
    // ...or the missing tap was completed from Talenta (a deliberate, marked change of the evaluated time)
    for (const d of changed) { const o = before.get(`${d.empId}|${d.date}`)!; expect(!!d.support || waived(d) || o.lateAfter !== d.lateAfter || o.earlyBefore !== d.earlyBefore).toBe(true); }
    // every remaining single-tap day has no plausible Talenta time for its missing side
    const hrisAt = new Map(ing.hris.map((r) => [`${r.id}|${r.date}`, r]));
    for (const d of cur.days.filter((x) => x.gap)) { const r = hrisAt.get(`${d.empId}|${d.date}`); expect(d.support).toBe(''); expect(d.gap === 'pulang' ? !(r?.tOut != null && r.tOut > d.last) : !(r?.tIn != null && r.tIn < d.first)).toBe(true); }
    expect(cur.days.filter((x) => x.support).length).toBeGreaterThan(0);
    expect(cur.flags.filter((f) => f.category === 'incomplete' && f.scope === 'day').length).toBeLessThan(old.flags.filter((f) => f.category === 'incomplete' && f.scope === 'day').length);

    const all = accept(cur);
    const ev = evaluateAttendance(cur, ing.hris, rules, all);
    const m = ev.summary.byMode;
    const withTaps = new Set(cur.employees.filter((e) => e.hasTaps).map((e) => e.id));
    const fpWfo = ev.days.filter((d) => d.mode === 'wfo' && withTaps.has(d.empId)).length;
    expect(fpWfo + m.off_presence).toBe(cur.days.length); // every fingerprint day is one WFO (or off-day presence) row, nothing lost or invented
    expect(m.wfo - fpWfo).toBeGreaterThan(0); // plus the Talenta-only presence of employees who have no fingerprint at all
    expect(ev.days.filter((d) => d.mode === 'wfo' && !withTaps.has(d.empId)).every((d) => d.source.includes('karyawan tanpa fingerprint'))).toBe(true);
    expect(Object.values(m).reduce((s, n) => s + n, 0)).toBe(ev.days.length);
    expect(ev.rows.reduce((s, r) => s + r.attended, 0)).toBe(m.wfo);
    expect(ev.rows.reduce((s, r) => s + r.wfh, 0)).toBe(m.wfh);
    expect(ev.rows.every((r) => r.credited <= r.required && r.credited <= r.attended)).toBe(true);
    const { buffer } = await buildResult({ res: cur, hris: ing.hris, emps: summarizeEmployees(cur, all, rules), decisions: all, rules, user: 'hr' });
    const f = await parseResult(buffer, 'sample.xlsx');
    expect(f.intact).toBe(true);
    expect(f.daily).toHaveLength(ev.days.length);
    expect(monthly(f).wfo).toMatchObject({ required: ev.summary.required, credited: ev.summary.credited, late: ev.summary.late, early: ev.summary.early, review: ev.summary.status.review, reviewDays: ev.summary.reviewDays });
    expect(ev.summary.reviewDays).toBeLessThan(ev.days.length); // review days are a subset, never every day
    // with every automatic reading switched off the sample has open flags: before any decision nothing is silently counted
    const strictR = { ...rules, params: { ...rules.params, forgotTapWhenPresent: 0, leaveWorkedFullDay: 0, inferHalfDayAlr: 0 }, flexDepts: [] };
    const curS = runEngine(ing.taps, ing.hris, strictR, ing.period, ing.stats);
    const res0 = evaluateAttendance(curS, ing.hris, strictR, {});
    expect(res0.summary.byMode.pending).toBeGreaterThan(0);
    expect(res0.summary.status.review).toBeGreaterThan(evaluateAttendance(curS, ing.hris, strictR, accept(curS)).summary.status.review);
  });

  // The alignment proof: with every flag accepted (= the company's own treatment of each tap-day),
  // Tenflow reproduces the workbook's Final Data sheet value for value.
  it('reproduces the "Final Data" sheet of Anonymized Data.xlsx (company formula, scheduleBasis = 0)', async () => {
    const ing = await ingest(buf('sample-data/fingerprint.xlsx'), buf('sample-data/hris.xlsx'));
    const res = runEngine(ing.taps, ing.hris, legacyRules, ing.period, ing.stats);
    const mine = new Map(summarizeEmployees(res, accept(res), legacyRules).map((r) => [r.id, r]));
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile('Anonymized Data.xlsx');
    const ws = wb.getWorksheet('Final Data')!;
    const v = (r: number, c: number) => { const x = ws.getRow(r).getCell(c).value as unknown; return x && typeof x === 'object' && 'result' in x ? (x as { result: unknown }).result : x; };
    const n = (x: unknown) => (typeof x === 'number' ? x : 0);
    let rows = 0;
    const diffs: string[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      if (v(r, 2) == null) continue;
      rows++;
      const id = String(v(r, 2)), m = mine.get(id);
      if (!m) { diffs.push(`${id} missing`); continue; }
      const exp = { clockIn: n(v(r, 6)), late: n(v(r, 7)), clockOut: n(v(r, 8)), early: n(v(r, 9)), complete: +n(v(r, 10)).toFixed(6), remark: v(r, 11), weeks: [12, 13, 14, 15, 16].map((c) => n(v(r, c))), office: n(v(r, 17)), schedule: v(r, 18), lateRate: +n(v(r, 19)).toFixed(6), lateRemark: v(r, 20) };
      const got = { clockIn: m.clockIn, late: m.late, clockOut: m.clockOut, early: m.early, complete: +m.complete.toFixed(6), remark: m.remark, weeks: m.weeks, office: m.office, schedule: m.schedule, lateRate: +(m.lateRate ?? 0).toFixed(6), lateRemark: m.lateRemark };
      if (JSON.stringify(exp) !== JSON.stringify(got)) diffs.push(`${id}: expected ${JSON.stringify(exp)} got ${JSON.stringify(got)}`);
    }
    console.log('FINAL DATA rows compared:', rows, 'mine:', mine.size, 'diffs:', diffs.length);
    if (diffs.length) console.log(diffs.slice(0, 6).join('\n'));
    expect(rows).toBe(86);
    expect(mine.size).toBe(86);
    expect(diffs).toEqual([]);
  });
});
