// Global Claude Code hook: forwards the hook event to the local graph viewer, starting it if needed.
// Must stay silent (hook stdout can inject context into Claude) and must always exit 0.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
if (process.env.MODEL_ENGINE_OFF === '1') process.exit(0);
process.on('uncaughtException', () => process.exit(0));
const PORT = Number(process.env.MODEL_ENGINE_PORT) || 4779;
const LOCK = path.join(os.tmpdir(), `model-engine-start-${PORT}.lock`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, p, data, timeout) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout, headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', (er) => resolve(er.code || 'error'));
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.end(data);
  });
}
// only one hook at a time starts the viewer; a lock older than 10 s is dead
function takeLock() {
  for (let i = 0; i < 2; i++) {
    try { fs.closeSync(fs.openSync(LOCK, 'wx')); return true; } catch {}
    try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 10000) fs.unlinkSync(LOCK); else return false; } catch {}
  }
  return false;
}
let owned = false;
async function startViewer() {
  if ((owned = takeLock())) {
    try { spawn(process.execPath, [path.join(__dirname, 'viewer.js')], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
  }
  for (let i = 0; i < 8; i++) {
    await sleep(200);
    if (await request('GET', '/about', undefined, 300) === 200) return;
  }
}
async function main(body) {
  const r = await request('POST', '/event', body, 600);
  if (r === 'ECONNREFUSED') {
    await startViewer();
    await request('POST', '/event', body, 600);
  }
  if (owned) try { fs.unlinkSync(LOCK); } catch {}
  process.exit(0);
}
setTimeout(() => process.exit(0), 8000).unref();
let body = '', over = false;
process.stdin.on('data', (d) => { if (body.length + d.length <= 1e6) body += d; else over = true; });
process.stdin.on('end', () => (over ? process.exit(0) : main(body)));
process.stdin.on('error', () => process.exit(0));
