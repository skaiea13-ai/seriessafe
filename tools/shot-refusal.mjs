/** Capture the refusal state, which is a demo beat in its own right. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const URLX = process.argv[2] ?? 'http://localhost:5177';
const OUT = process.argv[3] ?? 'refusal.png';
const SCHEME = process.argv[4] ?? 'dark';
const PORT = 9341;
const profile = mkdtempSync(join(tmpdir(), 'shotr-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--enable-features=WebMCPTesting,DevToolsWebMCPSupport',
  '--no-first-run', '--no-default-browser-check', '--headless=new',
  '--force-device-scale-factor=2', '--window-size=1440,1200', 'about:blank',
], { stdio: ['ignore','ignore','ignore'] });
const deadline = Date.now() + 20000; let version;
while (Date.now() < deadline) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { version = await r.json(); break; } } catch {} await new Promise(r=>setTimeout(r,200)); }
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id=0; const pending=new Map();
ws.addEventListener('message', e => { const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);} });
const send=(m,p={},s)=>{const i=++id;ws.send(JSON.stringify({id:i,method:m,params:p,...(s&&{sessionId:s})}));return new Promise((res,rej)=>pending.set(i,{resolve:res,reject:rej}));};
const { targetId } = await send('Target.createTarget', { url: URLX });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 2, mobile: false }, sessionId);
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: SCHEME }] }, sessionId);
await send('Page.reload', {}, sessionId);
await new Promise(r => setTimeout(r, 2200));
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
const msg = await ev(`(async () => {
  const mc = document.modelContext;
  const call = async (n,a) => { const t=(await mc.getTools()).find(x=>x.name===n); return String(await mc.executeTool(t, JSON.stringify(a||{}))); };
  await call('load_calendar', { source: 'sample' });
  await call('inspect_series', { uid: 'advanced-korean-tue@school.example.com' });
  await call('stage_series_split', { effectiveFrom: '2026-09-01', weekdays: ['TH'], endPolicy: 'keep-end-date' });
  await new Promise(r=>setTimeout(r,400));
  return document.querySelector('.refusal strong')?.textContent ?? '(no refusal rendered)';
})()`);
await new Promise(r => setTimeout(r, 500));
const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
writeFileSync(OUT, Buffer.from(data, 'base64'));
console.log(`refusal: ${msg}`);
console.log(`saved: ${OUT}`);
ws.close(); chrome.kill('SIGKILL');
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
