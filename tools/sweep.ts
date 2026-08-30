/** Sweep legitimate unbounded-series moves; none should be rejected. */
import { parseIcs, startOfDayInZone } from '../src/ics/parse.ts';
import { buildSeriesGraph } from '../src/engine/series.ts';
import { simulateSplit } from '../src/engine/split.ts';
import { applySplit } from '../src/engine/apply.ts';
import { validateStage } from '../src/engine/validate.ts';

const UID = 's@test';
const zones = ['UTC', 'Asia/Seoul', 'America/New_York', 'Australia/Sydney', 'Europe/London'];
const wksts = ['MO', 'SU', 'WE'];
const intervals = [1, 2, 3];
const froms = ['2026-07-01', '2026-10-04', '2027-01-04'];
const days: Array<[string, string]> = [['TU', 'TH'], ['MO', 'FR'], ['WE', 'SA']];

let total = 0, refused = 0, failedValidation = 0;
const problems: string[] = [];

for (const zone of zones) {
  for (const wkst of wksts) {
    for (const interval of intervals) {
      for (const from of froms) {
        for (const [oldDay, newDay] of days) {
          total++;
          const dtstart = zone === 'UTC'
            ? 'DTSTART:20260303T090000Z\r\nDTEND:20260303T100000Z'
            : `DTSTART;TZID=${zone}:20260303T090000\r\nDTEND;TZID=${zone}:20260303T100000`;
          const ics = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//s//EN','BEGIN:VEVENT',
            `UID:${UID}`,'DTSTAMP:20260101T000000Z', dtstart,
            `RRULE:FREQ=WEEKLY;INTERVAL=${interval};BYDAY=${oldDay};WKST=${wkst}`,
            'SUMMARY:S','END:VEVENT','END:VCALENDAR'].join('\r\n') + '\r\n';
          const cal = parseIcs(ics);
          const g = buildSeriesGraph(cal, UID);
          if (!g) { problems.push(`${zone}/${wkst}/${interval}/${from}: no graph`); continue; }
          const eff = startOfDayInZone(from, g.tzid)!;
          const plan = simulateSplit(g, { effectiveFromMs: eff, byday: [newDay] });
          if (!plan.ok) {
            refused++;
            if (problems.length < 6) problems.push(`REFUSED ${zone} wkst=${wkst} i=${interval} ${from} ${oldDay}->${newDay}: ${plan.refusals.map(r=>r.code).join(',')}`);
            continue;
          }
          const rep = validateStage(cal, applySplit(cal, g, plan).calendar, g, plan);
          if (!rep.pass) {
            failedValidation++;
            if (problems.length < 12) problems.push(`INVALID ${zone} wkst=${wkst} i=${interval} ${from} ${oldDay}->${newDay}: ` +
              rep.checks.filter(c=>!c.pass).map(c=>`${c.id} (${c.evidence})`).join(' | '));
          }
        }
      }
    }
  }
}
console.log(`total ${total} | refused ${refused} | validation failed ${failedValidation}`);
for (const p of problems) console.log('  ' + p);
