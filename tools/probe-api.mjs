#!/usr/bin/env node
/** Probe the exact shape of Chrome's real WebMCP API. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_UNDER_TEST = process.argv[2] ?? 'https://skaiea13-ai.github.io/seriessafe/';
const PORT = 9334;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'probe-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--enable-features=WebMCPTesting,DevToolsWebMCPSupport',
  '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const deadline = Date.now() + 20000;
let version;
while (Date.now() < deadline) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { version = await r.json(); break; } } catch {}
  await new Promise(r => setTimeout(r, 200));
}

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
const send = (method, params = {}, sessionId) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params, ...(sessionId && { sessionId }) })); return new Promise((res, rej) => pending.set(i, { resolve: res, reject: rej })); };

const { targetId } = await send('Target.createTarget', { url: URL_UNDER_TEST });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await new Promise(r => setTimeout(r, 2500));

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  return r.exceptionDetails ? { __error: r.exceptionDetails.exception?.description } : r.result.value;
};

console.log('\n=== RegisteredTool shape ===');
console.log(JSON.stringify(await ev(`
document.modelContext.getTools().then(ts => {
  const t = ts[0];
  return {
    ownKeys: Object.keys(t),
    protoKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(t)),
    ctor: Object.getPrototypeOf(t)?.constructor?.name,
    sample: { name: t.name, description: String(t.description).slice(0,60), inputSchema: t.inputSchema },
  };
})`), null, 2));

console.log('\n=== executeTool call styles ===');
for (const [label, expr] of [
  ['tool object + JSON string', `document.modelContext.getTools().then(ts => document.modelContext.executeTool(ts.find(t=>t.name==='list_recurring_series'), JSON.stringify({})))`],
  ['tool object + object',      `document.modelContext.getTools().then(ts => document.modelContext.executeTool(ts.find(t=>t.name==='list_recurring_series'), {}))`],
  ['tool object + omitted',     `document.modelContext.getTools().then(ts => document.modelContext.executeTool(ts.find(t=>t.name==='list_recurring_series')))`],
  ['name string + JSON string', `document.modelContext.executeTool('list_recurring_series', JSON.stringify({}))`],
]) {
  const r = await ev(`(async()=>{ try { const v = await (${expr}); return { ok:true, type: typeof v, head: String(v).slice(0,70) }; } catch(e) { return { ok:false, err: e.name+': '+e.message }; } })()`);
  console.log(`  ${label.padEnd(28)} → ${JSON.stringify(r)}`);
}

console.log('\n=== registerTool return + args delivery ===');
console.log(JSON.stringify(await ev(`(async () => {
  let seen = null;
  const ret = await document.modelContext.registerTool({
    name: 'probe_echo',
    description: 'Echo back exactly what the browser passed to execute, for API shape probing.',
    inputSchema: { type: 'object', properties: { a: { type: 'string' }, n: { type: 'number' } } },
    execute: async (args, opts) => { seen = { argsType: typeof args, args, optKeys: opts ? Object.keys(opts) : null }; return 'echoed'; },
  });
  const tools = await document.modelContext.getTools();
  const probe = tools.find(t => t.name === 'probe_echo');
  const out = await document.modelContext.executeTool(probe, JSON.stringify({ a: 'hello', n: 42 }));
  return { registerToolReturned: ret === undefined ? 'undefined' : typeof ret, executeReturned: out, executeReturnedType: typeof out, seen };
})()`), null, 2));

ws.close(); chrome.kill('SIGKILL');
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
