'use strict';
// A tiny DOM for Node, only what scene.js needs to build the Engine graph. Server side only.
// createDocument() -> { createElementNS, createElement }; element.serialize() -> markup string.
const SVG_NS = 'http://www.w3.org/2000/svg';
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
const kebab = (k) => (k.startsWith('--') ? k : k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));

class Raw { constructor(markup) { this.markup = String(markup); } }

class Element {
  constructor(tag, ns) {
    this.tagName = tag; this.namespaceURI = ns || null;
    this.attrs = new Map(); this.children = []; this.parentNode = null;
    this._css = new Map();
    const css = this._css;
    this.style = new Proxy({}, {
      get: (_, k) => {
        if (k === 'setProperty') return (n, v) => { v == null || v === '' ? css.delete(n) : css.set(n, String(v)); };
        if (k === 'removeProperty') return (n) => { css.delete(n); };
        if (k === 'getPropertyValue') return (n) => css.get(n) || '';
        if (k === 'cssText') return this._cssText();
        return typeof k === 'string' ? css.get(kebab(k)) || '' : undefined;
      },
      set: (_, k, v) => { const n = kebab(String(k)); v == null || v === '' ? css.delete(n) : css.set(n, String(v)); return true; },
    });
    const self = this;
    this.classList = {
      _l: () => (self.attrs.get('class') || '').split(/\s+/).filter(Boolean),
      _w(l) { self.attrs.set('class', l.join(' ')); },
      add(...n) { const l = this._l(); n.forEach((x) => { if (!l.includes(x)) l.push(x); }); this._w(l); },
      remove(...n) { this._w(this._l().filter((x) => !n.includes(x))); },
      contains(n) { return this._l().includes(n); },
      toggle(n, force) {
        const has = this.contains(n), want = force === undefined ? !has : !!force;
        if (want && !has) this.add(n); else if (!want && has) this.remove(n);
        return want;
      },
    };
  }
  _cssText() { return [...this._css].map(([k, v]) => k + ':' + v).join(';'); }
  setAttribute(k, v) {
    if (k === 'style') {
      this._css.clear();
      String(v).split(';').forEach((d) => { const i = d.indexOf(':'); if (i > 0) { const n = d.slice(0, i).trim(), val = d.slice(i + 1).trim(); if (n && val) this._css.set(n, val); } });
      return;
    }
    this.attrs.set(String(k), String(v));
  }
  getAttribute(k) { if (k === 'style') return this._css.size ? this._cssText() : null; return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  removeAttribute(k) { if (k === 'style') this._css.clear(); else this.attrs.delete(k); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this.children.map((c) => (c instanceof Element ? c.textContent : c instanceof Raw ? '' : c)).join(''); }
  set textContent(t) { this.children.forEach((c) => { if (c instanceof Element) c.parentNode = null; }); this.children = t == null || t === '' ? [] : [String(t)]; }
  set innerHTML(m) { this.children.forEach((c) => { if (c instanceof Element) c.parentNode = null; }); this.children = m ? [new Raw(m)] : []; }
  get innerHTML() { return this.children.map((c) => (c instanceof Element ? c.serialize() : c instanceof Raw ? c.markup : escText(c))).join(''); }
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() { return true; }
  serialize() {
    const a = [];
    if (this.tagName === 'svg' && !this.attrs.has('xmlns')) a.push(' xmlns="' + SVG_NS + '"');
    for (const [k, v] of this.attrs) { if (k === 'class' && !v) continue; a.push(' ' + k + '="' + escAttr(v) + '"'); }
    if (this._css.size) a.push(' style="' + escAttr(this._cssText()) + '"');
    const inner = this.innerHTML;
    return '<' + this.tagName + a.join('') + (inner ? '>' + inner + '</' + this.tagName + '>' : '/>');
  }
}

function createDocument() {
  return {
    createElementNS: (ns, tag) => new Element(tag, ns),
    createElement: (tag) => new Element(tag, null),
  };
}

module.exports = { createDocument, Element, SVG_NS };
