import {
  type Component,
  type Param,
  type Prop,
  getProp,
  getProps,
  getParam,

} from '../ics/types.ts';
import { parseDateTime, formatDateTime, unescapeText, isKnownTimeZone } from '../ics/parse.ts';
import { parseRRule, expandRRule, type RRule } from './rrule.ts';

/** How an occurrence differs from the bare recurrence pattern. */
export type OccurrenceKind = 'normal' | 'cancelled' | 'overridden' | 'extra';

export interface Occurrence {
  /** Ordinal position within the pattern, counting from DTSTART. */
  index: number;
  /** The pattern slot instant this occurrence is anchored to (UTC ms). */
  slotMs: number;
  kind: OccurrenceKind;
  /** Actual start once an override is applied; equals slotMs when unmodified. */
  startMs: number;
  endMs?: number;
  /** The detached VEVENT backing an `overridden` occurrence. */
  override?: Component;
  /** Human-readable note describing why this occurrence is special. */
  note?: string;
}

/**
 * One value from an EXDATE/RDATE list, with the parameters it travelled on and
 * the form it was written in.
 *
 * RFC 5545 lets an RDATE be a DATE even when the series is timed, and lets it
 * carry its own zone. Rewriting every value in the master's form turned an
 * all-day extra session into a timed one.
 */
export interface DateEntry {
  ms: number;
  params: Param[];
  isDate: boolean;
  isUtc: boolean;
  tzid?: string;
}

export interface SeriesGraph {
  uid: string;
  master: Component;
  rule: RRule;
  dtstartMs: number;
  tzid?: string;
  isDate: boolean;
  /** True when DTSTART was written as a UTC instant (a trailing "Z"). */
  isUtc: boolean;
  durationMs: number;
  summary: string;
  /** Cancelled slot instants taken from EXDATE. */
  exdates: number[];
  /** Extra slot instants taken from RDATE. */
  rdates: number[];
  /** The same values with the parameters each arrived on. */
  exdateEntries: DateEntry[];
  rdateEntries: DateEntry[];
  /** Detached overrides keyed by their RECURRENCE-ID instant. */
  overrides: Map<number, Component>;
  occurrences: Occurrence[];
  /** Set when a TZID could not be resolved, so every instant is a guess. */
  timeZoneUnresolved?: string;
  /** Date values present in the file that this parser could not read. */
  unreadableDates: string[];
  /** True when the rule has neither COUNT nor UNTIL, so it never ends. */
  unbounded: boolean;
  /** True when expansion hit its safety limit, so the model is incomplete. */
  truncated: boolean;
  /** The instant expansion stopped at. Comparisons must share this bound. */
  modelledUntilMs: number;
  /** Non-fatal observations surfaced in the UI. */
  warnings: string[];
}

/** Properties that carry user intent and must survive any rewrite. */
export const PRESERVED_PROPS = [
  'SUMMARY',
  'LOCATION',
  'DESCRIPTION',
  'ATTENDEE',
  'ORGANIZER',
  'CATEGORIES',
  'STATUS',
  'CLASS',
  'PRIORITY',
  'URL',
  'GEO',
  'RESOURCES',
  'CONTACT',
  'COMMENT',
  'TRANSP',
] as const;

function textOf(c: Component, name: string): string {
  const p = getProp(c, name);
  return p ? unescapeText(p.value) : '';
}

/**
 * Collect every date value from a multi-valued EXDATE/RDATE property set.
 *
 * Values this parser cannot read are reported rather than skipped: an
 * `RDATE;VALUE=PERIOD` was silently ignored, leaving the model with no record
 * of it, and the writer then dropped the property entirely.
 */
function collectDateList(props: Prop[]): {
  entries: DateEntry[];
  instants: number[];
  unreadable: string[];
  zones: string[];
} {
  const entries: DateEntry[] = [];
  const unreadable: string[] = [];
  const zones: string[] = [];
  for (const p of props) {
    const tzid = getParam(p, 'TZID');
    if (tzid) zones.push(tzid);
    const valueType = (getParam(p, 'VALUE') ?? '').toUpperCase();
    if (valueType === 'PERIOD') {
      unreadable.push(`${p.name};VALUE=PERIOD`);
      continue;
    }
    for (const piece of p.value.split(',')) {
      const dt = parseDateTime(piece, tzid);
      if (dt) entries.push({ ms: dt.ms, params: p.params, isDate: dt.isDate, isUtc: dt.isUtc, tzid });
      else unreadable.push(`${p.name}:${piece}`);
    }
  }
  return { entries, instants: entries.map((e) => e.ms), unreadable, zones };
}

/**
 * Build the semantic series graph for a UID from a parsed calendar.
 *
 * The DOM of any calendar UI shows *rendered* occurrences. This graph is the
 * thing the UI is rendered *from*: the master rule, the cancellations, the
 * detached overrides and the ordinal identity that links them. It is precisely
 * what an agent cannot reconstruct from pixels or from a month grid.
 */
export function buildSeriesGraph(cal: Component, uid: string, horizonMs?: number): SeriesGraph | null {
  const events = cal.children.filter((c) => c.name === 'VEVENT' && textOf(c, 'UID') === uid);
  if (!events.length) return null;

  const master = events.find((e) => !getProp(e, 'RECURRENCE-ID'));
  if (!master) return null;

  const warnings: string[] = [];
  /** Date values present in the file that this parser could not read. */
  const unreadableFixed: string[] = [];

  const dtstartProp = getProp(master, 'DTSTART');
  if (!dtstartProp) return null;
  const tzid = getParam(dtstartProp, 'TZID');
  let timeZoneUnresolved: string | undefined;
  const noteZone = (z: string | undefined, where: string) => {
    if (!z || isKnownTimeZone(z)) return;
    timeZoneUnresolved ??= z;
    warnings.push(`TZID "${z}" on ${where} is not one this browser can resolve.`);
  };
  noteZone(tzid, 'DTSTART');
  const dtstart = parseDateTime(dtstartProp.value, tzid);
  if (!dtstart) return null;

  const rruleProps = getProps(master, 'RRULE');
  if (rruleProps.length === 0) return null;
  if (rruleProps.length > 1) {
    warnings.push('Event carries multiple RRULE properties; only the first is modelled.');
  }
  const rule = parseRRule(rruleProps[0].value);

  // Duration: DTEND when present, else DURATION, else zero-length.
  let durationMs = 0;
  const dtendProp = getProp(master, 'DTEND');
  if (dtendProp) {
    const dtend = parseDateTime(dtendProp.value, getParam(dtendProp, 'TZID') ?? tzid);
    if (dtend) durationMs = dtend.ms - dtstart.ms;
    // An unreadable DTEND silently produced a zero-length event.
    else unreadableFixed.push(`DTEND:${dtendProp.value}`);
  } else {
    const dur = getProp(master, 'DURATION');
    if (dur) durationMs = parseDuration(dur.value);
  }

  const ex = collectDateList(getProps(master, 'EXDATE'));
  const rd = collectDateList(getProps(master, 'RDATE'));
  const exdates = ex.instants;
  const rdates = rd.instants;
  // An UNTIL that cannot be read turned a bounded series into an endless one.
  if (rruleProps[0].value.includes('UNTIL=') && rule.until === undefined) {
    unreadableFixed.push(`RRULE UNTIL in ${rruleProps[0].value}`);
  }

  // Every date-bearing property carries its own TZID, and an unresolvable one
  // anywhere makes that instant a guess — not only on DTSTART.
  noteZone(getParam(getProp(master, 'DTEND') ?? { name: '', params: [], value: '' }, 'TZID'), 'DTEND');
  for (const z of [...ex.zones, ...rd.zones]) noteZone(z, 'EXDATE/RDATE');

  const overrides = new Map<number, Component>();
  for (const ev of events) {
    const rid = getProp(ev, 'RECURRENCE-ID');
    if (!rid) continue;
    const range = getParam(rid, 'RANGE');
    if (range && range.toUpperCase() === 'THISANDFUTURE') {
      warnings.push(
        'An override uses RECURRENCE-ID;RANGE=THISANDFUTURE, whose forward effect cannot be re-anchored safely.',
      );
    }
    noteZone(getParam(rid, 'TZID'), 'RECURRENCE-ID');
    const dt = parseDateTime(rid.value, getParam(rid, 'TZID') ?? tzid);
    if (dt) overrides.set(dt.ms, ev);
    // An override whose anchor cannot be read is invisible to every later
    // step, and would simply be left behind on the truncated series.
    else unreadableFixed.push(`RECURRENCE-ID:${rid.value}`);
    for (const nameOf of ['DTSTART', 'DTEND'] as const) {
      const p = getProp(ev, nameOf);
      if (p && !parseDateTime(p.value, getParam(p, 'TZID') ?? tzid)) {
        unreadableFixed.push(`${nameOf}:${p.value} on a customised occurrence`);
      }
    }
  }

  // Materialize the occurrence list.
  // RRULE slots and RDATE-only dates are tracked separately: a date that the
  // rule already produces is not an "extra", and treating it as one removes it
  // from the pattern and shifts every later exception by a position.
  //
  // A bounded rule is expanded to its own end. Only a rule that never ends
  // gets a window, and it is anchored past the furthest exception so nothing
  // addressable is left outside the model. An earlier fixed three-year horizon
  // silently dropped far-future occurrences and rewrote long series as short
  // finite ones, with every invariant still reporting success.
  const unbounded = rule.count === undefined && rule.until === undefined;
  /*
   * For a rule with no end, the window has to reach the part of the calendar
   * someone is actually working in. Anchoring it to DTSTART meant a standup
   * that began in 2020 modelled nothing after 2022, and editing it in 2026 was
   * refused for having no occurrences left.
   */
  const furthestException = Math.max(
    dtstart.ms,
    Date.now(),
    ...exdates, ...rdates, ...[...overrides.keys()],
  );
  const LIMIT = 20000;
  // Expand one past the limit so a series of exactly LIMIT occurrences is not
  // mistaken for one that overflowed.
  const horizon =
    horizonMs ??
    (unbounded ? furthestException + 2 * 365 * 86400_000 : undefined);
  const expanded = expandRRule(dtstart.ms, rule, tzid, { maxMs: horizon, limit: LIMIT + 1 });
  const truncated = expanded.length > LIMIT;
  const ruleSlots = truncated ? expanded.slice(0, LIMIT) : expanded;
  const ruleSet = new Set(ruleSlots);
  /*
   * Floating local time means "whatever the clock says wherever you are", and
   * this parser represents it with the same number as the UTC instant of that
   * wall clock. That is fine on its own, but a file that mixes floating with
   * absolute values cannot be compared faithfully: a floating 09:00 and an
   * absolute 09:00Z would look like one occurrence. Rather than guess, such a
   * file is refused.
   */
  const masterIsFloating = !dtstart.isUtc && !tzid && !dtstart.isDate;
  for (const e of [...ex.entries, ...rd.entries]) {
    if (e.isDate) continue;
    const entryIsFloating = !e.isUtc && !e.tzid;
    if (entryIsFloating !== masterIsFloating) {
      unreadableFixed.push(
        `a ${entryIsFloating ? 'floating' : 'fixed'} date value on a ${masterIsFloating ? 'floating' : 'fixed'} series`,
      );
      break;
    }
  }

  const slots = [...ruleSlots];
  for (const r of rdates) if (!ruleSet.has(r)) slots.push(r);
  slots.sort((a, b) => a - b);

  const exSet = new Set(exdates);
  // Only an RDATE the rule does not already generate counts as an added date.
  const rdSet = new Set(rdates.filter((r) => !ruleSet.has(r)));
  const occurrences: Occurrence[] = slots.map((slotMs, index) => {
    const ov = overrides.get(slotMs);
    if (exSet.has(slotMs)) {
      /*
       * A slot can be cancelled twice over: by an EXDATE and by a detached
       * override carrying STATUS:CANCELLED. Taking the EXDATE branch first
       * used to discard the override, which then stayed behind on the series
       * being truncated, taking its note and its reminder with it.
       */
      return {
        index,
        slotMs,
        kind: 'cancelled',
        startMs: slotMs,
        override: ov,
        note: ov ? 'Cancelled (EXDATE and a cancelled occurrence)' : 'Cancelled (EXDATE)',
      };
    }
    if (ov) {
      // A detached override carrying STATUS:CANCELLED is not a meeting that
      // happens elsewhere; it is that occurrence being called off.
      if (textOf(ov, 'STATUS').toUpperCase() === 'CANCELLED') {
        return {
          index, slotMs, kind: 'cancelled', startMs: slotMs,
          override: ov, note: 'Cancelled (STATUS:CANCELLED)',
        };
      }
      const ovStartProp = getProp(ov, 'DTSTART');
      const ovStart = ovStartProp
        ? parseDateTime(ovStartProp.value, getParam(ovStartProp, 'TZID') ?? tzid)
        : null;
      const ovEndProp = getProp(ov, 'DTEND');
      const ovEnd = ovEndProp
        ? parseDateTime(ovEndProp.value, getParam(ovEndProp, 'TZID') ?? tzid)
        : null;
      return {
        index,
        slotMs,
        kind: 'overridden',
        startMs: ovStart ? ovStart.ms : slotMs,
        endMs: ovEnd ? ovEnd.ms : undefined,
        override: ov,
        note: describeOverride(ov, slotMs, ovStart ? ovStart.ms : slotMs),
      };
    }
    if (rdSet.has(slotMs)) {
      return { index, slotMs, kind: 'extra', startMs: slotMs, endMs: slotMs + durationMs, note: 'Extra date (RDATE)' };
    }
    return { index, slotMs, kind: 'normal', startMs: slotMs, endMs: slotMs + durationMs };
  });

  // Overrides whose RECURRENCE-ID matches no pattern slot are orphans.
  for (const [rid] of overrides) {
    if (!slots.includes(rid)) {
      warnings.push(
        `An override points at ${new Date(rid).toISOString()}, which is not a slot of the current rule.`,
      );
    }
  }

  return {
    uid,
    master,
    rule,
    dtstartMs: dtstart.ms,
    tzid,
    isDate: dtstart.isDate,
    isUtc: dtstart.isUtc,
    durationMs,
    summary: textOf(master, 'SUMMARY') || '(untitled)',
    exdates,
    rdates,
    exdateEntries: ex.entries,
    rdateEntries: rd.entries,
    overrides,
    occurrences,
    timeZoneUnresolved,
    // Composed here so every contributor above has already reported.
    unreadableDates: [...ex.unreadable, ...rd.unreadable, ...unreadableFixed],
    unbounded,
    truncated,
    modelledUntilMs: horizon ?? (ruleSlots.length ? ruleSlots[ruleSlots.length - 1] : dtstart.ms),
    warnings,
  };
}

function describeOverride(ov: Component, slotMs: number, startMs: number): string {
  const bits: string[] = [];
  if (startMs !== slotMs) {
    bits.push(`moved to ${new Date(startMs).toISOString().slice(0, 16).replace('T', ' ')}Z`);
  }
  const loc = textOf(ov, 'LOCATION');
  if (loc) bits.push(`location "${loc}"`);
  const status = textOf(ov, 'STATUS');
  if (status && status.toUpperCase() === 'CANCELLED') bits.push('marked CANCELLED');
  const att = getProps(ov, 'ATTENDEE').length;
  if (att) bits.push(`${att} attendee${att === 1 ? '' : 's'}`);
  return bits.length ? `Override: ${bits.join(', ')}` : 'Override';
}

const DUR_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function parseDuration(v: string): number {
  const m = DUR_RE.exec(v.trim());
  if (!m) return 0;
  const [, sign, w, d, h, mi, s] = m;
  const ms =
    (+(w ?? 0) * 7 * 86400 + +(d ?? 0) * 86400 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

/** List every distinct recurring UID present in a calendar. */
export function listRecurringUids(cal: Component): string[] {
  const uids = new Set<string>();
  for (const c of cal.children) {
    if (c.name !== 'VEVENT') continue;
    if (!getProp(c, 'RRULE')) continue;
    if (getProp(c, 'RECURRENCE-ID')) continue;
    const uid = textOf(c, 'UID');
    if (uid) uids.add(uid);
  }
  return [...uids];
}

/**
 * Format an instant using the same value type as this series' DTSTART.
 *
 * RFC 5545 gives a UTC instant, a floating local time and a date three
 * different meanings. Re-emitting a UTC `DTSTART` without its `Z` turns it
 * into floating time, which silently moves the event for every viewer outside
 * the writer's zone.
 */
export function formatLike(g: SeriesGraph, ms: number): string {
  return formatDateTime(ms, { isDate: g.isDate, isUtc: g.isUtc, tzid: g.tzid });
}

/**
 * The parameters a date property of this series' type must carry, keeping any
 * others the file already had.
 *
 * Replacing the parameter list wholesale silently deleted legitimate `X-`
 * parameters that travel on DTSTART, DTEND, EXDATE and RDATE.
 */
export function dtParams(g: SeriesGraph, existing: Param[] = []): Param[] {
  const kept = existing.filter((p) => p.name !== 'VALUE' && p.name !== 'TZID');
  if (g.isDate) return [{ name: 'VALUE', values: ['DATE'] }, ...kept];
  if (g.isUtc) return kept;
  return g.tzid ? [{ name: 'TZID', values: [g.tzid] }, ...kept] : kept;
}

/**
 * Build an UNTIL value of the type RFC 5545 §3.3.10 requires: a DATE when
 * DTSTART is a DATE, floating local time when DTSTART floats, and UTC when
 * DTSTART is UTC or carries a TZID.
 */
export function formatUntil(g: SeriesGraph, ms: number): string {
  if (g.isDate) return formatDateTime(ms, { isDate: true });
  if (!g.isUtc && !g.tzid) return formatDateTime(ms, { isDate: false });
  return formatDateTime(ms, { isUtc: true });
}
