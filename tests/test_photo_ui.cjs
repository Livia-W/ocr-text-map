/* Run: node tests/test_photo_ui.cjs. No browser or npm packages required.
 * Simulates decoding and network timing; real EXIF rendering needs a browser.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

class DrawingContext {
  constructor() { this.reset(); }
  reset() { this.path = []; this.paths = []; this.draws = []; this.rotations = []; }
  save() {}
  restore() {}
  translate() {}
  rotate(angle) { this.rotations.push(angle); }
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
    this.id = id;
    this.handlers = {};
    this.hidden = true;
    this.disabled = false;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.value = "";
    this.context = new DrawingContext();
    this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    this.files = [];
  }
  set width(value) { this._width = value; this.context.reset(); }
  get width() { return this._width; }
  set height(value) { this._height = value; this.context.reset(); }
  get height() { return this._height; }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  querySelectorAll() { return this.children.filter(item => item.className === "line-item"); }
  getContext() { return this.context; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 200 }; }
  remove() {}
}

function photo({ kind = "jpeg", width = 3000, height = 2000, size } = {}) {
  const headers = {
    jpeg: [255, 216, 255, 224, 0, 0, 0, 0, 0, 0, 0, 0],
    png: [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0],
    webp: [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80],
    invalid: [1, 2, 3, 4]
  };
  const file = new Blob([new Uint8Array(headers[kind])], { type: "application/octet-stream" });
  Object.assign(file, { name: `test.${kind}`, width, height });
  if (size !== undefined) Object.defineProperty(file, "size", { value: size });
  return file;
}

function browser({ deferredImages = false } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const requests = [];
  const urls = new Map();
  const downloads = [];
  const pendingImages = [];
  const timers = new Map();
  let urlId = 0, timerId = 0;
  const document = {
    body: new Element("body"),
    getElementById: element,
    createElement(type) {
      const item = new Element(type);
      if (type === "a") item.click = () => downloads.push({ blob: urls.get(item.href), filename: item.download });
      return item;
    }
  };
  const imageSizes = {
    "data:image/jpeg;base64,left": [1000, 1500],
    "data:image/jpeg;base64,right": [900, 1500]
  };
  class FakeImage {
    set src(url) {
      const file = urls.get(url);
      const size = file ? [file.width, file.height] : imageSizes[url] || [1000, 1500];
      this.naturalWidth = size[0];
      this.naturalHeight = size[1];
      const decoded = () => this.onload();
      if (deferredImages && file) pendingImages.push(decoded);
      else queueMicrotask(decoded);
    }
  }
  const context = {
    document,
    window: { addEventListener() {} },
    URL: {
      createObjectURL(blob) { const url = `blob:test-${++urlId}`; urls.set(url, blob); return url; },
      revokeObjectURL(url) { urls.delete(url); }
    },
    URLSearchParams, Blob, AbortController, Image: FakeImage,
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    async fetch(url, options) {
      if (url === "/api/health") return { ok: true, json: async () => ({ ready: true }) };
      return new Promise(resolve => requests.push({ url, options, resolve }));
    }
  };
  element("split").value = "none";
  element("mode").value = "auto";
  element("max-side").value = "1920";
  element("confidence").value = "0.45";
  element("split-position").value = "50";
  element("result-view").value = "source";
  const source = fs.readFileSync(path.join(__dirname, "../mobile_ocr/static/app.js"), "utf8");
  vm.runInNewContext(source, context);
  return {
    element, requests, timers, downloads, pendingImages,
    choose(file) { element("file").files = [file]; return element("file").handlers.change(); },
    change(id, value) { element(id).value = value; return element(id).handlers[id === "split-position" ? "input" : "change"](); },
    click(id) { return element(id).handlers.click(); }
  };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise(setImmediate);
}

function line(id, region, order, x, text) {
  return {
    id, region_id: region, block_id: `${region}-block-1`, reading_order: order, text, confidence: 0.92,
    polygon_source: [[x, 10], [x + 80, 10], [x + 80, 40], [x, 40]],
    polygon_rectified: [[20, 20], [100, 20], [100, 50], [20, 50]],
    bbox_source: [x, 10, 80, 30], bbox_rectified: [20, 20, 80, 30]
  };
}

function payload() {
  const lines = [line("left-line-1", "left", 0, 10, "左页文字"), line("right-line-1", "right", 1, 2100, "<img src=x onerror=alert(1)>右页文字")];
  return {
    schema_version: 2, source_size: [3000, 2000], lines,
    text: lines.map(item => item.text).join("\n"),
    blocks: [{ id: "left-block-1", region_id: "left", type: "text" }, { id: "right-block-1", region_id: "right", type: "text" }],
    regions: [
      { id: "left", label: "左页", kind: "page", rectified_size: [1000, 1500], rectified_image: "data:image/jpeg;base64,left", transform: {}, calibration: {}, line_ids: [lines[0].id] },
      { id: "right", label: "右页", kind: "page", rectified_size: [900, 1500], rectified_image: "data:image/jpeg;base64,right", transform: {}, calibration: {}, line_ids: [lines[1].id] }
    ], warnings: [], timing_ms: { total: 50 }
  };
}

function response(value = payload()) { return { ok: true, json: async () => value }; }

async function testOriginalUploadAndCalibration() {
  const app = browser();
  const file = photo();
  assert.equal(app.element("recognize").disabled, true);
  await app.choose(file);
  assert.equal(app.requests.length, 0, "Selecting a photo must not start recognition");
  assert.equal(app.element("recognize").disabled, false);
  assert.equal(app.element("preview").width, 3000);
  assert.equal(app.element("preview").height, 2000);
  app.click("rotate-right");
  assert.equal(app.element("rotation-value").textContent, "90°");
  assert.equal(app.element("preview").width, 2000);
  assert.equal(app.element("preview").height, 3000);
  app.change("split", "pages");
  assert.equal(app.element("split-control").hidden, false);
  assert.deepEqual(app.element("preview").context.paths.at(-1), [[1000, 0], [1000, 3000]]);
  app.change("split-position", "35");
  assert.deepEqual(app.element("preview").context.paths.at(-1), [[700, 0], [700, 3000]], "Split line uses the rotated preview's width");
  const pending = app.click("recognize");
  app.click("recognize");
  assert.equal(app.requests.length, 1, "Repeated recognition must keep one request in flight");
  const request = app.requests[0];
  assert.equal(request.options.body, file, "Original file must be sent without re-encoding or resizing");
  assert.equal(request.options.headers["Content-Type"], "image/jpeg", "Signature determines MIME, not a misleading file.type");
  const params = new URL(request.url, "http://localhost").searchParams;
  assert.equal(params.get("rotation"), "90");
  assert.equal(params.get("split"), "pages");
  assert.equal(params.get("split_position"), "0.35");
  assert.equal(params.get("max_side"), "1920");
  app.click("rotate-left");
  assert.equal(request.options.signal.aborted, true, "Changing input must abort the request");
  request.resolve(response());
  await pending;
  assert.equal(app.element("map").hidden, true, "An obsolete successful response must not show a map");
  assert.equal(app.element("export-json").disabled, true);
  assert.equal(app.element("recognize").disabled, false);
  assert.equal(app.timers.size, 0, "Photo recognition must not schedule sampling or retries");
  app.click("rotate-left");
  assert.equal(app.element("rotation-value").textContent, "270°", "Counterclockwise rotation is normalized for the API");
}

async function testRegionsCoordinatesAndExports() {
  const app = browser();
  await app.choose(photo());
  app.click("rotate-right");
  app.change("split", "pages");
  const pending = app.click("recognize");
  app.requests[0].resolve(response());
  await pending;
  assert.equal(app.element("map").width, 3000, "Source map must keep the photo's EXIF direction, independent of manual rotation");
  assert.equal(app.element("map").height, 2000);
  assert.equal(app.element("map").context.paths.length, 2);
  assert.deepEqual(app.element("map").context.paths[1], payload().lines[1].polygon_source);
  assert.equal(app.element("result-view").children.length, 3);
  app.change("result-view", "1");
  assert.equal(app.element("map").width, 900);
  assert.equal(app.element("map").height, 1500);
  assert.equal(app.element("map").context.paths.length, 1, "Corrected view must draw only that region's polygons");
  assert.deepEqual(app.element("map").context.paths[0], payload().lines[1].polygon_rectified);
  const rows = app.element("line-list").querySelectorAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].children[1].textContent, payload().lines[1].text, "OCR text is inserted as plain text");
  assert.match(app.element("line-list").children[0].textContent, /^右页 · 文字块/);
  assert.doesNotMatch(app.element("line-list").children[0].textContent, /right-block/);
  app.element("map").handlers.click({ clientX: 10, clientY: 4 });
  assert.equal(app.element("selected-text").textContent, payload().lines[1].text, "Click coordinates must account for displayed canvas size");
  assert.equal(app.element("selection").hidden, false);
  app.click("export-json");
  const exported = JSON.parse(await app.downloads[0].blob.text());
  assert.equal(exported.regions.length, 2);
  assert.deepEqual(exported.lines[1].polygon_source, payload().lines[1].polygon_source);
  app.click("export-txt");
  assert.equal((await app.downloads[1].blob.text()).replace(/^\uFEFF/, ""), payload().text);
  app.change("max-side", "2560");
  assert.equal(app.element("map").hidden, true, "Parameter changes clear outdated results");
  assert.equal(app.element("export-txt").disabled, true);
}

async function testValidationAndFormats() {
  for (const [kind, mime] of [["png", "image/png"], ["webp", "image/webp"]]) {
    const app = browser();
    const file = photo({ kind });
    await app.choose(file);
    const pending = app.click("recognize");
    assert.equal(app.requests[0].options.headers["Content-Type"], mime);
    assert.equal(app.requests[0].options.body, file);
    app.requests[0].resolve(response());
    await pending;
  }
  for (const [file, message] of [
    [photo({ size: 8 * 1024 * 1024 + 1 }), /8 MiB/],
    [photo({ width: 5000, height: 4001 }), /2000 万像素/],
    [photo({ kind: "invalid" }), /JPEG、PNG 和 WebP/]
  ]) {
    const app = browser();
    await app.choose(file);
    assert.equal(app.element("recognize").disabled, true);
    assert.equal(app.requests.length, 0);
    assert.match(app.element("status").textContent, message);
  }
}

async function testDecodeRaceAndSettingsDuringDecode() {
  const app = browser({ deferredImages: true });
  const old = app.choose(photo({ width: 1200, height: 800 }));
  await settle();
  const current = app.choose(photo({ width: 2400, height: 1600 }));
  await settle();
  app.change("split", "columns");
  app.pendingImages[1]();
  await current;
  assert.equal(app.element("recognize").disabled, false, "Changing settings during decode must not leave the UI locked");
  app.pendingImages[0]();
  await old;
  assert.equal(app.element("preview").width, 2400, "Old image decodes must not replace the latest selection");
  assert.equal(app.element("preview").height, 1600);
  const pending = app.click("recognize");
  assert.equal(new URL(app.requests[0].url, "http://localhost").searchParams.get("split"), "columns");
  app.requests[0].resolve(response());
  await pending;
}

(async () => {
  await testOriginalUploadAndCalibration();
  await testRegionsCoordinatesAndExports();
  await testValidationAndFormats();
  await testDecodeRaceAndSettingsDuringDecode();
  console.log("PASS: original upload, manual recognition, rotation/split preview, single request, stale results, region polygons, coordinate clicks, exports, limits, image races");
})().catch(error => { console.error(error); process.exitCode = 1; });
