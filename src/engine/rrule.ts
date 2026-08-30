import { zonedToUtc, tzOffsetMs, parseDateTime } from '../ics/parse.ts';

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface RRule {
  freq: Freq;
  interval: number;
  /** BYDAY as two-letter codes, e.g. ["TU","TH"]. Empty when absent. */
  byday: string[];
  /** BYMONTHDAY values. Empty when absent. */
  bymonthday: number[];
  count?: number;
  /** UNTIL as UTC ms. */
  until?: number;
  untilRaw?: string;
  wkst: string;
  /** Any RRULE part SeriesSafe does not model, kept so we can fail closed. */
  unsupported: Record<string, string>;
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Parts SeriesSafe understands well enough to rewrite safely. */
const KNOWN_PARTS = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL', 'WKST']);

export function parseRRule(value: string): RRule {
  const parts: Record<string, string> = {};
  for (const seg of value.split(';')) {
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq === -1) continue;
    parts[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
  }
  const freq = (parts.FREQ?.toUpperCase() as Freq) ?? 'WEEKLY';
  const unsupported: Record<string, string> = {};
  for (const [k, v] of Object.entries(parts)) {
    if (!KNOWN_PARTS.has(k)) unsupported[k] = v;
  }

  /*
   * Expansion only implements the parts below for the frequencies that use
   * them. Anything else is recorded as unsupported so staging refuses, rather
   * than being expanded to plausible-looking but wrong dates: `FREQ=MONTHLY;
   * BYDAY=1MO` once produced the first of every month instead of the first
   * Monday, and nothing flagged it.
   */
  if (freq !== 'WEEKLY' && parts.BYDAY) unsupported.BYDAY = parts.BYDAY;
  if (freq !== 'MONTHLY' && parts.BYMONTHDAY) unsupported.BYMONTHDAY = parts.BYMONTHDAY;
  if (freq === 'YEARLY' && (parts.BYDAY || parts.BYMONTHDAY)) {
    unsupported.FREQ = 'YEARLY with BY* parts';
  }
  /*
   * Only WEEKLY is expanded exactly, and only WEEKLY is documented as
   * supported — but the code had been happy to operate on the others anyway.
   * A MONTHLY rule lost its last occurrence, and a YEARLY rule on 29 February
   * produced 1 March in non-leap years. Saying no is the honest answer.
   */
  if (freq !== 'WEEKLY') {
    unsupported.FREQ = parts.FREQ ?? '(missing)';
  }

  const untilRaw = parts.UNTIL;
  const untilDt = untilRaw ? parseDateTime(untilRaw) : null;

  return {
    freq,
    interval: parts.INTERVAL ? Math.max(1, parseInt(parts.INTERVAL, 10)) : 1,
    byday: parts.BYDAY ? parts.BYDAY.split(',').map((d) => d.trim().toUpperCase()) : [],
    bymonthday: parts.BYMONTHDAY
      ? parts.BYMONTHDAY.split(',').map((d) => parseInt(d, 10)).filter(Number.isFinite)
      : [],
    count: parts.COUNT ? parseInt(parts.COUNT, 10) : undefined,
    until: untilDt ? untilDt.ms : undefined,
    untilRaw,
    wkst: (parts.WKST ?? 'MO').toUpperCase(),
    unsupported,
  };
}

export function formatRRule(r: RRule): string {
  const out: string[] = [`FREQ=${r.freq}`];
  if (r.interval > 1) out.push(`INTERVAL=${r.interval}`);
  if (r.byday.length) out.push(`BYDAY=${r.byday.join(',')}`);
  if (r.bymonthday.length) out.push(`BYMONTHDAY=${r.bymonthday.join(',')}`);
  if (r.count !== undefined) out.push(`COUNT=${r.count}`);
  if (r.untilRaw) out.push(`UNTIL=${r.untilRaw}`);
  if (r.wkst && r.wkst !== 'MO') out.push(`WKST=${r.wkst}`);
  for (const [k, v] of Object.entries(r.unsupported)) out.push(`${k}=${v}`);
  return out.join(';');
}

/** Wall-clock calendar fields, always interpreted inside a specific zone. */
interface Wall {
  y: number;
  m: number; // 0-based
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

function toWall(ms: number, tzid?: string): Wall {
  const offset = tzid ? tzOffsetMs(ms, tzid) : 0;
  const d = new Date(ms + offset);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth(),
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    ss: d.getUTCSeconds(),
  };
}

function wallToUtc(w: Wall, tzid?: string): number {
  return tzid
    ? zonedToUtc(w.y, w.m, w.d, w.hh, w.mm, w.ss, tzid)
    : Date.UTC(w.y, w.m, w.d, w.hh, w.mm, w.ss);
}

/** Day-of-week (0=Sun) for a wall-clock date. */
function wallDow(w: Wall): number {
  return new Date(Date.UTC(w.y, w.m, w.d)).getUTCDay();
}

function addDays(w: Wall, n: number): Wall {
  const d = new Date(Date.UTC(w.y, w.m, w.d));
  d.setUTCDate(d.getUTCDate() + n);
  return { ...w, y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}

function addMonths(w: Wall, n: number): Wall {
  const d = new Date(Date.UTC(w.y, w.m, 1));
  d.setUTCMonth(d.getUTCMonth() + n);
  return { ...w, y: d.getUTCFullYear(), m: d.getUTCMonth() };
}

export interface ExpandOptions {
  /** Hard ceiling so a malformed infinite rule can never hang the page. */
  limit?: number;
  /** Stop expanding past this instant (UTC ms), inclusive. */
  maxMs?: number;
}

/**
 * Expand a recurrence rule into occurrence start instants.
 *
 * Expansion walks the *wall clock* in the event's own zone and converts each
 * candidate to UTC separately. That keeps "every Tuesday at 19:00" at 19:00
 * local across a DST transition instead of drifting by an hour.
 *
 * EXDATE and RDATE are **not** applied here; the series graph layers them on
 * top so that cancellations stay individually addressable.
 */
export function expandRRule(
  dtstartMs: number,
  rule: RRule,
  tzid: string | undefined,
  opts: ExpandOptions = {},
): number[] {
  const limit = opts.limit ?? 5000;
  const out: number[] = [];
  const start = toWall(dtstartMs, tzid);
  const timeOf = { hh: start.hh, mm: start.mm, ss: start.ss };

  const push = (w: Wall): boolean => {
    const ms = wallToUtc({ ...w, ...timeOf }, tzid);
    if (ms < dtstartMs) return true; // never emit before DTSTART
    if (rule.until !== undefined && ms > rule.until) return false;
    if (opts.maxMs !== undefined && ms > opts.maxMs) return false;
    out.push(ms);
    return !(rule.count !== undefined && out.length >= rule.count) && out.length < limit;
  };

  if (rule.freq === 'WEEKLY') {
    const days = rule.byday.length ? rule.byday : [DAY_CODES[wallDow(start)]];
    const targetDows = days.map((d) => DAY_CODES.indexOf(d.replace(/^[+-]?\d+/, ''))).filter((n) => n >= 0);
    if (!targetDows.length) return out;

    const wkstIdx = Math.max(0, DAY_CODES.indexOf(rule.wkst));
    // Anchor to the first day of DTSTART's week.
    const startDow = wallDow(start);
    const backTo = (startDow - wkstIdx + 7) % 7;
    let weekStart = addDays(start, -backTo);

    for (let guard = 0; guard < limit * 2; guard++) {
      for (const dow of [...targetDows].sort((a, b) => ((a - wkstIdx + 7) % 7) - ((b - wkstIdx + 7) % 7))) {
        const offset = (dow - wkstIdx + 7) % 7;
        const cand = addDays(weekStart, offset);
        const candMs = wallToUtc({ ...cand, ...timeOf }, tzid);
        if (candMs < dtstartMs) continue;
        if (!push(cand)) return out;
      }
      weekStart = addDays(weekStart, 7 * rule.interval);
      const probe = wallToUtc({ ...weekStart, ...timeOf }, tzid);
      if (rule.until !== undefined && probe > rule.until) break;
      if (opts.maxMs !== undefined && probe > opts.maxMs) break;
      if (rule.count !== undefined && out.length >= rule.count) break;
    }
    return out;
  }

  if (rule.freq === 'DAILY') {
    let cur = start;
    for (let guard = 0; guard < limit * 2; guard++) {
      if (!push(cur)) return out;
      cur = addDays(cur, rule.interval);
    }
    return out;
  }

  if (rule.freq === 'MONTHLY') {
    let cur = { ...start };
    const mds = rule.bymonthday.length ? rule.bymonthday : [start.d];
    for (let guard = 0; guard < limit * 2; guard++) {
      for (const md of mds) {
        const daysInMonth = new Date(Date.UTC(cur.y, cur.m + 1, 0)).getUTCDate();
        const day = md > 0 ? md : daysInMonth + md + 1;
        if (day < 1 || day > daysInMonth) continue;
        if (!push({ ...cur, d: day })) return out;
      }
      cur = addMonths(cur, rule.interval);
      const probe = wallToUtc({ ...cur, ...timeOf }, tzid);
      if (rule.until !== undefined && probe > rule.until) break;
      if (opts.maxMs !== undefined && probe > opts.maxMs) break;
    }
    return out;
  }

  // YEARLY
  let cur = { ...start };
  for (let guard = 0; guard < limit * 2; guard++) {
    if (!push(cur)) return out;
    cur = { ...cur, y: cur.y + rule.interval };
  }
  return out;
}
