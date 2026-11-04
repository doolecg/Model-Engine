// Safe read of a subagent transcript named by a hook event. The path comes from an untrusted POST body, so it is only
// read when its real path (symlinks resolved) is a .jsonl file inside <home>/.claude/projects. Anything else returns null.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024, TAIL_BYTES = 256 * 1024;
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

function readTranscriptText(p, home) {
  let fd;
  try {
    if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p) || path.extname(p).toLowerCase() !== '.jsonl') return null;
    const root = norm(fs.realpathSync(path.join(home, '.claude', 'projects'))), real = fs.realpathSync(p);
    if (!norm(real).startsWith(root + path.sep) || path.extname(real).toLowerCase() !== '.jsonl') return null;
    fd = fs.openSync(real, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size <= MAX_BYTES) return fs.readFileSync(fd, 'utf8');
    const buf = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, buf, 0, TAIL_BYTES, st.size - TAIL_BYTES);
    const t = buf.toString('utf8'), nl = t.indexOf('\n');
    return nl < 0 ? '' : t.slice(nl + 1); // the first line is cut mid-way, drop it
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

module.exports = { readTranscriptText, MAX_BYTES, TAIL_BYTES };
