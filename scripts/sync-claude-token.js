#!/usr/bin/env node
// Copies the PC's current Claude access token into <repo>/secrets/claude-oauth-token for the Docker container.
// One line of output, never the token. Exit: 0 ok, 1 no login/invalid, 2 token expired.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TOKEN_RE = /^[A-Za-z0-9._~+\/=-]{20,}$/;
const REFRESH_WINDOW_MS = 30 * 60000;

function parseArgs(argv) {
  const a = { quiet: false, refresh: false, dir: path.resolve(__dirname, '..') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--quiet') a.quiet = true;
    else if (argv[i] === '--refresh') a.refresh = true;
    else if (argv[i] === '--dir' && argv[i + 1]) a.dir = path.resolve(argv[++i]);
  }
  return a;
}

function readCreds(home) {
  try {
    const raw = fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8').replace(/^﻿/, '');
    const o = JSON.parse(raw).claudeAiOauth;
    const token = o && typeof o.accessToken === 'string' ? o.accessToken.trim() : '';
    if (!TOKEN_RE.test(token)) return null;
    return { token, expiresAt: Number(o.expiresAt) || 0 };
  } catch { return null; }
}

function runClaude() {
  return new Promise((resolve) => {
    let child;
    try { child = spawn('claude', ['-p', 'ok', '--max-turns', '1'], { stdio: 'ignore', windowsHide: true }); } catch { return resolve(); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 90000);
    child.on('error', () => { clearTimeout(timer); resolve(); });
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function writeAtomic(file, token) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.claude-oauth-token.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

// Returns { code, msg }; prints nothing itself.
async function sync({ dir, refresh, home = os.homedir(), now = Date.now(), run = runClaude }) {
  let c = readCreds(home);
  if (!c) return { code: 1, msg: 'error: no valid Claude login found (run "claude" on this PC and sign in)' };
  if (refresh && c.expiresAt - now < REFRESH_WINDOW_MS) {
    await run();
    c = readCreds(home) || c;
  }
  if (c.expiresAt && c.expiresAt <= now) return { code: 2, msg: 'error: token already expired; open Claude Code on this PC once to refresh your login, or run with --refresh' };
  const file = path.join(dir, 'secrets', 'claude-oauth-token');
  let cur = null;
  try { cur = fs.readFileSync(file, 'utf8').trim(); } catch {}
  let msg;
  if (cur === c.token) msg = 'unchanged';
  else {
    try { writeAtomic(file, c.token); } catch (e) { return { code: 1, msg: 'error: could not write the token file (' + (e.code || 'failed') + ')' }; }
    msg = 'synced';
  }
  if (c.expiresAt) msg += `, expires in ${Math.max(0, Math.round((c.expiresAt - now) / 60000))} min`;
  return { code: 0, msg };
}

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  sync(a).then((r) => {
    if (r.code !== 0 || !a.quiet) (r.code ? console.error : console.log)(r.msg);
    process.exitCode = r.code;
  });
}

module.exports = { sync, parseArgs, readCreds };
