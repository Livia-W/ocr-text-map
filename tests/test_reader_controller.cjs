/* Run: node tests/test_reader_controller.cjs. Exercises the actual controller
 * with injected A/B/C/D boundaries and a deterministic clock; no camera/network.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "../reader-controller.js"), "utf8");
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const settle = async () => { for (let i = 0; i < 15; i += 1) await Promise.resolve(); await new Promise(setImmediate); };

class EventHub {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  dispatch(name, detail) { for (const callback of this.listeners.get(name) || []) callback({ type: name, detail }); }
}

class Clock {
  constructor() { this.time = 1000; this.number = 0; this.tasks = new Map(); }
  setTimeout(callback, delay) { const id = ++this.number; this.tasks.set(id, { callback, at: this.time + delay }); return id; }
  setInterval(callback, delay) { const id = this.setTimeout(callback, delay); this.tasks.get(id).interval = delay; return id; }
  clear(id) { this.tasks.delete(id); }
  async advance(milliseconds) {
    const end = this.time + milliseconds;
    while (true) {
      const next = [...this.tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, task] = next;
      this.time = task.at;
      if (task.interval) task.at += task.interval;
      else this.tasks.delete(id);
      task.callback();
      await settle();
    }
    this.time = end;
    await settle();
  }
}

function map(text = "中文测试", width = 200, height = 100) {
  return {
    schema_version: "2.0", document_id: `doc-${text}`, source_size: [width, height],
    rectified_size: [100, 50], text,
    coordinates: { unit: "pixel", source_orientation: "EXIF-transposed", rectified_space: "region-local" },
    regions: [{ id: "page-1", label: "整页", kind: "page", rectified_size: [100, 50], transform: {} }],
    lines: [{ id: "line-1", region_id: "page-1", block_id: "block-1", reading_order: 1, text, confidence: .95,
      bbox_source: [10, 20, 120, 20], polygon_source: [[10, 20], [130, 20], [130, 40], [10, 40]],
      bbox_rectified: [5, 10, 60, 10], polygon_rectified: [[5, 10], [65, 10], [65, 20], [5, 20]] }],
    blocks: [{ id: "block-1", region_id: "page-1", line_ids: ["line-1"], type: "text" }], warnings: []
  };
}

function photo(kind = "jpeg", text = "中文测试") {
  const bytes = {
    jpeg: [255, 216, 255, 224, 0, 0, 0, 0, 0, 0, 0, 0],
    png: [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0],
    webp: [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]
  };
  const blob = new Blob([new Uint8Array(bytes[kind])], { type: "application/octet-stream" });
  Object.assign(blob, { name: `photo.${kind}`, ocrText: text });
  return blob;
}

class ReadingStub {
  constructor() { this.calls = []; this.lines = []; this.listeners = new Set(); this.state = { status: "idle", currentIndex: 0, speed: 1 }; }
  onStateChange(callback) { this.listeners.add(callback); callback(this.getState()); return () => this.listeners.delete(callback); }
  emit() { for (const callback of this.listeners) callback(this.getState()); }
  getState() { return { ...this.state, totalLines: this.lines.length, currentLine: this.lines[this.state.currentIndex] || null }; }
  loadOcrMap(value) { this.calls.push(["load", value]); this.lines = value.lines; this.state.status = "idle"; this.state.currentIndex = 0; this.emit(); }
  stopSpeech() { this.calls.push(["stop"]); }
  pause(silent) { this.calls.push(["pause", silent]); this.state.status = "paused"; this.emit(); }
  resume() { this.calls.push(["resume"]); this.state.status = "playing"; this.emit(); }
  play(index = 0) { this.calls.push(["play", index]); this.state.status = "playing"; this.state.currentIndex = index; this.emit(); }
  prevLine() { this.calls.push(["prev"]); }
  nextLine() { this.calls.push(["next"]); }
  setSpeed(rate) { this.calls.push(["speed", rate]); }
  saveHighlight() { this.calls.push(["save"]); }
  onTapWord(...args) { this.calls.push(["tap", ...args]); }
  onSlideWords(...args) { this.calls.push(["slide", ...args]); }
  onSelectRegion(...args) { this.calls.push(["selection", ...args]); }
  getHighlights() { return []; }
  getHistory() { return []; }
}

function harness(t, { immediate = false, fetch: fetchOverride } = {}) {
  const clock = new Clock(), events = new EventHub(), docEvents = new EventHub();
  const reading = new ReadingStub();
  const video = {
    srcObject: {}, hidden: false, videoWidth: 640, videoHeight: 480,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 500, height: 500 })
  };
  let onTracking, onFrame;
  const handSignals = [], gestures = [], jobs = [], urls = new Map();
  const bookReader = {
    getVideoElement: () => video,
    subscribePageTracking(callback) { onTracking = callback; return () => { onTracking = null; }; },
    subscribeVideoFrames(callback) { onFrame = callback; return () => { onFrame = null; }; },
    setHandOccluded(value) { handSignals.push(value); }
  };
  class GestureStub {
    constructor(givenVideo, options) { assert.equal(givenVideo, video); this.options = options; this.maps = []; this.clears = 0; gestures.push(this); }
    async init() {}
    setTextMap(value) { this.maps.push(value); }
    clearTextMap() { this.clears += 1; }
    destroy() { this.destroyed = true; }
  }
  let urlCounter = 0;
  class LocalURL extends URL {
    static createObjectURL(blob) { const url = `blob:test-${++urlCounter}`; urls.set(url, blob); return url; }
    static revokeObjectURL(url) { urls.delete(url); }
  }
  let inFlight = 0, maxInFlight = 0;
  const ocr = {
    recognize(blob, config, options) {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve, reject) => {
        const job = { blob, config, options, done: false,
          resolve(value = map(blob.ocrText)) { assert(!this.done); this.done = true; inFlight -= 1; resolve(value); },
          reject(error) { assert(!this.done); this.done = true; inFlight -= 1; reject(error); } };
        jobs.push(job);
        if (immediate) job.resolve();
      });
    },
    destroy() {}
  };
  const context = {
    window: null, Blob, URL: LocalURL, AbortController, DOMException, console,
    location: { href: "https://feelyreader.com/", origin: "https://feelyreader.com" },
    performance: { now: () => clock.time },
    document: { baseURI: "https://feelyreader.com/", hidden: false,
      addEventListener: docEvents.addEventListener.bind(docEvents), removeEventListener: docEvents.removeEventListener.bind(docEvents),
      getElementById: () => ({}) },
    GestureEngine: GestureStub, Hands: function Hands() {},
    setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clear.bind(clock),
    setInterval: clock.setInterval.bind(clock), clearInterval: clock.clear.bind(clock)
  };
  context.window = context;
  vm.runInNewContext(source, context);
  const controller = new context.FeelyReaderController({ bookReader, eventTarget: events, ocr,
    readingManager: reading, fetch: fetchOverride || (async () => { throw new Error("Unexpected network call"); }), now: () => clock.time });
  t.after(() => controller.destroy());
  return {
    controller, Controller: context.FeelyReaderController, clock, reading, video, jobs, gestures, handSignals, urls,
    get maxInFlight() { return maxInFlight; },
    capture(count, ids = [7], texts = [], { automatic = false } = {}) {
      const pages = ids.map((pageId, index) => ({ pageId, label: `书页 ${index + 1}`, width: 200, height: 100, blob: photo("jpeg", texts[index] || `内容-${count}-${index}`) }));
      events.dispatch("bookreader:captured", { blob: photo(), width: 640, height: 480, automatic, pages, metadata: { captureCount: count } });
      return pages;
    },
    tracking(record) { onTracking?.({ timestamp: clock.time, pages: Array.isArray(record) ? record : [record] }); },
    frame(state) { onFrame?.({ type: "state", state }); }
  };
}

function tracking(h, overrides = {}) {
  return { pageId: 7, valid: true, timestamp: h.clock.time, referenceCaptureCount: 1,
    referenceSize: { width: 200, height: 100 }, videoSize: { width: 640, height: 480 },
    referenceToCurrentVideo: identity.slice(), currentVideoToReference: identity.slice(), ...overrides };
}

test("A recapture keeps one OCR in flight and discards an older capture of the same pageId", async t => {
  const h = harness(t);
  h.capture(1, [7], ["旧页"]);
  assert.equal(h.jobs.length, 1);
  h.capture(2, [7], ["新页"]);
  assert.equal(h.jobs[0].options.signal.aborted, true);
  assert.equal(h.jobs.length, 1, "New capture waits until the aborted worker settles");
  h.jobs[0].options.onProgress(.9);
  assert.equal(h.controller.getState().progress, 0, "Old progress cannot modify the new capture");
  h.jobs[0].resolve(map("旧页")); await settle();
  assert.equal(h.jobs.length, 2);
  assert.equal(h.controller.getState().pages.length, 0, "An obsolete successful result is ignored");
  h.jobs[1].resolve(map("新页")); await settle();
  assert.equal(h.maxInFlight, 1);
  assert.equal(h.controller.getState().pages.length, 1);
  assert.equal(h.controller.getState().activeMap.text, "新页");
  assert.match(h.controller.getState().activePageKey, /capture:2:page:7/);
  assert(!h.reading.calls.some(call => call[0] === "load" && call[1].text === "旧页"));
});

test("A two-page capture is recognized serially and a selected page loads its own D map", async t => {
  const h = harness(t);
  const captured = h.capture(3, [11, 12], ["左页", "右页"]);
  assert.equal(h.jobs.length, 1); assert.equal(h.jobs[0].blob, captured[0].blob);
  h.jobs[0].resolve(); await settle();
  assert.equal(h.jobs.length, 2); assert.equal(h.jobs[1].blob, captured[1].blob);
  assert.equal(h.controller.getState().pages.length, 1);
  h.jobs[1].resolve(); await settle();
  const state = h.controller.getState();
  assert.equal(state.status, "ready"); assert.equal(state.pages.length, 2); assert.equal(h.maxInFlight, 1);
  h.controller.selectPage(state.pages[1].key);
  assert.equal(h.controller.getState().activeMap.text, "右页");
  assert.equal(h.reading.lines[0].text, "右页");
});

test("tracking requires the exact capture, dimensions and age strictly under 400 ms", async t => {
  const h = harness(t, { immediate: true }); h.capture(1); await settle();
  h.tracking(tracking(h)); assert.equal(h.controller.getState().trackingReady, true);
  for (const record of [
    tracking(h, { referenceCaptureCount: 2 }), tracking(h, { timestamp: h.clock.time - 400 }),
    tracking(h, { timestamp: h.clock.time + 51 }), tracking(h, { valid: false }),
    tracking(h, { referenceSize: { width: 201, height: 100 } }),
    tracking(h, { videoSize: { width: 480, height: 640 } }),
    tracking(h, { currentVideoToReference: [0, 0, 0, 0, 0, 0, 0, 0, 0] })
  ]) { h.tracking(record); assert.equal(h.controller.getState().trackingReady, false); }
  h.tracking(tracking(h, { timestamp: h.clock.time - 399 }));
  assert.equal(h.controller.getState().trackingReady, true);
  await h.clock.advance(1); assert.equal(h.controller.getState().trackingReady, false);
  h.tracking(tracking(h)); h.frame("background");
  assert.equal(h.controller.getState().trackingReady, false);
  assert.equal(h.reading.calls.at(-1)[0], "pause");
});

test("90-degree homography composes with contain letterboxing and round-trips client coordinates", async t => {
  const h = harness(t, { immediate: true }); h.capture(1); await settle();
  h.tracking(tracking(h, { referenceToCurrentVideo: [0, -1, 300, 1, 0, 50, 0, 0, 1],
    currentVideoToReference: [0, 1, -50, -1, 0, 300, 0, 0, 1] }));
  const mapper = h.controller.coordinateMapper();
  const screen = mapper.mapToScreen(20, 30);
  assert(Math.abs(screen.x - 220.9375) < 1e-8);
  assert(Math.abs(screen.y - 137.1875) < 1e-8, "Contain adds a 62.5 px vertical letterbox");
  const point = mapper.screenToMap(screen.x, screen.y);
  assert(Math.abs(point.x - 20) < 1e-8); assert(Math.abs(point.y - 30) < 1e-8);
  h.video.hidden = true;
  assert.equal(mapper.mapToScreen(20, 30), null, "Hidden video cannot provide a screen mapping");
});

test("Python 503 backoff waits 1s then 2s and submits the original blob with detected MIME", async t => {
  const requests = [];
  const h = harness(t, { fetch: async (url, options) => {
    requests.push({ url, options });
    return requests.length < 3 ? { ok: false, status: 503, json: async () => ({ error: "busy" }) }
      : { ok: true, status: 200, json: async () => map() };
  } });
  h.controller.setConfig({ engine: "python", endpoint: "https://ocr.example/api/ocr?keep=yes" });
  const file = photo("png"); const pending = h.controller.selectPhoto(file); await settle();
  assert.equal(requests.length, 1);
  await h.clock.advance(999); assert.equal(requests.length, 1);
  await h.clock.advance(1); assert.equal(requests.length, 2);
  await h.clock.advance(1999); assert.equal(requests.length, 2);
  await h.clock.advance(1); await pending; assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.options.body, file); assert.equal(request.options.headers["Content-Type"], "image/png");
    const url = new URL(request.url); assert.equal(url.searchParams.get("keep"), "yes");
    assert.equal(url.searchParams.get("max_side"), "1920"); assert.equal(url.searchParams.get("split"), "none");
  }
  assert.equal(h.controller.getState().status, "ready");
});

test("Python JPEG/WebP MIME is sniffed and cancel interrupts a 503 retry wait", async t => {
  for (const [kind, expected] of [["jpeg", "image/jpeg"], ["webp", "image/webp"]]) {
    const requests = [];
    const h = harness(t, { fetch: async (url, options) => { requests.push(options); return { ok: true, status: 200, json: async () => map() }; } });
    h.controller.setConfig({ engine: "python" });
    const file = photo(kind); await h.controller.selectPhoto(file);
    assert.equal(requests[0].body, file); assert.equal(requests[0].headers["Content-Type"], expected);
  }
  let attempts = 0;
  const h = harness(t, { fetch: async () => { attempts += 1; return { ok: false, status: 503, json: async () => ({ error: "busy" }) }; } });
  h.controller.setConfig({ engine: "python" });
  const pending = h.controller.selectPhoto(photo()); await settle(); h.controller.cancel(); await pending;
  await h.clock.advance(5000); assert.equal(attempts, 1); assert.equal(h.controller.getState().activeMap, null);
});

test("static photos and imported maps cannot acquire paper tracking from camera messages", async t => {
  const h = harness(t, { immediate: true }); await h.controller.selectPhoto(photo());
  h.tracking(tracking(h)); assert.equal(h.controller.getState().trackingReady, false);
  await h.controller.setGesturesEnabled(true);
  assert.equal(h.gestures[0].maps.length, 0);
  h.gestures[0].options.onWordFocus({ word: "假命中", lineId: "line-1" });
  await h.clock.advance(110);
  assert(!h.reading.calls.some(call => call[0] === "tap" || call[0] === "slide"));
  h.controller.importMap(map()); h.tracking(tracking(h));
  assert.equal(h.controller.getState().trackingReady, false);
});

test("C focus bursts aggregate once, ignore duplicate voice annotations and respect manual pause", async t => {
  const h = harness(t, { immediate: true }); h.capture(1); await settle(); h.tracking(tracking(h));
  await h.controller.setGesturesEnabled(true);
  const gesture = h.gestures[0];
  assert.equal(gesture.options.requestCamera, false); assert.equal(gesture.options.mirrored, false); assert.equal(gesture.options.objectFit, "contain");
  assert.equal(gesture.maps[0].lines[0].bbox_rectified[0], 10, "C receives source geometry rather than B's local rectified coordinates");
  gesture.options.onWordFocus({ word: "你好", lineId: "line-1" });
  gesture.options.onWordFocus({ word: "你好", lineId: "line-1" });
  gesture.options.onWordFocus({ word: "世界", lineId: "line-1" });
  gesture.options.onVoiceAnnotation({ event: "word_focus", text: "你好世界" });
  await h.clock.advance(109);
  assert(!h.reading.calls.some(call => call[0] === "tap" || call[0] === "slide"));
  await h.clock.advance(1);
  const speech = h.reading.calls.filter(call => call[0] === "tap" || call[0] === "slide");
  assert.equal(speech.length, 1); assert.equal(speech[0][0], "slide"); assert.equal(speech[0][1], "你好世界");
  h.controller.pause();
  gesture.options.onWordFocus({ word: "不能自动恢复", lineId: "line-1" });
  await h.clock.advance(110);
  assert.equal(h.reading.calls.filter(call => call[0] === "tap" || call[0] === "slide").length, 1);
  assert.equal(h.reading.getState().status, "paused");
  h.controller.play(); h.tracking(tracking(h));
  gesture.options.onWordFocus({ word: "恢复", lineId: "line-1" });
  await h.clock.advance(110);
  assert.equal(h.reading.calls.filter(call => call[0] === "tap").at(-1)[1], "恢复");
});

test("tracking invalidation drops buffered C speech before its aggregation timer fires", async t => {
  const h = harness(t, { immediate: true }); h.capture(1); await settle(); h.tracking(tracking(h));
  await h.controller.setGesturesEnabled(true); const gesture = h.gestures[0];
  gesture.options.onWordFocus({ word: "旧定位", lineId: "line-1" });
  h.tracking(tracking(h, { valid: false })); await h.clock.advance(110);
  assert(!h.reading.calls.some(call => call[0] === "tap" || call[0] === "slide"));
  assert(gesture.clears > 0);
});

test("schema 2 import rejects local-only or non-finite source geometry and retains source polygons", t => {
  const h = harness(t); const valid = map();
  h.controller.importMap(valid);
  assert.equal(h.controller.getState().activeMap.lines[0].polygon_source[1][0], 130);
  const localOnly = map(); delete localOnly.lines[0].bbox_source; delete localOnly.lines[0].polygon_source;
  assert.throws(() => h.controller.importMap(localOnly), /原图|坐标/);
  const nan = map(); nan.lines[0].polygon_source[0][0] = NaN;
  assert.throws(() => h.controller.importMap(nan), /坐标/);
  const negativeWidth = map(); negativeWidth.lines[0].bbox_source[2] = -10;
  assert.throws(() => h.controller.importMap(negativeWidth), /坐标/);
  const huge = map(); huge.source_size = [5000, 4001];
  assert.throws(() => h.controller.importMap(huge), /尺寸/);
  assert.equal(h.controller.getState().activeMap.document_id, valid.document_id, "Invalid imports must not erase a valid map");
});

test("a mismatched reference image size never becomes a usable OCR/tracking page", async t => {
  const h = harness(t); h.capture(1);
  h.jobs[0].resolve(map("错误尺寸", 300, 100)); await settle();
  assert.equal(h.controller.getState().status, "error"); assert.equal(h.controller.getState().pages.length, 0);
  assert.match(h.controller.getState().message, /尺寸不一致/);
});

test("automatic A captures cannot replace a selected photo or imported document", async t => {
  const h = harness(t, { immediate: true }); await h.controller.selectPhoto(photo("jpeg", "所选照片"));
  const key = h.controller.getState().activePageKey;
  h.capture(2, [7], ["自动误覆盖"], { automatic: true }); await settle();
  assert.equal(h.jobs.length, 1); assert.equal(h.controller.getState().activePageKey, key);
  h.controller.importMap(map("导入内容"));
  h.capture(3, [7], ["自动误覆盖"], { automatic: true }); await settle();
  assert.equal(h.jobs.length, 1); assert.equal(h.controller.getState().activeMap.text, "导入内容");
  h.capture(4, [7], ["明确手动采集"]); await settle();
  assert.equal(h.jobs.length, 2); assert.equal(h.controller.getState().activeMap.text, "明确手动采集");
});

test("a later successful page retains the earlier page failure message", async t => {
  const h = harness(t); h.capture(1, [7, 8]);
  h.jobs[0].reject(new Error("左页失败")); await settle();
  assert.equal(h.jobs.length, 2);
  h.jobs[1].resolve(map("右页可读")); await settle();
  assert.equal(h.controller.getState().pages.length, 1);
  assert.equal(h.controller.getState().activeMap.text, "右页可读");
  assert.match(h.controller.getState().message, /部分|失败/);
  assert.match(h.controller.getState().message, /左页失败/);
});

test("schema 2 must not infer source dimensions from a smaller rectified image", t => {
  const h = harness(t); const value = map(); delete value.source_size;
  assert.throws(() => h.controller.importMap(value), /source|原图|尺寸/);
});

test("cancel keeps the finished map while stopping playback and blocking fresh C focus", async t => {
  const h = harness(t, { immediate: true }); h.capture(1); await settle(); h.tracking(tracking(h));
  await h.controller.setGesturesEnabled(true); h.controller.play();
  assert.equal(h.reading.getState().status, "playing");
  const documentId = h.controller.getState().activeMap.document_id;
  h.controller.cancel();
  assert.equal(h.controller.getState().activeMap.document_id, documentId);
  assert.notEqual(h.reading.getState().status, "playing", "Cancelled speech must not remain visibly playing");
  h.gestures[0].options.onWordFocus({ word: "不应重启", lineId: "line-1" });
  await h.clock.advance(110);
  assert(!h.reading.calls.some(call => call[0] === "tap" || call[0] === "slide"));
});
