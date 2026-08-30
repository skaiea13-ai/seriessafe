import { test } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';

import { parseIcs, zonedToUtc, startOfDayInZone, parseDateTime } from '../src/ics/parse.ts';
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
 * every invariant reported success.
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
  // one and dropped every occurrence beyond it, with every check green.
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

/* ---- second review round ------------------------------------------ */

test('a date boundary is resolved in the series zone, across a DST change', () => {
  // Australia/Sydney moves to daylight time on 2026-10-04. Deriving midnight
  // from a single offset lookup landed an hour early, pulling the previous
  // evening's meeting into the future half of the split.
  const midnight = startOfDayInZone('2026-10-04', 'Australia/Sydney')!;
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(midnight));
  assert.equal(local, '00:00', `the day must begin at midnight locally, got ${local}`);

  const ics = wrap(['DTSTART;TZID=Australia/Sydney:20260303T233000',
                    'DTEND;TZID=Australia/Sydney:20260304T003000',
                    'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261229T120000Z'].join('\r\n'));
  const g = buildSeriesGraph(parseIcs(ics), UID)!;
  const plan = simulateSplit(g, { effectiveFromMs: midnight, byday: ['TH'] });
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  const strays = plan.pastOccurrences.filter((o) => o.slotMs >= midnight);
  assert.equal(strays.length, 0, 'nothing before the boundary is treated as after it');
});

test('a rule SeriesSafe would not accept is not one it will write', () => {
  // Adding BYDAY to a DAILY series produced FREQ=DAILY;BYDAY=TH, expanded here
  // as consecutive days and read by everyone else as Thursdays.
  const ics = wrap(['DTSTART:20260302T090000Z', 'DTEND:20260302T100000Z',
                    'RRULE:FREQ=DAILY;COUNT=30'].join('\r\n'));
  const { plan } = attempt(ics, Date.UTC(2026, 2, 9), ['TH']);
  assert.ok(!plan.ok);
  assert.ok(codes(plan).includes('UNSUPPORTED_RESULT_RULE'), codes(plan).join(','));
});

test('date values that cannot be read stop the operation', () => {
  // RDATE;VALUE=PERIOD was skipped by the parser, so the writer dropped it.
  const ics = wrap(['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z',
                    'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=40',
                    'RDATE;VALUE=PERIOD:20261014T090000Z/PT2H'].join('\r\n'));
  const g = buildSeriesGraph(parseIcs(ics), UID)!;
  assert.ok(g.unreadableDates.some((d) => /PERIOD/.test(d)), 'the parser reports it');
  const { plan } = attempt(ics, Date.UTC(2026, 8, 1), ['TH']);
  assert.ok(!plan.ok);
  assert.ok(codes(plan).includes('UNREADABLE_DATE_VALUE'), codes(plan).join(','));
});

test('an unresolvable zone is caught on any date property, not just DTSTART', () => {
  const ics = wrap(['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z',
                    'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=40',
                    'EXDATE;TZID=Custom/Seoul:20260505T180000'].join('\r\n'));
  const g = buildSeriesGraph(parseIcs(ics), UID)!;
  assert.equal(g.timeZoneUnresolved, 'Custom/Seoul');
  const { plan } = attempt(ics, Date.UTC(2026, 8, 1), ['TH']);
  assert.ok(!plan.ok);
  assert.ok(codes(plan).includes('UNRESOLVED_TIME_ZONE'), codes(plan).join(','));
});

test('an occurrence called off by STATUS keeps what was attached to it', () => {
  // Converting it to a bare EXDATE dropped the note and the reminder, and left
  // the original event stranded on the series being truncated.
  const ics = wrap(
    ['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=40'].join('\r\n'),
    ['BEGIN:VEVENT', `UID:${UID}`, 'DTSTAMP:20260901T000000Z',
     'DTSTART:20260915T090000Z', 'DTEND:20260915T100000Z', 'RECURRENCE-ID:20260915T090000Z',
     'STATUS:CANCELLED', 'SUMMARY:X', 'COMMENT:Called off, room flooded',
     'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:n/a', 'TRIGGER:-PT30M', 'END:VALARM',
     'END:VEVENT'].join('\r\n'),
  );
  const { plan, out, report } = attempt(ics, Date.UTC(2026, 8, 1), ['TH']);
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  assert.ok(report!.pass, report!.checks.filter((c) => !c.pass).map((c) => c.evidence).join('; '));
  assert.match(out, /Called off, room flooded/, 'the note survives');
  assert.match(out, /BEGIN:VALARM/, 'the reminder survives');
  assert.doesNotMatch(out, /RECURRENCE-ID:20260915T090000Z/, 'and it is not left on the old series');
});

test('an all-day series refuses a start time rather than ignoring it', () => {
  const ics = wrap(['DTSTART;VALUE=DATE:20260302', 'DTEND;VALUE=DATE:20260303',
                    'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=30'].join('\r\n'));
  const { plan } = attempt(ics, Date.UTC(2026, 8, 1), ['TU'], { timeOfDay: '09:00' });
  assert.ok(!plan.ok);
  assert.ok(codes(plan).includes('TIME_ON_ALL_DAY_SERIES'), codes(plan).join(','));
});

test('the comparison looks only at the series being changed', () => {
  // Searching the whole file let an unrelated event sharing an instant make a
  // destroyed item look preserved.
  const ics =
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\n' +
    `BEGIN:VEVENT\r\nUID:${UID}\r\nDTSTAMP:20260101T000000Z\r\n` +
    'DTSTART:20260303T090000Z\r\nDTEND:20260303T100000Z\r\n' +
    'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261229T090000Z\r\n' +
    'RDATE:20261111T090000Z\r\nSUMMARY:X\r\nEND:VEVENT\r\n' +
    // An unrelated series that happens to meet at the very same instant.
    'BEGIN:VEVENT\r\nUID:other@test\r\nDTSTAMP:20260101T000000Z\r\n' +
    'DTSTART:20261111T090000Z\r\nDTEND:20261111T100000Z\r\n' +
    'RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=3\r\nSUMMARY:X\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const cal = parseIcs(ics);
  const g = buildSeriesGraph(cal, UID)!;
  const plan = simulateSplit(g, { effectiveFromMs: Date.UTC(2026, 8, 1), byday: ['TH'] });
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  const cmp = compareResults(g, plan, applySplit(cal, g, plan).calendar, applyNaive(cal, g, plan).calendar);
  const added = cmp.items.find((i) => i.what === 'Added session')!;
  assert.ok(added, 'the added session is compared');
  assert.equal(added.inSeriesSafe, true);
  assert.equal(added.inConventional, false, 'the unrelated series must not stand in for it');
});

test('a series of exactly the modelling limit is not called too large', () => {
  const ics = wrap(['DTSTART:20260101T090000Z', 'DTEND:20260101T100000Z',
                    'RRULE:FREQ=DAILY;COUNT=20000'].join('\r\n'));
  const g = buildSeriesGraph(parseIcs(ics), UID)!;
  assert.equal(g.occurrences.length, 20000);
  assert.equal(g.truncated, false, 'exactly at the limit is complete, not overflowing');
});

test('an endless series is checked against the file, not against the plan', () => {
  // The unbounded check asked whether SeriesSafe *intended* to keep the series
  // open, reading plan.newRuleText. A COUNT added to the rule actually written
  // out therefore passed — the exact mistake this validation stage exists to
  // avoid, since it is supposed to read the serialized bytes.
  const ics = wrap(['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z',
                    'RRULE:FREQ=WEEKLY;BYDAY=TU'].join('\r\n'));
  const cal = parseIcs(ics);
  const g = buildSeriesGraph(cal, UID)!;
  assert.equal(g.unbounded, true);
  const plan = simulateSplit(g, { effectiveFromMs: Date.UTC(2026, 8, 1), byday: ['TH'] });
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  assert.ok(validateStage(cal, applySplit(cal, g, plan).calendar, g, plan).pass, 'the honest result passes');

  const tampered = applySplit(cal, g, plan).calendar;
  const master = tampered.children.find(
    (c) => c.name === 'VEVENT' && getProp(c, 'UID')?.value === plan.newUid && !getProp(c, 'RECURRENCE-ID'),
  )!;
  const rrule = master.props.find((p) => p.name === 'RRULE')!;
  rrule.value += ';COUNT=5';

  const report = validateStage(cal, tampered, g, plan);
  assert.ok(!report.pass, 'a standing meeting turned into five must fail');
  const check = report.checks.find((c) => c.id === 'count-reconciles')!;
  assert.match(check.evidence, /the rule written out does/);
});

test('an exception years beyond any window is still carried', () => {
  const ics = wrap(['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z',
                    'RRULE:FREQ=WEEKLY;BYDAY=TU', 'EXDATE:20310909T090000Z'].join('\r\n'));
  const { plan, out, report } = attempt(ics, Date.UTC(2026, 8, 1), ['TH']);
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  assert.ok(report!.pass, report!.checks.filter((c) => !c.pass).map((c) => c.evidence).join('; '));
  const carried = plan.remaps.find((r) => r.oldSlotMs === Date.UTC(2031, 8, 9, 9));
  assert.ok(carried, 'the 2031 cancellation is carried');
  assert.match(out, /20310911T090000Z/, 'onto the Thursday of its own week');
});

/* ---- third review round -------------------------------------------- */

test('a rule that changed shape in the file is caught', () => {
  // Rewriting an open-ended weekly rule as monthly produced far fewer
  // meetings, and the equal-length prefix comparison simply shortened with it.
  const ics = wrap(['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z',
                    'RRULE:FREQ=WEEKLY;BYDAY=TU'].join('\r\n'));
  const cal = parseIcs(ics);
  const g = buildSeriesGraph(cal, UID)!;
  const plan = simulateSplit(g, { effectiveFromMs: Date.UTC(2026, 8, 1), byday: ['TH'] });
  assert.ok(plan.ok, JSON.stringify(plan.refusals));

  const tampered = applySplit(cal, g, plan).calendar;
  const master = tampered.children.find(
    (c) => c.name === 'VEVENT' && getProp(c, 'UID')?.value === plan.newUid && !getProp(c, 'RECURRENCE-ID'),
  )!;
  master.props.find((p) => p.name === 'RRULE')!.value = 'FREQ=MONTHLY;BYMONTHDAY=3';

  const report = validateStage(cal, tampered, g, plan);
  assert.ok(!report.pass, 'a weekly series turned monthly must fail');
  const check = report.checks.find((c) => c.id === 'rule-as-planned')!;
  assert.ok(!check.pass);
  assert.match(check.evidence, /Planned .*wrote/);
});

test('a slot cancelled twice over keeps its override', () => {
  // An EXDATE and a STATUS:CANCELLED override on the same slot: the EXDATE
  // branch discarded the override, which stayed behind on the truncated
  // series along with its note and its reminder.
  const ics = wrap(
    ['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TU',
     'EXDATE:20260915T090000Z'].join('\r\n'),
    ['BEGIN:VEVENT', `UID:${UID}`, 'DTSTAMP:20260901T000000Z',
     'DTSTART:20260915T090000Z', 'DTEND:20260915T100000Z', 'RECURRENCE-ID:20260915T090000Z',
     'STATUS:CANCELLED', 'SUMMARY:X', 'COMMENT:Called off twice over',
     'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:n/a', 'TRIGGER:-PT30M', 'END:VALARM',
     'END:VEVENT'].join('\r\n'),
  );
  const g = buildSeriesGraph(parseIcs(ics), UID)!;
  const occ = g.occurrences.find((o) => o.slotMs === Date.UTC(2026, 8, 15, 9))!;
  assert.equal(occ.kind, 'cancelled');
  assert.ok(occ.override, 'the override is not discarded by the EXDATE branch');

  const { plan, out, report } = attempt(ics, Date.UTC(2026, 8, 1), ['TH']);
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  assert.ok(report!.pass, report!.checks.filter((c) => !c.pass).map((c) => c.evidence).join('; '));
  assert.match(out, /Called off twice over/, 'the note survives');
  assert.doesNotMatch(out, /RECURRENCE-ID:20260915T090000Z/, 'and nothing is stranded');
});

test('extra parameters on date properties are kept', () => {
  const ics = wrap(['DTSTART;X-ORIGIN=import:20260303T090000Z',
                    'DTEND;X-END-META=y:20260303T100000Z',
                    'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=40',
                    'EXDATE;X-CANCEL-REASON=holiday:20260922T090000Z'].join('\r\n'));
  const { plan, out } = attempt(ics, Date.UTC(2026, 8, 1), ['TH']);
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  assert.match(out, /X-ORIGIN=import/, 'DTSTART keeps its extra parameter');
  assert.match(out, /X-END-META=y/, 'DTEND keeps its extra parameter');
  assert.match(out, /X-CANCEL-REASON=holiday/, 'EXDATE keeps its extra parameter');
});

test('a date that cannot exist is not quietly corrected', () => {
  // Date.UTC rolls 30 February forward to 2 March without complaint, so a
  // nonsense value was read as a plausible one and written back as a
  // different day.
  assert.equal(parseDateTime('20260230T090000Z'), null, '30 February is not a date');
  assert.equal(parseDateTime('20261301T090000Z'), null, 'month 13 is not a date');
  assert.equal(parseDateTime('20260101T250000Z'), null, 'hour 25 is not a time');
  assert.equal(parseDateTime('20260229T090000Z'), null, '2026 is not a leap year, so 29 February is not a date');
  assert.ok(parseDateTime('20280229T090000Z'), 'but 2028 is, so it is');

  // Rejecting malformed dates must not reject legal ones. RFC 5545 allows a
  // leap second, which JavaScript rolls into the next minute; it is clamped
  // rather than thrown out.
  const leap = parseDateTime('20260630T235960Z');
  assert.ok(leap, 'a leap second is a legal value');
  assert.equal(new Date(leap!.ms).getUTCDate(), 30, 'and stays on its own day');
  assert.ok(parseDateTime('20260101'), 'a plain DATE is still read');

  const ics = wrap(['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z',
                    'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=40',
                    'EXDATE:20260230T090000Z'].join('\r\n'));
  const g = buildSeriesGraph(parseIcs(ics), UID)!;
  assert.ok(g.unreadableDates.some((d) => /20260230/.test(d)), 'it is reported as unreadable');
  const { plan } = attempt(ics, Date.UTC(2026, 8, 1), ['TH']);
  assert.ok(!plan.ok);
  assert.ok(codes(plan).includes('UNREADABLE_DATE_VALUE'), codes(plan).join(','));
});

/* ---- fourth review round ------------------------------------------- */

test('a slot cancelled by both an EXDATE and an override keeps both', () => {
  // Collapsing the two into a single override remap dropped the EXDATE line
  // and the parameters riding on it.
  const ics = wrap(
    ['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=40',
     'EXDATE;X-CANCEL-SOURCE=registrar:20260915T090000Z'].join('\r\n'),
    ['BEGIN:VEVENT', `UID:${UID}`, 'DTSTAMP:20260901T000000Z',
     'DTSTART:20260915T090000Z', 'DTEND:20260915T100000Z', 'RECURRENCE-ID:20260915T090000Z',
     'STATUS:CANCELLED', 'SUMMARY:X', 'COMMENT:Called off by the registrar', 'END:VEVENT'].join('\r\n'),
  );
  const { plan, out, report } = attempt(ics, Date.UTC(2026, 8, 1), ['TH']);
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  assert.ok(report!.pass, report!.checks.filter((c) => !c.pass).map((c) => c.evidence).join('; '));
  assert.match(out, /Called off by the registrar/, 'the override survives');
  assert.match(out, /X-CANCEL-SOURCE=registrar/, 'and so does the EXDATE parameter');
});

test('date values on different properties keep their own parameters', () => {
  // Flattening every value into one property applied the first parameter set
  // to all of them.
  const ics = wrap(['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z',
                    'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=60',
                    'EXDATE;X-WHY=past:20260505T090000Z',
                    'EXDATE;X-WHY=future:20260922T090000Z'].join('\r\n'));
  const { plan, out } = attempt(ics, Date.UTC(2026, 8, 1), ['TH']);
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  assert.match(out, /X-WHY=past/, 'the earlier reason survives');
  assert.match(out, /X-WHY=future/, 'and so does the later one');
});

test('an unreadable DTEND or UNTIL stops the operation', () => {
  // An unreadable DTEND produced a zero-length event; an unreadable UNTIL
  // turned a bounded series endless. Both passed every check.
  const badEnd = wrap(['DTSTART:20260303T090000Z', 'DTEND:20260230T100000Z',
                       'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=40'].join('\r\n'));
  const g1 = buildSeriesGraph(parseIcs(badEnd), UID)!;
  assert.ok(g1.unreadableDates.some((d) => /DTEND/.test(d)));
  assert.ok(!attempt(badEnd, Date.UTC(2026, 8, 1), ['TH']).plan.ok);

  const badUntil = wrap(['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z',
                         'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260230T090000Z'].join('\r\n'));
  const g2 = buildSeriesGraph(parseIcs(badUntil), UID)!;
  assert.ok(g2.unreadableDates.some((d) => /UNTIL/.test(d)), 'the bad UNTIL is reported');
  const p2 = attempt(badUntil, Date.UTC(2026, 8, 1), ['TH']).plan;
  assert.ok(!p2.ok);
  assert.ok(codes(p2).includes('UNREADABLE_DATE_VALUE'), codes(p2).join(','));
});

test('a four-digit year below 0100 is not shifted into the 1900s', () => {
  // Date.UTC maps years 0-99 onto 1900-1999; RFC 5545 writes four digits.
  const early = parseDateTime('00960229');
  assert.ok(early, 'year 0096 is a legal value');
  assert.equal(new Date(early!.ms).getUTCFullYear(), 96);
});

test('the comparison distinguishes two overrides that look alike', () => {
  // A past override deliberately sharing a summary and start with a future one
  // was accepted as its replacement.
  const ics = wrap(
    ['DTSTART:20260303T090000Z', 'DTEND:20260303T100000Z',
     'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261229T090000Z'].join('\r\n'),
    [['BEGIN:VEVENT', `UID:${UID}`, 'DTSTAMP:20260401T000000Z',
      'DTSTART:20260407T110000Z', 'DTEND:20260407T120000Z', 'RECURRENCE-ID:20260407T090000Z',
      'SUMMARY:Twin', 'X-MARKER:PAST', 'END:VEVENT'].join('\r\n'),
     ['BEGIN:VEVENT', `UID:${UID}`, 'DTSTAMP:20260901T000000Z',
      'DTSTART:20260407T110000Z', 'DTEND:20260407T120000Z', 'RECURRENCE-ID:20260915T090000Z',
      'SUMMARY:Twin', 'X-MARKER:FUTURE', 'END:VEVENT'].join('\r\n')].join('\r\n'),
  );
  const cal = parseIcs(ics);
  const g = buildSeriesGraph(cal, UID)!;
  const plan = simulateSplit(g, { effectiveFromMs: Date.UTC(2026, 8, 1), byday: ['TH'] });
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  const cmp = compareResults(g, plan, applySplit(cal, g, plan).calendar, applyNaive(cal, g, plan).calendar);
  const custom = cmp.items.find((i) => i.what === 'Customised meeting')!;
  assert.ok(custom, 'the future override is compared');
  assert.equal(custom.inSeriesSafe, true, 'SeriesSafe keeps it');
  assert.equal(custom.inConventional, false, 'and its past twin must not stand in for it');
});
