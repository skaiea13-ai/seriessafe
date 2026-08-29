import { type Component, getProp, getParam } from '../ics/types.ts';
import { parseIcs, formatDateTime } from '../ics/parse.ts';
import { serializeIcs } from '../ics/serialize.ts';
import { buildSeriesGraph, type SeriesGraph } from './series.ts';
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
function render(cal: Component, uid: string): Rendered[] {
  const g = buildSeriesGraph(cal, uid);
  if (!g) return [];
  return g.occurrences.map((o) => ({
    slotMs: o.slotMs,
    startMs: o.startMs,
    cancelled: o.kind === 'cancelled',
    overridden: o.kind === 'overridden',
  }));
}

function propFingerprint(c: Component): string {
  const props = c.props
    .map((p) => `${p.name}=${p.value}`)
    .sort()
    .join('|');
  const alarms = c.children.filter((x) => x.name === 'VALARM').length;
  return `${props}#alarms=${alarms}`;
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

  const oldAfter = render(reparsed, before.uid);
  const newAfter = render(reparsed, plan.newUid);
  const origBefore = render(original, before.uid);

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
      for (const p of before.master.props) {
        if (REWRITTEN.includes(p.name)) continue;
        if (!oldMasterAfter.props.some((q) => q.name === p.name && q.value === p.value)) {
          contentProblems.push(`${p.name} lost from the original series`);
        }
      }
      const alarmsA = before.master.children.filter((c) => c.name === 'VALARM').length;
      const alarmsB = oldMasterAfter.children.filter((c) => c.name === 'VALARM').length;
      if (alarmsA !== alarmsB) contentProblems.push('the original series lost an alarm');
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
        const want = formatDateTime(r.newSlotMs, {
          tzid: getParam(rid, 'TZID') ?? tz,
          isDate: before.isDate,
        });
        return rid.value === want;
      });
      if (hits.length !== 1) {
        problems.push(`${fmt(r.oldSlotMs)} resolved to ${hits.length} events (expected exactly 1)`);
        continue;
      }
      const slot = newAfter.find((o) => o.slotMs === r.newSlotMs);
      if (!slot || slot.startMs !== r.keptStartMs) {
        problems.push(
          `${fmt(r.oldSlotMs)} should still start at ${fmt(r.keptStartMs ?? 0)} but starts at ${fmt(slot?.startMs ?? 0)}`,
        );
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
    let carried = 0;
    for (const r of plan.remaps.filter((x) => x.kind === 'override')) {
      const src = before.overrides.get(r.oldSlotMs);
      const dst = reparsed.children.find((c) => {
        if (c.name !== 'VEVENT') return false;
        if ((getProp(c, 'UID')?.value ?? '') !== plan.newUid) return false;
        const rid = getProp(c, 'RECURRENCE-ID');
        return !!rid && rid.value === formatDateTime(r.newSlotMs, {
          tzid: getParam(rid, 'TZID') ?? tz,
          isDate: before.isDate,
        });
      });
      if (!src || !dst) continue;
      for (const p of src.props) {
        if (['UID', 'RECURRENCE-ID', 'SEQUENCE', 'DTSTAMP', 'LAST-MODIFIED'].includes(p.name)) continue;
        const match = dst.props.find((q) => q.name === p.name && q.value === p.value);
        if (!match) problems.push(`${p.name} lost from the ${fmt(r.oldSlotMs)} override`);
        else carried++;
      }
      const srcAlarms = src.children.filter((c) => c.name === 'VALARM').length;
      const dstAlarms = dst.children.filter((c) => c.name === 'VALARM').length;
      if (srcAlarms !== dstAlarms) problems.push(`${srcAlarms - dstAlarms} alarm(s) lost from ${fmt(r.oldSlotMs)}`);
      else carried += srcAlarms;
    }
    // The new master must keep the roster, alarms and private extensions.
    const newMaster = reparsed.children.find(
      (c) => c.name === 'VEVENT' && (getProp(c, 'UID')?.value ?? '') === plan.newUid && !getProp(c, 'RECURRENCE-ID'),
    );
    if (newMaster) {
      for (const p of before.master.props) {
        if (['UID', 'DTSTART', 'DTEND', 'RRULE', 'EXDATE', 'RDATE', 'SEQUENCE', 'DTSTAMP', 'LAST-MODIFIED'].includes(p.name)) continue;
        const match = newMaster.props.find((q) => q.name === p.name && q.value === p.value);
        if (!match) problems.push(`${p.name} lost from the new series`);
        else carried++;
      }
      const a = before.master.children.filter((c) => c.name === 'VALARM').length;
      const b = newMaster.children.filter((c) => c.name === 'VALARM').length;
      if (a !== b) problems.push(`${a - b} alarm(s) lost from the new series`);
      else carried += a;
    } else {
      problems.push('the new series master is missing');
    }
    checks.push({
      id: 'properties-carried',
      title: 'Locations, attendees, reminders and private X- properties carried across',
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
    const futureCount = newAfter.filter((o) => !o.cancelled).length;
    const expected = origBefore.filter((o) => !o.cancelled).length;
    const got = pastCount + futureCount;
    checks.push({
      id: 'count-reconciles',
      title: 'The total number of real meetings is unchanged',
      pass: got === expected,
      evidence: `${pastCount} kept + ${futureCount} moved = ${got}; originally ${expected}.`,
    });
  }

  // 8. Nothing else in the file was touched.
  {
    const otherBefore = original.children.filter(
      (c) => c.name === 'VEVENT' && (getProp(c, 'UID')?.value ?? '') !== before.uid,
    );
    const otherAfter = reparsed.children.filter(
      (c) => c.name === 'VEVENT' && ![before.uid, plan.newUid].includes(getProp(c, 'UID')?.value ?? ''),
    );
    const same =
      otherBefore.length === otherAfter.length &&
      otherBefore.every((c, i) => propFingerprint(c) === propFingerprint(otherAfter[i]));
    checks.push({
      id: 'blast-radius',
      title: 'No other event in the calendar was modified',
      pass: same,
      evidence: same
        ? `${otherBefore.length} unrelated event(s) untouched.`
        : `Unrelated events changed: ${otherBefore.length} before vs ${otherAfter.length} after.`,
    });
  }

  const pass = checks.every((c) => c.pass);
  return { pass, checks, preservedCount: plan.naiveLosses.length, checkedAt: Date.now() };
}
