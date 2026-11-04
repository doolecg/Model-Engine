const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const INSTALL = path.join(__dirname, 'install-hooks.js'), UNINSTALL = path.join(__dirname, 'uninstall-hooks.js');
const HOOK = path.resolve(__dirname, '..', '.claude', 'live', 'hook.js').replace(/\\/g, '/');
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop'];
const HINDSIGHT = { matcher: 'startup', hooks: [{ type: 'command', command: 'node "C:/tools/hindsight/session-start.js"', timeout: 10 }] };
const FIXTURE = {
  model: 'opus', permissions: { allow: ['Bash(git status)'] }, env: { A: '1' },
  hooks: { SessionStart: [HINDSIGHT], PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo done' }] }], Notification: [{ hooks: [{ type: 'command', command: 'echo n' }] }] },
  zlast: true,
};
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'me-hooks-'));
const run = (script, file, extra = []) => spawnSync(process.execPath, [script, '--settings', file, ...extra], { encoding: 'utf8', env: { ...process.env, HOME: path.dirname(file), USERPROFILE: path.dirname(file) } });
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const setup = (data) => { const dir = mk(), f = path.join(dir, 'settings.json'); if (data !== undefined) fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n'); return { dir, f }; };
const backups = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('settings.json.bak-'));
const isOurs = (h) => h.command.includes(HOOK) && h.command.includes('--model-engine');

test('install adds the seven hooks and keeps everything else in place', () => {
  const { dir, f } = setup(FIXTURE);
  const r = run(INSTALL, f);
  assert.strictEqual(r.status, 0, r.stderr);
  const s = read(f);
  assert.deepStrictEqual(Object.keys(s), Object.keys(FIXTURE));
  for (const k of ['model', 'permissions', 'env', 'zlast']) assert.deepStrictEqual(s[k], FIXTURE[k]);
  assert.deepStrictEqual(s.hooks.Notification, FIXTURE.hooks.Notification);
  assert.deepStrictEqual(s.hooks.SessionStart[0], HINDSIGHT);
  assert.deepStrictEqual(s.hooks.PostToolUse[0], FIXTURE.hooks.PostToolUse[0]);
  for (const ev of EVENTS) {
    const ours = s.hooks[ev].filter((g) => g.hooks.some(isOurs));
    assert.strictEqual(ours.length, 1, ev);
    assert.strictEqual(s.hooks[ev][s.hooks[ev].length - 1], ours[0], 'ours goes last in ' + ev);
  }
  const g = (ev) => s.hooks[ev].find((x) => x.hooks.some(isOurs));
  assert.strictEqual(g('PreToolUse').matcher, 'mcp__.*');
  assert.strictEqual(g('PostToolUse').matcher, '*');
  assert.strictEqual(g('Stop').matcher, undefined);
  assert.strictEqual(g('Stop').hooks[0].command, `node "${HOOK}" --model-engine`);
  assert.strictEqual(backups(dir).length, 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, backups(dir)[0]), 'utf8')), FIXTURE);
  assert.ok(!fs.readdirSync(dir).some((n) => n.includes('.tmp-')), 'temp file left behind');
});

test('a second install changes nothing and makes no new backup', () => {
  const { dir, f } = setup(FIXTURE);
  run(INSTALL, f);
  const once = fs.readFileSync(f, 'utf8');
  const r = run(INSTALL, f);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), once);
  assert.strictEqual(backups(dir).length, 1);
});

test('install creates a missing settings file, with no backup', () => {
  const { dir, f } = setup();
  assert.strictEqual(run(INSTALL, f).status, 0);
  assert.strictEqual(EVENTS.every((ev) => read(f).hooks[ev].length === 1), true);
  assert.strictEqual(backups(dir).length, 0);
});

test('bad JSON is refused and nothing changes', () => {
  for (const bad of ['{ "hooks": ', '', '[1,2]', '{"a":1,}']) {
    const { dir, f } = setup(bad);
    const r = run(INSTALL, f);
    assert.strictEqual(r.status, 1, JSON.stringify(bad));
    assert.strictEqual(fs.readFileSync(f, 'utf8'), bad);
    assert.strictEqual(backups(dir).length, 0);
    assert.strictEqual(run(UNINSTALL, f).status, 1);
    assert.ok(!(r.stdout + r.stderr).includes('"hooks"'), 'settings content echoed');
  }
  const { f } = setup({ hooks: { Stop: 'nope' } });
  assert.strictEqual(run(INSTALL, f).status, 1);
});

test('dry run writes nothing', () => {
  const { dir, f } = setup(FIXTURE);
  const before = fs.readFileSync(f, 'utf8');
  const r = run(INSTALL, f, ['--dry-run']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /would add/i);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), before);
  assert.strictEqual(backups(dir).length, 0);
  run(INSTALL, f);
  const installed = fs.readFileSync(f, 'utf8');
  assert.strictEqual(run(UNINSTALL, f, ['--dry-run']).status, 0);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), installed);
  const { f: none } = setup();
  assert.strictEqual(run(INSTALL, none, ['--dry-run']).status, 0);
  assert.ok(!fs.existsSync(none));
});

test('uninstall removes only our entries and restores the original content', () => {
  const { f } = setup(FIXTURE);
  run(INSTALL, f);
  // a hand-added entry in the same group as ours, and a lookalike without the marker
  const s = read(f);
  const g = s.hooks.Stop.find((x) => x.hooks.some(isOurs));
  g.hooks.unshift({ type: 'command', command: 'echo mine' });
  s.hooks.Stop.push({ hooks: [{ type: 'command', command: `node "${HOOK}"` }] });
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
  const r = run(UNINSTALL, f);
  assert.strictEqual(r.status, 0, r.stderr);
  const u = read(f);
  assert.deepStrictEqual(u.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo mine' }] }, { hooks: [{ type: 'command', command: `node "${HOOK}"` }] }]);
  for (const ev of EVENTS.filter((e) => e !== 'Stop')) assert.ok(!(u.hooks[ev] || []).some((x) => x.hooks.some(isOurs)), ev);
  assert.deepStrictEqual(u.hooks.SessionStart, FIXTURE.hooks.SessionStart);
  assert.deepStrictEqual(u.hooks.PostToolUse, FIXTURE.hooks.PostToolUse);
  assert.deepStrictEqual(u.hooks.Notification, FIXTURE.hooks.Notification);
  assert.strictEqual(u.hooks.PreToolUse, undefined);
  assert.deepStrictEqual(Object.keys(u), Object.keys(FIXTURE));
  // a plain install then uninstall gives back the fixture exactly
  const b = setup(FIXTURE);
  run(INSTALL, b.f); run(UNINSTALL, b.f);
  assert.deepStrictEqual(read(b.f), FIXTURE);
  // and uninstall again has nothing to do
  const again = fs.readFileSync(b.f, 'utf8');
  assert.strictEqual(run(UNINSTALL, b.f).status, 0);
  assert.strictEqual(fs.readFileSync(b.f, 'utf8'), again);
});

test('only the 5 newest backups are kept', () => {
  const { dir, f } = setup(FIXTURE);
  const theirs = ['settings.json.bak-20261101-hook', 'settings.json.bak-20261101T120000000Z', 'settings.json.bak-me', 'settings.json.bak-me-notes', 'settings.json.bak-me-20261101T120000000Z.keep'];
  for (const n of theirs) fs.writeFileSync(path.join(dir, n), 'user');
  for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(dir, `settings.json.bak-me-2026110${i + 1}T120000000Z`), 'tool');
  run(INSTALL, f);
  const names = backups(dir), mine = names.filter((n) => /^settings\.json\.bak-me-\d{8}T\d{9}Z$/.test(n));
  assert.strictEqual(mine.length, 5);
  assert.deepStrictEqual(mine, [...mine].sort());
  assert.ok(!mine.includes('settings.json.bak-me-20261101T120000000Z'), 'oldest tool backup pruned');
  assert.ok(mine.some((n) => n > 'settings.json.bak-me-20261107'), 'new backup kept');
  for (const n of theirs) assert.ok(fs.existsSync(path.join(dir, n)), n + ' must survive');
});
