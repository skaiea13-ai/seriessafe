import {
  type Component,
  type Param,
  getProp,
  getProps,
  getParam,
  cloneComponent,
  removeProps,
} from '../ics/types.ts';
import { formatDateTime } from '../ics/parse.ts';
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
  const groups = new Map<string, { params: Param[]; values: number[] }>();
  for (const e of entries) {
    const extra = e.params.filter((p) => p.name !== 'VALUE' && p.name !== 'TZID');
    const key = extra.map((p) => `${p.name}=${[...p.values].sort().join(',')}`).sort().join(';');
    const g = groups.get(key);
    if (g) g.values.push(e.ms);
    else groups.set(key, { params: e.params, values: [e.ms] });
  }
  return [...groups.values()].map((g) => ({
    name,
    params: dtParams(graph, g.params),
    value: g.values
      .slice()
      .sort((a, b) => a - b)
      .map((ms) => formatLike(graph, ms))
      .join(','),
  }));
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
  const ridMsOf = (c: Component): number | null => {
    const rid = getProp(c, 'RECURRENCE-ID');
    if (!rid) return null;
    const tz = getParam(rid, 'TZID') ?? graph.tzid;
    const dt = rid.value;
    // Reuse the graph's override map by matching formatted values.
    for (const [ms] of graph.overrides) {
      if (formatDateTime(ms, { tzid: tz, isDate: graph.isDate, isUtc: graph.isUtc && !tz }) === dt) return ms;
    }
    return null;
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
  removeProps(newMaster, 'UID');
  newMaster.props.unshift({ name: 'UID', params: [], value: plan.newUid });

  const newDtstart = getProp(newMaster, 'DTSTART');
  if (newDtstart) {
    newDtstart.value = formatLike(graph, plan.newDtstartMs);
    newDtstart.params = dtParams(graph, newDtstart.params);
  }
  const newDtend = getProp(newMaster, 'DTEND');
  if (newDtend) {
    newDtend.value = formatLike(graph, plan.newDtstartMs + graph.durationMs);
    newDtend.params = dtParams(graph, newDtend.params);
  }
  getProps(newMaster, 'RRULE')[0].value = plan.newRuleText;

  // Re-anchored cancellations and extra dates.
  // Each re-anchored value keeps the parameters it arrived on.
  const paramsAt = (entries: DateEntry[], ms: number) =>
    entries.find((e) => e.ms === ms)?.params ?? [];
  const newEx: DateEntry[] = plan.remaps
    .filter((r) => r.kind === 'cancellation')
    .map((r) => ({ ms: r.newSlotMs, params: paramsAt(graph.exdateEntries, r.oldSlotMs) }));
  const newRd: DateEntry[] = plan.remaps
    .filter((r) => r.kind === 'extra')
    .map((r) => ({ ms: r.newSlotMs, params: paramsAt(graph.rdateEntries, r.oldSlotMs) }));
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
    // A future override moves to the new series, keeping its own times and
    // every property it carries.
    const moved = cloneComponent(ev);
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
