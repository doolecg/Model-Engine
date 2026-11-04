// Model Engine live view. node .claude/live/server.js [--open]
// Chat runs on the Claude Agent SDK, the same engine T3 Code uses.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync, execFile } = require('child_process');
const { providers } = require('./providers.js');
const { detectAccounts } = require('./accounts.js');
const { MODES: AUTH_MODES, buildClaudeEnv, claudeAuthStatus } = require('./auth.js');
const { aggregateUsage } = require('./usage.js');
const updater = require('./updater.js');
const remote = require('./remote.js');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.MODEL_ENGINE_PORT) || 4777;
const HOST = process.env.MODEL_ENGINE_HOST || '127.0.0.1';
const STORE = process.env.MODEL_ENGINE_STORE || path.join(__dirname, 'projects.json');
const MODELS = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' };
const rid = () => crypto.randomUUID().slice(0, 8);

const S = {
  calls: 0, verdict: null, opus: 'idle',
  recall: { cg: 0, hs: 0, grep: 0, saved: 0, run: false },
  orch: 'idle', builder: 'idle', orchModel: 'sonnet', council: { ui: 'idle', code: 'idle', run: 'idle' },
  mcpSeen: {}, ondemand: {}, active: {}, busy: false,
};
const clients = new Set();
// Claude sign-in mode: 'subscription' (your Claude login) or 'apikey'. Read at the start of each run, so a change applies to the next run.
let claudeAuth = 'subscription';
// Remote access (Tailscale): settings, in-memory sessions, login rate limit, open remote streams.
const RM = { ...remote.restore(null), creds: null }, sessions = remote.createSessions({ onChange: () => save() }), limiter = remote.createLimiter({ escalate: true }), globalLimiter = remote.createLimiter({ max: 30 }), remoteStreams = new Map();
function dropRemoteSessions() { sessions.clear(); for (const r of remoteStreams.keys()) { try { r.end(); } catch {} } remoteStreams.clear(); }
function pruneRemoteStreams() { for (const [r, h] of remoteStreams) if (!sessions.hasHash(h)) { try { r.end(); } catch {} remoteStreams.delete(r); } }
const sessionCookie = (id, remember) => `me_auth=${id}; HttpOnly; Secure; SameSite=Strict; Path=/${remember ? `; Max-Age=${remote.REMEMBER_MS / 1000}` : ''}`;

function send(type, data) {
  const m = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const c of clients) c.write(m);
}
let CP = null;
function stamp() {
  const s = (Date.now() - (CP ? CP.t0 : Date.now())) / 1000;
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + (s % 60).toFixed(1).padStart(4, '0');
}
function editDiff(a, b) {
  const o = a == null ? [] : String(a).split('\n'), n = String(b == null ? '' : b).split('\n');
  let p = 0;
  while (p < o.length && p < n.length && o[p] === n[p]) p++;
  let s = 0;
  while (s < o.length - p && s < n.length - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s++;
  const c0 = Math.max(0, p - 3), c1 = Math.min(s, 3), out = [];
  for (let i = c0; i < p; i++) out.push('  ' + o[i]);
  for (let i = p; i < o.length - s; i++) out.push('- ' + o[i]);
  for (let i = p; i < n.length - s; i++) out.push('+ ' + n[i]);
  for (let i = o.length - s; i < o.length - s + c1; i++) out.push('  ' + o[i]);
  return out;
}
function buildDiff(t, ti) {
  let parts = [];
  if (t === 'Edit') parts = [editDiff(ti.old_string, ti.new_string)];
  else if (t === 'MultiEdit') parts = (Array.isArray(ti.edits) ? ti.edits : []).map(x => editDiff(x && x.old_string, x && x.new_string));
  else if (t === 'Write') parts = [editDiff(null, ti.content)];
  else if (t === 'NotebookEdit') parts = [editDiff(null, ti.new_source)];
  let lines = [];
  parts.forEach((p, i) => { if (i) lines.push('@@'); lines = lines.concat(p); });
  if (!lines.length) return '';
  let cut = lines.length > 200;
  if (cut) lines = lines.slice(0, 200);
  let text = lines.join('\n');
  if (text.length > 20480) { text = text.slice(0, 20480); cut = true; }
  return cut ? text + '\n… truncated' : text;
}
function log(unit, msg) { if (!CP) return; CP.log.push([stamp(), unit, msg]); if (CP.log.length > 40) CP.log.shift(); }
const normP = (f) => path.resolve(String(f)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
function projectFor(e) {
  const t = !e.cwd && running && threads.get(running);
  if (t) return projects.get(t.project) || null;
  if (!e.cwd) return null;
  const c = normP(e.cwd);
  let best = null;
  for (const p of projects.values()) { const f = normP(p.folder); if ((c === f || c.startsWith(f + '/')) && (!best || f.length > normP(best.folder).length)) best = p; }
  return best;
}
function pulse(wire) { send('pulse', { wire }); }

function loadoutNow() {
  const sk = new Set(), mc = new Set(), home = os.homedir();
  for (const d of [path.join(ROOT, '.claude', 'skills'), path.join(home, '.claude', 'skills')]) {
    try { for (const f of fs.readdirSync(d, { withFileTypes: true })) if (f.isDirectory() && fs.existsSync(path.join(d, f.name, 'SKILL.md'))) sk.add(f.name); } catch {}
  }
  for (const f of [path.join(ROOT, '.mcp.json'), path.join(home, '.claude.json')]) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      Object.keys(j.mcpServers || {}).forEach((k) => mc.add(k));
      const p = j.projects && (j.projects[ROOT] || j.projects[ROOT.replace(/\\/g, '/')]);
      if (p && p.mcpServers) Object.keys(p.mcpServers).forEach((k) => mc.add(k));
    } catch {}
  }
  Object.keys(S.mcpSeen).forEach((k) => mc.add(k));
  return { skills: [...sk].sort(), mcps: [...mc].sort() };
}
let LO = null, LOt = 0;
function loadout() {
  if (!LO || Date.now() - LOt > 20000) { LO = loadoutNow(); LOt = Date.now(); }
  const mc = new Set(LO.mcps); Object.keys(S.mcpSeen).forEach((k) => mc.add(k));
  return { skills: LO.skills, mcps: [...mc].sort() };
}
// on-demand tools: off by default; only the Brain (reviewer) may switch one on, and only if the user allowed it in Settings
const ONDEMAND = { blender: { label: 'Frugal Blender', tools: ['discover', 'inspect', 'execute', 'capture'].map((n) => 'mcp__blender__' + n) } };
function odOff(q) { for (const k of Object.keys(ONDEMAND)) { if (q) try { q.toggleMcpServer(k, false).catch(() => {}); } catch {} } S.ondemand = {}; }
function odSwitch(text) {
  const t = threads.get(running);
  if (!t || !t.q) return;
  for (const m of String(text || '').toLowerCase().matchAll(/^\s*(enable|disable):\s*([\w-]+)/gm)) {
    const on = m[1] === 'enable', k = m[2];
    if (!ONDEMAND[k] || !(t.allow || []).includes(k) || !!S.ondemand[k] === on) continue;
    t.q.toggleMcpServer(k, on).catch(() => {});
    S.ondemand[k] = on; log('opus', (on ? 'enabled ' : 'disabled ') + ONDEMAND[k].label);
  }
}
function view() { const logs = {}; for (const p of projects.values()) logs[p.id] = { log: p.log, changes: p.changes }; return { ...S, logs, loadout: loadout(), repo: ROOT }; }
let pushT = null;
function push() { if (pushT) return; pushT = setTimeout(() => { pushT = null; send('state', { state: view() }); }, 80); }

function who(a) {
  a = (a || '').toLowerCase();
  if (a === 'reviewer') return 'opus';
  if (a === 'recall') return 'recall';
  if (a === 'builder') return 'builder';
  const m = a.match(/^council-(ui|code|run)$/);
  return m ? m[1] : null;
}
function verdict(t) {
  const m = String(t || '').toLowerCase().match(/\b(approve|reject|pass|note|fail)\b/);
  return m ? m[1] : null;
}

function apply(e, fromSdk) {
  CP = fromSdk ? projectFor({}) : projectFor(e);
  const n = e.hook_event_name, ag = who(e.agent_type);
  if (e.hook_event_name === 'SubagentStart' || e.hook_event_name === 'SubagentStop') subHook(e.hook_event_name, e);
  if (n === 'SessionStart') { if (e.source === 'startup') { if (CP) { CP.t0 = Date.now(); CP.log = []; CP.changes = []; } } log('session', e.source || 'start'); }
  else if (n === 'UserPromptSubmit') {
    S.busy = true; S.orch = 'thinking'; S.builder = 'idle'; S.verdict = null; S.active = {};
    S.council = { ui: 'idle', code: 'idle', run: 'idle' };
    log('you', String(e.prompt || '').replace(/\s+/g, ' ').slice(0, 60));
  } else if (n === 'SubagentStart' && ag) {
    if (ag === 'opus') { S.opus = 'awake'; pulse('ask'); log('opus', 'called'); }
    else if (ag === 'builder') { S.builder = 'building'; pulse('build'); log('builder', 'started'); }
    else if (ag === 'recall') { S.recall.run = true; pulse('plan'); log('recall', 'started'); }
    else { S.council[ag] = 'running'; pulse('out:' + ag); log('council', ag + ' started'); }
  } else if (n === 'SubagentStop' && ag) {
    const v = verdict(e.last_assistant_message);
    if (ag === 'opus') { S.opus = 'idle'; S.calls++; S.verdict = v === 'reject' ? 'reject' : v === 'approve' ? 'approve' : null; log('opus', v || 'done'); pulse('verdict'); odSwitch(e.last_assistant_message); }
    else if (ag === 'builder') { S.builder = 'done'; pulse('gate'); log('builder', 'done'); }
    else if (ag === 'recall') { S.recall.run = false; pulse('ctx'); log('recall', 'done'); }
    else { S.council[ag] = v === 'note' ? 'note' : v === 'fail' ? 'fail' : v === 'pass' ? 'pass' : 'done'; pulse('f:' + ag); log('council', ag + ' ' + (v || 'done')); }
  } else if (n === 'PreToolUse') {
    const pm = String(e.tool_name || '').match(/^mcp__(.+?)__/);
    if (pm) S.active[pm[1]] = (S.active[pm[1]] || 0) + 1;
  } else if (n === 'PostToolUse') {
    const t = e.tool_name || '', m = t.match(/^mcp__(.+?)__(.+)$/);
    if (m) {
      S.mcpSeen[m[1]] = Date.now();
      S.active[m[1]] = Math.max(0, (S.active[m[1]] || 1) - 1);
      if (m[1] === 'codegraph') { S.recall.cg++; log('codegraph', m[2].replace('codegraph_', '')); }
      else if (m[1] === 'hindsight') {
        if (/ingest|capture/.test(m[2])) { S.recall.saved++; pulse('commit'); log('hindsight', 'ingest'); }
        else { S.recall.hs++; log('hindsight', 'recall'); }
      }
      if (!ag) pulse('call');
    } else if (t === 'Grep') S.recall.grep++;
    else if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(t) && e.tool_input && (typeof e.tool_input.file_path === 'string' ? e.tool_input.file_path : typeof e.tool_input.notebook_path === 'string' ? e.tool_input.notebook_path : '')) {
      const fp = typeof e.tool_input.file_path === 'string' ? e.tool_input.file_path : e.tool_input.notebook_path, rel = path.relative(e.cwd || ROOT, fp);
      if (CP) {
        CP.changes.push([stamp(), t, rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : fp, buildDiff(t, e.tool_input)]);
        if (CP.changes.length > 60) CP.changes.shift();
        for (let i = 0; i < CP.changes.length - 15; i++) if (CP.changes[i].length > 3) CP.changes[i].length = 3;
      }
    }
    else if (t === 'Skill') { pulse('load'); log('skill', (e.tool_input && e.tool_input.skill) || ''); }
    if (!ag && !m && t !== 'Agent' && t !== 'Task') S.orch = 'writing';
  } else if (n === 'Stop') { const rt = threads.get(running); odOff(rt && rt.q); S.busy = false; S.active = {}; S.orch = 'done?'; log('orchestrator', 'finished'); }
  push();
}

// ---------------- agents and rules (passed through the SDK, so any project folder gets them) ----------------
const MEM = ['mcp__codegraph__codegraph_explore', 'mcp__hindsight__hindsight_search_knowledge_pages', 'mcp__hindsight__hindsight_read_knowledge_page'];
const PW = ['navigate', 'snapshot', 'take_screenshot', 'click', 'type', 'resize', 'wait_for', 'console_messages', 'network_requests', 'evaluate', 'close'].map(n => 'mcp__playwright__browser_' + n);
const PW_RULES = ' Playwright rules: only open pages the project serves (http://127.0.0.1, http://localhost, file:); never external sites or logins; headless, one browser at a time; save screenshots only to the OS temp folder or a docs/ path the task card names; always call browser_close when done; never edit project files.';
const ONE_LINE ='Never edit. Reply with exactly one line: `pass`, `note: <issue>` or `fail: <reason>`.';
const BLENDER_RULES = 'Blender: use the mcp__blender__* tools (Frugal Blender) only if the Brain enabled them this turn, and never run blender.exe yourself. If the bridge is down, say: in Blender, View3D > Sidebar > Frugal MCP, tick Allow python and save, then Start bridge.';
const AGENTS = {
  recall: { description: 'Memory and code lookup. Read-only. Use for every repo search, before planning or building.', model: MODELS.haiku, maxTurns: 12, tools: ['Read', 'Glob', 'Grep', ...MEM],
    prompt: 'Answer with paths and line numbers, one line each. Never edit. Hindsight first for decisions (name the page), then codegraph_explore for code, then Grep or Read only for what it does not index. If a tool is down, say so in one line and carry on.' },
  'council-ui': { description: 'Council 1 of 3. Reviews the UI side of a change. Replies pass, note or fail.', model: MODELS.haiku, maxTurns: 10, tools: ['Read', 'Glob', 'Grep', ...PW],
    prompt: 'Review only the UI: layout, spacing, empty and error states, contrast, keyboard basics, phone, 1080p and 32-inch sizes. If the Playwright tools exist, open the page at 1440x900 and 390x844 and check layout, states and console errors.' + PW_RULES + ' ' + ONE_LINE },
  'council-code': { description: 'Council 2 of 3. Reviews the code side of a change. Replies pass, note or fail.', model: MODELS.haiku, maxTurns: 10, tools: ['Read', 'Glob', 'Grep', 'mcp__codegraph__codegraph_explore'],
    prompt: 'Review only the code: bugs, edge cases, error handling, style, and callers of changed symbols (codegraph_explore). ' + ONE_LINE },
  'council-run': { description: 'Council 3 of 3. Runs the tests and starts the app once. Replies pass, note or fail.', model: MODELS.haiku, maxTurns: 12, tools: ['Bash', 'Read', 'Glob', 'Grep', ...PW],
    prompt: 'Run the test suite once and start the app or build once if there is one. Filter output with head, tail or grep. One build or test run at a time. After tests, start the app only if the task card says how, load it with Playwright, check the console for errors and that the main view renders, then stop what you started by PID.' + PW_RULES + ' Never edit. Reply with exactly one line: `pass: <N> tests`, `note: <issue>` or `fail: <first failing error, one line>`.' },
  builder: { description: 'Builds one step of a project to a task card. The only agent that edits project files. Runs its own check before reporting.', model: MODELS.sonnet, maxTurns: 40, tools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep', 'mcp__codegraph__codegraph_explore', ...ONDEMAND.blender.tools],
    prompt: 'You build exactly the step you are given, in the files you are given, nothing more. Match the surrounding code style. Run the check for the step (build, test or run) before reporting. Never fake success: no stubs, no skipped or weakened tests, no hardcoded results. If blocked, reply BLOCKED with the reason instead of improvising. Reply with DONE, what you changed (paths) and what you ran. ' + BLENDER_RULES },
  reviewer: { description: 'Opus gate. Reads the plan or the final diff plus council findings, answers approve or reject, commits the handoff to memory after an approve.', model: MODELS.opus, maxTurns: 6, tools: ['Read', 'mcp__hindsight__hindsight_search_knowledge_pages', 'mcp__hindsight__hindsight_ingest_document'],
    prompt: 'You get a plan, or a final diff with the council findings. Reject if it contradicts a recorded Hindsight decision. Reply with exactly one line: `approve` or `reject: <reason>`. Never write code. If the plan needs an on-demand tool (Blender work), add a line `enable: blender` with a one-line reason after your approve or reject; when a step is finished and the tool is no longer needed add `disable: blender`; never enable a tool the plan does not need. After an approve of a final diff only, ingest one short Hindsight document titled "Handoff: <project> <date>" (done, next, file paths, decisions); after the same error twice, ingest a "Lesson: <topic>" document.' },
};
const skillBody = (n) => { try { return '\n\n' + fs.readFileSync(path.join(ROOT, '.claude', 'skills', n, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim(); } catch { return ''; } };
for (const [a, k] of Object.entries({ recall: 'engine-recall', 'council-ui': 'engine-ui-review', 'council-code': 'engine-code-review', 'council-run': 'engine-run-check', builder: 'engine-builder', reviewer: 'engine-brain' })) AGENTS[a].prompt += skillBody(k);
const ENGINE_RULES = `You are the orchestrator: you talk to the user and coordinate. You do not edit project files yourself. For any real project work, delegate one step at a time to the builder agent with a short task card (task, files, done check). Every repo search goes to the recall agent. Every test run goes to council-run; before "done" also call council-ui and council-code on the diff. Ask the reviewer (the Brain, Opus) before a plan locks, after the same error twice, and before saying done, passing the plan or the final diff plus council findings; on reject, send the fix back to the builder and ask again. Chat, questions and planning talk need no agents. Max 3 subagents at once, one build or test run at a time. On-demand tools (mcp__blender__*, Frugal Blender) are off unless the reviewer enabled them this turn; never use them otherwise. For Blender work use only the Frugal Blender tools, never blender.exe. If the bridge is down tell the user: View3D > Sidebar > Frugal MCP, tick Allow python and save, Start bridge.`;
const PLAN_RULES = `You are the Brain, planning a project with the user. Use the recall agent to look things up. Interview the user, then write PLAN.md in the project folder with these sections: Goal; References (links, files, examples, with why each matters); Deliverables (what must be made); Done looks like (checkable, per deliverable); Build order (numbered steps, each with its own done check). You may write only PLAN.md and files under docs/. Do not write code. You only plan. Never start building, never offer to build, and never ask the user whether to send the plan to build. Do not call or suggest the builder or council. Never use mcp__blender__* tools; for Blender work use only the Frugal Blender tools later, never blender.exe. When PLAN.md is written or updated, reply with one short line: that the plan is saved and the user can press "Push to Engine" when ready, then stop.`;
const HOOKS = {};
for (const ev of ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse', 'Stop']) {
  HOOKS[ev] = [{ hooks: [async (input) => { try { apply(input, true); } catch {} return {}; }] }];
}

// ---------------- projects and chat threads (Agent SDK) ----------------
const projects = new Map(), threads = new Map(), pending = new Map();
let running = null, cmds = [], sdk = null, prefetching = false;
const SDK = async () => sdk || (sdk = await import('@anthropic-ai/claude-agent-sdk'));
const PROVIDERS = ['claude', 'codex', 'opencode', 'antigravity'];
const PROVIDER_MODELS = { codex: ['default', 'gpt-5-codex', 'gpt-5'], opencode: ['default', 'anthropic/claude-sonnet-4-5', 'openai/gpt-5'] };
const USAGE_CAP = 5000;
let usageRows = [];
const tmeta = (t) => ({ id: t.id, project: t.project, kind: t.kind, mode: t.mode, model: t.model, effort: t.effort, provider: t.provider || 'claude', running: t.running });
const pmeta = (p) => ({ id: p.id, name: p.name, folder: p.folder, planThread: p.planThread, engineThread: p.engineThread });
const sendProjects = () => { send('projects', { list: [...projects.values()].map(pmeta) }); send('threads', { list: [...threads.values()].map(tmeta) }); };
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const out = [...projects.values()].map((p) => ({ ...pmeta(p), log: p.log, changes: p.changes.map((c, i, a) => (i < a.length - 10 ? c.slice(0, 3) : c)), threads: [p.planThread, p.engineThread].map((id) => { const t = threads.get(id); return { ...tmeta(t), running: false, sessionId: t.sessionId, sessions: t.sessions || {}, items: t.items.filter((i) => i.kind !== 'perm' || i.status !== 'pending').slice(-200) }; }) }));
      fs.writeFileSync(STORE, JSON.stringify({ projects: out, usage: usageRows, updates: UPD.settings, claudeAuth, remote: { enabled: RM.enabled, host: RM.host, salt: RM.salt, hash: RM.hash, creds: RM.creds, sessions: sessions.dump() } }));
    } catch {}
  }, 400);
}
function mkThread(pid, kind) {
  const plan = kind === 'plan';
  const t = { id: rid(), project: pid, kind, sessionId: null, mode: 'default', model: plan ? 'opus' : 'sonnet', effort: 'medium', provider: 'claude', sessions: {}, items: [], running: false };
  threads.set(t.id, t); return t;
}
function recordUsage(t, provider, model, u) {
  usageRows.push({ ts: Date.now(), run: t.runId, project: t.project, thread: t.id, provider, model: model || 'unknown', in: u.in || 0, out: u.out || 0, cacheR: u.cacheR || 0, cacheW: u.cacheW || 0, cost: Number.isFinite(u.cost) ? u.cost : 0 });
  if (usageRows.length > USAGE_CAP) usageRows = usageRows.slice(-USAGE_CAP);
  save();
}
function newProject(folder, name) {
  const p = { id: rid(), name: name || path.basename(folder), folder, log: [], changes: [], t0: Date.now() };
  p.planThread = mkThread(p.id, 'plan').id; p.engineThread = mkThread(p.id, 'engine').id;
  projects.set(p.id, p); sendProjects(); save(); return p;
}
function load() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    if (!Array.isArray(data) && Array.isArray(data.usage)) usageRows = data.usage.slice(-USAGE_CAP);
    if (!Array.isArray(data)) Object.assign(UPD.settings, updSettings(data.updates) || {});
    if (!Array.isArray(data)) { Object.assign(RM, remote.restore(data.remote)); RM.creds = remote.restoreCreds(data.remote && data.remote.creds); sessions.load(data.remote && data.remote.sessions); }
    if (!Array.isArray(data) && AUTH_MODES.includes(data.claudeAuth)) claudeAuth = data.claudeAuth;
    for (const p of Array.isArray(data) ? data : data.projects || []) {
      if (!fs.existsSync(p.folder)) continue;
      projects.set(p.id, { id: p.id, name: p.name, folder: p.folder, planThread: p.planThread, engineThread: p.engineThread, log: Array.isArray(p.log) ? p.log.slice(-40) : [], changes: Array.isArray(p.changes) ? p.changes.slice(-60) : [], t0: Date.now() });
      for (const t of p.threads) threads.set(t.id, { ...t, provider: t.provider || 'claude', sessions: t.sessions || {}, running: false, items: (t.items || []).map((i) => (i.live ? { ...i, live: false } : i)) });
    }
  } catch {}
  if (!projects.size) newProject(ROOT, 'Model Engine');
}
const add = (t, item) => { item.id = item.id || rid(); t.items.push(item); send('chat', { thread: t.id, op: 'add', item }); save(); return item; };
const upd = (t, id, patch) => { const i = t.items.find((x) => x.id === id); if (i) { Object.assign(i, patch); send('chat', { thread: t.id, op: 'upd', id, patch }); save(); } };
const delta = (t, id, text) => { const i = t.items.find((x) => x.id === id); if (i) { i.text += text; send('chat', { thread: t.id, op: 'delta', id, text }); } };
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text || '').join('') : '');

function inside(folder, rel) {
  const full = path.resolve(folder, rel || '.');
  return full === folder || full.startsWith(folder + path.sep) ? full : null;
}
// The plan chat may write only PLAN.md and docs/**.
function planWriteOk(t, name, input) {
  if (!/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return null;
  const f = input && (input.file_path || input.notebook_path);
  const folder = projects.get(t.project).folder, full = f && inside(folder, path.isAbsolute(f) ? path.relative(folder, f) : f);
  if (!full) return false;
  const rel = path.relative(folder, full).replace(/\\/g, '/');
  return rel === 'PLAN.md' || rel.startsWith('docs/');
}
function askPerm(t, name, input, o) {
  if (t.kind === 'plan') {
    const ok = planWriteOk(t, name, input);
    if (ok === true) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    if (ok === false) return Promise.resolve({ behavior: 'deny', message: 'The plan chat may only write PLAN.md and files under docs/.' });
  }
  return new Promise((resolve) => {
    const item = add(t, { kind: 'perm', name, input, status: 'pending', reason: (o && (o.title || o.decisionReason)) || '' });
    pending.set(item.id, { resolve, input, o, t });
    if (o && o.signal) o.signal.addEventListener('abort', () => { if (pending.delete(item.id)) { upd(t, item.id, { status: 'denied' }); resolve({ behavior: 'deny', message: 'aborted' }); } });
  });
}
function answerPerm(id, allow, always, message) {
  const p = pending.get(id); if (!p) return false;
  pending.delete(id);
  if (allow) { p.resolve({ behavior: 'allow', updatedInput: p.input, ...(always && p.o && p.o.suggestions ? { updatedPermissions: p.o.suggestions } : {}) }); upd(p.t, id, { status: always ? 'always' : 'allowed' }); }
  else { p.resolve({ behavior: 'deny', message: message || 'Denied in the dashboard' }); upd(p.t, id, { status: 'denied' }); }
  return true;
}

function curThread() { return running && threads.get(running); }
const subTimers = new Map();
function subSend(t, s) {
  clearTimeout(subTimers.get(s.id));
  subTimers.set(s.id, setTimeout(() => send('sub', { thread: t.id, sub: { ...s, items: s.items.slice(-40) } }), 120));
}
function sumInput(i) { i = i || {}; return String(i.command || i.file_path || i.pattern || i.path || i.query || i.skill || i.url || i.subagent_type || '').slice(0, 120); }
function newSub(t, b) {
  t.subs = t.subs || [];
  if (t.subs.find((x) => x.id === b.id)) return;
  const i = b.input || {};
  const s = { id: b.id, type: i.subagent_type || 'agent', desc: String(i.description || '').slice(0, 120), prompt: String(i.prompt || '').slice(0, 800), status: 'running', items: [], started: Date.now() };
  t.subs.push(s); if (t.subs.length > 30) t.subs.shift(); subSend(t, s);
}
function readTranscript(p) {
  try {
    const items = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const c = o.message && o.message.content; if (!Array.isArray(c) || o.type !== 'assistant') continue;
      for (const b of c) { if (b.type === 'text' && b.text) items.push({ k: 'text', text: b.text.slice(0, 400) }); else if (b.type === 'tool_use') items.push({ k: 'tool', id: b.id, name: b.name, sum: sumInput(b.input), status: 'ok' }); }
    }
    return items.slice(-40);
  } catch { return []; }
}
function subHook(n, e) {
  const t = curThread(); if (!t) return;
  t.subs = t.subs || [];
  if (n === 'SubagentStart') {
    let s = t.subs.find((x) => x.type === e.agent_type && !x.agentId && x.status === 'running');
    if (s) s.agentId = e.agent_id;
    else { s = { id: e.agent_id, agentId: e.agent_id, type: e.agent_type, desc: '', prompt: '', status: 'running', items: [], started: Date.now() }; t.subs.push(s); if (t.subs.length > 30) t.subs.shift(); }
    subSend(t, s);
  } else {
    const s = t.subs.find((x) => x.agentId === e.agent_id) || t.subs.find((x) => x.type === e.agent_type && x.status === 'running');
    if (!s) return;
    s.status = 'done'; s.ended = Date.now(); s.result = String(e.last_assistant_message || s.result || '').slice(0, 2000);
    if (!s.items.length && e.agent_transcript_path) s.items = readTranscript(e.agent_transcript_path);
    subSend(t, s);
  }
}
function subStream(t, m) {
  const s = (t.subs || []).find((x) => x.id === m.parent_tool_use_id);
  const c = m.message && m.message.content;
  if (!s || !Array.isArray(c)) return;
  if (m.type === 'assistant') for (const b of c) { if (b.type === 'text' && b.text) s.items.push({ k: 'text', text: b.text.slice(0, 400) }); else if (b.type === 'tool_use') s.items.push({ k: 'tool', id: b.id, name: b.name, sum: sumInput(b.input), status: 'running' }); }
  else if (m.type === 'user') for (const b of c) if (b.type === 'tool_result') { const it = s.items.find((x) => x.id === b.tool_use_id); if (it) it.status = b.is_error ? 'err' : 'ok'; }
  subSend(t, s);
}

function handle(t, m) {
  if (m.parent_tool_use_id) { subStream(t, m); return; }
  if (m.type === 'system' && m.subtype === 'init') { t.sessionId = m.session_id; save(); }
  else if (m.type === 'stream_event') {
    const e = m.event || {};
    if (e.type === 'message_start') { t.liveIdx = {}; t.liveQ = { text: [], thinking: [] }; }
    else if (e.type === 'content_block_start' && e.content_block && (e.content_block.type === 'text' || e.content_block.type === 'thinking')) {
      const k = e.content_block.type, it = add(t, { kind: k, text: '', live: true });
      (t.liveIdx = t.liveIdx || {})[e.index] = it.id; (t.liveQ = t.liveQ || { text: [], thinking: [] })[k].push(it.id);
    } else if (e.type === 'content_block_delta' && t.liveIdx && t.liveIdx[e.index]) {
      const d = e.delta || {}, tx = d.text || d.thinking || '';
      if (tx) delta(t, t.liveIdx[e.index], tx);
    }
  } else if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
    for (const b of m.message.content) {
      if (b.type === 'text' || b.type === 'thinking') {
        const q = t.liveQ && t.liveQ[b.type], id = q && q.shift(), text = b.type === 'text' ? b.text : b.thinking;
        if (id) upd(t, id, { text, live: false }); else if (text) add(t, { kind: b.type, text });
      } else if (b.type === 'tool_use') { add(t, { id: b.id, kind: 'tool', name: b.name, input: b.input, status: 'running' }); if (b.name === 'Agent' || b.name === 'Task') newSub(t, b); }
    }
  } else if (m.type === 'user' && m.message && Array.isArray(m.message.content)) {
    for (const b of m.message.content) if (b.type === 'tool_result') {
      upd(t, b.tool_use_id, { status: b.is_error ? 'err' : 'ok', result: textOf(b.content).slice(0, 800) });
      const sb = (t.subs || []).find((x) => x.id === b.tool_use_id);
      if (sb && !/^Async agent launched/i.test(textOf(b.content))) { sb.status = 'done'; sb.ended = Date.now(); sb.result = textOf(b.content).slice(0, 2000); subSend(t, sb); }
    }
  } else if (m.type === 'result') {
    add(t, { kind: 'meta', text: `${m.subtype || 'done'} · ${((m.duration_ms || 0) / 1000).toFixed(1)}s · $${(m.total_cost_usd || 0).toFixed(3)}` });
    const mu = Object.entries(m.modelUsage || {});
    if (mu.length) for (const [name, u] of mu) recordUsage(t, 'claude', name, { in: u.inputTokens, out: u.outputTokens, cacheR: u.cacheReadInputTokens, cacheW: u.cacheCreationInputTokens, cost: u.costUSD });
    else if (m.usage) recordUsage(t, 'claude', MODELS[t.model] || t.model, { in: m.usage.input_tokens, out: m.usage.output_tokens, cacheR: m.usage.cache_read_input_tokens, cacheW: m.usage.cache_creation_input_tokens, cost: m.total_cost_usd });
    if (m.is_error && m.result) add(t, { kind: 'err', text: String(m.result) });
  }
}

async function runCliThread(t, proj, text, ac) {
  const prov = t.provider, p = providers[prov];
  if (!p) { add(t, { kind: 'err', text: `${prov} is not available yet.` }); return; }
  const model = t.model && t.model !== 'default' && (PROVIDER_MODELS[prov] || []).includes(t.model) ? t.model : undefined;
  const r = await p.run({
    cwd: proj.folder, text, model, sessionId: t.sessions[prov], signal: ac.signal,
    onEvent: (e) => {
      if (e.kind === 'text') add(t, { kind: 'text', text: e.text });
      else if (e.kind === 'tool') add(t, { kind: 'tool', name: e.name, input: e.input, status: e.ok ? 'ok' : 'err', result: String(e.output || '').slice(0, 800) });
      else if (e.kind === 'error') add(t, { kind: 'err', text: e.message });
    },
  });
  if (r.sessionId) { t.sessions[prov] = r.sessionId; save(); }
  const u = r.usage || {};
  add(t, { kind: 'meta', text: `${prov} done` });
  recordUsage(t, prov, model || 'default', u);
}

async function runThread(t, text, atts, allow, label) {
  if (running) return false;
  const proj = projects.get(t.project);
  running = t.id; t.running = true; S.orchModel = t.model; sendProjects();
  add(t, { kind: 'user', text, ...(label ? { label } : {}), atts: (atts || []).map((a) => ({ name: a.name, type: a.type })) });
  const ac = new AbortController(); t.ac = ac; t.runId = rid();
  try {
    if (t.provider && t.provider !== 'claude') { await runCliThread(t, proj, text, ac); return true; }
    const { query } = await SDK();
    const content = [];
    for (const a of atts || []) {
      if (a.type.startsWith('image/')) content.push({ type: 'image', source: { type: 'base64', media_type: a.type, data: a.data } });
      else if (a.type === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: a.type, data: a.data } });
      else content.push({ type: 'text', text: `File ${a.name}:\n\`\`\`\n${Buffer.from(a.data, 'base64').toString('utf8').slice(0, 200000)}\n\`\`\`` });
    }
    content.push({ type: 'text', text });
    const msg = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
    async function* one() { yield msg; }
    const q = query({
      prompt: one(),
      options: {
        cwd: proj.folder, model: MODELS[t.model] || t.model, permissionMode: t.mode, allowDangerouslySkipPermissions: true,
        settingSources: ['user', 'project', 'local'], includePartialMessages: true, abortController: ac, env: buildClaudeEnv(process.env, claudeAuth),
        agents: t.kind === 'plan' ? { recall: AGENTS.recall } : AGENTS, hooks: HOOKS, canUseTool: (n, i, o) => askPerm(t, n, i, o),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: t.kind === 'plan' ? PLAN_RULES : ENGINE_RULES },
        ...(t.effort ? { effort: t.effort } : {}), ...(t.sessionId ? { resume: t.sessionId } : {}),
      },
    });
    t.q = q; t.allow = Array.isArray(allow) ? allow.filter((k) => ONDEMAND[k]) : []; odOff(q);
    q.supportedCommands().then((c) => { if (c && c.length) { cmds = c; send('commands', { list: cmds }); } }).catch(() => {});
    for await (const m of q) handle(t, m);
  } catch (er) {
    if (!ac.signal.aborted) add(t, { kind: 'err', text: String((er && er.message) || er) });
    else add(t, { kind: 'meta', text: 'stopped' });
  } finally {
    for (const [id, p] of pending) if (p.t === t) answerPerm(id, false, false, 'run ended');
    for (const s of t.subs || []) if (s.status === 'running') { s.status = 'done'; s.ended = Date.now(); subSend(t, s); }
    t.running = false; t.q = null; t.ac = null; running = null; S.ondemand = {};
    if (S.orch === 'thinking' || S.orch === 'writing') S.orch = 'done?';
    if (S.builder === 'building') S.builder = 'idle';
    S.busy = false; push(); sendProjects(); save();
  }
  return true;
}

async function prefetch() {
  if (cmds.length || prefetching) return;
  prefetching = true;
  try {
    const { query } = await SDK();
    const ac = new AbortController();
    async function* never() { await new Promise(() => {}); }
    const q = query({ prompt: never(), options: { cwd: ROOT, settingSources: ['user', 'project', 'local'], abortController: ac, env: buildClaudeEnv(process.env, claudeAuth) } });
    cmds = await q.supportedCommands();
    ac.abort();
    send('commands', { list: cmds });
  } catch {} finally { prefetching = false; }
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' };
const SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '__pycache__', '.trash']);
const json = (res, o, code) => { res.writeHead(code || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const done = (res, code) => { res.writeHead(code || 204); res.end(); };
function body(req, cb, limit) {
  let b = '', over = false;
  req.on('data', (d) => { if (b.length < (limit || 2e6)) b += d; else over = true; });
  req.on('end', () => { if (over) return cb(null); try { cb(JSON.parse(b || '{}')); } catch { cb(null); } });
}

const NATIVE_PICKER = process.platform === 'win32' && !fs.existsSync('/.dockerenv') && process.env.MODEL_ENGINE_HOST !== '0.0.0.0';
const PICK_SCRIPT = "Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
  + "$o = New-Object System.Windows.Forms.Form; $o.TopMost = $true; $o.ShowInTaskbar = $false; $o.Opacity = 0; $o.StartPosition = 'CenterScreen'; $o.Show(); $o.Activate(); "
  + "$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose a project folder'; $d.ShowNewFolderButton = $true; "
  + "if ($d.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }; $o.Close()";
let picking = null;
const IN_DOCKER = process.env.MODEL_ENGINE_IN_DOCKER === '1' || fs.existsSync('/.dockerenv'), WORKSPACE = '/workspace';
// In Docker the folder picker is confined to /workspace (symlinks resolved); null = not allowed.
function fsAllowed(p) {
  if (!IN_DOCKER) return path.resolve(p);
  let full = path.resolve(WORKSPACE, p || '.');
  try { full = fs.realpathSync(full); } catch {}
  return full === WORKSPACE || full.startsWith(WORKSPACE + '/') ? full : null;
}

// ---------------- updates (logic in updater.js; nothing here runs unless the user or the settings ask) ----------------
const UPD = { settings: { channel: 'stable', check: true, install: false }, cache: {}, working: false };
const idle = () => !S.busy && !running && ![...threads.values()].some((t) => t.running);
const updBlock = () => updater.refusal({ root: ROOT, busy: !idle() });
// keeps only valid fields; strict = null when a given field is invalid
function updSettings(b, strict) {
  if (!b || typeof b !== 'object') return null;
  const out = {};
  if (b.channel === 'stable' || b.channel === 'dev') out.channel = b.channel; else if (strict && b.channel !== undefined) return null;
  for (const k of ['check', 'install']) { if (typeof b[k] === 'boolean') out[k] = b[k]; else if (strict && b[k] !== undefined) return null; }
  return out;
}
// at most one GitHub call per hour per channel; any failure is quiet and shows as "could not check"
async function updCheck() {
  const ch = UPD.settings.channel, c = UPD.cache[ch] || (UPD.cache[ch] = { at: 0, latest: null, error: false });
  if (c.at && Date.now() - c.at < 3600e3) return;
  c.at = Date.now();
  try { c.latest = await updater.checkLatest(ch); c.error = false; } catch { c.latest = null; c.error = true; }
}
function updStatus() {
  const ch = UPD.settings.channel, c = UPD.cache[ch] || { at: 0, latest: null, error: false }, inst = updater.readVersion(__dirname), block = updBlock();
  const l = c.latest, available = updater.isAvailable(ch, inst, l);
  const message = c.error ? 'Could not check' : !c.at ? 'Not checked yet' : !l ? (ch === 'dev' ? 'No dev branch yet' : 'No release yet') : available ? 'Update available: ' + l.version : 'Up to date';
  return {
    channel: ch, installed: { version: inst.version, ref: inst.ref, channel: inst.channel },
    latest: l ? { version: l.version, ref: l.ref, notes: l.notes, url: l.url } : null,
    available, canUpdate: !block, reason: block ? block.message : null, blocked: block ? block.kind : null,
    message, error: c.error, lastChecked: c.at || null, hasBackup: !!updater.backupInfo(ROOT), working: UPD.working,
    auto: { check: UPD.settings.check, install: UPD.settings.install },
  };
}
const updFail = (message, code) => Object.assign(new Error(message), { code });
// Download, verify and swap the program files. The caller restarts the server after replying.
async function updInstall() {
  if (UPD.working) throw updFail('Another update action is running.', 409);
  const block = updBlock();
  if (block) throw updFail(block.message, 409);
  if (!updStatus().available) throw updFail('No update available. Check for updates first.', 409);
  UPD.working = true;
  try { return await updater.applyUpdate({ root: ROOT, latest: UPD.cache[UPD.settings.channel].latest, channel: UPD.settings.channel, busy: !idle() }); }
  catch (er) { throw updFail(er.message, 500); }
  finally { UPD.working = false; }
}
function updRestart() {
  save();
  setTimeout(() => {
    try { updater.respawn({ root: ROOT }); } catch { return; }
    setTimeout(() => process.exit(0), 100);
  }, 900);
}
async function updAuto() {
  const b = updBlock();
  if (!UPD.settings.check || (b && b.kind !== 'busy')) return;
  await updCheck();
  if (UPD.settings.install) updInstall().then(updRestart).catch(() => {});
}

async function remoteStatus() {
  const ts = await remote.detectTailscale({ execFile, exists: (c) => fs.existsSync(c) });
  return { enabled: RM.enabled, host: RM.host, tokenSet: !!RM.hash, tailscale: { installed: ts.installed, running: ts.running, dnsName: ts.dnsName }, publishCommand: remote.publishCommand(PORT), credentials: { username: RM.creds ? RM.creds.username : null, set: !!RM.creds }, sessions: sessions.list() };
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin, host = req.headers.host, loopback = remote.isLoopbackHost(host, PORT);
  let isRemote = false;
  if (loopback && !remote.isProxied(req.headers)) {
    if (origin !== undefined && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) { res.writeHead(403); return res.end(); }
  } else if (!loopback && RM.enabled && remote.isAllowedRemoteHost(host, RM.host)) {
    if (origin !== undefined && !remote.isAllowedRemoteOrigin(origin, RM.host)) { res.writeHead(403); return res.end(); }
    isRemote = true;
  } else { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, 'http://x'), u = url.pathname, q = url.searchParams;
  if (isRemote) {
    const cookieId = remote.parseCookie(req.headers.cookie, 'me_auth'), chk = sessions.check(cookieId), authed = !!chk;
    if (chk && chk.slid) res.setHeader('set-cookie', sessionCookie(cookieId, chk.remember));
    if (u === '/auth/ping' && req.method === 'GET') return json(res, { ok: true, authed });
    if (u === '/auth/login' && req.method === 'POST') {
      const tsUser = req.headers['tailscale-user-login'];
      const key = (typeof tsUser === 'string' && tsUser ? tsUser.toLowerCase() : req.socket.remoteAddress) || '?';
      return body(req, (b) => {
        const wait = Math.max(limiter.retry(key), globalLimiter.retry('*'));
        if (wait) { res.setHeader('retry-after', wait); return json(res, { error: 'too many attempts' }, 429); }
        const byToken = !!b && typeof b.token === 'string';
        const good = byToken ? remote.verifyToken(b.token, RM) : !!b && remote.verifyCredentials(b.username, b.secret, RM.creds);
        if (!good) { limiter.fail(key); globalLimiter.fail('*'); return json(res, { error: byToken ? 'bad token' : 'Wrong username or password' }, 401); }
        limiter.reset(key);
        const remember = b.remember === true;
        res.setHeader('set-cookie', sessionCookie(sessions.create({ remember, label: remote.deviceLabel(req.headers['user-agent']) }), remember));
        json(res, { ok: true });
      }, 4096);
    }
    if (!authed) {
      if (req.method === 'GET' && (u === '/' || u === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'" });
        return res.end(remote.LOGIN_PAGE);
      }
      return json(res, { error: 'sign in required' }, 401);
    }
    if (u.startsWith('/remote/') || (req.method === 'POST' && ['/fs/pick', '/update/apply', '/update/rollback', '/update/settings', '/claude/auth'].includes(u))) return json(res, { error: 'only from the PC itself' }, 403);
  } else if (u.startsWith('/auth/')) { res.writeHead(404); return res.end(); }
  if (u === '/remote/credentials' && req.method === 'DELETE') return body(req, () => {
    RM.creds = null; dropRemoteSessions(); save();
    remoteStatus().then((st) => json(res, st)).catch(() => json(res, { error: 'status failed' }, 500));
  });
  if (req.method === 'GET' && u === '/remote/status') {
    res.setHeader('cache-control', 'no-store');
    return remoteStatus().then((st) => json(res, st)).catch(() => json(res, { error: 'status failed' }, 500));
  }
  if (req.method === 'GET' && (u === '/'|| u === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  if (req.method === 'GET' && u.startsWith('/fonts/')) {
    const FONTS = path.join(__dirname, 'fonts'), name = u.slice(7);
    let ok = false;
    try { ok = /^[\w.-]+$/.test(name) && /\.woff2$|^OFL\.txt$/.test(name) && fs.readdirSync(FONTS).includes(name); } catch {}
    if (!ok) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': name === 'OFL.txt' ? 'text/plain; charset=utf-8' : 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' });
    return res.end(fs.readFileSync(path.join(FONTS, name)));
  }
  if (req.method === 'GET' && u === '/about') {
    let version = '0.0.0';
    try { version = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch {}
    return json(res, { version, port: PORT, root: path.basename(ROOT), node: process.version, nativePicker: NATIVE_PICKER });
  }
  if (req.method === 'GET' && u === '/update/status') return json(res, updStatus());
  if (req.method === 'GET' && u === '/ondemand') return json(res, Object.entries(ONDEMAND).map(([name, o]) => ({ name, label: o.label })));
  if (req.method === 'GET' && u === '/usage') return json(res, aggregateUsage(usageRows));
  if (req.method === 'GET' && u === '/accounts') {
    res.setHeader('cache-control', 'no-store');
    return json(res, { accounts: detectAccounts(), ...(IN_DOCKER ? { note: 'Logins on the host are not visible inside Docker. Use CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in .env.' } : {}) });
  }
  if (req.method === 'GET' && u === '/claude/auth') {
    res.setHeader('cache-control', 'no-store');
    return json(res, claudeAuthStatus(claudeAuth));
  }
  if (req.method === 'POST' && u === '/claude/auth') return body(req, (b) => {
    if (!b || !AUTH_MODES.includes(b.mode)) return json(res, { error: 'bad mode' }, 400);
    claudeAuth = b.mode; save(); json(res, claudeAuthStatus(claudeAuth));
  }, 4096);
  if (req.method === 'GET' && u === '/providers') {
    const onPath = (n) => { const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [n], { encoding: 'utf8', windowsHide: true }); return r.status === 0 && !!(r.stdout || '').trim(); };
    return json(res, PROVIDERS.map((name) => ({ name, available: name === 'claude' || (!!providers[name] && onPath(name)), models: name === 'claude' ? Object.keys(MODELS) : PROVIDER_MODELS[name] || [] })));
  }
  if (req.method === 'GET' && u === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const w = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    w({ type: 'state', state: view() });
    w({ type: 'projects', list: [...projects.values()].map(pmeta) });
    w({ type: 'threads', list: [...threads.values()].map(tmeta) });
    for (const t of threads.values()) w({ type: 'items', thread: t.id, items: t.items });
    for (const t of threads.values()) w({ type: 'subs', thread: t.id, list: (t.subs || []).map((s) => ({ ...s, items: s.items.slice(-40) })) });
    if (cmds.length) w({ type: 'commands', list: cmds });
    clients.add(res); if (isRemote) remoteStreams.set(res, sessions.hashOf(remote.parseCookie(req.headers.cookie, 'me_auth')));
    req.on('close', () => { clients.delete(res); remoteStreams.delete(res); });
    prefetch();
    return;
  }
  if (req.method === 'GET' && u === '/fs') {
    let raw = q.get('path') || ''; const home = os.homedir();
    const quick = [['home', home], ['desktop', path.join(home, 'Desktop')], ['documents', path.join(home, 'Documents')], ['repos', path.dirname(ROOT)]]
      .filter((x) => fs.existsSync(x[1])).map((x) => ({ name: x[0], path: x[1] }));
    if (IN_DOCKER) quick.splice(0, quick.length, { name: 'workspace', path: WORKSPACE });
    if (!raw && IN_DOCKER) raw = WORKSPACE;
    if (!raw) {
      const drives = [];
      for (let c = 65; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; if (fs.existsSync(d)) drives.push({ name: d, path: d }); }
      return json(res, { path: '', parent: null, dirs: drives, quick });
    }
    const full = fsAllowed(raw);
    if (!full) return json(res, { error: 'outside workspace' }, 403);
    try {
      if (!fs.statSync(full).isDirectory()) return json(res, { error: 'not a folder' }, 400);
      const dirs = fs.readdirSync(full, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('$') && d.name !== 'System Volume Information')
        .map((d) => ({ name: d.name, path: path.join(full, d.name) })).sort((a, b) => a.name.localeCompare(b.name));
      const par = path.dirname(full);
      return json(res, { path: full, parent: par === full || (IN_DOCKER && full === WORKSPACE) ? '' : par, dirs, quick });
    } catch (er) { return json(res, { error: String(er.message) }, 403); }
  }
  if (req.method === 'GET' && (u === '/files' || u === '/file' || u === '/attach')) {
    const p = projects.get(q.get('project')); if (!p) return done(res, 404);
    const full = inside(p.folder, q.get('path') || '');
    if (!full || !fs.existsSync(full)) return done(res, 404);
    try {
      const rf = fs.realpathSync(p.folder), rt = fs.realpathSync(full);
      if (rt !== rf && !rt.startsWith(rf.endsWith(path.sep) ? rf : rf + path.sep)) return done(res, 403);
    } catch { return done(res, 403); }
    try {
      if (u === '/files') {
        const list = fs.readdirSync(full, { withFileTypes: true }).filter((d) => !SKIP.has(d.name)).map((d) => ({ name: d.name, dir: d.isDirectory() }))
          .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
        return json(res, { list });
      }
      const st = fs.statSync(full), ext = path.extname(full).toLowerCase();
      if (u === '/attach') {
        if (st.size > 8e6) return json(res, { error: 'too big' }, 413);
        return json(res, { name: path.basename(full), type: MIME[ext] || 'text/plain', data: fs.readFileSync(full).toString('base64') });
      }
      if (MIME[ext]) return json(res, { binary: true, type: MIME[ext], size: st.size });
      const buf = fs.readFileSync(full), sample = buf.subarray(0, 4000);
      if (sample.includes(0)) return json(res, { binary: true, size: st.size });
      return json(res, { text: buf.subarray(0, 200000).toString('utf8'), truncated: buf.length > 200000 });
    } catch (er) { return json(res, { error: String(er.message) }, 500); }
  }
  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
  if (u === '/update/check') return body(req, async () => {
    if (UPD.working) return json(res, { error: 'Another update action is running.' }, 409);
    await updCheck(); json(res, updStatus());
  });
  if (u === '/update/apply') return body(req, async () => {
    try { const r = await updInstall(); json(res, { ok: true, restarting: true, from: r.from, to: r.to }); updRestart(); }
    catch (er) { json(res, { error: er.message }, er.code || 500); }
  });
  if (u === '/update/rollback') return body(req, async () => {
    if (UPD.working) return json(res, { error: 'Another update action is running.' }, 409);
    UPD.working = true;
    try { const r = await updater.rollback({ root: ROOT, busy: !idle() }); json(res, { ok: true, restarting: true, to: r.to }); updRestart(); }
    catch (er) { json(res, { error: er.message }, 409); }
    finally { UPD.working = false; }
  });
  if (u === '/update/settings') return body(req, (b) => {
    const s = updSettings(b, true);
    if (!s) return json(res, { error: 'bad settings' }, 400);
    Object.assign(UPD.settings, s); save(); json(res, updStatus());
  });
  if (u === '/remote/settings') return body(req, (b) => {
    const host = b && typeof b.host === 'string' ? b.host.trim().toLowerCase() : '';
    if (!b || typeof b.enabled !== 'boolean' || ((b.enabled || host) && !remote.validHost(host))) return json(res, { error: 'Host must be a name ending in .ts.net (letters, digits, dots, hyphens).' }, 400);
    if (b.enabled !== RM.enabled || (host || null) !== RM.host) dropRemoteSessions();
    RM.enabled = b.enabled; RM.host = host || null; save();
    remoteStatus().then((st) => json(res, st)).catch(() => json(res, { error: 'status failed' }, 500));
  });
  if (u === '/remote/token') return body(req, () => {
    const token = remote.generateToken(), h = remote.hashToken(token);
    RM.salt = h.salt; RM.hash = h.hash; dropRemoteSessions(); save();
    res.setHeader('cache-control', 'no-store'); json(res, { token });
  });
  if (u === '/remote/revoke') return body(req, (b) => {
    if (b && b.index !== undefined) {
      if (!sessions.revokeAt(b.index)) return json(res, { error: 'No such device' }, 400);
      pruneRemoteStreams(); return json(res, { ok: true, sessions: sessions.count() });
    }
    dropRemoteSessions(); json(res, { ok: true, sessions: 0 });
  });
  if (u === '/remote/credentials' && req.method === 'POST') return body(req, (b) => {
    const username = b && typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
    if (!remote.validUsername(username)) return json(res, { error: 'Username must be 3 to 32 characters: a-z, 0-9, dot, underscore, hyphen.' }, 400);
    if (!b || !remote.validSecret(b.secret)) return json(res, { error: 'Password or PIN must be 6 to 128 characters.' }, 400);
    const h = remote.hashToken(b.secret);
    RM.creds = { username, salt: h.salt, hash: h.hash }; dropRemoteSessions(); save();
    res.setHeader('cache-control', 'no-store');
    remoteStatus().then((st) => json(res, st)).catch(() => json(res, { error: 'status failed' }, 500));
  });
  if (u === '/event') return body(req, (e) => {
    try { if (e) apply(e); } catch { return done(res, 400); }
    done(res);
  });
  if (u === '/fs/pick') {
    if (!NATIVE_PICKER) return json(res, { error: 'The Windows folder browser is not available here. Use the built-in browser.' }, 501);
    if (picking) return json(res, { error: 'A folder browser is already open' }, 409);
    let out = '', over = false, finished = false;
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', PICK_SCRIPT], { windowsHide: false, stdio: ['ignore', 'pipe', 'ignore'] });
    picking = child.pid;
    const stop = () => { try { process.kill(child.pid); } catch {} };
    const timer = setTimeout(stop, 5 * 60 * 1000);
    res.on('close', () => { if (!finished) stop(); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (out.length < 4096) out += d; else over = true; });
    child.on('error', (er) => { clearTimeout(timer); picking = null; if (finished || res.headersSent) return; finished = true; json(res, { error: 'Could not start PowerShell: ' + er.message }, 501); });
    child.on('close', () => {
      clearTimeout(timer); picking = null;
      if (finished || res.headersSent) return; finished = true;
      const p = out.trim();
      if (!p) return json(res, { cancelled: true });
      try { if (over || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) return json(res, { error: 'That is not a folder' }, 400); } catch { return json(res, { error: 'That is not a folder' }, 400); }
      json(res, { path: p });
    });
    return;
  }
  if (u === '/fs/mkdir') return body(req, (b) => {
    const n = b && String(b.name || '').trim(), dir = b && b.path && fsAllowed(String(b.path));
    if (b && b.path && !dir) return json(res, { error: 'outside workspace' }, 403);
    if (!n || /[\\/:*?"<>|]/.test(n) || n === '.' || n === '..' || !dir || !fs.existsSync(dir)) return json(res, { error: 'bad name or folder' }, 400);
    try { const d = path.join(dir, n); fs.mkdirSync(d); json(res, { path: d }); } catch (er) { json(res, { error: String(er.message) }, 400); }
  });
  if (u === '/project/new') return body(req, (b) => {
    const f = b && b.folder && fsAllowed(String(b.folder));
    if (b && b.folder && !f) return json(res, { error: 'outside workspace' }, 403);
    if (!f || !fs.existsSync(f) || !fs.statSync(f).isDirectory()) return json(res, { error: 'folder not found' }, 400);
    json(res, { id: newProject(f, b.name).id });
  });
  if (u === '/project/close') return body(req, (b) => {
    const p = b && projects.get(b.id);
    if (p && ![p.planThread, p.engineThread].some((id) => threads.get(id).running)) { threads.delete(p.planThread); threads.delete(p.engineThread); projects.delete(p.id); if (!projects.size) newProject(ROOT, 'Model Engine'); sendProjects(); save(); }
    done(res);
  });
  if (u === '/project/push') return body(req, (b) => {
    const p = b && projects.get(b.id); if (!p) return done(res, 404);
    if (!fs.existsSync(path.join(p.folder, 'PLAN.md'))) return json(res, { error: 'No PLAN.md yet. Ask the plan chat to write it first.' }, 400);
    json(res, { attach: 'PLAN.md', message: 'Build this project from the attached PLAN.md. Work through the build order one step at a time. For each step: call recall for context, build it, then run the council (council-ui, council-code, council-run) on the diff and apply the findings. Check the step against its "done looks like" before moving on. When every step is done, call the reviewer with the final diff and the council findings, and stop on a reject.' });
  });
  if (u === '/thread/set') return body(req, (b) => {
    const t = b && threads.get(b.id); if (!t) return done(res, 404);
    if (b.provider !== undefined && b.provider !== (t.provider || 'claude')) {
      if (!PROVIDERS.includes(b.provider)) return json(res, { error: 'unknown provider' }, 400);
      if (b.provider === 'antigravity') return json(res, { error: 'not available yet' }, 400);
      if (t.running) return json(res, { error: 'thread is running' }, 409);
      t.provider = b.provider;
      if (b.model === undefined) t.model = b.provider === 'claude' ? (t.kind === 'plan' ? 'opus' : 'sonnet') : 'default';
    }
    for (const k of ['mode', 'model', 'effort']) if (b[k] !== undefined) t[k] = b[k];
    if (t.q) { if (b.mode) t.q.setPermissionMode(b.mode).catch(() => {}); if (b.model) t.q.setModel(MODELS[b.model] || b.model).catch(() => {}); }
    if (t.kind === 'engine' && !running) { S.orchModel = t.model; push(); }
    sendProjects(); save(); done(res);
  });
  if (u === '/thread/clear') return body(req, (b) => {
    const t = b && threads.get(b.id); if (!t || t.running) return done(res, 409);
    t.items = []; t.subs = []; t.sessionId = null; send('items', { thread: t.id, items: [] }); send('subs', { thread: t.id, list: [] }); save(); done(res);
  });
  if (u === '/chat') return body(req, (b) => {
    const t = b && typeof b === 'object' && threads.get(b.thread);
    if (!t || (b.text !== undefined && typeof b.text !== 'string') || (b.atts !== undefined && !Array.isArray(b.atts))) return done(res, 400);
    b.atts = b.atts.slice(0, 20).filter((a) => a && typeof a === 'object' && typeof a.name === 'string' && typeof a.type === 'string' && typeof a.data === 'string' && a.data.length <= 12e6);
    if (!String(b.text || '').trim() && !b.atts.length) return done(res, 400);
    if (UPD.working) return done(res, 409);
    if (running) {
      if (!b.steer || running !== t.id || !t.q) return done(res, 409);
      const text = String(b.text || '');
      add(t, { kind: 'user', text, label: 'status', atts: [] });
      t.q.streamInput((async function* () { yield { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, priority: 'now' }; })()).catch((er) => add(t, { kind: 'err', text: 'steer failed: ' + ((er && er.message) || er) }));
      return done(res, 202);
    }
    runThread(t, String(b.text || ''), b.atts, b.allow, b.steer ? 'status' : undefined).catch((er) => {
      add(t, { kind: 'err', text: 'run failed: ' + ((er && er.message) || er) });
      t.running = false; if (running === t.id) running = null; push();
    });
    done(res, 202);
  }, 40e6);
  if (u === '/chat/stop') return body(req, (b) => { const t = b && threads.get(b.thread); if (t && t.q) t.q.interrupt().catch(() => {}); if (t && t.ac) { const ac = t.ac; setTimeout(() => ac.abort(), 4000); } done(res); });
  if (u === '/chat/perm') return body(req, (b) => { done(res, b && answerPerm(b.id, !!b.allow, !!b.always, b.message) ? 204 : 404); });
  res.writeHead(404); res.end();
});
// after an update the old process may still hold the port for a moment
const RESTARTED = process.env.MODEL_ENGINE_RESTART === '1';
delete process.env.MODEL_ENGINE_RESTART;
function start(left) {
  const onErr = (er) => { if (RESTARTED && er.code === 'EADDRINUSE' && left > 0) setTimeout(() => start(left - 1), 500); else throw er; };
  server.once('error', onErr);
  server.listen(PORT, HOST, () => {
    server.off('error', onErr);
    load();
    console.log(`live view on http://${HOST}:${PORT} (pid ${process.pid})`);
    setTimeout(updAuto, 10000).unref();
    setInterval(updAuto, 24 * 3600e3).unref();
    if (process.argv.includes('--open') && process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', 'msedge', `--app=http://127.0.0.1:${PORT}`, '--start-maximized'], { detached: true, stdio: 'ignore' }).unref();
    }
  });
}
if (!IN_DOCKER && !['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
  if (process.env.MODEL_ENGINE_ALLOW_LAN !== '1') {
    console.error('MODEL_ENGINE_HOST must be loopback outside Docker; use Tailscale access instead');
    process.exit(1);
  }
  console.warn('WARNING: MODEL_ENGINE_ALLOW_LAN=1: listening on ' + HOST + ' outside Docker. Anyone on the network can reach this server.');
}
start(20);
