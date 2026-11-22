/* Run: node tests/test_reader_ui.cjs. The DOM/controller simulation checks E's
 * orchestration; camera, real OCR, speech and gesture geometry have separate tests.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

class DrawingContext {
  constructor() { this.reset(); }
  reset() { this.paths = []; this.path = []; this.draws = []; }
  save() {}
  restore() {}
  translate() {}
  rotate() {}
  fillRect() {}
  drawImage(...args) { this.draws.push(args); }
  beginPath() { this.path = []; }
  moveTo(x, y) { this.path.push([x, y]); }
  lineTo(x, y) { this.path.push([x, y]); }
  closePath() {}
  fill() {}
  stroke() { this.paths.push(this.path.slice()); }
  setLineDash() {}
}

class Element {
  constructor(id) {
    this.id = id; this.handlers = {}; this.children = []; this.dataset = {};
    this.hidden = false; this.disabled = false; this.checked = false;
    this.value = ""; this.textContent = ""; this.files = []; this.attributes = {};
    this.context = new DrawingContext(); this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  }
  set width(value) { this._width = value; this.context.reset(); }
  get width() { return this._width; }
  set height(value) { this._height = value; this.context.reset(); }
  get height() { return this._height; }
  get options() { return this.children; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelectorAll(selector) { return this.children.filter(item => `.${item.className}` === selector); }
  getContext() { return this.context; }
  getBoundingClientRect() { return { left: 10, top: 20, width: 300, height: 200 }; }
  remove() {}
}

function photo(width = 2400, height = 1600, size) {
  const file = new Blob([new Uint8Array([255, 216, 255, 224])], { type: "image/jpeg" });
  Object.assign(file, { name: "中文照片.jpg", width, height });
  if (size != null) Object.defineProperty(file, "size", { value: size });
  return file;
}

function browser({ deferImages = false } = {}) {
  const elements = new Map();
  const node = id => {
    const key = `reader-${id}`;
    if (!elements.has(key)) elements.set(key, new Element(key));
    return elements.get(key);
  };
  const initial = {
    status: "idle", message: "等待照片", progress: 0, pages: [], activePageKey: null,
    activeMap: null, activeImageUrl: null, trackingReady: false, gesturesEnabled: false,
    reading: { status: "idle", speed: 1, currentIndex: 0 }, highlights: [], history: []
  };
  const calls = [];
  let reader;
  class FakeController {
    constructor() { reader = this; this.state = initial; this.listeners = []; }
    getState() { return this.state; }
    addEventListener(name, callback) { assert.equal(name, "state"); this.listeners.push(callback); }
    emit(patch) { this.state = { ...this.state, ...patch }; this.listeners.forEach(callback => callback({ detail: this.state })); }
    setConfig(config) { calls.push(["setConfig", config]); }
    selectPhoto(file) { calls.push(["selectPhoto", file]); this.emit({ status: "recognizing", message: "正在识别", progress: .25 }); }
    importMap(map) { calls.push(["importMap", map]); }
    selectPage(key) { calls.push(["selectPage", key]); }
    cancel() { calls.push(["cancel"]); this.emit({ status: "idle", message: "已取消" }); }
    setGesturesEnabled(enabled) { calls.push(["setGesturesEnabled", enabled]); this.emit({ gesturesEnabled: enabled }); }
    play() { calls.push(["play"]); }
    pause() { calls.push(["pause"]); }
    prev() { calls.push(["prev"]); }
    next() { calls.push(["next"]); }
    setSpeed(speed) { calls.push(["setSpeed", speed]); }
    readLine(id) { calls.push(["readLine", id]); }
    saveHighlight() { calls.push(["saveHighlight"]); }
  }
  const urls = new Map(); let urlId = 0;
  const downloads = [];
  const pendingImages = [];
  class FakeImage {
    set src(url) {
      const file = urls.get(url);
      this.naturalWidth = file?.width || 1200; this.naturalHeight = file?.height || 800;
      if (deferImages && file) pendingImages.push(() => this.onload());
      else queueMicrotask(() => this.onload());
    }
  }
  node("engine").value = "browser"; node("split").value = "none";
  node("mode").value = "auto"; node("max-side").value = "1920";
  node("confidence").value = "0.45"; node("split-position").value = "50";
  for (const speed of [.75, 1, 1.25, 1.5, 2]) {
    const option = new Element("option"); option.value = String(speed); node("speed").append(option);
  }
  const context = {
    window: { FeelyReaderController: FakeController },
    document: {
      body: new Element("body"),
      getElementById(id) { return node(id.replace(/^reader-/, "")); },
      createElement(tag) {
        const element = new Element(tag);
        if (tag === "a") element.click = () => downloads.push({ blob: urls.get(element.href), filename: element.download });
        return element;
      }
    },
    setTimeout() {},
    Blob, Image: FakeImage,
    URL: { createObjectURL(file) { const url = `blob:test-${++urlId}`; urls.set(url, file); return url; }, revokeObjectURL(url) { urls.delete(url); } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../e-app.js"), "utf8"), context);
  return {
    node, calls, reader, pendingImages, downloads,
    click(id) { return node(id).handlers.click(); },
    change(id, value) { node(id).value = value; return node(id).handlers[id === "split-position" ? "input" : "change"](); },
    choose(file) { node("photo").files = [file]; return node("photo").handlers.change(); }
  };
}

async function settle() { for (let i = 0; i < 20; i += 1) await Promise.resolve(); await new Promise(setImmediate); }

function mapFixture() {
  return {
    document_id: "document-1", source_size: [1200, 800], warnings: ["请检查识别结果"],
    lines: [{ id: "line-1", reading_order: 1, text: "<img src=x onerror=alert(1)>中文", polygon_source: [[20, 20], [300, 20], [300, 70], [20, 70]] }]
  };
}

async function testPhotoManualTriggerAndSettings() {
  const app = browser(); const file = photo();
  assert.equal(app.node("recognize").disabled, true);
  await app.choose(file);
  assert(!app.calls.some(call => call[0] === "selectPhoto"), "Selecting a photo must only prepare the preview");
  assert.equal(app.node("recognize").disabled, false);
  app.click("rotate-right");
  await app.change("split", "pages");
  await app.change("split-position", "35");
  assert.equal(app.node("photo-preview").width, 800);
  assert.equal(app.node("photo-preview").height, 1200);
  assert.deepEqual(app.node("photo-preview").context.paths.at(-1), [[280, 0], [280, 1200]]);
  await app.click("recognize");
  assert.equal(app.calls.find(call => call[0] === "selectPhoto")[1], file, "Send the original File to the controller");
  const config = app.calls.filter(call => call[0] === "setConfig").at(-1)[1];
  assert.equal(config.rotation, 90); assert.equal(config.split, "pages"); assert.equal(config.split_position, .35);
  assert.equal(config.max_side, 1920); assert.equal(config.engine, "browser");
  assert.equal(app.node("recognize").disabled, true);
  await app.click("recognize");
  assert.equal(app.calls.filter(call => call[0] === "selectPhoto").length, 1, "Busy state must block duplicate manual recognition");
  assert.equal(app.node("cancel").hidden, false); assert.equal(app.node("progress").value, .25);
  await app.click("cancel");
  assert.equal(app.node("cancel").hidden, true);
  await app.change("engine", "python");
  assert.equal(app.node("endpoint-label").hidden, false);
  assert.match(app.node("engine-note").textContent, /照片会发送/);
}

async function testMapSpeechAndSafeSavedText() {
  const app = browser(); const map = mapFixture();
  app.reader.emit({
    status: "ready", message: "识别完成", pages: [{ key: "page-1", label: "第一页", map }],
    activePageKey: "page-1", activeMap: map, activeImageUrl: "blob:source-1",
    reading: { status: "idle", speed: 1.25, currentIndex: 0, currentLine: map.lines[0] },
    highlights: [{ text: "<script>bad()</script>", pageLabel: "书页" }],
    history: [{ action: "朗读", detail: "<img onerror=bad()>", time: "12:00:00" }]
  });
  await settle();
  assert.equal(app.node("map").width, 1200); assert.equal(app.node("map").height, 800);
  assert.deepEqual(app.node("map").context.paths[0], map.lines[0].polygon_source);
  const row = app.node("lines").children[0];
  assert.equal(row.children[1].textContent, map.lines[0].text);
  assert.equal(row.attributes["aria-pressed"], "true");
  assert.equal(app.node("highlights").children[0].textContent, "<script>bad()</script>");
  assert.equal(app.node("history").children[0].textContent, "朗读 · <img onerror=bad()>");
  app.click("export-json");
  assert.deepEqual(JSON.parse(await app.downloads[0].blob.text()), map, "Export preserves the active coordinate map");
  assert.match(app.downloads[0].filename, /\.json$/);
  app.click("export-txt");
  assert.equal((await app.downloads[1].blob.text()).replace(/^\uFEFF/, ""), map.lines[0].text);
  await row.handlers.click();
  assert.deepEqual(app.calls.at(-1), ["readLine", "line-1"]);
  app.node("map").handlers.click({ clientX: 20, clientY: 30 });
  await settle();
  assert.deepEqual(app.calls.at(-1), ["readLine", "line-1"], "Map click must convert CSS coordinates to source pixels");
  await app.click("play"); assert.equal(app.calls.at(-1)[0], "play");
  app.reader.emit({ reading: { status: "playing", speed: 1.25, currentIndex: 0, currentLine: map.lines[0] } });
  await app.click("play"); assert.equal(app.calls.at(-1)[0], "pause");
  await app.click("prev"); assert.equal(app.calls.at(-1)[0], "prev");
  await app.click("next"); assert.equal(app.calls.at(-1)[0], "next");
  await app.change("speed", "1.5"); assert.deepEqual(app.calls.at(-1), ["setSpeed", 1.5]);
  await app.click("save"); assert.equal(app.calls.at(-1)[0], "saveHighlight");
  await app.change("page", "page-1"); assert.deepEqual(app.calls.at(-1), ["selectPage", "page-1"]);
  app.node("gestures").checked = true;
  await app.node("gestures").handlers.change();
  assert.deepEqual(app.calls.at(-1), ["setGesturesEnabled", true]);
  assert.equal(app.node("gestures").checked, true);
}

async function testInputLimitsAndDecodeRace() {
  const invalid = browser();
  await invalid.choose(photo(2400, 1600, 8 * 1024 * 1024 + 1));
  assert.equal(invalid.node("recognize").disabled, true);
  assert.match(invalid.node("status").textContent, /8 MiB/);
  await invalid.choose(photo(5000, 4001));
  assert.equal(invalid.node("recognize").disabled, true);
  assert.match(invalid.node("status").textContent, /2000 万像素/);
  const app = browser({ deferImages: true });
  const old = app.choose(photo(1200, 800)); await settle();
  const latest = app.choose(photo(1600, 1200)); await settle();
  app.pendingImages[1](); await latest;
  app.pendingImages[0](); await old;
  assert.match(app.node("file-info").textContent, /1600 × 1200/);
  assert.equal(app.node("recognize").disabled, false);
}

async function testJsonImportRace() {
  const app = browser(); let resolveOld;
  const oldFile = { size: 1, text: () => new Promise(resolve => { resolveOld = resolve; }) };
  app.node("json").files = [oldFile]; const old = app.node("json").handlers.change();
  const map = mapFixture();
  app.node("json").files = [{ size: 10, text: async () => JSON.stringify(map) }];
  await app.node("json").handlers.change();
  resolveOld("not valid JSON"); await old;
  assert.equal(app.calls.filter(call => call[0] === "importMap").length, 1, "Stale JSON reads must not replace the latest import");
  assert.equal(app.calls.find(call => call[0] === "importMap")[1].document_id, map.document_id);
  assert(!app.node("status").classes.has("error"), "Stale parse errors must not overwrite current status");
}

async function testLiveGestureStatusWithoutOcrAndStartupErrors() {
  const app = browser();
  assert.equal(app.node("hand-status").textContent, "手势识别未开启");
  app.reader.emit({ gesturesEnabled: true, gestureModelReady: true, gestureHands: 2, gestureFPS: 15.125 });
  assert.equal(app.node("hand-status").textContent, "检测到 2 只手 · 15.1 帧/秒");
  assert.match(app.node("gesture-status").textContent, /手骨架/);
  assert.equal(app.node("gestures").checked, true);
  assert.equal(app.node("play").disabled, true, "Live hand status must not require an OCR map");
  app.reader.emit({ gestureError: "<img src=x onerror=bad()>", gestureStatus: "", gesturesEnabled: false, gestureModelReady: false });
  assert.match(app.node("gesture-status").textContent, /<img src=x onerror=bad\(\)>/);
  assert.equal(app.node("gesture-status").attributes.role, "alert");
  assert(app.node("gesture-status").classes.has("error"));
  app.reader.emit({ gestureError: "", gestureStatus: "手势已关闭。" });
  assert.equal(app.node("gesture-status").attributes.role, "status");
  assert(!app.node("gesture-status").classes.has("error"));

  let rejectStart;
  app.reader.setGesturesEnabled = () => new Promise((resolve, reject) => {
    rejectStart = reject;
    app.reader.emit({ gestureStatus: "正在开启相机…" });
  });
  app.node("gestures").checked = true;
  const pending = app.node("gestures").handlers.change();
  await settle();
  assert.equal(app.node("gestures").disabled, true, "Do not start a second model while startup is pending");
  assert.equal(app.node("gestures").checked, true, "Keep the requested on state while the model is loading");
  rejectStart(new Error("请允许相机权限"));
  await pending;
  assert.equal(app.node("gestures").disabled, false);
  assert.equal(app.node("gestures").checked, false);
  assert.equal(app.node("gesture-status").textContent, "请允许相机权限");
  assert.equal(app.node("gesture-status").attributes.role, "alert");

  let resolveStart;
  app.reader.setGesturesEnabled = () => new Promise(resolve => {
    resolveStart = () => {
      app.reader.emit({ gesturesEnabled: true, gestureModelReady: true });
      resolve();
    };
    app.reader.emit({ gesturesEnabled: false, gestureStatus: "正在加载手势识别…" });
  });
  app.node("gestures").checked = true;
  const successful = app.node("gestures").handlers.change();
  await settle();
  assert.equal(app.node("gestures").checked, true);
  assert.equal(app.node("gestures").disabled, true);
  resolveStart();
  await successful;
  assert.equal(app.node("gestures").checked, true, "Successful startup must reflect the enabled controller state");
  assert.equal(app.node("gestures").disabled, false);
}

function testPreservedCaptureDomAndScripts() {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const capture = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
  const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(htmlIds).size, htmlIds.length, "DOM IDs must be unique");
  for (const match of capture.matchAll(/\$\('([^']+)'\)/g)) assert(htmlIds.includes(match[1]), `A requires #${match[1]}`);
  assert(htmlIds.includes("gesture-overlay"));
  const captureSection = html.slice(html.indexOf('id="capture-panel"'), html.indexOf('id="reader-panel"'));
  assert(captureSection.includes('id="reader-gestures"'), "The live gesture toggle must be beside the shared camera");
  assert(captureSection.includes('id="reader-hand-status"'));
  assert(captureSection.includes('id="reader-gesture-status"'));
  assert.match(captureSection, /href="blind-book-ocr-json-test\.html"[^>]*>打开 C 模块手势工作台<\/a>/);
  assert.match(captureSection, /未识别书页时也显示手骨架/);
  for (const asset of ["styles.css", "app.js", "live-bridge.js", "gesture-engine.js", "reader-controller.js", "e-app.js"]) {
    assert(html.includes(`${asset}?v=20261122`), `Invalidate the old cached ${asset}`);
  }
  assert(html.indexOf("FEELYREADER_NO_AUTO_TTS") < html.indexOf('src="reading_manager.js'));
  const scripts = ["app.js?", "reading_manager.js?", "gesture-engine.js?", "browser-ocr.js?", "reader-controller.js?", "e-app.js?"];
  for (let i = 1; i < scripts.length; i += 1) assert(html.indexOf(scripts[i - 1]) < html.indexOf(scripts[i]), "Module script order must preserve dependencies");
}

(async () => {
  await testPhotoManualTriggerAndSettings();
  await testMapSpeechAndSafeSavedText();
  await testInputLimitsAndDecodeRace();
  await testJsonImportRace();
  await testLiveGestureStatusWithoutOcrAndStartupErrors();
  testPreservedCaptureDomAndScripts();
  console.log("PASS: E photo/config flow, live gesture entry/status/errors without OCR, busy guards, map clicks, reading controls, safe saved text, input limits/races, A DOM and script order");
})().catch(error => { console.error(error); process.exitCode = 1; });
