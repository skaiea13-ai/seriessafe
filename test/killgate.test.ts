import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ICAL from 'ical.js';

import { parseIcs } from '../src/ics/parse.ts';
import { serializeIcs } from '../src/ics/serialize.ts';
import { buildSeriesGraph, listRecurringUids } from '../src/engine/series.ts';
import { simulateSplit } from '../src/engine/split.ts';
import { applySplit, applyNaive } from '../src/engine/apply.ts';
import { validateStage } from '../src/engine/validate.ts';

const SRC = readFileSync(new URL('../fixtures/korean-class.ics', import.meta.url), 'utf8');
const UID = 'advanced-korean-tue@school.example.com';
const TZ = 'Asia/Seoul';
/** 2026-09-01 00:00 KST — the effective date for the surgery. */
const EFFECTIVE = Date.UTC(2026, 7, 31, 15, 0, 0);

function graphOf(text: string) {
  const cal = parseIcs(text);
  const g = buildSeriesGraph(cal, UID);
  assert.ok(g, 'graph must build');
  return { cal, g: g! };
}

/** Independent verification: re-parse with Mozilla ical.js, not our own code. */
function independentEvents(text: string) {
  const comp = new ICAL.Component(ICAL.parse(text));
  return comp.getAllSubcomponents('vevent').map((v: any) => new ICAL.Event(v, { strictExceptions: false }));
}

function kstDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}
function kstTime(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms));
}

test('fixture parses and the series graph reflects every exception', () => {
  const { g } = graphOf(SRC);
  assert.equal(listRecurringUids(parseIcs(SRC)).length, 1);
  assert.equal(g.summary, 'Advanced Korean — Tuesday Evening Class');
  assert.equal(g.tzid, TZ);
  assert.equal(g.exdates.length, 3, 'three EXDATEs across two properties');
  assert.equal(g.rdates.length, 1);
  assert.equal(g.overrides.size, 3);
  const cancelled = g.occurrences.filter((o) => o.kind === 'cancelled');
  const overridden = g.occurrences.filter((o) => o.kind === 'overridden');
  assert.equal(cancelled.length, 3);
  assert.equal(overridden.length, 3);
  assert.equal(g.warnings.length, 0, `unexpected warnings: ${g.warnings.join(' | ')}`);
});

test('KILL GATE: split preserves every invariant', () => {
  const { cal, g } = graphOf(SRC);
  const plan = simulateSplit(g, { effectiveFromMs: EFFECTIVE, byday: ['TH'] });
  assert.equal(plan.refusals.length, 0, `refusals: ${JSON.stringify(plan.refusals)}`);
  assert.ok(plan.ok);

  const { calendar } = applySplit(cal, g, plan);
  const out = serializeIcs(calendar);

  // ---- independent parse ------------------------------------------
  const events = independentEvents(out);
  assert.ok(events.length >= 5, `expected split output, got ${events.length} events`);

  const oldMaster = events.find((e: any) => e.uid === UID && !e.isRecurrenceException());
  const newUid = plan.newUid;
  const newMaster = events.find((e: any) => e.uid === newUid && !e.isRecurrenceException());
  assert.ok(oldMaster, 'old master survives');
  assert.ok(newMaster, 'new master exists');

  // 1. Past occurrences and their properties are untouched.
  const pastOverride: any = events.find(
    (e: any) => e.uid === UID && e.isRecurrenceException() && kstDate(e.startDate.toJSDate().getTime()) === '2026-04-07',
  );
  assert.ok(pastOverride, 'the April room-swap override is still attached to the original series');
  assert.match(pastOverride.location, /Room C-105/);

  // 2. Old series now stops before the effective date.
  const oldExpanded = expand(UID, events);
  assert.ok(oldExpanded.every((ms) => ms < EFFECTIVE), 'no old-series occurrence lands on/after the effective date');
  assert.ok(oldExpanded.some((ms) => kstDate(ms) === '2026-08-25'), 'the last August Tuesday survives');

  // 3. Past cancellation still cancelled.
  assert.ok(!oldExpanded.some((ms) => kstDate(ms) === '2026-05-05'), 'Children’s Day stays cancelled');

  // 4. New series runs on Thursdays at the original time.
  const newResolved = resolve(newUid, events);
  const newExpanded = newResolved.map((o) => o.startMs);
  assert.ok(newResolved.length > 0);
  // Every *pattern slot* moves to Thursday. The single deliberate exception is
  // the explicit extra session on Wed 11 Nov, which keeps its own date.
  const EXTRA = '2026-11-11';
  for (const o of newResolved) {
    if (kstDate(o.slotMs) === EXTRA) continue;
    assert.equal(new Date(o.slotMs + 9 * 3600_000).getUTCDay(), 4,
      `slot ${kstDate(o.slotMs)} should be a Thursday`);
    assert.equal(kstTime(o.slotMs), '19:00', 'time of day preserved across the move');
  }
  assert.ok(newResolved.some((o) => kstDate(o.slotMs) === EXTRA),
    'the extra Wednesday session is still scheduled');

  // 5. Both future cancellations survive, re-anchored by ordinal.
  //    old 2026-09-22 was future slot #3 -> new 2026-09-24
  //    old 2026-10-06 was future slot #5 -> new 2026-10-08
  assert.ok(!newExpanded.some((ms) => kstDate(ms) === '2026-09-24'), 'Chuseok week stays cancelled');
  assert.ok(!newExpanded.some((ms) => kstDate(ms) === '2026-10-08'), 'the October cancellation survives');
  assert.equal(
    plan.remaps.filter((r) => r.kind === 'cancellation').length, 2,
    'exactly two cancellations were re-anchored',
  );

  // 6. The Wednesday make-up keeps its own date, is not absorbed, not duplicated.
  const makeups = events.filter((e: any) => /MAKE-UP/.test(e.summary ?? ''));
  assert.equal(makeups.length, 1, 'the make-up exists exactly once');
  const mk = makeups[0];
  assert.equal(kstDate(mk.startDate.toJSDate().getTime()), '2026-09-16', 'make-up stays on its Wednesday');
  assert.equal(mk.uid, newUid, 'make-up now belongs to the new series');
  assert.equal(
    kstDate(mk.recurrenceId.toJSDate().getTime()), '2026-09-17',
    'make-up is re-anchored to the matching new Thursday slot',
  );
  // The Sep-17 slot must render *as* the make-up, not alongside a plain class.
  const sep17 = newResolved.filter((o) => kstDate(o.slotMs) === '2026-09-17');
  assert.equal(sep17.length, 1, 'the re-anchored slot exists exactly once');
  assert.equal(kstDate(sep17[0].startMs), '2026-09-16',
    'that slot renders on the Wednesday, so the make-up is neither absorbed nor duplicated');
  assert.equal(newExpanded.filter((ms) => kstDate(ms) === '2026-09-17').length, 0,
    'no plain Thursday class is left behind on the replaced slot');

  // 7. Location and attendee overrides survive with their data.
  const guest: any = events.find((e: any) => /Guest Lecture/.test(e.summary ?? ''));
  assert.ok(guest, 'guest-lecture override survives');
  assert.match(guest.location, /Room B-302/);
  assert.equal(guest.attendees.length, 3, 'the extra guest attendee is preserved');
  assert.equal(guest.uid, newUid);

  // 8. Alarms and private X- properties survive on the re-anchored override.
  const mkComp = (mk as any).component;
  assert.equal(mkComp.getAllSubcomponents('valarm').length, 1, 'make-up keeps its reminder');
  assert.equal(mkComp.getFirstPropertyValue('x-school-makeup-for'), '20260915');
  const newMasterComp = (newMaster as any).component;
  assert.equal(newMasterComp.getFirstPropertyValue('x-school-course-code'), 'KOR-401');
  assert.equal(newMasterComp.getFirstPropertyValue('x-school-billing-unit'), 'TERM-2026-2');
  assert.equal(newMasterComp.getAllSubcomponents('valarm').length, 1, 'new master keeps its reminder');
  assert.equal(newMasterComp.getAllProperties('attendee').length, 2, 'roster preserved');

  // 9. The extra RDATE session keeps its own date.
  const rdates = newMasterComp.getAllProperties('rdate');
  assert.ok(rdates.length >= 1, 'the extra 11 Nov session is carried onto the new series');
});

test('CONTROL: the conventional edit destroys what we preserve', () => {
  const { cal, g } = graphOf(SRC);
  const plan = simulateSplit(g, { effectiveFromMs: EFFECTIVE, byday: ['TH'] });
  const { calendar } = applyNaive(cal, g, plan);
  const events = independentEvents(serializeIcs(calendar));

  assert.equal(events.filter((e: any) => /MAKE-UP/.test(e.summary ?? '')).length, 0,
    'the make-up is gone');
  assert.equal(events.filter((e: any) => /Guest Lecture/.test(e.summary ?? '')).length, 0,
    'the guest lecture override is gone');

  const naiveUid = `${UID}-naive-${plan.newDtstartMs}`;
  const naiveMaster = events.find((e: any) => e.uid === naiveUid);
  assert.ok(naiveMaster);
  const naiveExpanded = expand(naiveUid, events);
  assert.ok(naiveExpanded.some((ms) => kstDate(ms) === '2026-09-24'),
    'the cancelled Chuseok week silently reappears as a normal class');
  assert.ok(naiveExpanded.some((ms) => kstDate(ms) === '2026-10-08'),
    'the October cancellation silently reappears');

  // The loss report must have predicted exactly this.
  // 2 cancellations + 2 detached overrides + 1 extra date = 5 destroyed items.
  assert.equal(plan.naiveLosses.length, 5,
    `expected 5 predicted losses, got ${plan.naiveLosses.length}`);
});

test('fail-closed: unsupported rules and impossible dates are refused', () => {
  const { g } = graphOf(SRC);

  const noFuture = simulateSplit(g, { effectiveFromMs: Date.UTC(2030, 0, 1), byday: ['TH'] });
  assert.ok(!noFuture.ok);
  assert.ok(noFuture.refusals.some((r) => r.code === 'NOTHING_AFTER_DATE'));

  const noPast = simulateSplit(g, { effectiveFromMs: Date.UTC(2026, 0, 1), byday: ['TH'] });
  assert.ok(!noPast.ok);

  const bySetPos = SRC.replace('RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261229T100000Z',
    'RRULE:FREQ=WEEKLY;BYDAY=TU;BYSETPOS=1;UNTIL=20261229T100000Z');
  const { g: g2 } = graphOf(bySetPos);
  const unsafe = simulateSplit(g2, { effectiveFromMs: EFFECTIVE, byday: ['TH'] });
  assert.ok(!unsafe.ok);
  assert.ok(unsafe.refusals.some((r) => r.code === 'UNSUPPORTED_RRULE_PART'));

  const thisAndFuture = SRC.replace('RECURRENCE-ID;TZID=Asia/Seoul:20261020T190000',
    'RECURRENCE-ID;TZID=Asia/Seoul;RANGE=THISANDFUTURE:20261020T190000');
  const { g: g3 } = graphOf(thisAndFuture);
  const tf = simulateSplit(g3, { effectiveFromMs: EFFECTIVE, byday: ['TH'] });
  assert.ok(!tf.ok);
  assert.ok(tf.refusals.some((r) => r.code === 'RANGE_THISANDFUTURE'));
});

test('round-trip is lossless for untouched events', () => {
  const cal = parseIcs(SRC);
  const again = parseIcs(serializeIcs(cal));
  assert.equal(again.children.length, cal.children.length);
  const a = cal.children.find((c) => c.name === 'VEVENT')!;
  const b = again.children.find((c) => c.name === 'VEVENT')!;
  assert.equal(b.props.length, a.props.length, 'no property is dropped by a parse/serialize cycle');
  for (let i = 0; i < a.props.length; i++) {
    assert.equal(b.props[i].name, a.props[i].name);
    assert.equal(b.props[i].value, a.props[i].value);
  }
});

/**
 * Resolve a series the way a calendar client renders it, using ical.js:
 * expand the rule, drop EXDATEs, and let related exception events replace the
 * slots they are anchored to. This is independent of SeriesSafe's own engine.
 */
function resolve(masterUid: string, all: any[]): Array<{ slotMs: number; startMs: number; isException: boolean }> {
  const master = all.find((e: any) => e.uid === masterUid && !e.isRecurrenceException());
  assert.ok(master, `master ${masterUid} not found`);
  for (const e of all) {
    if (e.uid === masterUid && e.isRecurrenceException()) master!.relateException(e);
  }
  const out: Array<{ slotMs: number; startMs: number; isException: boolean }> = [];
  const it = master!.iterator();
  const limit = Date.UTC(2027, 0, 1);
  for (let i = 0; i < 400; i++) {
    const next = it.next();
    if (!next) break;
    const slotMs = next.toJSDate().getTime();
    if (slotMs > limit) break;
    const d = master!.getOccurrenceDetails(next);
    out.push({
      slotMs,
      startMs: d.startDate.toJSDate().getTime(),
      isException: d.item !== master!.component && d.item?.uid === masterUid
        ? true
        : slotMs !== d.startDate.toJSDate().getTime(),
    });
  }
  return out;
}

/** Just the rendered start instants of a series. */
function expand(masterUid: string, all: any[]): number[] {
  return resolve(masterUid, all).map((o) => o.startMs);
}

test('end policy: moving weekday must not silently drop the final meeting', () => {
  const { cal, g } = graphOf(SRC);

  // Default policy keeps every remaining meeting; the end date moves instead.
  const keep = simulateSplit(g, { effectiveFromMs: EFFECTIVE, byday: ['TH'] });
  assert.ok(keep.ok);
  assert.equal(keep.endPolicy, 'preserve-count');
  assert.match(keep.newRuleText, /COUNT=18/);
  assert.ok(keep.endDateShifted, 'the end date moves from Tue 29 Dec to Thu 31 Dec');
  const report = validateStage(cal, applySplit(cal, g, keep).calendar, g, keep);
  assert.ok(report.pass, report.checks.filter((c) => !c.pass).map((c) => c.evidence).join('; '));
  const count = report.checks.find((c) => c.id === 'count-reconciles')!;
  assert.ok(count.pass);
  assert.match(count.evidence, /= 42; originally 42/);

  // Holding the old end date would cost a meeting, so it is refused outright.
  const hold = simulateSplit(g, {
    effectiveFromMs: EFFECTIVE, byday: ['TH'], endPolicy: 'keep-end-date',
  });
  assert.ok(!hold.ok);
  assert.ok(hold.refusals.some((r) => r.code === 'END_DATE_DROPS_MEETINGS'));
});

test('a same-weekday time change keeps the end date exactly', () => {
  const { cal, g } = graphOf(SRC);
  const plan = simulateSplit(g, { effectiveFromMs: EFFECTIVE, byday: ['TU'], timeOfDay: '20:00' });
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  assert.equal(plan.endDateShifted, false, 'staying on Tuesday leaves the final date alone');
  const report = validateStage(cal, applySplit(cal, g, plan).calendar, g, plan);
  assert.ok(report.pass, report.checks.filter((c) => !c.pass).map((c) => c.evidence).join('; '));
  const events = independentEvents(serializeIcs(applySplit(cal, g, plan).calendar));
  const moved = resolve(plan.newUid, events).filter((o) => !/2026-11-11/.test(kstDate(o.slotMs)));
  for (const o of moved) assert.equal(kstTime(o.slotMs), '20:00', 'new time applied to every slot');
});
