import { test } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';

import { parseIcs } from '../src/ics/parse.ts';
import { serializeIcs } from '../src/ics/serialize.ts';
import { buildSeriesGraph, listRecurringUids } from '../src/engine/series.ts';
import { simulateSplit } from '../src/engine/split.ts';
import { applySplit } from '../src/engine/apply.ts';
import { validateStage } from '../src/engine/validate.ts';

/** Build a calendar around one VEVENT body. */
const cal = (body: string) =>
  `BEGIN:VCALENDAR\r\nPRODID:-//test//EN\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n${body}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

function roundTrip(text: string, uid: string, params: any) {
  const c = parseIcs(text);
  const g = buildSeriesGraph(c, uid);
  assert.ok(g, 'graph builds');
  const plan = simulateSplit(g!, params);
  if (!plan.ok) return { plan, report: null, g: g! };
  const out = applySplit(c, g!, plan).calendar;
  const report = validateStage(c, out, g!, plan);
  // The output must also survive an independent parse.
  const comp = new ICAL.Component(ICAL.parse(serializeIcs(out)));
  assert.ok(comp.getAllSubcomponents('vevent').length >= 2);
  return { plan, report, g: g! };
}

test('a plain series with no exceptions splits cleanly', () => {
  const text = cal(
    [
      'UID:plain@test',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;TZID=America/New_York:20260302T090000',
      'DTEND;TZID=America/New_York:20260302T093000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261228T140000Z',
      'SUMMARY:Team standup',
    ].join('\r\n'),
  );
  const { plan, report } = roundTrip(text, 'plain@test', {
    effectiveFromMs: Date.UTC(2026, 8, 1, 4, 0, 0),
    byday: ['WE'],
  });
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  assert.equal(plan.remaps.length, 0, 'nothing to re-anchor');
  assert.equal(plan.naiveLosses.length, 0, 'and so nothing a conventional edit would lose');
  assert.ok(report!.pass, report!.checks.filter((c) => !c.pass).map((c) => c.evidence).join('; '));
});

test('an all-day series keeps DATE values and splits correctly', () => {
  const text = cal(
    [
      'UID:allday@test',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;VALUE=DATE:20260302',
      'DTEND;VALUE=DATE:20260303',
      'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=30',
      'EXDATE;VALUE=DATE:20260907',
      'SUMMARY:Bin day',
    ].join('\r\n'),
  );
  const { plan, report } = roundTrip(text, 'allday@test', {
    effectiveFromMs: Date.UTC(2026, 8, 1),
    byday: ['TU'],
  });
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  assert.equal(plan.remaps.filter((r) => r.kind === 'cancellation').length, 1);
  assert.ok(report!.pass, report!.checks.filter((c) => !c.pass).map((c) => c.evidence).join('; '));
});

test('a COUNT-based rule keeps its remaining count', () => {
  const text = cal(
    [
      'UID:counted@test',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;TZID=Europe/London:20260305T180000',
      'DTEND;TZID=Europe/London:20260305T190000',
      'RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=40',
      'SUMMARY:Choir practice',
    ].join('\r\n'),
  );
  const { plan, report } = roundTrip(text, 'counted@test', {
    effectiveFromMs: Date.UTC(2026, 8, 1),
    byday: ['FR'],
  });
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  assert.match(plan.newRuleText, /COUNT=/);
  assert.ok(report!.pass, report!.checks.filter((c) => !c.pass).map((c) => c.evidence).join('; '));
});

test('a fortnightly series preserves its phase', () => {
  const text = cal(
    [
      'UID:fortnight@test',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;TZID=Australia/Sydney:20260303T100000',
      'DTEND;TZID=Australia/Sydney:20260303T110000',
      'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20261222T230000Z',
      'SUMMARY:Fortnightly review',
    ].join('\r\n'),
  );
  const c = parseIcs(text);
  const g = buildSeriesGraph(c, 'fortnight@test')!;

  // Sydney observes DST, so a fortnight is not a constant number of UTC
  // milliseconds — that it varies by an hour is the wall clock being preserved.
  // The invariant to check is the local date and time, not the UTC delta.
  const sydney = (ms: number) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ms));
  const dayNumber = (ms: number) => Math.round(Date.parse(sydney(ms).slice(0, 10) + 'T00:00:00Z') / 86400_000);

  const gaps = g.occurrences.slice(1).map((o, i) => dayNumber(o.slotMs) - dayNumber(g.occurrences[i].slotMs));
  assert.ok(gaps.every((d) => d === 14), `every gap is 14 local days, got ${[...new Set(gaps)].join(',')}`);
  assert.equal(new Set(g.occurrences.map((o) => sydney(o.slotMs).slice(-5))).size, 1,
    'the local start time never drifts');

  const { plan, report } = roundTrip(text, 'fortnight@test', {
    effectiveFromMs: Date.UTC(2026, 8, 1),
    byday: ['TH'],
  });
  assert.ok(plan.ok, JSON.stringify(plan.refusals));
  const newGaps = plan.newSlots.slice(1).map((ms, i) => dayNumber(ms) - dayNumber(plan.newSlots[i]));
  assert.ok(newGaps.every((d) => d === 14), `the new series stays fortnightly, got ${[...new Set(newGaps)].join(',')}`);
  assert.ok(report!.pass, report!.checks.filter((c) => !c.pass).map((c) => c.evidence).join('; '));
});

test('a series crossing a DST boundary keeps its wall-clock time', () => {
  // Europe/London leaves BST on 2026-10-25.
  const text = cal(
    [
      'UID:dst@test',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;TZID=Europe/London:20260901T190000',
      'DTEND;TZID=Europe/London:20260901T200000',
      'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T190000Z',
      'SUMMARY:Evening class',
    ].join('\r\n'),
  );
  const c = parseIcs(text);
  const g = buildSeriesGraph(c, 'dst@test')!;
  const local = (ms: number) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false })
      .format(new Date(ms));
  assert.ok(g.occurrences.length > 10);
  for (const o of g.occurrences) {
    assert.equal(local(o.slotMs), '19:00', `${new Date(o.slotMs).toISOString()} should stay at 19:00 local`);
  }
  // And a genuine UTC shift occurs across the transition, proving it is not naive.
  const utcHours = new Set(g.occurrences.map((o) => new Date(o.slotMs).getUTCHours()));
  assert.equal(utcHours.size, 2, 'the UTC hour changes when BST ends');
});

test('multiple series in one file are isolated from each other', () => {
  const text =
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n' +
    'BEGIN:VEVENT\r\nUID:a@test\r\nDTSTAMP:20260101T000000Z\r\n' +
    'DTSTART;TZID=Asia/Seoul:20260303T100000\r\nDTEND;TZID=Asia/Seoul:20260303T110000\r\n' +
    'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261229T010000Z\r\nSUMMARY:Series A\r\nEND:VEVENT\r\n' +
    'BEGIN:VEVENT\r\nUID:b@test\r\nDTSTAMP:20260101T000000Z\r\n' +
    'DTSTART;TZID=Asia/Seoul:20260304T100000\r\nDTEND;TZID=Asia/Seoul:20260304T110000\r\n' +
    'RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20261230T010000Z\r\nEXDATE;TZID=Asia/Seoul:20260916T100000\r\n' +
    'SUMMARY:Series B\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

  assert.deepEqual(listRecurringUids(parseIcs(text)).sort(), ['a@test', 'b@test']);
  const { report } = roundTrip(text, 'a@test', {
    effectiveFromMs: Date.UTC(2026, 7, 31, 15),
    byday: ['TH'],
  });
  assert.ok(report!.pass);
  const blast = report!.checks.find((c) => c.id === 'blast-radius')!;
  assert.ok(blast.pass);
  assert.match(blast.evidence, /1 unrelated component\(s\) untouched/);
});

test('a malformed calendar is rejected without throwing', () => {
  for (const junk of ['', 'not a calendar at all', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n']) {
    const c = parseIcs(junk);
    assert.deepEqual(listRecurringUids(c), []);
    assert.equal(buildSeriesGraph(c, 'nope@test'), null);
  }
});
