#!/usr/bin/env node
/**
 * Contrast and touch-target audit, run in a real browser against the rendered
 * DOM in both themes.
 *
 * Computed colours are composited properly: a translucent tint over a card
 * over the page is flattened before the ratio is taken, and element opacity is
 * folded into the text colour. Measuring the declared token instead of the
 * painted pixel is how contrast bugs hide.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URLX = process.argv[2] ?? 'http://localhost:5177';
const PORT = 9338;
const profile = mkdtempSync(join(tmpdir(), 'a11y-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank',
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

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false }, sessionId);

const AUDIT = `(async () => {
  const parse = (s) => { const m = s.match(/[\\d.]+/g).map(Number); return { r:m[0], g:m[1], b:m[2], a: m.length>3 ? m[3] : 1 }; };
  const over = (fg, bg) => ({ r: fg.r*fg.a + bg.r*(1-fg.a), g: fg.g*fg.a + bg.g*(1-fg.a), b: fg.b*fg.a + bg.b*(1-fg.a), a: 1 });
  const lum = (c) => { const f = v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }; return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b); };
  const ratio = (a,b) => { const [x,y]=[lum(a),lum(b)]; const hi=Math.max(x,y), lo=Math.min(x,y); return (hi+0.05)/(lo+0.05); };
  const rootBg = parse(getComputedStyle(document.body).backgroundColor);
  const effBg = (el) => {
    const layers = []; let n = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.a > 0) { layers.push(c); if (c.a === 1) break; }
      n = n.parentElement;
    }
    let acc = layers.length && layers[layers.length-1].a === 1 ? layers.pop() : rootBg;
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
    return acc;
  };
  const step = async (a) => { const el = document.querySelector('[data-act="'+a+'"]'); if (el) { el.click(); await new Promise(r=>setTimeout(r,240)); } };
  await step('sample'); await step('stage'); await step('validate');

  const contrast = [];
  document.querySelectorAll('#app *').forEach(el => {
    const txt = [...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join('');
    if (!txt) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return;
    const op = +cs.opacity, size = parseFloat(cs.fontSize), weight = +cs.fontWeight || 400;
    const need = (size >= 24 || (size >= 18.66 && weight >= 700)) ? 3 : 4.5;
    let fg = parse(cs.color); const bg = effBg(el);
    if (op < 1) fg = over({ ...fg, a: fg.a * op }, bg);
    const r = ratio(over(fg, bg), bg);
    if (r < need) contrast.push({ cls: String(el.className||el.tagName), size, ratio: +r.toFixed(2), need, text: txt.slice(0,40) });
  });

  const targets = [...document.querySelectorAll('button, input, select, a')]
    .map(el => ({ el, b: el.getBoundingClientRect() }))
    .filter(({ b }) => b.width > 0 && b.height < 24)
    .map(({ el, b }) => ({ t: (el.textContent||'').trim().slice(0,24), h: Math.round(b.height) }));

  const noPointer = [...document.querySelectorAll('button, a, [data-act]')]
    .filter(el => !el.disabled && getComputedStyle(el).cursor !== 'pointer')
    .map(el => String(el.className||el.tagName));

  const noFocusStyle = [];
  for (const el of document.querySelectorAll('button, input, select, a')) {
    el.focus();
    const cs = getComputedStyle(el);
    const hasRing = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
    if (!hasRing) noFocusStyle.push(String(el.className||el.tagName));
    el.blur();
  }

  const overflowX = document.documentElement.scrollWidth > document.documentElement.clientWidth;
  const emojiInUi = /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/u.test(document.getElementById('app').innerText);

  return { contrast, targets, noPointer, noFocusStyle, overflowX, emojiInUi };
})()`;

let failed = 0;
for (const scheme of ['dark', 'light']) {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sessionId);
  await send('Page.navigate', { url: URLX }, sessionId);
  await new Promise(r => setTimeout(r, 1800));
  const res = await send('Runtime.evaluate', { expression: AUDIT, awaitPromise: true, returnByValue: true }, sessionId);
  if (res.exceptionDetails) { console.error(scheme, res.exceptionDetails.exception?.description); failed++; continue; }
  const v = res.result.value;
  console.log(`\n── ${scheme.toUpperCase()} ──────────────────────────────`);
  const rows = [
    ['contrast failures', v.contrast.length, v.contrast.map(c => `${c.cls} ${c.ratio}:1 (needs ${c.need}) "${c.text}"`)],
    ['targets under 24px', v.targets.length, v.targets.map(t => `${t.t} ${t.h}px`)],
    ['missing cursor:pointer', v.noPointer.length, v.noPointer],
    ['missing focus ring', v.noFocusStyle.length, v.noFocusStyle],
    ['horizontal overflow', v.overflowX ? 1 : 0, []],
    ['emoji used as UI', v.emojiInUi ? 1 : 0, []],
  ];
  for (const [label, n, detail] of rows) {
    console.log(`  ${n === 0 ? 'ok  ' : 'FAIL'} ${label}: ${n}`);
    if (n) { failed += n; detail.slice(0, 6).forEach(d => console.log(`         ${d}`)); }
  }
}
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${failed} issue(s)\n`);
ws.close(); chrome.kill('SIGKILL');
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
