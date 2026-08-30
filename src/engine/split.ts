import { getProp, getProps, getParam } from '../ics/types.ts';
import { formatDateTime, parseDateTime } from '../ics/parse.ts';
import { expandRRule, formatRRule, parseRRule, type RRule } from './rrule.ts';
import { tzOffsetMs, localTimeIsAmbiguous } from '../ics/parse.ts';
import { PRESERVED_PROPS, formatUntil, type SeriesGraph, type Occurrence } from './series.ts';

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
  const unsupported = Object.keys(graph.rule.unsupported);
  if (unsupported.length) {
    const positional = unsupported.filter((k) => UNSAFE_RRULE_PARTS.includes(k));
    refusals.push({
      code: 'UNSUPPORTED_RRULE_PART',
      message: positional.length
        ? `The rule uses ${positional.join(', ')}, which changes how positions are counted.`
        : `The rule uses ${unsupported.join(', ')}, which this engine does not expand exactly.`,
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

  if (graph.timeZoneUnresolved) {
    refusals.push({
      code: 'UNRESOLVED_TIME_ZONE',
      message:
        `The series is written in the time zone "${graph.timeZoneUnresolved}", which this browser cannot ` +
        'resolve, so every instant would be a guess.',
      remedy:
        'Re-export the calendar using an IANA time zone such as Asia/Seoul, or convert the series to UTC.',
    });
  }

  if (graph.unreadableDates.length) {
    refusals.push({
      code: 'UNREADABLE_DATE_VALUE',
      message:
        `This series contains date values this tool cannot read: ${graph.unreadableDates.slice(0, 3).join(', ')}` +
        `${graph.unreadableDates.length > 3 ? ', …' : ''}.`,
      remedy: 'Convert those to plain date or date-time values, then retry.',
    });
  }

  if (graph.truncated) {
    refusals.push({
      code: 'SERIES_TOO_LARGE',
      message: 'The series has more occurrences than this tool will model, so it cannot be checked exhaustively.',
      remedy: 'Split the series into shorter runs, or bound it with an end date, then retry.',
    });
  }

  const past = graph.occurrences.filter((o) => o.slotMs < effectiveFromMs);
  const future = graph.occurrences.filter((o) => o.slotMs >= effectiveFromMs);

  /*
   * An override whose RECURRENCE-ID matches no slot of the current rule has no
   * ordinal, so it cannot be re-anchored. Left alone it stays attached to the
   * old series, which this operation is about to truncate — stranding it after
   * the series has ended. Refuse rather than warn.
   */
  const slotSet = new Set(graph.occurrences.map((o) => o.slotMs));
  const orphansAfter = [...graph.overrides.keys()].filter(
    (ms) => !slotSet.has(ms) && ms >= effectiveFromMs,
  );
  if (orphansAfter.length) {
    refusals.push({
      code: 'ORPHAN_OVERRIDE',
      message:
        `${orphansAfter.length} customised occurrence(s) — the first on ` +
        `${formatHuman(orphansAfter[0], graph.tzid)} — are attached to a date the recurrence rule does ` +
        'not produce, so they have no position to carry across.',
      remedy:
        'Reattach those occurrences to a date the rule generates, or convert them into separate events, ' +
        'then retry.',
    });
  }

  const patternAfter = graph.occurrences.filter(
    (o) => o.slotMs >= effectiveFromMs && o.kind !== 'extra',
  );
  if (future.length > 0 && patternAfter.length === 0) {
    refusals.push({
      code: 'NO_PATTERN_AFTER_DATE',
      message:
        'The repeating rule has already finished by that date; only individually added dates remain, ' +
        'so there is no pattern to move.',
      remedy: 'Edit those dates directly, or choose an earlier effective date.',
    });
  }

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

  /*
   * Ordinal alignment carries an exception from the Nth remaining old slot to
   * the Nth new slot. That preserves the *week* an exception belongs to only
   * while both rules produce the same number of slots per period. Going from
   * two days a week to three makes slot #6 land a week early, quietly
   * cancelling the wrong class — so the cadence must not change.
   */
  const oldDaysPerWeek = graph.rule.byday.length || 1;
  const newDaysPerWeek = (params.byday && params.byday.length ? params.byday : graph.rule.byday).length || 1;
  /*
   * The cadence rule exists to protect exceptions, which are carried by week.
   * A series with nothing to carry after the effective date has nothing at
   * risk, so refusing it is pure obstruction: changing a plain weekly standup
   * to twice weekly is an ordinary thing to want.
   */
  const hasFutureExceptions = graph.occurrences.some(
    (o) => o.slotMs >= effectiveFromMs && o.kind !== 'normal',
  );
  if (oldDaysPerWeek !== newDaysPerWeek && hasFutureExceptions) {
    refusals.push({
      code: 'CADENCE_CHANGED',
      message:
        `The series meets ${oldDaysPerWeek} time(s) per period and the new rule would meet ` +
        `${newDaysPerWeek} time(s). Exceptions are anchored by position, so they can no longer be ` +
        'matched to the right week.',
      remedy:
        'Keep the same number of days per period when moving the series, then add or remove days as a ' +
        'separate change.',
    });
  }
  if (params.interval !== undefined && params.interval !== graph.rule.interval && hasFutureExceptions) {
    refusals.push({
      code: 'CADENCE_CHANGED',
      message:
        `Changing the interval from ${graph.rule.interval} to ${params.interval} shifts every position ` +
        'onto a different week, so existing exceptions cannot be re-anchored safely.',
      remedy: 'Move the series first, then change the interval as a separate change.',
    });
  }

  const newRule: RRule = {
    ...graph.rule,
    byday: params.byday && params.byday.length ? params.byday : graph.rule.byday,
    interval: params.interval ?? graph.rule.interval,
    count: undefined,
  };

  if (endPolicy === 'preserve-count' && !graph.unbounded) {
    // An explicit COUNT is unambiguous: the user keeps every remaining meeting
    // even though the last one now lands on a different weekday.
    newRule.count = neededCount;
    newRule.until = undefined;
    newRule.untilRaw = undefined;
  } else if (graph.unbounded) {
    // A series with no end keeps no end. Writing a COUNT here would quietly
    // convert a standing meeting into a finite run.
    newRule.count = undefined;
    newRule.until = undefined;
    newRule.untilRaw = undefined;
  } else if (endPolicy === 'keep-end-date' && graph.rule.count !== undefined) {
    /*
     * A COUNT rule states a number, not a date. Clearing the COUNT and having
     * no UNTIL to inherit turned a ten-week course into a meeting that never
     * ends. "Keep the end date" for such a series means the date its last
     * occurrence would have fallen on.
     */
    const lastOld = graph.occurrences.length
      ? graph.occurrences[graph.occurrences.length - 1].slotMs
      : effectiveFromMs;
    newRule.until = lastOld;
    newRule.untilRaw = formatUntil(graph, lastOld);
  }

  // New DTSTART: the first slot of the new rule at or after the effective date,
  // carrying the requested time of day.
  if (params.timeOfDay !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(params.timeOfDay.trim())) {
    refusals.push({
      code: 'INVALID_TIME_OF_DAY',
      message: `"${params.timeOfDay}" is not a time I can read.`,
      remedy: 'Give the new start time as HH:MM on a 24-hour clock, for example 19:00.',
    });
  }

  /*
   * The generated rule is checked for the same capabilities as the input one.
   * Adding BYDAY to a DAILY series produced `FREQ=DAILY;BYDAY=TH`, which this
   * engine expanded as consecutive days while every other reader takes it as
   * Thursdays — a rule SeriesSafe wrote and cannot itself honour.
   */
  const producedUnsupported = Object.keys(parseRRule(formatRRule(newRule)).unsupported);
  if (producedUnsupported.length && !unsupported.length) {
    refusals.push({
      code: 'UNSUPPORTED_RESULT_RULE',
      message:
        `That change would produce ${formatRRule(newRule)}, which uses ${producedUnsupported.join(', ')} in a ` +
        'way this engine does not expand exactly.',
      remedy: `Keep the series weekly when choosing days, or leave the days as they are.`,
    });
  }

  // A date-only series has no time of day to set.
  if (params.timeOfDay !== undefined && graph.isDate) {
    refusals.push({
      code: 'TIME_ON_ALL_DAY_SERIES',
      message: 'This is an all-day series, so it has no start time to change.',
      remedy: 'Remove the time, or convert the series to a timed one first.',
    });
  }

  const anchor = computeNewAnchor(graph, params, effectiveFromMs);
  if (anchor === null) {
    refusals.push({
      code: 'NO_NEW_ANCHOR',
      message: 'The new rule produces no occurrence on or after the effective date.',
      remedy: 'Pick different days or a different effective date.',
    });
  }

  /*
   * A requested time that does not exist on the first new date cannot be
   * written down. Resolving 02:30 forward to 03:30 on a spring-forward Sunday
   * is right for that one occurrence, but it was then serialized as the new
   * DTSTART — making every later Sunday 03:30 too. Refuse rather than move a
   * whole series by an hour.
   */
  if (anchor !== null && !graph.isDate && !graph.timeZoneUnresolved) {
    /*
     * Read through the same offset path the rest of the engine uses, so a zone
     * the calendar defines for itself resolves here too — Intl would throw on
     * `Pacific Standard Time`.
     */
    const wallTime = (ms: number) => {
      const literal = formatDateTime(ms, { tzid: graph.tzid, isUtc: graph.isUtc && !graph.tzid });
      const m = /T(\d{2})(\d{2})/.exec(literal);
      return m ? `${m[1]}:${m[2]}` : '';
    };
    // The requested time, or the one the series already keeps.
    const asked = params.timeOfDay?.trim() ?? wallTime(graph.dtstartMs);
    const got = wallTime(anchor);
    if (got !== asked) {
      refusals.push({
        code: 'TIME_DOES_NOT_EXIST',
        message:
          `${asked} does not exist on ${formatHuman(anchor, graph.tzid)} — the clocks move forward that ` +
          `day, so the nearest real time is ${got}.`,
        remedy: 'Pick a different start time, or an effective date outside the changeover.',
      });
    }
  }

  const newDtstartMs = anchor ?? effectiveFromMs;
  const horizon = Math.max(
    future.length ? future[future.length - 1].slotMs : newDtstartMs,
    graph.modelledUntilMs,
  ) + 400 * 86400_000;
  const newSlots = anchor === null
    ? []
    : expandRRule(newDtstartMs, newRule, graph.tzid, { maxMs: horizon, limit: 2000 });

  // ---- ordinal alignment --------------------------------------------
  const remaps: RemapEntry[] = [];
  const naiveLosses: LossEntry[] = [];

  /*
   * Exceptions are carried by *week*, not by a flat position.
   *
   * "That week is off" is what the user meant, so an exception moves to the
   * slot holding the same place in the same week. A flat ordinal only agrees
   * with that while every week has the same number of slots on both sides —
   * and it silently disagrees in the boundary week, where the effective date
   * can cut a different number of meetings from each rule. Moving a Tue/Thu
   * class to Mon/Wed from a Tuesday put a Thursday cancellation on the
   * *following* Monday.
   */
  const patternFuture = future.filter((o) => o.kind !== 'extra');
  const wkst = graph.rule.wkst;
  const oldWeeks = byWeek(patternFuture.map((o) => o.slotMs), graph.tzid, wkst);
  const newWeeks = byWeek(newSlots, graph.tzid, wkst);

  const specialFuture = future.filter((o) => o.kind !== 'normal');
  for (const occ of specialFuture) {
    let target: number | undefined;
    let ordinal = -1;
    if (occ.kind === 'extra') {
      target = occ.slotMs;
    } else {
      const week = weekKey(occ.slotMs, graph.tzid, wkst);
      const oldRow = oldWeeks.get(week) ?? [];
      const newRow = newWeeks.get(week) ?? [];
      ordinal = oldRow.indexOf(occ.slotMs);
      if (oldRow.length !== newRow.length) {
        refusals.push({
          code: 'WEEK_NOT_ALIGNED',
          message:
            `The week of ${formatHuman(week, graph.tzid)} has ${oldRow.length} meeting(s) under the old rule ` +
            `and ${newRow.length} under the new one, so "${labelOf(occ, graph)}" cannot be matched to a slot ` +
            'in the same week.',
          remedy:
            'Choose an effective date at the start of a week, or keep the same days so each week lines up.',
        });
        continue;
      }
      target = newRow[ordinal];
    }

    // Everything special in the future is destroyed by the conventional edit.
    naiveLosses.push(describeLoss(occ, graph));

    if (target === undefined) {
      refusals.push({
        code: 'ORDINAL_OUT_OF_RANGE',
        message: `The new rule has no slot in that week to carry "${labelOf(occ, graph)}".`,
        remedy: 'Extend the new rule, or handle that occurrence separately.',
      });
      continue;
    }

    if (occ.kind === 'cancelled' && occ.override) {
      /*
       * A cancellation expressed as STATUS:CANCELLED on a detached override is
       * the RFC's way of calling an occurrence off while keeping what was
       * attached to it — a note, a reminder, a record of who was told. Turning
       * it into a bare EXDATE would drop all of that and strand the original
       * event on the series being truncated. It moves as an override instead.
       */
      const ov = occ.override;
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
      // The same slot may *also* carry an EXDATE, with parameters of its own.
      // Collapsing the two into one override dropped that line entirely.
      if (graph.exdates.includes(occ.slotMs)) {
        remaps.push({
          kind: 'cancellation',
          ordinal,
          oldSlotMs: occ.slotMs,
          newSlotMs: target,
          label: labelOf(occ, graph),
          carried: ['EXDATE'],
        });
      }
    } else if (occ.kind === 'cancelled') {
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

  /*
   * An RDATE naming a date the rule already produces is redundant as a date,
   * but it still carries whatever was written on it. Such a value is not an
   * `extra` occurrence, so nothing was carrying it and it vanished from the
   * output entirely. It moves with the slot it coincides with.
   */
  /*
   * An all-day value names a calendar date, not an instant. Comparing its UTC
   * midnight against a zoned boundary put a date-valued RDATE on the wrong
   * side of the split — an added date on the very day of the change stayed
   * with the series being ended.
   */
  const dayOf = (ms: number) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(ms));
  const effectiveDay = (() => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: graph.tzid && graph.tzid.length ? graph.tzid : 'UTC',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(effectiveFromMs));
    } catch {
      return dayOf(effectiveFromMs);
    }
  })();
  const isAfterBoundary = (e: { ms: number; isDate: boolean }) =>
    e.isDate ? dayOf(e.ms) >= effectiveDay : e.ms >= effectiveFromMs;

  for (const entry of graph.rdateEntries) {
    if (!isAfterBoundary(entry)) continue;
    if (remaps.some((r) => r.oldSlotMs === entry.ms && r.kind === 'extra')) continue;
    const week = weekKey(entry.ms, graph.tzid, graph.rule.wkst);
    const oldRow = oldWeeks.get(week) ?? [];
    const newRow = newWeeks.get(week) ?? [];
    const at = oldRow.indexOf(entry.ms);
    const target = at >= 0 ? newRow[at] : undefined;
    if (target !== undefined) {
      remaps.push({
        kind: 'extra',
        ordinal: at,
        oldSlotMs: entry.ms,
        newSlotMs: target,
        label: `Added date — ${formatHuman(entry.ms, graph.tzid)}`,
        carried: ['RDATE'],
      });
    } else {
      // It coincides with a slot the new rule has no counterpart for. Dropping
      // it silently is exactly what this tool exists to prevent.
      refusals.push({
        code: 'ADDED_DATE_NOT_ALIGNED',
        message:
          `The added date on ${formatHuman(entry.ms, graph.tzid)} falls on a meeting the new rule does not ` +
          'have a matching slot for.',
        remedy: 'Choose an effective date at the start of a week, or handle that date separately.',
      });
    }
  }

  // UNTIL must share DTSTART's value type (RFC 5545 §3.3.10).
  /*
   * An occurrence on a clock change cannot be written down unambiguously: a
   * spring-forward gap has no such time, and an autumn fold has two. Checking
   * only the first new date left later ones to be generated at the corrected
   * time — inventing a meeting the original series never had — and a one-hour
   * meeting inside a fold serialized as zero minutes long.
   */
  if (!graph.isDate && graph.tzid && anchor !== null) {
    const wallOf = (ms: number) => {
      const m = /T(\d{2})(\d{2})/.exec(formatDateTime(ms, { tzid: graph.tzid }));
      return m ? `${m[1]}:${m[2]}` : '';
    };
    // The time the series is meant to keep, taken from its first new date.
    const intended = wallOf(anchor);
    const clash = newSlots.find((ms) => {
      // A gap: the intended time does not exist, and expansion has quietly
      // produced the corrected one instead.
      if (wallOf(ms) !== intended) return true;
      // A fold: two instants share one wall clock. That applies to the end of
      // a meeting as much as its start — an hour spanning the change was
      // written with identical start and end, a meeting zero minutes long.
      if (localTimeIsAmbiguous(ms, graph.tzid)) return true;
      return graph.durationMs > 0 && localTimeIsAmbiguous(ms + graph.durationMs, graph.tzid);
    });
    if (clash !== undefined) {
      refusals.push({
        code: 'CLOCK_CHANGE_COLLISION',
        message:
          `The clocks change around ${formatHuman(clash, graph.tzid)}, so a meeting at ${intended} that ` +
          'day either does not exist or happens twice.',
        remedy: 'Move the series to a different time of day, or handle that week separately.',
      });
    }
  }

  const untilRaw = formatUntil(graph, effectiveFromMs - 1000);

  const oldEndsAtMs = future.length ? future[future.length - 1].slotMs : null;
  const newEndsAtMs = newSlots.length ? newSlots[newSlots.length - 1] : null;

  if (endPolicy === 'keep-end-date' && newSlots.length < neededCount) {
    refusals.push({
      code: 'END_DATE_DROPS_MEETINGS',
      message:
        `Keeping the original end date leaves ${neededCount - newSlots.length} fewer meeting(s), ` +
        `because the last ${dayWords(params.byday ?? graph.rule.byday)} falls before the old end date.`,
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

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

const DAY_NAMES: Record<string, string> = {
  SU: 'Sunday', MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday',
  TH: 'Thursday', FR: 'Friday', SA: 'Saturday',
};

/** Turn BYDAY codes into words, for messages a person reads. */
function dayWords(codes: string[]): string {
  const names = codes.map((c) => DAY_NAMES[c.replace(/^[+-]?\d+/, '').toUpperCase()] ?? c);
  if (names.length <= 1) return names[0] ?? 'day';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The start of the week an instant belongs to, in the series' own zone,
 * anchored at the rule's WKST. Used as the identity an exception is carried by.
 */
function weekKey(ms: number, tzid: string | undefined, wkst: string): number {
  const offset = tzid ? tzOffsetMs(ms, tzid) : 0;
  const local = new Date(ms + offset);
  const wkstIdx = Math.max(0, DAY_CODES.indexOf(wkst));
  const back = (local.getUTCDay() - wkstIdx + 7) % 7;
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - back);
}

/** Group instants by the week they fall in, preserving order within a week. */
function byWeek(slots: number[], tzid: string | undefined, wkst: string): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const s of slots) {
    const k = weekKey(s, tzid, wkst);
    const arr = m.get(k);
    if (arr) arr.push(s);
    else m.set(k, [s]);
  }
  return m;
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
