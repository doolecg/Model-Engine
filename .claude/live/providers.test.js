const test = require('node:test');
const assert = require('node:assert');
const { parseCodexLine, parseOpencodeLine, providers } = require('./providers');

const codexFixture = [
  { type: 'thread.started', thread_id: 'th-1' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'hello' } },
  { type: 'item.completed', item: { type: 'command_execution', command: 'pytest -q', aggregated_output: '1 failed', exit_code: 1 } },
  { type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/w/a.py', kind: 'update' }] } },
  { type: 'turn.completed', usage: { input_tokens: 3000, cached_input_tokens: 2000, cache_write_input_tokens: 200, output_tokens: 90, reasoning_output_tokens: 30 } },
  { type: 'error', message: 'boom' },
];

test('codex lines map to normalized events', () => {
  const ev = codexFixture.flatMap(parseCodexLine);
  assert.deepStrictEqual(ev[0], { kind: 'session', id: 'th-1' });
  assert.deepStrictEqual(ev[1], { kind: 'text', text: 'hello' });
  assert.deepStrictEqual(ev[2], { kind: 'tool', name: 'shell', input: { command: 'pytest -q' }, output: '1 failed', ok: false });
  assert.strictEqual(ev[3].name, 'apply_patch');
  assert.deepStrictEqual(ev[3].input.changes, [{ path: '/w/a.py', kind: 'update' }]);
  assert.deepStrictEqual(ev[4], { kind: 'usage', in: 800, out: 90, cacheR: 2000, cacheW: 200, cost: null });
  assert.deepStrictEqual(ev[5], { kind: 'error', message: 'boom' });
  assert.deepStrictEqual(parseCodexLine({ type: 'turn.started' }), []);
});

const sid = 'ses_x';
const ocFixture = [
  { type: 'step_start', sessionID: sid, part: { type: 'step-start' } },
  { type: 'text', sessionID: sid, part: { type: 'text', text: 'po' } },
  { type: 'text', sessionID: sid, part: { type: 'text', text: 'ng' } },
  { type: 'step_finish', sessionID: sid, part: { type: 'step-finish', cost: 0.5, tokens: { input: 10, output: 4, reasoning: 1, cache: { read: 7, write: 2 } } } },
];

test('opencode lines map to normalized events', () => {
  const ev = ocFixture.flatMap(parseOpencodeLine);
  assert.ok(ev.every((e) => e.kind !== 'session' || e.id === sid));
  assert.deepStrictEqual(ev.filter((e) => e.kind === 'text').map((e) => e.text), ['po', 'ng']);
  assert.deepStrictEqual(ev.find((e) => e.kind === 'usage'), { kind: 'usage', in: 10, out: 5, cacheR: 7, cacheW: 2, cost: 0.5 });
  const tool = parseOpencodeLine({ type: 'tool_use', sessionID: sid, part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a' } } });
  assert.deepStrictEqual(tool.find((e) => e.kind === 'tool'), { kind: 'tool', name: 'bash', input: { command: 'ls' }, output: 'a', ok: true });
});

test('providers expose run()', () => {
  assert.strictEqual(typeof providers.codex.run, 'function');
  assert.strictEqual(typeof providers.opencode.run, 'function');
});
