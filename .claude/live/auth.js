// Claude auth mode. Builds the environment for the Claude Code subprocess and reports presence only (booleans, never values or paths).
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODES = ['subscription', 'apikey'];
const LEAKS = ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDECODE', 'CLAUDE_PID'];

const TOKEN_RE = /^[A-Za-z0-9._~+\/=-]{20,}$/;
const MAX_TOKEN_FILE = 4096;

// Token synced from the host (scripts/sync-claude-token.js); null unless it is one valid single line.
function readTokenFile(env, readFile = fs.readFileSync) {
  const f = env.CLAUDE_CODE_OAUTH_TOKEN_FILE;
  if (typeof f !== 'string' || f.trim() === '') return null;
  try {
    const raw = String(readFile(f, 'utf8'));
    if (raw.length > MAX_TOKEN_FILE) return null;
    const t = raw.trim();
    return TOKEN_RE.test(t) ? t : null;
  } catch { return null; }
}

function buildClaudeEnv(env, mode = 'subscription', readFile = fs.readFileSync) {
  const out = { ...env };
  for (const k of LEAKS) delete out[k];
  if (mode === 'apikey') delete out.CLAUDE_CODE_OAUTH_TOKEN;
  else {
    delete out.ANTHROPIC_API_KEY; delete out.ANTHROPIC_AUTH_TOKEN;
    const t = readTokenFile(env, readFile);
    if (t) out.CLAUDE_CODE_OAUTH_TOKEN = t;
  }
  return out;
}

const has = (env, k) => typeof env[k] === 'string' && env[k].trim() !== '';

function claudeAuthStatus(mode, env = process.env, home = os.homedir()) {
  const homes = [...new Set([home, process.platform === 'win32' ? env.USERPROFILE : ''].filter(Boolean))];
  const loginFile = homes.some((h) => { try { return fs.existsSync(path.join(h, '.claude', '.credentials.json')); } catch { return false; } });
  const present = readTokenFile(env) !== null;
  let ageMinutes = null;
  if (present) { try { ageMinutes = Math.max(0, Math.floor((Date.now() - fs.statSync(env.CLAUDE_CODE_OAUTH_TOKEN_FILE).mtimeMs) / 60000)); } catch { ageMinutes = null; } }
  return { mode, subscription: { loginFile, tokenEnv: has(env, 'CLAUDE_CODE_OAUTH_TOKEN') || present, tokenFile: { present, ageMinutes } }, apiKeyEnv: has(env, 'ANTHROPIC_API_KEY') || has(env, 'ANTHROPIC_AUTH_TOKEN') };
}

module.exports = { MODES, buildClaudeEnv, claudeAuthStatus };
