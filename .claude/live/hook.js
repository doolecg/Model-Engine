// Forwards a Claude Code hook event to the live view. Fails silently if the server is down.
const http = require('http');
// Only runs started by the dashboard chat (or a terminal with MODEL_ENGINE_LIVE=1) report in. Other tools in this folder (T3 Code) stay out.
if (process.env.MODEL_ENGINE_LIVE !== '1' || process.env.CLAUDE_CODE_ENTRYPOINT === 't3-code') process.exit(0);
let body = '';
process.stdin.on('data', (d) => (body += d));
process.stdin.on('end', () => {
  const req = http.request(
    { host: '127.0.0.1', port: Number(process.env.MODEL_ENGINE_PORT) || 4777, path: '/event', method: 'POST', timeout: 800, headers: { 'content-type': 'application/json' } },
    (res) => { res.resume(); res.on('end', () => process.exit(0)); }
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
});
