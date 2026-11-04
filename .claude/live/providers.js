// Non-Claude CLI providers for the live view: codex and opencode, driven over JSONL.
// No shell is used: on Windows an npm .cmd shim is resolved to the exe/js it launches.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

const zeroUsage = () => ({ in: 0, out: 0, cacheR: 0, cacheW: 0, cost: null });
const num = (v) => (Number.isFinite(v) ? v : 0);

// ---- parsers (pure) ----
function parseCodexLine(o) {
  if (!o || typeof o !== 'object') return [];
  if (o.type === 'thread.started' && o.thread_id) return [{ kind: 'session', id: o.thread_id }];
  if (o.type === 'error') return [{ kind: 'error', message: String(o.message || 'codex error') }];
  if (o.type === 'turn.failed') return [{ kind: 'error', message: String((o.error && o.error.message) || 'codex turn failed') }];
  if (o.type === 'turn.completed' && o.usage) {
    const u = o.usage, cached = num(u.cached_input_tokens), written = num(u.cache_write_input_tokens);
    // out excludes reasoning_output_tokens: unverified vs TokenEconomizer trace/codex.py:271 (which adds them)
    return [{ kind: 'usage', in: Math.max(0, num(u.input_tokens) - cached - written), out: num(u.output_tokens), cacheR: cached, cacheW: written, cost: null }];
  }
  if (o.type === 'item.completed' && o.item) {
    const it = o.item;
    if (it.type === 'agent_message') return it.text ? [{ kind: 'text', text: String(it.text) }] : [];
    if (it.type === 'command_execution') {
      const code = it.exit_code;
      return [{ kind: 'tool', name: 'shell', input: { command: it.command }, output: it.aggregated_output || '', ok: code === 0 || code == null }];
    }
    if (it.type === 'file_change') {
      const ch = Array.isArray(it.changes) ? it.changes : [];
      return [{ kind: 'tool', name: 'apply_patch', input: { changes: ch.map((c) => ({ path: c.path, kind: c.kind })) }, output: ch.map((c) => `${c.kind || 'update'} ${c.path}`).join('\n'), ok: it.status !== 'failed' }];
    }
  }
  return [];
}

function parseOpencodeLine(o) {
  if (!o || typeof o !== 'object') return [];
  const out = [];
  if (o.sessionID) out.push({ kind: 'session', id: o.sessionID });
  const p = o.part || {};
  if (o.type === 'text' && p.text) out.push({ kind: 'text', text: String(p.text) });
  else if (o.type === 'tool_use' || o.type === 'tool' || p.type === 'tool') {
    const st = p.state || {};
    if (!st.status || st.status === 'completed' || st.status === 'error') {
      out.push({ kind: 'tool', name: p.tool || p.name || 'tool', input: st.input || p.input || {}, output: st.output != null ? String(st.output) : (st.error ? String(st.error) : ''), ok: st.status !== 'error' });
    }
  } else if (o.type === 'step_finish' && p.tokens) {
    const t = p.tokens, c = t.cache || {};
    out.push({ kind: 'usage', in: num(t.input), out: num(t.output) + num(t.reasoning), cacheR: num(c.read), cacheW: num(c.write), cost: Number.isFinite(p.cost) ? p.cost : null });
  } else if (o.type === 'error') {
    const e = o.error || {};
    out.push({ kind: 'error', message: String((e.data && e.data.message) || e.message || e.name || 'opencode error') });
  }
  return out;
}

// ---- binary resolution ----
function resolveBin(name) {
  let hits = [];
  if (process.platform === 'win32') {
    const r = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true });
    hits = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const h of hits) if (/\.exe$/i.test(h)) return { cmd: h, pre: [] };
    for (const h of hits) {
      if (!/\.(cmd|bat)$/i.test(h)) continue;
      let txt = '';
      try { txt = fs.readFileSync(h, 'utf8'); } catch { continue; }
      const dir = path.dirname(h);
      const exe = txt.match(/"%dp0%\\([^"]+?\.exe)"/i);
      if (exe && fs.existsSync(path.join(dir, exe[1]))) return { cmd: path.join(dir, exe[1]), pre: [] };
      const js = txt.match(/"%dp0%\\([^"]+?\.m?c?js)"/i);
      if (js && fs.existsSync(path.join(dir, js[1]))) return { cmd: process.execPath, pre: [path.join(dir, js[1])] };
    }
    if (hits.length) throw new Error(`${name} found but only as a shim that cannot be run without a shell`);
  } else {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    hits = (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (hits[0]) return { cmd: hits[0], pre: [] };
  }
  throw new Error(`${name} not installed`);
}

// ---- shared runner ----
function runCli({ name, args, stdin, cwd, env, signal, onEvent, parse }) {
  return new Promise((resolve, reject) => {
    let bin;
    try { bin = resolveBin(name); } catch (e) { return reject(e); }
    if (signal && signal.aborted) return reject(new Error('aborted'));
    let child;
    try {
      child = spawn(bin.cmd, [...bin.pre, ...args], { cwd, env: env ? { ...process.env, ...env } : process.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return reject(e.code === 'ENOENT' ? new Error(`${name} not installed`) : e); }
    let sessionId = null, gotText = false, buf = '', err = '';
    const usage = zeroUsage();
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
    const onAbort = () => {
      // kill the spawned child (and its tree on Windows); don't rely on 'close' alone to free the caller
      if (process.platform === 'win32' && child.pid) { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch {} }
      try { child.kill(); } catch {}
      setTimeout(() => done(reject, new Error('aborted')), 2000).unref();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const handleLine = (line) => {
      line = line.trim();
      if (!line) return;
      let o; try { o = JSON.parse(line); } catch { return; }
      for (const ev of parse(o)) {
        if (ev.kind === 'session') sessionId = ev.id;
        else if (ev.kind === 'text') gotText = true;
        else if (ev.kind === 'usage') {
          usage.in += ev.in; usage.out += ev.out; usage.cacheR += ev.cacheR; usage.cacheW += ev.cacheW;
          if (ev.cost != null) usage.cost = (usage.cost || 0) + ev.cost;
        }
        if (onEvent) onEvent(ev);
      }
    };
    const outDec = new StringDecoder('utf8'), errDec = new StringDecoder('utf8');
    child.stdout.on('data', (d) => {
      buf += outDec.write(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => { err = (err + errDec.write(d)).slice(-2000); });
    child.on('error', (e) => done(reject, e.code === 'ENOENT' ? new Error(`${name} not installed`) : e));
    child.on('close', (code) => {
      handleLine(buf);
      if (signal && signal.aborted) return done(reject, new Error('aborted'));
      if (code !== 0 && !gotText) return done(reject, new Error(`${name} exited ${code}: ${err.trim() || 'no stderr'}`));
      done(resolve, { sessionId, usage });
    });
    child.stdin.on('error', () => {});
    if (stdin != null) child.stdin.end(stdin); else child.stdin.end();
  });
}

// ---- providers ----
const codex = {
  run({ cwd, text, model, sessionId, signal, onEvent }) {
    const m = model ? ['-m', model] : [];
    const args = sessionId
      ? ['exec', 'resume', sessionId, '--json', '--skip-git-repo-check', ...m, '-']
      : ['exec', '--json', '--color', 'never', '--skip-git-repo-check', '-C', cwd, ...m, '-'];
    return runCli({ name: 'codex', args, stdin: text, cwd, signal, onEvent, parse: parseCodexLine });
  },
};

let ocFlag; // '--pure' | '--standalone' | ''
function opencodeFlag(bin) {
  if (ocFlag !== undefined) return ocFlag;
  const r = spawnSync(bin.cmd, [...bin.pre, 'run', '--help'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const help = (r.stdout || '') + (r.stderr || '');
  ocFlag = /--pure\b/.test(help) ? '--pure' : /--standalone\b/.test(help) ? '--standalone' : '';
  return ocFlag;
}

const opencode = {
  run({ cwd, text, model, sessionId, signal, onEvent }) {
    let flag;
    try { flag = opencodeFlag(resolveBin('opencode')); } catch (e) { return Promise.reject(e); }
    const args = ['run', '--format', 'json', ...(flag ? [flag] : []), ...(model ? ['--model', model] : []), ...(sessionId ? ['--session', sessionId] : []), '--', text]; // '--' so a prompt starting with '-' is not read as a flag
    return runCli({ name: 'opencode', args, cwd, env: { OPENCODE_CONFIG_CONTENT: '{"share":"disabled","autoupdate":false}' }, signal, onEvent, parse: parseOpencodeLine });
  },
};

module.exports = { providers: { codex, opencode }, parseCodexLine, parseOpencodeLine };
