"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../gesture-test.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../blind-book-ocr-json-test.html"), "utf8");
const parserContext = { window: {}, console, Intl };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../gesture-engine.js"), "utf8"), parserContext);
const realParse = value => parserContext.window.GestureEngine.parseTextMap(value);

class Element {
  constructor(id) {
    this.id = id; this.handlers = {}; this.children = []; this.style = {}; this.files = [];
    this.value = ""; this.textContent = ""; this.classes = new Set();
    this.classList = {
      toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
      remove: name => this.classes.delete(name)
    };
  }
  addEventListener(type, callback) { this.handlers[type] = callback; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  pause() {}
  getBoundingClientRect() { return { left: 10, top: 20, width: 600, height: 400 }; }
}
function map(text = "中文测试") {
  return { rectified_size: [600, 400], lines: [
    { id: "line-1", text, bbox_rectified: [40, 50, 240, 30], reading_order: 1 }
  ] };
}
function harness({ secure = true, gate = null, failure = null } = {}) {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); };
  const engines = [], windowHandlers = {}, documentHandlers = {}, events = [];
  let stopped = 0;
  class Engine {
    constructor(video, options) { this.video = video; this.options = options; this.lineById = new Map(); engines.push(this); }
    static parseTextMap(data) { return realParse(data); }
    setTextMap(data) { this.data = data; const parsed = realParse(data); this.lineById = new Map(parsed.lines.map(line => [line.id, line])); }
    async init(options = {}) {
      this.initOptions = options;
      if (options.mediaPipe !== false) this.video.srcObject = { getTracks: () => [{ stop() { stopped++; } }] };
      if (gate) await gate;
      if (failure) throw failure;
    }
    destroy() { this.destroyed = true; }
    resizeCanvas() {}
    refreshLayout() {}
    emitWordFocus(event, word) { this.options.onWordFocus({ event, word: word.text, fullLine: word.fullLine }); }
    updatePointerTrace(x, y, now) { this.trace = { x, y, now }; return this.trace; }
    handlePointerWord(trace) { this.lastTrace = trace; }
  }
  const window = { GestureEngine: Engine, isSecureContext: secure,
    addEventListener: (type, callback) => { windowHandlers[type] = callback; },
    dispatchEvent: event => events.push(event) };
  const document = { baseURI: "https://example.invalid/ocr-text-map/", hidden: false,
    getElementById: id => node(id), createElement: tag => new Element(tag),
    addEventListener: (type, callback) => { documentHandlers[type] = callback; } };
  vm.runInNewContext(source, { window, document, navigator: { mediaDevices: { getUserMedia() {} } },
    URL, performance: { now: () => 2000 }, CustomEvent: class { constructor(type, options) { Object.assign(this, { type }, options); } } });
  return { app: window.FeelyGestureWorkspace, node: id => node(`c-${id}`), engines, events,
    windowHandlers, documentHandlers, document, stopped: () => stopped };
}

test("the restored C URL loads local shared engine and exposes live-camera controls", () => {
  assert.match(html, /vendor\/mediapipe\/hands\.js/);
  assert.match(html, /gesture-engine\.js/);
  assert.match(html, /gesture-test\.js/);
  assert.match(html, /不追踪纸页/);
  assert(!/https?:\/\/.*(?:jsdelivr|unpkg)/.test(html));
  for (const id of ["camera", "start", "stop", "file", "hand-status", "region"]) assert(html.includes(`id="c-${id}"`));
});
test("camera and hand counts work before importing any text map", async () => {
  const h = harness();
  await h.app.startCamera();
  assert.equal(h.app.getState().mode, "camera");
  assert.equal(h.app.getState().lineCount, 0);
  const engine = h.engines[0];
  assert.equal(engine.options.requestCamera, true);
  assert.equal(engine.options.objectFit, "contain");
  assert.equal(engine.options.locateFile("hands.binarypb"), "https://example.invalid/ocr-text-map/vendor/mediapipe/hands.binarypb");
  engine.options.onHandUpdate({ count: 2, fps: 24.2 });
  assert.match(h.node("hand-status").textContent, /2.*24 FPS/);
  h.app.stop();
  assert.equal(h.app.getState().mode, "inactive");
  assert(engine.destroyed); assert.equal(h.node("camera").srcObject, null); assert.equal(h.stopped(), 1);
});
test("multi-region imports keep each rectified coordinate system and safe text rendering", async () => {
  const h = harness(); const raw = map("<img onerror=alert(1)>");
  raw.regions = [{ id: "left", label: "左页", rectified_size: [600, 400] }, { id: "right", label: "右页", rectified_size: [800, 600] }];
  raw.lines[0].region_id = "left";
  raw.lines.push({ ...raw.lines[0], id: "line-2", text: "右页", region_id: "right" });
  h.app.importMap(raw);
  assert.equal(h.app.getState().mapCount, 2);
  assert.equal(h.node("map").children[0].textContent, "<img onerror=alert(1)>");
  assert.equal(h.node("map").children[0].innerHTML, undefined);
  await h.app.startDemo();
  h.node("region").value = "1"; h.node("region").handlers.change();
  assert.equal(h.app.getState().selected, 1);
  assert.deepEqual(h.engines[0].data.rectified_size, [800, 600]);
  assert.equal(h.engines[0].data.lines.length, 1);
  assert.equal(h.engines[0].data.lines[0].text, "右页");
});
test("mouse mode calls the same word-focus path without requesting camera or MediaPipe", async () => {
  const h = harness(); h.app.importMap(map()); await h.app.startDemo();
  assert.equal(h.engines[0].initOptions.mediaPipe, false);
  assert.equal(h.node("camera").srcObject, undefined);
  h.node("viewer").handlers.pointermove({ clientX: 100, clientY: 90 });
  assert.equal(h.engines[0].lastTrace.x, 100);
  h.node("map").children[0].handlers.click();
  assert.match(h.node("focus").textContent, /中文/);
  assert.equal(h.events[0].type, "feelyreader:c-word-focus");
});
test("invalid JSON does not erase the current map, and empty regions are skipped", () => {
  const h = harness(); h.app.importMap(map());
  const invalid = map(); invalid.lines[0].bbox_rectified[2] = -3;
  assert.throws(() => h.app.importMap(invalid), /bbox_rectified/);
  assert.equal(h.app.getState().lineCount, 1);
  const raw = map(); raw.lines[0].region_id = "right";
  raw.regions = [{ id: "left", rectified_size: [600, 400] }, { id: "right", rectified_size: [600, 400] }];
  h.app.importMap(raw); assert.equal(h.app.getState().mapCount, 1);
});
test("runtime model errors are visible and release the camera; background also stops it", async () => {
  const h = harness(); await h.app.startCamera();
  h.engines[0].options.onError(new Error("model unavailable"));
  assert.equal(h.app.getState().mode, "inactive");
  assert.match(h.node("status").textContent, /model unavailable/);
  assert.equal(h.node("camera").srcObject, null);
  await h.app.startCamera(); h.document.hidden = true; h.documentHandlers.visibilitychange();
  assert.equal(h.app.getState().mode, "inactive"); assert.equal(h.node("camera").srcObject, null);
});
test("stopping during async initialization cannot revive the old session or status", async () => {
  let resolve; const gate = new Promise(done => { resolve = done; });
  const h = harness({ gate }); const start = h.app.startCamera();
  h.app.stop("用户已停止"); resolve(); await start;
  assert.equal(h.app.getState().mode, "inactive"); assert(h.engines[0].destroyed);
  assert.equal(h.node("status").textContent, "用户已停止");
  h.engines[0].options.onHandUpdate({ count: 2, fps: 30 });
  assert.equal(h.node("hand-status").textContent, "手部检测未启动");
});
test("nonsecure contexts fail visibly before creating a camera engine", async () => {
  const h = harness({ secure: false }); await h.app.startCamera();
  assert.equal(h.engines.length, 0); assert.equal(h.app.getState().mode, "inactive");
  assert.match(h.node("status").textContent, /HTTPS/);
});
