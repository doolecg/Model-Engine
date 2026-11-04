const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ports 4820-4822 only; 4777, 4818 and 4779 belong to the real tools
const P_MAIN = 4820, P_IDLE = 4821, P_HOOK = 4822;
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function call(port, method, p, o = {}) {
  return new Promise((resolve, reject) => {
    const data = o.body === undefined ? null : JSON.stringify(o.body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...(o.host ? { host: o.host } : {}), ...(o.headers || {}) } }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (d) => (t += d));
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, headers: res.headers, text: t, json: j }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}
async function waitUp(port, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await call(port, 'GET', '/about')).status === 200) return; } catch {}
    await sleep(100);
  }
  throw new Error('viewer did not come up on ' + port);
}
const isUp = (port) => call(port, 'GET', '/about').then((r) => r.status === 200, () => false);

function ctx(port, extra = {}) {
  const dir = mk('me-viewer-'), home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env, MODEL_ENGINE_PORT: String(port), MODEL_ENGINE_STORE: path.join(dir, 'viewer.json'), HOME: home, USERPROFILE: home, MODEL_ENGINE_VIEWER_TEMP: '1' };
  for (const k of ['MODEL_ENGINE_HOST', 'MODEL_ENGINE_RESTART', 'MODEL_ENGINE_OFF', 'MODEL_ENGINE_MODE', 'MODEL_ENGINE_IDLE_MIN']) delete env[k];
  Object.assign(env, extra);
  return { dir, home, env, store: env.MODEL_ENGINE_STORE, pidfile: env.MODEL_ENGINE_STORE + '.pid' };
}
function startViewer(c, args = []) {
  const child = spawn(process.execPath, [path.join(__dirname, 'viewer.js'), ...args], { env: c.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.out = ''; child.stdout.on('data', (d) => (child.out += d)); child.stderr.on('data', (d) => (child.out += d));
  child.exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return child;
}
const folder = (c, name) => { const d = path.join(c.dir, name); fs.mkdirSync(d, { recursive: true }); return d; };
const ev = (cwd, o = {}) => ({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd, prompt: 'hi', ...o });

test('viewer mode serves only the allow-listed routes', async () => {
  const c = ctx(P_MAIN), v = startViewer(c);
  try {
    await waitUp(P_MAIN);
    const about = await call(P_MAIN, 'GET', '/about');
    assert.strictEqual(about.json.mode, 'viewer');
    const root = await call(P_MAIN, 'GET', '/');
    assert.strictEqual(root.status, 302);
    assert.strictEqual(root.headers.location, '/panel');
    assert.strictEqual((await call(P_MAIN, 'GET', '/panel')).status, 200);
    assert.strictEqual((await call(P_MAIN, 'GET', '/scene.js')).status, 200);
    assert.strictEqual((await call(P_MAIN, 'GET', '/fonts/jetbrains-mono-latin-400-normal.woff2')).status, 200);
    for (const p of ['/index.html', '/usage', '/accounts', '/providers', '/fs', '/files?project=x', '/update/status', '/remote/status', '/ondemand', '/claude/auth', '/auth/ping']) {
      assert.strictEqual((await call(P_MAIN, 'GET', p)).status, 404, 'GET ' + p);
    }
    for (const p of ['/chat', '/chat/stop', '/thread/set', '/project/new', '/project/close', '/project/push', '/upload/start', '/update/check', '/update/apply', '/fs/pick', '/fs/mkdir', '/remote/token', '/remote/settings', '/claude/auth', '/auth/login']) {
      assert.strictEqual((await call(P_MAIN, 'POST', p, { body: {} })).status, 404, 'POST ' + p);
    }
    assert.strictEqual((await call(P_MAIN, 'PUT', '/upload/abcdefgh')).status, 404);
    assert.strictEqual((await call(P_MAIN, 'GET', '/about', { host: 'evil.com' })).status, 403);
    assert.strictEqual((await call(P_MAIN, 'GET', '/about', { host: 'example.ts.net' })).status, 403);
    assert.strictEqual((await call(P_MAIN, 'GET', '/about', { headers: { origin: 'http://evil.com' } })).status, 403);
    assert.strictEqual((await call(P_MAIN, 'POST', '/event', { body: ev(c.dir), headers: { origin: 'http://evil.com' } })).status, 403);
  } finally { v.kill(); await v.exited; }
});

test('events register projects, ignore home, root and temp, truncate prompts, hide, cap and persist', async () => {
  const c = ctx(P_MAIN);
  let v = startViewer(c);
  try {
    await waitUp(P_MAIN);
    const a = folder(c, 'alpha'), sub = path.join(a, 'src');
    fs.mkdirSync(sub);
    const long = 'x'.repeat(200);
    assert.strictEqual((await call(P_MAIN, 'POST', '/event', { body: ev(a, { prompt: long }) })).status, 204);
    // a subfolder joins its project; a second session is counted
    assert.strictEqual((await call(P_MAIN, 'POST', '/event', { body: ev(sub, { session_id: 's2', hook_event_name: 'SessionStart', source: 'resume' }) })).status, 204);
    // home, drive root, a missing folder and junk are ignored
    for (const cwd of [c.home, path.parse(c.dir).root, path.join(c.dir, 'nope'), 'relative/dir', undefined, 5]) await call(P_MAIN, 'POST', '/event', { body: ev(cwd) });
    assert.strictEqual((await call(P_MAIN, 'POST', '/event', { body: [] })).status, 400);
    const st = (await call(P_MAIN, 'GET', '/panel/state?folder=' + encodeURIComponent(a))).json;
    assert.strictEqual(st.project.name, 'alpha');
    assert.strictEqual(st.projects.length, 1);
    assert.strictEqual(st.sessions, 2);
    assert.strictEqual(st.idle, false);
    const you = st.log.find((r) => r[1] === 'you');
    assert.strictEqual(you[2], 'x'.repeat(60));
    await sleep(700);
    assert.ok(!fs.readFileSync(c.store, 'utf8').includes('x'.repeat(61)), 'a long prompt reached the store');

    // restart: the project list comes back from the store
    v.kill(); await v.exited;
    v = startViewer(c); await waitUp(P_MAIN);
    assert.deepStrictEqual((await call(P_MAIN, 'GET', '/panel/state')).json.projects.map((p) => p.name), ['alpha']);

    // hide removes the project from the list
    const id = (await call(P_MAIN, 'GET', '/panel/state')).json.project.id;
    assert.strictEqual((await call(P_MAIN, 'POST', '/project/hide', { body: { id } })).status, 204);
    assert.strictEqual((await call(P_MAIN, 'GET', '/panel/state')).status, 404);

    // at most 30 projects; the least recently active goes first
    for (let i = 0; i < 31; i++) { await call(P_MAIN, 'POST', '/event', { body: ev(folder(c, 'p' + i)) }); await sleep(2); }
    const names = (await call(P_MAIN, 'GET', '/panel/state')).json.projects.map((p) => p.name);
    assert.strictEqual(names.length, 30);
    assert.ok(!names.includes('p0') && names.includes('p30'));
  } finally { v.kill(); await v.exited; }
});

test('temp folders are ignored unless MODEL_ENGINE_VIEWER_TEMP=1', async () => {
  const c = ctx(P_MAIN, { MODEL_ENGINE_VIEWER_TEMP: '0' }), v = startViewer(c);
  try {
    await waitUp(P_MAIN);
    await call(P_MAIN, 'POST', '/event', { body: ev(folder(c, 'in-temp')) });
    assert.strictEqual((await call(P_MAIN, 'GET', '/panel/state')).status, 404);
  } finally { v.kill(); await v.exited; }
});

test('a second viewer exits quietly while the first answers', async () => {
  const c = ctx(P_MAIN), v1 = startViewer(c);
  try {
    await waitUp(P_MAIN);
    const v2 = startViewer(c);
    assert.strictEqual(await v2.exited, 0);
    assert.strictEqual(v2.out, '');
    assert.strictEqual(fs.readFileSync(c.pidfile, 'utf8'), String(v1.pid));
    assert.strictEqual(await isUp(P_MAIN), true);
  } finally { v1.kill(); await v1.exited; }
});

test('idle exit: stays while a stream is open, then exits silently and removes the pid file', async () => {
  const c = ctx(P_IDLE, { MODEL_ENGINE_IDLE_MIN: '0.03' }), v = startViewer(c);
  await waitUp(P_IDLE);
  assert.ok(fs.existsSync(c.pidfile));
  const es = await new Promise((resolve) => { const r = http.get({ host: '127.0.0.1', port: P_IDLE, path: '/stream' }, (res) => { res.resume(); resolve(r); }); });
  await sleep(3500);
  assert.strictEqual(await isUp(P_IDLE), true, 'exited with a stream client open');
  es.destroy();
  const code = await Promise.race([v.exited, sleep(10000).then(() => 'timeout')]);
  if (code === 'timeout') v.kill();
  assert.strictEqual(code, 0);
  assert.strictEqual(v.out, '');
  assert.ok(!fs.existsSync(c.pidfile));
});

function runHook(c, input, extra = {}) {
  return spawnSync(process.execPath, [path.join(__dirname, 'hook.js')], { env: { ...c.env, ...extra }, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 20000, windowsHide: true });
}
const lockFile = (port) => path.join(os.tmpdir(), `model-engine-start-${port}.lock`);
// stops the viewer a hook started, by the PID it reports
async function stopStarted() {
  let pid = 0;
  try { pid = (await call(P_HOOK, 'GET', '/about')).json.pid; } catch {}
  if (pid) { try { process.kill(pid); } catch {} }
  for (let i = 0; i < 50 && await isUp(P_HOOK); i++) await sleep(100);
}

test('hook.js is silent, exits 0 with no viewer, starts one and delivers the event', async () => {
  const c = ctx(P_HOOK);
  try { fs.unlinkSync(lockFile(P_HOOK)); } catch {}
  assert.strictEqual(await isUp(P_HOOK), false);
  try {
    // opt-out: nothing is started
    const off = runHook(c, ev(folder(c, 'beta')), { MODEL_ENGINE_OFF: '1' });
    assert.strictEqual(off.status, 0);
    assert.strictEqual(off.stdout + off.stderr, '');
    assert.strictEqual(await isUp(P_HOOK), false);

    const r = runHook(c, ev(path.join(c.dir, 'beta')));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout + r.stderr, '');
    assert.strictEqual(await isUp(P_HOOK), true, 'the hook did not start the viewer');
    const st = (await call(P_HOOK, 'GET', '/panel/state')).json;
    assert.strictEqual(st.project.name, 'beta');
    assert.strictEqual(st.log.some((x) => x[1] === 'you'), true);
    // with the viewer up, a second hook just delivers
    const r2 = runHook(c, ev(path.join(c.dir, 'beta'), { session_id: 's9' }));
    assert.strictEqual(r2.status, 0);
    assert.strictEqual((await call(P_HOOK, 'GET', '/panel/state')).json.sessions, 2);
    // junk input still exits 0 without a sound
    const junk = runHook(c, 'not json');
    assert.strictEqual(junk.status, 0);
    assert.strictEqual(junk.stdout + junk.stderr, '');
  } finally { await stopStarted(); }
});

test('hooks that fire together start only one viewer', async () => {
  const c = ctx(P_HOOK);
  try { fs.unlinkSync(lockFile(P_HOOK)); } catch {}
  assert.strictEqual(await isUp(P_HOOK), false);
  try {
    const dir = folder(c, 'gamma');
    const run = (sid) => new Promise((resolve) => {
      const ch = spawn(process.execPath, [path.join(__dirname, 'hook.js')], { env: c.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let out = ''; ch.stdout.on('data', (d) => (out += d)); ch.stderr.on('data', (d) => (out += d));
      ch.on('exit', (code) => resolve({ code, out }));
      ch.stdin.end(JSON.stringify(ev(dir, { session_id: sid })));
    });
    const res = await Promise.all([run('a'), run('b'), run('c')]);
    for (const r of res) { assert.strictEqual(r.code, 0); assert.strictEqual(r.out, ''); }
    await waitUp(P_HOOK);
    const about = (await call(P_HOOK, 'GET', '/about')).json;
    assert.strictEqual(fs.readFileSync(c.pidfile, 'utf8'), String(about.pid));
    assert.strictEqual((await call(P_HOOK, 'GET', '/panel/state')).json.sessions, 3);
  } finally { await stopStarted(); }
});
