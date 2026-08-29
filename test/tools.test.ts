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
let callTool: typeof import('../src/webmcp/harness.ts').callTool;

before(async () => {
  const harness = await import('../src/webmcp/harness.ts');
  assert.equal(harness.installHarnessIfAbsent(), true, 'harness installs when no WebMCP exists');
  callTool = harness.callTool;
  tools = await import('../src/webmcp/tools.ts');
  assert.equal(await tools.registerSeriesSafeTools(), true);
  mc = (globalThis as any).document.modelContext;
});

const names = async (): Promise<string[]> => (await mc.getTools()).map((t: any) => t.name);
/** Invoke exactly as Chrome requires: a RegisteredTool plus a JSON string. */
const call = (name: string, args: Record<string, unknown> = {}) => callTool(mc, name, args);

test('the always-available tools are registered with usable schemas', async () => {
  const list = await mc.getTools();
  assert.equal(list.length, 9);
  for (const t of list) {
    assert.ok(t.name && /^[a-z][a-z0-9_]*$/.test(t.name), `${t.name} is a sane tool name`);
    assert.ok(t.description.length > 40, `${t.name} explains itself`);
    // Chrome hands inputSchema back as a JSON string, not an object.
    assert.equal(typeof t.inputSchema, 'string');
    assert.equal(JSON.parse(t.inputSchema).type, 'object');
    assert.ok(typeof t.origin === 'string');
  }
  assert.ok(!(await names()).includes('commit_staged_split'), 'commit is not offered up front');
});

test('commit is unreachable until validation has passed', async () => {
  await call('load_calendar', { source: 'sample' });
  await call('inspect_series', { uid: 'advanced-korean-tue@school.example.com' });

  await assert.rejects(
    () => call('commit_staged_split'),
    /No tool named/,
    'the commit tool does not exist before staging',
  );

  const sim = await call('simulate_series_split', {
    effectiveFrom: '2026-09-01', weekdays: ['TH'],
  });
  assert.match(sim, /Safe to stage/);
  assert.ok(!(await names()).includes('commit_staged_split'), 'a dry run does not unlock commit');

  await call('stage_series_split', { effectiveFrom: '2026-09-01', weekdays: ['TH'] });
  assert.ok(!(await names()).includes('commit_staged_split'), 'staging alone does not unlock commit');

  const val = await call('validate_staged_split');
  assert.match(val, /All 8 invariants hold/);
  assert.ok((await names()).includes('commit_staged_split'), 'commit appears once the result is proven');

  const done = await call('commit_staged_split');
  assert.match(done, /5 item\(s\)/);
  assert.ok((await names()).includes('undo_series_split'), 'undo becomes available immediately');

  // A tool withdraws itself only after its own call has returned: cancelling
  // the registration signal mid-execution aborts that execution on Chrome 152
  // and earlier. One macrotask is enough for the withdrawal to land.
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!(await names()).includes('commit_staged_split'), 'commit is withdrawn again');

  await call('undo_series_split');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!(await names()).includes('undo_series_split'), 'undo is withdrawn after use');
});

test('an unsafe request is refused rather than staged', async () => {
  await call('load_calendar', { source: 'sample' });
  await call('inspect_series', { uid: 'advanced-korean-tue@school.example.com' });
  const r = await call('stage_series_split', { effectiveFrom: '2030-01-01', weekdays: ['TH'] });
  assert.match(r, /^REFUSED/);
  assert.match(r, /NOTHING_AFTER_DATE/);
  assert.ok(!(await names()).includes('commit_staged_split'));
});

test('exceptions are reported with the ordinal that anchors them', async () => {
  await call('load_calendar', { source: 'sample' });
  await call('inspect_series', { uid: 'advanced-korean-tue@school.example.com' });
  const r = await call('list_series_exceptions', { onlyAfter: '2026-09-01' });
  const data = JSON.parse(r.slice(r.indexOf('\n')));
  assert.equal(data.length, 5);
  assert.ok(data.every((d: any) => typeof d.ordinal === 'number'));
  assert.ok(data.some((d: any) => d.kind === 'overridden' && /16 Sept/.test(d.actualStart ?? '')));
});

test('the exported calendar is real ics text', async () => {
  await call('load_calendar', { source: 'sample' });
  await call('inspect_series', { uid: 'advanced-korean-tue@school.example.com' });
  const r = await call('export_calendar_ics', { which: 'current' });
  const data = JSON.parse(r.slice(r.indexOf('\n')));
  assert.match(data.ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(data.ics, /END:VCALENDAR\r\n$/);
});

test('the harness enforces the same calling convention as Chrome 151', async () => {
  const [tool] = await mc.getTools();

  await assert.rejects(
    () => mc.executeTool(tool),
    /2 arguments required/,
    'executeTool needs both arguments, as in Chrome',
  );
  await assert.rejects(
    () => mc.executeTool('load_calendar', JSON.stringify({ source: 'sample' })),
    /not of type 'RegisteredTool'/,
    'a bare tool name is rejected, as in Chrome',
  );
  await assert.rejects(
    () => mc.executeTool(tool, { source: 'sample' } as any),
    /Failed to parse input arguments/,
    'arguments must be a JSON string, as in Chrome',
  );
  assert.equal(
    await mc.registerTool({
      name: 'probe', description: 'x'.repeat(50), inputSchema: { type: 'object' }, execute: () => 'ok',
    }),
    undefined,
    'registerTool resolves with undefined, as in Chrome',
  );
});
