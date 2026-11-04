'use strict';
// Server-side snapshots of the Engine graph: the same scene.js the dashboard runs, drawn into scene-dom.js.
const path = require('path');
const fs = require('fs');
const { createDocument, Element } = require('./scene-dom.js');
const scene = require('./scene.js');

const FONT_DIR = path.join(__dirname, 'fonts');
const FONT_FILES = ['JetBrainsMono-Regular.ttf', 'JetBrainsMono-Medium.ttf', 'JetBrainsMono-Bold.ttf'];

function walk(e, fn) { fn(e); e.children.slice().forEach((c) => { if (c instanceof Element) walk(c, fn); }); }

// a still image has no animation: drop SMIL and CSS animation, and bake the bar transforms into widths
function stillen(svg) {
  walk(svg, (e) => {
    e.children = e.children.filter((c) => !(c instanceof Element && (c.tagName === 'set' || c.tagName === 'animateMotion')));
    e.style.animation = '';
    const m = /^scaleX\(([\d.]+)\)$/.exec(e.style.transform);
    if (m && e.style.transformBox) {
      e.setAttribute('width', +(Number(e.getAttribute('width')) * Number(m[1])).toFixed(2));
      e.style.transform = ''; e.style.transformBox = ''; e.style.transformOrigin = '';
    }
  });
}

// state: the merged diagram state (as the dashboard sees it); logs: { log: [[t,unit,msg]], changes: [[t,tool,path]] }
// o: layout 'wide'|'tall', width (px), animated (default true), tab 'log'|'changes'
function renderGraphSvg(state, logs, o) {
  o = o || {};
  const layout = o.layout === 'tall' ? 'tall' : 'wide', animated = o.animated !== false;
  const width = Math.round(Number(o.width)) || (layout === 'tall' ? 480 : 1024);
  const doc = createDocument();
  const sc = scene.createScene({ document: doc, layout, width, tab: o.tab === 'changes' ? 'chg' : 'log', reduceMotion: () => !animated });
  const L = logs || {};
  sc.apply(state, { log: (L.log || []).slice(-15).map((r) => r.slice(0, 3)), changes: (L.changes || []).slice(-15).map((r) => r.slice(0, 3)) });
  const svg = sc.svg, vb = svg.getAttribute('viewBox').split(' ').map(Number);
  svg.setAttribute('font-family', scene.FONT_FAMILY);
  const bg = doc.createElementNS(scene.NS, 'rect');
  ['x', 'y'].forEach((k) => bg.setAttribute(k, 0)); bg.setAttribute('width', vb[2]); bg.setAttribute('height', vb[3]); bg.setAttribute('fill', scene.C.bg);
  svg.children.unshift(bg); bg.parentNode = svg;
  const st = doc.createElementNS(scene.NS, 'style');
  st.textContent = scene.CSS_STATIC + (animated ? scene.CSS_ANIM : '');
  svg.appendChild(st);
  if (!animated) stillen(svg);
  return svg.serialize();
}

function loadResvg() {
  try { return require('@resvg/resvg-js'); } catch (er) { const e = new Error('PNG rendering is unavailable: @resvg/resvg-js is not installed'); e.code = 'RESVG_UNAVAILABLE'; throw e; }
}
// Global limit across all projects: at most MAX_CONCURRENT native renders at once, extra requests wait FIFO (max MAX_QUEUE, then
// RENDER_BUSY). A native resvg render cannot be cancelled, so on timeout the caller gets RENDER_TIMEOUT at once but the slot stays
// taken until the native call really returns; a stuck render therefore keeps its slot rather than letting new ones pile up.
const MAX_CONCURRENT = 2, MAX_QUEUE = 20, MAX_SVG_BYTES = 2 * 1024 * 1024;
const waiting = [];
let running = 0;
function acquire(maxQueue) {
  if (running < MAX_CONCURRENT) { running++; return Promise.resolve(); }
  if (waiting.length >= maxQueue) { const e = new Error('busy'); e.code = 'RENDER_BUSY'; return Promise.reject(e); }
  return new Promise((res) => waiting.push(res));
}
function release() { const next = waiting.shift(); if (next) next(); else running--; }

// svg: a string from renderGraphSvg(..., { animated: false }); scale 1..3 multiplies its width (output capped at 4096 px wide).
// Resolves to a PNG Buffer; rejects after timeoutMs (default 5000) counted from when the render starts.
// o.render / o.maxQueue are test hooks.
async function renderGraphPng(svg, o) {
  if (typeof svg !== 'string' || Buffer.byteLength(svg) > MAX_SVG_BYTES) { const e = new Error('SVG too large'); e.code = 'SVG_TOO_LARGE'; throw e; }
  const renderAsync = (o && o.render) || loadResvg().renderAsync, scale = Math.min(3, Math.max(1, Number(o && o.scale) || 1));
  await acquire((o && o.maxQueue) ?? MAX_QUEUE);
  let timer, native;
  try {
    const w = Number((/<svg[^>]*?\swidth="([\d.]+)"/.exec(svg) || [])[1]) || 1024;
    const ac = new AbortController();
    native = Promise.resolve(renderAsync(svg, {
      fitTo: { mode: 'width', value: Math.min(4096, Math.round(w * scale)) },
      font: { fontFiles: FONT_FILES.map((f) => path.join(FONT_DIR, f)).filter((f) => fs.existsSync(f)), loadSystemFonts: false, defaultFontFamily: 'JetBrains Mono' },
    }, ac.signal));
    native.then(() => {}, () => {}).then(release); // slot is freed only when the native render has returned
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); const e = new Error('PNG render timed out'); e.code = 'RENDER_TIMEOUT'; rej(e); }, (o && o.timeoutMs) || 5000); });
    const img = await Promise.race([native, timeout]);
    return img.asPng();
  } catch (er) {
    if (!native) release();
    throw er;
  } finally { clearTimeout(timer); }
}

module.exports = { renderGraphSvg, renderGraphPng };
