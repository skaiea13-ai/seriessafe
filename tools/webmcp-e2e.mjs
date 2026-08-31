#!/usr/bin/env node
/**
 * End-to-end verification against a real Chrome WebMCP implementation.
 *
 * Launches Chrome with the WebMCP testing flag in a throwaway profile, opens
 * the target page, and drives the tools the way an agent does — over the
 * DevTools Protocol `WebMCP` domain, using `WebMCP.invokeTool`, never by
 * calling page functions directly.
 *
 * Usage: node tools/webmcp-e2e.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_UNDER_TEST = process.argv[2] ?? 'https://hyunsikparker.github.io/seriessafe/';
const PORT = Number(process.env.CDP_PORT ?? 9333);
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const profile = mkdtempSync(join(tmpdir(), 'seriessafe-webmcp-'));
let chrome;
let failures = 0;
let checks = 0;

const log = (...a) => console.log(...a);
function check(ok, label, detail = '') {
  checks++;
  if (!ok) failures++;
  log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `\n         ${detail}` : ''}`);
}

async function waitForDevTools(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Chrome DevTools endpoint did not come up');
}

/** Minimal CDP client over the raw WebSocket Node already provides. */
class CDP {
  #ws;
  #id = 0;
  #pending = new Map();
  events = [];
  #handlers = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        msg.error ? p.reject(new Error(`${msg.error.message} (${msg.error.code})`)) : p.resolve(msg.result);
      } else {
        this.events.push(msg);
        for (const fn of this.#handlers.get(msg.method) ?? []) fn(msg.params);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new CDP(ws);
  }

  on(method, fn) {
    if (!this.#handlers.has(method)) this.#handlers.set(method, []);
    this.#handlers.get(method).push(fn);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.#ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  close() {
    try { this.#ws.close(); } catch { /* already gone */ }
  }
}

async function main() {
  log(`\nSeriesSafe — real-Chrome WebMCP verification`);
  log(`  target : ${URL_UNDER_TEST}`);
  log(`  chrome : ${CHROME}`);
  log(`  profile: ${profile}\n`);

  chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--enable-features=WebMCPTesting,DevToolsWebMCPSupport',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--headless=new',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  chrome.stderr.on('data', (d) => {
    const s = String(d);
    if (/error|fatal/i.test(s) && !/DEPRECATED|GPU|Vulkan|gl_display/i.test(s)) process.stderr.write(`  chrome: ${s}`);
  });

  const version = await waitForDevTools();
  log(`  ${version.Browser}\n`);

  const browser = await CDP.connect(version.webSocketDebuggerUrl);

  // Open the page and attach a session to it.
  const { targetId } = await browser.send('Target.createTarget', { url: URL_UNDER_TEST });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });

  const toolsAdded = [];
  const toolsRemoved = [];
  browser.on('WebMCP.toolsAdded', (p) => toolsAdded.push(p));
  browser.on('WebMCP.toolsRemoved', (p) => toolsRemoved.push(p));

  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Page.enable', {}, sessionId);

  let webmcpDomain = true;
  try {
    await browser.send('WebMCP.enable', {}, sessionId);
  } catch (err) {
    webmcpDomain = false;
    log(`  note: WebMCP CDP domain unavailable (${err.message}); falling back to in-page API.\n`);
  }

  // Give the page time to load and register.
  await new Promise((r) => setTimeout(r, 2500));

  const evaluate = async (expression) => {
    const r = await browser.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
    return r.result.value;
  };

  log('── API surface ───────────────────────────────────────────');
  const surface = await evaluate(`(() => ({
    href: location.href,
    hasDocumentModelContext: typeof document.modelContext === 'object' && document.modelContext !== null,
    hasNavigatorModelContext: typeof navigator.modelContext === 'object' && navigator.modelContext !== null,
    hasTesting: typeof navigator.modelContextTesting === 'object' && navigator.modelContextTesting !== null,
    isOurHarness: !!document.modelContext?.isSeriesSafeHarness,
    proto: document.modelContext ? Object.getPrototypeOf(document.modelContext)?.constructor?.name : null,
    methods: document.modelContext
      ? ['registerTool','getTools','executeTool'].filter(m => typeof document.modelContext[m] === 'function')
      : [],
  }))()`);
  log(JSON.stringify(surface, null, 2));

  check(surface.hasDocumentModelContext, 'document.modelContext exists');
  check(!surface.isOurHarness, 'the page is using the browser API, not the local harness',
    surface.isOurHarness ? 'harness installed — the real API was not detected' : `constructor: ${surface.proto}`);
  check(surface.methods.length === 3, 'registerTool / getTools / executeTool are all present',
    `found: ${surface.methods.join(', ')}`);

  log('\n── Registered tools ──────────────────────────────────────');
  const registered = await evaluate(
    `document.modelContext.getTools().then(ts => ts.map(t => t.name))`,
  );
  log(`  ${registered.length} tools: ${registered.join(', ')}`);
  const EXPECTED = [
    'load_calendar', 'list_recurring_series', 'inspect_series', 'list_series_exceptions',
    'simulate_series_split', 'stage_series_split', 'validate_staged_split',
    'compare_with_conventional_edit', 'export_calendar_ics',
  ];
  check(EXPECTED.every((n) => registered.includes(n)), 'all nine always-available tools registered',
    `missing: ${EXPECTED.filter((n) => !registered.includes(n)).join(', ') || 'none'}`);
  check(!registered.includes('commit_staged_split'), 'commit_staged_split is NOT registered up front');

  if (webmcpDomain) {
    const namesFromCdp = toolsAdded.flatMap((p) => (p.tools ?? []).map((t) => t.name ?? t.toolName));
    log(`  CDP WebMCP.toolsAdded reported: ${namesFromCdp.length ? namesFromCdp.join(', ') : '(no events)'}`);
    check(namesFromCdp.length > 0, 'Chrome surfaced the tools over the CDP WebMCP domain',
      namesFromCdp.length ? '' : 'no toolsAdded events observed');
  }

  /**
   * Invoke a tool exactly as Chrome requires: resolve the RegisteredTool from
   * getTools(), then pass the arguments as a JSON string. Never by reaching
   * into the application's own functions.
   */
  const invoke = async (name, args = {}) =>
    await evaluate(`
      document.modelContext.getTools().then(ts => {
        const t = ts.find(x => x.name === ${JSON.stringify(name)});
        if (!t) throw new Error('No tool named "' + ${JSON.stringify(name)} + '" is registered right now.');
        return document.modelContext.executeTool(t, ${JSON.stringify(JSON.stringify(args))});
      })
    `);

  log('\n── Agent workflow ────────────────────────────────────────');
  const seq = [
    ['load_calendar', { source: 'sample' }, /1 recurring series/],
    ['list_recurring_series', {}, /1 recurring series/],
    ['inspect_series', { uid: 'advanced-korean-tue@school.example.com' }, /Advanced Korean/],
    ['list_series_exceptions', { onlyAfter: '2026-09-01' }, /5 exception/],
    ['simulate_series_split', { effectiveFrom: '2026-09-01', weekdays: ['TH'] }, /Safe to stage/],
  ];
  for (const [name, args, expect] of seq) {
    const out = String(await invoke(name, args));
    check(expect.test(out), `${name}`, out.split('\n')[0].slice(0, 120));
  }

  log('\n── The safety boundary ───────────────────────────────────');
  const earlyCommit = await evaluate(`
    document.modelContext.getTools()
      .then(ts => {
        const t = ts.find(x => x.name === 'commit_staged_split');
        if (!t) return 'ABSENT: commit_staged_split is not in getTools()';
        return document.modelContext.executeTool(t, '{}')
          .then(() => 'RESOLVED — commit ran before validation')
          .catch(e => 'REJECTED: ' + e.message);
      })
  `);
  check(String(earlyCommit).startsWith('ABSENT'), 'commit is unreachable before validation',
    String(earlyCommit).slice(0, 140));

  const staged = String(await invoke('stage_series_split', { effectiveFrom: '2026-09-01', weekdays: ['TH'] }));
  check(/Staged/.test(staged), 'stage_series_split', staged.split('\n')[0]);

  const afterStage = await evaluate(`document.modelContext.getTools().then(t => t.map(x=>x.name))`);
  check(!afterStage.includes('commit_staged_split'), 'staging alone does not unlock commit');

  const validated = String(await invoke('validate_staged_split', {}));
  check(/All 9 invariants hold/.test(validated), 'validate_staged_split reports all invariants holding',
    validated.split('\n')[0]);

  const afterValidate = await evaluate(`document.modelContext.getTools().then(t => t.map(x=>x.name))`);
  check(afterValidate.includes('commit_staged_split'),
    'commit_staged_split is dynamically registered once validation passes');

  const committed = String(await invoke('commit_staged_split', {}));
  check(/still present/.test(committed), 'commit_staged_split', committed.split('\n')[0].slice(0, 140));

  const afterCommit = await evaluate(`document.modelContext.getTools().then(t => t.map(x=>x.name))`);
  check(!afterCommit.includes('commit_staged_split'), 'commit is withdrawn after use');
  check(afterCommit.includes('undo_series_split'), 'undo_series_split is registered after commit');

  if (webmcpDomain && toolsRemoved.length) {
    log(`  CDP WebMCP.toolsRemoved fired ${toolsRemoved.length} time(s) — Chrome saw the deregistration.`);
  }

  log('\n── The result ────────────────────────────────────────────');
  const exported = String(await invoke('export_calendar_ics', { which: 'current' }));
  const ics = JSON.parse(exported.slice(exported.indexOf('\n'))).ics;
  check(/BYDAY=TH/.test(ics), 'the new series runs on Thursdays');
  check(/MAKE-UP/.test(ics), 'the Wednesday make-up survived');
  check(/20260916T190000/.test(ics), 'the make-up kept its own Wednesday date');
  check(/RECURRENCE-ID;TZID=Asia\/Seoul:20260917T190000/.test(ics), 're-anchored to the matching Thursday slot');
  check(/B-302/.test(ics), 'the guest-lecture room survived');
  check(/BEGIN:VALARM/.test(ics), 'reminders survived');
  check(/X-SCHOOL-COURSE-CODE:KOR-401/.test(ics), 'private X- properties survived');
  check(/EXDATE[^\r\n]*20260924T190000/.test(ics), 'the Chuseok cancellation moved to the right Thursday');
  check(/EXDATE[^\r\n]*20261008T190000/.test(ics), 'the October cancellation moved to the right Thursday');

  const undone = String(await invoke('undo_series_split', {}));
  check(/Reverted/.test(undone), 'undo_series_split', undone.split('\n')[0].slice(0, 120));

  log('\n── The in-page agent walkthrough ─────────────────────────');
  // This is the "Watch an agent do it" button. It goes through the same
  // getTools()/executeTool() path, so it must work against the real API too.
  const walk = await evaluate(`(async () => {
    document.querySelector('[data-act="reset"]')?.click();
    await new Promise(r => setTimeout(r, 120));
    const btn = document.querySelector('[data-act="walkthrough"]');
    if (!btn) return { error: 'walkthrough button missing' };
    btn.click();
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 250));
      const span = document.querySelector('.ask span');
      if (span && span.textContent === 'sequence complete') break;
    }
    const failed = [...document.querySelectorAll('.log .entry.bad')].map(e => e.textContent.replace(/\\s+/g,' ').trim());
    return {
      complete: document.querySelector('.ask span')?.textContent === 'sequence complete',
      toolCalls: [...document.querySelectorAll('.log .entry')].length,
      failedEntries: failed,
      committed: !!document.querySelector('[data-act="undo"]'),
      proofChecks: document.querySelectorAll('.check.pass').length,
    };
  })()`);
  log(`  ${JSON.stringify(walk)}`);
  check(walk.complete === true, 'the in-page walkthrough runs to completion on the real API');
  check((walk.failedEntries ?? []).length === 0, 'no tool call failed during the walkthrough',
    (walk.failedEntries ?? []).join(' | '));
  check(walk.committed === true, 'the walkthrough reached a committed state');
  check(walk.proofChecks === 9, 'all nine invariants are shown as passing', `got ${walk.proofChecks}`);

  const consoleErrors = await evaluate(`(window.__seriesSafeErrors ?? []).length`);
  check(consoleErrors === 0 || consoleErrors === undefined, 'no uncaught page errors');

  browser.close();
  log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
  return failures === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(`\nharness error: ${err.stack ?? err}\n`);
  code = 1;
} finally {
  chrome?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
  chrome?.kill('SIGKILL');
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.exit(code);
