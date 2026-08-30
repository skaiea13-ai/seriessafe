import {
  type Component,
  type Param,
  getProp,
  getProps,
  getParam,
  cloneComponent,
  removeProps,
} from '../ics/types.ts';
import { formatDateTime, parseDateTime } from '../ics/parse.ts';
import { parseRRule, formatRRule } from './rrule.ts';
import { type SeriesGraph, type DateEntry, formatLike, dtParams } from './series.ts';
import type { SplitPlan } from './split.ts';

function bumpSequence(c: Component): void {
  const seq = getProp(c, 'SEQUENCE');
  const n = seq ? parseInt(seq.value, 10) || 0 : 0;
  if (seq) seq.value = String(n + 1);
  else c.props.push({ name: 'SEQUENCE', params: [], value: '1' });
}

function stampDtstamp(c: Component): void {
  const now = formatDateTime(Date.now(), { isUtc: true });
  const p = getProp(c, 'DTSTAMP');
  if (p) p.value = now;
  else c.props.push({ name: 'DTSTAMP', params: [], value: now });
}

/** Emit a date-list property (EXDATE/RDATE) for a set of instants. */
/**
 * Emit date-list properties, one per distinct parameter set.
 *
 * Values that arrived on different properties can carry different parameters —
 * `EXDATE;X-CANCEL-SOURCE=registrar` beside a plain one. Flattening them into a
 * single property applied the first set to everything and lost the rest.
 */
function dateListProps(
  name: string,
  entries: DateEntry[],
  graph: SeriesGraph,
): Component['props'] {
  if (!entries.length) return [];
  const groups = new Map<string, { params: Param[]; entries: DateEntry[] }>();
  for (const e of entries) {
    // The whole parameter set matters, VALUE and TZID included: values written
    // in different forms belong on different properties.
    const extra = e.params;
    /*
     * Serialized as nested structure rather than joined text, and left in the
     * order it arrived. Flattening with separators made `X-P="a,b"` — one
     * value containing a comma — collide with `X-P=a,b`, two values. Sorting
     * the values then made `X-P=a,b` and `X-P=b,a` collide too: order can
     * carry meaning in a parameter this tool does not understand, so it is not
     * this tool's to normalise.
     */
    const key = JSON.stringify(extra.map((p) => [p.name, p.values]));
    const g = groups.get(key);
    if (g) g.entries.push(e);
    else groups.set(key, { params: e.params, entries: [e] });
  }
  return [...groups.values()].map((g) => {
    // Each value is written back in the form it arrived in, not the series'.
    const seen = new Set<number>();
    const kept = g.entries
      .filter((e) => (seen.has(e.ms) ? false : (seen.add(e.ms), true)))
      .sort((a, b) => a.ms - b.ms);
    return {
      name,
      // A value written in UTC carries no TZID; adding the series' zone to it
      // would say something the file never said.
      params: g.params.length
        ? g.params
        : kept[0]?.isUtc
          ? []
          : dtParams(graph),
      value: kept
        .map((e) => formatDateTime(e.ms, { isDate: e.isDate, isUtc: e.isUtc, tzid: e.tzid }))
        .join(','),
    } as Component['props'][number];
  });
}

export interface ApplyResult {
  calendar: Component;
  /** UIDs of every component the operation touched or created. */
  touchedUids: string[];
}

/**
 * Apply a validated split plan, producing a new calendar.
 *
 * The old master is truncated with UNTIL and keeps every past exception. A new
 * master is created for the future, and each future exception is re-anchored
 * onto it by ordinal. Overrides keep their own DTSTART, their properties, their
 * alarms and their X- extensions; only UID and RECURRENCE-ID are rewritten.
 */
export function applySplit(cal: Component, graph: SeriesGraph, plan: SplitPlan): ApplyResult {
  const out = cloneComponent(cal);
  const events = out.children.filter((c) => c.name === 'VEVENT');

  const isOurs = (c: Component) => (getProp(c, 'UID')?.value ?? '') === graph.uid;
  /*
   * Resolve the anchor using the parameters it carries, rather than
   * re-formatting the series' own value type and comparing text. An override
   * written with a UTC RECURRENCE-ID against a TZID master is perfectly legal
   * and was simply not found, so it stayed on the truncated series.
   */
  const ridMsOf = (c: Component): number | null => {
    const rid = getProp(c, 'RECURRENCE-ID');
    if (!rid) return null;
    const parsed = parseDateTime(rid.value, getParam(rid, 'TZID') ?? graph.tzid);
    if (!parsed) return null;
    return graph.overrides.has(parsed.ms) ? parsed.ms : null;
  };

  // ---- 1. truncate the old master -----------------------------------
  const oldMaster = events.find((c) => isOurs(c) && !getProp(c, 'RECURRENCE-ID'));
  if (!oldMaster) throw new Error('master event vanished before apply');

  const oldRule = parseRRule(getProps(oldMaster, 'RRULE')[0].value);
  oldRule.count = undefined; // an explicit UNTIL replaces any COUNT
  oldRule.until = plan.pastOccurrences.length
    ? plan.pastOccurrences[plan.pastOccurrences.length - 1].slotMs
    : graph.dtstartMs;
  oldRule.untilRaw = plan.untilRaw;
  const oldRuleProp = getProps(oldMaster, 'RRULE')[0];
  oldRuleProp.value = formatRRule(oldRule);

  // Past-only EXDATE / RDATE stay on the old master.
  removeProps(oldMaster, 'EXDATE');
  removeProps(oldMaster, 'RDATE');
  const firstFutureSlot = plan.futureOccurrences[0]?.slotMs ?? Infinity;
  const pastEx = graph.exdateEntries.filter((e) => e.ms < firstFutureSlot);
  const pastRd = graph.rdateEntries.filter((e) => e.ms < firstFutureSlot);
  oldMaster.props.push(...dateListProps('EXDATE', pastEx, graph));
  oldMaster.props.push(...dateListProps('RDATE', pastRd, graph));
  bumpSequence(oldMaster);
  stampDtstamp(oldMaster);

  // ---- 2. build the new master --------------------------------------
  const newMaster = cloneComponent(oldMaster);
  removeProps(newMaster, 'EXDATE');
  removeProps(newMaster, 'RDATE');
  // A UID may carry parameters of its own; replacing the value is not licence
  // to drop them.
  const oldUidParams = removeProps(newMaster, 'UID')[0]?.params ?? [];
  newMaster.props.unshift({ name: 'UID', params: oldUidParams, value: plan.newUid });

  const newDtstart = getProp(newMaster, 'DTSTART');
  if (newDtstart) {
    newDtstart.value = formatLike(graph, plan.newDtstartMs);
    newDtstart.params = dtParams(graph, newDtstart.params);
  }
  const newDtend = getProp(newMaster, 'DTEND');
  if (newDtend) {
    /*
     * An end may be stated in a different zone from the start — a flight
     * landing in another country. Forcing it onto the start's zone keeps the
     * instant and loses the fact.
     */
    const endTz = getParam(newDtend, 'TZID');
    const endParsed = parseDateTime(newDtend.value, endTz ?? graph.tzid);
    newDtend.value = formatDateTime(plan.newDtstartMs + graph.durationMs, {
      isDate: endParsed?.isDate ?? graph.isDate,
      isUtc: endParsed?.isUtc ?? (graph.isUtc && !endTz),
      tzid: endTz ?? (endParsed?.isUtc ? undefined : graph.tzid),
    });
  }
  getProps(newMaster, 'RRULE')[0].value = plan.newRuleText;

  // Re-anchored cancellations and extra dates.
  /*
   * Every entry at an instant is carried, not just the first. A date can be
   * listed more than once with different parameters, and taking only the first
   * match silently dropped the rest.
   */
  const carryAll = (entries: DateEntry[], oldMs: number, newMs: number): DateEntry[] => {
    const matches = entries.filter((e) => e.ms === oldMs);
    // The moved value keeps the form and parameters it arrived with.
    return matches.length
      ? matches.map((e) => ({ ...e, ms: newMs }))
      : [{ ms: newMs, params: dtParams(graph), isDate: graph.isDate, isUtc: graph.isUtc, tzid: graph.tzid }];
  };
  const newEx: DateEntry[] = plan.remaps
    .filter((r) => r.kind === 'cancellation')
    .flatMap((r) => carryAll(graph.exdateEntries, r.oldSlotMs, r.newSlotMs));
  const newRd: DateEntry[] = plan.remaps
    .filter((r) => r.kind === 'extra')
    .flatMap((r) => carryAll(graph.rdateEntries, r.oldSlotMs, r.newSlotMs));
  newMaster.props.push(...dateListProps('EXDATE', newEx, graph));
  newMaster.props.push(...dateListProps('RDATE', newRd, graph));
  newMaster.props.push({
    name: 'X-SERIESSAFE-SPLIT-FROM',
    params: [],
    value: graph.uid,
  });
  bumpSequence(newMaster);
  stampDtstamp(newMaster);

  // ---- 3. re-anchor future overrides --------------------------------
  const overrideRemaps = new Map(
    plan.remaps.filter((r) => r.kind === 'override').map((r) => [r.oldSlotMs, r]),
  );

  const kept: Component[] = [];
  for (const ev of out.children) {
    if (ev.name !== 'VEVENT' || !isOurs(ev)) {
      kept.push(ev);
      continue;
    }
    const rid = ridMsOf(ev);
    if (rid === null) {
      kept.push(ev); // the (now truncated) old master
      continue;
    }
    const remap = overrideRemaps.get(rid);
    if (!remap) {
      kept.push(ev); // a past override: untouched
      continue;
    }
    /*
     * A future override moves to the new series.
     *
     * Whether its *times* move depends on what kind of override it is. One
     * that was deliberately relocated — a make-up already shifted to a
     * Wednesday — keeps the date the user chose. One that only changed
     * metadata, and whose DTSTART therefore still equals its RECURRENCE-ID,
     * has no date of its own to keep: leaving it behind stranded the guest
     * lecture on the old Tuesday while its anchor moved to the new Thursday.
     */
    const moved = cloneComponent(ev);
    const wasRelocated = (() => {
      const startProp = getProp(moved, 'DTSTART');
      if (!startProp) return false;
      const tz = getParam(startProp, 'TZID') ?? graph.tzid;
      const start = parseDateTime(startProp.value, tz);
      return start ? start.ms !== rid : false;
    })();

    if (!wasRelocated) {
      /*
       * Rewritten in the override's *own* form, not the series'. An all-day
       * override of a timed series is legal, and rewriting it in the master's
       * form turned it into a twenty-four-hour timed event.
       */
      const startProp = getProp(moved, 'DTSTART');
      const ownForm = (p: typeof startProp) => {
        const tz = p ? getParam(p, 'TZID') : undefined;
        const parsed = p ? parseDateTime(p.value, tz ?? graph.tzid) : null;
        return {
          isDate: parsed?.isDate ?? graph.isDate,
          isUtc: parsed?.isUtc ?? (graph.isUtc && !tz),
          tzid: tz ?? (parsed?.isUtc ? undefined : graph.tzid),
        };
      };
      if (startProp) {
        startProp.value = formatDateTime(remap.newSlotMs, ownForm(startProp));
      }
      const endProp = getProp(moved, 'DTEND');
      if (endProp) {
        const tz = getParam(endProp, 'TZID') ?? graph.tzid;
        const end = parseDateTime(endProp.value, tz);
        const own = end ? end.ms - rid : graph.durationMs;
        endProp.value = formatDateTime(remap.newSlotMs + own, ownForm(endProp));
      }
    }

    const uidProp = getProp(moved, 'UID');
    if (uidProp) uidProp.value = plan.newUid;
    const ridProp = getProp(moved, 'RECURRENCE-ID');
    if (ridProp) {
      ridProp.value = formatLike(graph, remap.newSlotMs);
      ridProp.params = dtParams(graph, ridProp.params);
    }
    moved.props.push({
      name: 'X-SERIESSAFE-REANCHORED-FROM',
      params: [],
      value: formatDateTime(remap.oldSlotMs, { isUtc: true }),
    });
    bumpSequence(moved);
    stampDtstamp(moved);
    kept.push(moved);
  }

  // Insert the new master directly after the old one for readability.
  const idx = kept.indexOf(oldMaster);
  kept.splice(idx + 1, 0, newMaster);
  out.children = kept;

  return { calendar: out, touchedUids: [graph.uid, plan.newUid] };
}

/**
 * Model the conventional "this and following" edit.
 *
 * Google Calendar splits the series into two requests and resets exceptions
 * after the target; Exchange removes exception objects when the recurrence
 * pattern changes. This reproduces that behaviour so the two results can be
 * compared on identical input — it is the honest control for the demo, not a
 * strawman.
 */
export function applyNaive(cal: Component, graph: SeriesGraph, plan: SplitPlan): ApplyResult {
  const out = cloneComponent(cal);
  const isOurs = (c: Component) => (getProp(c, 'UID')?.value ?? '') === graph.uid;
  const firstFuture = plan.futureOccurrences[0]?.slotMs ?? Infinity;

  const oldMaster = out.children.find((c) => c.name === 'VEVENT' && isOurs(c) && !getProp(c, 'RECURRENCE-ID'));
  if (!oldMaster) throw new Error('master event vanished before apply');

  const oldRule = parseRRule(getProps(oldMaster, 'RRULE')[0].value);
  oldRule.count = undefined;
  oldRule.untilRaw = plan.untilRaw;
  getProps(oldMaster, 'RRULE')[0].value = formatRRule(oldRule);

  removeProps(oldMaster, 'EXDATE');
  removeProps(oldMaster, 'RDATE');
  oldMaster.props.push(...dateListProps('EXDATE', graph.exdateEntries.filter((e) => e.ms < firstFuture), graph));
  // Dates added before the split are part of the truncated series, so a
  // conventional edit keeps them; only the future ones are lost with it.
  oldMaster.props.push(...dateListProps('RDATE', graph.rdateEntries.filter((e) => e.ms < firstFuture), graph));

  // The replacement series: pattern only. Future exceptions are not carried.
  const newMaster = cloneComponent(oldMaster);
  removeProps(newMaster, 'EXDATE');
  removeProps(newMaster, 'RDATE');
  const uidProp = getProp(newMaster, 'UID');
  if (uidProp) uidProp.value = `${graph.uid}-naive-${plan.newDtstartMs}`;
  const nd = getProp(newMaster, 'DTSTART');
  if (nd) {
    nd.value = formatLike(graph, plan.newDtstartMs);
    nd.params = dtParams(graph, nd.params);
  }
  const ne = getProp(newMaster, 'DTEND');
  if (ne) {
    ne.value = formatLike(graph, plan.newDtstartMs + graph.durationMs);
    ne.params = dtParams(graph, ne.params);
  }
  getProps(newMaster, 'RRULE')[0].value = plan.newRuleText;

  // Drop every future override entirely — this is the documented behaviour.
  const kept = out.children.filter((c) => {
    if (c.name !== 'VEVENT' || !isOurs(c)) return true;
    if (!getProp(c, 'RECURRENCE-ID')) return true;
    const rid = getProp(c, 'RECURRENCE-ID')!;
    const tz = getParam(rid, 'TZID') ?? graph.tzid;
    for (const [ms] of graph.overrides) {
      if (formatDateTime(ms, { tzid: tz, isDate: graph.isDate, isUtc: graph.isUtc && !tz }) === rid.value) {
        return ms < firstFuture;
      }
    }
    return true;
  });

  const idx = kept.indexOf(oldMaster);
  kept.splice(idx + 1, 0, newMaster);
  out.children = kept;

  return { calendar: out, touchedUids: [graph.uid] };
}
