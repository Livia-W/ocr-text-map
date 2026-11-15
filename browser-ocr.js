/* Browser OCR adapter: the same document/region coordinate contract as module B. */
(function attachBrowserOCR(global) {
  "use strict";

  const MAX_BYTES = 8 * 1024 * 1024;
  const MAX_PIXELS = 20_000_000;
  const ENGINE = "tesseract.js-6.0.1";
  const identity = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const now = () => global.performance?.now?.() ?? Date.now();
  const rounded = number => Math.round(number * 1000) / 1000;

  function abortError() {
    const error = new Error("识别已取消。");
    error.name = "AbortError";
    return error;
  }

  // Python round() uses ties to even, unlike JavaScript's Math.round().
  function roundToEven(value) {
    const floor = Math.floor(value), fraction = value - floor;
    return fraction === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
  }

  function multiply(a, b) {
    return a.map((row, i) => row.map((_, j) => row.reduce((sum, value, k) => sum + value * b[k][j], 0)));
  }

  function inverse(matrix) {
    const [[a, b, c], [d, e, f], [g, h, i]] = matrix;
    const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error("照片坐标变换无效。");
    return [[e * i - f * h, c * h - b * i, b * f - c * e],
      [f * g - d * i, a * i - c * g, c * d - a * f],
      [d * h - e * g, b * g - a * h, a * e - b * d]]
      .map(row => row.map(value => value / determinant));
  }

  function project(matrix, point) {
    const [x, y] = point;
    const z = matrix[2][0] * x + matrix[2][1] * y + matrix[2][2];
    return [(matrix[0][0] * x + matrix[0][1] * y + matrix[0][2]) / z,
      (matrix[1][0] * x + matrix[1][1] * y + matrix[1][2]) / z];
  }

  function polygon(box) {
    const [x, y, width, height] = box;
    return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  }

  function bounds(points) {
    const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
    const left = Math.min(...xs), top = Math.min(...ys);
    return [left, top, Math.max(...xs) - left, Math.max(...ys) - top];
  }

  function normalizeConfig(config = {}) {
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("识别参数必须是对象。");
    const options = {
      rotation: config.rotation ?? 0, split: config.split ?? "none",
      split_position: config.split_position ?? 0.5, mode: config.mode ?? "auto",
      max_side: config.max_side ?? 1920, min_confidence: config.min_confidence ?? 0.45
    };
    if (![0, 90, 180, 270].includes(options.rotation)) throw new Error("旋转角度必须是顺时针 0、90、180 或 270 度。");
    if (!["none", "pages", "columns"].includes(options.split)) throw new Error("分区方式必须为 none、pages 或 columns。");
    if (!Number.isFinite(options.split_position) || options.split_position < 0.1 || options.split_position > 0.9) throw new Error("分界比例必须在 0.1 到 0.9 之间。");
    if (!["none", "perspective", "auto"].includes(options.mode)) throw new Error("校正方式必须为 none、perspective 或 auto。");
    if (!Number.isInteger(options.max_side) || options.max_side < 640 || options.max_side > 2560) throw new Error("每区最大边长必须在 640 到 2560 之间。");
    if (!Number.isFinite(options.min_confidence) || options.min_confidence < 0 || options.min_confidence > 1) throw new Error("置信度必须在 0 到 1 之间。");
    return options;
  }

  function rotationMatrix(width, height, rotation) {
    if (rotation === 90) return [[0, -1, height - 1], [1, 0, 0], [0, 0, 1]];
    if (rotation === 180) return [[-1, 0, width - 1], [0, -1, height - 1], [0, 0, 1]];
    if (rotation === 270) return [[0, 1, 0], [-1, 0, width - 1], [0, 0, 1]];
    return identity();
  }

  function planRegions(width, height, config = {}) {
    const options = normalizeConfig(config);
    if (!Number.isInteger(width) || !Number.isInteger(height) || Math.min(width, height) < 32 || width * height > MAX_PIXELS) {
      throw new Error("照片宽高至少为 32 像素，且不能超过 2000 万像素。");
    }
    const sideways = options.rotation === 90 || options.rotation === 270;
    const rotatedWidth = sideways ? height : width, rotatedHeight = sideways ? width : height;
    const boundary = roundToEven(rotatedWidth * options.split_position);
    if (options.split !== "none" && Math.min(boundary, rotatedWidth - boundary, rotatedHeight) < 32) {
      throw new Error("分割后每区宽高至少需要 32 像素，请调整分界线。");
    }
    const partitions = options.split === "none" ? [[0, rotatedWidth, "page-1", "完整页面", "page"]]
      : options.split === "pages" ? [[0, boundary, "page-1", "左页", "page"], [boundary, rotatedWidth, "page-2", "右页", "page"]]
        : [[0, boundary, "column-1", "左栏", "column"], [boundary, rotatedWidth, "column-2", "右栏", "column"]];
    const rotation = rotationMatrix(width, height, options.rotation);
    return partitions.map(([left, right, id, label, kind]) => {
      const regionWidth = right - left;
      const ratio = Math.min(1, options.max_side / Math.max(regionWidth, rotatedHeight));
      const outputWidth = Math.max(2, roundToEven(regionWidth * ratio));
      const outputHeight = Math.max(2, roundToEven(rotatedHeight * ratio));
      const sourceToRegion = multiply([[1, 0, -left], [0, 1, 0], [0, 0, 1]], rotation);
      const sourceToPage = multiply([[outputWidth / regionWidth, 0, 0], [0, outputHeight / rotatedHeight, 0], [0, 0, 1]], sourceToRegion);
      return {
        id, label, kind, left, width: regionWidth, height: rotatedHeight,
        outputWidth, outputHeight, sourceToRegion, sourceToPage,
        regionToSource: inverse(sourceToRegion), pageToSource: inverse(sourceToPage),
        sourceSize: [width, height], rotatedSize: [rotatedWidth, rotatedHeight]
      };
    });
  }

  function stopWorker(worker) {
    try {
      const pending = worker?.terminate?.();
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch { /* A failed worker may already have terminated. */ }
  }

  class FeelyBrowserOCR {
    constructor() {
      this._record = null;
      this._active = null;
      this._destroyed = false;
    }

    _check(task) {
      if (task.cancelled || this._destroyed) throw abortError();
    }

    _race(promise, task) {
      const operation = Promise.resolve(promise);
      operation.catch(() => {});
      this._check(task);
      return Promise.race([operation, task.aborted]);
    }

    _progress(task, value) {
      if (this._active !== task || task.cancelled || this._destroyed) return;
      const bounded = Math.max(task.progress, Math.max(0, Math.min(1, value)));
      if (!Number.isFinite(bounded)) return;
      task.progress = bounded;
      try { task.onProgress?.(bounded); } catch { /* UI callbacks cannot break OCR. */ }
    }

    _discardWorker(record = this._record) {
      if (!record) return;
      record.discarded = true;
      if (this._record === record) this._record = null;
      stopWorker(record.worker || record.raw);
    }

    _captureWorker(record, path, factory) {
      // Tesseract.js 6 synchronously creates its native worker before returning
      // its initialization promise. Capture only that URL, and restore the
      // constructor before yielding, so abort can stop an initializing worker.
      const Original = global.Worker;
      if (typeof Original !== "function") return factory();
      function CapturedWorker(url, options) {
        const worker = new Original(url, options);
        if (String(url) === path) {
          record.raw = worker;
          worker.addEventListener?.("error", event => record.rejectError(new Error(event.message || "识别线程异常。")));
        }
        return worker;
      }
      CapturedWorker.prototype = Original.prototype;
      Object.setPrototypeOf(CapturedWorker, Original);
      let replaced = false;
      try { global.Worker = CapturedWorker; replaced = global.Worker === CapturedWorker; } catch { /* Late initialization cleanup remains available. */ }
      try { return factory(); }
      finally { if (replaced && global.Worker === CapturedWorker) global.Worker = Original; }
    }

    async _worker(task) {
      if (!this._record) {
        if (typeof global.Tesseract?.createWorker !== "function") throw new Error("浏览器 OCR 组件未加载，请刷新页面重试。");
        const record = { discarded: false, worker: null, raw: null };
        record.errors = new Promise((_, reject) => { record.rejectError = reject; });
        record.errors.catch(() => {});
        this._record = record;
        const base = global.document.baseURI;
        const workerPath = new global.URL("vendor/tesseract/worker.min.js", base).href;
        const options = {
          workerPath,
          corePath: new global.URL("vendor/tesseract/core/", base).href,
          langPath: new global.URL("vendor/tesseract/lang/", base).href,
          gzip: false, workerBlobURL: false,
          logger: message => {
            if (this._record !== record || !this._active) return;
            const active = this._active;
            const progress = Number(message.progress);
            if (!Number.isFinite(progress)) return;
            const recognizing = String(message.status || "").includes("recogniz");
            this._progress(active, recognizing
              ? 0.15 + 0.8 * (active.regionIndex + progress) / active.regionCount
              : 0.01 + 0.14 * progress);
          },
          // v6 can swallow a language/init rejection; this independent channel
          // also prevents its default errorHandler from throwing out of band.
          errorHandler: error => record.rejectError(new Error(String(error?.message || error || "OCR 初始化失败。")))
        };
        try {
          const produced = this._captureWorker(record, workerPath,
            () => global.Tesseract.createWorker("chi_sim+eng", 1, options));
          record.ready = Promise.resolve(produced).then(async worker => {
            record.worker = worker;
            if (record.discarded || this._record !== record) {
              stopWorker(worker);
              throw abortError();
            }
            if (!worker || typeof worker.recognize !== "function") throw new Error("OCR 线程初始化结果无效。");
            if (typeof worker.setParameters === "function") {
              await worker.setParameters({ tessedit_pageseg_mode: "3", preserve_interword_spaces: "1", user_defined_dpi: "300" });
            }
            return worker;
          });
          record.ready.catch(() => {});
        } catch (error) {
          this._discardWorker(record);
          throw error;
        }
      }
      const record = this._record;
      task.usedWorker = true;
      const worker = await this._race(Promise.race([record.ready, record.errors]), task);
      this._check(task);
      return { worker, record };
    }

    async _decode(blob, task) {
      const header = new Uint8Array(await this._race(blob.slice(0, 12).arrayBuffer(), task));
      const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
      const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => header[index] === value);
      const webp = [82, 73, 70, 70].every((value, index) => header[index] === value)
        && [87, 69, 66, 80].every((value, index) => header[index + 8] === value);
      if (!jpeg && !png && !webp) throw new Error("仅支持 JPEG、PNG 或 WebP 照片。");
      return this._race(new Promise((resolve, reject) => {
        const image = new global.Image();
        const url = global.URL.createObjectURL(blob);
        let released = false;
        const release = () => { if (!released) { released = true; global.URL.revokeObjectURL(url); } };
        task.cleanup.push(() => { release(); image.onload = image.onerror = null; image.src = ""; });
        image.onload = () => { release(); resolve(image); };
        image.onerror = () => { release(); reject(new Error("照片解码失败，请选择有效图片。")); };
        // The browser decodes EXIF display orientation once. All source
        // coordinates below refer to these naturalWidth/naturalHeight pixels.
        image.src = url;
      }), task);
    }

    _render(image, plan, rotation, task) {
      const canvas = global.document.createElement("canvas");
      canvas.width = plan.outputWidth;
      canvas.height = plan.outputHeight;
      task.cleanup.push(() => { canvas.width = canvas.height = 1; });
      const context = canvas.getContext("2d");
      if (!context) throw new Error("当前浏览器无法创建照片处理画布。");
      // Compose rotation, crop and resize into the output canvas. This avoids
      // allocating an additional full-resolution 20-megapixel rotated canvas.
      context.scale(plan.outputWidth / plan.width, plan.outputHeight / plan.height);
      context.translate(-plan.left, 0);
      const width = image.naturalWidth, height = image.naturalHeight;
      if (rotation === 90) context.transform(0, 1, -1, 0, height, 0);
      else if (rotation === 180) context.transform(-1, 0, 0, -1, width, height);
      else if (rotation === 270) context.transform(0, -1, 1, 0, 0, width);
      context.drawImage(image, 0, 0);
      return canvas;
    }

    _appendResult(data, plan, options, result) {
      if (!data || typeof data !== "object" || typeof data.text !== "string") {
        throw new Error("浏览器 OCR 返回了无效数据，请重新识别。");
      }
      const localLines = [], localBlocks = [];
      const nativeBlocks = Array.isArray(data?.blocks) ? data.blocks : [];
      if (!nativeBlocks.length && String(data?.text || "").trim()) {
        throw new Error("OCR 引擎未返回文字行坐标，请重新识别。");
      }
      for (const block of nativeBlocks) {
        const candidates = [];
        for (const paragraph of block.paragraphs || []) {
          for (const line of paragraph.lines || []) {
            const text = typeof line.text === "string" ? line.text.trim() : "";
            const confidence = Number(line.confidence) / 100;
            const box = line.bbox;
            if (!text || !Number.isFinite(confidence) || confidence < options.min_confidence || !box) continue;
            const coords = [box.x0, box.y0, box.x1, box.y1].map(Number);
            if (!coords.every(Number.isFinite)) continue;
            const [x0, y0, x1, y1] = coords;
            const left = Math.max(0, x0), top = Math.max(0, y0);
            const right = Math.min(plan.outputWidth - 1, x1), bottom = Math.min(plan.outputHeight - 1, y1);
            if (right <= left || bottom <= top) continue;
            candidates.push({ text, confidence: Math.max(0, Math.min(1, confidence)), box: [left, top, right - left, bottom - top] });
          }
        }
        if (!candidates.length) continue;
        const blockId = `block-${result.blocks.length + localBlocks.length + 1}`;
        const blockLineIds = [];
        for (const candidate of candidates) {
          const id = `line-${result.lines.length + localLines.length + 1}`;
          const rectified = polygon(candidate.box);
          const source = rectified.map(point => project(plan.pageToSource, point));
          localLines.push({
            id, reading_order: result.lines.length + localLines.length + 1,
            region_id: plan.id, block_id: blockId, text: candidate.text,
            confidence: Math.round(candidate.confidence * 10000) / 10000,
            polygon_rectified: rectified.map(point => point.map(rounded)),
            polygon_source: source.map(point => point.map(rounded)),
            bbox_rectified: candidate.box.map(rounded), bbox_source: bounds(source).map(rounded)
          });
          blockLineIds.push(id);
        }
        localBlocks.push({
          id: blockId, region_id: plan.id, type: "text", line_ids: blockLineIds,
          bbox: bounds(candidates.flatMap(candidate => polygon(candidate.box))).map(rounded),
          coordinate_space: "rectified"
        });
      }
      result.lines.push(...localLines);
      result.blocks.push(...localBlocks);
      return localLines.map(line => line.id);
    }

    async recognize(blob, config = {}, { signal, onProgress } = {}) {
      if (this._destroyed) throw new Error("浏览器 OCR 实例已关闭。");
      if (this._active) { const error = new Error("上一张照片仍在识别，请稍后重试。"); error.name = "BusyError"; throw error; }
      if (signal?.aborted) throw abortError();
      const options = normalizeConfig(config);
      if (!blob || typeof blob.slice !== "function" || !Number.isFinite(blob.size) || blob.size <= 0) throw new Error("请选择有效照片。");
      if (blob.size > MAX_BYTES) throw new Error("照片超过 8 MiB，请压缩后重试。");
      const task = { cleanup: [], onProgress, progress: 0, regionIndex: 0, regionCount: 1, cancelled: false, usedWorker: false };
      task.aborted = new Promise((_, reject) => { task.rejectAbort = reject; });
      task.aborted.catch(() => {});
      task.cancel = () => {
        if (task.cancelled || this._active !== task) return;
        task.cancelled = true;
        task.rejectAbort(abortError());
        this._discardWorker();
      };
      this._active = task;
      signal?.addEventListener("abort", task.cancel, { once: true });
      const started = now();
      try {
        this._progress(task, 0);
        const image = await this._decode(blob, task);
        this._check(task);
        const decodedAt = now();
        const plans = planRegions(image.naturalWidth, image.naturalHeight, options);
        task.regionCount = plans.length;
        const warnings = options.mode === "none" ? [] : [
          "浏览器识别支持旋转、左右分区和文字行定位，未执行透视或曲面校正；需要这些校正时请选择 Python 服务。"
        ];
        const result = {
          schema_version: "2.0", document_id: global.crypto?.randomUUID?.() || `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          engine: ENGINE, source_size: [image.naturalWidth, image.naturalHeight], rotated_size: plans[0].rotatedSize,
          calibration: { rotation_clockwise: options.rotation, split: options.split, split_position: options.split_position },
          regions: [], lines: [], blocks: [], text: "", warnings,
          coordinates: {
            unit: "pixel", origin: "top-left", x_axis: "right", y_axis: "down", bbox_format: "x,y,width,height",
            source_orientation: "EXIF-transposed", scope: "single-photo", text_location_level: "line", rectified_space: "region-local"
          },
          layout_method: "tesseract-block-paragraph-line-order"
        };
        const initializeAt = now();
        const { worker, record } = await this._worker(task);
        let ocrTime = now() - initializeAt, geometryTime = 0;
        for (const [index, plan] of plans.entries()) {
          this._check(task);
          task.regionIndex = index;
          const geometryAt = now();
          const canvas = this._render(image, plan, options.rotation, task);
          geometryTime += now() - geometryAt;
          this._progress(task, 0.15 + 0.8 * index / plans.length);
          this._check(task);
          const ocrAt = now();
          const response = await this._race(Promise.race([
            worker.recognize(canvas, {}, { text: true, blocks: true }), record.errors
          ]), task);
          ocrTime += now() - ocrAt;
          this._check(task);
          const lineIds = this._appendResult(response?.data, plan, options, result);
          const regionWarnings = lineIds.length ? [] : ["本区未检测到可靠文字，请检查照片清晰度和识别方向。"];
          result.warnings.push(...regionWarnings.map(message => `${plan.label}：${message}`));
          const calibration = {
            id: plan.id, label: plan.label, kind: plan.kind, rotation: options.rotation,
            bounds_rotated: [plan.left, 0, plan.width, plan.height], source_size: plan.sourceSize,
            rotated_size: plan.rotatedSize, region_size: [plan.width, plan.height],
            source_to_region_matrix: plan.sourceToRegion, region_to_source_matrix: plan.regionToSource,
            coordinate_unit: "pixel", source_coordinate_space: "exif_normalized_photo"
          };
          const transform = {
            source_size: plan.sourceSize, region_source_size: [plan.width, plan.height], rectified_size: [plan.outputWidth, plan.outputHeight],
            perspective_applied: false, curvature_applied: false, curvature_mesh: null,
            source_to_page_matrix: plan.sourceToPage, page_to_source_matrix: plan.pageToSource,
            coordinate_unit: "pixel", warnings: warnings.slice(0, options.mode === "none" ? 0 : 1)
          };
          const rectifiedImage = canvas.toDataURL("image/jpeg", 0.9);
          if (!rectifiedImage.startsWith("data:image/jpeg;base64,")) throw new Error("浏览器无法导出校准照片，请降低处理分辨率。");
          result.regions.push({
            id: plan.id, label: plan.label, kind: plan.kind, line_ids: lineIds,
            polygon_source: polygon([0, 0, plan.width - 1, plan.height - 1]).map(point => project(plan.regionToSource, point).map(rounded)),
            rectified_size: [plan.outputWidth, plan.outputHeight], rectified_image: rectifiedImage,
            calibration, transform, warnings: regionWarnings
          });
          canvas.width = canvas.height = 1;
        }
        result.text = result.lines.map(line => line.text).join("\n");
        const first = result.regions[0];
        result.rectified_image = first.rectified_image;
        result.rectified_size = first.rectified_size;
        result.transform = first.transform;
        result.timing_ms = { decode: rounded(decodedAt - started), geometry: rounded(geometryTime), ocr: rounded(ocrTime), total: rounded(now() - started) };
        this._progress(task, 1);
        this._check(task);
        return result;
      } catch (error) {
        if (task.usedWorker) this._discardWorker();
        if (task.cancelled || error?.name === "AbortError") throw abortError();
        if (error instanceof Error) throw error;
        throw new Error(`浏览器 OCR 失败：${String(error)}`);
      } finally {
        signal?.removeEventListener("abort", task.cancel);
        for (const release of task.cleanup) { try { release(); } catch {} }
        if (this._active === task) this._active = null;
      }
    }

    destroy() {
      if (this._destroyed) return;
      this._active?.cancel();
      this._discardWorker();
      this._destroyed = true;
    }
  }

  FeelyBrowserOCR.utils = Object.freeze({ roundToEven, normalizeConfig, rotationMatrix, planRegions, multiply, inverse, project, bounds });
  global.FeelyBrowserOCR = FeelyBrowserOCR;
})(typeof window !== "undefined" ? window : globalThis);
