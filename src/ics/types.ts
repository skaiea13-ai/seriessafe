/**
 * RFC 5545 structural types.
 *
 * The parser is deliberately *generic*: every property is retained as a
 * `Prop` with its raw parameters and raw value, in original order. Nothing is
 * dropped just because SeriesSafe does not understand it. Typed accessors sit
 * on top of this generic layer, never replace it.
 *
 * This is what makes "no silent loss" provable rather than aspirational.
 */

export interface Param {
  name: string;
  /** Parameter values. RFC 5545 allows comma-separated multi-values. */
  values: string[];
}

export interface Prop {
  /** Upper-cased property name, e.g. "DTSTART". */
  name: string;
  params: Param[];
  /** Raw (still-escaped) value text exactly as it appeared after the colon. */
  value: string;
}

export interface Component {
  /** Upper-cased component name, e.g. "VEVENT", "VALARM", "VTIMEZONE". */
  name: string;
  props: Prop[];
  children: Component[];
}

/** A date-time parsed out of DTSTART/RECURRENCE-ID/EXDATE etc. */
export interface IcsDateTime {
  /** UTC milliseconds. For floating/local times this is interpreted in `tzid`. */
  ms: number;
  /** True when the value was a DATE (no time part), e.g. all-day events. */
  isDate: boolean;
  /** True when the value carried a trailing "Z". */
  isUtc: boolean;
  /** TZID parameter when present. */
  tzid?: string;
  /** The original literal, preserved for byte-exact re-emission. */
  raw: string;
}

export function getProp(c: Component, name: string): Prop | undefined {
  const n = name.toUpperCase();
  return c.props.find((p) => p.name === n);
}

export function getProps(c: Component, name: string): Prop[] {
  const n = name.toUpperCase();
  return c.props.filter((p) => p.name === n);
}

export function getParam(p: Prop, name: string): string | undefined {
  const n = name.toUpperCase();
  return p.params.find((x) => x.name === n)?.values[0];
}

export function setProp(c: Component, name: string, value: string, params: Param[] = []): void {
  const n = name.toUpperCase();
  const existing = c.props.find((p) => p.name === n);
  if (existing) {
    existing.value = value;
    existing.params = params;
  } else {
    c.props.push({ name: n, params, value });
  }
}

export function removeProps(c: Component, name: string): Prop[] {
  const n = name.toUpperCase();
  const removed = c.props.filter((p) => p.name === n);
  c.props = c.props.filter((p) => p.name !== n);
  return removed;
}

/** Deep structural clone that keeps property order and unknown data intact. */
export function cloneComponent(c: Component): Component {
  return {
    name: c.name,
    props: c.props.map((p) => ({
      name: p.name,
      value: p.value,
      params: p.params.map((x) => ({ name: x.name, values: [...x.values] })),
    })),
    children: c.children.map(cloneComponent),
  };
}
