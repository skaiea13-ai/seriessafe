import { test } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';

import { parseIcs, zonedToUtc } from '../src/ics/parse.ts';
import { serializeIcs } from '../src/ics/serialize.ts';
import { getProp } from '../src/ics/types.ts';
import { buildSeriesGraph } from '../src/engine/series.ts';
import { simulateSplit } from '../src/engine/split.ts';
import { applySplit, applyNaive } from '../src/engine/apply.ts';
import { validateStage } from '../src/engine/validate.ts';
import { expandRRule, parseRRule } from '../src/engine/rrule.ts';
import { compareResults } from '../src/engine/compare.ts';
import { readFileSync } from 'node:fs';

/**
 * Regressions from an adversarial cross-validation pass.
 *
 * Every case here once produced a wrong result — or lost data outright — while
 * all eight invariants reported success.
 */

const UID = 'x@test';
const wrap = (body: string, extra = '') =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//EN', 'BEGIN:VEVENT', `UID:${UID}`,
   'DTSTAMP:20260101T000000Z', body, 'SUMMARY:X', 'END:VEVENT', extra, 'END:VCALENDAR']
    .filter(Boolean).join('\r\n') + '\r\n';

function attempt(ics: string, eff: number, byday: string[], extra: Record<string, unknown> = {}) {
  const cal = parseIcs(ics);
  const g = buildSeriesGraph(cal, UID)!;
  assert.ok(g, 'graph builds');
  const plan = simulateSplit(g, { effectiveFromMs: eff, byday, ...extra });
  if (!plan.ok) return { g, plan, out: '', report: null };
  const patched = applySplit(cal, g, plan).calendar;
  return { g, plan, out: serializeIcs(patched), report: validateStage(cal, patched, g, plan) };
}
const codes = (p: { refusals: Array<{ code: string }> }) => p.refusals.map((r) => r.code);

test('a long series is expanded to its real end, not a fixed horizon', () => {
  // A three-year modelling window rewrote a five-year series as a short finite
  // one and dropped every occurrence beyond it, with all eight checks green.
  const ics = wrap([
    'DTSTART:20260105T090000Z', 'DTEND:20260105T100000Z',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20301230T090000Z',
    'EXDATE:20300107T090000Z',
  ].join('\r\n'));

  const truth = expandRRule(
    Date.UTC(2026, 0, 5, 9),
    parseRRule('FREQ=WEEKLY;BYDAY=MO;UNTIL=20301230T090000Z'),
    undefined,
    { maxMs: Date.UTC(2031, 0, 1), limit: 5000 },
  ).length;
  assert.ok(truth > 250, 'the fixture really is long');

  const { g, plan, out, report } = attempt(ics, Date.UTC(2026, 6, 1), ['TU']);
  assert.equal(g.occurrences.length, truth, 'every occurrence is modelled');
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  assert.ok(report!.pass, report!.checks.filter((c) => !c.pass).map((c) => c.evidence).join('; '));

  // The 2030 cancellation is four years past the effective date. It must be
  // carried across — onto the Tuesday of its own week, since the series moves
  // from Mondays to Tuesdays. The old horizon dropped it entirely.
  const carried = plan.remaps.find((r) => r.oldSlotMs === Date.UTC(2030, 0, 7, 9));
  assert.ok(carried, 'the 2030 cancellation is in the plan');
  assert.equal(carried!.kind, 'cancellation');
  assert.equal(new Date(carried!.newSlotMs).toISOString(), '2030-01-08T09:00:00.000Z');
  assert.match(out, /20300108T090000Z/, 'and reaches the file');
});

test('a series with no end keeps no end', () => {
  // preserve-count wrote a COUNT onto an open-ended rule, quietly turning a
  // standing meeting into a finite run.
  const ics = wrap(['DTSTART:20260105T090000Z', 'DTEND:20260105T100000Z',
                    'RRULE:FREQ=WEEKLY;BYDAY=MO'].join('\r\n'));
  const { g, plan } = attempt(ics, Date.UTC(2026, 6, 1), ['TU']);
  assert.equal(g.unbounded, true);
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  assert.doesNotMatch(plan.newRuleText, /COUNT=/, 'no COUNT is invented');
  assert.doesNotMatch(plan.newRuleText, /UNTIL=/, 'no UNTIL is invented');
});

test('value types survive: UTC keeps its Z, all-day stays a DATE', () => {
  // Re-emitting a UTC DTSTART without its Z turns it into floating local time,
  // moving the event for every viewer outside the writer's zone.
  const utc = wrap(['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z',
                    'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=40'].join('\r\n'));
  const u = attempt(utc, Date.UTC(2026, 8, 1), ['TH']);
  assert.ok(u.plan.ok);
  assert.doesNotMatch(u.out, /^DTSTART:\d{8}T\d{6}$/m, 'no DTSTART lost its Z');
  assert.match(u.out, /^DTSTART:20260903T090000Z$/m);
  assert.ok(u.report!.pass);

  const allDay = wrap(['DTSTART;VALUE=DATE:20260302', 'DTEND;VALUE=DATE:20260303',
                       'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=30',
                       'EXDATE;VALUE=DATE:20260907'].join('\r\n'));
  const a = attempt(allDay, Date.UTC(2026, 8, 1), ['TU']);
  assert.ok(a.plan.ok, JSON.stringify(a.plan.refusals));
  assert.match(a.out, /EXDATE;VALUE=DATE:/, 'date lists keep VALUE=DATE');
  assert.doesNotMatch(a.plan.untilRaw, /T\d{6}Z?$/, `UNTIL must stay a DATE, got ${a.plan.untilRaw}`);
  assert.ok(a.report!.pass, a.report!.checks.filter((c) => !c.pass).map((c) => c.evidence).join('; '));
});

test('an RDATE the rule already produces is not an added date', () => {
  // Marking it "extra" pulled a real pattern slot out of the pattern, shifting
  // every later exception by a position.
  const ics = wrap(['DTSTART:20260302T090000Z', 'DTEND:20260302T100000Z',
                    'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10',
                    'RDATE:20260316T090000Z'].join('\r\n'));
  const g = buildSeriesGraph(parseIcs(ics), UID)!;
  const dup = g.occurrences.find((o) => o.slotMs === Date.UTC(2026, 2, 16, 9))!;
  assert.equal(dup.kind, 'normal', 'a coinciding RDATE is just the pattern slot');
  assert.equal(g.occurrences.filter((o) => o.slotMs === dup.slotMs).length, 1, 'and appears once');
});

test('rules this engine cannot expand exactly are refused', () => {
  // MONTHLY;BYDAY=1MO produced the first of every month instead of the first
  // Monday, was not flagged, and the split was approved.
  const rule = 'FREQ=MONTHLY;BYDAY=1MO;COUNT=6';
  assert.ok(Object.keys(parseRRule(rule).unsupported).includes('BYDAY'), 'flagged as unsupported');

  const ics = wrap(['DTSTART:20260601T090000Z', 'DTEND:20260601T100000Z', `RRULE:${rule}`].join('\r\n'));
  const { plan } = attempt(ics, Date.UTC(2026, 7, 1), ['TU']);
  assert.ok(!plan.ok);
  assert.ok(codes(plan).includes('UNSUPPORTED_RRULE_PART'), codes(plan).join(','));

  // The weekly surface this engine does implement still agrees with ical.js.
  const weekly = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=12';
  const mine = expandRRule(Date.UTC(2026, 5, 2, 9), parseRRule(weekly), undefined, { limit: 50 })
    .map((m) => new Date(m).toISOString().slice(0, 10));
  const comp = new ICAL.Component(ICAL.parse(
    wrap(['DTSTART:20260602T090000Z', 'DTEND:20260602T100000Z', `RRULE:${weekly}`].join('\r\n')),
  ));
  const ev = new ICAL.Event(comp.getAllSubcomponents('vevent')[0]);
  const theirs: string[] = [];
  const it = ev.iterator();
  for (let i = 0; i < 12; i++) { const n = it.next(); if (!n) break; theirs.push(n.toJSDate().toISOString().slice(0, 10)); }
  assert.deepEqual(mine, theirs, 'weekly expansion matches an independent parser');
});

test('an exception is carried to the same week, or the change is refused', () => {
  // Position alone only preserves the week while every week has the same
  // number of slots on both sides. Moving Tue/Thu to Mon/Wed from a Tuesday
  // put a Thursday cancellation on the following Monday.
  const ics = wrap(['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z',
                    'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261231T090000Z',
                    'EXDATE:20260903T090000Z'].join('\r\n'));
  const { plan } = attempt(ics, Date.UTC(2026, 8, 1), ['MO', 'WE']);
  assert.ok(!plan.ok, 'the ambiguous boundary week is refused');
  assert.ok(codes(plan).includes('WEEK_NOT_ALIGNED'), codes(plan).join(','));

  // Starting the change at the top of a week lines up, and is allowed.
  const clean = attempt(ics, Date.UTC(2026, 8, 7), ['MO', 'WE']);
  assert.ok(clean.plan.ok, JSON.stringify(clean.plan.refusals));
  assert.ok(clean.report!.pass);
});

test('a changed reminder or a stripped attendee parameter is caught', () => {
  // The fingerprint compared NAME=value and an alarm *count*, so retiming a
  // reminder or stripping CN/ROLE/PARTSTAT passed as "byte-for-byte".
  const ics = wrap([
    'DTSTART;TZID=Asia/Seoul:20260303T190000', 'DTEND;TZID=Asia/Seoul:20260303T210000',
    'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261229T100000Z',
    'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Mina:mailto:mina@example.com',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Soon', 'TRIGGER:-PT30M', 'END:VALARM',
  ].join('\r\n'));
  const cal = parseIcs(ics);
  const g = buildSeriesGraph(cal, UID)!;
  const plan = simulateSplit(g, { effectiveFromMs: Date.UTC(2026, 7, 31, 15), byday: ['TH'] });
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  assert.ok(validateStage(cal, applySplit(cal, g, plan).calendar, g, plan).pass, 'the honest result passes');

  const newMasterOf = (c: ReturnType<typeof applySplit>['calendar']) =>
    c.children.find((e) => e.name === 'VEVENT' && getProp(e, 'UID')?.value === plan.newUid && !getProp(e, 'RECURRENCE-ID'))!;

  const retimed = applySplit(cal, g, plan).calendar;
  const alarm = newMasterOf(retimed).children.find((c) => c.name === 'VALARM')!;
  alarm.props.find((p) => p.name === 'TRIGGER')!.value = '-PT5M';
  assert.ok(!validateStage(cal, retimed, g, plan).pass, 'a retimed reminder must fail');

  const stripped = applySplit(cal, g, plan).calendar;
  newMasterOf(stripped).props.find((p) => p.name === 'ATTENDEE')!.params = [];
  assert.ok(!validateStage(cal, stripped, g, plan).pass, 'a stripped attendee parameter must fail');
});

test('an occurrence cancelled by STATUS is not counted as a meeting', () => {
  const ics = wrap(
    ['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6'].join('\r\n'),
    ['BEGIN:VEVENT', `UID:${UID}`, 'DTSTAMP:20260101T000000Z',
     'DTSTART:20260317T090000Z', 'DTEND:20260317T100000Z',
     'RECURRENCE-ID:20260317T090000Z', 'STATUS:CANCELLED', 'SUMMARY:X', 'END:VEVENT'].join('\r\n'),
  );
  const g = buildSeriesGraph(parseIcs(ics), UID)!;
  const occ = g.occurrences.find((o) => o.slotMs === Date.UTC(2026, 2, 17, 9))!;
  assert.equal(occ.kind, 'cancelled', 'STATUS:CANCELLED means cancelled');
  assert.equal(g.occurrences.filter((o) => o.kind !== 'cancelled').length, 5, '5 real meetings, not 6');
});

test('a time that never existed resolves forward, not backward', () => {
  // America/New_York skips 02:00-03:00 on 2026-03-08. A single fixed-point
  // pass resolved 02:30 to 01:30, an hour earlier than the wall clock asked.
  const gap = zonedToUtc(2026, 2, 8, 2, 30, 0, 'America/New_York');
  const back = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(gap));
  assert.equal(back, '03:30', `a gap time must move forward, got ${back}`);

  // The ambiguous autumn hour takes the first occurrence.
  const fold = zonedToUtc(2026, 10, 1, 1, 30, 0, 'America/New_York');
  assert.equal(new Date(fold).toISOString(), '2026-11-01T05:30:00.000Z');
});

test('a time zone this browser cannot resolve is refused', () => {
  const ics = wrap(['DTSTART;TZID=Custom/Nowhere:20260303T190000',
                    'DTEND;TZID=Custom/Nowhere:20260303T210000',
                    'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=30'].join('\r\n'));
  const { g, plan } = attempt(ics, Date.UTC(2026, 8, 1), ['TH']);
  assert.equal(g.timeZoneUnresolved, 'Custom/Nowhere');
  assert.ok(!plan.ok);
  assert.ok(codes(plan).includes('UNRESOLVED_TIME_ZONE'), codes(plan).join(','));
});

test('an unreadable time of day is refused rather than ignored', () => {
  const ics = wrap(['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z',
                    'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=40'].join('\r\n'));
  const { plan } = attempt(ics, Date.UTC(2026, 8, 1), ['TH'], { timeOfDay: '99:99' });
  assert.ok(!plan.ok);
  assert.ok(codes(plan).includes('INVALID_TIME_OF_DAY'), codes(plan).join(','));
});

test('the conventional-edit control keeps what that edit would keep', () => {
  // applyNaive dropped every RDATE, including ones before the split, which
  // overstated the loss it is meant to model honestly.
  const ics = wrap(['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z',
                    'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261229T090000Z',
                    'RDATE:20260415T090000Z,20261111T090000Z'].join('\r\n'));
  const cal = parseIcs(ics);
  const g = buildSeriesGraph(cal, UID)!;
  const plan = simulateSplit(g, { effectiveFromMs: Date.UTC(2026, 8, 1), byday: ['TH'] });
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  const naive = serializeIcs(applyNaive(cal, g, plan).calendar);
  assert.match(naive, /20260415T090000Z/, 'the April addition predates the split and survives');
  assert.doesNotMatch(naive, /20261111T090000Z/, 'the November one goes with the old series');
});

test('the side-by-side result is measured from both calendars, not predicted', () => {
  // The comparison used to replay the plan's own arrays, so the headline
  // number was an assertion about what would happen rather than a reading of
  // what did.
  const src = readFileSync(new URL('../fixtures/korean-class.ics', import.meta.url), 'utf8');
  const cal = parseIcs(src);
  const uid = 'advanced-korean-tue@school.example.com';
  const g = buildSeriesGraph(cal, uid)!;
  const plan = simulateSplit(g, { effectiveFromMs: Date.UTC(2026, 7, 31, 15), byday: ['TH'] });
  assert.ok(plan.ok, JSON.stringify(plan.refusals));

  const safe = applySplit(cal, g, plan).calendar;
  const naive = applyNaive(cal, g, plan).calendar;
  const cmp = compareResults(g, plan, safe, naive);

  assert.equal(cmp.items.length, 5, 'five customised occurrences are at stake');
  assert.equal(cmp.preserved, 5, 'all five survive the SeriesSafe result');
  assert.equal(cmp.destroyed, 5, 'none survive the conventional one');
  for (const item of cmp.items) {
    assert.equal(item.inSeriesSafe, true, `${item.what} ${item.when} should survive`);
    assert.equal(item.inConventional, false, `${item.what} ${item.when} should be lost`);
  }
});
