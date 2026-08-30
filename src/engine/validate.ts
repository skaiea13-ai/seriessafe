import { type Component, type Prop, getProp, getParam } from '../ics/types.ts';
import { parseIcs, parseDateTime, isKnownTimeZone } from '../ics/parse.ts';
import { serializeIcs } from '../ics/serialize.ts';
import { buildSeriesGraph, formatLike, type SeriesGraph } from './series.ts';
import { parseRRule } from './rrule.ts';
import { formatHuman, type SplitPlan } from './split.ts';

export interface Check {
  id: string;
  title: string;
  pass: boolean;
  /** Concrete evidence, shown verbatim in the UI and returned to the agent. */
  evidence: string;
}

export interface ValidationReport {
  pass: boolean;
  checks: Check[];
  /** Items a conventional edit would have destroyed, confirmed still present. */
  preservedCount: number;
  checkedAt: number;
}

/**
 * The form a date property was written in, beyond the instant it resolves to.
 *
 * Two properties can name the same instant today and diverge later: dropping
 * `TZID=Europe/London` from a November date leaves the same moment but a
 * different rule. Comparing instants alone let that through, so the value kind
 * and zone are part of the identity.
 */
function dateForm(p: Prop): string {
  const value = (getParam(p, 'VALUE') ?? '').toUpperCase();
  const tzid = getParam(p, 'TZID') ?? '';
  const utc = /Z$/.test(p.value.split(',')[0] ?? '') ? 'UTC' : '';
  return `${value}|${tzid}|${utc}`;
}

/** The form this series' rewritten date properties must take. */
function expectedForm(g: SeriesGraph): string {
  if (g.isDate) return 'DATE||';
  if (g.isUtc) return '||UTC';
  return `|${g.tzid ?? ''}|`;
}

/** A property's full identity: name, value, and parameters in order. */
function propKey(p: Prop): string {
  return `${p.name}|${p.value}|${JSON.stringify(p.params.map((x) => [x.name, x.values]))}`;
}

/** Count each distinct property, so multiplicity is part of the comparison. */
function propCounts(props: Prop[], skip: (name: string) => boolean): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of props) {
    if (skip(p.name)) continue;
    const k = propKey(p);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

interface Rendered {
  slotMs: number;
  startMs: number;
  cancelled: boolean;
  overridden: boolean;
}

/**
 * Render a series from a *re-parsed* calendar: expand the rule, remove EXDATEs
 * and let detached overrides replace their slots. Validation deliberately works
 * from the serialized bytes rather than from in-memory objects, so a bug in the
 * writer cannot pass unnoticed.
 */
function render(cal: Component, uid: string, horizonMs?: number): Rendered[] {
  const g = buildSeriesGraph(cal, uid, horizonMs);
  if (!g) return [];
  return g.occurrences.map((o) => ({
    slotMs: o.slotMs,
    startMs: o.startMs,
    cancelled: o.kind === 'cancelled',
    overridden: o.kind === 'overridden',
  }));
}

/**
 * A canonical fingerprint covering everything a component carries: property
 * parameters and nested components included.
 *
 * Comparing only `NAME=value` and an alarm *count* left real changes invisible.
 * A reminder retimed from -PT30M to -PT5M, or an attendee stripped of their
 * CN, ROLE and PARTSTAT, both passed while the evidence line claimed the
 * properties were verified byte-for-byte.
 */
function propFingerprint(c: Component): string {
  // Parameter *order within a value list* is preserved: `X-P=a,b` and
  // `X-P=b,a` are not the same thing, and normalising them is not this tool's
  // call for a parameter it does not understand.
  const params = (p: { params: Array<{ name: string; values: string[] }> }) =>
    JSON.stringify(p.params.map((x) => [x.name, x.values]));
  const props = c.props
    .map((p) => `${p.name}${params(p)}=${p.value}`)
    .sort()
    .join('|');
  const kids = c.children.map(propFingerprint).sort().join('&');
  return `${c.name}{${props}}(${kids})`;
}

/**
 * Verify a staged patch against the invariants that make the operation safe.
 *
 * Every check is evidence-bearing: it names the dates and properties it looked
 * at, so a failure tells the agent what to fix rather than only that something
 * broke.
 */
export function validateStage(
  original: Component,
  patched: Component,
  before: SeriesGraph,
  plan: SplitPlan,
): ValidationReport {
  const checks: Check[] = [];
  // Round-trip through text so we validate what will actually be written out.
  const reparsed = parseIcs(serializeIcs(patched));
  const effective = plan.futureOccurrences[0]?.slotMs ?? Infinity;
  const tz = before.tzid;

  /*
   * Every rendering is bounded by the same instant. Comparing counts across
   * differently-sized windows is how a truncated model can look balanced: the
   * old and new series start on different dates, so left to themselves they
   * would each pick their own horizon.
   */
  const window = Math.max(
    before.modelledUntilMs,
    plan.newEndsAtMs ?? 0,
    plan.oldEndsAtMs ?? 0,
  );
  const oldAfter = render(reparsed, before.uid, window);
  const newAfter = render(reparsed, plan.newUid, window);
  const origBefore = render(original, before.uid, window);

  const fmt = (ms: number) => formatHuman(ms, tz);

  // 1. Nothing before the effective date moved — in timing *or* in content.
  {
    const pastBefore = origBefore.filter((o) => o.slotMs < effective);
    const pastAfter = oldAfter.filter((o) => o.slotMs < effective);
    const timingSame =
      pastBefore.length === pastAfter.length &&
      pastBefore.every((o, i) => o.slotMs === pastAfter[i].slotMs && o.startMs === pastAfter[i].startMs);

    /*
     * Matching instants is not enough: a past override could keep its date and
     * still be stripped of its room, its guests or its alarm. Compare the full
     * property fingerprint of every override that stays behind, and the
     * carried properties of the truncated master.
     */
    const pastOverrideIds = [...before.overrides.keys()].filter((ms) => ms < effective);
    const fingerprintOf = (cal: Component, uid: string, ridValue: string): string | null => {
      const ev = cal.children.find(
        (c) =>
          c.name === 'VEVENT' &&
          (getProp(c, 'UID')?.value ?? '') === uid &&
          getProp(c, 'RECURRENCE-ID')?.value === ridValue,
      );
      return ev ? propFingerprint(ev) : null;
    };
    const contentProblems: string[] = [];
    for (const ms of pastOverrideIds) {
      const src = before.overrides.get(ms)!;
      const rid = getProp(src, 'RECURRENCE-ID')!.value;
      const a = fingerprintOf(original, before.uid, rid);
      const b = fingerprintOf(reparsed, before.uid, rid);
      if (b === null) contentProblems.push(`the ${fmt(ms)} override is gone`);
      else if (a !== b) contentProblems.push(`the ${fmt(ms)} override was altered`);
    }
    // The master is deliberately re-written (UNTIL, EXDATE, SEQUENCE), so only
    // the properties that carry user intent are compared.
    const oldMasterAfter = reparsed.children.find(
      (c) => c.name === 'VEVENT' && (getProp(c, 'UID')?.value ?? '') === before.uid && !getProp(c, 'RECURRENCE-ID'),
    );
    const REWRITTEN = ['RRULE', 'EXDATE', 'RDATE', 'SEQUENCE', 'DTSTAMP', 'LAST-MODIFIED'];
    if (!oldMasterAfter) contentProblems.push('the original series master is gone');
    else {
      // Compared with parameters, and by multiplicity, so a duplicated or
      // subtly altered property cannot pass as present.
      const skipOld = (n: string) => REWRITTEN.includes(n);
      const wanted = propCounts(before.master.props, skipOld);
      const found = propCounts(oldMasterAfter.props, skipOld);
      for (const [k, n] of wanted) {
        if ((found.get(k) ?? 0) !== n) contentProblems.push(`${k.split('|')[0]} lost or altered on the original series`);
      }
      for (const [k, n] of found) {
        if ((wanted.get(k) ?? 0) !== n) contentProblems.push(`${k.split('|')[0]} was added to the original series`);
      }
      const alarmsA = before.master.children.filter((c) => c.name === 'VALARM').map(propFingerprint).sort();
      const alarmsB = oldMasterAfter.children.filter((c) => c.name === 'VALARM').map(propFingerprint).sort();
      if (alarmsA.join('|') !== alarmsB.join('|')) {
        contentProblems.push('a reminder on the original series was lost or changed');
      }
    }

    const same = timingSame && contentProblems.length === 0;
    checks.push({
      id: 'past-immutable',
      title: 'Every occurrence before the effective date is unchanged',
      pass: same,
      evidence: !timingSame
        ? `Past occurrences differ: ${pastBefore.length} before vs ${pastAfter.length} after.`
        : contentProblems.length
        ? contentProblems.join('; ')
        : `${pastBefore.length} past occurrences match exactly, from ${fmt(pastBefore[0]?.slotMs ?? 0)} to ` +
          `${fmt(pastBefore[pastBefore.length - 1]?.slotMs ?? 0)}, with ${pastOverrideIds.length} ` +
          `customised one(s) byte-for-byte identical.`,
    });
  }

  // 2. The old series stops at the boundary.
  {
    const stray = oldAfter.filter((o) => o.slotMs >= effective);
    checks.push({
      id: 'old-series-bounded',
      title: 'The original series produces nothing on or after the effective date',
      pass: stray.length === 0,
      evidence: stray.length === 0
        ? `The original rule now ends at ${plan.untilRaw}.`
        : `${stray.length} stray occurrence(s), first at ${fmt(stray[0].slotMs)}.`,
    });
  }

  // 3. Every re-anchored cancellation is still cancelled.
  {
    const wanted = plan.remaps.filter((r) => r.kind === 'cancellation');
    const missing = wanted.filter(
      (r) => !newAfter.some((o) => o.slotMs === r.newSlotMs && o.cancelled),
    );
    checks.push({
      id: 'cancellations-preserved',
      title: 'Cancelled dates are still cancelled after the move',
      pass: missing.length === 0,
      evidence: missing.length === 0
        ? wanted.length
          ? wanted.map((r) => `${fmt(r.oldSlotMs)} → ${fmt(r.newSlotMs)} still cancelled`).join('; ')
          : 'No cancellations fall after the effective date.'
        : `Reappeared as normal meetings: ${missing.map((r) => fmt(r.newSlotMs)).join(', ')}.`,
    });
  }

  // 4. Every re-anchored override exists exactly once and kept its own time.
  {
    const wanted = plan.remaps.filter((r) => r.kind === 'override');
    const problems: string[] = [];
    for (const r of wanted) {
      const hits = reparsed.children.filter((c) => {
        if (c.name !== 'VEVENT') return false;
        if ((getProp(c, 'UID')?.value ?? '') !== plan.newUid) return false;
        const rid = getProp(c, 'RECURRENCE-ID');
        if (!rid) return false;
        // Formatted in the series' own value type, or the UTC form is missing
        // its Z and nothing matches. RANGE=THISANDFUTURE on an anchor applies
        // to every later occurrence, so an anchor that gained one is not the
        // anchor that was planned.
        if ((getParam(rid, 'RANGE') ?? '') !== '') return false;
        return rid.value === formatLike(before, r.newSlotMs);
      });
      if (hits.length !== 1) {
        problems.push(`${fmt(r.oldSlotMs)} resolved to ${hits.length} events (expected exactly 1)`);
        continue;
      }
      const slot = newAfter.find((o) => o.slotMs === r.newSlotMs);
      const src = before.overrides.get(r.oldSlotMs);
      const isCancellation =
        (src && (getProp(src, 'STATUS')?.value ?? '').toUpperCase() === 'CANCELLED') || false;
      if (!slot) {
        problems.push(`${fmt(r.oldSlotMs)} has no occurrence at its new slot`);
      } else if (isCancellation) {
        // A called-off occurrence has no start time to keep; what matters is
        // that it is still called off, and still carries what was attached.
        if (!slot.cancelled) {
          problems.push(`${fmt(r.oldSlotMs)} was called off but is no longer cancelled`);
        }
      } else {
        // A deliberately relocated occurrence keeps the date the user chose; a
        // metadata-only one has no date of its own and belongs at the new slot.
        const relocated = r.keptStartMs !== undefined && r.keptStartMs !== r.oldSlotMs;
        const want = relocated ? r.keptStartMs! : r.newSlotMs;
        if (slot.startMs !== want) {
          problems.push(
            `${fmt(r.oldSlotMs)} should ${relocated ? 'still start' : 'now start'} at ${fmt(want)} ` +
              `but starts at ${fmt(slot.startMs)}`,
          );
        }
      }
    }
    checks.push({
      id: 'overrides-reanchored',
      title: 'Moved and customised occurrences survive, exactly once, at their own time',
      pass: problems.length === 0,
      evidence: problems.length === 0
        ? wanted.length
          ? wanted
              .map((r) => `${fmt(r.oldSlotMs)} → slot ${fmt(r.newSlotMs)}, still starts ${fmt(r.keptStartMs ?? 0)}`)
              .join('; ')
          : 'No detached overrides fall after the effective date.'
        : problems.join('; '),
    });
  }

  // 5. Properties, alarms and X- extensions carried across.
  {
    const problems: string[] = [];
    const contentProblemsOfStart: string[] = [];
    let carried = 0;
    for (const r of plan.remaps.filter((x) => x.kind === 'override')) {
      const src = before.overrides.get(r.oldSlotMs);
      const dst = reparsed.children.find((c) => {
        if (c.name !== 'VEVENT') return false;
        if ((getProp(c, 'UID')?.value ?? '') !== plan.newUid) return false;
        const rid = getProp(c, 'RECURRENCE-ID');
        return !!rid && rid.value === formatLike(before, r.newSlotMs);
      });
      if (!src || !dst) continue;
      // Counted, not merely found: two identical properties must still be two.
      // DTSTART and DTEND are compared as instants just below, because a
      // metadata-only override legitimately moves with its slot while a
      // relocated one legitimately does not.
      const skipOverride = (n: string) =>
        ['UID', 'RECURRENCE-ID', 'DTSTART', 'DTEND', 'SEQUENCE', 'DTSTAMP', 'LAST-MODIFIED'].includes(n) ||
        n.startsWith('X-SERIESSAFE-');
      const wantOv = propCounts(src.props, skipOverride);
      const gotOv = propCounts(dst.props, skipOverride);
      for (const [k, n] of wantOv) {
        if ((gotOv.get(k) ?? 0) !== n) problems.push(`${k.split('|')[0]} lost or altered on the ${fmt(r.oldSlotMs)} occurrence`);
        else carried += n;
      }
      for (const [k, n] of gotOv) {
        if ((wantOv.get(k) ?? 0) !== n) problems.push(`${k.split('|')[0]} was added to the ${fmt(r.oldSlotMs)} occurrence`);
      }

      /*
       * An override that was deliberately relocated keeps the date the user
       * chose. One that only changed metadata has no date of its own, so it
       * belongs at the new slot — leaving it behind stranded it on the old
       * weekday while its anchor moved.
       */
      const wasRelocated = r.keptStartMs !== undefined && r.keptStartMs !== r.oldSlotMs;
      const wantStartMs = wasRelocated ? r.keptStartMs! : r.newSlotMs;
      const resolveOn = (c: Component, name: string) => {
        const p = getProp(c, name);
        if (!p) return undefined;
        const tz = getParam(p, 'TZID');
        if (tz && !isKnownTimeZone(tz)) return null;
        return parseDateTime(p.value, tz ?? before.tzid)?.ms ?? null;
      };
      const gotOvStart = resolveOn(dst, 'DTSTART');
      if (gotOvStart !== undefined && gotOvStart !== wantStartMs) {
        problems.push(
          `the ${fmt(r.oldSlotMs)} occurrence should start at ${fmt(wantStartMs)} but starts at ` +
            `${gotOvStart === null ? '(unreadable)' : fmt(gotOvStart)}`,
        );
      }
      const srcEnd = resolveOn(src, 'DTEND');
      const srcStart = resolveOn(src, 'DTSTART');
      if (srcEnd != null && srcStart != null) {
        const ownDuration = srcEnd - srcStart;
        const gotOvEnd = resolveOn(dst, 'DTEND');
        if (gotOvEnd !== undefined && gotOvEnd !== wantStartMs + ownDuration) {
          problems.push(`the ${fmt(r.oldSlotMs)} occurrence changed length`);
        }
      }
      const srcAlarms = src.children.filter((c) => c.name === 'VALARM').map(propFingerprint).sort();
      const dstAlarms = dst.children.filter((c) => c.name === 'VALARM').map(propFingerprint).sort();
      if (srcAlarms.join('|') !== dstAlarms.join('|')) {
        problems.push(`a reminder on ${fmt(r.oldSlotMs)} was lost or changed`);
      } else carried += srcAlarms.length;
    }
    // The new master must keep the roster, alarms and private extensions.
    const newMaster = reparsed.children.find(
      (c) => c.name === 'VEVENT' && (getProp(c, 'UID')?.value ?? '') === plan.newUid && !getProp(c, 'RECURRENCE-ID'),
    );
    if (newMaster) {
      const skipMaster = (n: string) =>
        ['UID', 'DTSTART', 'DTEND', 'RRULE', 'EXDATE', 'RDATE', 'SEQUENCE', 'DTSTAMP', 'LAST-MODIFIED'].includes(n) ||
        n.startsWith('X-SERIESSAFE-');
      const wantM = propCounts(before.master.props, skipMaster);
      const gotM = propCounts(newMaster.props, skipMaster);
      for (const [k, n] of wantM) {
        if ((gotM.get(k) ?? 0) !== n) problems.push(`${k.split('|')[0]} lost or altered on the new series`);
        else carried += n;
      }
      // And the other way: a property that appeared from nowhere is a change
      // too. Adding STATUS:CANCELLED to the new series used to pass.
      for (const [k, n] of gotM) {
        if ((wantM.get(k) ?? 0) !== n) problems.push(`${k.split('|')[0]} was added to the new series`);
      }

      /*
       * DTSTART and DTEND are rewritten, so they are excluded above — which
       * left them unchecked entirely. A changed TZID on DTSTART moved the
       * whole future series by an hour, and a changed DTEND turned a one-hour
       * class into a four-hour one, both with every check green. They are
       * compared as resolved instants, not as text.
       */
      const wantForm = expectedForm(before);
      const resolved = (p: Prop | undefined) => {
        if (!p) return null;
        const tz = getParam(p, 'TZID');
        if (tz && !isKnownTimeZone(tz)) return null;
        return parseDateTime(p.value, tz ?? undefined)?.ms ?? null;
      };
      /*
       * Parameters riding on the rewritten date properties, beyond VALUE and
       * TZID, are still the user's. Rewriting the value is not licence to drop
       * an X- parameter that came with it.
       */
      const extraParams = (p: Prop | undefined) =>
        JSON.stringify(
          (p?.params ?? []).filter((x) => x.name !== 'VALUE' && x.name !== 'TZID').map((x) => [x.name, x.values]),
        );
      for (const nameOf of ['DTSTART', 'DTEND'] as const) {
        const had = getProp(before.master, nameOf);
        const has = getProp(newMaster, nameOf);
        if (had && has && extraParams(had) !== extraParams(has)) {
          contentProblemsOfStart.push(`${nameOf} lost or gained parameters on the new series`);
        }
      }

      const startProp2 = getProp(newMaster, 'DTSTART');
      const gotStart = resolved(startProp2);
      if (gotStart !== plan.newDtstartMs) {
        contentProblemsOfStart.push(
          `the new series starts at ${gotStart === null ? '(unreadable)' : fmt(gotStart)}, not ${fmt(plan.newDtstartMs)}`,
        );
      } else if (startProp2 && dateForm(startProp2) !== wantForm) {
        contentProblemsOfStart.push('the start was written in a different time-zone or value form than the series uses');
      }

      /*
       * The way an event states its length is part of it: DTEND, DURATION, or
       * neither. Checking DTEND only when present meant deleting it passed.
       */
      const hadEnd = Boolean(getProp(before.master, 'DTEND'));
      const hadDuration = Boolean(getProp(before.master, 'DURATION'));
      const hasEnd = Boolean(getProp(newMaster, 'DTEND'));
      const hasDuration = Boolean(getProp(newMaster, 'DURATION'));
      if (hadEnd !== hasEnd || hadDuration !== hasDuration) {
        contentProblemsOfStart.push(
          `the new series states its length differently: ` +
            `${hadEnd ? 'DTEND' : hadDuration ? 'DURATION' : 'neither'} became ` +
            `${hasEnd ? 'DTEND' : hasDuration ? 'DURATION' : 'neither'}`,
        );
      }
      const dtendProp = getProp(newMaster, 'DTEND');
      if (dtendProp) {
        const gotEnd = resolved(dtendProp);
        const wantEnd = plan.newDtstartMs + before.durationMs;
        if (gotEnd !== wantEnd) {
          contentProblemsOfStart.push(
            `each meeting would run to ${gotEnd === null ? '(unreadable)' : fmt(gotEnd)} instead of ${fmt(wantEnd)}`,
          );
        } else if (dateForm(dtendProp) !== wantForm) {
          contentProblemsOfStart.push('the end was written in a different time-zone or value form than the series uses');
        }
      }
      const a = before.master.children.filter((c) => c.name === 'VALARM').map(propFingerprint).sort();
      const b = newMaster.children.filter((c) => c.name === 'VALARM').map(propFingerprint).sort();
      if (a.join('|') !== b.join('|')) problems.push('a reminder on the new series was lost or changed');
      else carried += a.length;
    } else {
      problems.push('the new series master is missing');
    }
    /*
     * Date lists were never compared, so anything riding on an EXDATE or RDATE
     * could vanish with every check green. For each original value, a value
     * must exist in the output — at its re-anchored instant when it moved —
     * carrying the same parameters.
     */
    // The full parameter set, VALUE and TZID included: an RDATE may legally be
    // a DATE on a timed series, or carry a zone of its own, and the writer now
    // preserves that rather than normalising it to the series' form.
    const paramKey = (ps: Prop['params']) => JSON.stringify(ps.map((p) => [p.name, p.values]));
    /*
     * Each output value is resolved using the parameters *it* carries, so a
     * dropped or altered TZID is caught. Comparing the literal text alone let
     * `RDATE;TZID=Asia/Seoul:20261111T190000` lose its zone and move nine
     * hours with every check green.
     */
    const outEntries = (name: string, uid: string) => {
      const master = reparsed.children.find(
        (c) => c.name === 'VEVENT' && (getProp(c, 'UID')?.value ?? '') === uid && !getProp(c, 'RECURRENCE-ID'),
      );
      const out: Array<{ ms: number | null; key: string; form: string; zoneOk: boolean }> = [];
      for (const p of master?.props.filter((x) => x.name === name) ?? []) {
        const tz = getParam(p, 'TZID');
        const zoneOk = !tz || isKnownTimeZone(tz);
        for (const v of p.value.split(',')) {
          out.push({
            ms: zoneOk ? parseDateTime(v, tz)?.ms ?? null : null,
            key: paramKey(p.params),
            form: dateForm(p),
            zoneOk,
          });
        }
      }
      return out;
    };
    for (const [name, entries] of [
      ['EXDATE', before.exdateEntries],
      ['RDATE', before.rdateEntries],
    ] as const) {
      const oldOut = outEntries(name, before.uid);
      const newOut = outEntries(name, plan.newUid);
      for (const e of entries) {
        const moved = plan.remaps.find((r) => r.oldSlotMs === e.ms);
        const target = moved ? newOut : oldOut;
        const wantMs = moved ? moved.newSlotMs : e.ms;
        const want = paramKey(e.params);
        if (!target.some((o) => o.ms === wantMs && o.key === want && o.zoneOk)) {
          problems.push(`${name} for ${fmt(e.ms)} lost its entry, its time zone, its value type or its parameters`);
        } else carried++;
      }
    }

    problems.push(...contentProblemsOfStart);
    checks.push({
      id: 'properties-carried',
      title: 'Times, locations, attendees, reminders, date lists and private X- properties carried across',
      pass: problems.length === 0,
      evidence: problems.length === 0
        ? `${carried} properties and alarms verified byte-for-byte on the new series.`
        : problems.join('; '),
    });
  }

  // 6. No duplicates anywhere in the file.
  {
    const seen = new Map<string, number>();
    for (const c of reparsed.children) {
      if (c.name !== 'VEVENT') continue;
      const key = `${getProp(c, 'UID')?.value ?? ''}#${getProp(c, 'RECURRENCE-ID')?.value ?? 'MASTER'}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    checks.push({
      id: 'no-duplicates',
      title: 'No occurrence was duplicated',
      pass: dupes.length === 0,
      evidence: dupes.length === 0
        ? `${seen.size} distinct event identities, no repeats.`
        : `Duplicated: ${dupes.map(([k, n]) => `${k} ×${n}`).join(', ')}.`,
    });
  }

  // 7. Meeting count reconciles.
  {
    const pastCount = oldAfter.filter((o) => !o.cancelled).length;

    if (!before.unbounded && plan.endPolicy === 'keep-end-date') {
      /*
       * This policy holds the end date and lets the count move, so counting
       * meetings is the wrong question — it was failing ordinary requests.
       * What must hold is that the series still ends when it used to.
       */
      const lastNew = newAfter.length ? newAfter[newAfter.length - 1].slotMs : null;
      const lastOld = plan.oldEndsAtMs;
      const sameDay = (a: number | null, b: number | null) =>
        a !== null && b !== null &&
        new Intl.DateTimeFormat('en-CA', { timeZone: before.tzid ?? 'UTC' }).format(new Date(a)) ===
          new Intl.DateTimeFormat('en-CA', { timeZone: before.tzid ?? 'UTC' }).format(new Date(b));
      checks.push({
        id: 'count-reconciles',
        title: 'The series still ends when it used to',
        pass: lastNew !== null && lastOld !== null && lastNew <= lastOld,
        evidence:
          lastNew === null || lastOld === null
            ? 'The end of the series could not be determined.'
            : `${pastCount} kept before the change; the series now ends ${fmt(lastNew)}` +
              `${sameDay(lastNew, lastOld) ? ', the same day as before' : `, on or before the original ${fmt(lastOld)}`}.`,
      });
    } else if (!before.unbounded) {
      const futureCount = newAfter.filter((o) => !o.cancelled).length;
      const expected = origBefore.filter((o) => !o.cancelled).length;
      const got = pastCount + futureCount;
      checks.push({
        id: 'count-reconciles',
        title: 'The total number of real meetings is unchanged',
        pass: got === expected,
        evidence: `${pastCount} kept + ${futureCount} moved = ${got}; originally ${expected}.`,
      });
    } else {
      /*
       * A series with no end has no total to compare, and counting both sides
       * up to some wall-clock instant is not a fair test: the old and new
       * rules fall on different weekdays, so the last few days of any window
       * naturally hold a different number of meetings. Comparing prefixes of
       * equal length asks the question that actually matters — over the same
       * number of occurrences, does the same number of meetings survive — and
       * the new rule must still have no end.
       */
      const oldFuture = origBefore.filter((o) => o.slotMs >= effective);
      const n = Math.min(oldFuture.length, newAfter.length);
      const beforeN = oldFuture.slice(0, n).filter((o) => !o.cancelled).length;
      const afterN = newAfter.slice(0, n).filter((o) => !o.cancelled).length;
      /*
       * Read from the file, not from the plan. Checking `plan.newRuleText`
       * asked whether SeriesSafe *intended* to keep the series open, which is
       * exactly the mistake this whole validation stage exists to avoid: a
       * COUNT added to the written rule passed unnoticed.
       */
      const writtenMaster = reparsed.children.find(
        (c) =>
          c.name === 'VEVENT' &&
          (getProp(c, 'UID')?.value ?? '') === plan.newUid &&
          !getProp(c, 'RECURRENCE-ID'),
      );
      const writtenRule = writtenMaster
        ? (writtenMaster.props.find((p) => p.name === 'RRULE')?.value ?? '')
        : '';
      const parsedRule = writtenRule ? parseRRule(writtenRule) : null;
      const stillOpen = Boolean(parsedRule && parsedRule.count === undefined && parsedRule.until === undefined);
      checks.push({
        id: 'count-reconciles',
        title: 'The same meetings survive, and the series still has no end',
        pass: beforeN === afterN && stillOpen,
        evidence: !stillOpen
          ? `The series had no end, but the rule written out does: ${writtenRule || '(no rule found)'}.`
          : `${pastCount} kept before the change; over the next ${n} occurrences, ${beforeN} real meetings ` +
            `before and ${afterN} after.`,
      });
    }
  }

  // 8. The rule written out is the rule that was planned.
  {
    const writtenMaster = reparsed.children.find(
      (c) =>
        c.name === 'VEVENT' &&
        (getProp(c, 'UID')?.value ?? '') === plan.newUid &&
        !getProp(c, 'RECURRENCE-ID'),
    );
    const writtenRule = writtenMaster?.props.find((p) => p.name === 'RRULE')?.value ?? '';
    const startProp = writtenMaster ? getProp(writtenMaster, 'DTSTART') : undefined;
    const writtenStart = startProp?.value ?? '';
    const wantStart = formatLike(before, plan.newDtstartMs);
    // Resolved with the parameters actually written, so a swapped TZID cannot
    // keep the same text while meaning a different instant.
    const writtenStartMs = startProp
      ? parseDateTime(startProp.value, getParam(startProp, 'TZID') ?? undefined)?.ms ?? null
      : null;

    /*
     * Comparing occurrence counts cannot see a rule that changed shape:
     * rewriting an open-ended weekly rule as FREQ=MONTHLY produced far fewer
     * meetings, and the equal-length prefix comparison simply shortened with
     * it. The written rule is therefore compared to the planned one directly.
     */
    const norm = (r: string) => r.split(';').map((x) => x.trim().toUpperCase()).sort().join(';');
    const ruleMatches = norm(writtenRule) === norm(plan.newRuleText);
    const startMatches = writtenStart === wantStart && writtenStartMs === plan.newDtstartMs;
    checks.push({
      id: 'rule-as-planned',
      title: 'The recurrence written out is the one that was planned',
      pass: Boolean(writtenMaster) && ruleMatches && startMatches,
      evidence: !writtenMaster
        ? 'The new series master is missing.'
        : !ruleMatches
        ? `Planned ${plan.newRuleText}, wrote ${writtenRule || '(none)'}.`
        : !startMatches
        ? writtenStart === wantStart
          ? `The start reads ${writtenStart} but its parameters resolve it to ` +
            `${writtenStartMs === null ? '(unreadable)' : fmt(writtenStartMs)}, not ${fmt(plan.newDtstartMs)}.`
          : `Planned a start of ${wantStart}, wrote ${writtenStart || '(none)'}.`
        : `${writtenRule} starting ${writtenStart}, exactly as planned.`,
    });
  }

  // 9. Nothing else in the file was touched.
  {
    // Everything that is not part of this series: other events *and* the
    // calendar's other components, such as the VTIMEZONE definitions the
    // times depend on.
    const untouched = (c: Component, uids: string[]) =>
      c.name !== 'VEVENT' || !uids.includes(getProp(c, 'UID')?.value ?? '');
    const otherBefore = original.children.filter((c) => untouched(c, [before.uid]));
    const otherAfter = reparsed.children.filter((c) => untouched(c, [before.uid, plan.newUid]));
    const same =
      otherBefore.length === otherAfter.length &&
      otherBefore.every((c, i) => propFingerprint(c) === propFingerprint(otherAfter[i]));
    checks.push({
      id: 'blast-radius',
      title: 'No other event in the calendar was modified',
      pass: same,
      evidence: same
        ? `${otherBefore.length} unrelated component(s) untouched, parameters and sub-components included.`
        : `Unrelated components changed: ${otherBefore.length} before vs ${otherAfter.length} after.`,
    });
  }

  const pass = checks.every((c) => c.pass);
  return { pass, checks, preservedCount: plan.naiveLosses.length, checkedAt: Date.now() };
}
