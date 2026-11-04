// Portable self-update from the public GitHub repo. Pure logic: network, fs, node --check and npm are injected so tests need none of them.
// Contacts only api.github.com and codeload.github.com, sends no data and no credentials.
const nodeFs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const OWNER = 'doolecg', REPO = 'Model-Engine';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const HOSTS = ['api.github.com', 'codeload.github.com'];
const UA = 'model-engine-updater';
const LIMITS = { timeoutMs: 30000, maxBytes: 50 * 1024 * 1024, maxRedirects: 5, maxFiles: 5000, maxTotal: 100 * 1024 * 1024 };
const SELF = '.claude/live';
const VERSION_FILE = `${SELF}/.version.json`;
const NEEDED = [`${SELF}/server.js`, `${SELF}/package.json`];
const LOCK = `${SELF}/package-lock.json`;

// ---------------- versions ----------------
function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v == null ? '' : v).trim());
  return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] } : null;
}
// -1, 0, 1; null when either side is not a semver
function cmpSemver(a, b) {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
// installed: { version, ref, channel }; latest: { version, ref }. Never offers a downgrade.
function isAvailable(channel, installed, latest) {
  if (!latest) return false;
  if (channel === 'dev') return !(installed.channel === 'dev' && installed.ref === latest.ref);
  const have = installed.channel === 'stable' && parseSemver(installed.ref) ? installed.ref : installed.version;
  const c = cmpSemver(latest.ref, have);
  return c === null ? latest.ref !== installed.ref : c > 0;
}

// ---------------- network ----------------
function allowedUrl(u) {
  let x;
  try { x = new URL(u); } catch { return false; }
  return x.protocol === 'https:' && HOSTS.includes(x.hostname) && !x.username && !x.password && (x.port === '' || x.port === '443');
}
function fetchBuffer(url, o) {
  o = { get: https.get, ...LIMITS, accept: '*/*', ...o };
  return new Promise((resolve, reject) => {
    let settled = false, cur = null;
    const end = (er, val) => { if (settled) return; settled = true; clearTimeout(timer); if (cur) try { cur.destroy(); } catch {} er ? reject(er) : resolve(val); };
    const timer = setTimeout(() => end(new Error('timed out')), o.timeoutMs);
    const go = (u, hops) => {
      if (!allowedUrl(u)) return end(new Error('blocked url'));
      const req = o.get(u, { headers: { 'user-agent': UA, accept: o.accept } }, (res) => {
        const code = res.statusCode;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (hops >= o.maxRedirects) return end(new Error('too many redirects'));
          let next; try { next = new URL(res.headers.location, u).href; } catch { return end(new Error('bad redirect')); }
          return go(next, hops + 1);
        }
        if (code !== 200) { res.resume(); const er = new Error('http ' + code); er.status = code; return end(er); }
        if (Number(res.headers['content-length']) > o.maxBytes) { res.resume(); return end(new Error('response too large')); }
        const parts = []; let n = 0;
        res.on('data', (d) => { n += d.length; if (n > o.maxBytes) { try { res.destroy(); } catch {} return end(new Error('response too large')); } parts.push(d); });
        res.on('end', () => end(null, Buffer.concat(parts)));
        res.on('error', end);
      });
      cur = req;
      req.on('error', end);
    };
    go(url, 0);
  });
}
async function fetchJson(url, o) { return JSON.parse((await fetchBuffer(url, { ...o, accept: 'application/vnd.github+json', maxBytes: 2 * 1024 * 1024 })).toString('utf8')); }

// null = nothing published yet (404); throws on any other failure
async function checkLatest(channel, o) {
  try {
    if (channel === 'dev') {
      const j = await fetchJson(`${API}/commits/dev`, o);
      if (!j || !/^[0-9a-f]{40}$/.test(j.sha)) throw new Error('unexpected reply');
      return { channel, version: j.sha.slice(0, 7), ref: j.sha, notes: String((j.commit && j.commit.message) || '').slice(0, 400), url: String(j.html_url || ''), tarball: `${API}/tarball/dev` };
    }
    const j = await fetchJson(`${API}/releases/latest`, o);
    if (!j || !/^[\w.+-]{1,64}$/.test(j.tag_name) || typeof j.tarball_url !== 'string' || !j.tarball_url.startsWith(`${API}/tarball/`)) throw new Error('unexpected reply');
    return { channel, version: j.tag_name.replace(/^v/, ''), ref: j.tag_name, notes: String(j.body || '').slice(0, 400), url: String(j.html_url || ''), tarball: j.tarball_url };
  } catch (er) {
    if (er && er.status === 404) return null;
    throw er;
  }
}

// ---------------- tar ----------------
function tarErr(m) { return new Error('Unsafe or corrupt archive: ' + m); }
function cleanName(name, what) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw tarErr(`bad path in ${what}`);
  const segs = name.split('/').filter((s) => s !== '');
  if (segs.some((s) => s === '..' || s === '.' || s.includes(':'))) throw tarErr(`bad path in ${what}`);
  return segs;
}
function octal(b, what) {
  const s = b.toString('latin1').replace(/\0.*$/s, '').trim();
  if (b[0] & 0x80) throw tarErr('unsupported number format in ' + what);
  if (s && !/^[0-7]+$/.test(s)) throw tarErr('bad number in ' + what);
  return s ? parseInt(s, 8) : 0;
}
function paxPath(data) {
  let pos = 0, found = null;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos), len = parseInt(data.subarray(pos, sp).toString('latin1'), 10);
    if (sp < 0 || !(len > 0) || pos + len > data.length) throw tarErr('bad pax header');
    const rec = data.subarray(sp + 1, pos + len).toString('utf8').replace(/\n$/, ''), eq = rec.indexOf('=');
    const k = rec.slice(0, eq), v = rec.slice(eq + 1);
    if (k === 'path') found = v;
    else if (k === 'size' || k === 'linkpath') throw tarErr('unsupported pax field ' + k);
    pos += len;
  }
  return found;
}
// Returns [{ path, data, mode }] for regular files, top folder stripped. Anything but files and folders is refused.
function readTar(buf, o) {
  o = { ...LIMITS, ...o };
  const out = []; let pos = 0, total = 0, pax = null, seen = 0;
  while (pos + 512 <= buf.length) {
    const h = buf.subarray(pos, pos + 512);
    if (h.every((x) => x === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h.subarray(148, 156), 'checksum')) throw tarErr('checksum mismatch');
    const type = String.fromCharCode(h[156] || 48), size = octal(h.subarray(124, 136), 'size'), mode = octal(h.subarray(100, 108), 'mode');
    const ustar = h.subarray(257, 262).toString('latin1') === 'ustar';
    let name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = ustar ? h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '') : '';
    if (prefix) name = prefix + '/' + name;
    pos += 512;
    if (size > buf.length - pos) throw tarErr('truncated');
    const data = buf.subarray(pos, pos + size);
    pos += Math.ceil(size / 512) * 512;
    if (type === 'g') continue;
    if (type === 'x') { pax = paxPath(data); continue; }
    if (pax) { name = pax; pax = null; }
    if (type !== '0' && type !== '5') throw tarErr(`entry type "${type}" is not allowed`);
    if (++seen > o.maxFiles) throw tarErr('too many entries');
    const segs = cleanName(name, 'entry');
    if (type === '5') continue;
    if (segs.length < 2) throw tarErr('file outside the top folder');
    total += size;
    if (total > o.maxTotal) throw tarErr('too large when unpacked');
    out.push({ path: segs.slice(1).join('/'), data: Buffer.from(data), mode });
  }
  return out;
}
function unpack(gz, o) {
  o = { ...LIMITS, ...o };
  let tar;
  try { tar = zlib.gunzipSync(gz, { maxOutputLength: o.maxTotal + o.maxFiles * 1024 + 8192 }); } catch (er) { throw tarErr(er.code === 'ERR_BUFFER_TOO_LARGE' ? 'too large when unpacked' : 'not a gzip file'); }
  return readTar(tar, o);
}

// ---------------- what an update may replace ----------------
// Program files only. Everything else (projects.json, .env, workspace/, .update/, node_modules) is never in this list.
const PROGRAM_FILES = new Set(['CLAUDE.md', 'README.md', 'LICENSE', 'Dockerfile', 'docker-compose.yml', 'Model-Engine.cmd', 'model-engine.sh']);
function isProgramPath(rel) {
  if (rel === VERSION_FILE || rel === `${SELF}/projects.json` || rel === `${SELF}/node_modules` || rel.startsWith(`${SELF}/node_modules/`)) return false;
  return rel.startsWith('.claude/') || rel.startsWith('docs/') || PROGRAM_FILES.has(rel);
}

// ---------------- state and refusals ----------------
function readVersion(dir, fsx) {
  fsx = fsx || nodeFs;
  let version = '0.0.0', channel = null, ref = null;
  try { version = JSON.parse(fsx.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || version; } catch {}
  try { const j = JSON.parse(fsx.readFileSync(path.join(dir, '.version.json'), 'utf8')); if (j.channel === 'stable' || j.channel === 'dev') { channel = j.channel; ref = String(j.ref || '') || null; } } catch {}
  return { version, channel, ref };
}
// { kind: 'docker'|'git'|'busy', message } or null
function refusal(o) {
  const fsx = o.fs || nodeFs, env = o.env || process.env;
  if (env.MODEL_ENGINE_IN_DOCKER === '1' || fsx.existsSync('/.dockerenv')) return { kind: 'docker', message: 'Running in Docker. Rebuild the image to update.' };
  if (fsx.existsSync(path.join(o.root, '.git'))) return { kind: 'git', message: 'This folder is a git checkout. Use git pull to update.' };
  if (o.busy) return { kind: 'busy', message: 'A run is active. Wait for it to finish.' };
  return null;
}

// ---------------- apply and rollback ----------------
const safeName = (s) => String(s).replace(/[^\w.+-]/g, '_').slice(0, 64) || 'unknown';
const dirs = (root) => ({ tmp: path.join(root, '.update', 'tmp'), backup: path.join(root, '.update', 'backup') });
// Where a relative path lands inside the install; refuses anything that would end up outside it, symlinked folders included.
function dest(root, rel, fsx) {
  const full = path.resolve(root, ...rel.split('/'));
  if (!full.startsWith(root + path.sep)) throw new Error('path escapes the install folder: ' + rel);
  let p = path.dirname(full);
  while (!fsx.existsSync(p) && p !== root && p !== path.dirname(p)) p = path.dirname(p);
  const realRoot = fsx.realpathSync(root), real = fsx.realpathSync(p);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('path leaves the install folder: ' + rel);
  return full;
}
function defaultCheck(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return r.status === 0 ? { ok: true } : { ok: false, error: String(r.stderr || r.error || 'syntax error').split('\n').slice(0, 3).join(' ') };
}
function defaultNpm(args, cwd) {
  return new Promise((resolve, reject) => {
    const cli = [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((f) => nodeFs.existsSync(f));
    if (!cli && process.platform === 'win32') return reject(new Error('npm not found next to node'));
    const child = cli ? spawn(process.execPath, [cli, ...args], { cwd, stdio: 'ignore', windowsHide: true }) : spawn('npm', args, { cwd, stdio: 'ignore', windowsHide: true });
    const t = setTimeout(() => { try { child.kill(); } catch {} }, 5 * 60 * 1000);
    child.on('error', (er) => { clearTimeout(t); reject(er); });
    child.on('close', (c) => { clearTimeout(t); c === 0 ? resolve() : reject(new Error('npm ci failed (exit ' + c + ')')); });
  });
}
const NPM_ARGS = ['ci', '--omit=dev', '--ignore-scripts', '--prefix', '.claude/live'];

function rmrf(fsx, p) { try { fsx.rmSync(p, { recursive: true, force: true }); } catch {} }
// Puts back what the manifest says was replaced and removes what was created.
function restore(root, bdir, manifest, fsx) {
  for (const rel of manifest.replaced) {
    const to = dest(root, rel, fsx);
    fsx.mkdirSync(path.dirname(to), { recursive: true });
    fsx.copyFileSync(path.join(bdir, 'files', ...rel.split('/')), to);
  }
  for (const rel of manifest.created) rmrf(fsx, dest(root, rel, fsx));
}

async function applyUpdate(o) {
  const fsx = o.fs || nodeFs, root = path.resolve(o.root), d = dirs(root), check = o.check || defaultCheck, runNpm = o.runNpm || defaultNpm;
  const why = refusal({ root, fs: fsx, env: o.env, busy: o.busy });
  if (why) throw new Error(why.message);
  const latest = o.latest, channel = o.channel === 'dev' ? 'dev' : 'stable';
  if (!latest || !allowedUrl(latest.tarball)) throw new Error('No update to install.');
  const prog = (m) => { if (o.onProgress) o.onProgress(m); };
  rmrf(fsx, d.tmp);
  fsx.mkdirSync(path.join(d.tmp, 'new'), { recursive: true });
  let bdir = null, manifest = null, touched = false;
  try {
    prog('Downloading');
    const gz = await fetchBuffer(latest.tarball, { get: o.get, timeoutMs: o.timeoutMs, maxBytes: o.maxBytes });
    fsx.writeFileSync(path.join(d.tmp, 'update.tgz'), gz);
    prog('Checking the download');
    const entries = unpack(gz, o.limits).filter((e) => isProgramPath(e.path));
    const have = new Set(entries.map((e) => e.path));
    for (const n of NEEDED) if (!have.has(n)) throw new Error('The download is missing ' + n);
    for (const e of entries) {
      const to = dest(path.join(d.tmp, 'new'), e.path, fsx);
      fsx.mkdirSync(path.dirname(to), { recursive: true });
      fsx.writeFileSync(to, e.data);
    }
    let newVersion = 'unknown';
    try { newVersion = JSON.parse(entries.find((e) => e.path === `${SELF}/package.json`).data.toString('utf8')).version || newVersion; } catch { throw new Error('The download has an unreadable package.json'); }
    for (const f of [`${SELF}/server.js`, `${SELF}/updater.js`]) {
      if (!have.has(f)) continue;
      const r = check(path.join(d.tmp, 'new', ...f.split('/')));
      if (!r.ok) throw new Error(`${f} failed node --check: ${r.error || ''}`.trim());
    }

    prog('Backing up');
    const old = o.installed || readVersion(path.join(root, ...SELF.split('/')), fsx);
    const oldLock = (() => { try { return fsx.readFileSync(dest(root, LOCK, fsx)); } catch { return null; } })();
    const newLock = entries.find((e) => e.path === LOCK);
    const lockChanged = !!newLock && (!oldLock || !oldLock.equals(newLock.data));
    const versionData = Buffer.from(JSON.stringify({ channel, ref: latest.ref }));
    const all = [...entries.map((e) => ({ rel: e.path, data: e.data, mode: e.mode })), { rel: VERSION_FILE, data: versionData, mode: 0o644 }];
    manifest = { version: old.version, channel: old.channel, ref: old.ref, replaced: [], created: [], npm: lockChanged, at: Date.now() };
    for (const f of all) {
      const to = dest(root, f.rel, fsx);
      let st = null; try { st = fsx.lstatSync(to); } catch {}
      if (st && !st.isFile()) throw new Error('Not a plain file, will not replace: ' + f.rel);
      (st ? manifest.replaced : manifest.created).push(f.rel);
    }
    fsx.mkdirSync(d.backup, { recursive: true });
    bdir = path.join(d.backup, safeName(old.version));
    rmrf(fsx, bdir);
    for (const rel of manifest.replaced) {
      const to = path.join(bdir, 'files', ...rel.split('/'));
      fsx.mkdirSync(path.dirname(to), { recursive: true });
      fsx.copyFileSync(dest(root, rel, fsx), to);
    }
    fsx.writeFileSync(path.join(bdir, 'manifest.json'), JSON.stringify(manifest));

    prog('Installing');
    touched = true;
    for (const f of all.filter((x) => x.rel !== VERSION_FILE)) {
      const to = dest(root, f.rel, fsx);
      fsx.mkdirSync(path.dirname(to), { recursive: true });
      fsx.writeFileSync(to, f.data);
      try { fsx.chmodSync(to, f.mode & 0o755 || 0o644); } catch {}
    }
    if (lockChanged) { prog('Installing dependencies'); await runNpm(NPM_ARGS, root); }
    fsx.writeFileSync(dest(root, VERSION_FILE, fsx), versionData);
    for (const n of fsx.readdirSync(d.backup)) if (n !== path.basename(bdir)) rmrf(fsx, path.join(d.backup, n));
    return { ok: true, from: old.version, to: newVersion, ref: latest.ref };
  } catch (er) {
    let msg = (er && er.message) || String(er);
    if (touched && manifest) {
      try {
        restore(root, bdir, manifest, fsx);
        rmrf(fsx, bdir);
        msg += ' (previous version restored)';
        if (manifest.npm) { try { await runNpm(NPM_ARGS, root); } catch {} }
      } catch (er2) { msg += ' (restore failed: ' + er2.message + '; copy the files from ' + bdir + ' by hand)'; }
    } else if (bdir) rmrf(fsx, bdir);
    throw new Error(msg);
  } finally {
    rmrf(fsx, d.tmp);
  }
}

function backupInfo(root, fsx) {
  fsx = fsx || nodeFs;
  const b = dirs(path.resolve(root)).backup;
  try {
    for (const n of fsx.readdirSync(b)) {
      const manifest = JSON.parse(fsx.readFileSync(path.join(b, n, 'manifest.json'), 'utf8'));
      if (Array.isArray(manifest.replaced) && Array.isArray(manifest.created)) return { dir: path.join(b, n), manifest };
    }
  } catch {}
  return null;
}

async function rollback(o) {
  const fsx = o.fs || nodeFs, root = path.resolve(o.root), runNpm = o.runNpm || defaultNpm;
  const why = refusal({ root, fs: fsx, env: o.env, busy: o.busy });
  if (why) throw new Error(why.message);
  const b = backupInfo(root, fsx);
  if (!b) throw new Error('There is no backup to roll back to.');
  const cur = (() => { try { return fsx.readFileSync(dest(root, LOCK, fsx)); } catch { return null; } })();
  const was = (() => { try { return fsx.readFileSync(path.join(b.dir, 'files', ...LOCK.split('/'))); } catch { return null; } })();
  restore(root, b.dir, b.manifest, fsx);
  if (was && cur && !was.equals(cur)) await runNpm(NPM_ARGS, root);
  rmrf(fsx, b.dir);
  return { ok: true, to: b.manifest.version };
}

// New server process, same env, no console window. The caller exits the old one after its reply is sent.
function respawn(o) {
  const sp = o.spawn || spawn;
  const child = sp(process.execPath, [path.join(o.root, ...SELF.split('/'), 'server.js')], { cwd: o.root, env: { ...(o.env || process.env), MODEL_ENGINE_RESTART: '1' }, stdio: 'ignore', detached: true, windowsHide: true });
  child.unref();
  return child;
}

module.exports = { OWNER, REPO, HOSTS, LIMITS, VERSION_FILE, parseSemver, cmpSemver, isAvailable, allowedUrl, fetchBuffer, checkLatest, readTar, unpack, isProgramPath, readVersion, refusal, applyUpdate, rollback, backupInfo, respawn };
