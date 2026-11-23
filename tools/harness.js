/* 浏览器式 vm 沙箱 + 最小 DOM 桩，供 UI 相关测试复用。
   导出 { sandbox, documentStub, getOrCreate, loadAll, fireReady }。 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class El {
  constructor(tag, ns) {
    this.tagName = (tag || 'div').toUpperCase();
    this.ns = ns || null;
    this.children = [];
    this.attributes = {};
    const attrStore = this.attributes;
    const camelToKebab = k => 'data-' + k.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
    this.dataset = new Proxy({}, {
      get(t, k) { return attrStore[camelToKebab(String(k))]; },
      set(t, k, v) { attrStore[camelToKebab(String(k))] = String(v); return true; }
    });
    this.style = {};
    this._text = '';
    this._className = '';
    this.value = '';
    this.files = [];
    this.eventListeners = {};
    this._rect = { left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 };
    const self = this;
    this.classList = {
      _set: new Set(),
      _sync() { self._className = Array.from(this._set).join(' '); },
      add(...cs) { cs.forEach(c => this._set.add(c)); this._sync(); },
      remove(...cs) { cs.forEach(c => this._set.delete(c)); this._sync(); },
      contains(c) { return this._set.has(c); },
      toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); this._sync(); }
    };
  }
  get className() { return this._className; }
  set className(v) {
    this._className = v || '';
    if (this.classList) this.classList._set = new Set((v || '').split(/\s+/).filter(Boolean));
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map(c => c.textContent).join('');
    return this._text;
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this.className = String(v);
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
  }
  getAttribute(k) { return this.attributes[k]; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  addEventListener(t, fn) { (this.eventListeners[t] ||= []).push(fn); }
  dispatch(t, ev = {}) { (this.eventListeners[t] || []).forEach(fn => fn({ target: this, ...ev })); }
  getBoundingClientRect() { return this._rect; }
  querySelectorAll() { return []; }
  focus() {} blur() {}
}

const registry = new Map();
function getOrCreate(id) {
  if (!registry.has(id)) registry.set(id, new El('div'));
  return registry.get(id);
}

const documentStub = {
  documentElement: new El('html'),
  body: new El('body'),
  createElement: tag => new El(tag),
  createElementNS: (ns, tag) => new El(tag, ns),
  createTextNode: () => new El('#text'),
  getElementById: id => getOrCreate(id),
  querySelectorAll: () => [],
  addEventListener(t, fn) { (this._ev ||= {})[t] = fn; },
  fireReady() { this._ev.DOMContentLoaded && this._ev.DOMContentLoaded({}); }
};

function buildSandbox() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PRA = {};
  sandbox.matchMedia = () => ({ matches: false, addListener() {} });
  sandbox.innerWidth = 1280;
  sandbox.innerHeight = 900;
  sandbox.addEventListener = function () {};
  sandbox.getComputedStyle = () => ({ getPropertyValue: () => '#000000' });
  sandbox.document = documentStub;
  sandbox.Event = class {};
  sandbox.Option = function (text, value) { this.text = text; this.value = value; };
  sandbox.fetch = async f => ({ text: async () => fs.readFileSync(path.join(__dirname, '..', f), 'utf8') });
  sandbox.console = console;
  sandbox.setTimeout = setTimeout;
  sandbox.setInterval = () => 0;
  sandbox.clearTimeout = () => {};
  for (const k of ['Math', 'Date', 'JSON', 'Object', 'Array', 'Number', 'String', 'Boolean',
    'RegExp', 'Error', 'Map', 'Set', 'Promise', 'Symbol', 'parseInt', 'parseFloat', 'isFinite', 'isNaN']) {
    sandbox[k] = global[k];
  }
  vm.createContext(sandbox);
  return sandbox;
}

function loadAll(sandbox) {
  const load = rel => vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'), sandbox, { filename: rel });
  ['js/rng.js', 'js/stats.js', 'js/pipeline.js', 'js/importer.js', 'js/sample-data.js', 'js/charts.js', 'js/app.js']
    .forEach(load);
}

module.exports = { El, getOrCreate, documentStub, buildSandbox, loadAll };
