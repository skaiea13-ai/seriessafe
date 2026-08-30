import { test } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';

import { parseIcs, startOfDayInZone } from '../src/ics/parse.ts';
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

test('the shapes real exporters emit are accepted, not refused', () => {
  /*
   * Twelve refusal codes is a lot of ways to say no, and a tool that refuses
   * ordinary calendars is no use. These are the forms Google, Outlook and
   * Apple actually write, quirks included: empty DESCRIPTION and LOCATION,
   * X-MICROSOFT-* and X-APPLE-* properties, LANGUAGE parameters, an alarm with
   * its own UID, an embedded VTIMEZONE, all-day VALUE=DATE, and an
   * open-ended rule.
   */
  const exports: Record<string, string[]> = {
    'Google (TZID and an embedded VTIMEZONE)': [
      'BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'VERSION:2.0',
      'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Work', 'X-WR-TIMEZONE:America/New_York',
      'BEGIN:VTIMEZONE', 'TZID:America/New_York',
      'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT',
      'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST',
      'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20260303T090000',
      'DTEND;TZID=America/New_York:20260303T093000', 'RRULE:FREQ=WEEKLY;BYDAY=TU',
      'DTSTAMP:20260220T041500Z', 'UID:g1@google.com', 'CREATED:20260220T041500Z',
      'DESCRIPTION:', 'LAST-MODIFIED:20260220T041500Z', 'LOCATION:', 'SEQUENCE:0',
      'STATUS:CONFIRMED', 'SUMMARY:Standup', 'TRANSP:OPAQUE', 'END:VEVENT', 'END:VCALENDAR',
    ],
    'Outlook (UTC times and X-MICROSOFT properties)': [
      'BEGIN:VCALENDAR', 'PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN', 'VERSION:2.0',
      'METHOD:PUBLISH', 'X-MS-OLK-FORCEINSPECTOROPEN:TRUE',
      'BEGIN:VEVENT', 'CLASS:PUBLIC', 'CREATED:20260220T041500Z', 'DTEND:20260303T100000Z',
      'DTSTAMP:20260220T041500Z', 'DTSTART:20260303T090000Z', 'LAST-MODIFIED:20260220T041500Z',
      'PRIORITY:5', 'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=52', 'SEQUENCE:0',
      'SUMMARY;LANGUAGE=en-gb:Team sync', 'TRANSP:OPAQUE', 'UID:o1@outlook.com',
      'X-MICROSOFT-CDO-BUSYSTATUS:BUSY', 'X-MICROSOFT-CDO-IMPORTANCE:1',
      'END:VEVENT', 'END:VCALENDAR',
    ],
    'Apple (an alarm carrying its own UID)': [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.0//EN', 'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT', 'CREATED:20260220T041500Z', 'UID:a1@apple.com',
      'DTEND;TZID=Europe/London:20260303T100000', 'TRANSP:OPAQUE',
      'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC', 'SUMMARY:Gym',
      'DTSTART;TZID=Europe/London:20260303T090000', 'DTSTAMP:20260220T041500Z', 'SEQUENCE:0',
      'RRULE:FREQ=WEEKLY;BYDAY=TU;INTERVAL=1',
      'BEGIN:VALARM', 'X-WR-ALARMUID:x1', 'UID:x1', 'TRIGGER:-PT15M',
      'DESCRIPTION:Event reminder', 'ACTION:DISPLAY', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR',
    ],
    'Google (all-day with a VALUE=DATE exception)': [
      'BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'VERSION:2.0',
      'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20260302', 'DTEND;VALUE=DATE:20260303',
      'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;VALUE=DATE:20260907', 'DTSTAMP:20260220T041500Z',
      'UID:g2@google.com', 'SUMMARY:Bin day', 'TRANSP:TRANSPARENT', 'END:VEVENT', 'END:VCALENDAR',
    ],
  };

  for (const [label, lines] of Object.entries(exports)) {
    const text = lines.join('\r\n') + '\r\n';
    const c = parseIcs(text);
    const uids = listRecurringUids(c);
    assert.equal(uids.length, 1, `${label}: one recurring series`);
    const g = buildSeriesGraph(c, uids[0]);
    assert.ok(g, `${label}: the graph builds`);

    const plan = simulateSplit(g!, {
      effectiveFromMs: startOfDayInZone('2026-09-01', g!.tzid)!,
      byday: ['TH'],
    });
    assert.ok(plan.ok, `${label} was refused: ${plan.refusals.map((r) => r.code).join(', ')}`);

    const report = validateStage(c, applySplit(c, g!, plan).calendar, g!, plan);
    assert.ok(report.pass,
      `${label} failed validation: ${report.checks.filter((x) => !x.pass).map((x) => x.evidence).join('; ')}`);
  }
});
