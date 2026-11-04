const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'sync-claude-token.js');
const TOK = 'sk-ant-oat01-' + 'Ab9_'.repeat(8);
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function setup(creds, bom = false) {
  const home = mk('sct-home-'), dir = mk('sct-dir-');
  fs.mkdirSync(path.join(home, '.claude'));
  if (creds !== null) fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), (bom ? '﻿' : '') + JSON.stringify(creds));
  return { home, dir, file: path.join(dir, 'secrets', 'claude-oauth-token') };
}
const exec = (s, extra = []) => spawnSync(process.execPath, [SCRIPT, '--dir', s.dir, ...extra], { env: { ...process.env, HOME: s.home, USERPROFILE: s.home }, encoding: 'utf8' });
const creds = (token, mins) => ({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + mins * 60000 } });

test('writes the token (BOM ok), then reports unchanged', () => {
  const s = setup(creds(TOK, 200), true);
  const r = exec(s);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout.trim(), /^synced/);
  assert.strictEqual(fs.readFileSync(s.file, 'utf8'), TOK + '\n');
  const r2 = exec(s);
  assert.strictEqual(r2.status, 0);
  assert.match(r2.stdout.trim(), /^unchanged/);
});

test('changed token replaces the file atomically, no temp files left', () => {
  const s = setup(creds(TOK, 200));
  exec(s);
  const t2 = TOK + 'Z';
  fs.writeFileSync(path.join(s.home, '.claude', '.credentials.json'), JSON.stringify(creds(t2, 200)));
  assert.match(exec(s).stdout, /^synced/);
  assert.strictEqual(fs.readFileSync(s.file, 'utf8'), t2 + '\n');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(s.file)), ['claude-oauth-token']);
});

test('expired token exits 2 and writes nothing', () => {
  const s = setup(creds(TOK, -5));
  const r = exec(s);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /open Claude Code on this PC once to refresh your login, or run with --refresh/);
  assert.ok(!fs.existsSync(s.file));
});

test('invalid shape or missing login exits 1', () => {
  for (const c of [creds('short', 200), creds('has space ' + TOK, 200), { nope: 1 }, null]) {
    const s = setup(c);
    assert.strictEqual(exec(s).status, 1);
    assert.ok(!fs.existsSync(s.file));
  }
});

test('the token never appears in output', () => {
  const s = setup(creds(TOK, 200));
  const r = exec(s);
  assert.ok(!r.stdout.includes(TOK) && !r.stderr.includes(TOK));
});

test('--quiet prints nothing on success', () => {
  const s = setup(creds(TOK, 200));
  const r = exec(s, ['--quiet']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout + r.stderr, '');
});

test('--refresh runs claude only when expiry is under 30 minutes, then re-reads', async () => {
  const { sync } = require(SCRIPT);
  const s = setup(creds(TOK, 10));
  let calls = 0;
  const fake = async () => { calls++; fs.writeFileSync(path.join(s.home, '.claude', '.credentials.json'), JSON.stringify(creds(TOK + 'N', 300))); };
  const r = await sync({ dir: s.dir, refresh: true, home: s.home, run: fake });
  assert.strictEqual(calls, 1); assert.strictEqual(r.code, 0);
  assert.strictEqual(fs.readFileSync(s.file, 'utf8'), TOK + 'N\n');
  await sync({ dir: s.dir, refresh: true, home: s.home, run: fake });
  assert.strictEqual(calls, 1);
});
