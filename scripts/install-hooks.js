// Adds (or with uninstall-hooks.js removes) the Model Engine graph viewer hooks in the user's Claude settings.
// node scripts/install-hooks.js [--dry-run] [--settings <path>]
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', '.claude', 'live', 'hook.js').replace(/\\/g, '/');
const MARKER = '--model-engine';
const COMMAND = `node "${HOOK}" ${MARKER}`;
const EVENTS = [['SessionStart'], ['UserPromptSubmit'], ['PreToolUse', 'mcp__.*'], ['PostToolUse', '*'], ['SubagentStart'], ['SubagentStop'], ['Stop']];
const KEEP_BACKUPS = 5;

const ours = (h) => !!h && typeof h.command === 'string' && h.command.replace(/\\/g, '/').includes(HOOK) && h.command.includes(MARKER);
const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

function readSettings(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (er) { if (er.code === 'ENOENT') return { raw: null, data: {} }; throw er; }
  try {
    const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return plain(data) ? { raw, data } : null;
  } catch { return null; }
}

function addHooks(data) {
  const added = [];
  if (data.hooks === undefined) data.hooks = {};
  if (!plain(data.hooks)) return null;
  for (const [ev, matcher] of EVENTS) {
    if (data.hooks[ev] === undefined) data.hooks[ev] = [];
    const groups = data.hooks[ev];
    if (!Array.isArray(groups)) return null;
    if (groups.some((g) => plain(g) && Array.isArray(g.hooks) && g.hooks.some(ours))) continue;
    groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: COMMAND }] });
    added.push(ev);
  }
  return added;
}

function removeHooks(data) {
  const removed = [];
  if (!plain(data.hooks)) return removed;
  for (const ev of Object.keys(data.hooks)) {
    const groups = data.hooks[ev];
    if (!Array.isArray(groups)) continue;
    let hit = false;
    const kept = [];
    for (const g of groups) {
      if (plain(g) && Array.isArray(g.hooks) && g.hooks.some(ours)) {
        hit = true;
        g.hooks = g.hooks.filter((h) => !ours(h));
        if (g.hooks.length) kept.push(g);
      } else kept.push(g);
    }
    if (!hit) continue;
    removed.push(ev);
    if (kept.length) data.hooks[ev] = kept; else delete data.hooks[ev];
  }
  if (removed.length && !Object.keys(data.hooks).length) delete data.hooks;
  return removed;
}

function backup(file) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  fs.copyFileSync(file, `${file}.bak-me-${stamp}`);
  // only prune backups this tool made (exact name pattern); user-made or older-format .bak-* files are never touched
  const own = new RegExp('^' + path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.bak-me-\\d{8}T\\d{9}Z$'), dir = path.dirname(file);
  const old = fs.readdirSync(dir).filter((n) => own.test(n)).sort().reverse().slice(KEEP_BACKUPS);
  for (const n of old) try { fs.unlinkSync(path.join(dir, n)); } catch {}
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// returns { code, message }; never prints other content of the settings file
function run(mode, { settings, dryRun }) {
  const cur = readSettings(settings);
  if (!cur) return { code: 1, message: `${settings} is not a valid JSON object. Nothing changed.` };
  const data = cur.data;
  const done = mode === 'install' ? addHooks(data) : removeHooks(data);
  if (!done) return { code: 1, message: `${settings} has an unexpected "hooks" shape. Nothing changed.` };
  const verb = mode === 'install' ? 'add' : 'remove';
  if (!done.length) return { code: 0, message: `Model Engine hooks: nothing to ${verb} in ${settings}.` };
  if (dryRun) return { code: 0, message: `Dry run: would ${verb} hooks for ${done.join(', ')} in ${settings}. Nothing written.` };
  const indent = cur.raw && /^\s*\{\r?\n([ \t]+)"/.exec(cur.raw);
  const text = JSON.stringify(data, null, indent ? indent[1] : 2) + (cur.raw === null || /\n$/.test(cur.raw) ? '\n' : '');
  if (cur.raw !== null) backup(settings);
  writeAtomic(settings, text);
  return { code: 0, message: `Model Engine hooks ${verb === 'add' ? 'added' : 'removed'} for ${done.join(', ')} in ${settings}.` };
}

function main(mode, argv) {
  const si = argv.indexOf('--settings');
  const settings = path.resolve(si >= 0 && argv[si + 1] ? argv[si + 1] : path.join(os.homedir(), '.claude', 'settings.json'));
  let r;
  try { r = run(mode, { settings, dryRun: argv.includes('--dry-run') }); } catch (er) { r = { code: 1, message: `Could not update ${settings}: ${er.code || 'error'}. Nothing changed.` }; }
  (r.code ? console.error : console.log)(r.message);
  process.exit(r.code);
}

module.exports = { main, run, HOOK, COMMAND, EVENTS };
if (require.main === module) main('install', process.argv.slice(2));
