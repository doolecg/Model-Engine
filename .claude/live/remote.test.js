const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const r = require('./remote.js');

test('token: generated, hashed, verified; wrong token fails', () => {
  const t = r.generateToken();
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.notStrictEqual(t, r.generateToken());
  const h = r.hashToken(t);
  assert.deepStrictEqual(Object.keys(h).sort(), ['hash', 'salt']);
  assert.ok(!JSON.stringify(h).includes(t));
  assert.strictEqual(r.verifyToken(t, h), true);
  assert.strictEqual(r.verifyToken(t + 'x', h), false);
  assert.strictEqual(r.verifyToken('', h), false);
  assert.strictEqual(r.verifyToken(t, null), false);
  assert.notStrictEqual(r.hashToken(t).hash, h.hash);
});

test('token: comparison goes through the timing-safe function', () => {
  const t = r.generateToken(), h = r.hashToken(t);
  let calls = 0;
  const spy = (a, b) => { calls++; return require('crypto').timingSafeEqual(a, b); };
  assert.strictEqual(r.verifyToken(t, h, spy), true);
  assert.strictEqual(r.verifyToken('nope', h, spy), false);
  assert.strictEqual(calls, 2);
});

test('sessions: valid until 7 days, then expire; clear drops all', () => {
  let now = 1000;
  const s = r.createSessions({ now: () => now });
  const id = s.create();
  assert.ok(Buffer.from(id, 'base64url').length === 32);
  assert.strictEqual(s.valid(id), true);
  assert.strictEqual(s.valid('other'), false);
  assert.strictEqual(s.count(), 1);
  now += r.SESSION_MS - 1; assert.strictEqual(s.valid(id), true);
  now += 1; assert.strictEqual(s.valid(id), false);
  const b = s.create(); s.clear();
  assert.strictEqual(s.valid(b), false);
  assert.strictEqual(s.count(), 0);
});

test('cookie parsing', () => {
  assert.strictEqual(r.parseCookie('a=1; me_auth=abc; b=2', 'me_auth'), 'abc');
  assert.strictEqual(r.parseCookie('xme_auth=abc', 'me_auth'), null);
  assert.strictEqual(r.parseCookie(undefined, 'me_auth'), null);
});

test('loopback detection', () => {
  assert.ok(r.isLoopbackHost('127.0.0.1:4777', 4777));
  assert.ok(r.isLoopbackHost('localhost:4777', 4777));
  assert.ok(!r.isLoopbackHost('127.0.0.1:1', 4777));
  assert.ok(!r.isLoopbackHost('127.0.0.1', 4777));
  assert.ok(!r.isLoopbackHost('me.ts.net', 4777));
  assert.ok(!r.isLoopbackHost(undefined, 4777));
});

test('remote host: exact match only', () => {
  const c = 'pc.tail1234.ts.net';
  assert.ok(r.isAllowedRemoteHost('pc.tail1234.ts.net', c));
  assert.ok(r.isAllowedRemoteHost('PC.Tail1234.TS.net', c));
  assert.ok(r.isAllowedRemoteHost('pc.tail1234.ts.net:443', c));
  assert.ok(!r.isAllowedRemoteHost('pc.tail1234.ts.net.attacker.com', c));
  assert.ok(!r.isAllowedRemoteHost('evil.ts.net', c));
  assert.ok(!r.isAllowedRemoteHost('evil.pc.tail1234.ts.net', c));
  assert.ok(!r.isAllowedRemoteHost('pc.tail1234.ts.net:abc', c));
  assert.ok(!r.isAllowedRemoteHost('pc.tail1234.ts.net:', c));
  assert.ok(!r.isAllowedRemoteHost('pc.tail1234.ts.net@evil.com', c));
  assert.ok(!r.isAllowedRemoteHost(undefined, c));
  // configured name must itself be a *.ts.net name
  assert.ok(!r.isAllowedRemoteHost('example.com', 'example.com'));
  assert.ok(!r.isAllowedRemoteHost('.ts.net', '.ts.net'));
  assert.ok(!r.isAllowedRemoteHost('a', null));
  assert.ok(r.validHost('a.b.ts.net') && !r.validHost('a_b.ts.net') && !r.validHost('a..ts.net') && !r.validHost('A.ts.net'));
});

test('proxy headers are recognised', () => {
  assert.ok(r.isProxied({ 'x-forwarded-for': '1.2.3.4' }));
  assert.ok(r.isProxied({ 'tailscale-user-login': 'a@b' }));
  assert.ok(!r.isProxied({ host: '127.0.0.1:4777', origin: 'http://127.0.0.1:4777' }));
});

test('rate limiter: 5 failures then blocked 60 s, per key', () => {
  let now = 0;
  const l = r.createLimiter({ now: () => now });
  for (let i = 0; i < 4; i++) { l.fail('a'); assert.strictEqual(l.retry('a'), 0); }
  l.fail('a');
  assert.strictEqual(l.retry('a'), 60);
  assert.strictEqual(l.retry('b'), 0);
  now += 59e3; assert.ok(l.retry('a') > 0);
  now += 1e3; assert.strictEqual(l.retry('a'), 0);
  // failures outside the 60 s window do not add up
  for (let i = 0; i < 4; i++) { l.fail('c'); now += 20e3; }
  l.fail('c'); assert.strictEqual(l.retry('c'), 0);
  l.fail('d'); l.reset('d'); assert.strictEqual(l.retry('d'), 0);
});

test('restore keeps only well-formed settings', () => {
  const h = r.hashToken('x');
  assert.deepStrictEqual(r.restore({ enabled: true, host: 'a.ts.net', ...h }), { enabled: true, host: 'a.ts.net', ...h });
  assert.strictEqual(r.restore({ enabled: true, host: 'evil.com', ...h }).enabled, false);
  assert.strictEqual(r.restore({ enabled: true, host: 'a.ts.net', salt: 'x', hash: 'y' }).hash, null);
  assert.strictEqual(r.restore(null).enabled, false);
});

test('tailscale status: keeps only DNSName and BackendState', () => {
  const j = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'Pc.Tail1.ts.net.', TailscaleIPs: ['100.1.1.1'], UserID: 5 }, Peer: { x: { DNSName: 'other.ts.net.' } }, User: { 5: { LoginName: 'me@x.com' } } });
  const p = r.parseStatus(j);
  assert.deepStrictEqual(p, { running: true, dnsName: 'pc.tail1.ts.net' });
  assert.deepStrictEqual(r.parseStatus('{"BackendState":"Stopped"}'), { running: false, dnsName: null });
  assert.strictEqual(r.parseStatus('nope'), null);
  assert.strictEqual(r.publishCommand(4777), 'tailscale serve --bg 4777');
});

test('tailscale detection: args array, 5 s timeout, falls back, reports missing', async () => {
  const seen = [];
  const ok = (bin, args, opts, cb) => { seen.push([bin, args, opts.timeout]); cb(bin === 'tailscale' ? Object.assign(new Error('x'), { code: 'ENOENT' }) : null, JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'pc.t.ts.net.' } })); };
  const a = await r.detectTailscale({ execFile: ok, exists: () => true, platform: 'win32' });
  assert.deepStrictEqual(a, { installed: true, running: true, dnsName: 'pc.t.ts.net' });
  assert.deepStrictEqual(seen[1], ['C:\\Program Files\\Tailscale\\tailscale.exe', ['status', '--json'], 5000]);
  const none = (b, a2, o, cb) => cb(Object.assign(new Error('x'), { code: 'ENOENT' }));
  assert.deepStrictEqual(await r.detectTailscale({ execFile: none, exists: () => false, platform: 'linux' }), { installed: false, running: false, dnsName: null });
});

// ---------- guard-level: a throwaway server with crafted Host headers (no Tailscale needed) ----------
const PORT = 4802, RHOST = 'pc.tail1234.ts.net';

function call(method, url, { host = `127.0.0.1:${PORT}`, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: url, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (d) => (t += d));
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, headers: res.headers, text: t, json: j }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('guard on a throwaway server', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-remote-'));
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

    // loopback needs no token and keeps the old checks
    assert.strictEqual((await call('GET', '/about')).status, 200);
    assert.strictEqual((await call('GET', '/about', { headers: { origin: 'http://evil.com' } })).status, 403);
    assert.strictEqual((await call('GET', '/about', { host: 'evil.com' })).status, 403);
    // malformed /chat bodies are 400 and never crash the server
    const pr = await call('POST', '/project/new', { body: { folder: dir } });
    assert.strictEqual(pr.status, 200);
    const tid = await new Promise((res) => setTimeout(() => res(JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8')).projects.find((x) => x.id === pr.json.id).threads[0].id), 900));
    for (const bad of [{ thread: tid, text: 'hi', atts: 5 }, { thread: tid, atts: [null] }, { thread: tid, text: 5 }, { thread: tid, text: ' ', atts: [{ name: 1 }] }, { thread: 'nope', text: 'hi' }]) {
      assert.strictEqual((await call('POST', '/chat', { body: bad })).status, 400, JSON.stringify(bad));
    }
    assert.strictEqual((await call('GET', '/about')).status, 200);
    // remote is off by default
    assert.strictEqual((await call('GET', '/', { host: RHOST })).status, 403);

    // admin settings
    assert.strictEqual((await call('POST', '/remote/settings', { body: { enabled: true, host: 'example.com' } })).status, 400);
    assert.strictEqual((await call('POST', '/remote/settings', { body: { enabled: true, host: 'a_b.ts.net' } })).status, 400);
    const st = await call('POST', '/remote/settings', { body: { enabled: true, host: RHOST } });
    assert.strictEqual(st.status, 200);
    assert.strictEqual(st.json.enabled, true);
    assert.strictEqual(st.json.host, RHOST);
    assert.strictEqual(st.json.tokenSet, false);
    assert.strictEqual(st.json.publishCommand, `tailscale serve --bg ${PORT}`);
    const tk = await call('POST', '/remote/token', { body: {} });
    assert.strictEqual(tk.status, 200);
    const token = tk.json.token;
    assert.ok(token && token.length >= 43);
    const stored = JSON.parse(await new Promise((res) => setTimeout(() => res(fs.readFileSync(path.join(dir, 'store.json'), 'utf8')), 900)));
    assert.ok(!JSON.stringify(stored).includes(token), 'token must not be stored');
    assert.deepStrictEqual(Object.keys(stored.remote).sort(), ['enabled', 'hash', 'host', 'salt']);
    const s2 = await call('GET', '/remote/status');
    assert.strictEqual(s2.json.tokenSet, true);
    assert.ok(!JSON.stringify(s2.json).includes(token));

    // remote: no cookie
    const login = await call('GET', '/', { host: RHOST });
    assert.strictEqual(login.status, 200);
    assert.match(login.text, /Model Engine sign in/);
    assert.ok(!/https?:\/\//.test(login.text.replace(/<[^>]*>/g, '')) && !/(src|href)=/.test(login.text), 'login page has no external resources');
    assert.strictEqual((await call('GET', '/about', { host: RHOST })).status, 401);
    assert.strictEqual((await call('GET', '/stream', { host: RHOST })).status, 401);
    assert.strictEqual((await call('GET', '/about', { host: RHOST, headers: { cookie: 'me_auth=forged' } })).status, 401);
    assert.strictEqual((await call('GET', '/auth/ping', { host: RHOST })).status, 200);
    assert.strictEqual((await call('GET', '/about', { host: RHOST + '.attacker.com' })).status, 403);
    assert.strictEqual((await call('GET', '/about', { host: 'other.ts.net' })).status, 403);

    // a proxied request cannot claim a loopback Host
    assert.strictEqual((await call('GET', '/about', { headers: { 'tailscale-user-login': 'a@b.c' } })).status, 403);

    // wrong token, then right token
    assert.strictEqual((await call('POST', '/auth/login', { host: RHOST, body: { token: 'wrong' } })).status, 401);
    assert.strictEqual((await call('POST', '/auth/login', { host: RHOST, headers: { origin: 'https://evil.com' }, body: { token: token } })).status, 403);
    const ok = await call('POST', '/auth/login', { host: RHOST, headers: { origin: `https://${RHOST}` }, body: { token } });
    assert.strictEqual(ok.status, 200);
    const sc = [].concat(ok.headers['set-cookie'])[0];
    assert.match(sc, /^me_auth=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\//);
    const cookie = sc.split(';')[0];
    assert.strictEqual((await call('GET', '/about', { host: RHOST, headers: { cookie } })).status, 200);
    const page = await call('GET', '/', { host: RHOST, headers: { cookie } });
    assert.strictEqual(page.status, 200);
    assert.ok(!/Model Engine sign in/.test(page.text));

    // forbidden remotely, even when signed in
    for (const [m, u] of [['POST', '/fs/pick'], ['POST', '/update/apply'], ['POST', '/update/rollback'], ['POST', '/update/settings'], ['POST', '/remote/token'], ['POST', '/remote/settings'], ['POST', '/remote/revoke'], ['GET', '/remote/status']]) {
      const x = await call(m, u, { host: RHOST, headers: { cookie }, body: m === 'POST' ? {} : undefined });
      assert.strictEqual(x.status, 403, m + ' ' + u);
      assert.strictEqual(x.json.error, 'only from the PC itself');
    }
    assert.strictEqual((await call('GET', '/about', { host: RHOST, headers: { cookie, origin: 'https://evil.com' } })).status, 403);
    assert.strictEqual((await call('GET', '/about', { host: RHOST, headers: { cookie, origin: `http://${RHOST}` } })).status, 403);

    // revoke from the PC drops the session
    assert.strictEqual((await call('POST', '/remote/revoke', { body: {} })).status, 200);
    assert.strictEqual((await call('GET', '/about', { host: RHOST, headers: { cookie } })).status, 401);

    // rate limit: 5 bad tokens then 429, even with the right one
    for (let i = 0; i < 5; i++) assert.strictEqual((await call('POST', '/auth/login', { host: RHOST, body: { token: 'bad' + i } })).status, 401);
    const lim = await call('POST', '/auth/login', { host: RHOST, body: { token } });
    assert.strictEqual(lim.status, 429);
    assert.ok(Number(lim.headers['retry-after']) > 0);

    // disabling turns remote Hosts away again
    assert.strictEqual((await call('POST', '/remote/settings', { body: { enabled: false, host: RHOST } })).status, 200);
    assert.strictEqual((await call('GET', '/', { host: RHOST })).status, 403);
  } finally {
    child.kill();
    await new Promise((res) => (child.exitCode !== null ? res() : child.once('exit', res)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
