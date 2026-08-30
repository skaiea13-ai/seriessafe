import { type Component, getProp } from '../ics/types.ts';
import { parseIcs } from '../ics/parse.ts';
import { serializeIcs } from '../ics/serialize.ts';
import { buildSeriesGraph, type SeriesGraph } from './series.ts';
import { formatHuman, type SplitPlan } from './split.ts';

export interface ComparedItem {
  what: string;
  when: string;
  /** Present and intact in the result SeriesSafe produced. */
  inSeriesSafe: boolean;
  /** Present and intact in the conventional-edit result. */
  inConventional: boolean;
  detail: string;
}

export interface Comparison {
  items: ComparedItem[];
  preserved: number;
  destroyed: number;
}

/** Every VEVENT in a calendar, keyed by UID plus RECURRENCE-ID. */
function eventIndex(cal: Component): Map<string, Component> {
  const m = new Map<string, Component>();
  for (const c of cal.children) {
    if (c.name !== 'VEVENT') continue;
    const uid = getProp(c, 'UID')?.value ?? '';
    const rid = getProp(c, 'RECURRENCE-ID')?.value ?? '';
    m.set(`${uid}#${rid}`, c);
  }
  return m;
}

/** Does any series in `cal` still treat `slotMs` as cancelled? */
function isCancelledSomewhere(cal: Component, slotMs: number): boolean {
  for (const uid of new Set(
    cal.children.filter((c) => c.name === 'VEVENT').map((c) => getProp(c, 'UID')?.value ?? ''),
  )) {
    const g = buildSeriesGraph(cal, uid);
    if (!g) continue;
    if (g.occurrences.some((o) => o.kind === 'cancelled' && o.slotMs === slotMs)) return true;
    // The cancellation may have been re-anchored onto a different instant.
    if (g.exdates.includes(slotMs)) return true;
  }
  return false;
}

/**
 * Compare the two results by reading the calendars themselves.
 *
 * The plan already predicts what a conventional edit destroys, but a prediction
 * is not evidence. This re-parses both outputs and asks, for each thing the
 * user had customised, whether it is still there — so the headline number is
 * measured rather than asserted.
 */
export function compareResults(graph: SeriesGraph, plan: SplitPlan, safe: Component, naive: Component): Comparison {
  const safeCal = parseIcs(serializeIcs(safe));
  const naiveCal = parseIcs(serializeIcs(naive));
  const safeIdx = eventIndex(safeCal);
  const naiveIdx = eventIndex(naiveCal);

  const summaryOf = (c: Component) => getProp(c, 'SUMMARY')?.value ?? '';
  const findBySummary = (idx: Map<string, Component>, summary: string) =>
    [...idx.values()].some((c) => summaryOf(c) === summary && summary.length > 0);

  const items: ComparedItem[] = [];

  for (const occ of plan.futureOccurrences) {
    if (occ.kind === 'normal') continue;
    const when = formatHuman(occ.slotMs, graph.tzid);

    if (occ.kind === 'cancelled') {
      items.push({
        what: 'Cancellation',
        when,
        inSeriesSafe: isCancelledSomewhere(safeCal, plan.remaps.find((r) => r.oldSlotMs === occ.slotMs)?.newSlotMs ?? occ.slotMs),
        inConventional: isCancelledSomewhere(naiveCal, occ.slotMs),
        detail: 'the date stays off the calendar',
      });
      continue;
    }

    if (occ.kind === 'overridden') {
      const summary = summaryOf(occ.override!);
      items.push({
        what: 'Customised meeting',
        when,
        inSeriesSafe: findBySummary(safeIdx, summary),
        inConventional: findBySummary(naiveIdx, summary),
        detail: `"${summary}" with its own time, place and guests`,
      });
      continue;
    }

    // An explicitly added date.
    const present = (cal: Component) => {
      for (const uid of new Set(
        cal.children.filter((c) => c.name === 'VEVENT').map((c) => getProp(c, 'UID')?.value ?? ''),
      )) {
        const g = buildSeriesGraph(cal, uid);
        if (g?.occurrences.some((o) => o.slotMs === occ.slotMs)) return true;
      }
      return false;
    };
    items.push({
      what: 'Added session',
      when,
      inSeriesSafe: present(safeCal),
      inConventional: present(naiveCal),
      detail: 'the one-off date remains scheduled',
    });
  }

  return {
    items,
    preserved: items.filter((i) => i.inSeriesSafe).length,
    destroyed: items.filter((i) => !i.inConventional).length,
  };
}
