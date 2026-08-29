import type { Component, Prop } from './types.ts';

/**
 * Fold a content line to 75 octets per RFC 5545 section 3.1.
 *
 * The limit is counted in UTF-8 octets, not UTF-16 code units, and a multi-byte
 * character must never be split across the fold. Continuation lines begin with
 * a single space.
 */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;

  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  // First line may use 75 octets; continuations use 74 plus the leading space.
  let limit = 75;

  for (const ch of line) {
    const chBytes = enc.encode(ch).length;
    if (curBytes + chBytes > limit) {
      out.push(cur);
      cur = ch;
      curBytes = chBytes;
      limit = 74;
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  if (cur) out.push(cur);
  return out.join('\r\n ');
}

export function serializeProp(p: Prop): string {
  let head = p.name;
  for (const param of p.params) {
    const vals = param.values
      .map((v) => (/[;:,]/.test(v) ? `"${v}"` : v))
      .join(',');
    head += `;${param.name}=${vals}`;
  }
  return foldLine(`${head}:${p.value}`);
}

export function serializeComponent(c: Component): string[] {
  const lines: string[] = [`BEGIN:${c.name}`];
  for (const p of c.props) lines.push(serializeProp(p));
  for (const child of c.children) lines.push(...serializeComponent(child));
  lines.push(`END:${c.name}`);
  return lines;
}

/** Serialize a VCALENDAR back to an .ics document with CRLF endings. */
export function serializeIcs(cal: Component): string {
  return serializeComponent(cal).join('\r\n') + '\r\n';
}
