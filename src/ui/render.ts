import { state } from '../state.ts';
import { formatHuman } from '../engine/split.ts';
import { registeredToolNames, webmcpAvailable } from '../webmcp/tools.ts';
import { usingHarness } from '../webmcp/harness.ts';
import { WALKTHROUGH } from '../webmcp/walkthrough.ts';
import type { Occurrence } from '../engine/series.ts';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const ALWAYS_TOOLS = [
  'load_calendar',
  'list_recurring_series',
  'inspect_series',
  'list_series_exceptions',
  'simulate_series_split',
  'stage_series_split',
  'validate_staged_split',
  'compare_with_conventional_edit',
  'export_calendar_ics',
];

function header(): string {
  const live = webmcpAvailable() && !usingHarness();
  const harness = usingHarness();
  return `
  <header class="top">
    <div class="brand">
      <h1>🗓️ SeriesSafe</h1>
      <p class="lede">Move a recurring event to a different day — from a chosen date onward — without losing the cancellations, make-ups, room changes and reminders you already set.</p>
      <p>Calendar apps do this by ending the old series and creating a new one. Everything you customised after that date is silently discarded. SeriesSafe re-anchors it instead, and proves the result before committing.</p>
    </div>
    <div class="badge ${live ? 'on' : 'off'}" title="${
      live
        ? 'This browser provides document.modelContext, so an agent can call the tools directly.'
        : 'No browser WebMCP implementation found; a local stand-in is running the same tool definitions.'
    }">
      <span class="dot"></span>${
        live ? 'WebMCP connected' : harness ? 'WebMCP not in this browser — local harness' : 'WebMCP not detected'
      }
    </div>
  </header>`;
}

function loadCard(): string {
  if (state.calendar) {
    const list = state.uids
      .map((uid) => {
        const sel = uid === state.selectedUid;
        return `<button data-act="select" data-uid="${esc(uid)}" class="${sel ? 'primary' : ''}">${esc(
          shortName(uid),
        )}</button>`;
      })
      .join(' ');
    return `
    <div class="card">
      <h2>Calendar</h2>
      <p class="hint"><code>${esc(state.filename)}</code> — ${state.uids.length} recurring series</p>
      <div class="row">${list}
        <button data-act="reset">Load something else</button>
      </div>
    </div>`;
  }
  return `
  <div class="card">
    <h2>Start</h2>
    <p class="hint">Use the bundled language-school calendar, or drop in a real <code>.ics</code> export from Google Calendar, Outlook or Apple Calendar. Everything runs locally in this tab — no file is uploaded anywhere.</p>
    <div class="row">
      <button class="primary" data-act="sample">Load the sample calendar</button>
      <button data-act="pick">Open an .ics file…</button>
      <input type="file" id="file" accept=".ics,text/calendar" hidden />
    </div>
    <p class="kbd-hint" style="margin-top:12px">In a hurry? Use <strong>“Watch an agent do it”</strong> below — it runs the whole eight-call sequence for you.</p>
    <p class="kbd-hint">The sample mirrors a real Google export: folded lines, a VTIMEZONE block, multi-value EXDATE, an RDATE, three detached overrides, alarms and private X- properties.</p>
  </div>`;
}

function shortName(uid: string): string {
  return uid.split('@')[0].replace(/-seriessafe-\d+$/, ' (moved)');
}

function occRow(o: Occurrence, tz: string | undefined, effective: number | null): string {
  const past = effective !== null && o.slotMs < effective;
  const tag =
    o.kind === 'cancelled' ? 'cancelled'
    : o.kind === 'overridden' ? 'customised'
    : o.kind === 'extra' ? 'added'
    : '';
  const when = formatHuman(o.startMs, tz);
  const slotNote =
    o.kind === 'overridden' && o.startMs !== o.slotMs
      ? `moved from ${formatHuman(o.slotMs, tz)}`
      : o.note ?? '';
  return `
  <div class="occ ${o.kind} ${past ? 'past' : ''}">
    <span class="idx">${o.index + 1}</span>
    <span><span class="when">${esc(when)}</span>${slotNote ? ` <span class="note">— ${esc(slotNote)}</span>` : ''}</span>
    ${tag ? `<span class="tag">${tag}</span>` : '<span></span>'}
  </div>`;
}

function timelineCard(): string {
  const g = state.graph;
  if (!g) return '';
  const eff = currentEffectiveMs();
  const rows = g.occurrences.map((o) => occRow(o, g.tzid, eff));
  let html = '';
  let inserted = false;
  g.occurrences.forEach((o, i) => {
    if (!inserted && eff !== null && o.slotMs >= eff) {
      html += `<div class="divider">change applies from here</div>`;
      inserted = true;
    }
    html += rows[i];
  });
  const counts = {
    c: g.occurrences.filter((o) => o.kind === 'cancelled').length,
    o: g.occurrences.filter((o) => o.kind === 'overridden').length,
    e: g.occurrences.filter((o) => o.kind === 'extra').length,
  };
  return `
  <div class="card">
    <h2>${esc(g.summary)}</h2>
    <p class="hint">
      <code>${esc(g.rule.freq)}</code> in <code>${esc(g.tzid ?? 'floating')}</code> ·
      ${g.occurrences.length} occurrences ·
      <strong style="color:var(--lose)">${counts.c} cancelled</strong>,
      <strong style="color:var(--custom)">${counts.o} customised</strong>,
      <strong style="color:var(--accent)">${counts.e} added</strong>.
      A month grid shows these as ordinary meetings; the structure below is what actually defines them.
    </p>
    ${g.warnings.map((w) => `<div class="refusal"><strong>Heads up</strong><em>${esc(w)}</em></div>`).join('')}
    <div class="timeline">${html}</div>
  </div>`;
}

function currentEffectiveMs(): number | null {
  const el = document.getElementById('eff') as HTMLInputElement | null;
  const v = el?.value || pendingEffective;
  if (!v) return null;
  const g = state.graph;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (!g?.tzid) return naive;
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: g.tzid, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(naive));
    const get = (t: string) => +(p.find((x) => x.type === t)?.value ?? '0');
    let hh = get('hour'); if (hh === 24) hh = 0;
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hh, get('minute'), get('second'));
    return naive - (asUtc - naive);
  } catch {
    return naive;
  }
}

export let pendingEffective = '2026-09-01';
export function setPendingEffective(v: string): void { pendingEffective = v; }

const DAY_OPTS: Array<[string, string]> = [
  ['MO', 'Monday'], ['TU', 'Tuesday'], ['WE', 'Wednesday'], ['TH', 'Thursday'],
  ['FR', 'Friday'], ['SA', 'Saturday'], ['SU', 'Sunday'],
];

function requestCard(): string {
  if (!state.graph) return '';
  const g = state.graph;
  const cur = g.rule.byday[0] ?? '';
  return `
  <div class="card">
    <h2>The change</h2>
    <div class="ask">
      <span>what a person would actually say</span>
      “From September, move my Tuesday class to Thursday — but keep the holidays I cancelled, the make-up I already moved, and the guest-lecture room.”
    </div>
    <div class="row">
      <div class="field">
        <label for="eff">Effective from</label>
        <input type="date" id="eff" value="${esc(pendingEffective)}" />
      </div>
      <div class="field">
        <label for="day">New weekday</label>
        <select id="day">
          ${DAY_OPTS.map(([v, l]) => `<option value="${v}" ${v === 'TH' ? 'selected' : ''}>${l}${v === cur ? ' (current)' : ''}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="tod">Time (optional)</label>
        <input type="time" id="tod" />
      </div>
      <div class="field">
        <label for="endp">End of series</label>
        <select id="endp">
          <option value="preserve-count">Keep every remaining meeting</option>
          <option value="keep-end-date">Keep the original end date</option>
        </select>
      </div>
      <button class="primary" data-act="stage">Preview the change</button>
    </div>
    <p class="kbd-hint">Nothing is written until you commit — and commit stays locked until every check passes.</p>
  </div>`;
}

function comparisonCard(): string {
  const s = state.staged;
  const g = state.graph;
  if (!s || !g) return '';
  const { plan } = s;

  if (!plan.ok) {
    return `<div class="card"><h2>Refused</h2>
      ${plan.refusals.map((r) => `<div class="refusal"><strong>${esc(r.message)}</strong><em>${esc(r.remedy)}</em></div>`).join('')}
    </div>`;
  }

  const kept = plan.remaps.map((r) => {
    const what =
      r.kind === 'cancellation' ? 'Cancellation'
      : r.kind === 'extra' ? 'Added session'
      : 'Customised meeting';
    const detail =
      r.kind === 'override'
        ? `stays on ${formatHuman(r.keptStartMs!, g.tzid)}, re-anchored to the new ${formatHuman(r.newSlotMs, g.tzid)} slot`
        : r.kind === 'extra'
        ? 'keeps its own date'
        : `moves to ${formatHuman(r.newSlotMs, g.tzid)}, still cancelled`;
    return `<li><span class="mark">✓</span><span class="txt"><strong>${what} — ${esc(formatHuman(r.oldSlotMs, g.tzid))}</strong><em>${esc(detail)}</em></span></li>`;
  });

  const lost = plan.naiveLosses.map(
    (l) => `<li><span class="mark">✕</span><span class="txt"><strong>${esc(l.label)}</strong><em>${esc(l.detail)}</em></span></li>`,
  );

  return `
  <div class="card">
    <h2>Same request, two ways</h2>
    <p class="hint">${plan.pastOccurrences.length} past meetings stay exactly as they are. ${plan.futureOccurrences.length} move to the new day. The difference is what happens to the ${plan.naiveLosses.length} things you had customised.</p>
    ${
      plan.endDateShifted && plan.oldEndsAtMs && plan.newEndsAtMs
        ? `<div class="ask" style="border-left-color:var(--custom)"><span>one consequence worth seeing</span>
            The series now ends <strong>${esc(formatHuman(plan.newEndsAtMs, g.tzid))}</strong> instead of
            ${esc(formatHuman(plan.oldEndsAtMs, g.tzid))} — the last ${esc(DAY_OPTS.find(([v]) => v === (plan.newRuleText.match(/BYDAY=([A-Z,]+)/)?.[1] ?? ''))?.[1] ?? 'day')} falls after the old end date.
            Holding the old end date instead would quietly cost you a meeting, so that option is refused.
          </div>`
        : ''
    }
    <div class="compare">
      <div class="pane win">
        <h3>SeriesSafe</h3>
        <div class="count">${plan.remaps.length}</div>
        <div class="sub">preserved and re-anchored</div>
        <ul>${kept.join('')}</ul>
      </div>
      <div class="pane lose">
        <h3>A conventional “this and following” edit</h3>
        <div class="count">${plan.naiveLosses.length}</div>
        <div class="sub">silently destroyed</div>
        <ul>${lost.join('')}</ul>
      </div>
    </div>
    <div class="row" style="margin-top:16px">
      <button class="go" data-act="validate">Check every invariant</button>
      <button data-act="export-staged">Download the safe .ics</button>
      <button data-act="export-naive">Download the lossy one, to compare</button>
    </div>
  </div>`;
}

function validationCard(): string {
  const v = state.validation ?? state.commit?.validation ?? null;
  if (!v) return '';
  const committed = !state.validation && !!state.commit;
  const rows = v.checks
    .map(
      (c) => `<div class="check ${c.pass ? 'pass' : 'fail'}">
      <span class="mark">${c.pass ? '✓' : '✕'}</span>
      <span class="body"><strong>${esc(c.title)}</strong><span>${esc(c.evidence)}</span></span>
    </div>`,
    )
    .join('');
  return `
  <div class="card">
    <h2>Proof</h2>
    <p class="hint">Checked against the serialized <code>.ics</code> bytes, not the in-memory plan — so a bug in the writer cannot slip through.</p>
    ${rows}
    ${
      committed
        ? ''
        : `<div class="row" style="margin-top:16px">
      <button class="primary" data-act="commit" ${v.pass ? '' : 'disabled'}>
        ${v.pass ? 'Commit the change' : 'Commit locked — checks failed'}
      </button>
    </div>`
    }
  </div>`;
}

function committedCard(): string {
  if (!state.commit) return '';
  return `
  <div class="card">
    <h2>Committed</h2>
    <p class="hint"><strong style="color:var(--keep)">${state.commit.preserved} item(s) that a conventional edit would have destroyed are still there.</strong><br />${esc(state.commit.summary)}</p>
    <div class="row">
      <button data-act="export-current" class="primary">Download the updated .ics</button>
      <button data-act="undo" class="danger">Undo</button>
    </div>
  </div>`;
}

function walkthroughNarration(): string {
  const w = state.walkthrough;
  if (!w) return '';
  return `
  <div class="ask" style="margin-top:14px;border-left-color:${w.done ? 'var(--keep)' : 'var(--accent)'}">
    <span>${w.done ? 'sequence complete' : `step ${w.index + 1} of ${w.total} · ${esc(w.tool)}`}</span>
    ${esc(w.why)}
  </div>`;
}

function agentCard(): string {
  const dynamic = registeredToolNames().filter((n) => !ALWAYS_TOOLS.includes(n));
  const chips = [
    ...ALWAYS_TOOLS.map((n) => `<span class="tool-chip">${esc(n)}</span>`),
    ...dynamic.map((n) => `<span class="tool-chip dynamic">${esc(n)} · just appeared</span>`),
  ].join('');
  const entries = state.log
    .slice()
    .reverse()
    .map(
      (e) => `<div class="entry ${e.ok ? '' : 'bad'}">
      <span class="t">${new Date(e.at).toLocaleTimeString('en-GB', { hour12: false })}</span>
      <span class="tool">${esc(e.tool)}</span>
      <span class="d">${esc(e.detail)}</span>
    </div>`,
    )
    .join('');
  return `
  <div class="card">
    <h2>Tools this page exposes</h2>
    <p class="hint">${
      usingHarness()
        ? 'This browser has no WebMCP implementation, so the same tool definitions are registered against a local stand-in. Everything below still runs through <code>modelContext.executeTool</code>.'
        : 'An agent can call these directly.'
    } <code>commit_staged_split</code> is not registered until validation passes, and <code>undo_series_split</code> only exists while a commit can be reverted.</p>
    <div class="tools">${chips}</div>
    <div class="row" style="margin-top:14px">
      <button data-act="walkthrough" ${state.walkthrough && !state.walkthrough.done ? 'disabled' : ''}>
        ${state.walkthrough && !state.walkthrough.done
          ? `Running… ${state.walkthrough.index + 1}/${state.walkthrough.total}`
          : `Watch an agent do it (${WALKTHROUGH.length} tool calls)`}
      </button>
    </div>
    ${walkthroughNarration()}
    <h2 style="margin-top:18px">Activity</h2>
    <div class="log">${entries || '<div class="empty">Nothing yet.</div>'}</div>
  </div>`;
}

export function render(): void {
  const app = document.getElementById('app')!;
  const active = document.activeElement as HTMLElement | null;
  const activeId = active?.id;
  const selStart = (active as HTMLInputElement)?.selectionStart ?? null;

  app.innerHTML = `
    ${header()}
    <div class="grid">
      <div>
        ${loadCard()}
        ${timelineCard()}
        ${agentCard()}
      </div>
      <div>
        ${requestCard()}
        ${comparisonCard()}
        ${validationCard()}
        ${committedCard()}
      </div>
    </div>
    <p class="footnote">Runs entirely in your browser. Nothing is uploaded. ·
      <a href="https://github.com/skaiea13-ai/seriessafe">Source</a></p>
  `;

  if (activeId) {
    const el = document.getElementById(activeId) as HTMLInputElement | null;
    if (el) {
      el.focus();
      if (selStart !== null && el.setSelectionRange && el.type !== 'date' && el.type !== 'time') {
        try { el.setSelectionRange(selStart, selStart); } catch { /* not selectable */ }
      }
    }
  }
}
