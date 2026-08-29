import { getProp, getProps, getParam } from '../ics/types.ts';
import { formatDateTime, parseDateTime } from '../ics/parse.ts';
import { expandRRule, formatRRule, type RRule } from './rrule.ts';
import { PRESERVED_PROPS, type SeriesGraph, type Occurrence } from './series.ts';

export interface SplitParams {
  /** Everything at or after this instant belongs to the new series. */
  effectiveFromMs: number;
  /** New BYDAY, e.g. ["TH"]. Omit to keep the existing days. */
  byday?: string[];
  /** New interval. Omit to keep the existing one. */
  interval?: number;
  /** New local time of day, as "HH:MM". Omit to keep the existing time. */
  timeOfDay?: string;
  /**
   * What to do with the end of the series when the weekday moves.
   *
   * Moving Tuesday to Thursday while keeping a fixed UNTIL date quietly drops
   * the final meeting, because the last Thursday falls before the last Tuesday.
   * `preserve-count` (the default) keeps the number of remaining meetings and
   * lets the end date shift; `keep-end-date` keeps the original end date and
   * accepts that the count may change.
   */
  endPolicy?: 'preserve-count' | 'keep-end-date';
}

export interface Refusal {
  code: string;
  message: string;
  /** What the user can do to make the operation safe. */
  remedy: string;
}

export interface RemapEntry {
  kind: 'cancellation' | 'override' | 'extra';
  ordinal: number;
  oldSlotMs: number;
  newSlotMs: number;
  label: string;
  /** For overrides: the real start time, which is preserved unchanged. */
  keptStartMs?: number;
  /** Properties carried across verbatim. */
  carried: string[];
}

export interface LossEntry {
  kind: 'cancellation' | 'override' | 'extra';
  oldSlotMs: number;
  label: string;
  detail: string;
}

export interface SplitPlan {
  ok: boolean;
  refusals: Refusal[];
  /** Occurrences strictly before the effective date; these must not change. */
  pastOccurrences: Occurrence[];
  /** Occurrences at or after the effective date under the *old* rule. */
  futureOccurrences: Occurrence[];
  /** Slots produced by the *new* rule, aligned by ordinal. */
  newSlots: number[];
  remaps: RemapEntry[];
  /** What a conventional "this and following" edit silently destroys. */
  naiveLosses: LossEntry[];
  oldRuleText: string;
  newRuleText: string;
  untilRaw: string;
  newDtstartMs: number;
  newUid: string;
  summary: string;
  /** Last occurrence of the old rule that would have run, and of the new one. */
  oldEndsAtMs: number | null;
  newEndsAtMs: number | null;
  endPolicy: 'preserve-count' | 'keep-end-date';
  /** Set when the end date moved in order to keep the meeting count. */
  endDateShifted: boolean;
}

/** RRULE parts SeriesSafe will not re-anchor because it cannot prove the result. */
const UNSAFE_RRULE_PARTS = ['BYSETPOS', 'BYWEEKNO', 'BYYEARDAY', 'BYMONTH', 'BYHOUR', 'BYMINUTE', 'BYSECOND'];

/**
 * Plan a "change the rule from date D onwards" operation.
 *
 * The identity that makes this safe is **ordinal alignment**: the Nth future
 * occurrence of the old rule maps to the Nth future occurrence of the new rule.
 * A cancellation on the second future Tuesday becomes a cancellation on the
 * second future Thursday, because the user's intent ("that week is off") is
 * indexed by week, not by calendar date.
 *
 * A detached override is re-anchored the same way, but its *own* DTSTART is
 * left untouched. A make-up class that was already moved to a Wednesday stays
 * on that Wednesday; only the slot it hangs from moves. That is what keeps it
 * from being absorbed into the new pattern or duplicated alongside it.
 *
 * Nothing is staged when any input cannot be re-anchored with certainty.
 */
export function simulateSplit(graph: SeriesGraph, params: SplitParams): SplitPlan {
  const refusals: Refusal[] = [];
  const { effectiveFromMs } = params;

  // ---- fail-closed input checks -------------------------------------
  const unsupported = Object.keys(graph.rule.unsupported).filter((k) => UNSAFE_RRULE_PARTS.includes(k));
  if (unsupported.length) {
    refusals.push({
      code: 'UNSUPPORTED_RRULE_PART',
      message: `The rule uses ${unsupported.join(', ')}, which changes how positions are counted.`,
      remedy: 'Split this series manually, or remove the unsupported parts before retrying.',
    });
  }
  if (getProps(graph.master, 'RRULE').length > 1) {
    refusals.push({
      code: 'MULTIPLE_RRULE',
      message: 'The master event carries more than one RRULE.',
      remedy: 'Reduce the event to a single RRULE first.',
    });
  }
  for (const [, ov] of graph.overrides) {
    const rid = getProp(ov, 'RECURRENCE-ID');
    if (rid && (getParam(rid, 'RANGE') ?? '').toUpperCase() === 'THISANDFUTURE') {
      refusals.push({
        code: 'RANGE_THISANDFUTURE',
        message: 'An override applies to itself and all later occurrences (RANGE=THISANDFUTURE).',
        remedy: 'Expand that override into individual occurrences before splitting.',
      });
      break;
    }
  }

  const past = graph.occurrences.filter((o) => o.slotMs < effectiveFromMs);
  const future = graph.occurrences.filter((o) => o.slotMs >= effectiveFromMs);

  if (future.length === 0) {
    refusals.push({
      code: 'NOTHING_AFTER_DATE',
      message: 'The series has no occurrences on or after the effective date.',
      remedy: 'Choose an earlier effective date.',
    });
  }
  if (past.length === 0) {
    refusals.push({
      code: 'NOTHING_BEFORE_DATE',
      message:
        effectiveFromMs <= graph.dtstartMs
          ? 'The effective date is on or before the first occurrence, so there is no earlier part to keep.'
          : 'The effective date leaves no past occurrences, so there is nothing to split.',
      remedy: 'Edit the whole series directly instead of splitting it.',
    });
  }

  // ---- build the new rule -------------------------------------------
  const endPolicy = params.endPolicy ?? 'preserve-count';
  const neededCount = future.filter((o) => o.kind !== 'extra').length;

  const newRule: RRule = {
    ...graph.rule,
    byday: params.byday && params.byday.length ? params.byday : graph.rule.byday,
    interval: params.interval ?? graph.rule.interval,
    count: undefined,
  };

  if (endPolicy === 'preserve-count') {
    // An explicit COUNT is unambiguous: the user keeps every remaining meeting
    // even though the last one now lands on a different weekday.
    newRule.count = neededCount;
    newRule.until = undefined;
    newRule.untilRaw = undefined;
  }

  // New DTSTART: the first slot of the new rule at or after the effective date,
  // carrying the requested time of day.
  const anchor = computeNewAnchor(graph, params, effectiveFromMs);
  if (anchor === null) {
    refusals.push({
      code: 'NO_NEW_ANCHOR',
      message: 'The new rule produces no occurrence on or after the effective date.',
      remedy: 'Pick different days or a different effective date.',
    });
  }

  const newDtstartMs = anchor ?? effectiveFromMs;
  const horizon = future.length ? future[future.length - 1].slotMs + 400 * 86400_000 : newDtstartMs;
  const newSlots = anchor === null
    ? []
    : expandRRule(newDtstartMs, newRule, graph.tzid, { maxMs: horizon, limit: 2000 });

  // ---- ordinal alignment --------------------------------------------
  const remaps: RemapEntry[] = [];
  const naiveLosses: LossEntry[] = [];

  // Ordinal alignment is computed over *pattern* slots only. An RDATE extra is
  // not part of the pattern, so counting it would shift every later exception
  // by one and silently move the wrong week.
  const patternFuture = future.filter((o) => o.kind !== 'extra');
  const specialFuture = future.filter((o) => o.kind !== 'normal');
  for (const occ of specialFuture) {
    const ordinal = occ.kind === 'extra' ? -1 : patternFuture.indexOf(occ);
    const target = occ.kind === 'extra' ? occ.slotMs : newSlots[ordinal];

    // Everything special in the future is destroyed by the conventional edit.
    naiveLosses.push(describeLoss(occ, graph));

    if (target === undefined) {
      refusals.push({
        code: 'ORDINAL_OUT_OF_RANGE',
        message: `The new rule has no slot #${ordinal + 1} to carry "${labelOf(occ, graph)}".`,
        remedy: 'Extend the new rule, or handle that occurrence separately.',
      });
      continue;
    }

    if (occ.kind === 'cancelled') {
      remaps.push({
        kind: 'cancellation',
        ordinal,
        oldSlotMs: occ.slotMs,
        newSlotMs: target,
        label: labelOf(occ, graph),
        carried: ['EXDATE'],
      });
    } else if (occ.kind === 'overridden') {
      const ov = occ.override!;
      const carried = ov.props
        .map((p) => p.name)
        .filter((n) => (PRESERVED_PROPS as readonly string[]).includes(n) || n.startsWith('X-'));
      if (ov.children.some((c) => c.name === 'VALARM')) carried.push('VALARM');
      remaps.push({
        kind: 'override',
        ordinal,
        oldSlotMs: occ.slotMs,
        newSlotMs: target,
        label: labelOf(occ, graph),
        keptStartMs: occ.startMs,
        carried: [...new Set(carried)],
      });
    } else if (occ.kind === 'extra') {
      remaps.push({
        kind: 'extra',
        ordinal,
        oldSlotMs: occ.slotMs,
        newSlotMs: occ.slotMs, // an explicit extra date keeps its own date
        label: labelOf(occ, graph),
        carried: ['RDATE'],
      });
    }
  }

  const untilRaw = formatDateTime(effectiveFromMs - 1000, {
    isUtc: true,
    isDate: false,
  });

  const oldEndsAtMs = future.length ? future[future.length - 1].slotMs : null;
  const newEndsAtMs = newSlots.length ? newSlots[newSlots.length - 1] : null;

  if (endPolicy === 'keep-end-date' && newSlots.length < neededCount) {
    refusals.push({
      code: 'END_DATE_DROPS_MEETINGS',
      message:
        `Keeping the original end date leaves ${neededCount - newSlots.length} fewer meeting(s), ` +
        `because the last ${(params.byday ?? graph.rule.byday).join('/')} falls before the old end date.`,
      remedy: 'Use the "preserve-count" end policy, or choose a later end date.',
    });
  }

  return {
    ok: refusals.length === 0,
    refusals,
    pastOccurrences: past,
    futureOccurrences: future,
    newSlots,
    remaps,
    naiveLosses,
    oldRuleText: formatRRule(graph.rule),
    newRuleText: formatRRule(newRule),
    untilRaw,
    newDtstartMs,
    newUid: `${graph.uid}-seriessafe-${effectiveFromMs}`,
    summary: graph.summary,
    oldEndsAtMs,
    newEndsAtMs,
    endPolicy,
    endDateShifted:
      oldEndsAtMs !== null && newEndsAtMs !== null &&
      formatDateTime(oldEndsAtMs, { isUtc: true }).slice(0, 8) !==
        formatDateTime(newEndsAtMs, { isUtc: true }).slice(0, 8),
  };
}

function computeNewAnchor(graph: SeriesGraph, params: SplitParams, fromMs: number): number | null {
  const probeRule: RRule = {
    ...graph.rule,
    byday: params.byday && params.byday.length ? params.byday : graph.rule.byday,
    interval: params.interval ?? graph.rule.interval,
    count: undefined,
    until: undefined,
    untilRaw: undefined,
  };
  // Expand from the original DTSTART so week phasing (INTERVAL>1) is preserved,
  // then take the first slot at or after the effective date.
  let base = graph.dtstartMs;
  if (params.timeOfDay) {
    const shifted = applyTimeOfDay(graph.dtstartMs, params.timeOfDay, graph.tzid);
    if (shifted !== null) base = shifted;
  }
  const slots = expandRRule(base, probeRule, graph.tzid, {
    maxMs: fromMs + 400 * 86400_000,
    limit: 4000,
  });
  for (const s of slots) if (s >= fromMs) return s;
  return null;
}

/** Replace the local time-of-day of an instant, keeping its calendar date. */
export function applyTimeOfDay(ms: number, hhmm: string, tzid?: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const hh = +m[1];
  const mm = +m[2];
  if (hh > 23 || mm > 59) return null;
  const day = formatDateTime(ms, { tzid, isDate: true });
  const literal = `${day}T${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}00`;
  const parsed = parseDateTime(literal, tzid);
  return parsed ? parsed.ms : null;
}

function labelOf(occ: Occurrence, graph: SeriesGraph): string {
  const when = formatHuman(occ.slotMs, graph.tzid);
  switch (occ.kind) {
    case 'cancelled':
      return `Cancelled — ${when}`;
    case 'overridden':
      return `${occ.note ?? 'Override'} — ${when}`;
    case 'extra':
      return `Extra date — ${when}`;
    default:
      return when;
  }
}

function describeLoss(occ: Occurrence, graph: SeriesGraph): LossEntry {
  const when = formatHuman(occ.slotMs, graph.tzid);
  if (occ.kind === 'cancelled') {
    return {
      kind: 'cancellation',
      oldSlotMs: occ.slotMs,
      label: `Cancellation on ${when}`,
      detail: 'The date reappears as a normal meeting after a conventional edit.',
    };
  }
  if (occ.kind === 'extra') {
    return {
      kind: 'extra',
      oldSlotMs: occ.slotMs,
      label: `Extra date on ${when}`,
      detail: 'The added one-off date is dropped with the old series.',
    };
  }
  const ov = occ.override!;
  const bits: string[] = [];
  if (occ.startMs !== occ.slotMs) bits.push('its moved date and time');
  for (const n of ['LOCATION', 'DESCRIPTION', 'SUMMARY']) {
    if (getProp(ov, n)) bits.push(n.toLowerCase());
  }
  const att = getProps(ov, 'ATTENDEE').length;
  if (att) bits.push(`${att} attendee override${att === 1 ? '' : 's'}`);
  if (ov.children.some((c) => c.name === 'VALARM')) bits.push('its reminder');
  const xs = ov.props.filter((p) => p.name.startsWith('X-')).length;
  if (xs) bits.push(`${xs} private extension propert${xs === 1 ? 'y' : 'ies'}`);
  return {
    kind: 'override',
    oldSlotMs: occ.slotMs,
    label: `Override on ${when}`,
    detail: `Loses ${bits.length ? bits.join(', ') : 'its customisation'}.`,
  };
}

const humanFmt = new Map<string, Intl.DateTimeFormat>();

export function formatHuman(ms: number, tzid?: string): string {
  const zone = tzid && tzid.length ? tzid : 'UTC';
  let fmt = humanFmt.get(zone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    } catch {
      return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    }
    humanFmt.set(zone, fmt);
  }
  return fmt.format(new Date(ms));
}
