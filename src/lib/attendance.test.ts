// Synthetic data only. September 2026: Tue 1 Sep … Mon 7–Fri 11 is a full week; Mon 28–Wed 30 is a partial last week.
import { describe, expect, it } from 'vitest';
import { ingest, parseApproval, parseCategory, parseDate, parsePart, parseTime, looksLikeXlsx } from './ingest';
import { runEngine } from './engine';
import { evaluateAttendance, type DayStatus } from './compliance';
import { resolveDay, summarizeEmployees, type Decisions } from './review';
import { buildResult, CHECKSUM_KEY, checksumOf } from './exporter';
import { monthly, parseResult } from './dashboard';
import { activeRules, commit, defaultParams, defaultStore, migrate, type Params, type RuleSet } from './rules';
import { readSheets, writeXlsx } from './xlsx';
import { canAccess } from '../access';
import type { HrisRow, Tap } from './types';

const rules = activeRules(defaultStore());
const withParams = (p: Partial<Params>): RuleSet => ({ ...rules, params: { ...rules.params, ...p } });
const strict = withParams({ forgotTapWhenPresent: 0 }); // single-tap days with code H are flagged (the pre-forgot-tap behaviour)
const withCodes = (...codes: { code: string; treatment: 'present' | 'leave' | 'wfh' | 'dinas' }[]): RuleSet =>
  activeRules(commit(defaultStore(), 't', (d) => { codes.forEach((c, i) => d.attendance.push({ id: `x${i}`, ...c })); return { action: 'update', target: 't', detail: 't' }; }));
const raw = { fpRows: 0, hrisRows: 0, statusAliased: 0, tapsOutsidePeriod: 0 };
const hm = (s: string) => +s.slice(0, 2) * 60 + +s.slice(3, 5);
const D = (d: number) => `2026-09-${String(d).padStart(2, '0')}`;
const tap = (id: string, date: string, t: string, kind: 'in' | 'out' | null = 'in', extra: Partial<Tap> = {}): Tap => ({ id, org: 'X', date, min: hm(t), kind, raw: kind ?? '?', ...extra });
const hr = (date: string, o: Partial<HrisRow> = {}): HrisRow => ({ id: '1', name: 'A', org: 'FIN', date, shift: 'N', schedIn: hm('09:00'), schedOut: hm('18:00'), code: 'H', manager: '', ...o });
const off = (date: string, id = '1'): HrisRow => hr(date, { id, shift: 'dayoff', schedIn: null, schedOut: null, code: '' });
const acceptAll = (flags: { id: string }[]): Decisions => Object.fromEntries(flags.map((f) => [f.id, { action: 'accept' as const, reason: 't', by: 'hr', at: '' }]));

type Spec = Record<number, { t?: [string, string?]; r?: Partial<HrisRow> }>;
function build(spec: Spec, id = '1') {
  const taps: Tap[] = [], hris: HrisRow[] = [];
  for (const [d, s] of Object.entries(spec)) {
    const date = D(+d);
    hris.push(hr(date, { id, ...s.r }));
    if (s.t) { taps.push(tap(id, date, s.t[0])); if (s.t[1]) taps.push(tap(id, date, s.t[1], 'out')); }
  }
  return { taps, hris };
}
function evalSpec(spec: Spec, rs: RuleSet = rules, decide = true) {
  const { taps, hris } = build(spec);
  const res = runEngine(taps, hris, rs, '2026-09', raw);
  const decisions = decide ? acceptAll(res.flags) : {};
  return { res, taps, hris, decisions, ...evaluateAttendance(res, hris, rs, decisions) };
}
const dayOf = (days: DayStatus[], d: number) => days.find((x) => x.date === D(d))!;
const IN = ['09:00', '18:00'] as [string, string];
const WFH_DAY = { r: { tIn: hm('08:55'), tOut: hm('17:30') } }; // Talenta Check In, no fingerprint

describe('1. fingerprint + valid schedule', () => {
  it('judges physical attendance against the HRIS shift of that day', () => {
    const r = evalSpec({ 7: { t: ['09:10', '18:05'] } });
    expect(r.res.flags).toHaveLength(0);
    expect(r.res.days[0]).toMatchObject({ evaluated: true, category: 'REGULER', lateAfter: 555, earlyBefore: 1080, late: false, early: false });
    expect(dayOf(r.days, 7)).toMatchObject({ mode: 'wfo', physical: true, late: 'tidak', early: 'tidak' });
    expect(dayOf(r.days, 7).source).toContain('Fingerprint');
  });
});

describe('2–4. shift categories use the actual shift, never a generic or fingerprint-derived one', () => {
  it('regular employee uses the regular schedule', () => {
    const r = evalSpec({ 7: { t: ['09:16', '18:00'] } });
    expect(r.res.days[0]).toMatchObject({ late: true, early: false, category: 'REGULER' });
  });
  it('operations: S2 (14:00–23:00) is not late at 14:10, and S1 (07:00–16:00) is late at 07:20', () => {
    const r = evalSpec({ 7: { t: ['14:10', '23:00'], r: { shift: 'S2', schedIn: hm('14:00'), schedOut: hm('23:00') } }, 8: { t: ['07:20', '16:00'], r: { shift: 'S1', schedIn: hm('07:00'), schedOut: hm('16:00') } } });
    expect(r.res.days.map((d) => [d.category, d.late, d.early])).toEqual([['SHIFTING', false, false], ['SHIFTING', true, false]]);
    // the company-sheet basis would call S2 late (14:10 > 07:15): exactly the defect the edge-case document describes
    const legacy = evalSpec({ 7: { t: ['14:10', '23:00'], r: { shift: 'S2', schedIn: hm('14:00'), schedOut: hm('23:00') } } }, withParams({ scheduleBasis: 0 }));
    expect(legacy.res.days[0].late).toBe(true);
  });
  it('OB (Office Partner) shifts are a separate category with their own hours', () => {
    const r = evalSpec({ 7: { t: ['06:20', '15:00'], r: { shift: 'S1 OP', schedIn: hm('06:00'), schedOut: hm('15:00') } }, 8: { t: ['10:10', '19:00'], r: { shift: 'S2-OP', schedIn: hm('10:00'), schedOut: hm('19:00') } } });
    expect(r.res.days.map((d) => [d.category, d.late, d.early])).toEqual([['SHIFTING OB', true, false], ['SHIFTING OB', false, false]]);
  });
  it('a mixed-schedule employee is judged per day (N day is not judged by the OB threshold)', () => {
    const r = evalSpec({ 7: { t: ['08:30', '18:00'] }, 8: { t: ['06:00', '15:00'], r: { shift: 'S1 OP', schedIn: hm('06:00'), schedOut: hm('15:00') } } });
    expect(r.res.days.map((d) => d.late)).toEqual([false, false]);
    expect(r.res.flags).toHaveLength(0);
  });
});

describe('5. schedule missing', () => {
  it('flags for HR, does not calculate lateness, and never writes "On Time"', () => {
    const r = evalSpec({ 7: { t: ['11:00', '18:00'], r: { shift: 'ZZ' } } }, rules, false);
    expect(r.res.flags.filter((f) => f.scope === 'day').map((f) => f.category)).toEqual(['no_rule']);
    expect(r.res.flags.find((f) => f.scope === 'employee')?.reason).toContain('tidak dapat ditentukan'); // the employee has no mappable shift at all
    expect(r.res.days[0]).toMatchObject({ evaluated: false, late: false, early: false });
    expect(r.res.days[0].note).toContain('belum dihitung');
    expect(dayOf(r.days, 7).mode).toBe('pending');
    const accepted = acceptAll(r.res.flags);
    expect(resolveDay(r.res.days[0], accepted)).toMatchObject({ counted: true, evaluated: false });
    expect(summarizeEmployees(r.res, accepted, rules)[0]).toMatchObject({ clockIn: 1, late: 0, unevaluated: 1 });
  });
  it('a tap on a date without any HRIS row is not evaluated either', () => {
    const res = runEngine([tap('1', D(7), '09:00'), tap('1', D(7), '18:00', 'out')], [hr(D(8))], rules, '2026-09', raw);
    expect(res.days[0]).toMatchObject({ evaluated: false, late: false });
    expect(res.flags.map((f) => f.category)).toContain('ambiguous');
  });
});

describe('6. fingerprint category conflicts with the schedule', () => {
  it('flags a mismatch for HR Operations without declaring a violation, keeping the source value', () => {
    const taps = [tap('1', D(7), '09:00', 'in', { category: 'SHIFTING' }), tap('1', D(7), '18:00', 'out', { category: 'SHIFTING' })];
    const res = runEngine(taps, [hr(D(7))], rules, '2026-09', raw);
    const f = res.flags.find((x) => x.category === 'mismatch')!;
    expect(f.reason).toContain('tidak dinyatakan melanggar');
    expect(f.reason).toContain('"SHIFTING"');
    expect(res.days[0]).toMatchObject({ late: false, early: false }); // hours still come from the HRIS shift
    expect(evaluateAttendance(res, [hr(D(7))], rules, {}).days[0].mode).toBe('pending');
    expect(runEngine(taps.map((t) => ({ ...t, category: 'REGULER' })), [hr(D(7))], rules, '2026-09', raw).flags).toHaveLength(0);
  });
  it('parses fingerprint categories, OB before generic shifting', () => {
    expect([parseCategory('Shifting OB'), parseCategory('Shifting'), parseCategory('Regular'), parseCategory('???')]).toEqual(['SHIFTING OB', 'SHIFTING', 'REGULER', null]);
  });
});

describe('7. missing clock-in / clock-out', () => {
  it('flags both directions and keeps the evidence', () => {
    const res = runEngine([tap('1', D(7), '18:00', 'out'), tap('1', D(8), '09:00')], [hr(D(7)), hr(D(8))], strict, '2026-09', raw);
    const r = (d: number) => res.flags.find((f) => f.date === D(d) && f.category === 'incomplete')!.reason;
    expect(r(7)).toContain('Tap masuk tidak ditemukan');
    expect(r(8)).toContain('Tap pulang tidak ditemukan');
    const ev = evaluateAttendance(res, [hr(D(7)), hr(D(8))], strict, acceptAll(res.flags));
    expect(ev.days.map((d) => d.missing)).toEqual(['masuk', 'pulang']);
    expect(ev.summary.missing).toBe(2);
  });
  it('a single tap combined with sick leave stays unresolved: both the gap and the leave conflict are raised', () => {
    const res = runEngine([tap('1', D(7), '09:00')], [hr(D(7), { code: 'SLD' })], rules, '2026-09', raw);
    expect(res.flags.map((f) => f.category).sort()).toEqual(['conflict', 'incomplete']);
  });
});

describe('8. overnight shifts', () => {
  const s3 = (d: number) => hr(D(d), { shift: 'S3', schedIn: hm('22:00'), schedOut: hm('07:00') });
  it('pairs the after-midnight out tap with the shift date and judges it against the shift', () => {
    const res = runEngine([tap('1', D(1), '22:05'), tap('1', D(2), '07:02', 'out')], [s3(1), off(D(2))], rules, '2026-09', raw);
    expect(res.days).toHaveLength(1);
    expect(res.days[0]).toMatchObject({ date: D(1), first: 1325, last: 1440 + 422, late: false, early: false, earlyBefore: 1860 });
    expect(res.flags).toHaveLength(0);
  });
  it('late and early on an overnight shift', () => {
    const res = runEngine([tap('1', D(1), '22:20'), tap('1', D(2), '06:30', 'out')], [s3(1), off(D(2))], rules, '2026-09', raw);
    expect(res.days[0]).toMatchObject({ late: true, early: true });
  });
  it('a shift ending exactly at 00:00 treats a 00:03 out tap as on time', () => {
    const so = hr(D(1), { shift: 'S2-SO', schedIn: hm('15:00'), schedOut: 0 });
    const ok = runEngine([tap('1', D(1), '15:05'), tap('1', D(2), '00:03', 'out')], [so, off(D(2))], rules, '2026-09', raw);
    const early = runEngine([tap('1', D(1), '15:05'), tap('1', D(1), '23:40', 'out')], [so], rules, '2026-09', raw);
    expect(ok.days[0]).toMatchObject({ early: false, last: 1443 });
    expect(early.days[0].early).toBe(true);
  });
  it('the last day of the period claims the out tap that falls on the first day of the next month', () => {
    const res = runEngine([tap('1', '2026-09-30', '22:00'), tap('1', '2026-10-01', '07:00', 'out')], [hr('2026-09-30', { shift: 'S3', schedIn: hm('22:00'), schedOut: hm('07:00') })], rules, '2026-09', raw);
    expect(res.days).toHaveLength(1);
    expect(res.days[0]).toMatchObject({ date: '2026-09-30', hasOut: true, early: false });
  });
});

describe('9. exact duplicates, near duplicates and multiple legitimate events', () => {
  it('detects exact duplicates without deleting any source tap', () => {
    const taps = [tap('1', D(7), '09:00'), tap('1', D(7), '09:00'), tap('1', D(7), '09:03'), tap('1', D(7), '18:00', 'out')];
    const before = taps.map((t) => ({ ...t }));
    const res = runEngine(taps, [hr(D(7))], rules, '2026-09', raw);
    expect(taps).toEqual(before); // the imported records are untouched
    expect(res.stats).toMatchObject({ dupRemoved: 2, exactDup: 1 });
    expect(res.days[0].tapsText).toContain('duplikat persis');
    expect(res.days[0].tapsText).toContain('mendekati duplikat');
    expect(res.flags).toHaveLength(0);
  });
  it('several in/out taps far apart are not flagged: earliest in and latest out are used, every tap stays visible', () => {
    const taps = [tap('1', D(7), '08:00'), tap('1', D(7), '12:00', 'out'), tap('1', D(7), '13:00'), tap('1', D(7), '17:00', 'out')];
    const res = runEngine(taps, [hr(D(7), { schedIn: hm('08:00'), schedOut: hm('17:00') })], rules, '2026-09', raw);
    expect(res.days[0]).toMatchObject({ first: 480, last: 1020, hasIn: true, hasOut: true });
    expect(res.days[0].tapsText.split(', ')).toHaveLength(4);
    expect(res.stats.dupRemoved).toBe(0);
    expect(res.flags).toHaveLength(0);
    const wide = runEngine([tap('1', D(7), '08:57'), tap('1', D(7), '19:26'), tap('1', D(7), '17:50', 'out'), tap('1', D(7), '18:30', 'out'), tap('1', D(7), '21:00', 'out')], [hr(D(7))], rules, '2026-09', raw);
    expect(wide.days[0]).toMatchObject({ first: hm('08:57'), last: hm('21:00') });
    expect(wide.flags.map((f) => f.reason).join()).not.toContain('ganda');
  });
  it('odd tap order and taps outside the shift hours are not exceptions: earliest tap in, latest tap out, all taps kept', () => {
    const odd = runEngine([tap('1', D(7), '08:50', 'out'), tap('1', D(7), '09:00'), tap('1', D(7), '17:50', 'out'), tap('1', D(7), '18:10')], [hr(D(7))], rules, '2026-09', raw);
    expect(odd.flags).toHaveLength(0);
    expect(odd.days[0]).toMatchObject({ first: hm('08:50'), last: hm('18:10') });
    expect(odd.days[0].tapsText.split(', ')).toHaveLength(4);
    const outside = runEngine([tap('1', D(7), '05:30'), tap('1', D(7), '20:30', 'out')], [hr(D(7))], rules, '2026-09', raw);
    expect(outside.flags).toHaveLength(0); // 05:30 is 3.5h before the shift, 20:30 is 2.5h after it: still just earliest in / latest out
    expect(outside.days[0]).toMatchObject({ first: hm('05:30'), last: hm('20:30'), late: false, early: false });
    const absurd = runEngine([tap('1', D(7), '05:30'), tap('1', D(7), '22:00', 'out')], [hr(D(7))], rules, '2026-09', raw);
    expect(absurd.flags.map((f) => f.category)).toEqual(['out_of_range']); // the duration check still catches a clearly impossible span
  });
});

describe('9c. only a clock-in or only a clock-out', () => {
  const one = (taps: Tap[], row: HrisRow, rs: RuleSet = rules) => runEngine(taps, [row], rs, '2026-09', raw);

  it('Talenta Check Out completes a missing clock-out: not flagged, early judged on it, presence still the fingerprint', () => {
    const r = one([tap('1', D(7), '09:00')], hr(D(7), { tOut: hm('17:50') }));
    expect(r.flags).toHaveLength(0);
    expect(r.days[0]).toMatchObject({ first: hm('09:00'), last: hm('17:50'), early: true, support: 'out', gap: '', hasOut: false }); // 17:50 < 18:00
    expect(r.days[0].tapsText).toContain('pulang (dilengkapi Talenta)');
    expect(r.days[0].note).toContain('dilengkapi Check Out Talenta');
    expect(one([tap('1', D(7), '09:00')], hr(D(7), { tOut: hm('18:05') })).days[0].early).toBe(false);
    const ev = evaluateAttendance(r, [hr(D(7), { tOut: hm('17:50') })], rules, {});
    expect(ev.days[0]).toMatchObject({ mode: 'wfo', physical: true, missing: '', early: 'ya' });
    expect(ev.days[0].source).toContain('dilengkapi Check Out Talenta');
  });
  it('Talenta Check In completes a missing clock-in', () => {
    const r = one([tap('1', D(7), '18:00', 'out')], hr(D(7), { tIn: hm('09:30') }));
    expect(r.flags).toHaveLength(0);
    expect(r.days[0]).toMatchObject({ first: hm('09:30'), late: true, support: 'in', gap: '' });
    expect(one([tap('1', D(7), '18:00', 'out')], hr(D(7), { tIn: hm('08:55') })).days[0].late).toBe(false);
  });
  it('an implausible Talenta time is not used: still flagged, and the reason says so', () => {
    const bad = one([tap('1', D(7), '09:00')], hr(D(7), { tOut: hm('08:00') }), strict);
    expect(bad.flags.map((f) => f.category)).toEqual(['incomplete']);
    expect(bad.flags[0].reason).toContain('Check Out Talenta tidak masuk akal');
    expect(bad.days[0]).toMatchObject({ support: '', gap: 'pulang' });
    expect(one([tap('1', D(7), '18:00', 'out')], hr(D(7), { tIn: hm('19:00') }), strict).days[0]).toMatchObject({ support: '', gap: 'masuk' });
  });
  it('can be switched off, and without any Talenta time the day is flagged as before', () => {
    const off = one([tap('1', D(7), '09:00')], hr(D(7), { tOut: hm('17:50') }), withParams({ talentaFillsMissingTap: 0, forgotTapWhenPresent: 0 }));
    expect(off.flags.map((f) => f.category)).toEqual(['incomplete']);
    expect(off.days[0].support).toBe('');
    expect(one([tap('1', D(7), '09:00')], hr(D(7)), strict).flags.map((f) => f.category)).toEqual(['incomplete']);
  });
  it('works across midnight: the Talenta Check Out after midnight belongs to the shift', () => {
    const s3 = hr(D(1), { shift: 'S3', schedIn: hm('22:00'), schedOut: hm('07:00'), tOut: hm('07:02') });
    const r = runEngine([tap('1', D(1), '22:05')], [s3, off(D(2))], rules, '2026-09', raw);
    expect(r.flags).toHaveLength(0);
    expect(r.days[0]).toMatchObject({ last: 1440 + 422, early: false, support: 'out' });
  });

  it('approved half-day leave explains the missing side: PM leave needs no clock-out, AM leave needs no clock-in', () => {
    const pm = one([tap('1', D(7), '08:55')], hr(D(7), { code: 'ALR', approval: 'approved', leavePart: 'pm' }));
    expect(pm.flags).toHaveLength(0);
    expect(pm.days[0]).toMatchObject({ early: false, gap: '', hasOut: false });
    expect(pm.days[0].note).toContain('pulang awal tidak dinilai');
    const am = one([tap('1', D(7), '18:00', 'out')], hr(D(7), { code: 'ALR', approval: 'approved', leavePart: 'am' }));
    expect(am.flags).toHaveLength(0);
    expect(am.days[0]).toMatchObject({ late: false, gap: '' });
    // not approved: no exception, both the conflict and the gap are raised
    expect(one([tap('1', D(7), '08:55')], hr(D(7), { code: 'ALR', approval: 'pending', leavePart: 'pm' })).flags.map((f) => f.category).sort()).toEqual(['conflict', 'incomplete']);
    // a leave that does not cover the missing side does not explain it
    expect(one([tap('1', D(7), '18:00', 'out')], hr(D(7), { code: 'ALR', approval: 'approved', leavePart: 'pm' })).flags.map((f) => f.category)).toEqual(['incomplete']);
  });

  describe('HRIS says present (H) and only one side was tapped: forgot to tap', () => {
    it('no flag, counts as present, the missing side is not judged', () => {
      const out = one([tap('1', D(7), '18:00', 'out')], hr(D(7), { code: 'H' }));
      expect(out.flags).toHaveLength(0);
      expect(out.days[0]).toMatchObject({ gap: '', late: false, early: false });
      expect(out.days[0].note).toContain('dianggap lupa tap');
      const inn = one([tap('1', D(7), '09:00')], hr(D(7), { code: 'H' }));
      expect(inn.flags).toHaveLength(0);
      expect(inn.days[0]).toMatchObject({ gap: '', late: false, early: false });
      const rows = [hr(D(7), { code: 'H' })];
      expect(dayOf(evaluateAttendance(inn, rows, rules, {}).days, 7)).toMatchObject({ mode: 'wfo', unresolved: false });
    });
    it('the side that exists is still judged: a late clock-in is late even without a clock-out', () => {
      expect(one([tap('1', D(7), '10:00')], hr(D(7), { code: 'H' })).days[0]).toMatchObject({ late: true, early: false });
    });
    it('only for code H: other codes and the switch off still flag', () => {
      expect(one([tap('1', D(7), '09:00')], hr(D(7), { code: 'ALR' })).flags.map((f) => f.category)).toContain('incomplete');
      expect(one([tap('1', D(7), '09:00')], hr(D(7), { code: 'H' }), strict).flags.map((f) => f.category)).toEqual(['incomplete']);
    });
  });

  describe('flexible department (COM): in and out for meetings', () => {
    const com = (taps: Tap[], r: Partial<HrisRow> = {}, rs = rules) => one(taps, hr(D(7), { org: '[AB] COM', ...r }), rs);
    it('a one-sided day is present, whatever the code, and a long span is not an exception', () => {
      for (const code of ['H', '']) {
        expect(com([tap('1', D(7), '14:00', 'out')], { code }).flags).toHaveLength(0);
        expect(com([tap('1', D(7), '09:00')], { code }).flags).toHaveLength(0);
      }
      expect(com([tap('1', D(7), '05:30'), tap('1', D(7), '22:00', 'out')]).flags).toHaveLength(0);
      const rows = [hr(D(7), { org: '[AB] COM', code: '' })];
      const res = runEngine([tap('1', D(7), '09:00')], rows, rules, '2026-09', raw);
      expect(dayOf(evaluateAttendance(res, rows, rules, {}).days, 7)).toMatchObject({ mode: 'wfo', unresolved: false });
      expect(res.days[0].note).toContain('divisi fleksibel');
    });
    it('several taps all labelled "masuk": the last one (>= minWorkMin after the first) is the clock-out and is judged', () => {
      const r = com([tap('1', D(7), '08:58'), tap('1', D(7), '09:04'), tap('1', D(7), '14:29')]);
      expect(r.flags).toHaveLength(0);
      expect(r.days[0]).toMatchObject({ gap: '', late: false, early: true });
      expect(r.days[0].note).toContain('tap terakhir 14:29 dipakai sebagai jam pulang');
      // taps too close together are one tap, not a clock-out
      expect(com([tap('1', D(7), '08:40'), tap('1', D(7), '09:04')]).days[0]).toMatchObject({ early: false, gap: '' });
      // same for code H outside the flexible department
      expect(one([tap('1', D(7), '09:00'), tap('1', D(7), '14:29')], hr(D(7), { code: 'H' })).days[0]).toMatchObject({ gap: '', early: true });
    });
    it('punctuality is still judged when both taps exist; the side that is there is judged', () => {
      expect(com([tap('1', D(7), '10:00'), tap('1', D(7), '18:00', 'out')]).days[0]).toMatchObject({ late: true, early: false });
      expect(com([tap('1', D(7), '10:00')]).days[0]).toMatchObject({ late: true });
    });
    it('another department, or a list without COM, is still flagged; a leave code keeps its own rule', () => {
      expect(one([tap('1', D(7), '09:00')], hr(D(7), { org: '[AB] FIN', code: '' })).flags.map((f) => f.category)).toEqual(['incomplete']);
      expect(com([tap('1', D(7), '09:00')], { code: '' }, { ...rules, flexDepts: [] }).flags.map((f) => f.category)).toEqual(['incomplete']);
      expect(com([tap('1', D(7), '09:00')], { code: 'SLD' }).flags.map((f) => f.category)).toContain('conflict');
    });
    it('names match without the company prefix or case; an old stored rule set is migrated with COM added', () => {
      expect(com([tap('1', D(7), '09:00')], { org: 'com' }).flags).toHaveLength(0);
      expect(com([tap('1', D(7), '09:00')], {}, { ...rules, flexDepts: ['[XY] Com'] }).flags).toHaveLength(0);
      const old = defaultStore(); delete (old.versions[0] as { flexDepts?: string[] }).flexDepts;
      const m = migrate(old);
      expect(activeRules(m).flexDepts).toEqual(['COM']);
      expect(m.log[m.log.length - 1]).toMatchObject({ by: 'sistem' });
    });
  });

  describe('leave code but the taps cover the whole shift', () => {
    const full = (code: string, a: string, b: string, rs = rules) => one([tap('1', D(7), a), tap('1', D(7), b, 'out')], hr(D(7), { code }), rs);
    it('is a worked day: no flag, presence counts, even for SLD', () => {
      for (const code of ['ALR', 'SLD', 'CL']) expect(full(code, '08:51', '18:00').flags).toHaveLength(0);
      const rows = [hr(D(7), { code: 'SLD' })];
      const res = runEngine([tap('1', D(7), '08:51'), tap('1', D(7), '18:00', 'out')], rows, rules, '2026-09', raw);
      expect(dayOf(evaluateAttendance(res, rows, rules, {}).days, 7)).toMatchObject({ mode: 'wfo', unresolved: false });
    });
    it('late or early taps (not the whole shift), or the switch off, still need HR', () => {
      expect(full('SLD', '09:30', '18:00').flags.map((f) => f.category)).toEqual(['conflict']);
      expect(full('SLD', '09:00', '17:00').flags.map((f) => f.category)).toEqual(['conflict']);
      expect(full('SLD', '08:51', '18:00', withParams({ leaveWorkedFullDay: 0 })).flags.map((f) => f.category)).toEqual(['conflict']);
    });
    it('mislabelled in/out: 09:00 + a second "masuk" at 12:26 is still an afternoon leave (earliest and latest tap decide)', () => {
      const r = one([tap('1', D(7), '09:00'), tap('1', D(7), '12:26')], hr(D(7), { code: 'ALR' }));
      expect(r.flags).toHaveLength(0);
      expect(r.days[0]).toMatchObject({ early: false, gap: '' });
    });
  });

  describe('ALR without a period: half day inferred from the taps (HR rule)', () => {
    const alr = (a: string, b: string, r: Partial<HrisRow> = {}, rs = rules) => one([tap('1', D(7), a), tap('1', D(7), b, 'out')], hr(D(7), { code: 'ALR', ...r }), rs);

    it('on-time in + out at lunch = afternoon leave: no conflict, no early-out', () => {
      const r = alr('09:00', '12:00');
      expect(r.flags).toHaveLength(0);
      expect(r.days[0]).toMatchObject({ late: false, early: false });
      expect(r.days[0].note).toContain('cuti sore');
      expect(alr('08:55', '12:40').flags).toHaveLength(0); // left during the lunch window
    });
    it('late in after lunch + on-time out = morning leave: no conflict, no late', () => {
      const r = alr('13:00', '18:00');
      expect(r.flags).toHaveLength(0);
      expect(r.days[0]).toMatchObject({ late: false, early: false });
      expect(r.days[0].note).toContain('cuti pagi');
      expect(alr('12:30', '18:00').flags).toHaveLength(0);
    });
    it('anything else stays a full-day conflict for HR', () => {
            expect(alr('09:00', '17:00').flags.map((f) => f.category)).toEqual(['conflict']); // left mid-afternoon, not at lunch
      expect(alr('10:30', '17:00').flags.map((f) => f.category)).toEqual(['conflict']); // late morning, early out
      expect(alr('11:00', '18:00').flags.map((f) => f.category)).toEqual(['conflict']); // late but before lunch
    });
    it('needs both taps, a non-rejected status, ALR and the switch on', () => {
      expect(one([tap('1', D(7), '09:00')], hr(D(7), { code: 'ALR' })).flags.map((f) => f.category).sort()).toEqual(['conflict', 'incomplete']);
      expect(alr('09:00', '12:00', { approval: 'rejected' }).flags.map((f) => f.category)).toEqual(['conflict']);
      expect(alr('09:00', '12:00', { approval: 'pending' }).flags.map((f) => f.category)).toEqual(['conflict']);
      expect(alr('09:00', '12:00', { code: 'SLD' }).flags.map((f) => f.category)).toEqual(['conflict']);
      expect(alr('09:00', '12:00', {}, withParams({ inferHalfDayAlr: 0 })).flags.map((f) => f.category)).toEqual(['conflict']);
    });
    it('an explicit period from HRIS always wins over the inference', () => {
      const r = alr('09:00', '12:00', { approval: 'approved', leavePart: 'am' });
      expect(r.flags.map((f) => f.category)).toEqual(['conflict']); // tap inside the explicit AM leave
    });
  });
});

describe('9d. dinas / meeting luar', () => {
  const rs = withCodes({ code: 'DL', treatment: 'dinas' });
  const dl = (o: Partial<HrisRow> = {}) => hr(D(7), { code: 'DL', approval: 'approved', ...o });

  it('approved: a one-sided tap is not flagged and the missing side is not judged; both sides present is no conflict', () => {
    const inOnly = runEngine([tap('1', D(7), '09:00')], [dl()], rs, '2026-09', raw);
    expect(inOnly.flags).toHaveLength(0);
    expect(inOnly.days[0]).toMatchObject({ early: false, late: false, gap: '' });
    const outOnly = runEngine([tap('1', D(7), '18:00', 'out')], [dl()], rs, '2026-09', raw);
    expect(outOnly.flags).toHaveLength(0);
    expect(outOnly.days[0]).toMatchObject({ late: false, gap: '' });
    expect(runEngine([tap('1', D(7), '09:00'), tap('1', D(7), '18:00', 'out')], [dl()], rs, '2026-09', raw).flags).toHaveLength(0);
  });
  it('not approved: no exception, the gap is flagged as for any other day', () => {
    const r = runEngine([tap('1', D(7), '09:00')], [dl({ approval: 'pending' })], rs, '2026-09', raw);
    expect(r.flags.map((f) => f.category)).toEqual(['incomplete']);
    expect(r.days[0].early).toBe(true);
  });
  it('without any fingerprint an approved dinas day is neither WFO nor WFH: it lowers the obligation like approved leave', () => {
    const spec = (last: Partial<HrisRow>): Spec => ({ 7: { t: IN }, 8: { t: IN }, 9: { t: IN }, 10: WFH_DAY, 11: { r: last } });
    const ok = evalSpec(spec({ code: 'DL', approval: 'approved' }), rs);
    expect(dayOf(ok.days, 11)).toMatchObject({ mode: 'dinas', physical: false, excused: true });
    expect(ok.rows[0]).toMatchObject({ excused: 1, required: 3, credited: 3, status: 'patuh' });
    const pending = evalSpec(spec({ code: 'DL', approval: 'pending' }), rs);
    expect(dayOf(pending.days, 11)).toMatchObject({ mode: 'dinas', excused: false, unresolved: true });
    expect(dayOf(pending.days, 11).review).toContain('pengecualian tidak diberikan otomatis');
  });
  it('no default code is invented: an unmapped code stays "no rule"', () => {
    expect(rules.attendance.some((a) => a.treatment === 'dinas')).toBe(false);
    expect(runEngine([tap('1', D(7), '09:00'), tap('1', D(7), '18:00', 'out')], [dl()], rules, '2026-09', raw).flags.map((f) => f.category)).toEqual(['no_rule']);
  });
});

describe('9b. taps on a day off', () => {
  it('are treated as non-existent: not flagged, not counted, not physical presence; reported in the stats', () => {
    const rows = [hr(D(7)), hr(D(12), { shift: 'dayoff', schedIn: null, schedOut: null, code: '' }), hr(D(14), { shift: 'national holiday', schedIn: null, schedOut: null, code: '' })];
    const taps = [tap('1', D(7), '09:00'), tap('1', D(7), '18:00', 'out'), tap('1', D(12), '10:00'), tap('1', D(12), '12:00', 'out'), tap('1', D(14), '10:00')];
    const res = runEngine(taps, rows, rules, '2026-09', raw);
    expect(res.days.map((d) => d.date)).toEqual([D(7)]);
    expect(res.flags).toHaveLength(0);
    expect(res.stats.dayOffDays).toBe(2);
    const ev = evaluateAttendance(res, rows, rules, {});
    expect(ev.days.filter((d) => d.date !== D(7)).map((d) => [d.mode, d.physical, d.scheduled])).toEqual([['off', false, false], ['off', false, false]]);
    expect(ev.rows[0]).toMatchObject({ attended: 1, scheduled: 1 });
    expect(summarizeEmployees(res, {}, rules)[0]).toMatchObject({ clockIn: 1, clockOut: 1 });
    // a tap on a date with no HRIS row at all is a different case and still flagged
    expect(runEngine([tap('1', D(20), '09:00')], rows, rules, '2026-09', raw).flags.map((f) => f.category)).toContain('ambiguous');
  });
  it('the previous day keeps the out tap of an overnight shift even when the next day is a day off', () => {
    const rows = [hr(D(1), { shift: 'S3', schedIn: hm('22:00'), schedOut: hm('07:00') }), off(D(2))];
    const res = runEngine([tap('1', D(1), '22:00'), tap('1', D(2), '07:00', 'out')], rows, rules, '2026-09', raw);
    expect(res.days).toHaveLength(1);
    expect(res.days[0]).toMatchObject({ hasOut: true, last: 1440 + 420 });
    expect(res.stats.dayOffDays).toBe(0); // that tap was claimed by the shift, not "ignored"
  });
});

describe('10. employee identity reconciliation', () => {
  it('an ID that only exists in HRIS has no fingerprint: no flag, and its Talenta Check In counts as office presence', () => {
    const { taps, hris } = build({ 7: { t: IN }, 8: { t: IN } });
    const other = [hr(D(7), { id: '2', tIn: hm('08:55') }), hr(D(8), { id: '2' }), hr(D(9), { id: '2', workMode: 'wfh', tIn: hm('08:55') }), hr(D(10), { id: '2', code: 'ALR', approval: 'approved' })];
    const res = runEngine(taps, [...hris, ...other], rules, '2026-09', raw);
    expect(res.flags.filter((f) => f.empId === '2')).toHaveLength(0);
    const days = evaluateAttendance(res, [...hris, ...other], rules, {}).days.filter((d) => d.empId === '2');
    expect(days.map((d) => d.mode)).toEqual(['wfo', 'no_evidence', 'wfh', 'leave']); // presence only from Check In; explicit WFH, leave and "no record" are untouched
    expect(days[0].source).toContain('karyawan tanpa fingerprint');
    const row = evaluateAttendance(res, [...hris, ...other], rules, {}).rows.find((r) => r.id === '2')!;
    expect(row).toMatchObject({ attended: 1, wfh: 1, excused: 1 });
    expect(row.explanation).toContain('dinilai dari data HRIS saja');
    // an employee who has fingerprints elsewhere is never read this way, and the policy can be switched off
    expect(evaluateAttendance(res, [...hris, ...other], withParams({ hrisOnlyPresence: 0 }), {}).days.find((d) => d.empId === '2' && d.date === D(7))!.mode).toBe('wfh');
    const both = build({ 7: { t: IN, r: { tIn: hm('08:55') } }, 8: { r: { tIn: hm('08:55') } } });
    expect(evaluateAttendance(runEngine(both.taps, both.hris, rules, '2026-09', raw), both.hris, rules, acceptAll([])).days.map((d) => d.mode)).toEqual(['wfo', 'wfh']);
  });
  it('a fingerprint-only ID is still a reconciliation flag, and an employee-level exclude removes the employee from every table', () => {
    const { taps, hris } = build({ 7: { t: IN } });
    const noDept = [{ ...hr(D(7), { id: '2' }), org: '' }];
    const res = runEngine([...taps, tap('9', D(7), '09:00')], [...hris, ...noDept], rules, '2026-09', raw);
    expect(res.flags.find((f) => f.empId === '9')?.reason).toContain('tidak ada di HRIS');
    const flag = res.flags.find((f) => f.empId === '2')!; // missing department: employee-level flag
    const excluded = evaluateAttendance(res, [...hris, ...noDept], rules, { [flag.id]: { action: 'exclude', reason: 'x', by: 'hr', at: '' } });
    expect(excluded.rows.map((r) => r.id)).toEqual(['1']);
    expect(excluded.days.every((d) => d.empId === '1')).toBe(true); // totals reconcile
  });
});

describe('11. leave: approval, partial days and conflicts with the fingerprint', () => {
  const am = { code: 'ALR', approval: 'approved' as const, leavePart: 'am' as const };
  const pm = { code: 'ALE', approval: 'approved' as const, leavePart: 'pm' as const };

  it('Annual Leave Reguler before lunch: obligation resumes after lunch, no conflict', () => {
    const ok = runEngine([tap('1', D(7), '13:05'), tap('1', D(7), '18:00', 'out')], [hr(D(7), am)], rules, '2026-09', raw);
    expect(ok.flags).toHaveLength(0);
    expect(ok.days[0]).toMatchObject({ late: false, lateAfter: 795 });
    expect(ok.days[0].note).toContain('Annual Leave Reguler');
    const late = runEngine([tap('1', D(7), '13:30'), tap('1', D(7), '18:00', 'out')], [hr(D(7), am)], rules, '2026-09', raw);
    expect(late.days[0].late).toBe(true);
  });
  it('Annual Leave Executive after lunch: obligation ends at lunch, no conflict', () => {
    const ok = runEngine([tap('1', D(7), '09:00'), tap('1', D(7), '12:05', 'out')], [hr(D(7), pm)], rules, '2026-09', raw);
    expect(ok.flags).toHaveLength(0);
    expect(ok.days[0]).toMatchObject({ early: false, earlyBefore: 720 });
    expect(ok.days[0].note).toContain('Annual Leave Executive');
    const early = runEngine([tap('1', D(7), '09:00'), tap('1', D(7), '11:30', 'out')], [hr(D(7), pm)], rules, '2026-09', raw);
    expect(early.days[0].early).toBe(true);
  });
  it('lunch boundaries come from Config, not hardcoded', () => {
    const rs = withParams({ lunchEndMin: hm('12:30') });
    const res = runEngine([tap('1', D(7), '12:50'), tap('1', D(7), '18:00', 'out')], [hr(D(7), am)], rs, '2026-09', raw);
    expect(res.days[0]).toMatchObject({ late: true, lateAfter: hm('12:45') }); // leave ends 12:30, plus the 15 min tolerance
    expect(runEngine([tap('1', D(7), '12:44'), tap('1', D(7), '18:00', 'out')], [hr(D(7), am)], rs, '2026-09', raw).days[0].late).toBe(false);
  });
  it('a tap inside an approved leave period is a conflict, not a silent exception', () => {
    const res = runEngine([tap('1', D(7), '10:00'), tap('1', D(7), '18:00', 'out')], [hr(D(7), am)], rules, '2026-09', raw);
    const f = res.flags.find((x) => x.category === 'conflict')!;
    expect(f.reason).toContain('jatuh di dalam periode');
    expect(res.days[0].lateAfter).toBe(555); // no waiver was granted
  });
  it('sick leave after clocking in with explicit times: the early departure is approved, taps stay the evidence', () => {
    const sick = { code: 'SLD', approval: 'approved' as const, leaveStart: hm('11:00'), leaveEnd: hm('18:00') };
    const res = runEngine([tap('1', D(7), '08:55'), tap('1', D(7), '11:05', 'out')], [hr(D(7), sick)], rules, '2026-09', raw);
    expect(res.flags).toHaveLength(0);
    expect(res.days[0]).toMatchObject({ early: false, earlyBefore: 660 });
  });
  it('approved early departure: waived only when approved; unapproved is flagged and the tentative result still shows early', () => {
    const leave = { code: 'CL', leaveStart: hm('15:00'), leaveEnd: hm('18:00') };
    const approved = runEngine([tap('1', D(7), '09:00'), tap('1', D(7), '15:05', 'out')], [hr(D(7), { ...leave, approval: 'approved' })], rules, '2026-09', raw);
    expect(approved.days[0].early).toBe(false);
    expect(approved.flags).toHaveLength(0);
    for (const approval of ['pending', 'rejected', ''] as const) {
      const r = runEngine([tap('1', D(7), '09:00'), tap('1', D(7), '15:05', 'out')], [hr(D(7), { ...leave, approval })], rules, '2026-09', raw);
      expect(r.flags.map((f) => f.category)).toEqual(['conflict']);
      expect(r.flags[0].reason).toContain('pengecualian tidak diberikan otomatis');
      expect(r.days[0].early).toBe(true);
    }
  });
  it('full-day approved leave plus a tap preserves both pieces of evidence and requires a decision', () => {
    const rows = [hr(D(7), { code: 'ALR', approval: 'approved' })];
    const res = runEngine([tap('1', D(7), '10:00'), tap('1', D(7), '17:00', 'out')], rows, rules, '2026-09', raw);
    expect(res.flags.map((f) => f.category)).toEqual(['conflict']);
    const open = evaluateAttendance(res, rows, rules, {});
    expect(dayOf(open.days, 7)).toMatchObject({ mode: 'pending', unresolved: true });
    expect(dayOf(open.days, 7).review).toContain('Konflik antar sumber');
    const done = evaluateAttendance(res, rows, rules, acceptAll(res.flags));
    expect(dayOf(done.days, 7)).toMatchObject({ mode: 'wfo', evidence: '10:00 masuk, 17:00 pulang' });
    expect(dayOf(done.days, 7).leave).toContain('Annual Leave Reguler');
    expect(dayOf(done.days, 7).decision).toContain('Accept');
  });
  it('a leave code without an approval column is read as a full day that is not approved', () => {
    const r = evalSpec({ 7: { r: { code: 'ALR' } } });
    expect(dayOf(r.days, 7)).toMatchObject({ mode: 'leave', excused: false, unresolved: true, approved: false });
    expect(dayOf(r.days, 7).review).toContain('pengecualian tidak diberikan otomatis');
    const lenient = evalSpec({ 7: { r: { code: 'ALR' } } }, withParams({ missingApprovalAsApproved: 1 }));
    expect(dayOf(lenient.days, 7)).toMatchObject({ excused: true, unresolved: false });
  });
  it('partial leave without any fingerprint is neither a full excuse nor a violation', () => {
    const r = evalSpec({ 7: { r: am } });
    expect(dayOf(r.days, 7)).toMatchObject({ mode: 'leave_partial', excused: false, unresolved: true });
    expect(r.rows[0].required).toBe(0); // one scheduled day, minus the WFH allowance
  });
  it('cross-midnight half-day leave without explicit hours is not guessed', () => {
    const res = runEngine([tap('1', D(7), '22:05'), tap('1', D(8), '07:00', 'out')], [hr(D(7), { shift: 'S3', schedIn: hm('22:00'), schedOut: hm('07:00'), code: 'ALR', approval: 'approved', leavePart: 'am' }), off(D(8))], rules, '2026-09', raw);
    expect(res.flags[0].reason).toContain('shift lintas hari');
  });
  it('leave records outside the scheduled shift or inconsistent times are ignored with a warning, not trusted', async () => {
    const ing = await ingest(await xlsx([['Employee ID', 'Organization', 'Tanggal', 'Waktu', 'Status'], ['1', 'FIN', '2026-09-07', '09:00', 'C/Masuk']]), await xlsx([['Employee ID', 'Full Name', 'Organization', 'Date', 'Shift', 'Schedule In', 'Schedule Out', 'Attendance Code', 'Leave Start', 'Leave End'], ['1', 'A', 'FIN', '2026-09-07', 'N', '09:00', '18:00', 'CL', '15:00', '11:00']]));
    expect(ing.hris[0]).toMatchObject({ leaveStart: null, leaveEnd: null });
    expect(ing.issues.some((i) => i.message.includes('tidak lengkap atau tidak berurutan'))).toBe(true);
  });
});

describe('12. WFH from Talenta is never actual WFO', () => {
  it('explicit WFH code without fingerprint', () => {
    const rs = withCodes({ code: 'WFH', treatment: 'wfh' });
    const r = evalSpec({ 7: { r: { code: 'WFH' } } }, rs);
    expect(dayOf(r.days, 7)).toMatchObject({ mode: 'wfh', physical: false });
    expect(dayOf(r.days, 7).source).toContain('kode Talenta');
    expect(r.rows[0]).toMatchObject({ attended: 0, wfh: 1 });
  });
  it('Work Location = WFH, and a Talenta Check In without fingerprint (policy switch)', () => {
    const a = evalSpec({ 7: { r: { workMode: 'wfh' } } });
    expect(dayOf(a.days, 7).mode).toBe('wfh');
    const b = evalSpec({ 7: WFH_DAY, 8: { t: IN } }); // the employee has fingerprints on other days
    expect(dayOf(b.days, 7)).toMatchObject({ mode: 'wfh', physical: false });
    expect(dayOf(b.days, 7).source).toContain('disimpulkan');
    const off0 = evalSpec({ 7: WFH_DAY, 8: { t: IN } }, withParams({ inferWfhFromTalenta: 0 }));
    expect(dayOf(off0.days, 7)).toMatchObject({ mode: 'no_evidence', unresolved: true });
    expect(dayOf(off0.days, 7).review).toContain('status WFH belum dikonfirmasi');
  });
  it('no fingerprint and no Talenta record is not read as absence', () => {
    const r = evalSpec({ 7: {} });
    expect(dayOf(r.days, 7)).toMatchObject({ mode: 'no_evidence', unresolved: true });
    expect(dayOf(r.days, 7).review).toContain('tidak dianggap absen otomatis');
  });
  it('WFH in Talenta but the fingerprint shows presence: conflict flagged, physical presence read from the fingerprint', () => {
    const rs = withCodes({ code: 'WFH', treatment: 'wfh' });
    const res = runEngine([tap('1', D(7), '09:00'), tap('1', D(7), '18:00', 'out')], [hr(D(7), { code: 'WFH' })], rs, '2026-09', raw);
    expect(res.flags.map((f) => f.category)).toEqual(['conflict']);
    expect(res.flags[0].reason).toContain('fingerprint menunjukkan hadir');
  });
  it('an unknown attendance code never grants or denies anything automatically', () => {
    const r = evalSpec({ 7: { r: { code: 'QQ' } } });
    expect(dayOf(r.days, 7)).toMatchObject({ mode: 'no_evidence', excused: false, unresolved: true });
  });
});

describe('13. WFO compliance calculation', () => {
  const week = (modes: ('o' | 'w' | 'x' | 'l' | 'u')[]): Spec => Object.fromEntries(modes.map((m, i): [number, Spec[number]] => [7 + i,
    m === 'o' ? { t: IN } : m === 'w' ? WFH_DAY : m === 'x' ? {} : m === 'l' ? { r: { code: 'ALR', approval: 'approved' } } : { r: { code: 'ALR' } }]));
  const one = (modes: Parameters<typeof week>[0], rs: RuleSet = rules) => evalSpec(week(modes), rs).rows[0];

  it('4 WFO + 1 WFH is compliant: 4 of 4', () => {
    expect(one(['o', 'o', 'o', 'o', 'w'])).toMatchObject({ required: 4, credited: 4, rate: 1, status: 'patuh' });
  });
  it('3 WFO + 1 WFH + 1 day without evidence needs review, not a violation', () => {
    expect(one(['o', 'o', 'o', 'w', 'x'])).toMatchObject({ required: 4, credited: 3, open: 1, status: 'review' });
  });
  it('2 WFO + 3 WFH is a definite violation (WFH never counts as WFO)', () => {
    expect(one(['o', 'o', 'w', 'w', 'w'])).toMatchObject({ credited: 2, required: 4, status: 'tidak_patuh' });
  });
  it('approved leave lowers the obligation; the interpretation is configurable', () => {
    expect(one(['o', 'o', 'o', 'w', 'l'])).toMatchObject({ excused: 1, required: 3, credited: 3, status: 'patuh' });
    expect(one(['o', 'o', 'o', 'w', 'l'], withParams({ leaveConsumesWfhAllowance: 1 }))).toMatchObject({ required: 4, credited: 3, status: 'tidak_patuh' });
  });
  it('unapproved leave does not lower the obligation and leaves the result open', () => {
    expect(one(['o', 'o', 'o', 'w', 'u'])).toMatchObject({ excused: 0, required: 4, credited: 3, open: 1, status: 'review' });
  });
  it('different employee schedules: 3 scheduled days give 2 required', () => {
    const spec: Spec = { 7: { t: IN }, 8: { t: IN }, 9: { r: { shift: 'dayoff', schedIn: null, schedOut: null, code: '' } }, 10: { t: IN }, 11: { r: { shift: 'dayoff', schedIn: null, schedOut: null, code: '' } } };
    expect(evalSpec(spec).rows[0]).toMatchObject({ scheduled: 3, required: 2, credited: 2, status: 'patuh' });
  });
  it('boundary weeks are clipped to the period: Tue 1 – Fri 4 Sep and Mon 28 – Wed 30 Sep', () => {
    const spec: Spec = {};
    for (const d of [1, 2, 3, 4, 28, 29, 30]) spec[d] = { t: IN };
    const r = evalSpec(spec).rows[0];
    expect(r.weeks.map((w) => [w.weekStart, w.scheduled, w.required])).toEqual([['2026-08-31', 4, 3], ['2026-09-28', 3, 2]]);
    expect(r).toMatchObject({ required: 5, credited: 5, status: 'patuh' });
  });
  it('excluded days leave the obligation; a month with nothing scheduled has no obligation', () => {
    const { taps, hris } = build(week(['o', 'o', 'o', 'o', 'o']));
    const res = runEngine(taps, hris, rules, '2026-09', raw);
    const ex = evaluateAttendance(res, hris, rules, { 'ambiguous|1|2026-09-07': { action: 'exclude', reason: 'x', by: 'hr', at: '' } });
    expect(ex.rows[0].scheduled).toBe(5);
    const none = evalSpec({ 7: { r: { shift: 'dayoff', schedIn: null, schedOut: null, code: '' } } });
    expect(none.rows[0]).toMatchObject({ required: 0, status: 'tanpa_kewajiban', rate: null });
  });
  it('the compliance threshold is configurable', () => {
    expect(one(['o', 'o', 'o', 'x', 'x'], withParams({ wfoCompliancePct: 75 }))).toMatchObject({ required: 4, credited: 3, status: 'patuh' });
  });
  it('pending flags make a day unresolved instead of absent', () => {
    const { taps, hris } = build({ 7: { t: IN, r: { code: 'ALR', approval: 'approved' } }, 8: { t: IN }, 9: { t: IN }, 10: { t: IN }, 11: WFH_DAY });
    const strict = withParams({ leaveWorkedFullDay: 0 }); // full-day taps + leave code would otherwise count as worked
    const res = runEngine(taps, hris, strict, '2026-09', raw);
    const ev = evaluateAttendance(res, hris, strict, {});
    expect(dayOf(ev.days, 7)).toMatchObject({ mode: 'pending', unresolved: true });
    expect(ev.rows[0]).toMatchObject({ attended: 3, status: 'review' });
  });
});

describe('14. overrides never erase the system result', () => {
  it('an override changes the final result but the stored system result and the original reason survive', () => {
    const rows = [hr(D(7))];
    const res = runEngine([tap('1', D(7), '09:30')], rows, strict, '2026-09', raw);
    const id = res.flags[0].id;
    const d: Decisions = { [id]: { action: 'override', outcome: 'compliant', reason: 'Lupa tap pulang, dikonfirmasi atasan', by: 'hr@x', at: '2026-09-08T00:00:00Z' } };
    expect(resolveDay(res.days[0], d)).toMatchObject({ late: false, early: false, manual: true });
    expect(res.days[0]).toMatchObject({ late: true, early: true }); // untouched system result
    const day = evaluateAttendance(res, rows, strict, d).days[0];
    expect(day).toMatchObject({ late: 'tidak', early: 'tidak', sysLate: true, sysEarly: true });
    expect(day.decision).toContain('Lupa tap pulang');
    expect(day.decision).toContain('[hr@x]');
  });
});

describe('15. repeated import / idempotency', () => {
  it('the same taps imported twice do not inflate attendance', () => {
    const { taps, hris } = build({ 7: { t: IN }, 8: { t: ['09:20', '18:00'] } });
    const once = runEngine(taps, hris, rules, '2026-09', raw);
    const twice = runEngine([...taps, ...taps.map((t) => ({ ...t }))], hris, rules, '2026-09', raw);
    expect(summarizeEmployees(twice, {}, rules)).toEqual(summarizeEmployees(once, {}, rules));
    expect(twice.days.map((d) => [d.date, d.first, d.last])).toEqual(once.days.map((d) => [d.date, d.first, d.last]));
    expect(twice.stats.exactDup).toBe(taps.length);
    expect(runEngine(taps, hris, rules, '2026-09', raw)).toEqual(once); // deterministic
  });
  it('identical HRIS rows are folded, conflicting HRIS rows are kept and flagged', async () => {
    const head = ['Employee ID', 'Full Name', 'Organization', 'Date', 'Shift', 'Schedule In', 'Schedule Out', 'Attendance Code'];
    const same = ['1', 'A', 'FIN', '2026-09-07', 'N', '09:00', '18:00', 'H'];
    const ing = await ingest(await xlsx([['Employee ID', 'Organization', 'Tanggal', 'Waktu', 'Status'], ['1', 'FIN', '2026-09-07', '09:00', 'C/Masuk'], ['1', 'FIN', '2026-09-07', '18:00', 'C/Keluar']]), await xlsx([head, same, same, ['1', 'A', 'FIN', '2026-09-07', 'S1', '07:00', '16:00', 'H'], ['1', 'A', 'FIN', '2026-09-08', 'N', '09:00', '18:00', 'H']]));
    expect(ing.hris).toHaveLength(3);
    expect(ing.issues.map((i) => i.message).join()).toContain('1 baris HRIS identik');
    expect(ing.issues.map((i) => i.message).join()).toContain('1 kombinasi ID dan tanggal memuat baris HRIS yang berbeda');
    const res = runEngine(ing.taps, ing.hris, rules, ing.period, ing.stats);
    expect(res.flags.find((f) => f.category === 'conflict')?.reason).toContain('N/H vs S1/H');
    expect(ing.taps[0].row).toBe(2); // source row kept for traceability
  });
});

describe('16. parsing, time zones, null and malformed values', () => {
  it('reads Excel date/times as wall-clock UTC fields, independent of the machine time zone, with no conversion', () => {
    expect(parseTime(new Date(Date.UTC(1899, 11, 30, 9, 3)))).toBe(543);
    expect(parseTime(new Date(Date.UTC(2026, 8, 1, 23, 59, 30)))).toBeCloseTo(1439.5);
    expect(parseDate(new Date(Date.UTC(2026, 8, 1)))).toBe('2026-09-01');
    expect(parseDate(46266)).toBe('2026-09-01'); // Excel serial
    expect(parseDate('01/09/2026')).toBe('2026-09-01');
  });
  it('rejects malformed values instead of guessing', () => {
    expect([parseTime('24:00'), parseTime('9:75'), parseTime(''), parseTime(null), parseTime(1.5), parseDate('2026-13-01'), parseDate('2026-02-30'), parseDate(null), parseDate(5)]).toEqual(Array(9).fill(null));
    expect([parseApproval('Approved'), parseApproval('Menunggu'), parseApproval('Ditolak'), parseApproval(''), parseApproval('maybe')]).toEqual(['approved', 'pending', 'rejected', '', null]);
    expect([parsePart('AM'), parsePart('Sebelum makan siang'), parsePart('Setelah makan siang'), parsePart('Full Day'), parsePart('???')]).toEqual(['am', 'am', 'pm', 'full', null]);
  });
  it('reports malformed rows with sheet, row and column, and refuses to process', async () => {
    const ing = await ingest(
      await xlsx([['Employee ID', 'Organization', 'Tanggal', 'Waktu', 'Status'], ['1', 'FIN', '2026-09-08', 'jam?', 'C/Masuk']]),
      await xlsx([['Employee ID', 'Full Name', 'Organization', 'Date', 'Shift', 'Schedule In', 'Schedule Out', 'Attendance Code'], ['', 'A', 'FIN', '2026-09-07', 'N', '09:00', '18:00', 'H'], ['1', 'A', 'FIN', 'bukan tanggal', 'N', '09:00', '18:00', 'H'], ['1', 'A', 'FIN', '2026-09-08', 'N', '25:00', '18:00', 'H']]));
    const errs = ing.issues.filter((i) => i.level === 'error');
    expect(errs.map((e) => e.where)).toEqual(expect.arrayContaining([expect.stringContaining('kolom Employee ID'), expect.stringContaining('kolom Date'), expect.stringContaining('kolom Schedule In'), expect.stringContaining('kolom Waktu')]));
    expect(errs.every((e) => /baris \d+/.test(e.where))).toBe(true);
  });
  it('validates the file signature and required columns before parsing', async () => {
    expect(looksLikeXlsx(new ArrayBuffer(2))).toBe(false);
    expect(looksLikeXlsx(new TextEncoder().encode('a,b\n1,2').buffer as ArrayBuffer)).toBe(false);
    const ing = await ingest(new TextEncoder().encode('Employee ID,x\n1,2').buffer as ArrayBuffer, await xlsx([['Employee ID', 'Wrong'], ['1', 'x']]));
    const msgs = ing.issues.map((i) => `${i.file}: ${i.message}`).join('\n');
    expect(msgs).toContain('Fingerprint: Isi file bukan format .xlsx');
    expect(msgs).toContain('HRIS: Kolom wajib tidak ditemukan');
    expect(ing.taps).toHaveLength(0);
  });
});

describe('17. policy store', () => {
  it('migrates an older store with a new version, an audit entry, and untouched history', () => {
    const old = defaultStore();
    const { scheduleBasis: _s, wfoDaysPerWeek: _w, ...legacyParams } = defaultParams();
    old.versions[0].params = { ...legacyParams, evalThresholdPct: 25 } as Params;
    const m = migrate(old);
    expect(m.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(m.versions[0].params.evalThresholdPct).toBe(25);
    expect('scheduleBasis' in m.versions[0].params).toBe(false); // history is not rewritten
    expect(m.versions[1].params).toMatchObject({ evalThresholdPct: 25, scheduleBasis: 1, wfoDaysPerWeek: 4 });
    expect(m.log.at(-1)).toMatchObject({ by: 'sistem', action: 'update' });
    expect(migrate(m)).toBe(m); // idempotent
  });
});

describe('18. dashboard, detail tables and export reconcile', () => {
  it('Daily Evaluation, WFO Compliance and the Dashboard agree with the on-screen summary', async () => {
    const a = build({ 7: { t: IN }, 8: { t: ['09:20', '17:00'] }, 9: WFH_DAY, 10: { r: { code: 'ALR', approval: 'approved' } }, 11: { t: IN } }, '1');
    const b = build({ 7: { t: IN }, 8: WFH_DAY, 9: WFH_DAY, 10: WFH_DAY, 11: {} }, '2');
    const taps = [...a.taps, ...b.taps], hris = [...a.hris, ...b.hris.map((h) => ({ ...h, org: 'OPS' }))];
    const res = runEngine(taps, hris, rules, '2026-09', raw);
    const decisions = acceptAll(res.flags);
    const ev = evaluateAttendance(res, hris, rules, decisions);
    const { buffer } = await buildResult({ res, hris, emps: summarizeEmployees(res, decisions, rules), decisions, rules, user: 'hr' });
    const f = await parseResult(buffer, 'x.xlsx');
    expect(f.intact).toBe(true);
    expect(f.daily).toHaveLength(ev.days.length);
    expect(f.wfo).toHaveLength(ev.rows.length);
    const m = monthly(f).wfo!;
    expect(m).toMatchObject({ employees: ev.summary.employees, required: ev.summary.required, credited: ev.summary.credited, late: ev.summary.late, early: ev.summary.early, missing: ev.summary.missing, reviewDays: ev.summary.reviewDays, days: ev.days.length, patuh: ev.summary.status.patuh, tidakPatuh: ev.summary.status.tidak_patuh, review: ev.summary.status.review, physical: ev.summary.physical, wfhEmployees: ev.summary.wfhEmployees });
    // every total is derived from the same rows
    expect(Object.values(ev.summary.byMode).reduce((s, n) => s + n, 0)).toBe(ev.days.length);
    expect(ev.rows.reduce((s, r) => s + r.attended, 0)).toBe(ev.summary.byMode.wfo);
    expect(ev.rows.reduce((s, r) => s + r.wfh, 0)).toBe(ev.summary.byMode.wfh);
    expect(m.byDept.map((d) => [d.dept, d.n])).toEqual([['FIN', 1], ['OPS', 1]]);
    expect(m.byDept.reduce((s, d) => s + d.credited, 0)).toBe(ev.summary.credited);
    // late / early on the Daily sheet are the very numbers Final Data is built from
    const fin = summarizeEmployees(res, decisions, rules);
    expect(fin.reduce((s, e) => s + e.late, 0)).toBe(ev.summary.late);
    expect(fin.reduce((s, e) => s + e.early, 0)).toBe(ev.summary.early);
  });
  it('detects tampering with the new sheets and still reads schema /2 files', async () => {
    const { taps, hris } = build({ 7: { t: IN } });
    const res = runEngine(taps, hris, rules, '2026-09', raw);
    const { buffer } = await buildResult({ res, hris, emps: summarizeEmployees(res, {}, rules), decisions: {}, rules, user: 'hr' });
    const ExcelJS = (await import('exceljs')).default;
    const edit = async (fn: (wb: import('exceljs').Workbook) => void) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer); fn(wb); return (await wb.xlsx.writeBuffer()) as ArrayBuffer; };
    expect((await parseResult(await edit((wb) => { wb.getWorksheet('WFO Compliance')!.getCell('K2').value = 99; }), 'a.xlsx')).intact).toBe(false);
    expect((await parseResult(await edit((wb) => { wb.getWorksheet('Daily Evaluation')!.getCell('O2').value = 'ya'; }), 'a.xlsx')).intact).toBe(false);
    await expect(parseResult(await edit((wb) => wb.removeWorksheet(wb.getWorksheet('WFO Compliance')!.id)), 'a.xlsx')).rejects.toThrow('WFO Compliance');
    // a schema /2 file: no evaluation sheets, checksum over the five original sheets only
    let legacy = await edit((wb) => {
      wb.removeWorksheet(wb.getWorksheet('WFO Compliance')!.id); wb.removeWorksheet(wb.getWorksheet('Daily Evaluation')!.id);
      const meta = wb.getWorksheet('Metadata')!; meta.eachRow((r) => { if (r.getCell(1).value === 'Schema Version') r.getCell(2).value = 'tenflow.result/2'; });
    });
    const s = await readSheets(legacy) as Record<string, (string | number)[][]>;
    const sum = await checksumOf(s['Final Data'], s['Master Data'], s['Exception'], s['Audit Trail'], s['Metadata']);
    const ExcelJS2 = new ExcelJS.Workbook(); await ExcelJS2.xlsx.load(legacy);
    ExcelJS2.getWorksheet('Metadata')!.eachRow((r) => { if (r.getCell(1).value === CHECKSUM_KEY) r.getCell(2).value = sum; });
    legacy = (await ExcelJS2.xlsx.writeBuffer()) as ArrayBuffer;
    const lf = await parseResult(legacy, 'old.xlsx');
    expect(lf).toMatchObject({ intact: true, wfo: null, daily: null });
    expect(monthly(lf).wfo).toBeNull();
  });
});

describe('19. permissions for sensitive actions', () => {
  it('only Admin may open Settings & Config; HR and Admin may process and view the dashboard; anonymous gets nothing', () => {
    expect(canAccess('admin', '/config')).toBe(true);
    expect(canAccess('hr', '/config')).toBe(false);
    for (const p of ['/proses', '/dashboard']) { expect(canAccess('hr', p)).toBe(true); expect(canAccess('admin', p)).toBe(true); expect(canAccess(undefined, p)).toBe(false); }
    expect(canAccess('admin', '/tidak-ada')).toBe(false);
    expect(canAccess(undefined, '/config')).toBe(false);
  });
});

async function xlsx(rows: (string | number)[][]) { return writeXlsx([{ name: 'S', rows }]); }
