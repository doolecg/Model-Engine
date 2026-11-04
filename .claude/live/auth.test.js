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
  assert.deepStrictEqual(st, { mode: 'apikey', subscription: { loginFile: true, tokenEnv: false, tokenFile: { present: false, ageMinutes: null } }, apiKeyEnv: true });
  const s = JSON.stringify(st);
  for (const bad of ['sk-secret', 'SECRET', home]) assert.ok(!s.includes(bad));
});

const TOK = 'tok_' + 'a'.repeat(30);
const tmpTok = (content) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tokf-')); const f = path.join(d, 't'); fs.writeFileSync(f, content); return f; };

test('token file wins over a stale env value (subscription), trimmed, read every call', () => {
  const f = tmpTok(TOK + '\n');
  const env = { ...base(), CLAUDE_CODE_OAUTH_TOKEN_FILE: f };
  assert.strictEqual(buildClaudeEnv(env).CLAUDE_CODE_OAUTH_TOKEN, TOK);
  fs.writeFileSync(f, TOK + 'b\n');
  assert.strictEqual(buildClaudeEnv(env, 'subscription').CLAUDE_CODE_OAUTH_TOKEN, TOK + 'b');
  assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, 'o');
});

test('bad, empty, multi-line, oversize or missing token file is ignored', () => {
  const bads = ['', '\n', 'short', TOK + '\n' + TOK, 'has space ' + TOK, 'x'.repeat(5000)];
  for (const c of bads) {
    const e = buildClaudeEnv({ ...base(), CLAUDE_CODE_OAUTH_TOKEN_FILE: tmpTok(c) });
    assert.strictEqual(e.CLAUDE_CODE_OAUTH_TOKEN, 'o', JSON.stringify(c.slice(0, 12)));
  }
  assert.strictEqual(buildClaudeEnv({ ...base(), CLAUDE_CODE_OAUTH_TOKEN_FILE: path.join(os.tmpdir(), 'nope-none') }).CLAUDE_CODE_OAUTH_TOKEN, 'o');
});

test('injected readFile is used', () => {
  const e = buildClaudeEnv({ ...base(), CLAUDE_CODE_OAUTH_TOKEN_FILE: '/x' }, 'subscription', () => TOK);
  assert.strictEqual(e.CLAUDE_CODE_OAUTH_TOKEN, TOK);
});

test('apikey mode ignores the token file', () => {
  const e = buildClaudeEnv({ ...base(), CLAUDE_CODE_OAUTH_TOKEN_FILE: tmpTok(TOK) }, 'apikey');
  assert.strictEqual(e.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('status: token file gives booleans and age only, never the token or path', () => {
  const f = tmpTok(TOK);
  const old = new Date(Date.now() - 125 * 60000); fs.utimesSync(f, old, old);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
  const st = claudeAuthStatus('subscription', { CLAUDE_CODE_OAUTH_TOKEN_FILE: f }, home);
  assert.strictEqual(st.subscription.tokenEnv, true);
  assert.strictEqual(st.subscription.tokenFile.present, true);
  assert.ok(st.subscription.tokenFile.ageMinutes >= 124 && st.subscription.tokenFile.ageMinutes <= 127);
  assert.deepStrictEqual(Object.keys(st.subscription.tokenFile), ['present', 'ageMinutes']);
  const s = JSON.stringify(st);
  assert.ok(!s.includes(TOK) && !s.includes(f));
  const none = claudeAuthStatus('subscription', { CLAUDE_CODE_OAUTH_TOKEN_FILE: tmpTok('bad') }, home);
  assert.deepStrictEqual(none.subscription.tokenFile, { present: false, ageMinutes: null });
  assert.strictEqual(none.subscription.tokenEnv, false);
});
