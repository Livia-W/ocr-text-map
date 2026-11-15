"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../browser-ocr.js"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

function data(text = "中文 OCR", confidence = 96, bbox = { x0: 30, y0: 30, x1: 180, y1: 55 }) {
  return { text, blocks: [{ paragraphs: [{ lines: [{ text, confidence, bbox }] }] }] };
}

function browser({ width = 1600, height = 800, factory, recognize, nativeWorker = false } = {}) {
  const urls = new Map(), canvases = [], creations = [], workers = [], calls = [], rawWorkers = [];
  let urlIndex = 0, documentIndex = 0;
  class BrowserURL extends URL {
    static createObjectURL(blob) { const url = `blob:test-${++urlIndex}`; urls.set(url, blob); return url; }
    static revokeObjectURL(url) { urls.delete(url); }
  }
  class Image {
    set src(url) {
      this.url = url;
      if (!url) return;
      this.naturalWidth = width;
      this.naturalHeight = height;
      queueMicrotask(() => this.onload?.());
    }
    get src() { return this.url; }
  }
  class Canvas {
    constructor() {
      this.operations = [];
      this.context = Object.fromEntries(["scale", "translate", "transform", "drawImage"].map(method =>
        [method, (...args) => this.operations.push([method, ...args])]));
    }
    getContext() { return this.context; }
    toDataURL(type) { assert.equal(type, "image/jpeg"); return "data:image/jpeg;base64," + Buffer.from(`${this.width}x${this.height}`).toString("base64"); }
  }
  const context = {
    console, Blob, URL: BrowserURL, Image, AbortController,
    performance: { now: () => performance.now() },
    crypto: { randomUUID: () => `document-${++documentIndex}` },
    document: {
      baseURI: "https://feelyreader.com/app/index.html",
      createElement(tag) { assert.equal(tag, "canvas"); const canvas = new Canvas(); canvases.push(canvas); return canvas; }
    }
  };
  if (nativeWorker) {
    context.Worker = class Worker {
      constructor(url) { this.url = url; this.terminated = 0; this.listeners = {}; rawWorkers.push(this); }
      terminate() { this.terminated += 1; }
      addEventListener(type, callback) { this.listeners[type] = callback; }
    };
  }
  function worker() {
    const item = {
      terminated: 0, parameters: [],
      async setParameters(parameters) { item.parameters.push(parameters); },
      recognize(canvas, options, output) {
        const call = { size: [canvas.width, canvas.height], options, output, worker: item };
        calls.push(call);
        return recognize ? recognize(call, calls.length, item) : Promise.resolve({ data: data() });
      },
      terminate() { item.terminated += 1; return Promise.resolve(); }
    };
    workers.push(item);
    return item;
  }
  context.Tesseract = { createWorker(languages, mode, options) {
    creations.push({ languages, mode, options });
    return factory ? factory({ context, worker, options, number: creations.length }) : Promise.resolve(worker());
  } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    context, urls, canvases, creations, workers, calls, rawWorkers,
    adapter: new context.FeelyBrowserOCR(), utils: context.FeelyBrowserOCR.utils,
    photo() { return new Blob([Uint8Array.from([255, 216, 255, 224, 0, 0, 0, 0, 0, 0, 0, 0])], { type: "image/jpeg" }); }
  };
}

async function waitFor(predicate) {
  for (let i = 0; i < 40; i += 1) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  throw new Error("Expected asynchronous OCR stage was not reached.");
}

test("rotation matrices preserve pixel corners and inverse mappings for all four orientations", () => {
  const env = browser();
  const corners = [[0, 0], [95, 0], [95, 63], [0, 63]];
  const expected = {
    0: corners,
    90: [[63, 0], [63, 95], [0, 95], [0, 0]],
    180: [[95, 63], [0, 63], [0, 0], [95, 0]],
    270: [[0, 95], [0, 0], [63, 0], [63, 95]]
  };
  for (const angle of [0, 90, 180, 270]) {
    const matrix = env.utils.rotationMatrix(96, 64, angle);
    const inverse = env.utils.inverse(matrix);
    const transformed = corners.map(point => env.utils.project(matrix, point));
    assert.deepEqual(plain(transformed), expected[angle]);
    assert.deepEqual(plain(transformed.map(point => env.utils.project(inverse, point))), corners);
  }
});

test("region planning uses Python ties-to-even and partitions rotated width without gaps", () => {
  const env = browser();
  assert.deepEqual([-2.5, -1.5, 0.5, 1.5, 2.5].map(env.utils.roundToEven), [-2, -2, 0, 2, 2]);
  const plans = env.utils.planRegions(100, 65, { rotation: 90, split: "columns", split_position: 0.5 });
  assert.deepEqual(plain(plans.map(plan => [plan.id, plan.left, plan.width, plan.height])),
    [["column-1", 0, 32, 100], ["column-2", 32, 33, 100]]);
  assert.deepEqual(plain(env.utils.project(plans[1].regionToSource, [0, 0])), [0, 32]);
});

test("actual worker API is requested with Chinese/English, explicit blocks, and same-origin assets", async () => {
  const env = browser();
  const progress = [];
  const result = await env.adapter.recognize(env.photo(), { mode: "none", max_side: 800 }, { onProgress: value => progress.push(value) });
  assert.equal(env.creations.length, 1);
  const creation = env.creations[0];
  assert.equal(creation.languages, "chi_sim+eng");
  assert.equal(creation.mode, 1);
  assert.equal(creation.options.workerPath, "https://feelyreader.com/app/vendor/tesseract/worker.min.js");
  assert.equal(creation.options.corePath, "https://feelyreader.com/app/vendor/tesseract/core/");
  assert.equal(creation.options.langPath, "https://feelyreader.com/app/vendor/tesseract/lang/");
  assert.equal(creation.options.gzip, false);
  assert.equal(creation.options.workerBlobURL, false);
  assert.deepEqual(plain(env.calls[0].output), { text: true, blocks: true });
  assert.deepEqual(plain(env.calls[0].options), {});
  assert.equal(result.engine, "tesseract.js-6.0.1");
  assert.equal(result.schema_version, "2.0");
  assert.deepEqual(plain(result.rectified_size), [800, 400]);
  assert.deepEqual(plain(result.lines[0].bbox_source), [60, 60, 300, 50]);
  assert.equal(result.lines[0].confidence, 0.96);
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((value, index) => value >= 0 && value <= 1 && (!index || value >= progress[index - 1])));
  assert.equal(env.urls.size, 0);
  assert.ok(env.canvases.every(canvas => canvas.width === 1 && canvas.height === 1));
});

test("two rotated pages return globally unique lines/blocks and original EXIF-photo coordinates", async () => {
  const env = browser({ width: 800, height: 1600, recognize: (_call, index) => Promise.resolve({ data: data(index === 1 ? "左页" : "右页") }) });
  const result = await env.adapter.recognize(env.photo(), { rotation: 90, split: "pages", mode: "none", max_side: 800 });
  assert.deepEqual(plain(result.source_size), [800, 1600]);
  assert.deepEqual(plain(result.rotated_size), [1600, 800]);
  assert.deepEqual(plain(result.regions.map(region => region.id)), ["page-1", "page-2"]);
  assert.deepEqual(plain(result.lines.map(line => [line.id, line.block_id, line.region_id, line.reading_order])),
    [["line-1", "block-1", "page-1", 1], ["line-2", "block-2", "page-2", 2]]);
  assert.deepEqual(plain(result.lines[0].bbox_source), [30, 1419, 25, 150]);
  assert.deepEqual(plain(result.lines[1].bbox_source), [30, 619, 25, 150]);
  assert.equal(result.text, "左页\n右页");
  assert.equal(result.rectified_image, result.regions[0].rectified_image);
  assert.deepEqual(plain(result.regions[1].line_ids), ["line-2"]);
  for (const line of result.lines) {
    const transform = result.regions.find(region => region.id === line.region_id).transform.source_to_page_matrix;
    assert.deepEqual(plain(line.polygon_source.map(point => env.utils.project(transform, point))), plain(line.polygon_rectified));
  }
  assert.ok(env.canvases[0].operations.some(operation => operation[0] === "transform" && operation[1] === 0 && operation[4] === 0 && operation[5] === 1600));
});

test("paragraph/line order is retained and low-confidence or invalid boxes do not enter text maps", async () => {
  const output = { text: "第一行\n第二行\n过滤", blocks: [
    { paragraphs: [{ lines: [
      { text: "第一行", confidence: 92, bbox: { x0: 10, y0: 10, x1: 100, y1: 40 } },
      { text: "过滤", confidence: 20, bbox: { x0: 10, y0: 50, x1: 100, y1: 80 } }
    ] }] },
    { paragraphs: [{ lines: [
      { text: "第二行", confidence: 80, bbox: { x0: 10, y0: 100, x1: 100, y1: 130 } },
      { text: "损坏坐标", confidence: 99, bbox: { x0: NaN, y0: 0, x1: 20, y1: 30 } }
    ] }] }
  ] };
  const env = browser({ recognize: () => Promise.resolve({ data: output }) });
  const result = await env.adapter.recognize(env.photo(), { min_confidence: 0.8, mode: "auto" });
  assert.equal(result.text, "第一行\n第二行");
  assert.deepEqual(plain(result.blocks.map(block => block.line_ids)), [["line-1"], ["line-2"]]);
  assert.ok(result.warnings.some(warning => warning.includes("未执行透视或曲面校正")));
  assert.ok(result.regions.every(region => !region.transform.perspective_applied && !region.transform.curvature_applied && region.transform.curvature_mesh === null));
});

test("empty pages are valid results but plain text without line geometry is rejected", async () => {
  const empty = browser({ recognize: () => Promise.resolve({ data: { text: "", blocks: null } }) });
  const result = await empty.adapter.recognize(empty.photo());
  assert.equal(result.lines.length, 0);
  assert.equal(result.blocks.length, 0);
  assert.equal(result.text, "");
  assert.ok(result.warnings.some(warning => warning.includes("未检测到可靠文字")));
  const missingGeometry = browser({ recognize: () => Promise.resolve({ data: { text: "不能假造定位", blocks: null } }) });
  await assert.rejects(missingGeometry.adapter.recognize(missingGeometry.photo()), /未返回文字行坐标/);
});

test("valid sequential calls reuse one worker while generating distinct document ids", async () => {
  const env = browser();
  const first = await env.adapter.recognize(env.photo());
  const second = await env.adapter.recognize(env.photo());
  assert.equal(env.creations.length, 1);
  assert.equal(env.calls.length, 2);
  assert.notEqual(first.document_id, second.document_id);
});

test("aborting a recognition rejects immediately even if job and terminate promises never settle", { timeout: 1500 }, async () => {
  const env = browser({
    recognize: (_call, index, worker) => {
      if (index === 1) {
        worker.terminate = () => { worker.terminated += 1; return new Promise(() => {}); };
        return new Promise(() => {});
      }
      return Promise.resolve({ data: data("重试成功") });
    }
  });
  const controller = new AbortController();
  const pending = env.adapter.recognize(env.photo(), {}, { signal: controller.signal });
  await waitFor(() => env.calls.length === 1);
  await assert.rejects(env.adapter.recognize(env.photo()), error => error.name === "BusyError");
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
  assert.equal(env.workers[0].terminated, 1);
  const retry = await env.adapter.recognize(env.photo());
  assert.equal(retry.text, "重试成功");
  assert.equal(env.creations.length, 2);
});

test("aborting initialization stops its native worker and restores the Worker constructor", { timeout: 1500 }, async () => {
  const env = browser({ nativeWorker: true, factory: ({ context, options, number, worker }) => {
    if (number === 1) { new context.Worker(options.workerPath); return new Promise(() => {}); }
    return Promise.resolve(worker());
  } });
  const Original = env.context.Worker;
  const controller = new AbortController();
  const pending = env.adapter.recognize(env.photo(), {}, { signal: controller.signal });
  await waitFor(() => env.rawWorkers.length === 1);
  assert.equal(env.context.Worker, Original);
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
  assert.equal(env.rawWorkers[0].terminated, 1);
  assert.equal((await env.adapter.recognize(env.photo())).text, "中文 OCR");
});

test("swallowed v6 initialization errors use an independent rejection path and allow retry", { timeout: 1500 }, async () => {
  const env = browser({ nativeWorker: true, factory: ({ context, options, number, worker }) => {
    if (number === 1) {
      new context.Worker(options.workerPath);
      queueMicrotask(() => { assert.doesNotThrow(() => options.errorHandler("language initialization failed")); });
      return new Promise(() => {});
    }
    return Promise.resolve(worker());
  } });
  await assert.rejects(env.adapter.recognize(env.photo()), /language initialization failed/);
  assert.equal(env.rawWorkers[0].terminated, 1);
  assert.equal((await env.adapter.recognize(env.photo())).text, "中文 OCR");
});

test("invalid options, unsupported files, and oversized photos fail without creating a worker", async () => {
  const env = browser();
  for (const options of [{ rotation: 45 }, { rotation: true }, { split: "bad" }, { split_position: 0.09 },
    { split_position: NaN }, { mode: "bad" }, { max_side: 639 }, { max_side: 2561 }, { min_confidence: Infinity }]) {
    await assert.rejects(env.adapter.recognize(env.photo(), options));
  }
  await assert.rejects(env.adapter.recognize(new Blob(["invalid"])), /仅支持/);
  const oversized = env.photo();
  Object.defineProperty(oversized, "size", { value: 8 * 1024 * 1024 + 1 });
  await assert.rejects(env.adapter.recognize(oversized), /8 MiB/);
  assert.equal(env.creations.length, 0);
  assert.equal(env.urls.size, 0);
});

test("decoded display dimensions govern source coordinates and invalid decoded sizes are rejected", async () => {
  const env = browser({ width: 200, height: 100 });
  const result = await env.adapter.recognize(env.photo(), { rotation: 90, mode: "none" });
  assert.deepEqual(plain(result.source_size), [200, 100]);
  assert.deepEqual(plain(result.rotated_size), [100, 200]);
  const huge = browser({ width: 6000, height: 4000 });
  await assert.rejects(huge.adapter.recognize(huge.photo()), /2000 万像素/);
  assert.equal(huge.creations.length, 0);
  assert.equal(huge.urls.size, 0);
});

test("destroy aborts the current job and prevents later use", { timeout: 1500 }, async () => {
  const env = browser({ recognize: () => new Promise(() => {}) });
  const pending = env.adapter.recognize(env.photo());
  await waitFor(() => env.calls.length === 1);
  env.adapter.destroy();
  await assert.rejects(pending, error => error.name === "AbortError");
  await assert.rejects(env.adapter.recognize(env.photo()), /已关闭/);
  assert.equal(env.workers[0].terminated, 1);
});
