const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const U = require('./updater.js');

// never let a test depend on running inside Docker
const tfs = { ...fs, existsSync: (p) => (p === '/.dockerenv' ? false : fs.existsSync(p)) };
const ENV = {};

// ---------- helpers ----------
function header(name, { type = '0', size = 0, mode = 0o644, link = '', prefix = '' } = {}) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156); h.write(link, 157, 100);
  h.write('ustar\0' + '00', 257);
  if (prefix) h.write(prefix, 345, 155);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
function tar(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.from(e.data == null ? '' : e.data);
    parts.push(header(e.name, { type: e.type, size: e.type === '5' || e.link ? 0 : data.length, mode: e.mode, link: e.link, prefix: e.prefix }));
    if (e.type !== '5' && !e.link) { parts.push(data); parts.push(Buffer.alloc((512 - (data.length % 512)) % 512)); }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
const gz = (entries) => zlib.gzipSync(tar(entries));
const TOP = 'doolecg-Model-Engine-abc1234/';
const f = (rel, data, extra) => ({ name: TOP + rel, data, ...extra });

function fakeGet(routes, log) {
  return (url, opts, cb) => {
    if (log) log.push({ url, opts });
    const req = new EventEmitter();
    req.destroy = () => {};
    const r = routes[url];
    if (r === 'hang') return req;
    process.nextTick(() => {
      if (!r) { const res = Readable.from([]); res.statusCode = 404; res.headers = {}; return cb(res); }
      const res = Readable.from(r.body === undefined ? [] : [Buffer.from(r.body)]);
      res.statusCode = r.status || 200; res.headers = r.headers || {};
      cb(res);
    });
    return req;
  };
}
const TMPS = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'me-upd-')); TMPS.push(d); return d; }
test.after(() => { for (const d of TMPS) fs.rmSync(d, { recursive: true, force: true }); });

const OK_JS = '// ok\nmodule.exports = 1;\n';
function install() {
  const root = tmp();
  const w = (rel, data) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
  w('.claude/live/server.js', '// old server\n');
  w('.claude/live/updater.js', '// old updater\n');
  w('.claude/live/package.json', JSON.stringify({ version: '0.1.0' }));
  w('.claude/live/package-lock.json', 'lock1');
  w('.claude/live/projects.json', 'USER PROJECTS');
  w('.claude/live/node_modules/x/index.js', 'USER MODULE');
  w('.claude/live/.version.json', JSON.stringify({ channel: 'stable', ref: 'v0.1.0' }));
  w('.env', 'SECRET=1');
  w('workspace/a.txt', 'MY WORK');
  w('README.md', 'old readme');
  return root;
}
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
function snapshot(root) {
  const out = {};
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(root, p)] = fs.readFileSync(p, 'utf8'); } })(root);
  return out;
}
function release(extra, over) {
  return gz([
    { name: TOP, type: '5' },
    f('.claude/live/server.js', OK_JS), f('.claude/live/updater.js', OK_JS),
    f('.claude/live/package.json', JSON.stringify({ version: '0.2.0' })), f('.claude/live/package-lock.json', over && over.lock || 'lock1'),
    f('.claude/live/projects.json', 'EVIL'), f('.claude/live/node_modules/x/index.js', 'EVIL'),
    f('.env', 'EVIL'), f('workspace/a.txt', 'EVIL'), f('.update/x', 'EVIL'), f('random.txt', 'EVIL'),
    f('README.md', 'new readme'), f('docs/new.md', 'new doc'), f('model-engine.sh', '#!/bin/sh\n', { mode: 0o755 }),
    ...(extra || []),
  ]);
}
const TARBALL = 'https://api.github.com/repos/doolecg/Model-Engine/tarball/v0.2.0';
const LATEST = { channel: 'stable', version: '0.2.0', ref: 'v0.2.0', tarball: TARBALL };
const route = (buf) => ({ [TARBALL]: { status: 200, body: buf } });

// ---------- versions ----------
test('semver compare', () => {
  assert.strictEqual(U.cmpSemver('1.2.3', '1.2.3'), 0);
  assert.strictEqual(U.cmpSemver('v1.10.0', '1.9.9'), 1);
  assert.strictEqual(U.cmpSemver('0.9.9', '1.0.0'), -1);
  assert.strictEqual(U.cmpSemver('1.0.0-rc.1', '1.0.0'), -1);
  assert.strictEqual(U.cmpSemver('1.0.0-rc.2', '1.0.0-rc.10'), -1);
  assert.strictEqual(U.cmpSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.strictEqual(U.cmpSemver('1.0.0+build', '1.0.0'), 0);
  assert.strictEqual(U.cmpSemver('main', '1.0.0'), null);
});

test('channel decisions', () => {
  const inst = (version, channel, ref) => ({ version, channel, ref });
  assert.strictEqual(U.isAvailable('stable', inst('0.1.0', 'stable', 'v0.1.0'), { ref: 'v0.2.0' }), true);
  assert.strictEqual(U.isAvailable('stable', inst('0.2.0', 'stable', 'v0.2.0'), { ref: 'v0.2.0' }), false);
  assert.strictEqual(U.isAvailable('stable', inst('0.3.0', 'stable', 'v0.3.0'), { ref: 'v0.2.0' }), false, 'never downgrades');
  assert.strictEqual(U.isAvailable('stable', inst('0.5.0', 'dev', 'a'.repeat(40)), { ref: 'v0.2.0' }), false, 'dev build newer than the release');
  assert.strictEqual(U.isAvailable('stable', inst('0.1.0', null, null), { ref: 'v0.2.0' }), true, 'fresh install uses package.json');
  assert.strictEqual(U.isAvailable('stable', inst('0.1.0', 'stable', 'v0.1.0'), null), false);
  const sha = 'a'.repeat(40), sha2 = 'b'.repeat(40);
  assert.strictEqual(U.isAvailable('dev', inst('0.1.0', 'dev', sha), { ref: sha }), false);
  assert.strictEqual(U.isAvailable('dev', inst('0.1.0', 'dev', sha), { ref: sha2 }), true);
  assert.strictEqual(U.isAvailable('dev', inst('0.1.0', 'stable', 'v0.1.0'), { ref: sha }), true);
});

test('checkLatest: stable, dev, nothing yet, and failures', async () => {
  const A = 'https://api.github.com/repos/doolecg/Model-Engine';
  const sha = 'c'.repeat(40);
  const get = fakeGet({
    [A + '/releases/latest']: { body: JSON.stringify({ tag_name: 'v1.2.3', tarball_url: A + '/tarball/v1.2.3', body: 'x'.repeat(900), html_url: 'https://github.com/doolecg/Model-Engine/releases/tag/v1.2.3' }) },
    [A + '/commits/dev']: { body: JSON.stringify({ sha, commit: { message: 'fix things' }, html_url: 'u' }) },
  });
  const s = await U.checkLatest('stable', { get });
  assert.deepStrictEqual([s.version, s.ref, s.notes.length], ['1.2.3', 'v1.2.3', 400]);
  const d = await U.checkLatest('dev', { get });
  assert.deepStrictEqual([d.ref, d.version, d.tarball, d.notes], [sha, sha.slice(0, 7), A + '/tarball/dev', 'fix things']);
  assert.strictEqual(await U.checkLatest('stable', { get: fakeGet({}) }), null, '404 means no release yet');
  await assert.rejects(U.checkLatest('stable', { get: fakeGet({ [A + '/releases/latest']: { status: 403 } }) }), /403/);
  await assert.rejects(U.checkLatest('stable', { get: fakeGet({ [A + '/releases/latest']: { body: JSON.stringify({ tag_name: 'v1', tarball_url: 'https://evil.example/t' }) } }) }), /unexpected/);
  await assert.rejects(U.checkLatest('stable', { get: fakeGet({ [A + '/releases/latest']: { body: 'not json' } }) }));
});

// ---------- network rules ----------
test('url allow-list: https, two hosts, no credentials, standard port', () => {
  assert.ok(U.allowedUrl('https://api.github.com/repos/doolecg/Model-Engine/tarball/dev'));
  assert.ok(U.allowedUrl('https://codeload.github.com/doolecg/Model-Engine/legacy.tar.gz/refs/tags/v1'));
  for (const bad of ['http://api.github.com/x', 'https://github.com/x', 'https://evil.example/x', 'https://api.github.com.evil.example/x', 'https://u:p@api.github.com/x', 'https://api.github.com:8443/x', 'ftp://api.github.com/x', 'nope']) assert.strictEqual(U.allowedUrl(bad), false, bad);
});

test('redirects: allowed host followed, other host and http refused, loop capped; headers carry nothing identifying', async () => {
  const log = [];
  const A = 'https://api.github.com/a', C = 'https://codeload.github.com/b';
  const ok = await U.fetchBuffer(A, { get: fakeGet({ [A]: { status: 302, headers: { location: C } }, [C]: { body: 'data' } }, log) });
  assert.strictEqual(ok.toString(), 'data');
  assert.deepStrictEqual(Object.keys(log[0].opts.headers).sort(), ['accept', 'user-agent']);
  assert.strictEqual(log[0].opts.headers['user-agent'], 'model-engine-updater');
  await assert.rejects(U.fetchBuffer(A, { get: fakeGet({ [A]: { status: 302, headers: { location: 'https://evil.example/x' } } }) }), /blocked/);
  await assert.rejects(U.fetchBuffer(A, { get: fakeGet({ [A]: { status: 302, headers: { location: 'http://codeload.github.com/x' } } }) }), /blocked/);
  await assert.rejects(U.fetchBuffer(A, { get: fakeGet({ [A]: { status: 302, headers: { location: A } } }) }), /redirects/);
  await assert.rejects(U.fetchBuffer('https://evil.example/x', { get: fakeGet({}) }), /blocked/);
});

test('size cap and timeout', async () => {
  const A = 'https://api.github.com/a';
  await assert.rejects(U.fetchBuffer(A, { maxBytes: 10, get: fakeGet({ [A]: { body: 'x'.repeat(50) } }) }), /too large/);
  await assert.rejects(U.fetchBuffer(A, { maxBytes: 10, get: fakeGet({ [A]: { body: 'x', headers: { 'content-length': '999' } } }) }), /too large/);
  await assert.rejects(U.fetchBuffer(A, { timeoutMs: 30, get: fakeGet({ [A]: 'hang' }) }), /timed out/);
  assert.strictEqual(U.LIMITS.maxBytes, 50 * 1024 * 1024);
  assert.strictEqual(U.LIMITS.timeoutMs, 30000);
});

// ---------- tar reader ----------
test('tar reader: reads files and strips the top folder; pax paths and ustar prefix work', () => {
  const rec = `path=${TOP}deep/long.txt
`;
  let n = rec.length + 2; while (String(n).length + 1 + rec.length > n) n++;
  const px = Buffer.from(`${n} ${rec}`);
  const buf = Buffer.concat([header('pax', { type: 'x', size: px.length }), px, Buffer.alloc(512 - px.length), header('ignored'), tar([f('a.txt', 'A'), { name: 'b.txt', prefix: TOP.slice(0, -1), data: 'B' }])]);
  const got = U.readTar(buf).map((e) => [e.path, e.data.toString()]);
  assert.deepStrictEqual(got, [['deep/long.txt', ''], ['a.txt', 'A'], ['b.txt', 'B']]);
});

test('tar reader rejects .., absolute paths, drive letters, backslashes', () => {
  for (const name of [TOP + '../evil', '../evil', '/etc/passwd', 'C:/x/y', TOP + 'a\\b', TOP + 'a/../../b', TOP + 'a:stream']) {
    assert.throws(() => U.readTar(tar([{ name, data: 'x' }])), /Unsafe or corrupt/, name);
  }
});

test('tar reader rejects symlinks, hardlinks, devices, fifos', () => {
  for (const type of ['2', '1', '3', '4', '6']) {
    assert.throws(() => U.readTar(tar([{ name: TOP + 'l', type, link: 'x' }])), /not allowed/, 'type ' + type);
  }
});

test('tar reader enforces size and count caps and rejects corrupt data', () => {
  assert.throws(() => U.readTar(tar([f('a', 'x'.repeat(100)), f('b', 'x'.repeat(100))]), { maxTotal: 150 }), /too large/);
  assert.throws(() => U.readTar(tar([f('a', 'x'), f('b', 'x'), f('c', 'x')]), { maxFiles: 2 }), /too many/);
  const good = tar([f('a', 'hello')]);
  const bad = Buffer.from(good); bad[10] ^= 0xff;
  assert.throws(() => U.readTar(bad), /checksum/);
  assert.throws(() => U.readTar(good.subarray(0, 514)), /truncated/);
  assert.throws(() => U.unpack(Buffer.from('this is not gzip')), /not a gzip/);
  assert.throws(() => U.unpack(zlib.gzipSync(Buffer.alloc(5000, 1)), { maxTotal: 100, maxFiles: 1 }), /too large|Unsafe/, 'gzip bomb capped');
});

test('program paths: only program files, never user data', () => {
  for (const p of ['.claude/live/server.js', '.claude/agents/x.md', '.claude/skills/a/SKILL.md', 'CLAUDE.md', 'README.md', 'LICENSE', 'Dockerfile', 'docker-compose.yml', 'Model-Engine.cmd', 'model-engine.sh', 'docs/images/a.png']) assert.ok(U.isProgramPath(p), p);
  for (const p of ['.claude/live/projects.json', '.claude/live/node_modules/x/y.js', '.env', 'workspace/a', '.update/tmp/x', '.git/config', 'random.txt', '.gitignore', '.claude/live/.version.json']) assert.strictEqual(U.isProgramPath(p), false, p);
});

// ---------- apply ----------
test('apply replaces program files, keeps user data, backs up, records the version', async () => {
  const root = install(), before = snapshot(root), steps = [], npm = [];
  const r = await U.applyUpdate({ root, fs: tfs, env: ENV, latest: LATEST, channel: 'stable', get: fakeGet(route(release())), runNpm: async (a) => npm.push(a), onProgress: (m) => steps.push(m) });
  assert.deepStrictEqual([r.ok, r.from, r.to, r.ref], [true, '0.1.0', '0.2.0', 'v0.2.0']);
  assert.strictEqual(read(root, '.claude/live/server.js'), OK_JS);
  assert.strictEqual(read(root, 'README.md'), 'new readme');
  assert.strictEqual(read(root, 'docs/new.md'), 'new doc');
  assert.strictEqual(read(root, 'model-engine.sh'), '#!/bin/sh\n');
  assert.strictEqual(read(root, '.claude/live/projects.json'), 'USER PROJECTS');
  assert.strictEqual(read(root, '.claude/live/node_modules/x/index.js'), 'USER MODULE');
  assert.strictEqual(read(root, '.env'), 'SECRET=1');
  assert.strictEqual(read(root, 'workspace/a.txt'), 'MY WORK');
  assert.ok(!fs.existsSync(path.join(root, 'random.txt')));
  assert.ok(!fs.existsSync(path.join(root, '.update', 'x')));
  assert.deepStrictEqual(JSON.parse(read(root, '.claude/live/.version.json')), { channel: 'stable', ref: 'v0.2.0' });
  assert.deepStrictEqual(npm, [], 'lock unchanged: npm skipped');
  assert.strictEqual(read(root, '.update/backup/0.1.0/files/README.md'), 'old readme');
  assert.ok(!fs.existsSync(path.join(root, '.update', 'tmp')), 'temp dir cleaned');
  assert.ok(steps.includes('Downloading'));
  assert.ok(U.backupInfo(root, tfs));
  assert.notDeepStrictEqual(snapshot(root), before);
});

test('apply runs npm ci with an args array only when the lockfile changed', async () => {
  const root = install(), npm = [];
  await U.applyUpdate({ root, fs: tfs, env: ENV, latest: LATEST, channel: 'stable', get: fakeGet(route(release(null, { lock: 'lock2' }))), runNpm: async (a, cwd) => npm.push([a, cwd]) });
  assert.deepStrictEqual(npm, [[['ci', '--omit=dev', '--ignore-scripts', '--prefix', '.claude/live'], path.resolve(root)]]);
});

test('apply keeps only the latest backup', async () => {
  const root = install();
  fs.mkdirSync(path.join(root, '.update', 'backup', '0.0.1'), { recursive: true });
  fs.writeFileSync(path.join(root, '.update', 'backup', '0.0.1', 'manifest.json'), '{}');
  await U.applyUpdate({ root, fs: tfs, env: ENV, latest: LATEST, channel: 'stable', get: fakeGet(route(release())) });
  assert.deepStrictEqual(fs.readdirSync(path.join(root, '.update', 'backup')), ['0.1.0']);
});

test('a corrupt archive leaves the install untouched', async () => {
  const root = install(), before = snapshot(root);
  for (const buf of [Buffer.from('garbage'), release().subarray(0, 200), zlib.gzipSync(Buffer.from('x'.repeat(2000)))]) {
    await assert.rejects(U.applyUpdate({ root, fs: tfs, env: ENV, latest: LATEST, channel: 'stable', get: fakeGet(route(buf)) }));
    assert.deepStrictEqual(snapshot(root), before);
    assert.ok(!fs.existsSync(path.join(root, '.update', 'backup')));
  }
});

test('an archive with a bad entry or without server.js leaves the install untouched', async () => {
  const root = install(), before = snapshot(root);
  const evil = gz([f('.claude/live/server.js', OK_JS), f('.claude/live/package.json', '{}'), { name: TOP + '../../evil.txt', data: 'x' }]);
  await assert.rejects(U.applyUpdate({ root, fs: tfs, env: ENV, latest: LATEST, channel: 'stable', get: fakeGet(route(evil)) }), /Unsafe/);
  const link = gz([f('.claude/live/server.js', OK_JS), f('.claude/live/package.json', '{}'), { name: TOP + 'docs/l', type: '2', link: '/etc/passwd' }]);
  await assert.rejects(U.applyUpdate({ root, fs: tfs, env: ENV, latest: LATEST, channel: 'stable', get: fakeGet(route(link)) }), /not allowed/);
  const missing = gz([f('README.md', 'x'), f('.claude/live/package.json', '{}')]);
  await assert.rejects(U.applyUpdate({ root, fs: tfs, env: ENV, latest: LATEST, channel: 'stable', get: fakeGet(route(missing)) }), /missing/);
  assert.deepStrictEqual(snapshot(root), before);
});

test('a failing node --check leaves the install untouched', async () => {
  const root = install(), before = snapshot(root);
  const broken = gz([f('.claude/live/server.js', 'function ('), f('.claude/live/package.json', '{"version":"9.9.9"}'), f('README.md', 'x')]);
  await assert.rejects(U.applyUpdate({ root, fs: tfs, env: ENV, latest: LATEST, channel: 'stable', get: fakeGet(route(broken)) }), /node --check/);
  assert.deepStrictEqual(snapshot(root), before);
  assert.ok(!fs.existsSync(path.join(root, '.update', 'backup')));
});

test('a failure after files were written restores everything from the backup', async () => {
  const root = install(), before = snapshot(root), calls = [];
  const extra = [f('docs/created-by-update.md', 'new')];
  await assert.rejects(U.applyUpdate({ root, fs: tfs, env: ENV, latest: LATEST, channel: 'stable', get: fakeGet(route(release(extra, { lock: 'lock2' }))), runNpm: async (a) => { calls.push(a); throw new Error('npm exploded'); } }), /npm exploded.*restored/);
  assert.deepStrictEqual(snapshot(root), before, 'every file back, created files gone');
  assert.strictEqual(calls.length, 2, 'dependencies reinstalled for the old lockfile');
});

test('refuses in Docker, in a git checkout, and while busy', async () => {
  const get = fakeGet(route(release()));
  const base = { fs: tfs, latest: LATEST, channel: 'stable', get };
  let root = install(), before = snapshot(root);
  await assert.rejects(U.applyUpdate({ ...base, root, env: { MODEL_ENGINE_IN_DOCKER: '1' } }), /Docker.*rebuild/i);
  await assert.rejects(U.applyUpdate({ ...base, root, env: ENV, fs: { ...fs, existsSync: (p) => p === '/.dockerenv' || fs.existsSync(p) } }), /Docker/);
  await assert.rejects(U.applyUpdate({ ...base, root, env: ENV, busy: true }), /run is active/);
  fs.mkdirSync(path.join(root, '.git'));
  await assert.rejects(U.applyUpdate({ ...base, root, env: ENV }), /git pull/);
  fs.rmdirSync(path.join(root, '.git'));
  assert.deepStrictEqual(snapshot(root), before);
  assert.strictEqual(U.refusal({ root, fs: tfs, env: ENV }), null);
  assert.strictEqual(U.refusal({ root, fs: tfs, env: ENV, busy: true }).kind, 'busy');
  await assert.rejects(U.rollback({ root, fs: tfs, env: { MODEL_ENGINE_IN_DOCKER: '1' } }), /Docker/);
});

test('apply refuses a tarball url outside the allow-list', async () => {
  const root = install();
  await assert.rejects(U.applyUpdate({ root, fs: tfs, env: ENV, channel: 'stable', latest: { ...LATEST, tarball: 'https://evil.example/t.tgz' }, get: fakeGet({}) }), /No update/);
});

// ---------- rollback ----------
test('rollback restores the previous version, removes created files, then drops the backup', async () => {
  const root = install(), before = snapshot(root);
  await U.applyUpdate({ root, fs: tfs, env: ENV, latest: LATEST, channel: 'stable', get: fakeGet(route(release())) });
  assert.strictEqual(read(root, 'README.md'), 'new readme');
  const r = await U.rollback({ root, fs: tfs, env: ENV, runNpm: async () => { throw new Error('npm should not run'); } });
  assert.deepStrictEqual([r.ok, r.to], [true, '0.1.0']);
  const after = snapshot(root);
  for (const k of Object.keys(after)) if (k.startsWith('.update')) delete after[k];
  assert.deepStrictEqual(after, before);
  assert.strictEqual(U.backupInfo(root, tfs), null);
  await assert.rejects(U.rollback({ root, fs: tfs, env: ENV }), /no backup/i);
});

test('rollback reinstalls dependencies when the lockfile differs', async () => {
  const root = install(), npm = [];
  await U.applyUpdate({ root, fs: tfs, env: ENV, latest: LATEST, channel: 'stable', get: fakeGet(route(release(null, { lock: 'lock2' }))), runNpm: async () => {} });
  await U.rollback({ root, fs: tfs, env: ENV, runNpm: async (a) => npm.push(a) });
  assert.strictEqual(npm.length, 1);
  assert.strictEqual(read(root, '.claude/live/package-lock.json'), 'lock1');
});

// ---------- restart ----------
test('respawn starts a detached hidden server with the same env and no --open', () => {
  const calls = []; let unref = false;
  U.respawn({ root: '/r', env: { A: '1' }, spawn: (cmd, args, o) => { calls.push([cmd, args, o]); return { unref: () => { unref = true; } }; } });
  const [cmd, args, o] = calls[0];
  assert.strictEqual(cmd, process.execPath);
  assert.deepStrictEqual(args, [path.join('/r', '.claude', 'live', 'server.js')]);
  assert.deepStrictEqual([o.detached, o.stdio, o.windowsHide, o.env.A, o.env.MODEL_ENGINE_RESTART], [true, 'ignore', true, '1', '1']);
  assert.ok(unref);
});
