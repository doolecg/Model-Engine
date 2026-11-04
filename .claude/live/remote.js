// Remote access over Tailscale: token, session, host and rate-limit helpers. Pure; fs, clock and execFile are injected.
const crypto = require('crypto');

const HOST_RE = /^[a-z0-9.-]+$/;
const REMEMBER_MS = 30 * 24 * 3600e3, SHORT_MS = 12 * 3600e3, SLIDE_MS = 3600e3, MAX_SESSIONS = 20;

const validHost = (h) => typeof h === 'string' && h.length <= 253 && HOST_RE.test(h) && h.endsWith('.ts.net') && h.length > '.ts.net'.length && !h.startsWith('.') && !h.includes('..');

const generateToken = () => crypto.randomBytes(32).toString('base64url');

// Only {salt, hash} is ever stored, never the token.
function hashToken(token, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  return { salt: s, hash: crypto.scryptSync(String(token), s, 32).toString('hex') };
}
function verifyToken(token, stored, eq) {
  if (typeof token !== 'string' || !stored || typeof stored.salt !== 'string' || typeof stored.hash !== 'string') return false;
  const want = Buffer.from(stored.hash, 'hex'), got = Buffer.from(hashToken(token, stored.salt).hash, 'hex');
  return want.length === got.length && (eq || crypto.timingSafeEqual)(want, got);
}

// Username + secret: scrypt with a per-user salt. Only {username, salt, hash} is ever stored.
const validUsername = (u) => typeof u === 'string' && /^[a-z0-9._-]{3,32}$/.test(u);
const validSecret = (p) => typeof p === 'string' && p.length >= 6 && p.length <= 128;
const DUMMY_SALT = '0'.repeat(32);
function verifyCredentials(username, secret, creds, eq) {
  const cmp = eq || crypto.timingSafeEqual, has = !!creds && typeof creds.salt === 'string' && typeof creds.hash === 'string';
  if (typeof secret !== 'string' || secret.length < 1 || secret.length > 128) return false;
  // Always run scrypt (on a dummy salt when nothing is set) so timing does not reveal whether the username exists.
  const got = Buffer.from(hashToken(secret, has ? creds.salt : DUMMY_SALT).hash, 'hex'), want = has ? Buffer.from(creds.hash, 'hex') : Buffer.alloc(32);
  const sha = (x) => crypto.createHash('sha256').update(String(x)).digest();
  const nameOk = cmp(sha(typeof username === 'string' ? username.toLowerCase() : ''), sha(has ? creds.username : ''));
  const hashOk = want.length === got.length && cmp(want, got);
  return has && nameOk && hashOk;
}

// Short family label from the User-Agent, e.g. 'Android Chrome'. No IP, no version.
function deviceLabel(ua) {
  const s = String(ua || '');
  const os = /Android/.test(s) ? 'Android' : /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Windows/.test(s) ? 'Windows' : /Macintosh|Mac OS X/.test(s) ? 'Mac' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : '';
  const br = /Edg(e|A|iOS)?\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\/|FxiOS/.test(s) ? 'Firefox' : /Chrome\/|CriOS/.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'browser';
  return (os + ' ' + br).trim();
}

// Sessions persist: only sha256(id) is kept, never the id. Remembered ones (30 days) slide, at most once an hour; others last 12 h.
const hashId = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');
function createSessions(opts) {
  const now = (opts && opts.now) || Date.now, onChange = (opts && opts.onChange) || (() => {}), m = new Map();
  const purge = () => { const t = now(); for (const [k, v] of m) if (v.expires <= t) m.delete(k); };
  const sorted = () => [...m.entries()].sort((x, y) => x[1].created - y[1].created);
  return {
    create(o) {
      const id = crypto.randomBytes(32).toString('base64url'), t = now(), remember = !!(o && o.remember);
      purge();
      m.set(hashId(id), { idHash: hashId(id), created: t, lastSeen: t, expires: t + (remember ? REMEMBER_MS : SHORT_MS), label: String((o && o.label) || 'Unknown').slice(0, 40) });
      while (m.size > MAX_SESSIONS) m.delete(sorted()[0][0]);
      onChange(); return id;
    },
    // null, or {remember, slid} (slid: the expiry was just extended, so the cookie should be re-issued)
    check(id) {
      if (typeof id !== 'string' || !id) return null;
      const k = hashId(id), v = m.get(k), t = now();
      if (!v) return null;
      if (v.expires <= t) { m.delete(k); onChange(); return null; }
      const remember = v.expires - v.created > SHORT_MS;
      let slid = false;
      if (remember && t - v.lastSeen >= SLIDE_MS) { v.lastSeen = t; v.expires = t + REMEMBER_MS; slid = true; onChange(); }
      return { remember, slid };
    },
    valid(id) { return !!this.check(id); },
    drop(id) { if (m.delete(hashId(id))) onChange(); },
    hasHash(h) { return m.has(h); },
    hashOf: hashId,
    // devices for the UI, oldest first, no ids
    list() { purge(); return sorted().map(([, v]) => ({ label: v.label, created: v.created, lastSeen: v.lastSeen })); },
    revokeAt(i) { purge(); const e = Number.isInteger(i) ? sorted()[i] : null; if (!e) return false; m.delete(e[0]); onChange(); return true; },
    clear() { if (m.size) { m.clear(); onChange(); } },
    count() { purge(); return m.size; },
    dump() { purge(); return sorted().map(([, v]) => ({ ...v })); },
    load(arr) {
      m.clear();
      for (const v of Array.isArray(arr) ? arr : []) {
        if (v && /^[0-9a-f]{64}$/.test(v.idHash) && [v.created, v.lastSeen, v.expires].every(Number.isFinite)) m.set(v.idHash, { idHash: v.idHash, created: v.created, lastSeen: v.lastSeen, expires: v.expires, label: typeof v.label === 'string' ? v.label.slice(0, 40) : 'Unknown' });
      }
      purge(); while (m.size > MAX_SESSIONS) m.delete(sorted()[0][0]);
    },
  };
}

const parseCookie = (header, name) => {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
};

const isLoopbackHost = (host, port) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;

// Exact match against the ONE configured *.ts.net name; an optional :port is the only extra allowed.
function isAllowedRemoteHost(host, configured) {
  if (!validHost(configured) || typeof host !== 'string') return false;
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(host.toLowerCase());
  return !!m && m[1] === configured.toLowerCase() && (m[2] === undefined || (+m[2] >= 1 && +m[2] <= 65535));
}

// Origin must be https://<configured host> with an optional numeric port; no userinfo, path or other extras.
function isAllowedRemoteOrigin(origin, configured) {
  if (!validHost(configured) || typeof origin !== 'string') return false;
  const m = /^https:\/\/([^:/@?#\s]+)(?::(\d{1,5}))?$/.exec(origin.toLowerCase());
  return !!m && m[1] === configured.toLowerCase() && (m[2] === undefined || (+m[2] >= 1 && +m[2] <= 65535));
}

// Requests that came through a reverse proxy such as `tailscale serve` carry these headers; a real local browser does not.
const isProxied = (h) => Object.keys(h || {}).some((k) => k === 'x-forwarded-for' || k === 'x-forwarded-host' || k === 'x-forwarded-proto' || k === 'forwarded' || k.startsWith('tailscale-'));

// 5 failures per 60 s per key, then blocked for 60 s. With escalate, each further lockout doubles (1, 2, 4 ... min, up to capMs) until reset.
function createLimiter(opts) {
  const now = (opts && opts.now) || Date.now, max = (opts && opts.max) || 5, win = (opts && opts.windowMs) || 60e3, block = (opts && opts.blockMs) || 60e3, esc = !!(opts && opts.escalate), cap = (opts && opts.capMs) || 15 * 60e3, m = new Map();
  return {
    // seconds to wait, or 0 when allowed
    retry(key) { const e = m.get(key); if (!e || !e.until) return 0; if (e.until <= now()) { if (esc) e.until = 0; else m.delete(key); return 0; } return Math.ceil((e.until - now()) / 1000); },
    fail(key) {
      const t = now(), e = m.get(key) || { fails: [], until: 0, level: 0 };
      e.fails = e.fails.filter((x) => t - x < win); e.fails.push(t);
      if (e.fails.length >= max) { e.until = t + (esc ? Math.min(block * 2 ** e.level, cap) : block); e.level++; e.fails = []; }
      m.set(key, e);
    },
    reset(key) { m.delete(key); },
  };
}

// Keep only well-formed stored settings.
function restore(o) {
  const r = { enabled: false, host: null, salt: null, hash: null };
  if (!o || typeof o !== 'object') return r;
  if (validHost(o.host)) r.host = o.host;
  r.enabled = o.enabled === true && !!r.host;
  if (/^[0-9a-f]{32}$/.test(o.salt || '') && /^[0-9a-f]{64}$/.test(o.hash || '')) { r.salt = o.salt; r.hash = o.hash; }
  return r;
}

function restoreCreds(o) {
  return o && typeof o === 'object' && validUsername(o.username) && /^[0-9a-f]{32}$/.test(o.salt || '') && /^[0-9a-f]{64}$/.test(o.hash || '') ? { username: o.username, salt: o.salt, hash: o.hash } : null;
}

const publishCommand = (port) => `tailscale serve --bg ${port}`;

// Keeps only Self.DNSName (no trailing dot) and BackendState from `tailscale status --json`.
function parseStatus(text) {
  try {
    const j = JSON.parse(text);
    const dns = j && j.Self && typeof j.Self.DNSName === 'string' ? j.Self.DNSName.replace(/\.$/, '').toLowerCase() : null;
    return { running: !!j && j.BackendState === 'Running', dnsName: dns && validHost(dns) ? dns : null };
  } catch { return null; }
}

// Read-only. Never changes Tailscale config.
function detectTailscale(deps) {
  const execFile = deps.execFile, exists = deps.exists || (() => false), win = (deps.platform || process.platform) === 'win32';
  const cands = ['tailscale'];
  if (win) cands.push('C:\\Program Files\\Tailscale\\tailscale.exe');
  const list = cands.filter((c, i) => i === 0 || exists(c));
  const tryOne = (i) => new Promise((resolve) => {
    if (i >= list.length) return resolve({ installed: false, running: false, dnsName: null });
    execFile(list[i], ['status', '--json'], { timeout: 5000, windowsHide: true, maxBuffer: 10e6 }, (err, stdout) => {
      if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) return resolve(tryOne(i + 1));
      const p = parseStatus(stdout);
      resolve({ installed: true, running: p ? p.running : false, dnsName: p ? p.dnsName : null });
    });
  });
  return tryOne(0);
}

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Model Engine sign in</title>
<style>body{background:#121214;color:#e8e8ee;font:16px ui-monospace,Menlo,Consolas,monospace;display:grid;place-items:center;min-height:100vh;margin:0}form{width:min(92vw,380px);display:grid;gap:12px}
[hidden]{display:none!important}h1{font-size:1em;letter-spacing:.08em;color:#4ade80;margin:0}label{display:grid;gap:6px}label.c{display:flex;align-items:center;gap:10px;min-height:44px}label.c input{width:22px;height:22px;min-height:0;margin:0}
input,button{font:inherit;min-height:44px;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #3a3a44;background:#17171b;color:inherit}button{cursor:pointer}#sw{background:none;border:0;color:#8b7cf6;text-decoration:underline;font-size:.85em}
input:focus,button:focus{outline:2px solid #8b7cf6}#m{min-height:1.4em;color:#f0a64b;margin:0}</style></head><body>
<form id="f"><h1>MODEL ENGINE</h1>
<div id="cr" style="display:grid;gap:12px"><label>Username<input id="u" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
<label>Password or PIN<input id="p" type="password" autocomplete="current-password" inputmode="text" required></label></div>
<label id="tk" hidden>Access token<input id="t" type="password" autocomplete="off"></label>
<label class="c"><input id="rm" type="checkbox" checked>Remember this device</label>
<button id="go" type="submit">Sign in</button><button id="sw" type="button">Use access token instead</button><p id="m" role="alert"></p></form>
<script>var $=function(i){return document.getElementById(i)},tok=false;
$("sw").onclick=function(){tok=!tok;$("cr").hidden=tok;$("tk").hidden=!tok;$("u").required=$("p").required=!tok;$("t").required=tok;$("sw").textContent=tok?"Use username and password instead":"Use access token instead";$("m").textContent="";(tok?$("t"):$("u")).focus()};
$("f").onsubmit=async function(e){e.preventDefault();var m=$("m"),b=$("go");m.textContent="";b.disabled=true;
try{var d=tok?{token:$("t").value}:{username:$("u").value.trim(),secret:$("p").value};d.remember=$("rm").checked;
var r=await fetch("/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(d)});
if(r.ok)location.reload();else if(r.status===429){var w=+r.headers.get("retry-after")||60;m.textContent="Too many attempts. Try again in "+(w>=120?Math.ceil(w/60)+" minutes":w+" seconds")+"."}else m.textContent=tok?"That token was not accepted.":"Wrong username or password"}
catch(x){m.textContent="Could not reach the server."}b.disabled=false};</script></body></html>`;

module.exports = { validHost, generateToken, hashToken, verifyToken, validUsername, validSecret, verifyCredentials, deviceLabel, restoreCreds, createSessions, parseCookie, isLoopbackHost, isAllowedRemoteHost, isAllowedRemoteOrigin, isProxied, createLimiter, restore, publishCommand, parseStatus, detectTailscale, LOGIN_PAGE, REMEMBER_MS, SHORT_MS, SLIDE_MS, MAX_SESSIONS };
