import { state, subscribe, logCall } from './state.ts';
import { render, setPendingEffective } from './ui/render.ts';
import { serializeIcs } from './ics/serialize.ts';
import { startOfDayInZone } from './ics/parse.ts';
import { SAMPLE_ICS } from './sample.ts';
import { installHarnessIfAbsent, usingHarness } from './webmcp/harness.ts';
import { runWalkthrough } from './webmcp/walkthrough.ts';
import {
  registerSeriesSafeTools,
  resetAll,
  doLoadCalendar,
  doSelectSeries,
  doStage,
  doValidate,
  doCommit,
  doUndo,
} from './webmcp/tools.ts';

function download(name: string, text: string): void {
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readForm(): {
  effectiveFrom: string;
  weekdays: string[];
  timeOfDay?: string;
  endPolicy: 'preserve-count' | 'keep-end-date';
} {
  const eff = (document.getElementById('eff') as HTMLInputElement)?.value || '2026-09-01';
  const day = (document.getElementById('day') as HTMLSelectElement)?.value || 'TH';
  const tod = (document.getElementById('tod') as HTMLInputElement)?.value || '';
  const endPolicy =
    ((document.getElementById('endp') as HTMLSelectElement)?.value as
      | 'preserve-count'
      | 'keep-end-date') || 'preserve-count';
  setPendingEffective(eff);
  return { effectiveFrom: eff, weekdays: [day], timeOfDay: tod || undefined, endPolicy };
}

/** Turn the form's ISO date into the same instant the tools compute. */
function effectiveMs(iso: string): number {
  return startOfDayInZone(iso, state.graph?.tzid) ?? Date.now();
}

document.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!btn) return;
  const act = btn.dataset.act;

  try {
    switch (act) {
      case 'sample': {
        const r = doLoadCalendar(SAMPLE_ICS, 'sample-language-school.ics');
        logCall('load_calendar', r.split('\n')[0], true, 'user');
        if (state.uids[0]) doSelectSeries(state.uids[0]);
        break;
      }
      case 'pick':
        (document.getElementById('file') as HTMLInputElement)?.click();
        break;
      case 'reset':
        resetAll();
        break;
      case 'select':
        doSelectSeries(btn.dataset.uid!);
        logCall('inspect_series', btn.dataset.uid!, true, 'user');
        break;
      case 'stage': {
        const f = readForm();
        const r = doStage({
          effectiveFromMs: effectiveMs(f.effectiveFrom),
          byday: f.weekdays,
          timeOfDay: f.timeOfDay,
          endPolicy: f.endPolicy,
        });
        logCall('stage_series_split', r.split('\n')[0], !r.startsWith('REFUSED'), 'user');
        break;
      }
      case 'validate': {
        doValidate();
        logCall('validate_staged_split', state.validation?.pass ? 'all invariants hold' : 'failed', !!state.validation?.pass, 'user');
        break;
      }
      case 'commit': {
        const r = doCommit();
        logCall('commit_staged_split', r.split('\n')[0], !r.startsWith('REFUSED'), 'user');
        break;
      }
      case 'walkthrough': {
        const b = btn as HTMLButtonElement;
        b.disabled = true;
        b.textContent = 'Running…';
        resetAll();
        state.log = [];
        state.walkthrough = null;
        runWalkthrough(render)
          .catch((err) => logCall('walkthrough', (err as Error).message, false))
          .finally(render);
        break;
      }
      case 'undo': {
        const r = doUndo();
        logCall('undo_series_split', r.split('\n')[0], !r.startsWith('REFUSED'), 'user');
        break;
      }
      case 'export-staged':
        if (state.staged) download('seriessafe-preserved.ics', serializeIcs(state.staged.safe));
        break;
      case 'export-naive':
        if (state.staged) download('conventional-edit-lossy.ics', serializeIcs(state.staged.naive));
        break;
      case 'export-current':
        if (state.calendar) download('calendar-updated.ics', serializeIcs(state.calendar));
        break;
      default:
        break;
    }
  } catch (err) {
    logCall(String(act), (err as Error).message, false, 'user');
  }
});

document.addEventListener('change', (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id === 'file' && t.files?.[0]) {
    const file = t.files[0];
    file.text().then((text) => {
      const r = doLoadCalendar(text, file.name);
      logCall('load_calendar', r.split('\n')[0], !r.startsWith('REFUSED'), 'user');
      if (state.uids[0]) doSelectSeries(state.uids[0]);
    });
  }
  if (t.id === 'eff') {
    setPendingEffective(t.value);
    render();
  }
});

subscribe(render);

// Register against the browser's own WebMCP when it has one, and otherwise
// against a local stand-in so the tool layer is still exercisable.
installHarnessIfAbsent();
render();

registerSeriesSafeTools().then((registered) => {
  if (!registered) return;
  logCall(
    'modelContext',
    `9 tools registered via ${usingHarness() ? 'the local harness' : 'the browser WebMCP API'}; ` +
      'commit and undo appear only once they are safe',
    true,
  );
});
