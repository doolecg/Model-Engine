// Presence-only login detection. Never reads file contents or env values, never runs a CLI.
// Output holds fixed labels only.
const fs = require('fs');
const os = require('os');
const path = require('path');

const has = (env, k) => typeof env[k] === 'string' && env[k].trim() !== '';
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

function onPath(env, platform, name) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const names = platform === 'win32' ? [name, name + '.exe', name + '.cmd', name + '.ps1'] : [name];
  return dirs.some((d) => names.some((n) => exists(path.join(d, n))));
}

function detectAccounts(env = process.env, platform = process.platform, home = os.homedir()) {
  const win = platform === 'win32';
  const homes = [...new Set([home, win ? env.USERPROFILE : ''].filter(Boolean))];
  const anyFile = (...rels) => homes.some((h) => rels.some((r) => exists(path.join(h, ...r))));
  const anyAbs = (...ps) => ps.some((p) => p && exists(p));
  const cli = (...names) => names.some((n) => onPath(env, platform, n));
  const anyEnv = (...ks) => ks.some((k) => has(env, k));
  const dataHome = has(env, 'XDG_DATA_HOME') ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');

  const out = [];
  const add = (id, label, cliFound, login, key, noLoginAuth, token) => {
    const auth = login || token ? 'signed-in' : key ? 'api-key' : noLoginAuth;
    out.push({ id, label, cli: cliFound ? 'found' : 'missing', auth, via: login ? 'login file' : token ? 'environment token' : key ? 'environment' : 'none' });
  };

  const claudeCli = cli('claude');
  add('claude', 'Claude Code', claudeCli,
    anyFile(['.claude', '.credentials.json']),
    anyEnv('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'),
    platform === 'darwin' && claudeCli ? 'unknown' : 'not-found',
    anyEnv('CLAUDE_CODE_OAUTH_TOKEN'));

  add('codex', 'Codex', cli('codex'),
    anyAbs(path.join(has(env, 'CODEX_HOME') ? env.CODEX_HOME : path.join(home, '.codex'), 'auth.json')),
    anyEnv('OPENAI_API_KEY'), 'not-found');

  add('opencode', 'OpenCode', cli('opencode'),
    anyAbs(path.join(dataHome, 'opencode', 'auth.json'), win && env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'opencode', 'auth.json')),
    anyEnv('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'), 'not-found');

  const gem = cli('gemini'), anti = cli('antigravity');
  add('google', 'Google (Gemini CLI / Antigravity)', gem || anti,
    anyFile(['.gemini', 'oauth_creds.json'], ['.config', 'gcloud', 'application_default_credentials.json']) ||
      anyAbs(win && env.APPDATA && path.join(env.APPDATA, 'gcloud', 'application_default_credentials.json')),
    anyEnv('GEMINI_API_KEY', 'GOOGLE_API_KEY'),
    anti && !gem ? 'unknown' : 'not-found');
  return out;
}

module.exports = { detectAccounts };
