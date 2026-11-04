// Pure aggregation of usage rows {ts, project, thread, provider, model, in, out, cacheR, cacheW, cost}.
const num = (v) => (Number.isFinite(v) ? v : 0);
const blank = () => ({ runs: 0, in: 0, out: 0, cacheR: 0, cacheW: 0, cost: 0 });
const seen = new WeakMap(); // bucket -> run keys already counted (one run can write several model rows)
function addTo(a, r) {
  let s = seen.get(a); if (!s) seen.set(a, s = new Set());
  const k = r.run != null ? String(r.run) : Symbol();
  if (!s.has(k)) { s.add(k); a.runs++; } a.in += num(r.in); a.out += num(r.out); a.cacheR += num(r.cacheR); a.cacheW += num(r.cacheW); a.cost += num(r.cost);
}

function aggregateUsage(rows) {
  rows = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const totals = blank(), prov = new Map(), model = new Map(), day = new Map();
  const bucket = (m, k, init) => { let b = m.get(k); if (!b) { b = { ...init, ...blank() }; m.set(k, b); } return b; };
  for (const r of rows) {
    const p = r.provider || 'claude', md = r.model || 'unknown', d = Number.isFinite(r.ts) ? new Date(r.ts).toISOString().slice(0, 10) : 'unknown';
    addTo(totals, r);
    addTo(bucket(prov, p, { provider: p }), r);
    addTo(bucket(model, p + '/' + md, { provider: p, model: md }), r);
    addTo(bucket(day, d, { day: d }), r);
  }
  return {
    totals,
    byProvider: [...prov.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
    byModel: [...model.values()].sort((a, b) => b.cost - a.cost || (b.in + b.out) - (a.in + a.out)),
    byDay: [...day.values()].sort((a, b) => a.day.localeCompare(b.day)),
    rows: rows.slice(-200),
  };
}

module.exports = { aggregateUsage };
