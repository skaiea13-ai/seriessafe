import type { Component } from './types.ts';
import { getProp, getProps } from './types.ts';

/**
 * Resolve time zones from the `VTIMEZONE` blocks a calendar carries.
 *
 * Exchange and Outlook write zone names of their own — `Pacific Standard
 * Time`, `GMT Standard Time` — and define them in an accompanying VTIMEZONE.
 * `Intl` has never heard of those names, so a file that is entirely valid was
 * being refused. Rather than guess, the definition in the file is used.
 *
 * Only the shape those exporters actually emit is implemented: STANDARD and
 * DAYLIGHT sub-components with a local `DTSTART`, `TZOFFSETFROM`,
 * `TZOFFSETTO`, and an optional yearly rule stated as `BYMONTH` with either
 * `BYDAY=<n><DAY>` or `BYMONTHDAY`. Anything else resolves to nothing, and the
 * caller refuses rather than assuming UTC.
 */

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

interface Transition {
  /** UTC instant the offset changes. */
  atMs: number;
  /** Offset in force from that instant, in milliseconds. */
  offsetMs: number;
}

interface ZoneRule {
  offsetFromMs: number;
  offsetToMs: number;
  /** Local wall clock the change takes effect, as calendar fields. */
  start: { y: number; mo: number; d: number; h: number; mi: number; s: number };
  yearly?: { month: number; nth?: number; day?: number; monthday?: number };
}

/** Parse "+0900" or "-0430" into milliseconds. */
function parseOffset(v: string): number | null {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(v.trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * ((+m[2] * 3600 + +m[3] * 60 + (+(m[4] ?? 0))) * 1000);
}

function parseLocal(v: string) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(v.trim());
  if (!m) return null;
  return { y: +m[1], mo: +m[2] - 1, d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
}

function ruleOf(sub: Component): ZoneRule | null {
  const from = parseOffset(getProp(sub, 'TZOFFSETFROM')?.value ?? '');
  const to = parseOffset(getProp(sub, 'TZOFFSETTO')?.value ?? '');
  const start = parseLocal(getProp(sub, 'DTSTART')?.value ?? '');
  if (from === null || to === null || !start) return null;

  const rule: ZoneRule = { offsetFromMs: from, offsetToMs: to, start };
  const rrule = getProps(sub, 'RRULE')[0]?.value;
  if (rrule) {
    const parts: Record<string, string> = {};
    for (const seg of rrule.split(';')) {
      const i = seg.indexOf('=');
      if (i > 0) parts[seg.slice(0, i).toUpperCase()] = seg.slice(i + 1);
    }
    if ((parts.FREQ ?? '').toUpperCase() !== 'YEARLY' || !parts.BYMONTH) return null;
    const month = parseInt(parts.BYMONTH, 10) - 1;
    if (!Number.isFinite(month)) return null;
    if (parts.BYDAY) {
      const m = /^(-?\d)?([A-Z]{2})$/.exec(parts.BYDAY.trim().toUpperCase());
      if (!m) return null;
      const day = DAY_CODES.indexOf(m[2]);
      if (day < 0) return null;
      rule.yearly = { month, nth: m[1] ? +m[1] : 1, day };
    } else if (parts.BYMONTHDAY) {
      rule.yearly = { month, monthday: parseInt(parts.BYMONTHDAY, 10) };
    } else return null;
  }
  return rule;
}

/** The nth weekday of a month, counting from the end when nth is negative. */
function nthWeekday(year: number, month: number, day: number, nth: number): number {
  if (nth > 0) {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return 1 + ((day - first + 7) % 7) + (nth - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month, lastDay)).getUTCDay();
  return lastDay - ((last - day + 7) % 7) + (nth + 1) * 7;
}

function transitionsFor(rule: ZoneRule, year: number): Transition[] {
  const out: Transition[] = [];
  const emit = (y: number, mo: number, d: number) => {
    const localMs = Date.UTC(y, mo, d, rule.start.h, rule.start.mi, rule.start.s);
    out.push({ atMs: localMs - rule.offsetFromMs, offsetMs: rule.offsetToMs });
  };
  if (!rule.yearly) {
    emit(rule.start.y, rule.start.mo, rule.start.d);
    return out;
  }
  const { month, nth, day, monthday } = rule.yearly;
  if (year < rule.start.y) return out;
  if (monthday !== undefined) emit(year, month, monthday);
  else if (day !== undefined && nth !== undefined) emit(year, month, nthWeekday(year, month, day, nth));
  return out;
}

/** Every zone definition a calendar carries, keyed by its TZID. */
export type ZoneTable = Map<string, ZoneRule[]>;

export function collectTimeZones(cal: Component): ZoneTable {
  const table: ZoneTable = new Map();
  for (const c of cal.children) {
    if (c.name !== 'VTIMEZONE') continue;
    const tzid = getProp(c, 'TZID')?.value;
    if (!tzid) continue;
    const rules: ZoneRule[] = [];
    for (const sub of c.children) {
      if (sub.name !== 'STANDARD' && sub.name !== 'DAYLIGHT') continue;
      const r = ruleOf(sub);
      if (r) rules.push(r);
    }
    if (rules.length) table.set(tzid, rules);
  }
  return table;
}

/**
 * The offset in force at `ms`, or null when the zone is not defined here or
 * uses a shape this resolver does not implement.
 */
export function offsetFromTable(table: ZoneTable, tzid: string, ms: number): number | null {
  const rules = table.get(tzid);
  if (!rules?.length) return null;

  const year = new Date(ms).getUTCFullYear();
  const candidates: Transition[] = [];
  for (const rule of rules) {
    for (const y of [year - 1, year, year + 1]) candidates.push(...transitionsFor(rule, y));
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.atMs - b.atMs);

  let current: Transition | null = null;
  for (const t of candidates) {
    if (t.atMs <= ms) current = t;
    else break;
  }
  // Before the first transition of the window, the earliest rule's "from"
  // offset is what was in force.
  return current ? current.offsetMs : rules[0].offsetFromMs;
}
