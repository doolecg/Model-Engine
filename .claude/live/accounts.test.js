const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectAccounts } = require('./accounts.js');

const plat = process.platform;
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
  const home = path.join(root, 'home'), bin = path.join(root, 'bin');
  fs.mkdirSync(home); fs.mkdirSync(bin);
  const exe = (n) => { fs.writeFileSync(path.join(bin, n), ''); if (plat === 'win32') fs.writeFileSync(path.join(bin, n + '.cmd'), ''); };
  const file = (...p) => { const f = path.join(home, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'SECRET-CONTENT'); };
  return { root, home, bin, exe, file, env: { PATH: bin }, get: (env, p = plat) => Object.fromEntries(detectAccounts(env, p, home).map((a) => [a.id, a])) };
}

test('signed-in via login file', () => {
  const t = setup(); t.exe('claude'); t.file('.claude', '.credentials.json');
  assert.deepStrictEqual(t.get(t.env).claude, { id: 'claude', label: 'Claude Code', cli: 'found', auth: 'signed-in', via: 'login file' });
});

test('api-key via environment', () => {
  const t = setup(); t.exe('codex');
  const a = t.get({ ...t.env, OPENAI_API_KEY: 'sk-fake-value-123' });
  assert.strictEqual(a.codex.auth, 'api-key'); assert.strictEqual(a.codex.via, 'environment');
  assert.strictEqual(a.opencode.auth, 'api-key'); assert.strictEqual(a.opencode.cli, 'missing');
});

test('claude: OAuth token is signed-in via environment token, API key stays api-key', () => {
  const t = setup(); t.exe('claude');
  assert.deepStrictEqual(t.get({ ...t.env, CLAUDE_CODE_OAUTH_TOKEN: 'oat-fake-789' }).claude, { id: 'claude', label: 'Claude Code', cli: 'found', auth: 'signed-in', via: 'environment token' });
  const k = t.get({ ...t.env, ANTHROPIC_API_KEY: 'sk-fake-value-123' }).claude;
  assert.strictEqual(k.auth, 'api-key'); assert.strictEqual(k.via, 'environment');
  assert.strictEqual(t.get({ ...t.env, ANTHROPIC_AUTH_TOKEN: 'x-fake' }).claude.auth, 'api-key');
});

test('not-found and missing CLI', () => {
  const t = setup(); t.exe('gemini');
  const a = t.get({ ...t.env, OPENAI_API_KEY: '   ' });
  assert.strictEqual(a.claude.cli, 'missing'); assert.strictEqual(a.claude.auth, 'not-found'); assert.strictEqual(a.claude.via, 'none');
  assert.strictEqual(a.codex.auth, 'not-found');
  assert.strictEqual(a.google.cli, 'found'); assert.strictEqual(a.google.auth, 'not-found');
});

test('google: gcloud ADC counts, antigravity alone is unknown', () => {
  const t = setup(); t.file('.config', 'gcloud', 'application_default_credentials.json');
  assert.strictEqual(t.get(t.env).google.auth, 'signed-in');
  const u = setup(); u.exe('antigravity');
  assert.strictEqual(u.get(u.env).google.auth, 'unknown');
});

test('macOS claude with CLI and no file is unknown', () => {
  const t = setup(); t.exe('claude');
  assert.strictEqual(t.get(t.env, 'darwin').claude.auth, 'unknown');
});

test('opencode and codex login files, CODEX_HOME honoured', () => {
  const t = setup(); t.exe('opencode'); t.file('.local', 'share', 'opencode', 'auth.json'); t.file('cx', 'auth.json');
  const a = t.get({ ...t.env, CODEX_HOME: path.join(t.home, 'cx') });
  assert.strictEqual(a.opencode.auth, 'signed-in'); assert.strictEqual(a.codex.auth, 'signed-in');
});

test('output never contains paths, file contents or env values', () => {
  const t = setup(); t.exe('claude'); t.file('.claude', '.credentials.json'); t.file('.gemini', 'oauth_creds.json');
  const env = { ...t.env, OPENAI_API_KEY: 'sk-fake-value-123', GEMINI_API_KEY: 'gm-fake-value-456', CLAUDE_CODE_OAUTH_TOKEN: 'oat-fake-789', USERPROFILE: t.home };
  const s = JSON.stringify(detectAccounts(env, plat, t.home));
  for (const bad of [t.root, t.home, t.bin, 'sk-fake-value-123', 'gm-fake-value-456', 'oat-fake-789', 'SECRET-CONTENT', os.tmpdir()]) assert.ok(!s.includes(bad), bad);
});
