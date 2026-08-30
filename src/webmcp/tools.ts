import { parseIcs } from '../ics/parse.ts';
import { serializeIcs } from '../ics/serialize.ts';
import { cloneComponent } from '../ics/types.ts';
import { buildSeriesGraph, listRecurringUids } from '../engine/series.ts';
import { simulateSplit, formatHuman, type SplitParams } from '../engine/split.ts';
import { applySplit, applyNaive } from '../engine/apply.ts';
import { validateStage } from '../engine/validate.ts';
import { compareResults } from '../engine/compare.ts';
import { state, notify, logCall, resetDownstream } from '../state.ts';
import { SAMPLE_ICS } from '../sample.ts';

/** Chrome exposes the API on document.modelContext; older builds used navigator. */
export function modelContext(): any | null {
  const d = document as any;
  if (d.modelContext) return d.modelContext;
  const n = navigator as any;
  if (n.modelContext) return n.modelContext;
  return null;
}

export function webmcpAvailable(): boolean {
  return modelContext() !== null;
}

/** Tools that are only registered once the workflow reaches the right state. */
let commitController: AbortController | null = null;
let undoController: AbortController | null = null;

/**
 * Withdraw a self-deregistering tool once its own call has returned.
 *
 * `commit_staged_split` and `undo_series_split` withdraw themselves as their
 * last act. Registration is cancelled through an AbortSignal, and up to Chrome
 * 152 aborting that signal also cancels the execution still in flight — the
 * call fails with "The operation failed for an unknown transient reason" even
 * though the work completed. Chrome 153 changed this; deferring by a task is
 * correct on every version.
 *
 * The controller live at scheduling time is captured, so if the tool has since
 * been registered afresh the deferred withdrawal leaves the new one alone.
 */
function withdrawAfterReturn(which: 'commit' | 'undo', ctrl: AbortController | null): void {
  setTimeout(() => {
    if (which === 'commit') {
      if (commitController !== ctrl) return;
      unregisterCommit();
    } else {
      if (undoController !== ctrl) return;
      unregisterUndo();
    }
  }, 0);
}

/**
 * Bring the conditional tools back in line with the state.
 *
 * Commit exists only while a staged patch has passed validation, and undo only
 * while there is a commit to revert. Anything that invalidates those — loading
 * another calendar, selecting another series — must be reflected in the tool
 * list, not merely inside the tool body.
 */
function syncDynamicTools(): void {
  const commitAllowed = Boolean(state.staged && state.validation?.pass);
  if (commitAllowed) registerCommit();
  else if (commitController) unregisterCommit();

  const undoAllowed = Boolean(state.commit);
  if (undoAllowed) registerUndo();
  else if (undoController) unregisterUndo();
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function ok(summary: string, data?: unknown): string {
  return data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 2)}`;
}

function fail(summary: string, data?: unknown): string {
  return ok(`REFUSED: ${summary}`, data);
}

function requireGraph() {
  if (!state.calendar) throw new Error('No calendar is loaded. Call load_calendar first.');
  if (!state.graph) throw new Error('No series is selected. Call inspect_series with a uid first.');
  return state.graph;
}

/** Parse "2026-09-01" (or a full ISO instant) into UTC ms in the series zone. */
function parseEffectiveDate(input: string, tzid?: string): number | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    // Midnight local time in the series' own zone.
    const naive = Date.UTC(+y, +m - 1, +d, 0, 0, 0);
    if (!tzid) return naive;
    // Correct for the zone offset at that wall-clock moment.
    const probe = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(naive));
    const get = (t: string) => +(probe.find((p) => p.type === t)?.value ?? '0');
    let hh = get('hour'); if (hh === 24) hh = 0;
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hh, get('minute'), get('second'));
    return naive - (asUtc - naive);
  }
  const t = Date.parse(input);
  return Number.isFinite(t) ? t : null;
}

/* ------------------------------------------------------------------ */
/* Core operations, shared by the tools and the human UI               */
/* ------------------------------------------------------------------ */

export function doLoadCalendar(text: string, filename: string): string {
  const cal = parseIcs(text);
  const uids = listRecurringUids(cal);
  state.calendar = cal;
  state.filename = filename;
  state.uids = uids;
  state.selectedUid = null;
  state.graph = null;
  state.commit = null;
  resetDownstream();
  syncDynamicTools();
  notify();
  if (!uids.length) return fail('That calendar contains no recurring events to operate on.');
  return ok(`Loaded ${filename}: ${uids.length} recurring series.`, {
    series: uids.map((uid) => {
      const g = buildSeriesGraph(cal, uid);
      return { uid, summary: g?.summary ?? '(unreadable)', occurrences: g?.occurrences.length ?? 0 };
    }),
  });
}

export function doSelectSeries(uid: string): string {
  if (!state.calendar) throw new Error('No calendar is loaded.');
  const g = buildSeriesGraph(state.calendar, uid);
  if (!g) return fail(`No recurring series with uid "${uid}".`, { available: state.uids });
  state.selectedUid = uid;
  state.graph = g;
  resetDownstream();
  syncDynamicTools();
  notify();
  const counts = {
    total: g.occurrences.length,
    cancelled: g.occurrences.filter((o) => o.kind === 'cancelled').length,
    overridden: g.occurrences.filter((o) => o.kind === 'overridden').length,
    extra: g.occurrences.filter((o) => o.kind === 'extra').length,
  };
  return ok(`Selected "${g.summary}".`, {
    uid,
    summary: g.summary,
    rule: g.rule,
    timezone: g.tzid ?? '(floating)',
    firstOccurrence: formatHuman(g.dtstartMs, g.tzid),
    lastOccurrence: formatHuman(g.occurrences[g.occurrences.length - 1]?.slotMs ?? g.dtstartMs, g.tzid),
    counts,
    warnings: g.warnings,
    note:
      'The counts above include exceptions that a month grid renders as ordinary meetings. ' +
      'Call list_series_exceptions to see each one with the ordinal that anchors it.',
  });
}

export function doSimulate(params: SplitParams) {
  const g = requireGraph();
  return simulateSplit(g, params);
}

export function doStage(params: SplitParams): string {
  const g = requireGraph();
  const plan = simulateSplit(g, params);
  if (!plan.ok) {
    state.staged = null;
    state.validation = null;
    // Surfaced on the page too: a refusal that only the caller sees looks
    // identical to nothing having happened.
    state.refusals = plan.refusals;
    unregisterCommit();
    notify();
    return fail('The change was not staged because it cannot be applied safely.', {
      refusals: plan.refusals,
    });
  }
  state.refusals = null;
  const safe = applySplit(state.calendar!, g, plan).calendar;
  const naive = applyNaive(state.calendar!, g, plan).calendar;
  const comparison = compareResults(g, plan, safe, naive);
  state.staged = { params, plan, safe, naive, comparison, stagedAt: Date.now() };
  state.validation = null;
  unregisterCommit();
  notify();
  return ok('Staged. Nothing has been committed yet — call validate_staged_split next.', {
    from: plan.oldRuleText,
    to: plan.newRuleText,
    keptUnchanged: plan.pastOccurrences.length,
    moved: plan.futureOccurrences.length,
    endPolicy: plan.endPolicy,
    lastOccurrence: plan.newEndsAtMs
      ? `${formatHuman(plan.newEndsAtMs, g.tzid)}${
          plan.endDateShifted && plan.oldEndsAtMs
            ? ` (was ${formatHuman(plan.oldEndsAtMs, g.tzid)})`
            : ''
        }`
      : undefined,
    reanchored: plan.remaps.map((r) => ({
      kind: r.kind,
      from: formatHuman(r.oldSlotMs, g.tzid),
      toSlot: formatHuman(r.newSlotMs, g.tzid),
      keepsItsOwnStart: r.keptStartMs ? formatHuman(r.keptStartMs, g.tzid) : undefined,
      carriedProperties: r.carried,
    })),
    wouldBeLostByAConventionalEdit: plan.naiveLosses.map((l) => `${l.label} — ${l.detail}`),
  });
}

export function doValidate(): string {
  const g = requireGraph();
  if (!state.staged) return fail('Nothing is staged. Call stage_series_split first.');
  const report = validateStage(state.calendar!, state.staged.safe, g, state.staged.plan);
  state.validation = report;
  if (report.pass) registerCommit();
  else unregisterCommit();
  notify();
  return ok(
    report.pass
      ? `All ${report.checks.length} invariants hold. The tool "commit_staged_split" is now available.`
      : `Validation failed. Commit stays unavailable.`,
    {
      pass: report.pass,
      checks: report.checks.map((c) => ({ id: c.id, title: c.title, pass: c.pass, evidence: c.evidence })),
    },
  );
}

export function doCommit(): string {
  const g = requireGraph();
  if (!state.staged) return fail('Nothing is staged.');
  if (!state.validation?.pass) return fail('Validation has not passed. Commit is not permitted.');
  state.commit = {
    before: cloneComponent(state.calendar!),
    after: state.staged.safe,
    at: Date.now(),
    summary: `${g.summary}: ${state.staged.plan.oldRuleText} → ${state.staged.plan.newRuleText}`,
    validation: state.validation!,
    preserved: state.staged.plan.naiveLosses.length,
  };
  state.calendar = state.staged.safe;
  state.uids = listRecurringUids(state.calendar);
  state.selectedUid = state.staged.plan.newUid;
  state.graph = buildSeriesGraph(state.calendar, state.staged.plan.newUid);
  const preserved = state.staged.plan.naiveLosses.length;
  state.staged = null;
  state.validation = null;
  registerUndo();
  withdrawAfterReturn('commit', commitController);
  notify();
  return ok(
    `Committed. ${preserved} item(s) that a conventional edit would have destroyed are still present. ` +
      `"undo_series_split" is now available.`,
  );
}

export function doUndo(): string {
  if (!state.commit) return fail('There is nothing to undo.');
  state.calendar = state.commit.before;
  state.uids = listRecurringUids(state.calendar);
  state.selectedUid = state.uids[0] ?? null;
  state.graph = state.selectedUid ? buildSeriesGraph(state.calendar, state.selectedUid) : null;
  const what = state.commit.summary;
  state.commit = null;
  resetDownstream();
  withdrawAfterReturn('undo', undoController);
  notify();
  return ok(`Reverted: ${what}`);
}

/* ------------------------------------------------------------------ */
/* Tool registration                                                   */
/* ------------------------------------------------------------------ */

const registered: string[] = [];

async function reg(def: any, options?: any): Promise<void> {
  const mc = modelContext();
  if (!mc) return;
  // Chrome resolves registerTool with undefined; nothing is read from it.
  await mc.registerTool(def, options);
  if (!registered.includes(def.name)) registered.push(def.name);
  notify();
}

export function registeredToolNames(): string[] {
  return [...registered];
}

function registerCommit(): void {
  if (commitController) return;
  commitController = new AbortController();
  void reg(
    {
      name: 'commit_staged_split',
      description:
        'Apply the staged change to the calendar. This tool only exists after validate_staged_split has ' +
        'reported that every invariant holds; if validation has not passed, it is not registered at all.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        const r = doCommit();
        logCall('commit_staged_split', r.split('\n')[0], !r.startsWith('REFUSED'));
        return r;
      },
    },
    { signal: commitController.signal },
  );
}

function unregisterCommit(): void {
  commitController?.abort();
  commitController = null;
  const i = registered.indexOf('commit_staged_split');
  if (i >= 0) registered.splice(i, 1);
  notify();
}

function registerUndo(): void {
  if (undoController) return;
  undoController = new AbortController();
  void reg(
    {
      name: 'undo_series_split',
      description:
        'Restore the calendar to its state before the last commit. Registered only while a commit exists.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        const r = doUndo();
        logCall('undo_series_split', r.split('\n')[0], !r.startsWith('REFUSED'));
        return r;
      },
    },
    { signal: undoController.signal },
  );
}

function unregisterUndo(): void {
  undoController?.abort();
  undoController = null;
  const i = registered.indexOf('undo_series_split');
  if (i >= 0) registered.splice(i, 1);
  notify();
}

/**
 * Register the always-available tools.
 *
 * The set is deliberately narrow and sequential. There is no `fix_my_calendar`
 * tool: the agent has to read the structure, propose a change, look at what the
 * simulation says it would cost, and only then stage, validate and commit. The
 * page refuses at every step it cannot prove.
 */
export async function registerSeriesSafeTools(): Promise<boolean> {
  const mc = modelContext();
  if (!mc) return false;

  await reg({
    name: 'load_calendar',
    description:
      'Load an iCalendar (.ics) document into SeriesSafe so its recurring series can be examined. ' +
      'Pass source="sample" to load the bundled language-school calendar, or source="text" with the ics content.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['sample', 'text'], description: 'Where the calendar comes from.' },
        ics: { type: 'string', description: 'Raw .ics content. Required when source is "text".' },
      },
      required: ['source'],
    },
    execute: async ({ source, ics }: { source: string; ics?: string }) => {
      const r =
        source === 'sample'
          ? doLoadCalendar(SAMPLE_ICS, 'sample-language-school.ics')
          : doLoadCalendar(ics ?? '', 'pasted.ics');
      logCall('load_calendar', r.split('\n')[0], !r.startsWith('REFUSED'));
      return r;
    },
  });

  await reg({
    name: 'list_recurring_series',
    description:
      'List every recurring series in the loaded calendar, with how many occurrences and exceptions each has.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      if (!state.calendar) return fail('No calendar is loaded.');
      const data = state.uids.map((uid) => {
        const g = buildSeriesGraph(state.calendar!, uid);
        return {
          uid,
          summary: g?.summary,
          rule: g ? g.rule.freq : undefined,
          occurrences: g?.occurrences.length,
          exceptions: g ? g.occurrences.filter((o) => o.kind !== 'normal').length : 0,
        };
      });
      const r = ok(`${data.length} recurring series.`, data);
      logCall('list_recurring_series', `${data.length} series`);
      return r;
    },
  });

  await reg({
    name: 'inspect_series',
    description:
      'Select one recurring series and return its underlying structure: the recurrence rule, time zone, ' +
      'first and last occurrence, and how many occurrences are cancelled, individually overridden or added. ' +
      'This is the semantic state behind the calendar grid, not what the grid displays.',
    inputSchema: {
      type: 'object',
      properties: { uid: { type: 'string', description: 'The UID of the series to inspect.' } },
      required: ['uid'],
    },
    execute: async ({ uid }: { uid: string }) => {
      const r = doSelectSeries(uid);
      logCall('inspect_series', r.split('\n')[0], !r.startsWith('REFUSED'));
      return r;
    },
  });

  await reg({
    name: 'list_series_exceptions',
    description:
      'Enumerate every occurrence of the selected series that differs from the plain pattern: cancellations, ' +
      'detached overrides (moved, relocated, or given a different roster) and explicitly added dates. Each is ' +
      'returned with the ordinal position that anchors it, which is what makes a safe re-anchoring possible.',
    inputSchema: {
      type: 'object',
      properties: {
        onlyAfter: {
          type: 'string',
          description: 'Optional ISO date (YYYY-MM-DD); return only exceptions on or after it.',
        },
      },
    },
    execute: async ({ onlyAfter }: { onlyAfter?: string }) => {
      const g = requireGraph();
      const cutoff = onlyAfter ? parseEffectiveDate(onlyAfter, g.tzid) : null;
      const rows = g.occurrences
        .filter((o) => o.kind !== 'normal')
        .filter((o) => (cutoff === null ? true : o.slotMs >= cutoff))
        .map((o) => ({
          ordinal: o.index,
          patternSlot: formatHuman(o.slotMs, g.tzid),
          kind: o.kind,
          actualStart: o.startMs === o.slotMs ? undefined : formatHuman(o.startMs, g.tzid),
          detail: o.note,
        }));
      const r = ok(`${rows.length} exception(s) in "${g.summary}".`, rows);
      logCall('list_series_exceptions', `${rows.length} exceptions`);
      return r;
    },
  });

  await reg({
    name: 'simulate_series_split',
    description:
      'Dry run: work out what changing the recurrence rule from a given date onwards would do, WITHOUT ' +
      'changing anything. Returns the re-anchoring plan, the list of items a conventional "this and following" ' +
      'edit would silently destroy, and any reason the change cannot be made safely.',
    inputSchema: {
      type: 'object',
      properties: {
        effectiveFrom: { type: 'string', description: 'ISO date (YYYY-MM-DD). The change applies from here onwards.' },
        weekdays: {
          type: 'array',
          items: { type: 'string', enum: DAYS },
          description: 'New weekday(s), e.g. ["TH"]. Omit to keep the current days.',
        },
        interval: { type: 'number', description: 'New interval, e.g. 2 for fortnightly. Omit to keep it.' },
        timeOfDay: { type: 'string', description: 'New local start time as HH:MM. Omit to keep it.' },
        endPolicy: {
          type: 'string',
          enum: ['preserve-count', 'keep-end-date'],
          description:
            'What to do with the end of the series. "preserve-count" (default) keeps every remaining meeting, ' +
            'letting the final date shift to the new weekday. "keep-end-date" holds the original end date and ' +
            'is refused if that would drop a meeting.',
        },
      },
      required: ['effectiveFrom'],
    },
    execute: async (args: any) => {
      const g = requireGraph();
      const from = parseEffectiveDate(args.effectiveFrom, g.tzid);
      if (from === null) return fail(`"${args.effectiveFrom}" is not a date I can read. Use YYYY-MM-DD.`);
      const plan = doSimulate({
        effectiveFromMs: from,
        byday: args.weekdays,
        interval: args.interval,
        timeOfDay: args.timeOfDay,
        endPolicy: args.endPolicy,
      });
      const r = plan.ok
        ? ok('Safe to stage.', {
            unchangedBefore: plan.pastOccurrences.length,
            movedFrom: plan.oldRuleText,
            movedTo: plan.newRuleText,
            firstNewOccurrence: formatHuman(plan.newDtstartMs, g.tzid),
            lastOccurrence: plan.newEndsAtMs
              ? `${formatHuman(plan.newEndsAtMs, g.tzid)}${
                  plan.endDateShifted && plan.oldEndsAtMs
                    ? ` (was ${formatHuman(plan.oldEndsAtMs, g.tzid)}; the end date moves so the meeting count is kept)`
                    : ''
                }`
              : undefined,
            reanchoring: plan.remaps.map((x) => ({
              kind: x.kind,
              from: formatHuman(x.oldSlotMs, g.tzid),
              toSlot: formatHuman(x.newSlotMs, g.tzid),
              keepsItsOwnStart: x.keptStartMs ? formatHuman(x.keptStartMs, g.tzid) : undefined,
            })),
            aConventionalEditWouldDestroy: plan.naiveLosses.map((l) => `${l.label} — ${l.detail}`),
          })
        : fail('This change cannot be applied safely.', { refusals: plan.refusals });
      logCall('simulate_series_split', plan.ok ? `${plan.remaps.length} re-anchorings` : 'refused', plan.ok);
      return r;
    },
  });

  await reg({
    name: 'stage_series_split',
    description:
      'Prepare the change without committing it. Refuses outright if the simulation found anything it cannot ' +
      're-anchor with certainty. After staging, call validate_staged_split.',
    inputSchema: {
      type: 'object',
      properties: {
        effectiveFrom: { type: 'string', description: 'ISO date (YYYY-MM-DD).' },
        weekdays: { type: 'array', items: { type: 'string', enum: DAYS }, description: 'New weekday(s).' },
        interval: { type: 'number', description: 'New interval.' },
        timeOfDay: { type: 'string', description: 'New local start time as HH:MM.' },
        endPolicy: {
          type: 'string',
          enum: ['preserve-count', 'keep-end-date'],
          description:
            'What to do with the end of the series. "preserve-count" (default) keeps every remaining meeting, ' +
            'letting the final date shift to the new weekday. "keep-end-date" holds the original end date and ' +
            'is refused if that would drop a meeting.',
        },
      },
      required: ['effectiveFrom'],
    },
    execute: async (args: any) => {
      const g = requireGraph();
      const from = parseEffectiveDate(args.effectiveFrom, g.tzid);
      if (from === null) return fail(`"${args.effectiveFrom}" is not a date I can read. Use YYYY-MM-DD.`);
      const r = doStage({
        effectiveFromMs: from,
        byday: args.weekdays,
        interval: args.interval,
        timeOfDay: args.timeOfDay,
        endPolicy: args.endPolicy,
      });
      logCall('stage_series_split', r.split('\n')[0], !r.startsWith('REFUSED'));
      return r;
    },
  });

  await reg({
    name: 'validate_staged_split',
    description:
      'Check the staged result against every safety invariant, working from the serialized .ics bytes rather ' +
      'than from memory. Returns per-check evidence. Only if all checks pass does the page register the ' +
      'commit_staged_split tool.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const r = doValidate();
      logCall('validate_staged_split', state.validation?.pass ? 'all invariants hold' : 'failed', !!state.validation?.pass);
      return r;
    },
  });

  await reg({
    name: 'compare_with_conventional_edit',
    description:
      'Show the same staged change applied two ways: as SeriesSafe applies it, and as a conventional calendar ' +
      '"this and following" edit applies it. Use this to report concretely what the user would have lost.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      requireGraph();
      if (!state.staged) return fail('Nothing is staged.');
      // Measured by re-reading both calendars, not replayed from the plan.
      const { comparison: cmp } = state.staged;
      const r = ok('Side-by-side result of the same request, read back from both calendars.', {
        method: 'Both results were serialized, re-parsed, and inspected for each customised occurrence.',
        seriesSafe: { stillPresent: cmp.preserved, of: cmp.items.length },
        conventionalEdit: { destroyed: cmp.destroyed, of: cmp.items.length },
        items: cmp.items.map((i) => ({
          what: `${i.what} — ${i.when}`,
          detail: i.detail,
          seriesSafe: i.inSeriesSafe ? 'kept' : 'lost',
          conventionalEdit: i.inConventional ? 'kept' : 'lost',
        })),
      });
      logCall('compare_with_conventional_edit', `${cmp.destroyed} of ${cmp.items.length} destroyed by a conventional edit`);
      return r;
    },
  });

  await reg({
    name: 'export_calendar_ics',
    description:
      'Return the current calendar as .ics text, ready to re-import into Google Calendar, Outlook or Apple Calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        which: {
          type: 'string',
          enum: ['current', 'staged', 'conventional'],
          description: 'Which version to export. "conventional" returns the lossy comparison result.',
        },
      },
    },
    execute: async ({ which = 'current' }: { which?: string }) => {
      let cal = state.calendar;
      if (which === 'staged') cal = state.staged?.safe ?? null;
      if (which === 'conventional') cal = state.staged?.naive ?? null;
      if (!cal) return fail(`Nothing to export for "${which}".`);
      const text = serializeIcs(cal);
      logCall('export_calendar_ics', `${which}, ${text.length} bytes`);
      return ok(`${which} calendar, ${text.length} bytes:`, { ics: text });
    },
  });

  notify();
  return true;
}
