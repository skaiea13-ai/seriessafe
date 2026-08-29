/** Check every required breakpoint for overflow and layout integrity. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const URLX = process.argv[2] ?? 'http://localhost:5177';
const PORT = 9339;
const profile = mkdtempSync(join(tmpdir(), 'resp-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank',
], { stdio: ['ignore','ignore','ignore'] });
const deadline = Date.now() + 20000; let version;
while (Date.now() < deadline) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { version = await r.json(); break; } } catch {} await new Promise(r=>setTimeout(r,200)); }
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id=0; const pending=new Map();
ws.addEventListener('message', e => { const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);} });
const send=(method,params={},sessionId)=>{const i=++id;ws.send(JSON.stringify({id:i,method,params,...(sessionId&&{sessionId})}));return new Promise((res,rej)=>pending.set(i,{resolve:res,reject:rej}));};
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);

let bad = 0;
for (const [w, h, label] of [[375,812,'mobile'],[768,1024,'tablet'],[1024,768,'small laptop'],[1440,900,'desktop']]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 768 }, sessionId);
  await send('Page.navigate', { url: URLX }, sessionId);
  await new Promise(r => setTimeout(r, 1500));
  const r = await send('Runtime.evaluate', { expression: `(async()=>{
    const s=a=>{document.querySelector('[data-act="'+a+'"]')?.click();return new Promise(r=>setTimeout(r,240));};
    await s('sample'); await s('stage'); await s('validate');
    const de = document.documentElement;
    const wide = [...document.querySelectorAll('#app *')].filter(el => el.getBoundingClientRect().right > de.clientWidth + 1)
      .map(el => String(el.className||el.tagName)).slice(0,5);
    return { overflow: de.scrollWidth > de.clientWidth, scrollW: de.scrollWidth, clientW: de.clientWidth, wide,
             cols: getComputedStyle(document.querySelector('.grid')).gridTemplateColumns,
             compare: document.querySelector('.compare') ? getComputedStyle(document.querySelector('.compare')).gridTemplateColumns : null };
  })()`, awaitPromise: true, returnByValue: true }, sessionId);
  const v = r.result.value;
  const ok = !v.overflow && v.wide.length === 0;
  if (!ok) bad++;
  console.log(`  ${ok?'ok  ':'FAIL'} ${label.padEnd(13)} ${w}x${h}  scroll=${v.scrollW}/${v.clientW}  grid=[${v.cols}]  compare=[${v.compare}]`);
  if (v.wide.length) console.log(`         overflowing: ${v.wide.join(', ')}`);
}
console.log(`\n${bad===0?'PASS':'FAIL'} — ${bad} breakpoint issue(s)`);
ws.close(); chrome.kill('SIGKILL');
try { rmSync(profile,{recursive:true,force:true}); } catch {}
process.exit(bad===0?0:1);
