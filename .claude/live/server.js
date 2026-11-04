// Model Engine live view. node .claude/live/server.js [--open]
// Chat runs on the Claude Agent SDK, the same engine T3 Code uses.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.MODEL_ENGINE_PORT) || 4777;
const STORE = process.env.MODEL_ENGINE_STORE || path.join(__dirname, 'projects.json');
const MODELS = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' };
const rid = () => crypto.randomUUID().slice(0, 8);

const S = {
  calls: 0, verdict: null, opus: 'idle',
  recall: { cg: 0, hs: 0, grep: 0, saved: 0, run: false },
  orch: 'idle', builder: 'idle', orchModel: 'sonnet', council: { ui: 'idle', code: 'idle', run: 'idle' },
  mcpSeen: {}, active: {}, log: [], t0: Date.now(), busy: false,
};
const clients = new Set();

function send(type, data) {
  const m = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const c of clients) c.write(m);
}
function stamp() {
  const s = (Date.now() - S.t0) / 1000;
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + (s % 60).toFixed(1).padStart(4, '0');
}
function log(unit, msg) { S.log.push([stamp(), unit, msg]); if (S.log.length > 40) S.log.shift(); }
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
function view() { return { ...S, loadout: loadout(), repo: ROOT }; }
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

function apply(e) {
  const n = e.hook_event_name, ag = who(e.agent_type);
  if (e.hook_event_name === 'SubagentStart' || e.hook_event_name === 'SubagentStop') subHook(e.hook_event_name, e);
  if (n === 'SessionStart') { if (e.source === 'startup') { S.t0 = Date.now(); S.log = []; S.changes = []; } log('session', e.source || 'start'); }
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
    if (ag === 'opus') { S.opus = 'idle'; S.calls++; S.verdict = v === 'reject' ? 'reject' : v === 'approve' ? 'approve' : null; log('opus', v || 'done'); pulse('verdict'); }
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
    else if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(t) && e.tool_input && (e.tool_input.file_path || e.tool_input.notebook_path)) {
      const fp = e.tool_input.file_path || e.tool_input.notebook_path, rel = path.relative(e.cwd || ROOT, fp);
      (S.changes = S.changes || []).push([stamp(), t, rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : fp]);
      if (S.changes.length > 60) S.changes.shift();
    }
    else if (t === 'Skill') { pulse('load'); log('skill', (e.tool_input && e.tool_input.skill) || ''); }
    if (!ag && !m && t !== 'Agent' && t !== 'Task') S.orch = 'writing';
  } else if (n === 'Stop') { S.busy = false; S.active = {}; S.orch = 'done?'; log('orchestrator', 'finished'); }
  push();
}

// ---------------- agents and rules (passed through the SDK, so any project folder gets them) ----------------
const MEM = ['mcp__codegraph__codegraph_explore', 'mcp__hindsight__hindsight_search_knowledge_pages', 'mcp__hindsight__hindsight_read_knowledge_page'];
const ONE_LINE = 'Never edit. Reply with exactly one line: `pass`, `note: <issue>` or `fail: <reason>`.';
const AGENTS = {
  recall: { description: 'Memory and code lookup. Read-only. Use for every repo search, before planning or building.', model: MODELS.haiku, maxTurns: 12, tools: ['Read', 'Glob', 'Grep', ...MEM],
    prompt: 'Answer with paths and line numbers, one line each. Never edit. Hindsight first for decisions (name the page), then codegraph_explore for code, then Grep or Read only for what it does not index. If a tool is down, say so in one line and carry on.' },
  'council-ui': { description: 'Council 1 of 3. Reviews the UI side of a change. Replies pass, note or fail.', model: MODELS.haiku, maxTurns: 10, tools: ['Read', 'Glob', 'Grep'],
    prompt: 'Review only the UI: layout, spacing, empty and error states, contrast, keyboard basics, phone, 1080p and 32-inch sizes. ' + ONE_LINE },
  'council-code': { description: 'Council 2 of 3. Reviews the code side of a change. Replies pass, note or fail.', model: MODELS.haiku, maxTurns: 10, tools: ['Read', 'Glob', 'Grep', 'mcp__codegraph__codegraph_explore'],
    prompt: 'Review only the code: bugs, edge cases, error handling, style, and callers of changed symbols (codegraph_explore). ' + ONE_LINE },
  'council-run': { description: 'Council 3 of 3. Runs the tests and starts the app once. Replies pass, note or fail.', model: MODELS.haiku, maxTurns: 12, tools: ['Bash', 'Read', 'Glob', 'Grep'],
    prompt: 'Run the test suite once and start the app or build once if there is one. Filter output with head, tail or grep. One build or test run at a time. Never edit. Reply with exactly one line: `pass: <N> tests`, `note: <issue>` or `fail: <first failing error, one line>`.' },
  builder: { description: 'Builds one step of a project to a task card. The only agent that edits project files. Runs its own check before reporting.', model: MODELS.sonnet, maxTurns: 40, tools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep', 'mcp__codegraph__codegraph_explore'],
    prompt: 'You build exactly the step you are given, in the files you are given, nothing more. Match the surrounding code style. Run the check for the step (build, test or run) before reporting. Never fake success: no stubs, no skipped or weakened tests, no hardcoded results. If blocked, reply BLOCKED with the reason instead of improvising. Reply with DONE, what you changed (paths) and what you ran.' },
  reviewer: { description: 'Opus gate. Reads the plan or the final diff plus council findings, answers approve or reject, commits the handoff to memory after an approve.', model: MODELS.opus, maxTurns: 6, tools: ['Read', 'mcp__hindsight__hindsight_search_knowledge_pages', 'mcp__hindsight__hindsight_ingest_document'],
    prompt: 'You get a plan, or a final diff with the council findings. Reject if it contradicts a recorded Hindsight decision. Reply with exactly one line: `approve` or `reject: <reason>`. Never write code. After an approve of a final diff only, ingest one short Hindsight document titled "Handoff: <project> <date>" (done, next, file paths, decisions); after the same error twice, ingest a "Lesson: <topic>" document.' },
};
const skillBody = (n) => { try { return '\n\n' + fs.readFileSync(path.join(ROOT, '.claude', 'skills', n, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim(); } catch { return ''; } };
for (const [a, k] of Object.entries({ recall: 'engine-recall', 'council-ui': 'engine-ui-review', 'council-code': 'engine-code-review', 'council-run': 'engine-run-check', builder: 'engine-builder', reviewer: 'engine-brain' })) AGENTS[a].prompt += skillBody(k);
const ENGINE_RULES = `You are the orchestrator: you talk to the user and coordinate. You do not edit project files yourself. For any real project work, delegate one step at a time to the builder agent with a short task card (task, files, done check). Every repo search goes to the recall agent. Every test run goes to council-run; before "done" also call council-ui and council-code on the diff. Ask the reviewer (the Brain, Opus) before a plan locks, after the same error twice, and before saying done, passing the plan or the final diff plus council findings; on reject, send the fix back to the builder and ask again. Chat, questions and planning talk need no agents. Max 3 subagents at once, one build or test run at a time.`;
const PLAN_RULES = `You are the Brain, planning a project with the user. Use the recall agent to look things up. Interview the user, then write PLAN.md in the project folder with these sections: Goal; References (links, files, examples, with why each matters); Deliverables (what must be made); Done looks like (checkable, per deliverable); Build order (numbered steps, each with its own done check). You may write only PLAN.md and files under docs/. Do not write code.`;
const HOOKS = {};
for (const ev of ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse', 'Stop']) {
  HOOKS[ev] = [{ hooks: [async (input) => { try { apply(input); } catch {} return {}; }] }];
}

// ---------------- projects and chat threads (Agent SDK) ----------------
const projects = new Map(), threads = new Map(), pending = new Map();
let running = null, cmds = [], sdk = null, prefetching = false;
const SDK = async () => sdk || (sdk = await import('@anthropic-ai/claude-agent-sdk'));
const tmeta = (t) => ({ id: t.id, project: t.project, kind: t.kind, mode: t.mode, model: t.model, effort: t.effort, running: t.running });
const pmeta = (p) => ({ id: p.id, name: p.name, folder: p.folder, planThread: p.planThread, engineThread: p.engineThread });
const sendProjects = () => { send('projects', { list: [...projects.values()].map(pmeta) }); send('threads', { list: [...threads.values()].map(tmeta) }); };
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const out = [...projects.values()].map((p) => ({ ...pmeta(p), threads: [p.planThread, p.engineThread].map((id) => { const t = threads.get(id); return { ...tmeta(t), running: false, sessionId: t.sessionId, items: t.items.filter((i) => i.kind !== 'perm' || i.status !== 'pending').slice(-200) }; }) }));
      fs.writeFileSync(STORE, JSON.stringify(out));
    } catch {}
  }, 400);
}
function mkThread(pid, kind) {
  const plan = kind === 'plan';
  const t = { id: rid(), project: pid, kind, sessionId: null, mode: 'default', model: plan ? 'opus' : 'sonnet', effort: 'medium', items: [], running: false };
  threads.set(t.id, t); return t;
}
function newProject(folder, name) {
  const p = { id: rid(), name: name || path.basename(folder), folder };
  p.planThread = mkThread(p.id, 'plan').id; p.engineThread = mkThread(p.id, 'engine').id;
  projects.set(p.id, p); sendProjects(); save(); return p;
}
function load() {
  try {
    for (const p of JSON.parse(fs.readFileSync(STORE, 'utf8'))) {
      if (!fs.existsSync(p.folder)) continue;
      projects.set(p.id, { id: p.id, name: p.name, folder: p.folder, planThread: p.planThread, engineThread: p.engineThread });
      for (const t of p.threads) threads.set(t.id, { ...t, running: false, items: (t.items || []).map((i) => (i.live ? { ...i, live: false } : i)) });
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
    if (m.is_error && m.result) add(t, { kind: 'err', text: String(m.result) });
  }
}

async function runThread(t, text, atts) {
  if (running) return false;
  const proj = projects.get(t.project);
  running = t.id; t.running = true; S.orchModel = t.model; sendProjects();
  add(t, { kind: 'user', text, atts: (atts || []).map((a) => ({ name: a.name, type: a.type })) });
  const ac = new AbortController(); t.ac = ac;
  try {
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
        settingSources: ['user', 'project', 'local'], includePartialMessages: true, abortController: ac,
        agents: AGENTS, hooks: HOOKS, canUseTool: (n, i, o) => askPerm(t, n, i, o),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: t.kind === 'plan' ? PLAN_RULES : ENGINE_RULES },
        ...(t.effort ? { effort: t.effort } : {}), ...(t.sessionId ? { resume: t.sessionId } : {}),
      },
    });
    t.q = q;
    q.supportedCommands().then((c) => { if (c && c.length) { cmds = c; send('commands', { list: cmds }); } }).catch(() => {});
    for await (const m of q) handle(t, m);
  } catch (er) {
    if (!ac.signal.aborted) add(t, { kind: 'err', text: String((er && er.message) || er) });
    else add(t, { kind: 'meta', text: 'stopped' });
  } finally {
    for (const [id, p] of pending) if (p.t === t) answerPerm(id, false, false, 'run ended');
    for (const s of t.subs || []) if (s.status === 'running') { s.status = 'done'; s.ended = Date.now(); subSend(t, s); }
    t.running = false; t.q = null; t.ac = null; running = null;
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
    const q = query({ prompt: never(), options: { cwd: ROOT, settingSources: ['user', 'project', 'local'], abortController: ac } });
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

http.createServer((req, res) => {
  const hosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`], origin = req.headers.origin;
  if (!hosts.includes(req.headers.host) || (origin !== undefined && !hosts.some((h) => origin === `http://${h}`))) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, 'http://x'), u = url.pathname, q = url.searchParams;
  if (req.method === 'GET' && (u === '/'|| u === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  if (req.method === 'GET' && u === '/about') {
    let version = '0.0.0';
    try { version = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch {}
    return json(res, { version, port: PORT, root: path.basename(ROOT), node: process.version });
  }
  if (req.method === 'GET' && u === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const w = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    w({ type: 'state', state: view() });
    w({ type: 'projects', list: [...projects.values()].map(pmeta) });
    w({ type: 'threads', list: [...threads.values()].map(tmeta) });
    for (const t of threads.values()) w({ type: 'items', thread: t.id, items: t.items });
    for (const t of threads.values()) w({ type: 'subs', thread: t.id, list: (t.subs || []).map((s) => ({ ...s, items: s.items.slice(-40) })) });
    if (cmds.length) w({ type: 'commands', list: cmds });
    clients.add(res); req.on('close', () => clients.delete(res));
    prefetch();
    return;
  }
  if (req.method === 'GET' && u === '/fs') {
    const raw = q.get('path') || '', home = os.homedir();
    const quick = [['home', home], ['desktop', path.join(home, 'Desktop')], ['documents', path.join(home, 'Documents')], ['repos', path.dirname(ROOT)]]
      .filter((x) => fs.existsSync(x[1])).map((x) => ({ name: x[0], path: x[1] }));
    if (!raw) {
      const drives = [];
      for (let c = 65; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; if (fs.existsSync(d)) drives.push({ name: d, path: d }); }
      return json(res, { path: '', parent: null, dirs: drives, quick });
    }
    const full = path.resolve(raw);
    try {
      if (!fs.statSync(full).isDirectory()) return json(res, { error: 'not a folder' }, 400);
      const dirs = fs.readdirSync(full, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('$') && d.name !== 'System Volume Information')
        .map((d) => ({ name: d.name, path: path.join(full, d.name) })).sort((a, b) => a.name.localeCompare(b.name));
      const par = path.dirname(full);
      return json(res, { path: full, parent: par === full ? '' : par, dirs, quick });
    } catch (er) { return json(res, { error: String(er.message) }, 403); }
  }
  if (req.method === 'GET' && (u === '/files' || u === '/file' || u === '/attach')) {
    const p = projects.get(q.get('project')); if (!p) return done(res, 404);
    const full = inside(p.folder, q.get('path') || '');
    if (!full || !fs.existsSync(full)) return done(res, 404);
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
  if (u === '/event') return body(req, (e) => { if (e) apply(e); done(res); });
  if (u === '/fs/mkdir') return body(req, (b) => {
    const n = b && String(b.name || '').trim(), dir = b && b.path && path.resolve(String(b.path));
    if (!n || /[\\/:*?"<>|]/.test(n) || !dir || !fs.existsSync(dir)) return json(res, { error: 'bad name or folder' }, 400);
    try { const d = path.join(dir, n); fs.mkdirSync(d); json(res, { path: d }); } catch (er) { json(res, { error: String(er.message) }, 400); }
  });
  if (u === '/project/new') return body(req, (b) => {
    const f = b && b.folder && path.resolve(String(b.folder));
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
    const t = b && threads.get(b.thread);
    if (!t || (!String(b.text || '').trim() && !(b.atts && b.atts.length))) return done(res, 400);
    if (running) return done(res, 409);
    runThread(t, String(b.text || ''), b.atts); done(res, 202);
  }, 40e6);
  if (u === '/chat/stop') return body(req, (b) => { const t = b && threads.get(b.thread); if (t && t.q) t.q.interrupt().catch(() => {}); if (t && t.ac) setTimeout(() => t.ac && t.ac.abort(), 4000); done(res); });
  if (u === '/chat/perm') return body(req, (b) => { done(res, b && answerPerm(b.id, !!b.allow, !!b.always, b.message) ? 204 : 404); });
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => {
  load();
  console.log(`live view on http://127.0.0.1:${PORT} (pid ${process.pid})`);
  if (process.argv.includes('--open')) {
    spawn('cmd', ['/c', 'start', '', 'msedge', `--app=http://127.0.0.1:${PORT}`, '--start-maximized'], { detached: true, stdio: 'ignore' }).unref();
  }
});
