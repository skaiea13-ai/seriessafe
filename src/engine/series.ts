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
  /** Detached overrides keyed by their RECURRENCE-ID instant. */
  overrides: Map<number, Component>;
  occurrences: Occurrence[];
  /** Set when a TZID could not be resolved, so every instant is a guess. */
  timeZoneUnresolved?: string;
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

/** Collect every date value from a multi-valued EXDATE/RDATE property set. */
function collectDateList(props: Prop[]): number[] {
  const out: number[] = [];
  for (const p of props) {
    const tzid = getParam(p, 'TZID');
    for (const piece of p.value.split(',')) {
      const dt = parseDateTime(piece, tzid);
      if (dt) out.push(dt.ms);
    }
  }
  return out;
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

  const dtstartProp = getProp(master, 'DTSTART');
  if (!dtstartProp) return null;
  const tzid = getParam(dtstartProp, 'TZID');
  let timeZoneUnresolved: string | undefined;
  if (tzid && !isKnownTimeZone(tzid)) {
    timeZoneUnresolved = tzid;
    warnings.push(
      `TZID "${tzid}" is not one this browser can resolve, so every time in this series would be a guess.`,
    );
  }
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
  } else {
    const dur = getProp(master, 'DURATION');
    if (dur) durationMs = parseDuration(dur.value);
  }

  const exdates = collectDateList(getProps(master, 'EXDATE'));
  const rdates = collectDateList(getProps(master, 'RDATE'));

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
    const dt = parseDateTime(rid.value, getParam(rid, 'TZID') ?? tzid);
    if (dt) overrides.set(dt.ms, ev);
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
  const furthestException = Math.max(
    dtstart.ms,
    ...exdates, ...rdates, ...[...overrides.keys()],
  );
  const LIMIT = 20000;
  const horizon =
    horizonMs ??
    (unbounded ? furthestException + 2 * 365 * 86400_000 : undefined);
  const ruleSlots = expandRRule(dtstart.ms, rule, tzid, { maxMs: horizon, limit: LIMIT });
  const truncated = ruleSlots.length >= LIMIT;
  const ruleSet = new Set(ruleSlots);
  const slots = [...ruleSlots];
  for (const r of rdates) if (!ruleSet.has(r)) slots.push(r);
  slots.sort((a, b) => a - b);

  const exSet = new Set(exdates);
  // Only an RDATE the rule does not already generate counts as an added date.
  const rdSet = new Set(rdates.filter((r) => !ruleSet.has(r)));
  const occurrences: Occurrence[] = slots.map((slotMs, index) => {
    const ov = overrides.get(slotMs);
    if (exSet.has(slotMs)) {
      return { index, slotMs, kind: 'cancelled', startMs: slotMs, note: 'Cancelled (EXDATE)' };
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
    overrides,
    occurrences,
    timeZoneUnresolved,
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

/** The parameters a date property of this series' type must carry. */
export function dtParams(g: SeriesGraph): Param[] {
  if (g.isDate) return [{ name: 'VALUE', values: ['DATE'] }];
  if (g.isUtc) return [];
  return g.tzid ? [{ name: 'TZID', values: [g.tzid] }] : [];
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
