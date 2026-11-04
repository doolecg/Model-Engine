// The Engine graph: one drawing module shared by the dashboard (browser <script>), the /panel page,
// and the server-side SVG/PNG snapshots (Node require, with scene-dom.js). It never touches window,
// localStorage or fetch; everything outside the drawing comes in through createScene options.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EngineScene = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const C = { bg: '#121214', card: '#17171b', l: '#3a3a44', gl: '#2c2c33', d: '#9a9aa6', t: '#e8e8ee', p: '#8b7cf6', g: '#4ade80', r: '#f4514b', a: '#f0a64b', c: '#5eead4' };
  const NS = 'http://www.w3.org/2000/svg';
  const FONT_FAMILY = '"JetBrains Mono","Cascadia Mono",ui-monospace,Consolas,monospace';
  // the rules the graph needs on top of its attributes; ANIM is left out of still images
  const CSS_STATIC = '.fl{opacity:0}.fl.on{opacity:1}.act{stroke-dasharray:6 5;stroke-width:1.6}';
  const CSS_ANIM = '.fl.on{animation:march 1.2s linear infinite}.led{animation:pulse 1.8s ease-in-out infinite}.act{animation:march .9s linear infinite}'
    + '@keyframes march{to{stroke-dashoffset:-22}}@keyframes fill{0%{transform:scaleX(0)}70%,100%{transform:scaleX(1)}}@keyframes pulse{50%{opacity:.3}}';
  const CS = { idle: ['idle', C.d, 'zero'], running: ['running…', C.t, 'run'], pass: ['✓ pass', C.g, 'full'], note: ['⚠ note', C.a, 'full'], fail: ['✕ fail', C.r, 'full'], done: ['✓ done', C.d, 'full'] };

  // opts: document, layout 'wide'|'tall'|'portrait', log (false: no log panel at all, the viewBox shrinks), width (px, sets the svg size),
  // svg (existing element to draw into), reduceMotion() -> bool, tab 'log'|'chg', onBotClick(), onChangeRow(entry, i), onTabChange(tab)
  function createScene(opts) {
    const document = opts.document, layout = opts.layout === 'tall' || opts.layout === 'portrait' ? opts.layout : 'wide';
    const reduced = () => !!(opts.reduceMotion && opts.reduceMotion());
    const W = {}, BIND = [], BOTS = [];
    let P, FID = '', FMIN = 0, last = null, logFit = null, logG = null, logOn = opts.log !== false, fw = 0, fh = 0, tallVB = [0, 0];

    function mkel(t, a, x) { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (x != null) e.textContent = x; return e; }
    function kbd(e, role, label) {
      e.setAttribute('tabindex', '0'); e.setAttribute('role', role || 'button'); if (label) e.setAttribute('aria-label', label);
      e.addEventListener('keydown', (ev) => { if (ev.target === e && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); e.dispatchEvent(new MouseEvent('click', { bubbles: true })); } });
    }
    function el(t, a, x) { const e = mkel(t, a, x); P.appendChild(e); return e; }
    function mk(vb) {
      const s = opts.svg || document.createElementNS(NS, 'svg');
      s.setAttribute('viewBox', vb); s.setAttribute('preserveAspectRatio', 'xMidYMid meet'); s.textContent = '';
      P = s; FID = 'glow' + layout;
      s.appendChild(mkel('defs', {})).innerHTML = '<filter id="glow' + layout + '" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>';
      return s;
    }
    function T(x, y, s, f, sz, anc, b, ls) { return el('text', { x, y, fill: f, 'font-size': Math.max(sz || 12, FMIN), 'text-anchor': anc || 'start', 'font-weight': b ? 700 : 400, 'letter-spacing': ls || 0 }, s); }
    function card(x, y, w, h, st) { return el('rect', { x, y, width: w, height: h, rx: 10, fill: C.card, stroke: st || C.l }); }
    function grp(x, y, w, h, label, col) { el('rect', { x, y, width: w, height: h, rx: 14, fill: 'none', stroke: C.gl, 'stroke-dasharray': '4 5' }); el('circle', { cx: x + 16, cy: y + 14, r: 3, fill: col }); T(x + 26, y + 18, label, C.d, 10, 'start', 1, 2); }
    function bar(x, y, w) { el('rect', { x, y, width: w, height: 4, rx: 2, fill: '#3a3a42' }); return el('rect', { x, y, width: w, height: 4, rx: 2, fill: C.g, style: 'transform-box:fill-box;transform-origin:0 50%;transform:scaleX(0)' }); }
    function setBar(b, mode, col) {
      b.setAttribute('fill', col);
      b.style.animation = mode === 'run' ? 'fill 1.6s ease-out infinite' : 'none';
      b.style.transform = mode === 'full' ? 'scaleX(1)' : mode === 'zero' ? 'scaleX(0)' : mode === 'run' && reduced() ? 'scaleX(.5)' : '';
    }
    function rp(p, r) {
      let d = 'M' + p[0];
      for (let i = 1; i < p.length - 1; i++) {
        const a = p[i - 1], b = p[i], c = p[i + 1];
        const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]), k = Math.min(r, l1 / 2, l2 / 2);
        const u = [(a[0] - b[0]) / l1, (a[1] - b[1]) / l1], v = [(c[0] - b[0]) / l2, (c[1] - b[1]) / l2];
        d += ` L${b[0] + u[0] * k},${b[1] + u[1] * k} Q${b[0]},${b[1]} ${b[0] + v[0] * k},${b[1] + v[1] * k}`;
      }
      return d + ' L' + p[p.length - 1];
    }
    function wire(key, p, col, o) {
      o = o || {}; const d = rp(p, 10);
      el('path', { d, fill: 'none', stroke: C.gl, 'stroke-width': 1.6 });
      const fl = el('path', { d, fill: 'none', stroke: col, 'stroke-width': 1.6, 'stroke-dasharray': o.dash || '4 7', 'stroke-linecap': 'round', class: 'fl' });
      const s = p[0]; if (!o.nd) el('circle', { cx: s[0], cy: s[1], r: 3, fill: C.bg, stroke: col });
      const e = p[p.length - 1], q = p[p.length - 2], ang = Math.atan2(e[1] - q[1], e[0] - q[0]) * 180 / Math.PI;
      el('path', { d: 'M-7,-4L0,0L-7,4Z', fill: col, transform: `translate(${e[0]},${e[1]}) rotate(${ang})` });
      const dur = o.dur || 1.4, c = el('circle', { r: 3.4, fill: col, filter: 'url(#' + FID + ')', visibility: 'hidden', class: 'dot' });
      const st = mkel('set', { attributeName: 'visibility', to: 'visible', begin: 'indefinite', dur: dur + 's' }); c.appendChild(st);
      const m = mkel('animateMotion', { begin: 'indefinite', dur: dur + 's', path: d, fill: 'remove' }); c.appendChild(m);
      (W[key] = W[key] || []).push({ fl, st, m });
    }
    function pulse(k) {
      (W[k] || []).forEach((w) => {
        w.fl.classList.add('on'); clearTimeout(w.t); w.t = setTimeout(() => w.fl.classList.remove('on'), 2200);
        if (!reduced()) try { w.st.beginElement(); w.m.beginElement(); } catch {}
      });
    }
    // snapshots: light the wires of key k with no timer (the caller says who is flowing)
    function flow(k, on) { (W[k] || []).forEach((w) => w.fl.classList.toggle('on', !!on)); }
    const bind = (f) => BIND.push(f);
    function actBind(r, col, fn) {
      const o = r.getAttribute('stroke'); r.style.setProperty('--c', col);
      bind((s) => { const on = !!fn(s); r.classList.toggle('act', on); r.setAttribute('stroke', on ? col : o); });
      return r;
    }
    function botIcon(x, y) {
      const prev = P, g = el('g', { transform: 'translate(' + x + ',' + y + ')', style: 'cursor:pointer' }); P = g;
      el('rect', { x: -4, y: -4, width: 44, height: 26, fill: 'transparent' });
      el('path', { d: 'M8,0V4', stroke: C.d, 'stroke-width': 1.4, fill: 'none' });
      const h = el('rect', { x: 0, y: 4, width: 16, height: 12, rx: 3, fill: 'none', stroke: C.d, 'stroke-width': 1.4 });
      el('circle', { cx: 5, cy: 10, r: 1.4, fill: C.d }); el('circle', { cx: 11, cy: 10, r: 1.4, fill: C.d });
      const t = el('text', { x: 21, y: 15, fill: C.g, 'font-size': 12, 'font-weight': 700 }, '');
      P = prev; g.addEventListener('click', () => { if (opts.onBotClick) opts.onBotClick(); }); kbd(g, 'button', 'subagents'); BOTS.push({ h, t }); return g;
    }

    function councilCard(k, x, y, w, h, name, scope, wide) {
      actBind(card(x, y, w, h), C.g, (s) => s.council[k] === 'running'); T(x + (wide ? 16 : 12), y + (wide ? 26 : 24), name, C.t, wide ? 14 : 13, 'start', 1); wide ? T(x + w - 16, y + 26, 'haiku 5.5', C.d, 11, 'end') : T(x + 12, y + 40, 'haiku 5.5', C.d, 10);
      if (wide) T(x + 16, y + 48, scope, C.d, 11);
      const b = bar(x + (wide ? 16 : 12), y + (wide ? 60 : 54), w - (wide ? 32 : 24)), st = T(x + (wide ? 16 : 12), y + h - (wide ? 18 : 14), 'idle', C.d, wide ? 12 : 11, 'start', 1);
      bind((s) => { const v = CS[s.council[k]] || CS.idle; st.textContent = v[0]; st.setAttribute('fill', v[1]); setBar(b, v[2], v[1]); });
    }
    // a name that does not fit gets an ellipsis, never a silent mid-word cut
    const ell = (v, n) => v.length > n ? v.slice(0, n - 1) + '…' : v;
    function skillsMcps(xs, ys, lh, n) {
      const sk = [], mc = [];
      for (let i = 0; i < n; i++) { sk.push(T(xs[0], ys + i * lh, '', C.t, 10)); mc.push(T(xs[1], ys + i * lh, '', C.d, 10)); }
      const hs = T(xs[0], ys - 18, 'skills', C.d, 10), hm = T(xs[1], ys - 18, 'mcp', C.d, 10);
      bind((s) => {
        const L = s.loadout; hs.textContent = 'skills ' + L.skills.length; hm.textContent = 'mcp ' + L.mcps.filter((m) => s.mcpSeen[m]).length + '/' + L.mcps.length;
        sk.forEach((t, i) => t.textContent = ell(L.skills[i] || '', 18));
        mc.forEach((t, i) => { const m = L.mcps[i]; if (!m) { t.textContent = ''; return; } const on = !!s.mcpSeen[m]; t.textContent = (on ? '● ' : '○ ') + ell(m, 13); t.setAttribute('fill', on ? (m === 'hindsight' ? C.a : m === 'codegraph' ? C.c : C.g) : C.d); });
      });
    }
    function opusBits(xc, yc, xv, yv, xl, yl) {
      const calls = T(xc, yc, 'calls 0', C.d, 11), v = T(xv, yv, '—', C.d, 12, 'end', 1), led = el('circle', { cx: xl, cy: yl, r: 3, fill: C.p, opacity: .25 });
      bind((s) => {
        calls.textContent = 'calls ' + s.calls; v.textContent = s.verdict === 'approve' ? 'APPROVE' : s.verdict === 'reject' ? 'REJECT' : '—'; v.setAttribute('fill', s.verdict === 'approve' ? C.g : s.verdict === 'reject' ? C.r : C.d);
        led.setAttribute('opacity', s.opus === 'awake' ? 1 : .25); led.setAttribute('class', s.opus === 'awake' ? 'led' : '');
      });
    }
    function recallBits(xa, ya, xb, yb) {
      const cg = T(xa, ya, '0 explores · 0 greps', C.d, 11), hs = T(xb, yb, '0 recalls · 0 saved', C.d, 11);
      bind((s) => { cg.textContent = s.recall.cg + ' explores · ' + s.recall.grep + ' greps'; hs.textContent = s.recall.hs + ' recalls · ' + s.recall.saved + ' saved'; });
    }
    function logPanel(x, y, w, h, rows, fs, gap, th, lg) {
      th = th || 26; lg = lg || gap; const rl = Math.floor(rows * gap / lg), off = 24; const cd = card(x, y, w, h); const r = []; let nc = rows, nl = rl, tb = opts.tab === 'chg' ? 'chg' : 'log';
      const ty = y + 10, tw = fs * 11, tabs = {};
      el('path', { d: 'M' + (x + 1) + ',' + (ty + th) + 'H' + (x + w - 1), stroke: C.gl });
      [['log', 'SESSION LOG', x + 12], ['chg', 'CHANGES', x + 12 + tw + 6]].forEach(([k, lab, tx]) => {
        const g = el('g', { style: 'cursor:pointer' }), pv = P; P = g;
        const bg = el('path', { d: 'M' + tx + ',' + (ty + th) + 'V' + (ty + 6) + 'Q' + tx + ',' + ty + ' ' + (tx + 6) + ',' + ty + 'H' + (tx + tw - 6) + 'Q' + (tx + tw) + ',' + ty + ' ' + (tx + tw) + ',' + (ty + 6) + 'V' + (ty + th) + 'Z' });
        const ln = el('rect', { x: tx, y: ty, width: tw, height: 2, fill: C.g }), t = T(tx + tw / 2, ty + th / 2 + 5, lab, C.d, fs - 1, 'middle', 1, 1);
        P = pv; tabs[k] = { bg, ln, t, g }; kbd(g, 'tab', lab); g.addEventListener('click', () => { tb = k; paint(); render(); if (opts.onTabChange) opts.onTabChange(k); });
      });
      const paint = () => { for (const k in tabs) { const a = k === tb, o = tabs[k]; o.bg.setAttribute('fill', a ? C.bg : '#1d1d22'); o.bg.setAttribute('stroke', a ? C.g : C.gl); o.ln.setAttribute('opacity', a ? 1 : 0); o.t.setAttribute('fill', a ? C.g : C.d); o.t.setAttribute('font-weight', a ? 700 : 400); o.g.setAttribute('aria-selected', a); } }; paint();
      const tc = tabs.chg.t;
      let cur = []; const hit = []; const ty0 = y + th + off;
      for (let i = 0; i < rl; i++) {
        const yy = ty0 + i * gap; const hr = el('rect', { x: x + 6, y: yy - fs - 2, width: w - 12, height: gap, rx: 4, fill: '#fff', 'fill-opacity': 0, 'pointer-events': 'none' });
        hr.addEventListener('mouseenter', () => hr.setAttribute('fill-opacity', .07)); hr.addEventListener('mouseleave', () => hr.setAttribute('fill-opacity', 0));
        hr.addEventListener('click', () => { const e = cur[i]; if (e && opts.onChangeRow) opts.onChangeRow(e, i); }); kbd(hr, 'button'); hr.removeAttribute('tabindex'); hr.removeAttribute('role'); hit.push(hr);
        const row = [T(x + 16, yy, '', C.d, fs), T(x + 16 + fs * 6, yy, '', C.t, fs), T(x + 16 + fs * 15, yy, '', C.t, fs)]; row.forEach((t) => t.setAttribute('pointer-events', 'none')); r.push(row);
      }
      const col = { opus: C.p, hindsight: C.a, codegraph: C.c, council: C.t, sonnet: C.t, recall: C.c, you: C.g };
      bind((s, ex) => {
        const lgs = (ex && ex.log) || [], ch = (ex && ex.changes) || []; const gp = tb === 'log' ? lg : gap; const L = (tb === 'log' ? lgs : ch).slice(-(tb === 'log' ? nl : nc)); const m = Math.floor((w - fs * 15 - 32) / (fs * .6));
        tc.textContent = 'CHANGES' + (ch.length ? ' ' + ch.length : ''); cur = tb === 'chg' ? L : [];
        r.forEach((row, i) => {
          const e = L[i]; const hr = hit[i]; const yy = ty0 + i * gp;
          row.forEach((t) => t.setAttribute('y', yy)); hr.setAttribute('y', yy - fs - 2); hr.setAttribute('height', gp);
          const act = tb === 'chg' && e; hr.setAttribute('pointer-events', act ? 'all' : 'none');
          if (act) { hr.setAttribute('tabindex', '0'); hr.setAttribute('role', 'button'); hr.setAttribute('aria-label', 'show diff: ' + e[1] + ' ' + e[2]); } else { hr.removeAttribute('tabindex'); hr.removeAttribute('role'); hr.removeAttribute('aria-label'); }
          hr.style.cursor = 'pointer'; row[0].textContent = e ? e[0] : ''; row[1].textContent = e ? e[1] : ''; row[1].setAttribute('fill', e ? (tb === 'chg' ? C.g : col[e[1]] || C.d) : C.d);
          const v = e ? String(e[2]) : ''; row[2].textContent = tb === 'chg' && v.length > m ? '…' + v.slice(-(m - 1)) : v.slice(0, m);
        });
      });
      return (hh) => { cd.setAttribute('height', hh); nc = Math.max(1, Math.min(rows, Math.floor((hh - th - off - 10) / gap) + 1)); nl = Math.max(1, Math.min(rl, Math.floor((hh - th - off - 10) / lg) + 1)); render(); };
    }
    function orchBits(xs, ys, bx, by, bw, xd, yd, sz, xu, yu) {
      const sub = T(xu, yu, '', C.d, 11), st = T(xs, ys, 'idle', C.g, 12), b = bar(bx, by, bw), dn = T(xd, yd, '', C.t, sz, 'end', 1);
      bind((s) => { sub.textContent = 'chat · ' + (s.orchModel || 'sonnet'); st.textContent = s.orch === 'done?' ? 'ready' : s.orch; const run = s.orch === 'thinking' || s.orch === 'writing'; setBar(b, run ? 'run' : s.orch === 'done?' ? 'full' : 'zero', C.g); dn.textContent = s.orch === 'done?' ? 'done?' : ''; });
    }
    function builderBits(xs, ys, bx, by, bw) {
      const st = T(xs, ys, 'idle', C.d, 12), b = bar(bx, by, bw);
      bind((s) => { const v = s.builder; st.textContent = v === 'building' ? 'building' : v === 'done' ? '✓ done' : 'idle'; st.setAttribute('fill', v === 'idle' ? C.d : C.g); setBar(b, v === 'building' ? 'run' : v === 'done' ? 'full' : 'zero', C.g); });
    }

    function wideScene() {
      mk('0 0 1024 640');
      grp(8, 40, 224, 170, 'ORCHESTRATOR', C.g); grp(8, 250, 224, 170, 'BRAIN', C.p); grp(258, 40, 234, 170, 'MEMORY', C.a); grp(528, 40, 244, 372, 'BUILDER', C.t); grp(800, 40, 196, 404, 'COUNCIL', C.g);
      actBind(card(20, 68, 200, 130, C.g), C.g, (s) => s.orch === 'thinking' || s.orch === 'writing'); botIcon(172, 76); T(36, 92, 'ORCHESTRATOR', C.t, 14, 'start', 1); orchBits(36, 134, 36, 142, 168, 204, 134, 16, 36, 108);
      T(36, 166, '▸ talks to you', C.d, 11); T(36, 182, '▸ asks the Brain', C.d, 11);
      actBind(card(20, 278, 200, 130, C.p), C.p, (s) => s.opus === 'awake'); T(36, 302, 'OPUS 5.5', C.t, 15, 'start', 1); T(36, 318, 'plan + final gate', C.d, 11);
      ['▸ plan locks', '▸ same error ×2', '▸ before done'].forEach((s, i) => T(36, 342 + i * 16, s, C.d, 12));
      opusBits(36, 400, 204, 400, 206, 298);
      actBind(card(270, 68, 210, 130), C.c, (s) => s.recall.run); T(286, 92, 'RECALL', C.t, 15, 'start', 1); T(466, 92, 'haiku 5.5', C.d, 11, 'end');
      actBind(el('rect', { x: 286, y: 106, width: 178, height: 40, rx: 8, fill: 'none', stroke: C.c }), C.c, (s) => s.active && s.active.codegraph > 0); T(298, 124, '● CODEGRAPH', C.c, 11, 'start', 1);
      actBind(el('rect', { x: 286, y: 152, width: 178, height: 40, rx: 8, fill: 'none', stroke: C.a }), C.a, (s) => s.active && s.active.hindsight > 0); T(298, 170, '● HINDSIGHT', C.a, 11, 'start', 1);
      recallBits(298, 138, 298, 184);
      actBind(card(540, 68, 220, 130), C.t, (s) => s.builder === 'building'); botIcon(722, 76); T(556, 92, 'BUILDER', C.t, 15, 'start', 1); T(556, 108, 'sonnet 5.5 · projects only', C.d, 11); builderBits(556, 134, 556, 142, 188); T(556, 168, 'applies council findings', C.d, 11);
      card(540, 250, 220, 150); T(556, 272, 'LOADOUT', C.t, 12, 'start', 1); el('path', { d: 'M556,282H744', stroke: C.gl }); skillsMcps([554, 666], 318, 16, 5);
      [['ui', 68, 'UI', 'layout · screenshots'], ['code', 196, 'CODE', 'diff · bugs · style'], ['run', 324, 'RUN', 'tests · app boots']].forEach((n) => councilCard(n[0], 812, n[1], 168, 108, n[2], n[3], true));
      wire('ask', [[100, 198], [100, 278]], C.p, { nd: 1, dur: 1 }); T(108, 238, 'ask', C.d, 10);
      wire('verdict', [[140, 278], [140, 198]], C.p, { nd: 1, dur: 1 }); T(148, 238, 'verdict', C.d, 10);
      wire('plan', [[220, 322], [245, 322], [245, 100], [270, 100]], C.p, { nd: 1, dur: 1.6 });
      wire('ctx', [[480, 100], [540, 100]], C.c, { nd: 1 }); T(510, 90, 'CTX', C.d, 9, 'middle');
      wire('build', [[220, 385], [505, 385], [505, 160], [540, 160]], C.t, { dur: 2.4 }); T(360, 378, 'delegate → builder', C.d, 10, 'middle');
      wire('gate', [[540, 185], [520, 185], [520, 430], [120, 430], [120, 408]], C.p, { dash: '7 6', dur: 2.8 }); T(330, 424, 'done? · same error ×2 → brain', C.d, 10, 'middle');
      wire('commit', [[220, 343], [375, 343], [375, 198]], C.a, { dur: 1.8 }); T(298, 336, 'commit → memory', C.a, 10, 'middle');
      wire('load', [[600, 198], [600, 250]], C.t, { dur: 1 }); T(608, 228, 'load', C.d, 10);
      wire('call', [[700, 250], [700, 198]], C.c, { dur: 1 }); T(708, 228, 'call', C.d, 10);
      wire('out:ui', [[760, 100], [812, 100]], C.d);
      wire('out:code', [[760, 100], [786, 100], [786, 228], [812, 228]], C.d);
      wire('out:run', [[760, 100], [786, 100], [786, 356], [812, 356]], C.d);
      wire('f:ui', [[980, 100], [1004, 100], [1004, 28], [720, 28], [720, 68]], C.g, { dur: 2 });
      wire('f:code', [[980, 228], [1004, 228], [1004, 28], [720, 28], [720, 68]], C.g, { dur: 2 });
      wire('f:run', [[980, 356], [1004, 356], [1004, 28], [720, 28], [720, 68]], C.g, { dur: 2 });
      T(862, 22, 'findings', C.d, 10, 'middle');
      const root = P;
      if (!logOn) { root.setAttribute('viewBox', '0 0 1024 450'); return; }
      logG = el('g', {}); P = logG; logFit = logPanel(20, 462, 984, 176, 60, 12, 20); P = root;
    }

    function tallScene() {
      mk('0 0 390 900'); const root = P; FMIN = 11;
      grp(8, 44, 364, 98, 'ORCHESTRATOR', C.g); actBind(card(16, 68, 348, 62, C.g), C.g, (s) => s.orch === 'thinking' || s.orch === 'writing'); botIcon(322, 74); T(30, 92, 'ORCHESTRATOR', C.t, 14, 'start', 1); orchBits(30, 118, 110, 113, 170, 350, 118, 14, 208, 92);
      wire('ask', [[130, 142], [130, 166]], C.p, { nd: 1, dur: .8 }); wire('verdict', [[250, 166], [250, 142]], C.p, { nd: 1, dur: .8 });
      const g = el('g', { transform: 'translate(0,122)' }); P = g;
      grp(8, 44, 364, 98, 'BRAIN', C.p); actBind(card(16, 68, 348, 62, C.p), C.p, (s) => s.opus === 'awake'); T(30, 92, 'OPUS 5.5', C.t, 15, 'start', 1); T(118, 92, 'plan + final gate', C.d, 11); T(30, 114, 'plan · same error ×2 · done', C.d, 11); opusBits(298, 114, 350, 92, 350, 76);
      grp(8, 166, 364, 112, 'MEMORY', C.a); actBind(card(16, 190, 348, 80), C.c, (s) => s.recall.run); T(30, 208, 'RECALL', C.t, 13, 'start', 1); T(350, 208, 'haiku 5.5', C.d, 10, 'end');
      actBind(el('rect', { x: 28, y: 218, width: 158, height: 44, rx: 8, fill: 'none', stroke: C.c }), C.c, (s) => s.active && s.active.codegraph > 0); T(38, 236, '● CODEGRAPH', C.c, 11, 'start', 1);
      actBind(el('rect', { x: 194, y: 218, width: 158, height: 44, rx: 8, fill: 'none', stroke: C.a }), C.a, (s) => s.active && s.active.hindsight > 0); T(204, 236, '● HINDSIGHT', C.a, 11, 'start', 1); recallBits(38, 252, 204, 252);
      grp(8, 302, 364, 196, 'BUILDER', C.t); actBind(card(16, 326, 348, 84), C.t, (s) => s.builder === 'building'); botIcon(322, 334); T(30, 350, 'BUILDER', C.t, 15, 'start', 1); T(30, 366, 'sonnet 5.5 · projects only', C.d, 11); builderBits(30, 398, 30, 376, 320);
      card(16, 430, 348, 60); T(30, 448, 'LOADOUT', C.t, 11, 'start', 1);
      const mc = [0, 1, 2, 3].map((i) => T(30 + i * 84, 474, '', C.d, 11)); const T0 = T(350, 448, '', C.d, 10, 'end');
      bind((s) => { const L = s.loadout; T0.textContent = L.skills.length + ' skills · ' + L.mcps.length + ' mcp'; mc.forEach((t, i) => { const m = L.mcps[i]; if (!m) { t.textContent = ''; return; } const on = !!s.mcpSeen[m]; t.textContent = (on ? '● ' : '○ ') + ell(m, 10); t.setAttribute('fill', on ? (m === 'hindsight' ? C.a : m === 'codegraph' ? C.c : C.g) : C.d); }); });
      const GY = 122, CY = 522, CH = 130; grp(8, CY, 364, CH, 'COUNCIL', C.g);
      [['ui', 'UI', 16], ['code', 'CODE', 135], ['run', 'RUN', 254]].forEach((n) => councilCard(n[0], n[2], 548, 110, 92, n[1], '', false));
      wire('plan', [[190, 142], [190, 166]], C.g, { nd: 1, dur: .8 }); wire('ctx', [[190, 278], [190, 302]], C.c, { nd: 1, dur: .8 });
      wire('load', [[130, 410], [130, 430]], C.t, { nd: 1, dur: .8 }); wire('call', [[250, 430], [250, 410]], C.c, { nd: 1, dur: .8 });
      wire('out:ui', [[190, 498], [190, 512], [104, 512], [104, 548]], C.d); wire('out:code', [[190, 498], [190, 548]], C.d, { dur: 1 }); wire('out:run', [[190, 498], [190, 512], [309, 512], [309, 548]], C.d);
      [['ui', 71], ['code', 190], ['run', 309]].forEach((n) => wire('f:' + n[0], [[n[1], 640], [n[1], 664], [382, 664], [382, 368], [364, 368]], C.g, { dur: 2 }));
      wire('commit', [[364, 100], [377, 100], [377, 230], [364, 230]], C.a, { nd: 1, dur: 1.6 }); P = root;
      const LY = GY + CY + CH + 36, LH = 330; tallVB = [LY + LH + 12, LY - 8];
      if (logOn) { logG = el('g', {}); P = logG; logPanel(13, LY, 364, LH, 6, 12, 44, 48, 22); P = root; }
      FMIN = 0; root.setAttribute('viewBox', '0 0 390 ' + tallVB[logOn ? 0 : 1]);
    }

    // the wide scene's cards, groups and wires re-flowed into two columns for a tall pane (viewBox 672 x 1008 with the log, 672 x 822 without)
    function portraitScene() {
      mk('0 0 672 1008');
      grp(8, 40, 244, 170, 'ORCHESTRATOR', C.g); grp(412, 40, 244, 170, 'MEMORY', C.a); grp(8, 250, 244, 170, 'BRAIN', C.p); grp(412, 250, 244, 170, 'BUILDER', C.t); grp(8, 470, 244, 344, 'LOADOUT', C.t); grp(412, 470, 244, 344, 'COUNCIL', C.g);
      actBind(card(20, 68, 220, 130, C.g), C.g, (s) => s.orch === 'thinking' || s.orch === 'writing'); botIcon(192, 76); T(36, 92, 'ORCHESTRATOR', C.t, 14, 'start', 1); orchBits(36, 134, 36, 142, 188, 224, 134, 16, 36, 108);
      T(36, 166, '▸ talks to you', C.d, 11); T(36, 182, '▸ asks the Brain', C.d, 11);
      actBind(card(20, 278, 220, 130, C.p), C.p, (s) => s.opus === 'awake'); T(36, 302, 'OPUS 5.5', C.t, 15, 'start', 1); T(36, 318, 'plan + final gate', C.d, 11);
      ['▸ plan locks', '▸ same error ×2', '▸ before done'].forEach((s, i) => T(36, 342 + i * 16, s, C.d, 12));
      opusBits(36, 400, 224, 400, 226, 298);
      actBind(card(424, 68, 220, 130), C.c, (s) => s.recall.run); T(440, 92, 'RECALL', C.t, 15, 'start', 1); T(628, 92, 'haiku 5.5', C.d, 11, 'end');
      actBind(el('rect', { x: 440, y: 106, width: 188, height: 40, rx: 8, fill: 'none', stroke: C.c }), C.c, (s) => s.active && s.active.codegraph > 0); T(452, 124, '● CODEGRAPH', C.c, 11, 'start', 1);
      actBind(el('rect', { x: 440, y: 152, width: 188, height: 40, rx: 8, fill: 'none', stroke: C.a }), C.a, (s) => s.active && s.active.hindsight > 0); T(452, 170, '● HINDSIGHT', C.a, 11, 'start', 1);
      recallBits(452, 138, 452, 184);
      actBind(card(424, 278, 220, 130), C.t, (s) => s.builder === 'building'); botIcon(606, 286); T(440, 302, 'BUILDER', C.t, 15, 'start', 1); T(440, 318, 'sonnet 5.5 · projects only', C.d, 11); builderBits(440, 344, 440, 352, 188); T(440, 378, 'applies council findings', C.d, 11);
      card(20, 498, 220, 304); T(36, 520, 'LOADOUT', C.t, 12, 'start', 1); el('path', { d: 'M36,530H224', stroke: C.gl }); skillsMcps([34, 146], 566, 16, 14);
      [['ui', 498, 'UI', 'layout · screenshots'], ['code', 602, 'CODE', 'diff · bugs · style'], ['run', 706, 'RUN', 'tests · app boots']].forEach((n) => councilCard(n[0], 440, n[1], 192, 96, n[2], n[3], true));
      wire('ask', [[100, 198], [100, 278]], C.p, { nd: 1, dur: 1 }); T(108, 238, 'ask', C.d, 10);
      wire('verdict', [[140, 278], [140, 198]], C.p, { nd: 1, dur: 1 }); T(148, 238, 'verdict', C.d, 10);
      wire('plan', [[240, 322], [276, 322], [276, 100], [424, 100]], C.p, { nd: 1, dur: 1.6 });
      wire('ctx', [[534, 198], [534, 278]], C.c, { nd: 1 }); T(542, 242, 'CTX', C.d, 9);
      wire('build', [[240, 372], [424, 372]], C.t, { dur: 1.4 }); T(332, 365, 'delegate → builder', C.d, 10, 'middle');
      wire('gate', [[424, 395], [240, 395]], C.p, { dash: '7 6', dur: 1.4 }); T(332, 388, 'done? · same error ×2 → brain', C.d, 10, 'middle');
      wire('commit', [[240, 343], [312, 343], [312, 170], [424, 170]], C.a, { dur: 1.8 }); T(320, 232, 'commit → memory', C.a, 10);
      wire('load', [[460, 408], [460, 432], [60, 432], [60, 498]], C.t, { dur: 1 }); T(466, 424, 'load', C.d, 10);
      wire('call', [[110, 498], [110, 446], [500, 446], [500, 408]], C.c, { dur: 1 }); T(506, 424, 'call', C.d, 10);
      [['ui', 530], ['code', 634], ['run', 738]].forEach((n) => {
        wire('out:' + n[0], [[570, 408], [570, 458], [424, 458], [424, n[1]], [440, n[1]]], C.d);
        wire('f:' + n[0], [[632, n[1]], [664, n[1]], [664, 330], [644, 330]], C.g, { dur: 2 });
      });
      T(658, 455, 'findings', C.d, 10, 'end');
      const root = P;
      if (!logOn) { root.setAttribute('viewBox', '0 0 672 822'); return; }
      logG = el('g', {}); P = logG; logFit = logPanel(20, 826, 632, 174, 8, 12, 20); P = root; logFit(174);
    }

    function render() { if (last) BIND.forEach((f) => f(last.s, last.ex)); }
    // wide only: the box is w x h pixels; the viewBox grows taller to fill it and the log panel takes the extra height
    function fit(w, h) {
      if (layout !== 'wide' || !w || !h || !logFit) return;
      fw = w; fh = h;
      const H = Math.max(logOn ? 640 : 450, Math.round(1024 * h / w));
      svg.setAttribute('viewBox', '0 0 1024 ' + H); logFit(H - 462 - 2);
    }
    // hide or show the log panel (the /panel page's Log toggle)
    function setLog(on) {
      if (!logG) return; logOn = !!on; logG.setAttribute('display', logOn ? 'inline' : 'none');
      if (layout === 'wide') { if (fw && fh) fit(fw, fh); else svg.setAttribute('viewBox', '0 0 1024 ' + (logOn ? 640 : 450)); } else if (layout === 'portrait') svg.setAttribute('viewBox', '0 0 672 ' + (logOn ? 1008 : 822)); else svg.setAttribute('viewBox', '0 0 390 ' + tallVB[logOn ? 0 : 1]);
    }

    const svg = (layout === 'wide' ? wideScene() : layout === 'portrait' ? portraitScene() : tallScene(), P);
    if (layout === 'wide') fit(1024, 640);
    if (opts.width) {
      const vb = svg.getAttribute('viewBox').split(' ').map(Number);
      svg.setAttribute('width', opts.width); svg.setAttribute('height', Math.round(opts.width * vb[3] / vb[2]));
    }
    return {
      svg, fit, pulse, flow, setLog,
      // state: the merged diagram state; extra: { log: [...], changes: [...] } for the log panel
      apply(state, extra) { last = { s: state, ex: extra || {} }; render(); },
      setBots(n) { BOTS.forEach((b) => { b.t.textContent = n ? String(n) : ''; b.h.setAttribute('stroke', n ? C.g : C.d); }); },
    };
  }

  return { createScene, C, NS, FONT_FAMILY, CSS_STATIC, CSS_ANIM };
});
