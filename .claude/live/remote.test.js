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

test('sessions: valid until 30 days when remembered, then expire; clear drops all', () => {
  let now = 1000;
  const s = r.createSessions({ now: () => now });
  const id = s.create({ remember: true });
  assert.ok(Buffer.from(id, 'base64url').length === 32);
  assert.strictEqual(s.valid(id), true);
  assert.strictEqual(s.valid('other'), false);
  assert.strictEqual(s.count(), 1);
  now += r.REMEMBER_MS - 1; assert.strictEqual(s.valid(id), true);
  now += r.REMEMBER_MS; assert.strictEqual(s.valid(id), false);
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

test('remote origin: https, configured host, optional valid port', () => {
  const c = 'pc.tail1234.ts.net';
  assert.ok(r.isAllowedRemoteOrigin('https://pc.tail1234.ts.net', c));
  assert.ok(r.isAllowedRemoteOrigin('https://PC.Tail1234.TS.net', c));
  assert.ok(r.isAllowedRemoteOrigin('https://pc.tail1234.ts.net:8777', c));
  assert.ok(r.isAllowedRemoteOrigin('https://pc.tail1234.ts.net:443', c));
  assert.ok(!r.isAllowedRemoteOrigin('https://other.ts.net', c));
  assert.ok(!r.isAllowedRemoteOrigin('http://pc.tail1234.ts.net', c));
  assert.ok(!r.isAllowedRemoteOrigin('http://pc.tail1234.ts.net:8777', c));
  assert.ok(!r.isAllowedRemoteOrigin('https://pc.tail1234.ts.net.evil.com', c));
  assert.ok(!r.isAllowedRemoteOrigin('https://pc.tail1234.ts.net:abc', c));
  assert.ok(!r.isAllowedRemoteOrigin('https://pc.tail1234.ts.net:99999', c));
  assert.ok(!r.isAllowedRemoteOrigin('https://pc.tail1234.ts.net:0', c));
  assert.ok(!r.isAllowedRemoteOrigin('https://pc.tail1234.ts.net:', c));
  assert.ok(!r.isAllowedRemoteOrigin('https://user@pc.tail1234.ts.net', c));
  assert.ok(!r.isAllowedRemoteOrigin('https://pc.tail1234.ts.net:80@evil.com', c));
  assert.ok(!r.isAllowedRemoteOrigin('https://pc.tail1234.ts.net/path', c));
  assert.ok(!r.isAllowedRemoteOrigin(undefined, c));
  assert.ok(!r.isAllowedRemoteOrigin('https://pc.tail1234.ts.net', null));
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
  assert.ok(!r.isAllowedRemoteHost('pc.tail1234.ts.net:0', c));
  assert.ok(!r.isAllowedRemoteHost('pc.tail1234.ts.net:99999', c));
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
const PORT = 4813, RHOST = 'pc.tail1234.ts.net';

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
    assert.deepStrictEqual(Object.keys(stored.remote).sort(), ['creds', 'enabled', 'hash', 'host', 'salt', 'sessions']);
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
    const okPort = await call('POST', '/auth/login', { host: `${RHOST}:8777`, headers: { origin: `https://${RHOST}:8777` }, body: { token } });
    assert.strictEqual(okPort.status, 200);
    assert.strictEqual((await call('POST', '/auth/login', { host: `${RHOST}:8777`, headers: { origin: `https://${RHOST}:abc` }, body: { token } })).status, 403);
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

// ---------- credentials, persistent sessions, escalating lockout ----------
test('credentials: set, verify, wrong, unknown user, case, limits', () => {
  assert.ok(r.validUsername('dayle') && r.validUsername('a.b_c-1') && r.validUsername('abc'));
  assert.ok(!r.validUsername('ab') && !r.validUsername('a'.repeat(33)) && !r.validUsername('Dayle') && !r.validUsername('a b c') && !r.validUsername(5));
  assert.ok(r.validSecret('123456') && r.validSecret('x'.repeat(128)));
  assert.ok(!r.validSecret('12345') && !r.validSecret('x'.repeat(129)) && !r.validSecret('') && !r.validSecret(123456));
  const h = r.hashToken('482913');
  const c = { username: 'dayle', ...h };
  assert.strictEqual(r.verifyCredentials('dayle', '482913', c), true);
  assert.strictEqual(r.verifyCredentials('Dayle', '482913', c), true);
  assert.strictEqual(r.verifyCredentials('dayle', '482914', c), false);
  assert.strictEqual(r.verifyCredentials('nobody', '482913', c), false);
  assert.strictEqual(r.verifyCredentials('dayle', '482913', null), false);
  assert.strictEqual(r.verifyCredentials('dayle', 5, c), false);
  assert.strictEqual(r.verifyCredentials(undefined, '482913', c), false);
  assert.notStrictEqual(r.hashToken('482913').salt, h.salt);
  // the compare runs for an unknown user too (same work as a wrong password)
  let calls = 0;
  const spy = (a, b) => { calls++; return require('crypto').timingSafeEqual(a, b); };
  r.verifyCredentials('nobody', 'whatever', c, spy); const unknown = calls; calls = 0;
  r.verifyCredentials('dayle', 'whatever', c, spy);
  assert.strictEqual(unknown, calls);
  assert.deepStrictEqual(r.restoreCreds({ username: 'dayle', ...h, extra: 1 }), c);
  assert.strictEqual(r.restoreCreds({ username: 'Bad Name', ...h }), null);
  assert.strictEqual(r.restoreCreds({ username: 'dayle', salt: 'x', hash: 'y' }), null);
});

test('device label: family only', () => {
  assert.strictEqual(r.deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'), 'Android Chrome');
  assert.strictEqual(r.deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), 'iOS Safari');
  assert.strictEqual(r.deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0'), 'Windows Edge');
  assert.strictEqual(r.deviceLabel(undefined), 'browser');
});

test('sessions: persisted as hashes, remember vs 12 h, hourly slide, cap 20, purge on load', () => {
  let now = 1e9, changes = 0;
  const s = r.createSessions({ now: () => now, onChange: () => changes++ });
  const a = s.create({ remember: true, label: 'Android Chrome' }), b = s.create({ remember: false, label: 'iOS Safari' });
  const dump = JSON.stringify(s.dump());
  assert.ok(!dump.includes(a) && !dump.includes(b), 'raw id never in the dump');
  assert.deepStrictEqual(Object.keys(s.dump()[0]).sort(), ['created', 'expires', 'idHash', 'label', 'lastSeen']);
  assert.strictEqual(s.dump()[0].idHash, require('crypto').createHash('sha256').update(a).digest('hex'));
  assert.strictEqual(s.dump()[0].expires - s.dump()[0].created, r.REMEMBER_MS);
  assert.strictEqual(s.dump()[1].expires - s.dump()[1].created, r.SHORT_MS);
  assert.ok(!JSON.stringify(s.list()).includes('idHash'));
  // slide at most once an hour, only for remembered sessions
  const c0 = changes;
  now += 60e3; assert.deepStrictEqual(s.check(a), { remember: true, slid: false }); assert.strictEqual(changes, c0);
  now += r.SLIDE_MS; assert.deepStrictEqual(s.check(a), { remember: true, slid: true }); assert.strictEqual(changes, c0 + 1);
  assert.strictEqual(s.dump()[0].expires, now + r.REMEMBER_MS);
  assert.deepStrictEqual(s.check(b), { remember: false, slid: false });
  now += r.SHORT_MS; assert.strictEqual(s.valid(b), false); assert.strictEqual(s.valid(a), true);
  // survives a "restart"
  const s2 = r.createSessions({ now: () => now });
  s2.load(JSON.parse(JSON.stringify(s.dump())));
  assert.strictEqual(s2.valid(a), true);
  now += r.REMEMBER_MS + 1;
  const s3 = r.createSessions({ now: () => now }); s3.load(s.dump());
  assert.strictEqual(s3.count(), 0);
  s3.load([{ idHash: 'nope', created: 1, lastSeen: 1, expires: now + 1e6 }, null, 5]);
  assert.strictEqual(s3.count(), 0);
  // cap 20, oldest evicted
  const s4 = r.createSessions({ now: () => now }), ids = [];
  for (let i = 0; i < 21; i++) { ids.push(s4.create({ remember: true })); now += 1; }
  assert.strictEqual(s4.count(), 20);
  assert.strictEqual(s4.valid(ids[0]), false); assert.strictEqual(s4.valid(ids[20]), true);
  assert.strictEqual(s4.revokeAt(0), true); assert.strictEqual(s4.valid(ids[1]), false); assert.strictEqual(s4.revokeAt(99), false); assert.strictEqual(s4.revokeAt('0'), false);
});

test('limiter: escalating lockout 1, 2, 4 ... capped at 15 min, reset on success', () => {
  let now = 0;
  const l = r.createLimiter({ now: () => now, escalate: true });
  const lock = () => { for (let i = 0; i < 5; i++) l.fail('k'); return l.retry('k'); };
  for (const want of [60, 120, 240, 480, 900, 900]) {
    assert.strictEqual(lock(), want);
    now += want * 1000;
    assert.strictEqual(l.retry('k'), 0);
  }
  l.reset('k');
  assert.strictEqual(lock(), 60);
});

function startServer(dir) {
  const env = { ...process.env, MODEL_ENGINE_PORT: String(PORT), MODEL_ENGINE_STORE: path.join(dir, 'store.json') };
  delete env.MODEL_ENGINE_HOST; delete env.MODEL_ENGINE_RESTART;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stderr.on('data', (d) => (log += d));
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not start: ' + log)), 15000);
    child.stdout.on('data', (d) => { if (String(d).includes('live view on')) { clearTimeout(to); res(child); } });
    child.on('exit', () => rej(new Error('server exited: ' + log)));
  });
}
const stopServer = async (child) => { child.removeAllListeners('exit'); child.kill(); await new Promise((res) => (child.exitCode !== null ? res() : child.once('exit', res))); };
const settle = () => new Promise((res) => setTimeout(res, 900));

test('username + password login, remembered sessions across a restart, revoke, lockout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-cred-'));
  const store = path.join(dir, 'store.json');
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const login = (body, who, ua) => call('POST', '/auth/login', { host: RHOST, headers: { 'tailscale-user-login': who || 'u@x.y', 'user-agent': ua || ANDROID }, body });
  const ck = (res) => [].concat(res.headers['set-cookie'])[0];
  const cookieOf = (res) => ck(res).split(';')[0];
  const about = (cookie) => call('GET', '/about', { host: RHOST, headers: { cookie } });
  let child = await startServer(dir);
  try {
    assert.strictEqual((await call('POST', '/remote/settings', { body: { enabled: true, host: RHOST } })).status, 200);

    // weak or malformed input is refused and the secret never comes back
    for (const bad of [{ username: 'dayle', secret: '12345' }, { username: 'dayle', secret: 'abcde' }, { username: 'dayle', secret: 'x'.repeat(129) }, { username: 'ab', secret: '123456' }, { username: 'bad name', secret: '123456' }, { username: 'dayle' }, { secret: '123456' }]) {
      const x = await call('POST', '/remote/credentials', { body: bad });
      assert.strictEqual(x.status, 400, JSON.stringify(bad));
      assert.ok(!bad.secret || !x.text.includes(bad.secret));
    }
    assert.strictEqual((await call('GET', '/remote/status')).json.credentials.set, false);
    assert.strictEqual((await login({ username: 'dayle', secret: '482913' }, 'none@x.y')).status, 401);

    // the credentials routes are PC-only, even for a signed-in remote device
    const tk = (await call('POST', '/remote/token', { body: {} })).json.token;
    const first = await login({ token: tk, remember: false });
    assert.strictEqual(first.status, 200);
    const firstCookie = cookieOf(first);
    for (const m of ['POST', 'DELETE']) {
      const x = await call(m, '/remote/credentials', { host: RHOST, headers: { cookie: firstCookie }, body: m === 'POST' ? { username: 'dayle', secret: '482913' } : undefined });
      assert.strictEqual(x.status, 403, m);
      assert.strictEqual(x.json.error, 'only from the PC itself');
    }
    assert.strictEqual((await call('POST', '/remote/credentials', { host: RHOST, body: { username: 'dayle', secret: '482913' } })).status, 401);
    assert.strictEqual((await call('GET', '/remote/status')).json.credentials.set, false);

    // set credentials: username folded to lower case, everyone signed out, secret not returned
    const set = await call('POST', '/remote/credentials', { body: { username: 'Dayle', secret: '482913' } });
    assert.strictEqual(set.status, 200);
    assert.deepStrictEqual(set.json.credentials, { username: 'dayle', set: true });
    assert.ok(!set.text.includes('482913'));
    assert.strictEqual((await about(firstCookie)).status, 401);

    // wrong password and unknown user look identical
    const wrong = await login({ username: 'dayle', secret: '482914', remember: true }, 'a@x.y');
    const unknown = await login({ username: 'nobody', secret: '482914', remember: true }, 'b@x.y');
    assert.strictEqual(wrong.status, 401); assert.strictEqual(unknown.status, 401);
    assert.strictEqual(wrong.text, unknown.text);
    assert.strictEqual(wrong.json.error, 'Wrong username or password');
    assert.strictEqual(wrong.headers['set-cookie'], undefined);

    // remember: 30-day cookie; not remembered: session cookie
    const rem = await login({ username: 'DAYLE', secret: '482913', remember: true });
    assert.strictEqual(rem.status, 200);
    assert.match(ck(rem), /^me_auth=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=2592000$/);
    const shortRes = await login({ username: 'dayle', secret: '482913', remember: false }, 'c@x.y', IPHONE);
    assert.strictEqual(shortRes.status, 200);
    assert.match(ck(shortRes), /^me_auth=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/$/);
    const rememberCookie = cookieOf(rem), shortCookie = cookieOf(shortRes);
    assert.strictEqual((await about(rememberCookie)).status, 200);
    assert.strictEqual((await about(shortCookie)).status, 200);
    const st = (await call('GET', '/remote/status')).json;
    assert.deepStrictEqual(st.sessions.map((x) => x.label), ['Android Chrome', 'iOS Safari']);
    assert.deepStrictEqual(Object.keys(st.sessions[0]).sort(), ['created', 'label', 'lastSeen']);
    assert.ok(!JSON.stringify(st).includes(rememberCookie.slice(8)));

    // the store holds hashes only
    await settle();
    const raw = fs.readFileSync(store, 'utf8');
    for (const secret of [rememberCookie.slice(8), shortCookie.slice(8), '482913', tk]) assert.ok(!raw.includes(secret), 'secret found in store');
    const rm = JSON.parse(raw).remote;
    assert.strictEqual(rm.sessions.length, 2);
    assert.deepStrictEqual(Object.keys(rm.creds).sort(), ['hash', 'salt', 'username']);
    assert.strictEqual(rm.sessions[0].idHash, require('crypto').createHash('sha256').update(rememberCookie.slice(8)).digest('hex'));

    // restart the server on the same store: cookies still work
    await stopServer(child);
    child = await startServer(dir);
    assert.strictEqual((await about(rememberCookie)).status, 200);
    assert.strictEqual((await about(shortCookie)).status, 200);
    assert.strictEqual((await about('me_auth=forged')).status, 401);
    assert.strictEqual((await login({ username: 'dayle', secret: '482913' }, 'd@x.y')).status, 200);

    // revoke one device by index, then all
    assert.strictEqual((await call('GET', '/remote/status')).json.sessions.length, 3);
    assert.strictEqual((await call('POST', '/remote/revoke', { body: { index: 7 } })).status, 400);
    assert.strictEqual((await call('POST', '/remote/revoke', { body: { index: 0 } })).status, 200);
    assert.strictEqual((await about(rememberCookie)).status, 401);
    assert.strictEqual((await about(shortCookie)).status, 200);
    assert.strictEqual((await call('GET', '/remote/status')).json.sessions.length, 2);
    assert.strictEqual((await call('POST', '/remote/revoke', { body: {} })).status, 200);
    assert.strictEqual((await about(shortCookie)).status, 401);
    assert.strictEqual((await call('GET', '/remote/status')).json.sessions.length, 0);

    // a new token signs everyone out; the token still logs in, and so do the credentials
    const live = cookieOf(await login({ username: 'dayle', secret: '482913', remember: true }, 'e@x.y'));
    const tk2 = (await call('POST', '/remote/token', { body: {} })).json.token;
    assert.strictEqual((await about(live)).status, 401);
    assert.strictEqual((await login({ token: tk }, 'f@x.y')).status, 401);
    assert.strictEqual((await login({ token: tk2 }, 'f@x.y')).status, 200);
    assert.strictEqual((await login({ username: 'dayle', secret: '482913' }, 'f@x.y')).status, 200);

    // lockout per client key: 5 failures, then 429 with Retry-After even for the right password; another key is unaffected
    for (let i = 0; i < 5; i++) assert.strictEqual((await login({ username: 'dayle', secret: 'wrong' + i }, 'lock@x.y')).status, 401);
    const locked = await login({ username: 'dayle', secret: '482913' }, 'lock@x.y');
    assert.strictEqual(locked.status, 429);
    const wait = Number(locked.headers['retry-after']);
    assert.ok(wait > 0 && wait <= 60, 'first lockout is about a minute: ' + wait);
    assert.strictEqual((await login({ username: 'dayle', secret: '482913' }, 'other@x.y')).status, 200);

    // the login page has the new fields and a strict CSP
    const page = await call('GET', '/', { host: RHOST });
    for (const bit of ['autocomplete="username"', 'autocomplete="current-password"', 'Remember this device', 'Use access token instead', 'role="alert"']) assert.ok(page.text.includes(bit), bit);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);

    // remove credentials from the PC
    const del = await call('DELETE', '/remote/credentials');
    assert.strictEqual(del.status, 200);
    assert.deepStrictEqual(del.json.credentials, { username: null, set: false });
    assert.strictEqual((await login({ username: 'dayle', secret: '482913' }, 'g@x.y')).status, 401);
    assert.strictEqual((await login({ token: tk2 }, 'g@x.y')).status, 200);
  } finally {
    await stopServer(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
