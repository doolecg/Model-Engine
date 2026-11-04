const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { createDocument } = require('./scene-dom.js');
const zlib = require('zlib');
const { renderGraphSvg, renderGraphPng, pickLayout } = require('./graph.js');

const IDLE = { calls: 0, verdict: null, opus: 'idle', recall: { cg: 0, hs: 0, grep: 0, saved: 0, run: false }, orch: 'idle', builder: 'idle', orchModel: 'sonnet', council: { ui: 'idle', code: 'idle', run: 'idle' }, ondemand: {}, active: {}, busy: false, mcpSeen: {}, loadout: { skills: [], mcps: [] } };
const count = (s, sub) => s.split(sub).length - 1;

test('scene-dom: attributes, style, classList, raw markup, escaping, serialize', () => {
  const d = createDocument(), svg = d.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const r = d.createElementNS('x', 'rect');
  r.setAttribute('x', 1); r.setAttribute('style', 'cursor:pointer;transform:scaleX(0)');
  assert.strictEqual(r.getAttribute('x'), '1');
  assert.strictEqual(r.style.cursor, 'pointer');
  r.style.animation = 'fill 1s'; r.style.transformOrigin = '0 50%'; r.style.setProperty('--c', '#fff'); r.style.transform = '';
  assert.strictEqual(r.getAttribute('style'), 'cursor:pointer;animation:fill 1s;transform-origin:0 50%;--c:#fff');
  r.classList.add('a'); r.classList.toggle('b'); r.classList.toggle('a', false);
  assert.ok(r.classList.contains('b') && !r.classList.contains('a'));
  r.removeAttribute('x'); assert.strictEqual(r.getAttribute('x'), null);
  r.addEventListener('click', () => {});
  const t = d.createElementNS('x', 'text'); t.textContent = 'a<b & "c"'; svg.appendChild(r); svg.appendChild(t);
  const defs = svg.appendChild(d.createElementNS('x', 'defs')); defs.innerHTML = '<filter id="f"/>';
  const out = svg.serialize();
  assert.ok(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg">'));
  assert.ok(out.includes('<text>a&lt;b &amp; "c"</text>'));
  assert.ok(out.includes('<defs><filter id="f"/></defs>'));
  assert.ok(out.includes('<rect class="b" style="'));
  t.textContent = ''; assert.strictEqual(t.serialize(), '<text/>');
});

test('graph: idle wide svg keeps the card titles (drift check)', () => {
  const s = renderGraphSvg(IDLE, {}, { layout: 'wide' });
  for (const w of ['ORCHESTRATOR', 'BRAIN', 'MEMORY', 'RECALL', 'BUILDER', 'COUNCIL', 'SESSION LOG', 'CHANGES']) assert.ok(s.includes('>' + w + '<'), w);
  assert.ok(s.includes('viewBox="0 0 1024 640"'));
  assert.ok(s.includes('font-family="&quot;JetBrains Mono&quot;'));
  assert.strictEqual(count(s, 'class="act"'), 0);
  const t = renderGraphSvg(IDLE, {}, { layout: 'tall' });
  assert.ok(t.includes('viewBox="0 0 390 1152"') && t.includes('>SESSION LOG<'));
});

test('graph: council running gets the marching border; output is deterministic', () => {
  const st = { ...IDLE, council: { ui: 'running', code: 'idle', run: 'idle' } };
  const a = renderGraphSvg(st, {}, { layout: 'wide' });
  assert.strictEqual(count(a, 'class="act"'), 1);
  assert.ok(a.includes('<style>') && a.includes('.act{animation:march') && a.includes('@keyframes march'));
  assert.ok(a.includes('<animateMotion'));
  assert.strictEqual(a, renderGraphSvg(st, {}, { layout: 'wide' }));
  const still = renderGraphSvg(st, {}, { layout: 'wide', animated: false });
  assert.strictEqual(count(still, 'class="act"'), 1);
  assert.ok(still.includes('.act{stroke-dasharray:6 5'));
  for (const bad of ['@keyframes', 'animateMotion', '<set ', 'animation:']) assert.ok(!still.includes(bad), bad);
});

test('graph: the log panel shows the last rows of the chosen tab', () => {
  const log = Array.from({ length: 30 }, (_, i) => ['00:' + String(i).padStart(2, '0') + '.0', 'opus', 'row' + i]);
  const changes = [['00:01.0', 'Edit', 'src/a.js']];
  const l = renderGraphSvg(IDLE, { log, changes }, { layout: 'wide' });
  assert.ok(l.includes('>row29<') && !l.includes('>row0<') && !l.includes('>src/a.js<'));
  const c = renderGraphSvg(IDLE, { log, changes }, { layout: 'wide', tab: 'changes' });
  assert.ok(c.includes('>src/a.js<') && !c.includes('>row29<') && c.includes('>CHANGES 1<'));
});

// every <text> as a box: x0..x1 from anchor and 0.6em monospace advance, y0..y1 from font size and baseline
function texts(svg) {
  const out = [], re = /<text ([^>]*?)>([^<]*)<\/text>/g; let m;
  while ((m = re.exec(svg))) {
    const at = (k) => (new RegExp('(?:^|\\s)' + k + '="([^"]*)"').exec(m[1]) || [])[1];
    const x = Number(at('x')), y = Number(at('y')), fs = Number(at('font-size')), a = at('text-anchor') || 'start', t = m[2];
    const w = t.length * fs * 0.6, x0 = a === 'end' ? x - w : a === 'middle' ? x - w / 2 : x;
    out.push({ t, x, y, fs, x0, x1: x0 + w, y0: y - fs * 0.8, y1: y + fs * 0.2 });
  }
  return out;
}
const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const LOAD = { skills: ['engine-builder', 'engine-code-review', 'engine-run-check', 'engine-recall', 'engine-council'], mcps: ['hindsight', 'codegraph', 'playwright'] };

test('graph: loadout shows full skill names inside the card, long ones get an ellipsis', () => {
  const w = renderGraphSvg({ ...IDLE, loadout: LOAD, mcpSeen: { hindsight: 1 } }, {}, { layout: 'wide' });
  for (const n of LOAD.skills) assert.ok(w.includes('>' + n + '<'), n);
  assert.ok(!w.includes('>engine-builde<') && !w.includes('>engine-code-r<') && !w.includes('>engine-run-ch<'));
  assert.ok(w.includes('>mcp 1/3<'));
  const inCard = texts(w).filter((t) => t.y > 300 && t.y < 400 && t.x >= 540 && t.x < 760);
  assert.ok(inCard.length >= 8);
  for (const t of inCard) assert.ok(t.x1 <= 758, t.t + ' overflows the card');
  const long = renderGraphSvg({ ...IDLE, loadout: { skills: ['engine-a-very-long-skill-name'], mcps: ['some-quite-long-mcp-name'] } }, {}, { layout: 'wide' });
  assert.ok(long.includes('>engine-a-very-lon…<') && long.includes('>○ some-quite-l…<'));
  const t = renderGraphSvg({ ...IDLE, loadout: LOAD, mcpSeen: { hindsight: 1 } }, {}, { layout: 'tall' });
  for (const n of ['● hindsight', '○ codegraph', '○ playwright']) assert.ok(t.includes('>' + n + '<'), n);
  for (const x of texts(t).filter((q) => q.t.startsWith('○ ') || q.t.startsWith('● '))) assert.ok(x.x1 <= 376, x.t + ' overflows');
});

test('graph: the done? label never overlaps text on the orchestrator card', () => {
  for (const [layout, box] of [['wide', [20, 68, 220, 198]], ['tall', [16, 68, 364, 130]]]) {
    const svg = renderGraphSvg({ ...IDLE, orch: 'done?' }, {}, { layout }), all = texts(svg.split('<g transform="translate(0,122)"')[0]); // tall: the Brain group is shifted down, so it is not on this card
    const d = all.find((q) => q.t === 'done?');
    assert.ok(d, layout + ' has the label');
    const others = all.filter((q) => q !== d && q.x1 > box[0] && q.x0 < box[2] && q.y1 > box[1] && q.y0 < box[3] && q.t);
    assert.ok(others.some((q) => q.t === 'ready'));
    for (const q of others) assert.ok(!hit(d, q), layout + ': done? hits ' + q.t);
    assert.ok(d.x1 <= box[2] && d.y1 <= box[3], layout + ': done? stays in the card');
  }
});

test('graph: log rows start 24px under the tab bar in both scenes and stay in the panel', () => {
  const log = Array.from({ length: 80 }, (_, i) => ['00:00.0', 'opus', 'row' + i]);
  for (const [layout, panelY, th] of [['wide', 462, 26], ['tall', null, 48]]) {
    const svg = renderGraphSvg(IDLE, { log }, { layout }), cards = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="([\d.]+)" rx="10"/g)].map((m) => m.slice(1).map(Number));
    const py = panelY || Math.max(...cards.map((c) => c[1])), card = cards.find((c) => c[1] === py);
    const rows = texts(svg).filter((q) => /^row\d+$/.test(q.t)).sort((a, b) => a.y - b.y);
    assert.ok(rows.length >= 5, layout);
    assert.strictEqual(rows[0].y, py + th + 24, layout + ' first baseline');
    assert.ok(rows[0].y - rows[0].fs >= py + 10 + th, layout + ' first row clear of the tab bar');
    assert.ok(rows[rows.length - 1].y <= py + card[3] - 8, layout + ' last row inside the panel');
  }
});

test('graph: PNG has the signature, the width asked for and a real size', async () => {
  const svg = renderGraphSvg({ ...IDLE, builder: 'building' }, {}, { layout: 'wide', width: 800, animated: false });
  const png = await renderGraphPng(svg, { scale: 2 });
  assert.deepStrictEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.length > 20000);
  assert.strictEqual(png.readUInt32BE(16), 1600);
});

const vbOf = (s) => /viewBox="0 0 (\d+) (\d+)"/.exec(s).slice(1).map(Number);
const cardsOf = (s) => [...s.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="([\d.]+)" rx="10"/g)].map((m) => m.slice(1).map(Number));
// first pixel of a PNG (colour type 6): the first scanline's first pixel needs no filter maths
const cornerPixel = (png) => {
  const idat = []; let o = 8;
  while (o < png.length) { const n = png.readUInt32BE(o), t = png.toString('latin1', o + 4, o + 8); if (t === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + n)); o += 12 + n; }
  const raw = zlib.inflateSync(Buffer.concat(idat)); return [...raw.subarray(1, 5)];
};

test('graph: portrait keeps every card and group title, nothing overlaps, about 1:1.5', () => {
  const s = renderGraphSvg({ ...IDLE, loadout: LOAD, mcpSeen: { hindsight: 1 } }, {}, { layout: 'portrait' });
  for (const w of ['ORCHESTRATOR', 'BRAIN', 'MEMORY', 'RECALL', 'BUILDER', 'LOADOUT', 'COUNCIL', 'OPUS 5.5', 'UI', 'CODE', 'RUN', 'SESSION LOG', 'CHANGES', 'delegate → builder', 'commit → memory', 'done? · same error ×2 → brain', 'findings', 'load', 'call', 'ask', 'verdict', 'CTX']) assert.ok(s.includes('>' + w + '<'), w);
  const [vw, vh] = vbOf(s);
  assert.deepStrictEqual([vw, vh], [672, 1008]);
  assert.ok(vh / vw > 1.4 && vh / vw < 1.6);
  const cards = cardsOf(s);
  assert.strictEqual(cards.length, 9); // orchestrator, brain, recall, builder, loadout, ui, code, run and the log panel
  cards.forEach((c) => assert.ok(c[0] >= 0 && c[1] >= 0 && c[0] + c[2] <= vw && c[1] + c[3] <= vh, 'inside the viewBox: ' + c));
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i], b = cards[j];
    assert.ok(!(a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]), 'cards overlap: ' + a + ' / ' + b);
  }
  for (const n of LOAD.skills) assert.ok(s.includes('>' + n + '<'), n);
  for (const t of texts(s).filter((q) => q.t)) assert.ok(t.x0 >= 0 && t.x1 <= vw && t.y1 <= vh, t.t + ' clipped');
  const inCard = texts(s).filter((t) => t.y > 540 && t.y < 790 && t.x >= 20 && t.x < 240);
  assert.ok(inCard.length >= 8);
  for (const t of inCard) assert.ok(t.x1 <= 238, t.t + ' overflows the loadout card');
  const done = texts(renderGraphSvg({ ...IDLE, orch: 'done?' }, {}, { layout: 'portrait' })), d = done.find((q) => q.t === 'done?');
  assert.ok(d && d.x1 <= 240);
  assert.ok(done.filter((q) => q !== d && q.t && q.x1 > 20 && q.x0 < 240 && q.y1 > 68 && q.y0 < 198).every((q) => !hit(d, q)));
  assert.strictEqual(count(renderGraphSvg({ ...IDLE, council: { ui: 'running', code: 'idle', run: 'idle' } }, {}, { layout: 'portrait' }), 'class="act"'), 1);
});

test('graph: log:false drops the SESSION LOG / CHANGES panel and shrinks the viewBox in every layout', () => {
  for (const [layout, withLog, without] of [['wide', 640, 450], ['tall', 1152, 802], ['portrait', 1008, 822]]) {
    const a = renderGraphSvg(IDLE, {}, { layout }), b = renderGraphSvg(IDLE, {}, { layout, log: false });
    assert.strictEqual(vbOf(a)[1], withLog, layout);
    assert.strictEqual(vbOf(b)[1], without, layout);
    assert.ok(a.includes('>SESSION LOG<') && !b.includes('>SESSION LOG<') && !b.includes('>CHANGES') && !b.includes('>row'), layout);
    if (layout === 'tall') continue; // tall draws its lower cards inside a shifted group
    const bottom = Math.max(...cardsOf(b).map((c) => c[1] + c[3]));
    assert.ok(bottom <= without && without - bottom < 60, layout + ' leaves no empty band');
  }
});

test('graph: bg transparent has no background rect, dark and hex fill one', async () => {
  const bgRect = (s) => /<rect x="0" y="0" width="\d+" height="\d+" fill="([^"]+)"/.exec(s);
  assert.strictEqual(bgRect(renderGraphSvg(IDLE, {}, { layout: 'portrait', bg: 'transparent' })), null);
  assert.ok(!/<svg[^>]*\sfill=/.test(renderGraphSvg(IDLE, {}, { bg: 'transparent' }).slice(0, 300)));
  assert.strictEqual(bgRect(renderGraphSvg(IDLE, {}, {}))[1], '#121214');
  assert.strictEqual(bgRect(renderGraphSvg(IDLE, {}, { bg: 'dark' }))[1], '#121214');
  assert.strictEqual(bgRect(renderGraphSvg(IDLE, {}, { bg: '#AABBCC' }))[1], '#aabbcc');
  assert.strictEqual(bgRect(renderGraphSvg(IDLE, {}, { bg: 'nonsense' }))[1], '#121214');
  const t = await renderGraphPng(renderGraphSvg(IDLE, {}, { layout: 'portrait', width: 400, bg: 'transparent', animated: false }));
  assert.strictEqual(t[25], 6);
  assert.strictEqual(cornerPixel(t)[3], 0);
  const d = await renderGraphPng(renderGraphSvg(IDLE, {}, { layout: 'portrait', width: 400, animated: false }));
  assert.strictEqual(cornerPixel(d)[3], 255);
});

test('graph: auto layout selection', () => {
  for (const [w, h, want] of [[980, 1230, 'portrait'], [600, 1200, 'portrait'], [420, 700, 'portrait'], [419, 900, 'tall'], [390, 844, 'tall'], [1200, 700, 'wide'], [1000, 1000, 'wide'], [1000, 1150, 'wide'], [1000, 1151, 'portrait'], [800, 0, 'wide'], [0, 800, 'wide'], [300, 0, 'tall'], [NaN, NaN, 'wide']]) assert.strictEqual(pickLayout(w, h), want, w + 'x' + h);
});

// ---------- routes on a throwaway server (port 4827, never 4777, 4779 or 4818) ----------
const PORT = 4827, RHOST = 'pc.tail1234.ts.net';
function call(method, url, { host = `127.0.0.1:${PORT}`, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: url, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const bufs = []; res.on('data', (d) => bufs.push(d));
      res.on('end', () => { const raw = Buffer.concat(bufs), text = raw.toString('utf8'); let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, raw, text, json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('panel routes on a throwaway server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-graph-'));
  const env = { ...process.env, MODEL_ENGINE_PORT: String(PORT), MODEL_ENGINE_STORE: path.join(dir, 'store.json') };
  delete env.MODEL_ENGINE_HOST; delete env.MODEL_ENGINE_RESTART;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stderr.on('data', (d) => (log += d));
  try {
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('server did not start: ' + log)), 15000);
      child.stdout.on('data', (d) => { if (String(d).includes('live view on')) { clearTimeout(to); res(); } });
      child.on('exit', () => rej(new Error('server exited: ' + log)));
    });
    const mk = async (name) => {
      const folder = path.join(dir, name); fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
      const r = await call('POST', '/project/new', { body: { folder, name } });
      assert.strictEqual(r.status, 200);
      return { id: r.json.id, folder };
    };
    const A = await mk('alpha'), B = await mk('beta');

    const byId = await call('GET', '/panel/state?folder=' + A.id);
    assert.strictEqual(byId.status, 200);
    assert.strictEqual(byId.headers['cache-control'], 'no-store');
    assert.deepStrictEqual(byId.json.project, { id: A.id, name: 'alpha' });
    assert.ok(['alpha', 'beta'].every((n) => byId.json.projects.some((p) => p.name === n)));
    assert.strictEqual(byId.json.state.council.ui, 'idle');
    assert.ok(Array.isArray(byId.json.log) && Array.isArray(byId.json.changes) && byId.json.at > 0);
    assert.ok(!byId.text.includes(dir.replace(/\\/g, '\\\\')) && !byId.text.includes(dir));
    const q = (f) => '/panel/state?folder=' + encodeURIComponent(f);
    assert.strictEqual((await call('GET', q(B.folder))).json.project.id, B.id);
    assert.strictEqual((await call('GET', q(B.folder.toUpperCase()))).json.project.id, B.id);
    assert.strictEqual((await call('GET', q('beta'))).json.project.id, B.id);
    assert.strictEqual((await call('GET', q(path.join(A.folder, 'src', 'deep', 'file.js')))).json.project.id, A.id);
    assert.strictEqual((await call('GET', '/panel/state')).status, 200);
    const nf = await call('GET', q('nothing-here'));
    assert.strictEqual(nf.status, 404);
    assert.ok(nf.json && nf.json.error);

    const svg = await call('GET', '/panel/graph.svg?folder=' + A.id + '&layout=tall&width=10');
    assert.strictEqual(svg.status, 200);
    assert.ok(svg.headers['content-type'].startsWith('image/svg+xml'));
    assert.ok(svg.text.startsWith('<svg xmlns=') && svg.text.includes('viewBox="0 0 390 1152"') && svg.text.includes('width="400"'));
    assert.ok((await call('GET', '/panel/graph.svg?folder=' + A.id + '&width=99999')).text.includes('width="2400"'));
    assert.ok((await call('GET', '/panel/graph.svg?folder=' + A.id)).text.includes('width="1024"'));
    assert.strictEqual((await call('GET', '/panel/graph.svg?folder=nope')).status, 404);

    const g = (q) => call('GET', '/panel/graph.svg?folder=' + A.id + q);
    const por = await g('&layout=portrait');
    assert.ok(por.text.includes('viewBox="0 0 672 1008"') && por.text.includes('width="672"') && por.text.includes('>SESSION LOG<'));
    assert.ok((await g('&layout=portrait&log=0')).text.includes('viewBox="0 0 672 822"'));
    const nl = await g('&log=0');
    assert.ok(!nl.text.includes('SESSION LOG') && nl.text.includes('viewBox="0 0 1024 450"'));
    assert.ok((await g('&log=junk')).text.includes('>SESSION LOG<'));
    for (const [qs, vb, w] of [['&layout=auto&width=980&height=1230', '0 0 672 1008', 980], ['&layout=auto&width=300&height=900', '0 0 390 1152', 400], ['&layout=auto&width=1200&height=700', '0 0 1024 640', 1200], ['&layout=auto', '0 0 1024 640', 1024], ['&layout=bogus&width=500', '0 0 1024 640', 500], ['&layout=auto&width=500&height=99999', '0 0 672 1008', 500]]) {
      const r = await g(qs); assert.strictEqual(r.status, 200, qs);
      assert.ok(r.text.includes('viewBox="' + vb + '"') && r.text.includes('width="' + w + '"'), qs);
    }
    assert.ok(/<rect x="0" y="0" width="\d+" height="\d+" fill="#121214"/.test((await g('&layout=portrait')).text));
    assert.ok(!/<rect x="0" y="0" width="\d+" height="\d+" fill=/.test((await g('&layout=portrait&bg=transparent')).text));
    assert.ok((await g('&bg=%23aabbcc')).text.includes('fill="#aabbcc"') && (await g('&bg=aabbcc')).text.includes('fill="#aabbcc"'));
    assert.ok((await g('&bg=red;evil')).text.includes('fill="#121214"'));
    const tp = await call('GET', '/panel/graph.png?folder=' + A.id + '&layout=portrait&width=500&log=0&bg=transparent');
    assert.strictEqual(tp.status, 200);
    assert.strictEqual(tp.raw[25], 6);
    assert.strictEqual(cornerPixel(tp.raw)[3], 0);
    assert.strictEqual(tp.raw.readUInt32BE(16), 500);
    assert.strictEqual(tp.raw.readUInt32BE(20), Math.round(500 * 822 / 672));

    const png = await call('GET', '/panel/graph.png?folder=' + A.id + '&width=500&scale=9');
    assert.strictEqual(png.status, 200);
    assert.strictEqual(png.headers['content-type'], 'image/png');
    assert.deepStrictEqual([...png.raw.subarray(0, 4)], [137, 80, 78, 71]);
    assert.strictEqual(png.raw.readUInt32BE(16), 1500); // scale capped at 3
    const big = await call('GET', '/panel/graph.png?folder=' + A.id + '&width=2400&scale=3');
    assert.strictEqual(big.raw.readUInt32BE(16), 4096); // output width capped
    const two = await Promise.all([call('GET', '/panel/graph.png?folder=' + A.id), call('GET', '/panel/graph.png?folder=' + A.id)]);
    assert.ok(two.every((r) => r.status === 200));

    const page = await call('GET', '/panel?folder=' + A.id);
    assert.strictEqual(page.status, 200);
    assert.ok(page.text.includes('<body class="panel" data-tab="engine">') && page.text.includes('/scene.js?v='));
    assert.ok(!(await call('GET', '/')).text.includes('class="panel"'));
    const sj = await call('GET', '/scene.js');
    assert.strictEqual(sj.status, 200);
    assert.ok(sj.headers['content-type'].startsWith('text/javascript') && sj.text.includes('createScene'));
    const ver = /\/scene\.js\?v=(\w+)/.exec(page.text)[1];
    assert.ok((await call('GET', '/scene.js?v=' + ver)).headers['cache-control'].includes('immutable'));

    // guards: bad Host is 403; remote needs a sign-in
    for (const u of ['/panel', '/panel/state', '/panel/graph.svg', '/panel/graph.png', '/scene.js']) assert.strictEqual((await call('GET', u, { host: 'evil.com' })).status, 403, u);
    assert.strictEqual((await call('POST', '/remote/settings', { body: { enabled: true, host: RHOST } })).status, 200);
    for (const u of ['/panel/state', '/panel/graph.svg', '/panel/graph.png']) assert.strictEqual((await call('GET', u, { host: RHOST })).status, 401, u);
    assert.ok((await call('GET', '/panel', { host: RHOST })).text.length > 0);
    assert.ok(!(await call('GET', '/panel', { host: RHOST })).text.includes('class="panel"'));
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- global render limit ----------
test('graph: renders are capped at 2 in flight across callers, the rest queue FIFO', async () => {
  let inflight = 0, peak = 0;
  const render = () => new Promise((res) => { inflight++; peak = Math.max(peak, inflight); setTimeout(() => { inflight--; res({ asPng: () => Buffer.from('png') }); }, 40); });
  const out = await Promise.all(Array.from({ length: 5 }, () => renderGraphPng('<svg width="100"></svg>', { render })));
  assert.strictEqual(out.length, 5);
  assert.strictEqual(peak, 2);
});

test('graph: a full queue answers RENDER_BUSY; a timed-out render keeps its slot until it returns', async () => {
  const gates = [];
  let started = 0;
  const render = () => new Promise((res) => { started++; gates.push(() => res({ asPng: () => Buffer.from('png') })); });
  const svg = '<svg width="100"></svg>';
  const ps = [0, 1].map(() => renderGraphPng(svg, { render, timeoutMs: 60 }).catch((er) => er.code));
  const queued = [renderGraphPng(svg, { render, timeoutMs: 1000, maxQueue: 1 }).then((b) => b.length)];
  await assert.rejects(renderGraphPng(svg, { render, maxQueue: 1 }), { code: 'RENDER_BUSY' });
  assert.deepStrictEqual(await Promise.all(ps), ['RENDER_TIMEOUT', 'RENDER_TIMEOUT']);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(started, 2, 'timed-out renders still hold both slots, the queued one has not started');
  gates[0]();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(started, 3);
  gates[1](); gates[2]();
  assert.deepStrictEqual(await Promise.all(queued), [3]);
});

test('graph: an SVG over 2 MB is refused before rendering', async () => {
  await assert.rejects(renderGraphPng('<svg width="100">' + 'x'.repeat(2 * 1024 * 1024) + '</svg>'), { code: 'SVG_TOO_LARGE' });
});

// ---------- anim=attr: the client drives the animation ----------
const flowOf = (s) => [...s.matchAll(/<[a-z]+ [^>]*data-flow="[^>]*>/g)].map((m) => m[0]);
const offsets = (s) => flowOf(s).map((t) => /stroke-dashoffset="([^"]+)"/.exec(t)[1]);

test('graph anim=attr: no style, no SMIL, running card and live wire carry dash attributes', () => {
  const st = { ...IDLE, council: { ui: 'running', code: 'idle', run: 'idle' }, opus: 'awake', pulses: { build: 1500, gate: 0 } };
  const s = renderGraphSvg(st, {}, { layout: 'wide', anim: 'attr' });
  for (const bad of ['<style', '<animate', '<set ', '@keyframes', 'animation:']) assert.ok(!s.includes(bad), bad);
  const tags = flowOf(s);
  const card = tags.filter((t) => t.includes('stroke-dasharray="6 5"'));
  assert.ok(card.length >= 1 && card.every((t) => t.includes('data-flow="11"') && t.startsWith('<rect')));
  const wires = tags.filter((t) => t.startsWith('<path'));
  assert.strictEqual(wires.length, 1);
  assert.ok(wires[0].includes('stroke-dasharray="4 7"') && wires[0].includes('data-flow="11"') && wires[0].includes('opacity="1"'));
  assert.ok(s.includes('data-pulse="1"'));
  assert.ok(count(s, 'opacity="0"') >= 10);
});

test('graph anim=attr: an idle graph has no data-flow or data-pulse', () => {
  const s = renderGraphSvg(IDLE, {}, { layout: 'tall', anim: 'attr' });
  assert.ok(!s.includes('data-flow') && !s.includes('data-pulse') && !s.includes('<style'));
  assert.ok(!renderGraphSvg({ ...IDLE, pulses: { build: 0 } }, {}, { anim: 'attr' }).includes('data-flow'));
});

test('graph anim=attr: phase moves the dash offset, deterministically', () => {
  const st = { ...IDLE, builder: 'building', pulses: { gate: 900 } };
  const at = (phase) => renderGraphSvg(st, {}, { anim: 'attr', phase });
  assert.deepStrictEqual(offsets(at(0)), ['0', '0']);
  assert.strictEqual(at(3), at(3));
  assert.notStrictEqual(at(3), at(0));
  // phase 3 = 6 units: the 6 5 card (period 11) -> -6, the 7 6 gate wire (period 13) -> -6
  assert.deepStrictEqual(offsets(at(3)), ['-6', '-6']);
  // phase 6 = 12 units: card 12 mod 11 -> -1, gate wire 12 mod 13 -> -12
  assert.deepStrictEqual(offsets(at(6)).sort(), ['-1', '-12']);
});

test('graph: without anim the svg keeps its CSS animation', () => {
  const s = renderGraphSvg({ ...IDLE, builder: 'building' }, {}, { layout: 'wide' });
  assert.ok(s.includes('<style>') && s.includes('@keyframes march') && !s.includes('data-flow'));
});

function callOn(port, url) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const b = []; res.on('data', (d) => b.push(d));
      res.on('end', () => { const raw = Buffer.concat(b), text = raw.toString('utf8'); let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, raw, text, json }); });
    }).on('error', reject);
  });
}
function postOn(port, url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: url, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => { const b = []; res.on('data', (d) => b.push(d)); res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(b).toString('utf8')); } catch {} resolve({ status: res.statusCode, json }); }); });
    req.on('error', reject); req.end(data);
  });
}

test('panel anim=attr, phase, pulses and activity on a throwaway server', async () => {
  const PORT2 = 4830, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-anim-'));
  const env = { ...process.env, MODEL_ENGINE_PORT: String(PORT2), MODEL_ENGINE_STORE: path.join(dir, 'store.json'), MODEL_ENGINE_PULSE_MS: '900' };
  delete env.MODEL_ENGINE_HOST; delete env.MODEL_ENGINE_RESTART;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stderr.on('data', (d) => (log += d));
  try {
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('server did not start: ' + log)), 15000);
      child.stdout.on('data', (d) => { if (String(d).includes('live view on')) { clearTimeout(to); res(); } });
      child.on('exit', () => rej(new Error('server exited: ' + log)));
    });
    const folder = path.join(dir, 'proj'); fs.mkdirSync(folder, { recursive: true });
    const id = (await postOn(PORT2, '/project/new', { folder, name: 'proj' })).json.id;
    const svgUrl = (qs) => '/panel/graph.svg?folder=' + id + qs, get = (u) => callOn(PORT2, u);

    const idle = await get('/panel/state?folder=' + id);
    assert.deepStrictEqual(idle.json.activity, { animating: false, frameMs: 250 });
    assert.deepStrictEqual(idle.json.state.pulses, {});
    const calm = await get(svgUrl('&anim=attr'));
    assert.ok(!calm.text.includes('data-flow') && !calm.text.includes('<style'));
    assert.ok((await get(svgUrl(''))).text.includes('@keyframes march'));

    // a hook event pulses the wire for PULSE_MS, then it is over
    const ev = (e) => postOn(PORT2, '/event', { cwd: folder, ...e });
    assert.strictEqual((await ev({ hook_event_name: 'SubagentStart', agent_type: 'council-code' })).status, 204);
    const hot = await get('/panel/state?folder=' + id);
    assert.ok(hot.json.state.pulses['out:code'] > 0 && hot.json.state.pulses['out:code'] <= 900);
    assert.strictEqual(hot.json.state.council.code, 'running');
    assert.strictEqual(hot.json.activity.animating, true);
    const run0 = await get(svgUrl('&anim=attr&phase=0')), run3 = await get(svgUrl('&anim=attr&phase=3'));
    assert.ok(!run0.text.includes('<style') && !run0.text.includes('<animate'));
    assert.ok(flowOf(run0.text).some((t) => t.startsWith('<path') && t.includes('stroke-dasharray="4 7"')), 'the fired wire flows');
    assert.ok(flowOf(run0.text).some((t) => t.startsWith('<rect')), 'the running card flows');
    assert.notDeepStrictEqual(offsets(run0.text), offsets(run3.text));
    assert.strictEqual((await get(svgUrl('&anim=attr&phase=3'))).text, run3.text);

    const p0 = await get('/panel/graph.png?folder=' + id + '&phase=0'), p3 = await get('/panel/graph.png?folder=' + id + '&phase=3');
    assert.ok(p0.status === 200 && p3.status === 200 && p0.raw[1] === 80 && p3.raw[1] === 80);
    assert.ok(!p0.raw.equals(p3.raw));

    await new Promise((r) => setTimeout(r, 1000));
    const cool = await get('/panel/state?folder=' + id);
    assert.strictEqual(cool.json.state.pulses['out:code'], 0);
    assert.strictEqual(cool.json.activity.animating, true, 'the council member is still running');
    const after = await get(svgUrl('&anim=attr'));
    assert.ok(!flowOf(after.text).some((t) => t.startsWith('<path')), 'the wire stopped');
    assert.ok(flowOf(after.text).some((t) => t.startsWith('<rect')));
    await ev({ hook_event_name: 'SubagentStop', agent_type: 'council-code', last_assistant_message: 'pass' });
    await new Promise((r) => setTimeout(r, 1000));
    assert.strictEqual((await get('/panel/state?folder=' + id)).json.activity.animating, false);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
