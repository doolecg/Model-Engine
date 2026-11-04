const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const up = require('./upload.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const listAll = (d) => { const out = []; (function w(x) { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const f = path.join(x, e.name); if (e.isDirectory()) w(f); else out.push(f); } })(d); return out; };

test('safeRel: good paths pass and come back with forward slashes', () => {
  for (const p of ['a.txt', 'src/index.js', 'a/b/c/d.md', 'dir with space/file (1).txt', '.env.example', 'x'.repeat(200), 'Console.txt.bak', 'COM10', 'a/' + 'b/'.repeat(18) + 'c']) assert.strictEqual(up.safeRel(p), p, p);
});

test('safeRel: every bad class is rejected', () => {
  const bad = {
    empty: ['', null, undefined, 5, {}],
    absolute: ['/etc/passwd', '/a'],
    drive: ['C:\\x', 'C:/x', 'c:x', 'a/C:/x'],
    backslash: ['a\\b', '..\\x', '\\\\server\\share', 'a/b\\c'],
    dotdot: ['..', '../x', 'a/../b', 'a/../../b', 'a/..', './a', 'a/./b', 'a//b', 'a/'],
    nul: ['a\0b', 'a/b\0'],
    reserved: ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9', 'a/NUL.txt', 'dir/aux.c', 'CON '],
    trailing: ['a.', 'a ', 'dir./f', 'dir /f'],
    longName: ['x'.repeat(201), 'a/' + 'y'.repeat(201)],
    deep: ['a/'.repeat(20) + 'b'],
    chars: ['a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b', 'a\nb', 'a\x01'],
  };
  for (const [k, list] of Object.entries(bad)) for (const p of list) assert.strictEqual(up.safeRel(p), null, `${k}: ${JSON.stringify(p)}`);
  assert.strictEqual(up.safeRel('a/'.repeat(19) + 'b'), 'a/'.repeat(19) + 'b');
});

test('cleanName: only [A-Za-z0-9 ._-], trimmed, max 60, never reserved or hidden', () => {
  assert.strictEqual(up.cleanName('My App!'), 'My App_');
  assert.strictEqual(up.cleanName('  ..hidden  '), 'hidden');
  assert.strictEqual(up.cleanName('a'.repeat(100)).length, 60);
  assert.strictEqual(up.cleanName(''), 'Uploaded project');
  assert.strictEqual(up.cleanName('...'), 'Uploaded project');
  assert.strictEqual(up.cleanName('CON'), 'CON_');
  assert.match(up.cleanName('../../etc'), /^[A-Za-z0-9 ._-]+$/);
  assert.ok(!up.cleanName('../../etc').includes('/'));
});

test('uniqueProjectName adds -2, -3 on collision', () => {
  const root = tmp('me-uq-');
  assert.strictEqual(up.uniqueProjectName(root, 'app'), 'app');
  fs.mkdirSync(path.join(root, 'app'));
  assert.strictEqual(up.uniqueProjectName(root, 'app'), 'app-2');
  fs.mkdirSync(path.join(root, 'app-2'));
  assert.strictEqual(up.uniqueProjectName(root, 'app'), 'app-3');
  fs.rmSync(root, { recursive: true, force: true });
});

const body = (s) => Readable.from([Buffer.from(s)]);

test('uploads: full flow, limits, cancel, expiry, per-key cap (module level)', async () => {
  const root = tmp('me-ur-');
  let now = 1000;
  const u = up.createUploads({ root, now: () => now, limits: { maxFile: 10, maxTotal: 40, maxFiles: 5, idleMs: 100 }, statfs: null });
  try {
    // refuse oversize announcements
    assert.throws(() => u.start('k', { name: 'x', files: 6, bytes: 1 }), { status: 413 });
    assert.throws(() => u.start('k', { name: 'x', files: 1, bytes: 41 }), { status: 413 });
    assert.throws(() => u.start('k', { name: 'x', files: 0, bytes: 1 }), { status: 400 });
    assert.throws(() => u.start('k', null), { status: 400 });
    assert.strictEqual(u.size(), 0);

    const a = u.start('k', { name: 'proj', files: 2, bytes: 12 });
    assert.strictEqual(a.name, 'proj');
    assert.strictEqual(u.start('other', { name: 'proj', files: 1, bytes: 1 }).name, 'proj-2');
    // another key cannot touch it
    await assert.rejects(u.putFile(a.id, 'other', 'x.txt', body('1')), { status: 404 });
    // total cap: announced 12 bytes
    await u.putFile(a.id, 'k', 'src/a.txt', body('hello'));
    await assert.rejects(u.putFile(a.id, 'k', 'src/a.txt', body('x')), { status: 409 });
    await assert.rejects(u.putFile(a.id, 'k', 'src/B.txt', body('1234567890'), undefined), { status: 413 });
    await assert.rejects(u.putFile(a.id, 'k', 'f.txt', body('12345678'), undefined), { status: 413 }); // 5 + 8 > 12
    assert.throws(() => u.finish(a.id, 'k'), { status: 400 });
    await u.putFile(a.id, 'k', 'src/b.txt', body('worlds!'));
    await assert.rejects(u.putFile(a.id, 'k', 'third.txt', body('')), { status: 400 });
    const r = u.finish(a.id, 'k');
    assert.strictEqual(fs.readFileSync(path.join(r.dir, 'src', 'a.txt'), 'utf8'), 'hello');
    assert.strictEqual(fs.readFileSync(path.join(r.dir, 'src', 'b.txt'), 'utf8'), 'worlds!');
    assert.ok(listAll(r.dir).every((f) => !/\.part-/.test(f)));
    assert.throws(() => u.finish(a.id, 'k'), { status: 404 });

    // per-file cap mid-stream leaves no temp file
    const b = u.start('k2', { name: 'cap', files: 1, bytes: 40 });
    await assert.rejects(u.putFile(b.id, 'k2', 'f.bin', Readable.from([Buffer.alloc(6), Buffer.alloc(6)])), { status: 413 });
    assert.deepStrictEqual(listAll(path.join(root, b.name)), []);
    // traversal never writes
    for (const p of ['../x', '..\\x', '/abs', 'C:\\x', 'a/../../b']) await assert.rejects(u.putFile(b.id, 'k2', p, body('x')), { status: 400 }, p);
    assert.deepStrictEqual(fs.readdirSync(root).sort(), ['.uploads', 'cap', 'proj', 'proj-2']);

    // a file where a folder is needed is a clean 400
    const c = u.start('k3', { name: 'clash', files: 2, bytes: 10 });
    await u.putFile(c.id, 'k3', 'a', body('1'));
    await assert.rejects(u.putFile(c.id, 'k3', 'a/b', body('2')), { status: 400 });

    // per-key cap of 2 active uploads
    assert.throws(() => u.start('k3', { name: 'n3', files: 1, bytes: 1 }).name && u.start('k3', { name: 'n4', files: 1, bytes: 1 }), { status: 429 });

    // delete removes the partial folder and its marker
    u.remove(b.id, 'k2');
    assert.ok(!fs.existsSync(path.join(root, b.name)));
    assert.throws(() => u.remove(b.id, 'k2'), { status: 404 });

    // idle expiry
    const names = fs.readdirSync(root).filter((n) => n !== '.uploads');
    assert.ok(names.includes('clash'));
    now += 50; u.sweep();
    assert.ok(fs.existsSync(path.join(root, 'clash')));
    now += 200; u.sweep();
    assert.strictEqual(u.size(), 0);
    assert.deepStrictEqual(fs.readdirSync(root).sort(), ['.uploads', 'proj']);
    assert.strictEqual(fs.readdirSync(path.join(root, '.uploads')).length, 0);
    assert.throws(() => u.finish('nope', 'x'), { status: 404 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('uploads: cleanStale removes folders left by a dead process, nothing else', () => {
  const root = tmp('me-cs-');
  try {
    const u1 = up.createUploads({ root, statfs: null });
    const a = u1.start('k', { name: 'half', files: 1, bytes: 1 });
    fs.mkdirSync(path.join(root, 'keepme'));
    fs.writeFileSync(path.join(root, '.uploads', 'junk'), JSON.stringify({ dir: '../escape' }));
    fs.mkdirSync(path.join(path.dirname(root), path.basename(root) + '-escape'), { recursive: true });
    up.createUploads({ root, statfs: null }).cleanStale();
    assert.ok(!fs.existsSync(path.join(root, a.name)));
    assert.ok(fs.existsSync(path.join(root, 'keepme')));
    assert.ok(fs.existsSync(path.join(path.dirname(root), path.basename(root) + '-escape')));
    assert.strictEqual(fs.readdirSync(path.join(root, '.uploads')).length, 0);
    fs.rmSync(path.join(path.dirname(root), path.basename(root) + '-escape'), { recursive: true, force: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('uploads: not enough disk space is refused', () => {
  const root = tmp('me-ds-');
  try {
    const u = up.createUploads({ root, statfs: () => ({ bavail: 10, bsize: 1024 }) });
    assert.throws(() => u.start('k', { name: 'x', files: 1, bytes: 1 }), { status: 507 });
    assert.deepStrictEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- HTTP level: a throwaway server, crafted Host headers, temp store and temp upload root ----------
const PORT = 4814, RHOST = 'pc.tail1234.ts.net';

function call(method, url, { host = `127.0.0.1:${PORT}`, headers = {}, body: b, raw } = {}) {
  return new Promise((resolve) => {
    const data = raw !== undefined ? null : b === undefined ? null : JSON.stringify(b);
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: url, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (d) => (t += d));
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, headers: res.headers, text: t, json: j }); });
    });
    req.on('error', (er) => resolve({ status: 0, error: er.code || String(er) }));
    if (data) req.write(data);
    if (typeof raw === 'function') raw(req); else { if (raw !== undefined) req.write(raw); req.end(); }
  });
}
const OCT = { 'content-type': 'application/octet-stream' };

test('upload routes on a throwaway server', async () => {
  const dir = tmp('me-up-'), uroot = path.join(dir, 'ws');
  const env = { ...process.env, MODEL_ENGINE_PORT: String(PORT), MODEL_ENGINE_STORE: path.join(dir, 'store.json'), MODEL_ENGINE_UPLOAD_ROOT: uroot };
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
    const put = (id, rel, data, o = {}) => call('PUT', `/upload/${id}?path=${encodeURIComponent(rel)}`, { raw: data, ...o, headers: { ...OCT, ...(o.headers || {}) } });

    // unauthenticated remote: remote is off, then on without a cookie
    assert.strictEqual((await call('POST', '/upload/start', { host: RHOST, body: { name: 'x', files: 1, bytes: 1 } })).status, 403);
    assert.strictEqual((await call('POST', '/remote/settings', { body: { enabled: true, host: RHOST } })).status, 200);
    const token = (await call('POST', '/remote/token', { body: {} })).json.token;
    assert.strictEqual((await call('POST', '/upload/start', { host: RHOST, body: { name: 'x', files: 1, bytes: 1 } })).status, 401);
    assert.strictEqual((await call('PUT', '/upload/abcdefgh12?path=a.txt', { host: RHOST, headers: OCT, raw: 'x' })).status, 401);
    assert.strictEqual((await call('DELETE', '/upload/abcdefgh12', { host: RHOST })).status, 401);
    assert.strictEqual((await call('POST', '/upload/start', { host: RHOST, headers: { cookie: 'me_auth=forged' }, body: { name: 'x', files: 1, bytes: 1 } })).status, 401);
    assert.ok(!fs.existsSync(uroot) || fs.readdirSync(uroot).filter((n) => n !== '.uploads').length === 0);

    // authenticated remote session
    const login = await call('POST', '/auth/login', { host: RHOST, body: { token } });
    assert.strictEqual(login.status, 200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const R = { host: RHOST, headers: { cookie } };

    const st = await call('POST', '/upload/start', { ...R, body: { name: 'My Project!', files: 3, bytes: 40 } });
    assert.strictEqual(st.status, 200);
    const id = st.json.id;
    assert.ok(fs.statSync(path.join(uroot, 'My Project_')).isDirectory());
    { const r0 = await put(id, 'README.md', 'hello readme', R); assert.strictEqual(r0.status, 200, r0.text); }
    const contents = { 'src/main.js': 'console.log(1)\n', 'src/deep/data.json': '{"a":1}' };
    assert.strictEqual((await put(id, 'src/main.js', contents['src/main.js'], R)).status, 200);
    assert.strictEqual((await put(id, 'src/deep/data.json', contents['src/deep/data.json'], R)).status, 200);

    // wrong content type, wrong owner
    assert.strictEqual((await call('PUT', `/upload/${id}?path=z.txt`, { ...R, raw: 'x' })).status, 415);
    assert.strictEqual((await put(id, 'z.txt', 'x')).status, 404);

    const fin = await call('POST', `/upload/${id}/finish`, { ...R, body: {} });
    assert.strictEqual(fin.status, 200);
    assert.ok(fin.json.id);
    const proj = path.join(uroot, 'My Project_');
    assert.strictEqual(fs.readFileSync(path.join(proj, 'README.md'), 'utf8'), 'hello readme');
    assert.strictEqual(fs.readFileSync(path.join(proj, 'src', 'main.js'), 'utf8'), contents['src/main.js']);
    assert.strictEqual(fs.readFileSync(path.join(proj, 'src', 'deep', 'data.json'), 'utf8'), contents['src/deep/data.json']);
    // the project is registered
    const saved = await new Promise((res) => setTimeout(() => res(JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'))), 900));
    const reg = saved.projects.find((p) => p.id === fin.json.id);
    assert.ok(reg);
    assert.strictEqual(path.resolve(reg.folder), proj);
    assert.strictEqual(reg.name, 'My Project_');

    // same name again gets -2
    const st2 = await call('POST', '/upload/start', { ...R, body: { name: 'My Project!', files: 1, bytes: 5 } });
    assert.ok(fs.existsSync(path.join(uroot, 'My Project_-2')));

    // traversal attempts: 400 and nothing outside the upload folder
    const before = fs.readdirSync(dir).sort();
    for (const p of ['../x', '..\\x', '/abs', 'C:\\x', 'a/../../b']) {
      const r = await put(st2.json.id, p, 'evil', R);
      assert.strictEqual(r.status, 400, p);
    }
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), before);
    assert.deepStrictEqual(listAll(path.join(uroot, 'My Project_-2')), []);

    // bytes announced cap: 5 announced, 9 sent
    const over = await put(st2.json.id, 'big.txt', '123456789', R);
    assert.strictEqual(over.status, 413);
    assert.deepStrictEqual(listAll(path.join(uroot, 'My Project_-2')), []);
    // too large announcement
    assert.strictEqual((await call('POST', '/upload/start', { ...R, body: { name: 'x', files: 1, bytes: 301 * 1048576 } })).status, 413);
    assert.strictEqual((await call('POST', '/upload/start', { ...R, body: { name: 'x', files: 2001, bytes: 1 } })).status, 413);

    // one file over 25 MB, sent as chunks with no length: rejected mid-stream, nothing left behind
    const st3 = await call('POST', '/upload/start', { ...R, body: { name: 'huge', files: 1, bytes: 40 * 1048576 } });
    assert.strictEqual(st3.status, 200);
    const huge = await put(st3.json.id, 'big.bin', (req) => {
      const chunk = Buffer.alloc(1048576, 7); let n = 0;
      const next = () => { if (n++ >= 27 || req.destroyed) return req.end(); if (req.write(chunk)) setImmediate(next); else req.once('drain', next); };
      next();
    }, R);
    assert.ok(huge.status === 413 || huge.status === 0, 'status ' + huge.status);
    assert.deepStrictEqual(listAll(path.join(uroot, 'huge')), []);
    // a declared length over the cap is refused up front
    assert.strictEqual((await call('PUT', `/upload/${st3.json.id}?path=b.bin`, { ...R, headers: { ...R.headers, ...OCT, 'content-length': String(26 * 1048576) }, raw: (req) => req.end() })).status, 413);

    // DELETE removes the partial folder
    assert.strictEqual((await call('DELETE', `/upload/${st3.json.id}`, R)).status, 204);
    assert.ok(!fs.existsSync(path.join(uroot, 'huge')));
    assert.strictEqual((await call('DELETE', `/upload/${st2.json.id}`, R)).status, 204);
    assert.ok(!fs.existsSync(path.join(uroot, 'My Project_-2')));
    assert.strictEqual((await call('DELETE', `/upload/${st2.json.id}`, R)).status, 404);

    // local (PC) browser works too, with its own key
    const lo = await call('POST', '/upload/start', { body: { name: 'local', files: 1, bytes: 2 } });
    assert.strictEqual(lo.status, 200);
    assert.strictEqual((await put(lo.json.id, 'a.txt', 'ok')).status, 200);
    assert.strictEqual((await call('POST', `/upload/${lo.json.id}/finish`, { body: {} })).status, 200);
    assert.strictEqual(fs.readFileSync(path.join(uroot, 'local', 'a.txt'), 'utf8'), 'ok');
    // the remote key cannot finish or delete a local upload
    const lo2 = await call('POST', '/upload/start', { body: { name: 'local2', files: 1, bytes: 2 } });
    assert.strictEqual((await call('DELETE', `/upload/${lo2.json.id}`, R)).status, 404);
    assert.strictEqual((await call('DELETE', `/upload/${lo2.json.id}`)).status, 204);

    // nothing but the expected folders exists under the upload root
    assert.deepStrictEqual(fs.readdirSync(uroot).sort(), ['.uploads', 'My Project_', 'local']);
  } finally {
    child.kill();
    await new Promise((res) => setTimeout(res, 300));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('safeRel: 8.3 aliases, superscript reserved names, streams, trailing dot/space', () => {
  const bad = ['PROGRA~1', 'a/PROGRA~1/b', 'x~12.txt', 'GIT~1/config', 'COM¹', 'com².txt', 'LPT³', 'dir/LPT¹.log', 'file.txt:stream', 'a:b/c', 'file::$DATA', 'a：b', 'a.', 'a ', 'dir./f'];
  for (const p of bad) assert.strictEqual(up.safeRel(p), null, JSON.stringify(p));
  for (const p of ['a~b', 'x~', 'COM⁰', 'readme~.md']) assert.strictEqual(up.safeRel(p), p, p);
});

test('classify: git always, config at any depth, NFKC and case folded', () => {
  for (const p of ['.git/config', 'a/.git/HEAD', '.git', 'sub/.git', '.GIT/x', '.gitmodules', 'a/.gitmodules', 'deep/.git/config', 'a/b/.git/config', '．git/config', 'a/．git/x', 'a/.GIT/x', '.git./x']) assert.strictEqual(up.classify(p), 'git', p);
  for (const p of ['.claude/settings.json', '.claude/hooks/x.sh', '.Claude/a', '.mcp.json', '.cursor/rules', '.vscode/tasks.json', '.husky/pre-commit', 'sub/.claude/settings.json', 'a/b/.mcp.json', 'x/.husky/pre-commit', 'a/.Claude/x', 'a/.MCP.JSON', '.MCP.JSON', 'a/.cursor/rules', 'a/b/.vscode/tasks.json', 'a/.VSCODE/Tasks.json', '．claude/x', 'a/．mcp.json']) assert.strictEqual(up.classify(p), 'config', p);
  for (const p of ['.vscode/settings.json', 'a/.vscode/settings.json', '.mcp.json/x', '.gitignore', '.github/ci.yml', 'README.md', 'a/b.txt']) assert.strictEqual(up.classify(p), null, p);
});

test('uploads: nested git and config refused, .git even with allowConfig', () => {
  const root = tmp('me-nc-');
  try {
    const u = up.createUploads({ root, statfs: null, limits: { perKey: 99, maxActive: 99 } });
    const gits = ['deep/.git/config', 'a/b/.git/config', '．git/config', 'a/．git/config', '.GIT/config', 'x/.GIT/config'];
    const cfgs = ['sub/.claude/settings.json', 'a/b/.mcp.json', 'x/.husky/pre-commit', 'a/.Claude/s.json', 'a/.MCP.JSON', 'a/.cursor/rules', 'a/b/.vscode/tasks.json'];
    for (const p of gits) for (const allowConfig of [false, true]) assert.throws(() => u.start('k', { name: 'x', files: 1, bytes: 1, paths: [p], allowConfig }), { status: 400, message: 'git data is not uploaded' }, p);
    for (const p of cfgs) {
      assert.throws(() => u.start('k', { name: 'x', files: 1, bytes: 1, paths: [p] }), { status: 400 }, p);
      assert.doesNotThrow(() => u.start('k', { name: 'x', files: 1, bytes: 1, paths: [p], allowConfig: true }), p);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('uploads: nested git and config refused on each PUT', async () => {
  const root = tmp('me-np-');
  try {
    const u = up.createUploads({ root, statfs: null, limits: { perKey: 99, maxActive: 99 } });
    const deny = u.start('k', { name: 'd', files: 20, bytes: 100 }), allow = u.start('k', { name: 'a', files: 20, bytes: 100, allowConfig: true });
    for (const p of ['deep/.git/config', '．git/config', 'a/.GIT/x']) for (const s of [deny, allow]) await assert.rejects(u.putFile(s.id, 'k', p, body('x')), { status: 400, message: 'git data is not uploaded' }, p);
    for (const p of ['sub/.claude/settings.json', 'a/b/.mcp.json', 'x/.husky/pre-commit', 'a/.MCP.JSON']) {
      await assert.rejects(u.putFile(deny.id, 'k', p, body('x')), { status: 400 }, p);
      await u.putFile(allow.id, 'k', p, body('x'));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('uploads: a failing copy fallback leaves no partial target, so a retry works', async () => {
  const root = tmp('me-cp-');
  const link = fs.linkSync, copy = fs.copyFileSync;
  try {
    const u = up.createUploads({ root, statfs: null });
    const a = u.start('k', { name: 'p', files: 1, bytes: 10 });
    fs.linkSync = () => { throw Object.assign(new Error('no links'), { code: 'EPERM' }); };
    fs.copyFileSync = (from, to) => { fs.writeFileSync(to, 'par'); throw Object.assign(new Error('disk'), { code: 'EIO' }); };
    await assert.rejects(u.putFile(a.id, 'k', 'a.txt', body('hello')), { status: 400 });
    fs.linkSync = link; fs.copyFileSync = copy;
    assert.ok(!fs.existsSync(path.join(root, a.name, 'a.txt')));
    await u.putFile(a.id, 'k', 'a.txt', body('hello'));
    assert.strictEqual(fs.readFileSync(path.join(root, a.name, 'a.txt'), 'utf8'), 'hello');
  } finally { fs.linkSync = link; fs.copyFileSync = copy; fs.rmSync(root, { recursive: true, force: true }); }
});

test('uploads: git data always refused, config only with allowConfig (start list and each PUT)', async () => {
  const root = tmp('me-cf-');
  const u = up.createUploads({ root, statfs: null, limits: { perKey: 9 } });
  try {
    assert.throws(() => u.start('k', { name: 'x', files: 1, bytes: 1, paths: ['.git/config'], allowConfig: true }), { status: 400, message: 'git data is not uploaded' });
    assert.throws(() => u.start('k', { name: 'x', files: 1, bytes: 1, paths: ['ok.txt', '.claude/settings.json'] }), { status: 400 });
    assert.throws(() => u.start('k', { name: 'x', files: 1, bytes: 1, paths: ['../x'] }), { status: 400 });
    assert.strictEqual(u.size(), 0);
    const a = u.start('k', { name: 'plain', files: 1, bytes: 20, paths: ['a.txt'] });
    for (const p of ['.git/config', 'sub/.git', '.gitmodules']) await assert.rejects(u.putFile(a.id, 'k', p, body('x')), { status: 400, message: 'git data is not uploaded' }, p);
    for (const p of ['.claude/settings.json', '.mcp.json', '.cursor/x', '.vscode/tasks.json', '.husky/pre-commit']) await assert.rejects(u.putFile(a.id, 'k', p, body('x')), { status: 400 }, p);
    assert.deepStrictEqual(listAll(path.join(root, a.name)), []);
    await u.putFile(a.id, 'k', 'a.txt', body('fine'));
    const b = u.start('k2', { name: 'cfg', files: 2, bytes: 20, paths: ['.claude/settings.json', 'b.txt'], allowConfig: true });
    await u.putFile(b.id, 'k2', '.claude/settings.json', body('{}'));
    await assert.rejects(u.putFile(b.id, 'k2', '.git/hooks/pre-commit', body('x')), { status: 400, message: 'git data is not uploaded' });
    await u.putFile(b.id, 'k2', 'b.txt', body('b'));
    assert.strictEqual(fs.readFileSync(path.join(root, b.name, '.claude', 'settings.json'), 'utf8'), '{}');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('uploads: finishing never overwrites (second PUT to a path is 409, first content intact)', async () => {
  const root = tmp('me-ow-');
  const u = up.createUploads({ root, statfs: null });
  try {
    const a = u.start('k', { name: 'p', files: 3, bytes: 100 });
    await u.putFile(a.id, 'k', 'x.txt', body('first'));
    await assert.rejects(u.putFile(a.id, 'k', 'x.txt', body('second')), { status: 409 });
    assert.strictEqual(fs.readFileSync(path.join(root, a.name, 'x.txt'), 'utf8'), 'first');
    // a file that appeared on disk behind the session's back is not replaced either
    fs.writeFileSync(path.join(root, a.name, 'planted.txt'), 'planted');
    await assert.rejects(u.putFile(a.id, 'k', 'planted.txt', body('evil')), { status: 409 });
    assert.strictEqual(fs.readFileSync(path.join(root, a.name, 'planted.txt'), 'utf8'), 'planted');
    assert.ok(listAll(path.join(root, a.name)).every((f) => !/\.part-/.test(f)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('uploads: global caps on active uploads and in-flight bytes, released on delete', () => {
  const root = tmp('me-gc-');
  try {
    const u = up.createUploads({ root, statfs: null, limits: { maxActive: 2, perKey: 9, maxInflight: 100 } });
    const a = u.start('a', { name: 'a', files: 1, bytes: 60 });
    assert.throws(() => u.start('b', { name: 'b', files: 1, bytes: 50 }), { status: 429, message: /at once/ });
    u.start('b', { name: 'b', files: 1, bytes: 40 });
    assert.throws(() => u.start('c', { name: 'c', files: 1, bytes: 0 }), { status: 429, message: /Too many uploads/ });
    u.remove(a.id, 'a');
    u.start('c', { name: 'c', files: 1, bytes: 60 });
    assert.strictEqual(u.size(), 2);
    assert.strictEqual(up.LIMITS.maxActive, 4);
    assert.strictEqual(up.LIMITS.maxInflight, 1024 * 1048576);
    assert.strictEqual(up.LIMITS.margin, 500 * 1048576);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('uploads: announced bytes are reserved against free disk space minus the margin', () => {
  const root = tmp('me-rb-');
  try {
    const u = up.createUploads({ root, statfs: () => ({ bavail: 100, bsize: 1 }), limits: { margin: 10, perKey: 9 } });
    const a = u.start('a', { name: 'a', files: 1, bytes: 50 });
    assert.throws(() => u.start('b', { name: 'b', files: 1, bytes: 50 }), { status: 507 });
    u.start('b', { name: 'b', files: 1, bytes: 40 });
    u.remove(a.id, 'a');
    u.start('c', { name: 'c', files: 1, bytes: 50 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('uploads: a PUT idle for 2 minutes is destroyed, its .part removed, and the file can be retried', async () => {
  const root = tmp('me-st-');
  let now = 1000;
  const u = up.createUploads({ root, now: () => now, statfs: null });
  try {
    const a = u.start('k', { name: 'p', files: 1, bytes: 100 });
    const stuck = new Readable({ read() {} });
    stuck.push('partial');
    const p = u.putFile(a.id, 'k', 'big.bin', stuck);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(listAll(path.join(root, a.name)).length, 1);
    now += 60e3; u.sweepStalls();
    assert.ok(!stuck.destroyed);
    now += 61e3; u.sweepStalls();
    await assert.rejects(p, { status: 408 });
    assert.deepStrictEqual(listAll(path.join(root, a.name)), []);
    await u.putFile(a.id, 'k', 'big.bin', body('again'));
    assert.strictEqual(fs.readFileSync(path.join(root, a.name, 'big.bin'), 'utf8'), 'again');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('uploads: user files named like temp files survive finish; startup sweep clears .uploads staging only', async () => {
  const root = tmp('me-lo-');
  try {
    const u = up.createUploads({ root, statfs: null });
    const a = u.start('k', { name: 'p', files: 1, bytes: 10 });
    await u.putFile(a.id, 'k', 'a.txt', body('x'));
    fs.mkdirSync(path.join(root, a.name, 'sub'));
    fs.writeFileSync(path.join(root, a.name, 'sub', '.part-0123456789ab'), 'mine');
    fs.writeFileSync(path.join(root, a.name, '.part-ba9876543210'), 'mine');
    const r = u.finish(a.id, 'k');
    assert.deepStrictEqual(listAll(r.dir).map((f) => path.relative(r.dir, f)).sort(), ['.part-ba9876543210', 'a.txt', path.join('sub', '.part-0123456789ab')]);

    const old = path.join(root, 'old'), stage = path.join(root, '.uploads', 'stage');
    fs.mkdirSync(old, { recursive: true }); fs.mkdirSync(stage, { recursive: true });
    const oldPart = path.join(old, '.part-aaaaaaaaaaaa'), stalePart = path.join(stage, '.part-bbbbbbbbbbbb'), freshPart = path.join(stage, '.part-cccccccccccc');
    for (const f of [oldPart, stalePart, freshPart]) fs.writeFileSync(f, 'x');
    const t = new Date(Date.now() - 2 * 3600e3);
    for (const f of [oldPart, stalePart]) fs.utimesSync(f, t, t);
    up.createUploads({ root, statfs: null }).cleanStale();
    assert.ok(fs.existsSync(oldPart));
    assert.ok(!fs.existsSync(stalePart));
    assert.ok(!fs.existsSync(freshPart));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
