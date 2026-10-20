import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseDate, parseTime, ingest } from './ingest';
import { runEngine } from './engine';
import { resolveDay, summarize, summarizeEmployees, weekOf, type Decisions } from './review';
import { buildResult } from './exporter';
import { parseResult, addResultFiles, monthly, trend, ruleWarnings } from './dashboard';
import { commit, defaultStore, activeRules, diffSnapshots, snapshotRows } from './rules';
import type { HrisRow, Tap } from './types';

const rules = activeRules(defaultStore());
const raw = { fpRows: 0, hrisRows: 0, statusAliased: 0, tapsOutsidePeriod: 0 };
const hm = (s: string) => +s.slice(0, 2) * 60 + +s.slice(3, 5);
const tap = (id: string, date: string, t: string, kind: 'in' | 'out' | null = 'in'): Tap => ({ id, org: 'X', date, min: hm(t), kind, raw: kind ?? '?' });
const row = (date: string, shift = 'N', inn = '09:00', out = '18:00', code = 'H', id = '1'): HrisRow => ({
  id, name: 'A', org: 'FIN', date, shift, code, manager: '',
  schedIn: shift === 'dayoff' ? null : hm(inn), schedOut: shift === 'dayoff' ? null : hm(out),
});
const run = (taps: Tap[], hris: HrisRow[]) => runEngine(taps, hris, rules, '2026-09', raw);
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

  it('Work Schedule = highest priority shift; mixed schedules are flagged; SHIFTING OB uses the 10:00 split', () => {
    const hris = [row('2026-09-01', 'N'), row('2026-09-02', 'S1 OP', '06:00', '15:00'), row('2026-09-03', 'S2-OP', '10:00', '19:00')];
    const r = run([...full('2026-09-02', '06:20', '15:00'), ...full('2026-09-03', '10:16', '19:00')], hris);
    expect(r.employees[0].schedule).toBe('SHIFTING OB');
    expect(r.days.map((d) => [d.late, d.early])).toEqual([[true, false], [true, false]]); // 06:20 > 06:15 ; 10:16 > 10:15
    expect(r.flags.map((f) => f.category)).toEqual(['ambiguous']); // mixed schedule (N + OB)
  });

  it('a single-tap day is flagged, uses the tap as in and out (company rule), and counts only after a decision', () => {
    const r = run([tap('1', '2026-09-01', '09:03')], [row('2026-09-01')]);
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

  it('pairs the out tap of a midnight-crossing shift on the next day and flags the missing time rule', () => {
    const r = run([tap('1', '2026-09-01', '22:05'), tap('1', '2026-09-02', '07:00', 'out')], [row('2026-09-01', 'S3', '22:00', '07:00'), row('2026-09-02', 'dayoff')]);
    expect(r.days).toHaveLength(1);
    expect(r.days[0]).toMatchObject({ first: 1325, last: 1440 + 420 });
    expect(cats(r, '2026-09-01')).toEqual(['no_rule']);
  });

  it('flags leave+tap as conflict, unmapped shift / unknown code as no_rule, tap on a day off as ambiguous', () => {
    const r = run(
      [...full('2026-09-01', '09:00', '18:00'), ...full('2026-09-02', '09:00', '18:00'), ...full('2026-09-03', '09:00', '18:00'), tap('1', '2026-09-05', '10:00')],
      [row('2026-09-01', 'N', '09:00', '18:00', 'ALR'), row('2026-09-02', 'ZZ'), row('2026-09-03', 'N', '09:00', '18:00', 'XYZ'), row('2026-09-05', 'dayoff')]);
    expect(cats(r, '2026-09-01')).toEqual(['conflict']);
    expect(cats(r, '2026-09-02')).toEqual(['no_rule']);
    expect(cats(r, '2026-09-03')).toEqual(['no_rule']);
    expect(cats(r, '2026-09-05').sort()).toEqual(['ambiguous', 'incomplete']); // in/out reasons merge into one flag
  });

  it('flags id mismatch both ways, blank department and an unclassifiable employee', () => {
    const noDept = { ...row('2026-09-01', 'N', '09:00', '18:00', 'H', '2'), org: '' };
    const odd = row('2026-09-01', 'QQ', '09:00', '18:00', 'H', '4');
    const r = run([...full('2026-09-01', '09:00', '18:00', '1'), ...full('2026-09-01', '09:00', '18:00', '9'), ...full('2026-09-01', '09:00', '18:00', '4')], [row('2026-09-01', 'N', '09:00', '18:00', 'H', '3'), noDept, odd]);
    const by = (c: string) => r.flags.filter((f) => f.category === c && f.scope === 'employee').map((f) => f.empId).sort();
    expect(by('mismatch')).toEqual(['1', '2', '3', '9']); // 1 and 9 only in fingerprint, 2 and 3 only in HRIS
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
    const { buffer } = await buildResult({ res: r, emps, decisions: {}, rules, user: 'hr@x' });
    const f = await parseResult(buffer, 'a.xlsx');
    expect(f).toMatchObject({ period: '2026-09', intact: true, ruleVersion: 1 });
    expect(f.employees[0]).toMatchObject({ complete: 0, remark: 'Normal', schedule: 'REGULER', lateRemark: 'On Time' });
    expect(monthly(f).avgComplete).toBe(0);

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Final Data', 'Master Data', 'Exception', 'Audit Trail', 'Metadata']);
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
      const { buffer } = await buildResult({ res, emps: summarizeEmployees(res, {}, rs), decisions: {}, rules: rs, user: 'hr' });
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
    const { buffer } = await buildResult({ res, emps: done, decisions: all, rules, user: 'hr' });
    expect((await parseResult(buffer, 's.xlsx')).intact).toBe(true);
  });

  // The alignment proof: with every flag accepted (= the company's own treatment of each tap-day),
  // Tenflow reproduces the workbook's Final Data sheet value for value.
  it('reproduces the "Final Data" sheet of Anonymized Data.xlsx', async () => {
    const ing = await ingest(buf('sample-data/fingerprint.xlsx'), buf('sample-data/hris.xlsx'));
    const res = runEngine(ing.taps, ing.hris, rules, ing.period, ing.stats);
    const mine = new Map(summarizeEmployees(res, accept(res), rules).map((r) => [r.id, r]));
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
