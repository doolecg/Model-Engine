const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildClaudeEnv, claudeAuthStatus } = require('./auth.js');

const base = () => ({
  PATH: 'x', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o',
  CLAUDE_CODE_SUBAGENT_MODEL: 'm', CLAUDE_CODE_ENTRYPOINT: 'e', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 's',
  CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_MESSAGING_SOCKET: 'p', CLAUDE_CODE_MESSAGING_TOKEN: 'q', CLAUDECODE: '1', CLAUDE_PID: '9',
});
const LEAKS = ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDECODE', 'CLAUDE_PID'];

test('subscription (default): drops API key vars and leaks, keeps OAuth token', () => {
  for (const e of [buildClaudeEnv(base()), buildClaudeEnv(base(), 'subscription')]) {
    assert.strictEqual(e.ANTHROPIC_API_KEY, undefined); assert.strictEqual(e.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.strictEqual(e.CLAUDE_CODE_OAUTH_TOKEN, 'o'); assert.strictEqual(e.PATH, 'x');
    for (const k of LEAKS) assert.ok(!(k in e), k);
  }
});

test('apikey: drops OAuth token and leaks, keeps API key vars', () => {
  const e = buildClaudeEnv(base(), 'apikey');
  assert.strictEqual(e.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.strictEqual(e.ANTHROPIC_API_KEY, 'k'); assert.strictEqual(e.ANTHROPIC_AUTH_TOKEN, 't');
  for (const k of LEAKS) assert.ok(!(k in e), k);
});

test('input env is not mutated', () => {
  const b = base(), snap = { ...b };
  buildClaudeEnv(b, 'subscription'); buildClaudeEnv(b, 'apikey');
  assert.deepStrictEqual(b, snap);
});

test('status holds booleans only', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
  fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), 'SECRET');
  const st = claudeAuthStatus('apikey', { ANTHROPIC_API_KEY: 'sk-secret', CLAUDE_CODE_OAUTH_TOKEN: '  ' }, home);
  assert.deepStrictEqual(st, { mode: 'apikey', subscription: { loginFile: true, tokenEnv: false }, apiKeyEnv: true });
  const s = JSON.stringify(st);
  for (const bad of ['sk-secret', 'SECRET', home]) assert.ok(!s.includes(bad));
});
