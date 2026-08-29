import type { Component } from './ics/types.ts';
import type { SeriesGraph } from './engine/series.ts';
import type { SplitPlan, SplitParams } from './engine/split.ts';
import type { ValidationReport } from './engine/validate.ts';

export interface StagedPatch {
  params: SplitParams;
  plan: SplitPlan;
  /** The calendar as SeriesSafe would write it. */
  safe: Component;
  /** The calendar as a conventional client would write it. */
  naive: Component;
  stagedAt: number;
}

export interface CommitRecord {
  before: Component;
  after: Component;
  at: number;
  summary: string;
}

export interface AppState {
  calendar: Component | null;
  filename: string;
  uids: string[];
  selectedUid: string | null;
  graph: SeriesGraph | null;
  staged: StagedPatch | null;
  validation: ValidationReport | null;
  commit: CommitRecord | null;
  /** Chronological trace of every tool call, shown live in the UI. */
  log: Array<{ at: number; actor: 'agent' | 'user'; tool: string; detail: string; ok: boolean }>;
}

export const state: AppState = {
  calendar: null,
  filename: '',
  uids: [],
  selectedUid: null,
  graph: null,
  staged: null,
  validation: null,
  commit: null,
  log: [],
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(): void {
  for (const fn of listeners) fn();
}

export function logCall(tool: string, detail: string, ok = true, actor: 'agent' | 'user' = 'agent'): void {
  state.log.push({ at: Date.now(), actor, tool, detail, ok });
  if (state.log.length > 200) state.log.shift();
  notify();
}

/** Clear everything downstream of the selected series. */
export function resetDownstream(): void {
  state.staged = null;
  state.validation = null;
}
