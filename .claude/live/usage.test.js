const test = require('node:test');
const assert = require('node:assert');
const { aggregateUsage } = require('./usage.js');

const D1 = Date.UTC(2026, 10, 3, 12), D2 = Date.UTC(2026, 10, 4, 9);
const rows = [
  { ts: D1, provider: 'claude', model: 'claude-sonnet-5-5', in: 100, out: 50, cacheR: 10, cacheW: 5, cost: 0.5 },
  { ts: D1, provider: 'codex', model: 'gpt-5', in: 200, out: 20, cacheR: 0, cacheW: 0, cost: null },
  { ts: D2, provider: 'claude', model: 'claude-sonnet-5-5', in: 1, out: 2, cacheR: 3, cacheW: 4, cost: 0.25 },
];

test('totals sum every row and ignore null cost', () => {
  const a = aggregateUsage(rows);
  assert.deepStrictEqual(a.totals, { runs: 3, in: 301, out: 72, cacheR: 13, cacheW: 9, cost: 0.75 });
});

test('groups by provider, model and day', () => {
  const a = aggregateUsage(rows);
  assert.deepStrictEqual(a.byProvider.map((x) => [x.provider, x.runs]), [['claude', 2], ['codex', 1]]);
  assert.strictEqual(a.byModel.length, 2);
  assert.strictEqual(a.byModel[0].model, 'claude-sonnet-5-5');
  assert.deepStrictEqual(a.byDay.map((x) => [x.day, x.runs]), [['2026-11-03', 2], ['2026-11-04', 1]]);
});

test('rows keeps only the last 200; bad input is safe', () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ ts: D1, provider: 'codex', model: 'm', in: i, out: 0, cacheR: 0, cacheW: 0, cost: 0 }));
  const a = aggregateUsage(many);
  assert.strictEqual(a.rows.length, 200);
  assert.strictEqual(a.rows[0].in, 50);
  assert.strictEqual(aggregateUsage(null).totals.runs, 0);
  assert.strictEqual(aggregateUsage([null, {}]).totals.runs, 1);
});

test('runs counts recorded runs, not model rows', () => {
  const two = [
    { ts: D1, run: 'a', provider: 'claude', model: 'm1', in: 1, out: 1, cacheR: 0, cacheW: 0, cost: 0 },
    { ts: D1, run: 'a', provider: 'claude', model: 'm2', in: 1, out: 1, cacheR: 0, cacheW: 0, cost: 0 },
    { ts: D1, run: 'b', provider: 'claude', model: 'm1', in: 1, out: 1, cacheR: 0, cacheW: 0, cost: 0 },
  ];
  const a = aggregateUsage(two);
  assert.strictEqual(a.totals.runs, 2);
  assert.strictEqual(a.byProvider[0].runs, 2);
  assert.deepStrictEqual(a.byModel.map((x) => [x.model, x.runs]).sort(), [['m1', 2], ['m2', 1]]);
});
