import type { Component, Prop, Param, IcsDateTime } from './types.ts';

/**
 * Unfold RFC 5545 content lines.
 *
 * A long line is split with CRLF followed by a single space or tab. Both the
 * space and the tab form are legal, and some providers emit bare LF, so all
 * three line endings are tolerated on input.
 */
export function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out.filter((l) => l.length > 0);
}

/**
 * Parse a single content line: NAME;PARAM=VAL;PARAM2="q;uoted":VALUE
 *
 * The colon that ends the property name+params is the first colon that is not
 * inside a double-quoted parameter value.
 */
export function parseLine(line: string): Prop {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return { name: line.toUpperCase(), params: [], value: '' };

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);

  // Split head on semicolons that are not inside quotes.
  const segments: string[] = [];
  let cur = '';
  inQuotes = false;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
    } else if (ch === ';' && !inQuotes) {
      segments.push(cur);
      cur = '';
    } else cur += ch;
  }
  segments.push(cur);

  const name = segments[0].toUpperCase();
  const params: Param[] = [];
  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf('=');
    if (eq === -1) {
      params.push({ name: seg.toUpperCase(), values: [''] });
      continue;
    }
    const pname = seg.slice(0, eq).toUpperCase();
    const pvalRaw = seg.slice(eq + 1);
    // Multi-valued params are comma separated, honouring quotes.
    const values: string[] = [];
    let v = '';
    let q = false;
    for (let i = 0; i < pvalRaw.length; i++) {
      const ch = pvalRaw[i];
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) {
        values.push(v);
        v = '';
      } else v += ch;
    }
    values.push(v);
    params.push({ name: pname, values });
  }
  return { name, params, value };
}

/** Parse a full iCalendar document into a component tree. */
export function parseIcs(text: string): Component {
  const lines = unfold(text);
  const root: Component = { name: 'ROOT', props: [], children: [] };
  const stack: Component[] = [root];

  for (const line of lines) {
    const prop = parseLine(line);
    if (prop.name === 'BEGIN') {
      const child: Component = { name: prop.value.toUpperCase(), props: [], children: [] };
      stack[stack.length - 1].children.push(child);
      stack.push(child);
    } else if (prop.name === 'END') {
      if (stack.length > 1) stack.pop();
    } else {
      stack[stack.length - 1].props.push(prop);
    }
  }
  // A well-formed file yields ROOT > VCALENDAR.
  return root.children.length === 1 && root.children[0].name === 'VCALENDAR'
    ? root.children[0]
    : root;
}

/* ------------------------------------------------------------------ */
/* Date-time handling                                                  */
/* ------------------------------------------------------------------ */

const DT_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

/**
 * Parse an RFC 5545 DATE or DATE-TIME literal.
 *
 * Local (floating) and TZID-qualified times are anchored to UTC using the
 * offset lookup below. SeriesSafe keeps `raw` so that any value it did not
 * need to change is re-emitted byte-for-byte.
 */
export function parseDateTime(raw: string, tzid?: string): IcsDateTime | null {
  const m = DT_RE.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const isDate = hh === undefined;
  const isUtc = z === 'Z';

  const year = +y;
  const month = +mo - 1;
  const day = +d;
  const hour = isDate ? 0 : +hh;
  const min = isDate ? 0 : +mm;
  const sec = isDate ? 0 : +ss;

  let ms: number;
  if (isUtc) {
    ms = Date.UTC(year, month, day, hour, min, sec);
  } else if (tzid) {
    ms = zonedToUtc(year, month, day, hour, min, sec, tzid);
  } else {
    // Floating time: treat the wall clock as UTC so arithmetic stays stable.
    ms = Date.UTC(year, month, day, hour, min, sec);
  }
  return { ms, isDate, isUtc, tzid, raw: raw.trim() };
}

/**
 * Convert a wall-clock time in `tzid` to UTC milliseconds.
 *
 * Uses Intl to read the zone's offset at the candidate instant, then corrects
 * once. Two passes settle DST boundaries for every real-world zone.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  min: number,
  sec: number,
  tzid: string,
): number {
  const naive = Date.UTC(year, month, day, hour, min, sec);
  let guess = naive;
  for (let i = 0; i < 2; i++) {
    const offset = tzOffsetMs(guess, tzid);
    const next = naive - offset;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

/** Offset of `tzid` from UTC at instant `ms`, in milliseconds. */
export function tzOffsetMs(ms: number, tzid: string): number {
  let dtf = dtfCache.get(tzid);
  if (!dtf) {
    try {
      dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tzid,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      // Unknown TZID: treat as UTC rather than throwing. Callers that need a
      // guarantee check `isKnownTimeZone` and fail closed instead.
      return 0;
    }
    dtfCache.set(tzid, dtf);
  }
  const parts = dtf.formatToParts(new Date(ms));
  const get = (t: string) => +(parts.find((p) => p.type === t)?.value ?? '0');
  let hour = get('hour');
  if (hour === 24) hour = 0; // some ICU versions emit 24 for midnight
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUtc - ms;
}

export function isKnownTimeZone(tzid: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzid });
    return true;
  } catch {
    return false;
  }
}

/** Format UTC ms back into an RFC 5545 literal in the given zone. */
export function formatDateTime(ms: number, opts: { isDate?: boolean; isUtc?: boolean; tzid?: string }): string {
  const { isDate = false, isUtc = false, tzid } = opts;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');

  if (isUtc) {
    const d = new Date(ms);
    const base =
      `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
    return isDate ? base : `${base}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  }

  const offset = tzid ? tzOffsetMs(ms, tzid) : 0;
  const d = new Date(ms + offset);
  const base = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  return isDate ? base : `${base}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** Unescape an RFC 5545 TEXT value for display. */
export function unescapeText(v: string): string {
  return v.replace(/\\([nN;,\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Escape a display string back into an RFC 5545 TEXT value. */
export function escapeText(v: string): string {
  return v.replace(/([\;,])/g, '\\$1').replace(/\n/g, '\\n');
}
