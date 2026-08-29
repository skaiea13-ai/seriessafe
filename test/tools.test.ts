import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Exercise the WebMCP tool layer the way an agent does: entirely through
 * `modelContext.executeTool`, never by calling the internal functions.
 *
 * The tools module touches `document`, so a minimal stand-in is installed
 * before it is imported.
 */
const listeners: Record<string, Array<() => void>> = {};
(globalThis as any).document = {
  addEventListener: (t: string, fn: () => void) => { (listeners[t] ??= []).push(fn); },
  removeEventListener: () => {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, remove: () => {}, click: () => {} }),
  body: { appendChild: () => {}, removeChild: () => {} },
};
// Node already provides a read-only `navigator`; the tools module only reads from it.

let mc: any;
let tools: typeof import('../src/webmcp/tools.ts');

before(async () => {
  const harness = await import('../src/webmcp/harness.ts');
  assert.equal(harness.installHarnessIfAbsent(), true, 'harness installs when no WebMCP exists');
  tools = await import('../src/webmcp/tools.ts');
  assert.equal(await tools.registerSeriesSafeTools(), true);
  mc = (globalThis as any).document.modelContext;
});

const names = async (): Promise<string[]> => (await mc.getTools()).map((t: any) => t.name);

test('the always-available tools are registered with usable schemas', async () => {
  const list = await mc.getTools();
  assert.equal(list.length, 9);
  for (const t of list) {
    assert.ok(t.name && /^[a-z][a-z0-9_]*$/.test(t.name), `${t.name} is a sane tool name`);
    assert.ok(t.description.length > 40, `${t.name} explains itself`);
    assert.equal((t.inputSchema as any).type, 'object');
  }
  assert.ok(!(await names()).includes('commit_staged_split'), 'commit is not offered up front');
});

test('commit is unreachable until validation has passed', async () => {
  await mc.executeTool('load_calendar', { source: 'sample' });
  await mc.executeTool('inspect_series', { uid: 'advanced-korean-tue@school.example.com' });

  await assert.rejects(
    () => mc.executeTool('commit_staged_split', {}),
    /No tool named/,
    'the commit tool does not exist before staging',
  );

  const sim = await mc.executeTool('simulate_series_split', {
    effectiveFrom: '2026-09-01', weekdays: ['TH'],
  });
  assert.match(sim, /Safe to stage/);
  assert.ok(!(await names()).includes('commit_staged_split'), 'a dry run does not unlock commit');

  await mc.executeTool('stage_series_split', { effectiveFrom: '2026-09-01', weekdays: ['TH'] });
  assert.ok(!(await names()).includes('commit_staged_split'), 'staging alone does not unlock commit');

  const val = await mc.executeTool('validate_staged_split', {});
  assert.match(val, /All 8 invariants hold/);
  assert.ok((await names()).includes('commit_staged_split'), 'commit appears once the result is proven');

  const done = await mc.executeTool('commit_staged_split', {});
  assert.match(done, /5 item\(s\)/);
  const after = await names();
  assert.ok(after.includes('undo_series_split'), 'undo becomes available');
  assert.ok(!after.includes('commit_staged_split'), 'commit is withdrawn again');

  await mc.executeTool('undo_series_split', {});
  assert.ok(!(await names()).includes('undo_series_split'), 'undo is withdrawn after use');
});

test('an unsafe request is refused rather than staged', async () => {
  await mc.executeTool('load_calendar', { source: 'sample' });
  await mc.executeTool('inspect_series', { uid: 'advanced-korean-tue@school.example.com' });
  const r = await mc.executeTool('stage_series_split', {
    effectiveFrom: '2030-01-01', weekdays: ['TH'],
  });
  assert.match(r, /^REFUSED/);
  assert.match(r, /NOTHING_AFTER_DATE/);
  assert.ok(!(await names()).includes('commit_staged_split'));
});

test('exceptions are reported with the ordinal that anchors them', async () => {
  await mc.executeTool('load_calendar', { source: 'sample' });
  await mc.executeTool('inspect_series', { uid: 'advanced-korean-tue@school.example.com' });
  const r = await mc.executeTool('list_series_exceptions', { onlyAfter: '2026-09-01' });
  const data = JSON.parse(r.slice(r.indexOf('\n')));
  assert.equal(data.length, 5);
  assert.ok(data.every((d: any) => typeof d.ordinal === 'number'));
  assert.ok(data.some((d: any) => d.kind === 'overridden' && /16 Sept/.test(d.actualStart ?? '')));
});

test('the exported calendar is real ics text', async () => {
  await mc.executeTool('load_calendar', { source: 'sample' });
  await mc.executeTool('inspect_series', { uid: 'advanced-korean-tue@school.example.com' });
  const r = await mc.executeTool('export_calendar_ics', { which: 'current' });
  const data = JSON.parse(r.slice(r.indexOf('\n')));
  assert.match(data.ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(data.ics, /END:VCALENDAR\r\n$/);
});
