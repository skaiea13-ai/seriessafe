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

/**
 * Compare the two results by reading the calendars themselves.
 *
 * The plan already predicts what a conventional edit destroys, but a
 * prediction is not evidence. This re-parses both outputs and asks, for each
 * thing the user had customised, whether it survived.
 *
 * Every lookup is scoped to the series under operation. An earlier version
 * searched the whole file, so an unrelated event that happened to share a
 * summary or an instant made a destroyed item look preserved.
 */
export function compareResults(
  graph: SeriesGraph,
  plan: SplitPlan,
  safe: Component,
  naive: Component,
): Comparison {
  const safeCal = parseIcs(serializeIcs(safe));
  const naiveCal = parseIcs(serializeIcs(naive));

  /** Occurrences of this series only, under whichever UID now carries them. */
  const seriesOf = (cal: Component, uids: string[]) =>
    uids.flatMap((uid) => buildSeriesGraph(cal, uid)?.occurrences ?? []);

  /** Detached overrides of this series only, keyed by nothing but membership. */
  const overridesOf = (cal: Component, uids: string[]) =>
    cal.children.filter(
      (c) =>
        c.name === 'VEVENT' &&
        uids.includes(getProp(c, 'UID')?.value ?? '') &&
        !!getProp(c, 'RECURRENCE-ID'),
    );

  const safeUids = [graph.uid, plan.newUid];
  const naiveUids = [graph.uid, `${graph.uid}-naive-${plan.newDtstartMs}`];

  const safeOccs = seriesOf(safeCal, safeUids);
  const naiveOccs = seriesOf(naiveCal, naiveUids);
  const safeOverrides = overridesOf(safeCal, safeUids);
  const naiveOverrides = overridesOf(naiveCal, naiveUids);

  const items: ComparedItem[] = [];

  for (const occ of plan.futureOccurrences) {
    if (occ.kind === 'normal') continue;
    const when = formatHuman(occ.slotMs, graph.tzid);
    const remap = plan.remaps.find((r) => r.oldSlotMs === occ.slotMs);

    if (occ.kind === 'cancelled') {
      const cancelledAt = (occs: typeof safeOccs, at: number) =>
        occs.some((o) => o.kind === 'cancelled' && o.slotMs === at);
      items.push({
        what: 'Cancellation',
        when,
        inSeriesSafe: cancelledAt(safeOccs, remap?.newSlotMs ?? occ.slotMs),
        inConventional: cancelledAt(naiveOccs, occ.slotMs),
        detail: 'the date stays off the calendar',
      });
      continue;
    }

    if (occ.kind === 'overridden') {
      /*
       * Identity is this specific detached override: same summary, same start
       * instant, still attached to this series. Matching on "some occurrence
       * starts at that moment" let an unrelated past override of the same
       * series stand in for a destroyed future one.
       */
      const wantedSummary = getProp(occ.override!, 'SUMMARY')?.value ?? '';
      const wantedStart = getProp(occ.override!, 'DTSTART')?.value ?? '';
      const survives = (evs: Component[]) =>
        evs.some(
          (e) =>
            (getProp(e, 'SUMMARY')?.value ?? '') === wantedSummary &&
            (getProp(e, 'DTSTART')?.value ?? '') === wantedStart,
        );
      items.push({
        what: 'Customised meeting',
        when,
        inSeriesSafe: survives(safeOverrides),
        inConventional: survives(naiveOverrides),
        detail: `"${wantedSummary || 'that meeting'}" with its own time, place and guests`,
      });
      continue;
    }

    // An explicitly added date.
    const present = (occs: typeof safeOccs, at: number) => occs.some((o) => o.slotMs === at);
    items.push({
      what: 'Added session',
      when,
      inSeriesSafe: present(safeOccs, remap?.newSlotMs ?? occ.slotMs),
      inConventional: present(naiveOccs, occ.slotMs),
      detail: 'the one-off date remains scheduled',
    });
  }

  return {
    items,
    preserved: items.filter((i) => i.inSeriesSafe).length,
    destroyed: items.filter((i) => !i.inConventional).length,
  };
}
