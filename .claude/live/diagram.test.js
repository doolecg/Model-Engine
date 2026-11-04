const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// throwaway server on loopback, temp store, never port 4777
const PORT = 4817;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function call(method, url, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: url, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (d) => (t += d));
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', (er) => resolve({ status: 0, error: String(er) }));
    if (data) req.write(data);
    req.end();
  });
}
// first message on /stream is the full state
function state() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/stream' }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; const m = buf.match(/^data: (.*)\n\n/); if (m) { req.destroy(); resolve(JSON.parse(m[1]).state); } });
    });
    req.on('error', (er) => { if (er.code !== 'ECONNRESET') reject(er); });
  });
}

async function withServer(extra, fn) {
  const dir = tmp('me-dg-');
  const env = { ...process.env, MODEL_ENGINE_PORT: String(PORT), MODEL_ENGINE_STORE: path.join(dir, 'store.json'), ...extra };
  delete env.MODEL_ENGINE_HOST; delete env.MODEL_ENGINE_RESTART;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stderr.on('data', (d) => (log += d));
  try {
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('server did not start: ' + log)), 15000);
      child.stdout.on('data', (d) => { if (String(d).includes('live view on')) { clearTimeout(to); res(); } });
      child.on('exit', () => rej(new Error('server exited: ' + log)));
    });
    const mk = async (name) => {
      const folder = path.join(dir, name); fs.mkdirSync(folder);
      const r = await call('POST', '/project/new', { folder, name });
      assert.strictEqual(r.status, 200);
      return { id: r.json.id, folder };
    };
    await fn({ mk });
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const ev = (cwd, name, extra) => call('POST', '/event', { hook_event_name: name, cwd, ...extra });

test('diagram state is per project and subagents survive prompts', async () => {
  await withServer({}, async ({ mk }) => {
    const A = await mk('a'), B = await mk('b');
    await ev(A.folder, 'SubagentStart', { agent_type: 'council-run', agent_id: 'x1' });
    let s = await state();
    assert.strictEqual(s.states[A.id].council.run, 'running');
    assert.strictEqual(s.states[B.id].council.run, 'idle');

    // a task-notification prompt resets nothing and logs a short row
    await ev(A.folder, 'UserPromptSubmit', { prompt: '  <task-notification><summary>Agent "x" finished</summary></task-notification>' });
    s = await state();
    assert.strictEqual(s.states[A.id].council.run, 'running');
    assert.strictEqual(s.states[A.id].orch, 'idle');
    assert.ok(s.logs[A.id].log.some((r) => r[1] === 'agent' && r[2] === 'Agent "x" finished'));
    assert.ok(!s.logs[A.id].log.some((r) => r[1] === 'you'));
    await ev(A.folder, 'UserPromptSubmit', { prompt: '<task-notification>no summary</task-notification>' });
    s = await state();
    assert.ok(s.logs[A.id].log.some((r) => r[2] === 'background task finished'));

    // a genuine prompt resets finished states only (subfolder cwd still routes to A)
    await ev(A.folder, 'SubagentStart', { agent_type: 'engine:council_ui', agent_id: 'x2' });
    await ev(A.folder, 'SubagentStop', { agent_type: 'engine:council_ui', agent_id: 'x2', last_assistant_message: 'pass' });
    await ev(A.folder, 'SubagentStart', { agent_type: 'builder', agent_id: 'x3' });
    await ev(A.folder, 'SubagentStop', { agent_type: 'builder', agent_id: 'x3' });
    s = await state();
    assert.strictEqual(s.states[A.id].council.ui, 'pass');
    assert.strictEqual(s.states[A.id].builder, 'done');
    await ev(path.join(A.folder, 'sub'), 'UserPromptSubmit', { prompt: 'do the thing' });
    s = await state();
    const a = s.states[A.id];
    assert.deepStrictEqual([a.council.ui, a.builder, a.verdict, a.orch, a.council.run], ['idle', 'idle', null, 'thinking', 'running']);
    assert.ok(a.busy && s.busy);
    assert.strictEqual(s.states[B.id].orch, 'idle');

    // Stop leaves a running member alone
    await ev(A.folder, 'Stop');
    s = await state();
    assert.strictEqual(s.states[A.id].council.run, 'running');
    assert.strictEqual(s.states[A.id].orch, 'done?');
    assert.strictEqual(s.states[A.id].busy, false);

    // SubagentStop clears it, whatever the agent type looks like
    await ev(A.folder, 'SubagentStop', { agent_type: 'engine:Council-Run', agent_id: 'x1', last_assistant_message: 'pass: 3 tests' });
    s = await state();
    assert.strictEqual(s.states[A.id].council.run, 'pass');

    // an unrelated folder is dropped, nothing changes
    const other = tmp('me-other-');
    try {
      const fixed = (st) => JSON.stringify(st, (k, v) => (k === 'pulses' ? undefined : v)); // pulses count down with time
      const before = fixed((await state()).states);
      await ev(other, 'SubagentStart', { agent_type: 'recall', agent_id: 'x4' });
      s = await state();
      assert.strictEqual(fixed(s.states), before);
    } finally { fs.rmSync(other, { recursive: true, force: true }); }

    // closing a project removes its state; a new project starts idle
    await ev(B.folder, 'SubagentStart', { agent_type: 'recall', agent_id: 'x5' });
    assert.strictEqual((await state()).states[B.id].recall.run, true);
    assert.strictEqual((await call('POST', '/project/close', { id: B.id })).status, 204);
    s = await state();
    assert.ok(!(B.id in s.states) && A.id in s.states);
    const C = await mk('c');
    assert.strictEqual((await state()).states[C.id].orch, 'idle');
  });
});

test('a subagent running past the stale limit is shown idle', async () => {
  await withServer({ MODEL_ENGINE_STALE_MS: '600' }, async ({ mk }) => {
    const A = await mk('a');
    await ev(A.folder, 'SubagentStart', { agent_type: 'council-code', agent_id: 'y1' });
    await ev(A.folder, 'SubagentStart', { agent_type: 'builder', agent_id: 'y2' });
    let s = await state();
    assert.deepStrictEqual([s.states[A.id].council.code, s.states[A.id].builder], ['running', 'building']);
    await new Promise((r) => setTimeout(r, 900));
    s = await state();
    assert.deepStrictEqual([s.states[A.id].council.code, s.states[A.id].builder], ['idle', 'idle']);
  });
});

test('mcpSeen and the loadout markers are per project', async () => {
  await withServer({}, async ({ mk }) => {
    const A = await mk('a'), B = await mk('b');
    await ev(A.folder, 'PostToolUse', { tool_name: 'mcp__hindsight__recall' });
    await ev(A.folder, 'PostToolUse', { tool_name: 'mcp__codegraph__codegraph_explore' });
    const s = await state();
    assert.deepStrictEqual(Object.keys(s.states[A.id].mcpSeen).sort(), ['codegraph', 'hindsight']);
    assert.deepStrictEqual(s.states[B.id].mcpSeen, {});
    assert.ok(['codegraph', 'hindsight'].every((k) => s.states[A.id].loadout.mcps.includes(k)));
    assert.ok(!s.states[B.id].loadout.mcps.some((k) => s.states[A.id].mcpSeen[k] && !s.loadout.mcps.includes(k)));
    assert.deepStrictEqual(s.mcpSeen, {});
    await ev(B.folder, 'PostToolUse', { tool_name: 'mcp__hindsight__recall' });
    const t = await state();
    assert.deepStrictEqual(Object.keys(t.states[B.id].mcpSeen), ['hindsight']);
    assert.ok(!t.states[B.id].loadout.mcps.includes('codegraph') || !t.states[B.id].mcpSeen.codegraph);
  });
});
