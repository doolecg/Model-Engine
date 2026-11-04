// Folder upload from another device. Pure logic, no HTTP: server.js wires it to the routes.
// Files land only under one upload root, in a folder this module creates. Nothing is executed, no links are followed or made. Git data is never stored; project config only on request.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform, pipeline } = require('stream');

const LIMITS = { maxFiles: 2000, maxFile: 25 * 1048576, maxTotal: 300 * 1048576, maxDepth: 20, maxName: 200, idleMs: 30 * 60e3, perKey: 2, maxActive: 4, margin: 500 * 1048576, maxInflight: 1024 * 1048576, stallMs: 120e3 };
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MARKERS = '.uploads';

const fail = (status, message) => Object.assign(new Error(message), { status });

// A relative path from the client, or null when anything about it is unsafe. Result uses '/' only.
function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 4096) return null;
  if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return null;
  const segs = rel.split('/');
  if (segs.length > LIMITS.maxDepth) return null;
  for (const s of segs) {
    if (!s || s === '.' || s === '..' || s.length > LIMITS.maxName) return null;
    const n = s.normalize('NFKC');
    if (/[\x00-\x1f<>:"|?*]/.test(s) || /[\x00-\x1f<>:"|?*]/.test(n) || /[. ]$/.test(s) || /[. ]$/.test(n)) return null;
    if (/~\d/.test(n)) return null;
    if (RESERVED.test(n.toLowerCase().split('.')[0].trim())) return null;
  }
  return segs.join('/');
}

// 'git' (never uploaded), 'config' (project config that can run commands; only with allowConfig) or null. rel must pass safeRel.
// Applies at any depth, to each segment as given and after NFKC, lower-cased, trailing dots/spaces stripped.
function classify(rel) {
  const segs = rel.split('/').map((s) => [s.toLowerCase(), s.normalize('NFKC').toLowerCase().replace(/[. ]+$/, '')]);
  const any = (i, names) => segs[i].some((v) => names.includes(v));
  const last = segs.length - 1;
  if (segs.some((_, i) => any(i, ['.git'])) || any(last, ['.gitmodules'])) return 'git';
  for (let i = 0; i <= last; i++) {
    if (any(i, ['.claude', '.cursor', '.husky'])) return 'config';
    if (i === last && any(i, ['.mcp.json'])) return 'config';
    if (i === last - 1 && any(i, ['.vscode']) && any(i + 1, ['tasks.json'])) return 'config';
  }
  return null;
}

// create `to` only if it does not exist (hard link, else exclusive copy), then drop `from`
function moveNew(from, to) {
  try { fs.linkSync(from, to); } catch (er) {
    if (er.code === 'EEXIST') throw fail(409, 'duplicate path');
    try { fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); } catch (e2) {
      if (e2.code === 'EEXIST') throw fail(409, 'duplicate path');
      try { fs.unlinkSync(to); } catch {} // the exclusive copy created `to`, so a partial one is ours to remove
      throw e2;
    }
  }
  try { fs.unlinkSync(from); } catch {}
}

// Folder name as a project name: [A-Za-z0-9 ._-], no leading dot, trimmed, at most 60 characters.
function cleanName(name) {
  let n = String(name == null ? '' : name).replace(/[^A-Za-z0-9 ._-]/g, '_').replace(/^[. ]+/, '').slice(0, 60).replace(/[. ]+$/, '');
  if (!n) n = 'Uploaded project';
  return RESERVED.test(n.split('.')[0].trim()) ? n + '_' : n;
}

// name, then name-2, name-3 ... until nothing of that name exists in root
function uniqueProjectName(root, name) {
  let n = name, i = 1;
  while (fs.existsSync(path.join(root, n))) n = `${name}-${++i}`;
  return n;
}

const within = (base, p) => p === base || p.startsWith(base + path.sep);

function createUploads(o) {
  const now = o.now || Date.now, L = { ...LIMITS, ...(o.limits || {}) }, statfs = o.statfs === undefined ? fs.statfsSync : o.statfs;
  const root = path.resolve(o.root), markerDir = path.join(root, MARKERS), m = new Map();

  const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} };
  const dropSession = (u) => { u.dead = true; m.delete(u.id); rm(u.dir); rm(path.join(markerDir, u.id)); };
  const get = (id, key) => { const u = m.get(id); if (!u || u.key !== key || u.dead) throw fail(404, 'no such upload'); u.last = now(); return u; };

  // leftovers from a run that died: every marker on disk belongs to no live session
  function cleanStale() {
    let list = [];
    try { list = fs.readdirSync(markerDir); } catch {}
    for (const id of list) {
      if (m.has(id)) continue;
      const mk = path.join(markerDir, id);
      try {
        const d = path.join(root, String(JSON.parse(fs.readFileSync(mk, 'utf8')).dir));
        if (path.dirname(d) === root && path.basename(d) !== MARKERS) rm(d);
      } catch {}
      rm(mk);
    }
  }
  // a PUT that has sent nothing for stallMs is cut off; its putFile then removes the .part and reports failure
  function sweepStalls() {
    for (const u of m.values()) for (const p of [...u.puts]) if (now() - p.last > L.stallMs) p.req.destroy(fail(408, 'upload stalled'));
  }
  function sweep() { sweepStalls(); for (const u of [...m.values()]) if (!u.active && now() - u.last > L.idleMs) dropSession(u); }
  const reservedLeft = () => [...m.values()].reduce((a, u) => a + Math.max(0, u.bytes - u.got), 0);
  const reservedAll = () => [...m.values()].reduce((a, u) => a + u.bytes, 0);

  function start(key, b) {
    sweep();
    const files = b && b.files, bytes = b && b.bytes;
    if (!Number.isInteger(files) || files < 1 || !Number.isInteger(bytes) || bytes < 0) throw fail(400, 'bad request');
    if (files > L.maxFiles) throw fail(413, `Too many files (limit ${L.maxFiles}).`);
    if (bytes > L.maxTotal) throw fail(413, `Too large (limit ${Math.round(L.maxTotal / 1048576)} MB in total).`);
    if (b.paths !== undefined) {
      if (!Array.isArray(b.paths) || b.paths.length > L.maxFiles) throw fail(400, 'bad request');
      for (const p of b.paths) {
        const r = safeRel(p);
        if (!r) throw fail(400, 'bad path');
        const k = classify(r);
        if (k === 'git') throw fail(400, 'git data is not uploaded');
        if (k === 'config' && b.allowConfig !== true) throw fail(400, 'project config is not uploaded unless you include it');
      }
    }
    if ([...m.values()].filter((u) => u.key === key).length >= L.perKey) throw fail(429, 'Too many uploads in progress. Finish or cancel one first.');
    if (m.size >= L.maxActive) throw fail(429, `Too many uploads in progress on the server (limit ${L.maxActive}). Try again shortly.`);
    if (reservedAll() + bytes > L.maxInflight) throw fail(429, `Too much data is being uploaded at once (limit ${Math.round(L.maxInflight / 1048576)} MB). Try again shortly.`);
    fs.mkdirSync(root, { recursive: true, mode: 0o755 });
    if (typeof statfs === 'function') {
      let free = null;
      try { const s = statfs(root); free = Number(s.bavail) * Number(s.bsize); } catch {}
      if (free !== null && Number.isFinite(free) && free < reservedLeft() + bytes + L.margin) throw fail(507, 'Not enough free disk space on the server.');
    }
    const base = cleanName(b.name);
    let name = null;
    for (let i = 0; i < 50 && !name; i++) {
      const cand = uniqueProjectName(root, base);
      try { fs.mkdirSync(path.join(root, cand), { mode: 0o755 }); name = cand; } catch (er) { if (er.code !== 'EEXIST') throw fail(500, 'Could not create the folder.'); }
    }
    if (!name) throw fail(500, 'Could not create the folder.');
    const id = crypto.randomBytes(12).toString('base64url'), dir = path.join(root, name);
    try {
      fs.mkdirSync(markerDir, { recursive: true, mode: 0o755 });
      fs.writeFileSync(path.join(markerDir, id), JSON.stringify({ dir: name }), { mode: 0o644 });
    } catch { rm(dir); throw fail(500, 'Could not create the folder.'); }
    m.set(id, { id, key, dir, name, files, bytes, got: 0, count: 0, paths: new Set(), puts: new Set(), parts: new Set(), allowConfig: b.allowConfig === true, active: 0, last: now(), dead: false });
    return { id, name };
  }

  // Stream one file to disk: temp name, hard limits, then rename. Resolves {size}; rejects with an error carrying .status.
  async function putFile(id, key, rel, req, declared) {
    const u = get(id, key), r = safeRel(rel);
    if (!r) throw fail(400, 'bad path');
    const kind = classify(r);
    if (kind === 'git') throw fail(400, 'git data is not uploaded');
    if (kind === 'config' && !u.allowConfig) throw fail(400, 'project config is not uploaded unless you include it');
    const lc = r.toLowerCase();
    if (u.paths.has(lc)) throw fail(409, 'duplicate path');
    if (u.paths.size >= u.files) throw fail(400, 'more files than announced');
    if (Number.isFinite(declared) && (declared > L.maxFile || declared > u.bytes - u.got)) throw fail(413, 'file too large');
    const segs = r.split('/'), parent = path.join(u.dir, ...segs.slice(0, -1)), target = path.join(u.dir, ...segs);
    if (!within(u.dir, path.resolve(target))) throw fail(400, 'bad path');
    u.paths.add(lc);
    u.active++;
    let tmp = null, mine = 0, ok = false;
    const put = { req, last: now() };
    u.puts.add(put);
    try {
      fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
      const realDir = fs.realpathSync(u.dir), realParent = fs.realpathSync(parent);
      if (!within(realDir, realParent) || fs.lstatSync(parent).isSymbolicLink()) throw fail(400, 'bad path');
      tmp = path.join(parent, `.part-${crypto.randomBytes(6).toString('hex')}`);
      u.parts.add(tmp);
      const ws = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o644 });
      const gate = new Transform({
        transform(chunk, _e, cb) {
          if (u.dead) return cb(fail(404, 'upload cancelled'));
          put.last = now();
          mine += chunk.length; u.got += chunk.length;
          if (mine > L.maxFile) return cb(fail(413, `File over ${Math.round(L.maxFile / 1048576)} MB.`));
          if (u.got > u.bytes) return cb(fail(413, 'More data than announced.'));
          cb(null, chunk);
        },
      });
      await new Promise((res, rej) => pipeline(req, gate, ws, (er) => (er ? rej(er.status ? er : fail(400, 'upload interrupted')) : res())));
      if (u.dead) throw fail(404, 'upload cancelled');
      moveNew(tmp, target);
      u.parts.delete(tmp); tmp = null; ok = true; u.count++; u.last = now();
      return { size: mine };
    } catch (er) {
      throw er.status ? er : fail(400, 'could not write that file');
    } finally {
      u.active--; u.puts.delete(put);
      if (!ok) { u.got -= mine; u.paths.delete(lc); if (tmp) { try { fs.rmSync(tmp, { force: true, maxRetries: 5, retryDelay: 100 }); } catch {} u.parts.delete(tmp); } }
    }
  }

  // All announced files arrived: the session is over and the folder is the caller's to register.
  function finish(id, key) {
    const u = get(id, key);
    if (u.active) throw fail(409, 'files still uploading');
    if (u.count !== u.files) throw fail(400, `Expected ${u.files} files, got ${u.count}.`);
    for (const f of u.parts) try { fs.rmSync(f, { force: true }); } catch {}
    m.delete(id); rm(path.join(markerDir, id));
    return { dir: u.dir, name: u.name };
  }
  function remove(id, key) { dropSession(get(id, key)); }

  return { start, putFile, finish, remove, sweep, sweepStalls, cleanStale, size: () => m.size, root };
}

module.exports = { LIMITS, safeRel, classify, cleanName, uniqueProjectName, createUploads };
