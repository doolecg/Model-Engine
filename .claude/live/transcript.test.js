const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readTranscriptText, MAX_BYTES, TAIL_BYTES } = require('./transcript.js');

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'me-tr-'));
function fake() {
  const dir = mk(), home = path.join(dir, 'home'), proj = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  return { dir, home, proj };
}

test('transcript: a .jsonl inside <home>/.claude/projects is read', () => {
  const { home, proj } = fake(), f = path.join(proj, 'a.jsonl');
  fs.writeFileSync(f, '{"a":1}\n');
  assert.strictEqual(readTranscriptText(f, home), '{"a":1}\n');
});

test('transcript: files outside the projects folder, wrong extension, relative or odd input are not read', () => {
  const { dir, home, proj } = fake();
  const out = path.join(dir, 'out.jsonl'), txt = path.join(proj, 'a.txt');
  fs.writeFileSync(out, 'secret'); fs.writeFileSync(txt, 'secret');
  assert.strictEqual(readTranscriptText(out, home), null);
  assert.strictEqual(readTranscriptText(txt, home), null);
  assert.strictEqual(readTranscriptText(path.join(proj, '..', '..', '..', 'out.jsonl'), home), null);
  for (const bad of [undefined, null, 5, {}, '', 'a.jsonl', path.join(proj, 'x\0.jsonl'), proj, path.join(proj, 'missing.jsonl')]) assert.strictEqual(readTranscriptText(bad, home), null);
  assert.strictEqual(readTranscriptText(out, path.join(dir, 'no-home')), null);
  // a sibling folder whose name starts like the projects folder is not inside it
  const sib = path.join(home, '.claude', 'projects-evil'); fs.mkdirSync(sib);
  fs.writeFileSync(path.join(sib, 'a.jsonl'), 'secret');
  assert.strictEqual(readTranscriptText(path.join(sib, 'a.jsonl'), home), null);
});

test('transcript: a symlink inside projects that points outside is refused', (t) => {
  const { dir, home, proj } = fake(), out = path.join(dir, 'out.jsonl');
  fs.writeFileSync(out, 'secret');
  try { fs.symlinkSync(out, path.join(proj, 'link.jsonl')); fs.symlinkSync(dir, path.join(proj, 'dirlink'), 'junction'); } catch { return t.skip('symlinks not permitted here'); }
  assert.strictEqual(readTranscriptText(path.join(proj, 'link.jsonl'), home), null);
  assert.strictEqual(readTranscriptText(path.join(proj, 'dirlink', 'out.jsonl'), home), null);
});

test('transcript: an oversize file returns only the tail, starting on a whole line', () => {
  const { home, proj } = fake(), f = path.join(proj, 'big.jsonl');
  const line = JSON.stringify({ pad: 'x'.repeat(98) }) + '\n';
  const n = Math.ceil(MAX_BYTES / line.length) + 10;
  fs.writeFileSync(f, line.repeat(n) + '{"last":true}\n');
  const t = readTranscriptText(f, home);
  assert.ok(t.length <= TAIL_BYTES && t.length > TAIL_BYTES / 2);
  assert.ok(t.endsWith('{"last":true}\n'));
  for (const l of t.split('\n').filter(Boolean)) JSON.parse(l);
});
