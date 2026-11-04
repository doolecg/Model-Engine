// Claude auth mode. Builds the environment for the Claude Code subprocess and reports presence only (booleans, never values or paths).
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODES = ['subscription', 'apikey'];
const LEAKS = ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDECODE', 'CLAUDE_PID'];

function buildClaudeEnv(env, mode = 'subscription') {
  const out = { ...env };
  for (const k of LEAKS) delete out[k];
  if (mode === 'apikey') delete out.CLAUDE_CODE_OAUTH_TOKEN;
  else { delete out.ANTHROPIC_API_KEY; delete out.ANTHROPIC_AUTH_TOKEN; }
  return out;
}

const has = (env, k) => typeof env[k] === 'string' && env[k].trim() !== '';

function claudeAuthStatus(mode, env = process.env, home = os.homedir()) {
  const homes = [...new Set([home, process.platform === 'win32' ? env.USERPROFILE : ''].filter(Boolean))];
  const loginFile = homes.some((h) => { try { return fs.existsSync(path.join(h, '.claude', '.credentials.json')); } catch { return false; } });
  return { mode, subscription: { loginFile, tokenEnv: has(env, 'CLAUDE_CODE_OAUTH_TOKEN') }, apiKeyEnv: has(env, 'ANTHROPIC_API_KEY') || has(env, 'ANTHROPIC_AUTH_TOKEN') };
}

module.exports = { MODES, buildClaudeEnv, claudeAuthStatus };
