/** Screenshot the app running against real Chrome WebMCP. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URLX = process.argv[2] ?? 'https://skaiea13-ai.github.io/seriessafe/';
const OUT = process.argv[3] ?? 'webmcp-connected.png';
const PORT = 9336;
const profile = mkdtempSync(join(tmpdir(), 'shot-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--enable-features=WebMCPTesting,DevToolsWebMCPSupport',
  '--no-first-run', '--no-default-browser-check', '--headless=new',
  '--force-device-scale-factor=2', '--window-size=1440,1500', 'about:blank',
], { stdio: ['ignore','ignore','ignore'] });

const deadline = Date.now() + 20000; let version;
while (Date.now() < deadline) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { version = await r.json(); break; } } catch {}
  await new Promise(r => setTimeout(r, 200));
}
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
const send = (method, params = {}, sessionId) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params, ...(sessionId && { sessionId }) })); return new Promise((res, rej) => pending.set(i, { resolve: res, reject: rej })); };

const { targetId } = await send('Target.createTarget', { url: URLX });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1500, deviceScaleFactor: 2, mobile: false }, sessionId);
await new Promise(r => setTimeout(r, 2500));

const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return r.result.value;
};

// Each click reveals the next control, and rendering is batched into a
// microtask, so wait for the DOM between steps.
const badge = await ev(`(async () => {
  const step = async (a) => {
    const el = document.querySelector('[data-act="'+a+'"]');
    if (!el) throw new Error('no button for ' + a);
    el.click();
    await new Promise(r => setTimeout(r, 250));
  };
  await step('sample');
  await step('stage');
  await step('validate');
  return document.querySelector('.badge')?.textContent.trim();
})()`);
await new Promise(r => setTimeout(r, 700));
const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
writeFileSync(OUT, Buffer.from(data, 'base64'));
console.log(`badge: "${badge}"`);
console.log(`saved: ${OUT}`);
ws.close(); chrome.kill('SIGKILL');
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
