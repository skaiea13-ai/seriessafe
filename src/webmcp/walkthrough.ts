import { modelContext } from './tools.ts';
import { callTool } from './harness.ts';
import { logCall, state } from '../state.ts';

/**
 * The sequence an agent actually performs for the headline request.
 *
 * Every step goes through `modelContext.executeTool`, so this exercises the
 * registered tools exactly as an external agent would — it does not call the
 * internal functions directly. The interesting property is step 6: the commit
 * tool does not exist until step 5 has reported that the result is sound.
 */
export interface Step {
  tool: string;
  args?: Record<string, unknown>;
  why: string;
}

export const WALKTHROUGH: Step[] = [
  { tool: 'load_calendar', args: { source: 'sample' }, why: 'Get the calendar in front of me.' },
  { tool: 'list_recurring_series', why: 'See which series exist and which one has exceptions.' },
  {
    tool: 'inspect_series',
    args: { uid: 'advanced-korean-tue@school.example.com' },
    why: 'Read the rule, the zone and how many occurrences are not ordinary.',
  },
  {
    tool: 'list_series_exceptions',
    args: { onlyAfter: '2026-09-01' },
    why: 'Find out exactly what is at risk after the effective date.',
  },
  {
    tool: 'simulate_series_split',
    args: { effectiveFrom: '2026-09-01', weekdays: ['TH'] },
    why: 'Dry run first: what would this cost, and can it be done safely?',
  },
  {
    tool: 'stage_series_split',
    args: { effectiveFrom: '2026-09-01', weekdays: ['TH'] },
    why: 'Prepare the change. Still nothing written.',
  },
  { tool: 'validate_staged_split', why: 'Verify against the serialized file, not the plan.' },
  { tool: 'commit_staged_split', why: 'This tool only became available because validation passed.' },
];

export async function runWalkthrough(announce: () => void): Promise<void> {
  const mc = modelContext();
  if (!mc) throw new Error('No model context is available.');
  try {
    for (let i = 0; i < WALKTHROUGH.length; i++) {
      const step = WALKTHROUGH[i];
      state.walkthrough = { index: i, total: WALKTHROUGH.length, tool: step.tool, why: step.why, done: false };
      announce();
      // Let the narration paint before the call runs.
      await new Promise((r) => setTimeout(r, 430));

      const names: string[] = (await mc.getTools()).map((t: any) => t.name);
      if (!names.includes(step.tool)) {
        logCall(step.tool, `not registered at this point — ${step.why}`, false);
        throw new Error(`"${step.tool}" is not registered yet.`);
      }
      // Resolve the RegisteredTool and pass a JSON string, as Chrome requires.
      await callTool(mc, step.tool, step.args ?? {});
      await new Promise((r) => setTimeout(r, 170));
    }
    state.walkthrough = {
      index: WALKTHROUGH.length - 1,
      total: WALKTHROUGH.length,
      tool: 'done',
      why: 'Committed — and every exception is still there.',
      done: true,
    };
    announce();
  } catch (err) {
    state.walkthrough = null;
    announce();
    throw err;
  }
}
