/**
 * Build the SeriesSafe WebMCP Challenge demo without macOS screen-recording
 * permission. Chrome is driven over CDP, frames are captured at 10 fps, and
 * macOS `say` plus ffmpeg provide timed English narration.
 *
 * Usage:
 *   node tools/make-demo-video.mjs /absolute/path/SeriesSafe-WebMCP-Demo.mp4
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LIVE_URL = 'https://hyunsikparker.github.io/seriessafe/';
const TMP_ROOT = '/tmp';
const OUTPUT = resolve(process.argv[2] ?? join(TMP_ROOT, 'SeriesSafe-WebMCP-Demo.mp4'));
const WIDTH = 1440;
const HEIGHT = 900;
const DEVICE_SCALE_FACTOR = 2;
const FRAME_RATE = 10;
const DURATION = 168;
const FRAME_COUNT = FRAME_RATE * DURATION;

const narration = [
  {
    start: 0,
    end: 20,
    text: `This is a language school's calendar: a weekly Tuesday class running from March to December. Over the term, the teacher cancelled public holidays, moved one session to Wednesday as a make-up, and booked a different room for a guest lecture.`,
  },
  {
    start: 20,
    end: 40,
    text: `Now the timetable changes. From September, Tuesday becomes Thursday. In Google Calendar or Outlook, you would choose this and following, and those future exceptions would be silently thrown away. That is documented behavior: Google's API guide says following-instance changes reset later exceptions, and Microsoft's protocol removes them when the recurrence pattern changes.`,
  },
  {
    start: 40,
    end: 60,
    text: `This page exposes the calendar structure to an agent through WebMCP. Watch the eight tool calls. It loads the calendar, lists the series, inspects the rule, and asks specifically what is at risk after the first of September.`,
  },
  {
    start: 60,
    end: 85,
    text: `It simulates before it touches anything. Here is the result: the same request, applied two ways. SeriesSafe preserves five things. A conventional this-and-following edit destroys all five. Both counts are read back from the resulting calendar files, not predicted.`,
  },
  {
    start: 85,
    end: 110,
    text: `It also caught something subtler. Moving Tuesday to Thursday while keeping the old end date would quietly cost a class, because the last Thursday falls after the old end. The default keeps every meeting and explains the shifted end date. Ask it to hold the original date instead, and it refuses. Nothing was changed. It would rather decline than produce a calendar it cannot vouch for.`,
  },
  {
    start: 110,
    end: 135,
    text: `Before committing, it checks nine invariants against the actual serialized I-C-S bytes, not its own plan: the past is untouched, cancellations stay cancelled, overrides survive exactly once at their own time, and attendees, alarms, and private properties carry across. Before validation, commit-staged-split is not disabled; the tool does not exist. Only after all nine checks pass does it appear in the registry.`,
  },
  {
    start: 135,
    end: 158,
    text: `The class is now on Thursdays. The holiday cancellations moved to the correct Thursday slots. The make-up is still Wednesday, September sixteenth, not absorbed and not duplicated. The guest lecture is Thursday, October twenty-second, with its room intact. Five things a normal calendar edit would have destroyed are still here, with one-click undo.`,
  },
  {
    start: 158,
    end: 168,
    text: `SeriesSafe. Safe weekly I-C-S surgery, entirely in your browser, exposed through WebMCP, and MIT licensed.`,
  },
];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  await new Promise((done) => server.close(done));
  return address.port;
}

async function waitForDevTools(port) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      // Chrome is still starting.
    }
    await sleep(200);
  }
  throw new Error('Chrome DevTools endpoint did not come up');
}

class CDP {
  #socket;
  #id = 0;
  #pending = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((done, fail) => {
      socket.addEventListener('open', done, { once: true });
      socket.addEventListener('error', fail, { once: true });
    });
    return new CDP(socket);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    return new Promise((resolveSend, rejectSend) => {
      this.#pending.set(id, { resolve: resolveSend, reject: rejectSend });
    });
  }

  close() {
    try { this.#socket.close(); } catch { /* already closed */ }
  }
}

async function mediaDuration(path) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path,
  ]);
  return Number(stdout.trim());
}

function srtTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const hh = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
  const mm = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0');
  const ss = String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0');
  const mmm = String(ms % 1000).padStart(3, '0');
  return `${hh}:${mm}:${ss},${mmm}`;
}

async function makeNarration(work) {
  const normalized = [];
  const srt = [];
  for (let index = 0; index < narration.length; index++) {
    const segment = narration[index];
    const textPath = join(work, `narration-${index + 1}.txt`);
    const aiffPath = join(work, `narration-${index + 1}.aiff`);
    const wavPath = join(work, `narration-${index + 1}.wav`);
    writeFileSync(textPath, `${segment.text}\n`);

    const slot = segment.end - segment.start;
    let rate = 176;
    for (let attempt = 0; attempt < 4; attempt++) {
      await run('say', ['-v', 'Samantha', '-r', String(Math.round(rate)), '-o', aiffPath, '-f', textPath]);
      const spoken = await mediaDuration(aiffPath);
      if (spoken <= slot - 0.75) break;
      rate = Math.min(230, Math.ceil(rate * spoken / (slot - 1.0)));
    }

    const spoken = await mediaDuration(aiffPath);
    if (spoken > slot - 0.35) {
      throw new Error(`Narration segment ${index + 1} is ${spoken.toFixed(2)}s for a ${slot}s slot`);
    }
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', aiffPath,
      '-af', `aresample=48000,apad,atrim=duration=${slot}`,
      '-ac', '2', '-c:a', 'pcm_s16le', wavPath,
    ]);
    normalized.push(wavPath);
    srt.push(
      `${index + 1}\n${srtTime(segment.start)} --> ${srtTime(segment.end - 0.2)}\n${segment.text}\n`,
    );
    console.log(`narration ${index + 1}/8: ${spoken.toFixed(2)}s spoken in ${slot}s slot at rate ${Math.round(rate)}`);
  }

  const concatPath = join(work, 'narration-concat.txt');
  writeFileSync(concatPath, normalized.map((path) => `file '${path}'`).join('\n'));
  const narrationPath = join(work, 'narration.wav');
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-c:a', 'pcm_s16le', narrationPath,
  ]);
  writeFileSync(join(work, 'captions.srt'), srt.join('\n'));
  return narrationPath;
}

function demoLayer() {
  if (document.getElementById('ss-demo-layer')) return;
  const style = document.createElement('style');
  style.textContent = `
    #ss-demo-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font-family: 'Fira Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    #ss-demo-stage { position: absolute; inset: 26px 72px; overflow: hidden; opacity: 0; background: #090d12; border: 1px solid #3a475c; border-radius: 14px; box-shadow: 0 22px 70px rgba(0,0,0,.72); transition: opacity .24s ease; }
    #ss-demo-stage.on { opacity: 1; }
    #ss-demo-stage > .card { margin: 0; border: 0; border-radius: 0; box-shadow: none; min-height: 100%; }
    #ss-demo-note { position: absolute; left: 72px; right: 72px; bottom: 44px; padding: 22px 26px; color: #f4f7fb; background: rgba(8,10,14,.96); border: 1px solid #3a475c; border-radius: 14px; box-shadow: 0 18px 55px rgba(0,0,0,.55); opacity: 0; transform: translateY(12px); transition: opacity .28s ease, transform .28s ease; }
    #ss-demo-note.on { opacity: 1; transform: translateY(0); }
    #ss-demo-note h2 { margin: 0 0 12px; font-size: 25px; line-height: 1.2; letter-spacing: -.01em; }
    #ss-demo-note p { margin: 7px 0 0; color: #d5dce8; font-size: 17px; line-height: 1.42; }
    #ss-demo-note code { color: #92c5ff; background: #111823; border-color: #2e3d52; }
    #ss-demo-note .sources { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    #ss-demo-note .source { padding: 14px 16px; border-radius: 9px; background: #11161f; border: 1px solid #2a3545; }
    #ss-demo-note .source strong { display:block; color:#f4f7fb; font-size:14px; margin-bottom:5px; }
    #ss-demo-note .source span { display:block; color:#9eabbc; font-size:12px; margin-top:7px; overflow-wrap:anywhere; }
    #ss-demo-cursor { position:absolute; width:34px; height:40px; opacity:0; transform:translate(-4px,-4px); transition:left .34s cubic-bezier(.2,0,.13,1), top .34s cubic-bezier(.2,0,.13,1), opacity .18s ease; filter:drop-shadow(0 2px 4px rgba(0,0,0,.8)); }
    #ss-demo-cursor.on { opacity:1; }
    #ss-demo-focus { position:absolute; opacity:0; border:3px solid #60a5fa; border-radius:10px; box-shadow:0 0 0 4px rgba(96,165,250,.20),0 0 32px rgba(96,165,250,.35); transition:all .25s ease, opacity .18s ease; }
    #ss-demo-focus.on { opacity:1; }
  `;
  document.head.appendChild(style);
  const layer = document.createElement('div');
  layer.id = 'ss-demo-layer';
  layer.innerHTML = `<div id="ss-demo-stage"></div><div id="ss-demo-note"></div><div id="ss-demo-focus"></div><div id="ss-demo-cursor"><svg viewBox="0 0 28 34" width="28" height="34" aria-hidden="true"><path d="M3 2L24 21H14L9 31L3 2Z" fill="#f7fbff" stroke="#0b0e13" stroke-width="2.2" stroke-linejoin="round"/></svg></div>`;
  document.body.appendChild(layer);
  const stage = layer.querySelector('#ss-demo-stage');
  const note = layer.querySelector('#ss-demo-note');
  const cursor = layer.querySelector('#ss-demo-cursor');
  const focus = layer.querySelector('#ss-demo-focus');
  const cardByHeading = (heading) => [...document.querySelectorAll('.card')].find((card) => card.querySelector('h2')?.textContent.trim() === heading);
  const rowContaining = (text) => [...document.querySelectorAll('.occ')].find((row) => row.textContent.includes(text));
  const target = (selectorOrElement) => typeof selectorOrElement === 'string' ? document.querySelector(selectorOrElement) : selectorOrElement;
  window.__seriesSafeDemo = {
    note(html) { note.innerHTML = html; note.classList.add('on'); },
    clearNote() { note.classList.remove('on'); },
    spotlightCard(heading) {
      const card = cardByHeading(heading);
      if (!card) return false;
      stage.replaceChildren(card.cloneNode(true));
      stage.classList.add('on');
      return true;
    },
    clearSpotlight() { stage.classList.remove('on'); stage.replaceChildren(); },
    stageTarget(selector) { return stage.querySelector(selector); },
    hidePointer() { cursor.classList.remove('on'); focus.classList.remove('on'); },
    point(selectorOrElement) {
      const element = target(selectorOrElement);
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      cursor.style.left = `${Math.max(8, Math.min(innerWidth - 38, rect.left + Math.min(20, rect.width * .2)))}px`;
      cursor.style.top = `${Math.max(8, Math.min(innerHeight - 44, rect.top + Math.min(18, rect.height * .35)))}px`;
      cursor.classList.add('on');
      return true;
    },
    focus(selectorOrElement) {
      const element = target(selectorOrElement);
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      focus.style.left = `${Math.max(4, rect.left - 5)}px`;
      focus.style.top = `${Math.max(4, rect.top - 5)}px`;
      focus.style.width = `${Math.min(innerWidth - 8, rect.width + 10)}px`;
      focus.style.height = `${Math.min(innerHeight - 8, rect.height + 10)}px`;
      focus.classList.add('on');
      return true;
    },
    scrollCard(heading, top = 60) {
      const card = cardByHeading(heading);
      if (!card) return false;
      const rect = card.getBoundingClientRect();
      document.scrollingElement.scrollTop = Math.max(0, window.scrollY + rect.top - top);
      return true;
    },
    showRow(text, top = 118) {
      const row = rowContaining(text);
      if (!row) return false;
      const timeline = row.closest('.timeline');
      const rowRect = row.getBoundingClientRect();
      const timelineRect = timeline.getBoundingClientRect();
      timeline.scrollTop = Math.max(0, timeline.scrollTop + rowRect.top - timelineRect.top - timeline.clientHeight * .38);
      const card = timeline.closest('.card');
      const cardRect = card.getBoundingClientRect();
      document.scrollingElement.scrollTop = Math.max(0, window.scrollY + cardRect.top - top);
      this.focus(row);
      this.point(row);
      return true;
    },
    cardByHeading,
    rowContaining,
  };
}
const installDemoLayer = `(${demoLayer.toString()})()`;

async function recordFrames(work) {
  const port = await freePort();
  const profile = mkdtempSync(join(TMP_ROOT, 'seriessafe-demo-chrome-'));
  let chrome;
  let browser;
  try {
    chrome = spawn(CHROME, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--enable-features=WebMCPTesting,DevToolsWebMCPSupport',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--headless=new',
      `--window-size=${WIDTH},${HEIGHT}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    chrome.stderr.on('data', (chunk) => {
      const line = String(chunk);
      if (/fatal/i.test(line)) process.stderr.write(line);
    });

    const version = await waitForDevTools(port);
    console.log(`browser: ${version.Browser}`);
    browser = await CDP.connect(version.webSocketDebuggerUrl);
    const { targetId } = await browser.send('Target.createTarget', { url: LIVE_URL });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Runtime.enable', {}, sessionId);
    await browser.send('Page.enable', {}, sessionId);
    try { await browser.send('WebMCP.enable', {}, sessionId); } catch { /* in-page API is still checked below */ }
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      mobile: false,
    }, sessionId);
    await browser.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    }, sessionId);
    await browser.send('Page.reload', {}, sessionId);

    const evaluate = async (expression) => {
      const result = await browser.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }, sessionId);
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? 'Runtime.evaluate failed');
      }
      return result.result.value;
    };

    for (let attempt = 0; attempt < 80; attempt++) {
      const ready = await evaluate(`document.readyState === 'complete' && !!document.querySelector('[data-act="sample"]')`);
      if (ready) break;
      await sleep(250);
    }
    await sleep(1800);
    const badge = await evaluate(`document.querySelector('.badge')?.textContent.trim()`);
    if (badge !== 'WebMCP connected') throw new Error(`Expected live WebMCP badge, got ${JSON.stringify(badge)}`);
    const api = await evaluate(`(async () => ({
      harness: !!document.modelContext?.isSeriesSafeHarness,
      tools: (await document.modelContext.getTools()).map((tool) => tool.name),
    }))()`);
    if (api.harness || api.tools.length !== 9 || api.tools.includes('commit_staged_split')) {
      throw new Error(`Unexpected initial WebMCP state: ${JSON.stringify(api)}`);
    }

    await evaluate(`document.querySelector('[data-act="sample"]').click()`);
    await sleep(250);
    await evaluate(installDemoLayer);
    await evaluate(`window.__seriesSafeDemo.showRow('Tue, 15 Sept 2026')`);

    const action = (at, label, expression) => ({ at, label, expression, done: false });
    const actions = [
      action(1.0, 'point to make-up and future exceptions', `window.__seriesSafeDemo.showRow('Tue, 15 Sept 2026')`),
      action(7.0, 'point to September cancellation', `window.__seriesSafeDemo.showRow('Tue, 22 Sept 2026')`),
      action(12.5, 'point to guest lecture', `window.__seriesSafeDemo.showRow('Tue, 20 Oct 2026')`),
      action(16.0, 'point to added session', `window.__seriesSafeDemo.showRow('Wed, 11 Nov 2026')`),
      action(20.0, 'show official-source card', `window.__seriesSafeDemo.hidePointer(); window.__seriesSafeDemo.note(\`
        <h2>Documented platform behavior</h2>
        <div class="sources">
          <div class="source"><strong>Google Calendar API</strong>“Changing all following instances resets any exceptions happening after the target instance.”<span>developers.google.com/workspace/calendar/api/guides/recurringevents</span></div>
          <div class="source"><strong>Microsoft MS-OXOCAL</strong>When the recurrence pattern changes, the client “removes every exception” and every Exception Attachment object.<span>learn.microsoft.com/openspecs/exchange_server_protocols/ms-oxocal</span></div>
        </div>\`)`),
      action(38.0, 'hide official-source card', `window.__seriesSafeDemo.clearNote()`),
      action(39.0, 'show agent card', `window.__seriesSafeDemo.scrollCard('Tools this page exposes', 92); window.__seriesSafeDemo.focus('[data-act="walkthrough"]'); window.__seriesSafeDemo.point('[data-act="walkthrough"]')`),
      action(40.0, 'start eight-call walkthrough', `document.querySelector('[data-act="walkthrough"]').click()`),
      action(47.0, 'show completed agent log', `window.__seriesSafeDemo.scrollCard('Tools this page exposes', 62); window.__seriesSafeDemo.focus('.log')`),
      action(59.0, 'show same-request comparison', `(async () => {
        document.querySelector('[data-act="reset"]')?.click();
        await new Promise(r => setTimeout(r, 120));
        document.querySelector('[data-act="sample"]')?.click();
        await new Promise(r => setTimeout(r, 140));
        document.querySelector('[data-act="stage"]')?.click();
        await new Promise(r => setTimeout(r, 180));
        window.__seriesSafeDemo.hidePointer();
        if (!window.__seriesSafeDemo.spotlightCard('Same request, two ways')) throw new Error('comparison card was not rendered');
      })()`),
      action(72.0, 'highlight preserved count', `window.__seriesSafeDemo.focus(window.__seriesSafeDemo.stageTarget('.pane.win')); window.__seriesSafeDemo.point(window.__seriesSafeDemo.stageTarget('.pane.win .count'))`),
      action(77.0, 'highlight destroyed count', `window.__seriesSafeDemo.focus(window.__seriesSafeDemo.stageTarget('.pane.lose')); window.__seriesSafeDemo.point(window.__seriesSafeDemo.stageTarget('.pane.lose .count'))`),
      action(84.5, 'clear comparison highlight', `window.__seriesSafeDemo.hidePointer(); window.__seriesSafeDemo.clearSpotlight()`),
      action(85.0, 'build refusal state', `(async () => {
        document.querySelector('[data-act="reset"]')?.click();
        await new Promise(r => setTimeout(r, 120));
        document.querySelector('[data-act="sample"]')?.click();
        await new Promise(r => setTimeout(r, 160));
        const end = document.getElementById('endp'); end.value = 'keep-end-date'; end.dispatchEvent(new Event('change', { bubbles: true }));
        window.__seriesSafeDemo.scrollCard('The change', 65); window.__seriesSafeDemo.focus('#endp'); window.__seriesSafeDemo.point('#endp');
      })()`),
      action(88.0, 'preview refused end-date policy', `(async () => {
        document.querySelector('[data-act="stage"]')?.click();
        await new Promise(r => setTimeout(r, 120));
        window.__seriesSafeDemo.scrollCard('Refused — nothing was changed', 120);
        window.__seriesSafeDemo.focus(window.__seriesSafeDemo.cardByHeading('Refused — nothing was changed'));
      })()`),
      action(108.0, 'prepare safe state before validation', `(async () => {
        document.querySelector('[data-act="reset"]')?.click();
        await new Promise(r => setTimeout(r, 120));
        document.querySelector('[data-act="sample"]')?.click();
        await new Promise(r => setTimeout(r, 140));
        document.querySelector('[data-act="stage"]')?.click();
        await new Promise(r => setTimeout(r, 180));
        const names = (await document.modelContext.getTools()).map(t => t.name);
        window.__seriesSafeDemo.scrollCard('Tools this page exposes', 65);
        window.__seriesSafeDemo.focus('.tools');
        window.__seriesSafeDemo.note('<h2>Registry before validation</h2><p><strong>' + names.length + ' tools</strong> are registered. <code>commit_staged_split</code> is absent — it is not a disabled button or a promise from the UI.</p>');
      })()`),
      action(114.0, 'run nine serialized-byte checks', `(async () => {
        window.__seriesSafeDemo.clearNote();
        document.querySelector('[data-act="validate"]')?.click();
        await new Promise(r => setTimeout(r, 180));
        window.__seriesSafeDemo.scrollCard('Proof', 38);
        window.__seriesSafeDemo.focus(window.__seriesSafeDemo.cardByHeading('Proof'));
      })()`),
      action(126.0, 'show dynamic commit tool', `(async () => {
        const names = (await document.modelContext.getTools()).map(t => t.name);
        if (!names.includes('commit_staged_split')) throw new Error('commit tool did not appear after validation');
        window.__seriesSafeDemo.scrollCard('Tools this page exposes', 65);
        const chip = [...document.querySelectorAll('.tool-chip')].find(el => el.textContent.includes('commit_staged_split'));
        window.__seriesSafeDemo.focus(chip); window.__seriesSafeDemo.point(chip);
        window.__seriesSafeDemo.note('<h2>All 9 invariants passed</h2><p><code>commit_staged_split</code> has now appeared in the real WebMCP registry.</p>');
      })()`),
      action(131.0, 'commit after validation', `window.__seriesSafeDemo.clearNote(); document.querySelector('[data-act="commit"]')?.click()`),
      action(134.0, 'show Wednesday make-up after commit', `window.__seriesSafeDemo.showRow('Wed, 16 Sept 2026')`),
      action(141.0, 'show moved cancellation after commit', `window.__seriesSafeDemo.showRow('Thu, 24 Sept 2026')`),
      action(147.0, 'show guest lecture and room after commit', `window.__seriesSafeDemo.showRow('Thu, 22 Oct 2026')`),
      action(153.0, 'show committed state and undo', `window.__seriesSafeDemo.scrollCard('Committed', 120); window.__seriesSafeDemo.focus('[data-act="undo"]'); window.__seriesSafeDemo.point('[data-act="undo"]')`),
      action(158.0, 'close on product and live badge', `window.scrollTo({ top: 0, behavior: 'instant' }); window.__seriesSafeDemo.hidePointer(); window.__seriesSafeDemo.note(\`<h2>SeriesSafe</h2><p>Weekly <code>.ics</code> surgery with proof before commit · real WebMCP tool registration · entirely in the browser · MIT licensed</p>\`); window.__seriesSafeDemo.focus('.badge')`),
    ];

    const frameDir = join(work, 'frames');
    const captureStart = Date.now();
    for (let frame = 0; frame < FRAME_COUNT; frame++) {
      const time = frame / FRAME_RATE;
      for (const item of actions) {
        if (!item.done && item.at <= time + 0.0001) {
          await evaluate(item.expression);
          item.done = true;
          console.log(`scene ${item.at.toFixed(1).padStart(5)}s: ${item.label}`);
        }
      }
      const targetTime = captureStart + frame * (1000 / FRAME_RATE);
      const delay = targetTime - Date.now();
      if (delay > 0) await sleep(delay);
      const shot = await browser.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      }, sessionId);
      writeFileSync(join(frameDir, `frame-${String(frame + 1).padStart(5, '0')}.png`), Buffer.from(shot.data, 'base64'));
      if ((frame + 1) % 100 === 0) console.log(`captured ${frame + 1}/${FRAME_COUNT} frames`);
    }

    const final = await evaluate(`(async () => ({
      badge: document.querySelector('.badge')?.textContent.trim(),
      committed: !!document.querySelector('[data-act="undo"]'),
      proofChecks: document.querySelectorAll('.check.pass').length,
      tools: (await document.modelContext.getTools()).map((tool) => tool.name),
      errors: (window.__seriesSafeErrors ?? []).length,
    }))()`);
    if (final.badge !== 'WebMCP connected' || !final.committed || final.proofChecks !== 9 || final.errors !== 0) {
      throw new Error(`Unexpected final browser state: ${JSON.stringify(final)}`);
    }
    console.log(`final browser state: ${JSON.stringify(final)}`);
  } finally {
    browser?.close();
    chrome?.kill('SIGTERM');
    await sleep(400);
    chrome?.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  }
}

async function encodeVideo(work, narrationPath) {
  const framePattern = join(work, 'frames', 'frame-%05d.png');
  const tempOutput = join(dirname(OUTPUT), `.${join('', OUTPUT.split('/').at(-1))}.partial.mp4`);
  rmSync(tempOutput, { force: true });
  await run('ffmpeg', [
    '-hide_banner', '-y',
    '-framerate', String(FRAME_RATE), '-i', framePattern,
    '-i', narrationPath,
    '-vf', `scale=${WIDTH}:${HEIGHT}:flags=lanczos,fps=30,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-t', String(DURATION), '-movflags', '+faststart', tempOutput,
  ]);
  renameSync(tempOutput, OUTPUT);
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);
  const work = mkdtempSync(join(TMP_ROOT, 'seriessafe-demo-video-'));
  const frameDir = join(work, 'frames');
  mkdirSync(frameDir);
  console.log(`temporary workspace: ${work}`);
  console.log(`output: ${OUTPUT}`);
  try {
    const narrationPath = await makeNarration(work);
    await recordFrames(work);
    await encodeVideo(work, narrationPath);
    const duration = await mediaDuration(OUTPUT);
    const bytes = readFileSync(OUTPUT).byteLength;
    console.log(`created: ${OUTPUT}`);
    console.log(`duration: ${duration.toFixed(3)} seconds`);
    console.log(`size: ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
