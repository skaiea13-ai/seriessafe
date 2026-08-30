import type { Component } from './ics/types.ts';
import type { SeriesGraph } from './engine/series.ts';
import type { SplitPlan, SplitParams, Refusal } from './engine/split.ts';
import type { ValidationReport } from './engine/validate.ts';
import type { Comparison } from './engine/compare.ts';

export interface StagedPatch {
  params: SplitParams;
  plan: SplitPlan;
  /** The calendar as SeriesSafe would write it. */
  safe: Component;
  /** The calendar as a conventional client would write it. */
  naive: Component;
  /** What each result actually contains, read back from both files. */
  comparison: Comparison;
  stagedAt: number;
}

export interface CommitRecord {
  before: Component;
  after: Component;
  at: number;
  summary: string;
  /** Kept so the evidence stays on screen after committing. */
  validation: ValidationReport;
  /** How many items a conventional edit would have destroyed. */
  preserved: number;
}

export interface AppState {
  calendar: Component | null;
  filename: string;
  uids: string[];
  selectedUid: string | null;
  graph: SeriesGraph | null;
  staged: StagedPatch | null;
  /** Why the last attempt was refused. Cleared as soon as one succeeds. */
  refusals: Refusal[] | null;
  validation: ValidationReport | null;
  commit: CommitRecord | null;
  /** Chronological trace of every tool call, shown live in the UI. */
  log: Array<{ at: number; actor: 'agent' | 'user'; tool: string; detail: string; ok: boolean }>;
  /** Set while the scripted agent sequence is running, so the UI can narrate it. */
  walkthrough: { index: number; total: number; tool: string; why: string; done: boolean } | null;
}

export const state: AppState = {
  calendar: null,
  filename: '',
  uids: [],
  selectedUid: null,
  graph: null,
  staged: null,
  refusals: null,
  validation: null,
  commit: null,
  log: [],
  walkthrough: null,
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let queued = false;

/**
 * Coalesce notifications into a single render at the end of the current task.
 *
 * A microtask is used rather than `requestAnimationFrame` on purpose: an agent
 * may drive this page while it is in a background tab, where rAF is throttled
 * or never fires at all. Batching still collapses the several state changes a
 * single tool call makes into one render.
 */
export function notify(): void {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    for (const fn of listeners) fn();
  });
}

/** Render immediately, without waiting for the microtask queue to drain. */
export function notifySync(): void {
  queued = false;
  for (const fn of listeners) fn();
}

export function logCall(
  tool: string,
  detail: string,
  ok = true,
  actor: 'agent' | 'user' = 'agent',
): void {
  state.log.push({ at: Date.now(), actor, tool, detail, ok });
  if (state.log.length > 200) state.log.shift();
  notify();
}

/** Clear everything downstream of the selected series. */
export function resetDownstream(): void {
  state.staged = null;
  state.refusals = null;
  state.validation = null;
}
