// Remote access over Tailscale: token, session, host and rate-limit helpers. Pure; fs, clock and execFile are injected.
const crypto = require('crypto');

const HOST_RE = /^[a-z0-9.-]+$/;
const SESSION_MS = 7 * 24 * 3600e3;

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

// In-memory sessions: random id, 7-day expiry.
function createSessions(opts) {
  const now = (opts && opts.now) || Date.now, ttl = (opts && opts.ttl) || SESSION_MS, m = new Map();
  const purge = () => { const t = now(); for (const [k, v] of m) if (v <= t) m.delete(k); };
  return {
    create() { const id = crypto.randomBytes(32).toString('base64url'); m.set(id, now() + ttl); return id; },
    valid(id) { const v = typeof id === 'string' && m.get(id); if (!v) return false; if (v <= now()) { m.delete(id); return false; } return true; },
    drop(id) { m.delete(id); },
    clear() { m.clear(); },
    count() { purge(); return m.size; },
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

// 5 failures per 60 s per key, then blocked for 60 s.
function createLimiter(opts) {
  const now = (opts && opts.now) || Date.now, max = (opts && opts.max) || 5, win = (opts && opts.windowMs) || 60e3, block = (opts && opts.blockMs) || 60e3, m = new Map();
  return {
    // seconds to wait, or 0 when allowed
    retry(key) { const e = m.get(key); if (!e || !e.until) return 0; if (e.until <= now()) { m.delete(key); return 0; } return Math.ceil((e.until - now()) / 1000); },
    fail(key) {
      const t = now(), e = m.get(key) || { fails: [], until: 0 };
      e.fails = e.fails.filter((x) => t - x < win); e.fails.push(t);
      if (e.fails.length >= max) { e.until = t + block; e.fails = []; }
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

const LOGIN_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Model Engine sign in</title>'
  + '<style>body{background:#121214;color:#e8e8ee;font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}form{width:min(92vw,380px);display:grid;gap:12px}'
  + 'h1{font-size:1em;letter-spacing:.08em;color:#4ade80;margin:0}input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #3a3a44;background:#17171b;color:inherit}button{cursor:pointer}'
  + 'input:focus,button:focus{outline:2px solid #8b7cf6}#m{min-height:1.4em;color:#f0a64b;margin:0}</style></head><body>'
  + '<form id="f"><h1>MODEL ENGINE</h1><label for="t">Access token</label><input id="t" type="password" autocomplete="off" required><button type="submit">Sign in</button><p id="m" role="status" aria-live="polite"></p></form>'
  + '<script>document.getElementById("f").onsubmit=async function(e){e.preventDefault();var m=document.getElementById("m");m.textContent="";'
  + 'try{var r=await fetch("/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:document.getElementById("t").value})});'
  + 'if(r.ok)location.reload();else m.textContent=r.status===429?"Too many attempts. Wait a minute.":"That token was not accepted."}catch(x){m.textContent="Could not reach the server."}};</script></body></html>';

module.exports = { validHost, generateToken, hashToken, verifyToken, createSessions, parseCookie, isLoopbackHost, isAllowedRemoteHost, isAllowedRemoteOrigin, isProxied, createLimiter, restore, publishCommand, parseStatus, detectTailscale, LOGIN_PAGE, SESSION_MS };
