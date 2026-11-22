/* A/B/C/D orchestration. Snapshot geometry is never reused across captures. */
(function attachReaderController(global) {
  "use strict";

  const DEFAULTS = Object.freeze({ engine: "browser", endpoint: "", rotation: 0,
    split: "none", split_position: 0.5, mode: "auto", max_side: 1920, min_confidence: 0.45 });
  const makeId = () => global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const abortError = () => new DOMException("识别已取消", "AbortError");

  function project(matrix, x, y) {
    if (!Array.isArray(matrix) || matrix.length !== 9 || !matrix.every(Number.isFinite)) return null;
    const z = matrix[6] * x + matrix[7] * y + matrix[8];
    if (Math.abs(z) < 1e-9) return null;
    const point = { x: (matrix[0] * x + matrix[1] * y + matrix[2]) / z,
      y: (matrix[3] * x + matrix[4] * y + matrix[5]) / z };
    return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
  }

  function cameraRect(video) {
    if (!video?.videoWidth || !video.videoHeight || video.hidden) return null;
    const box = video.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    if (!Number.isFinite(scale) || scale <= 0) return null;
    return { left: box.left + (box.width - video.videoWidth * scale) / 2,
      top: box.top + (box.height - video.videoHeight * scale) / 2, scale };
  }

  function normalizeMap(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.lines) || raw.lines.length > 10000) {
      throw new Error("文字地图必须包含有效的 lines 数组（最多 10000 行）。");
    }
    const schema2 = String(raw.schema_version || "").startsWith("2");
    if (schema2 && !raw.source_size) throw new Error("版本 2 文字地图缺少原图尺寸 source_size。");
    const size = raw.source_size || raw.rectified_size || [1, 1];
    if (!Array.isArray(size) || size.length !== 2 || !size.every(v => Number.isFinite(v) && v > 0)
        || size[0] * size[1] > 20_000_000) throw new Error("文字地图的照片尺寸无效或过大。");
    const ids = new Set();
    const lines = raw.lines.map((line, i) => {
      if (typeof line?.text !== "string" || line.text.length > 50000) throw new Error("文字行内容无效。");
      let id = String(line.id || `line-${i + 1}`);
      if (ids.has(id)) id = `${id}-${i + 1}`;
      ids.add(id);
      if (schema2 && !line.bbox_source && !line.polygon_source) {
        throw new Error("版本 2 文字地图缺少原图定位坐标，不能使用分区局部坐标替代。");
      }
      let box = line.bbox_source || (!schema2 ? line.bbox_rectified : null) || null;
      if (box && (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)
          || box[2] <= 0 || box[3] <= 0)) throw new Error("文字框坐标无效。");
      let polygon = line.polygon_source;
      if (polygon != null && (!Array.isArray(polygon) || polygon.length > 256 || polygon.length < 3
          || polygon.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)))) {
        throw new Error("文字多边形坐标无效。");
      }
      if (!polygon && box) {
        const [x, y, w, h] = box;
        polygon = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      }
      if (!box && polygon) {
        const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]);
        box = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
      }
      return { ...line, id, text: line.text.trim(), bbox_source: box, polygon_source: polygon || [],
        reading_order: Number.isFinite(line.reading_order) ? line.reading_order : i + 1 };
    }).filter(line => line.text).sort((a, b) => a.reading_order - b.reading_order);
    return { ...raw, document_id: String(raw.document_id || raw.frame_id || raw.pageId || makeId()),
      source_size: [...size], lines, text: lines.map(line => line.text).join("\n"),
      warnings: Array.isArray(raw.warnings) ? raw.warnings.filter(v => typeof v === "string") : [],
      regions: Array.isArray(raw.regions) ? raw.regions : [], blocks: Array.isArray(raw.blocks) ? raw.blocks : [] };
  }

  class FeelyReaderController {
    constructor(options = {}) {
      this.config = { ...DEFAULTS };
      this.listeners = new Set();
      this.pages = [];
      this.activePageKey = null;
      this.status = "idle";
      this.message = "拍摄书页、选择照片或导入文字地图开始阅读。";
      this.progress = 0;
      this.failures = [];
      this.inputMode = "camera";
      this.session = makeId();
      this.generation = 0;
      this.queue = [];
      this.running = false;
      this.request = null;
      this.urls = new Set();
      this.tracking = new Map();
      this.gesturesEnabled = false;
      this.gestureStatus = "开启实时手势可查看手骨架；识别书页后可进行纸面点读。";
      this.gestureHands = 0;
      this.gestureFPS = 0;
      this.gestureModelReady = false;
      this.gestureError = "";
      this.gesture = null;
      this.gestureToken = 0;
      this.gestureMappedKey = null;
      this.gestureSpeechAllowed = true;
      this.wordBuffer = [];
      this.now = options.now || (() => global.performance.now());
      this.bookReader = options.bookReader || global.BookReader;
      this.events = options.eventTarget || global;
      this.fetch = options.fetch || global.fetch?.bind(global);
      this.ocr = options.ocr || new global.FeelyBrowserOCR();
      this.reader = options.readingManager || new global.ReadingManager({ autoListenA: false,
        initialMap: { document_id: "empty", label: "等待书页", lines: [] } });
      this.removeReadingListener = this.reader.onStateChange(() => this.emit());
      this.onCaptured = event => this.acceptCapture(event.detail);
      this.events.addEventListener("bookreader:captured", this.onCaptured);
      this.removeTracking = this.bookReader?.subscribePageTracking?.(message => this.acceptTracking(message));
      this.removeFrames = this.bookReader?.subscribeVideoFrames?.(frame => {
        if (frame.type === "state" && ["stopped", "background", "reference-changing", "tracking-error"].some(s => String(frame.state).startsWith(s))) {
          this.tracking.clear();
          this.syncGestureMap();
          if (["stopped", "background"].includes(frame.state)) { this.pause(); this.setGesturesEnabled(false); }
          this.emit();
        }
      });
      this.lastTrackingReady = false;
      this.trackingTimer = global.setInterval(() => {
        const ready = !!this.activeTracking();
        if (ready !== this.lastTrackingReady) { this.lastTrackingReady = ready; this.syncGestureMap(); this.emit(); }
      }, 200);
      this.trackingTimer?.unref?.();
      this.onBackground = () => { if (global.document?.hidden) { this.tracking.clear(); this.pause(); this.setGesturesEnabled(false); } };
      global.document?.addEventListener("visibilitychange", this.onBackground);
      this.onKeys = event => {
        const tag = event.target?.tagName?.toLowerCase();
        if (["input", "textarea", "select", "button"].includes(tag) || event.target?.isContentEditable || event.altKey || event.ctrlKey || event.metaKey) return;
        if (!this.activePage()?.map?.lines.length) return;
        if (event.code === "Space") { event.preventDefault(); this.reader.getState().status === "playing" ? this.pause() : this.play(); }
        else if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); this.next(); }
        else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); this.prev(); }
      };
      this.events.addEventListener("keydown", this.onKeys);
    }

    addEventListener(type, listener) { if (type === "state") this.listeners.add(listener); }
    removeEventListener(type, listener) { if (type === "state") this.listeners.delete(listener); }
    activePage() { return this.pages.find(page => page.key === this.activePageKey) || null; }
    getState() {
      const page = this.activePage();
      return { status: this.status, message: this.message, progress: this.progress,
        pages: this.pages.map(p => ({ key: p.key, label: p.label, map: p.map, sourceUrl: p.sourceUrl })),
        activePageKey: this.activePageKey, activeMap: page?.map || null, activeImageUrl: page?.sourceUrl || "",
        trackingReady: !!this.activeTracking(), gesturesEnabled: this.gesturesEnabled,
        gestureStatus: this.gestureStatus, gestureHands: this.gestureHands, gestureFPS: this.gestureFPS,
        gestureModelReady: this.gestureModelReady, gestureError: this.gestureError,
        reading: this.reader?.getState?.() || {},
        highlights: this.reader?.getHighlights?.() || this.reader?.highlights || [],
        history: this.reader?.getHistory?.() || this.reader?.history || [] };
    }
    emit() {
      if (this.destroyed) return;
      const detail = this.getState();
      for (const listener of this.listeners) { try { listener({ type: "state", detail }); } catch (error) { global.console.error(error); } }
    }

    setConfig(changes) {
      const next = { ...this.config, ...changes };
      if (!["browser", "python"].includes(next.engine) || ![0, 90, 180, 270].includes(next.rotation)
          || !["none", "pages", "columns"].includes(next.split) || !["none", "auto", "perspective"].includes(next.mode)
          || !Number.isFinite(next.split_position) || next.split_position < .1 || next.split_position > .9
          || !Number.isInteger(next.max_side) || next.max_side < 640 || next.max_side > 2560
          || !Number.isFinite(next.min_confidence) || next.min_confidence < 0 || next.min_confidence > 1) {
        throw new Error("识别参数无效，请检查方向、分割和分辨率。");
      }
      next.endpoint = String(next.endpoint || "").trim();
      if (next.endpoint) this.endpointURL(next.endpoint);
      if (JSON.stringify(next) === JSON.stringify(this.config)) return;
      this.config = next;
      this.reset();
      this.message = "设置已更新，请重新识别照片或采集书页。";
      this.emit();
    }

    endpointURL(value) {
      const url = new URL(value || "api/ocr", global.document?.baseURI || global.location.href);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      const sameOrigin = url.origin === global.location.origin;
      if (url.username || url.password || !["http:", "https:"].includes(url.protocol)
          || (url.protocol !== "https:" && !local && !sameOrigin)) throw new Error("识别接口必须为可信 HTTPS 地址，本机 localhost 调试除外。");
      url.hash = "";
      return url;
    }

    cancel() {
      this.generation += 1;
      this.queue = [];
      this.request?.abort();
      this.request = null;
      this.gestureSpeechAllowed = false;
      this.wordBuffer.length = 0;
      this.reader?.pause(true);
      this.clearWords();
      this.status = this.pages.length ? "ready" : "idle";
      this.progress = 0;
      this.message = "已取消当前识别。";
      this.emit();
    }
    reset() {
      this.cancel();
      this.pages = [];
      this.failures = [];
      this.activePageKey = null;
      for (const url of this.urls) global.URL.revokeObjectURL(url);
      this.urls.clear();
      this.tracking.clear();
      this.reader.loadOcrMap({ document_id: "empty", lines: [] }, { silent: true });
      this.syncGestureMap();
      this.status = "idle";
    }
    sourceURL(blob) { const url = global.URL.createObjectURL(blob); this.urls.add(url); return url; }

    async selectPhoto(file) {
      if (!(file instanceof global.Blob) || !file.size || file.size > 8 * 1024 * 1024) throw new Error("请选择不超过 8 MiB 的有效照片。");
      this.reset();
      this.inputMode = "photo";
      const job = { generation: this.generation, key: `photo:${makeId()}`, label: file.name || "所选照片",
        blob: file, sourceUrl: this.sourceURL(file), config: { ...this.config }, reference: false };
      this.queue = [job];
      return this.drain();
    }

    acceptCapture(detail) {
      if (!detail?.blob || !Array.isArray(detail.pages)) return;
      if (detail.automatic && this.inputMode !== "camera") return;
      this.reset();
      this.inputMode = "camera";
      const generation = this.generation;
      const captureCount = Number(detail.metadata?.captureCount || 0);
      const pages = detail.pages.length ? detail.pages : [{ blob: detail.blob, label: "手动拍摄照片" }];
      this.queue = pages.map((page, i) => ({ generation,
        key: `${this.session}:capture:${captureCount}:page:${page.pageId ?? i}`,
        readingKey: `${this.session}:content:${page.pageId ?? captureCount}`,
        label: page.label || `第 ${i + 1} 页`, blob: page.blob, sourceUrl: this.sourceURL(page.blob),
        reference: detail.pages.length > 0, pageId: page.pageId, captureCount,
        width: page.width, height: page.height,
        config: detail.pages.length ? { ...this.config, rotation: 0, split: "none" } : { ...this.config } }));
      this.drain();
    }

    async drain() {
      if (this.running || this.destroyed) return;
      this.running = true;
      try {
        while (this.queue.length && !this.destroyed) {
          const job = this.queue.shift();
          if (job.generation !== this.generation) continue;
          const request = new global.AbortController();
          this.request = request;
          this.status = "recognizing";
          this.progress = 0;
          this.message = `正在识别${job.label}…首次运行需要加载模型。`;
          this.emit();
          try {
            const progress = value => {
              if (job.generation !== this.generation || request.signal.aborted) return;
              this.progress = Math.max(0, Math.min(1, Number(value) || 0)); this.emit();
            };
            const raw = job.config.engine === "python"
              ? await this.recognizePython(job, request.signal)
              : await this.ocr.recognize(job.blob, job.config, { signal: request.signal, onProgress: progress });
            if (job.generation !== this.generation || request.signal.aborted) continue;
            this.acceptResult(job, raw);
            this.progress = 1;
            this.status = this.queue.length ? "recognizing" : "ready";
            this.message = this.queue.length ? "当前页识别完成，正在处理下一页…"
              : this.failures.length ? `部分页面未能识别：${this.failures.join('；')}`
                : "识别完成。可点击文字行朗读；跟踪有效时可使用纸面手势。";
            this.emit();
          } catch (error) {
            if (job.generation !== this.generation || request.signal.aborted || error.name === "AbortError") continue;
            this.status = "error";
            this.failures.push(`${job.label}：${error.message || error}`);
            this.message = `识别未完成：${error.message || error}`;
            this.emit();
          } finally { if (this.request === request) this.request = null; }
        }
      } finally { this.running = false; if (this.queue.length && !this.destroyed) this.drain(); }
    }

    async recognizePython(job, signal) {
      const url = this.endpointURL(job.config.endpoint);
      for (const key of ["rotation", "split", "split_position", "mode", "max_side", "min_confidence"]) url.searchParams.set(key, String(job.config[key]));
      const signature = new Uint8Array(await job.blob.slice(0, 12).arrayBuffer());
      const type = signature[0] === 255 && signature[1] === 216 ? "image/jpeg"
        : signature[0] === 137 && signature[1] === 80 ? "image/png"
          : signature[0] === 82 && signature[8] === 87 ? "image/webp" : null;
      if (!type) throw new Error("只支持 JPEG、PNG 和 WebP 照片。");
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (signal.aborted) throw abortError();
        const response = await this.fetch(url.href, { method: "POST", headers: { "Content-Type": type }, body: job.blob, signal });
        let data;
        try { data = await response.json(); } catch { throw new Error(`Python 接口未返回有效 JSON（HTTP ${response.status}）。`); }
        if (response.ok) return data;
        if (response.status !== 503 || attempt === 3) throw new Error(data.error || `识别服务返回 HTTP ${response.status}`);
        this.message = "识别服务正忙，正在等待…"; this.emit();
        await new Promise((resolve, reject) => {
          const timer = global.setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, 1000 * (attempt + 1));
          const aborted = () => { global.clearTimeout(timer); reject(abortError()); };
          signal.addEventListener("abort", aborted, { once: true });
        });
      }
      throw new Error("识别服务暂时不可用。");
    }

    acceptResult(job, raw) {
      const map = normalizeMap(raw);
      if (job.reference && (map.source_size[0] !== job.width || map.source_size[1] !== job.height)) {
        throw new Error("识别结果与相机参考页尺寸不一致，请重新采集。");
      }
      const parts = map.regions.length > 1 ? map.regions : [null];
      for (const region of parts) {
        const lines = region ? map.lines.filter(line => line.region_id === region.id) : map.lines;
        const pageMap = region ? { ...map, lines, regions: [region], text: lines.map(line => line.text).join("\n"),
          blocks: map.blocks.filter(block => block.region_id === region.id),
          rectified_size: region.rectified_size, rectified_image: region.rectified_image, transform: region.transform } : map;
        const page = { ...job, key: region ? `${job.key}:${region.id}` : job.key,
          label: region ? `${job.label} · ${region.label || region.id}` : job.label, map: pageMap,
          readingKey: region ? `${job.readingKey || map.document_id}:${region.id}` : (job.readingKey || map.document_id) };
        this.pages.push(page);
        if (!this.activePageKey) this.selectPage(page.key);
      }
    }

    importMap(raw, imageFile = null) {
      const map = normalizeMap(raw);
      this.reset();
      this.inputMode = "import";
      const job = { key: `import:${makeId()}`, label: raw.label || "导入的文字地图", reference: false,
        sourceUrl: imageFile instanceof global.Blob ? this.sourceURL(imageFile) : "" };
      this.acceptResult(job, map);
      this.status = "ready";
      this.message = "文字地图已载入，可逐行朗读。未附原照片时，定位框显示在空白画布上。";
      this.emit();
    }
    selectPage(key) {
      const page = this.pages.find(item => item.key === key);
      if (!page) return;
      this.activePageKey = key;
      this.clearWords();
      this.gestureSpeechAllowed = true;
      this.reader.loadOcrMap({ ...page.map, document_id: page.readingKey, pageId: page.readingKey, label: page.label }, { silent: true });
      this.syncGestureMap(); this.emit();
    }

    acceptTracking(envelope) {
      this.tracking.clear();
      for (const record of envelope?.pages || []) {
        if (record.valid && Number.isFinite(record.timestamp)) this.tracking.set(String(record.pageId), record);
      }
      this.syncGestureMap(); this.emit();
    }
    activeTracking() {
      const page = this.activePage();
      if (!page?.reference || !page.map?.lines.length) return null;
      const track = this.tracking.get(String(page.pageId));
      const age = track ? this.now() - track.timestamp : Infinity;
      const video = this.bookReader?.getVideoElement?.();
      if (!track?.valid || track.referenceCaptureCount !== page.captureCount || age < -50 || age >= 400
          || track.videoSize?.width !== video?.videoWidth || track.videoSize?.height !== video?.videoHeight
          || track.referenceSize?.width !== page.width || track.referenceSize?.height !== page.height
          || !project(track.currentVideoToReference, 0, 0) || !project(track.referenceToCurrentVideo, 0, 0)) return null;
      return track;
    }
    coordinateMapper() {
      return {
        isValid: () => !!this.activeTracking(),
        screenToMap: (x, y) => {
          const track = this.activeTracking(), video = this.bookReader?.getVideoElement?.(), box = cameraRect(video);
          return track && box ? project(track.currentVideoToReference, (x - box.left) / box.scale, (y - box.top) / box.scale) : null;
        },
        mapToScreen: (x, y) => {
          const track = this.activeTracking(), video = this.bookReader?.getVideoElement?.(), box = cameraRect(video);
          const point = track && box ? project(track.referenceToCurrentVideo, x, y) : null;
          return point ? { x: box.left + point.x * box.scale, y: box.top + point.y * box.scale } : null;
        }
      };
    }
    syncGestureMap() {
      if (!this.gesture) return;
      const page = this.activePage(), ready = !!this.activeTracking();
      if (!ready) {
        if (this.gestureMappedKey) this.gesture.clearTextMap();
        this.gestureMappedKey = null; this.clearWords();
        this.gestureStatus = page?.reference ? "手势识别已开启；书页跟踪暂不可用，点读等待恢复。" : "手势识别已开启，可查看手骨架；拍摄并识别书页后可纸面点读。";
        return;
      }
      if (this.gestureMappedKey !== page.key) {
        const lines = page.map.lines.filter(line => line.bbox_source && line.bbox_source[2] > 0 && line.bbox_source[3] > 0)
          .map(line => ({ ...line, bbox_rectified: line.bbox_source }));
        if (!lines.length) return;
        this.gesture.setTextMap({ ...page.map, lines, rectified_size: page.map.source_size });
        this.gestureMappedKey = page.key;
      }
      this.gestureStatus = this.gestureSpeechAllowed ? "纸面跟踪有效，可单指点读或双指选区。" : "点读已暂停，点击开始朗读可恢复。";
    }

    async setGesturesEnabled(enabled) {
      const token = ++this.gestureToken;
      if (!enabled) {
        const gesture = this.gesture; this.gesture = null;
        this.gesturesEnabled = false; this.gestureMappedKey = null; this.clearWords();
        this.gestureHands = 0; this.gestureFPS = 0; this.gestureModelReady = false; this.gestureError = "";
        this.bookReader?.setHandOccluded?.(false);
        gesture?.destroy();
        this.gestureStatus = "手势已关闭。"; this.emit(); return;
      }
      if (this.gesture) { this.gesturesEnabled = true; this.emit(); return; }
      this.gestureError = "";
      let video = this.bookReader?.getVideoElement?.();
      if ((!video?.srcObject || !video.videoWidth) && this.bookReader?.startCamera) {
        this.gestureStatus = "正在开启相机…"; this.emit();
        await this.bookReader.startCamera();
        if (token !== this.gestureToken || this.destroyed) return;
        video = this.bookReader.getVideoElement();
      }
      if (!video?.srcObject || !video.videoWidth) throw new Error("请先开启相机，再启用纸面手势。");
      if (typeof global.GestureEngine !== "function" || typeof global.Hands !== "function") throw new Error("手势运行资源未加载，请刷新页面重试。");
      this.gestureStatus = "正在加载手势模型…"; this.emit();
      const gesture = new global.GestureEngine(video, {
        canvas: global.document.getElementById("gesture-overlay"), mapViewport: video,
        requestCamera: false, mirrored: false, objectFit: "contain", coordinateMapper: this.coordinateMapper(),
        locateFile: file => new URL(`vendor/mediapipe/${file}`, global.document.baseURI).href,
        onWordFocus: event => this.focusWord(event),
        onVoiceAnnotation: event => {
          if (!this.activeTracking()) return;
          if (event.event === "pause") this.pause();
          else if (event.event === "resume") this.play();
        },
        onSelection: event => {
          if (!this.activeTracking() || !this.gestureSpeechAllowed) return;
          this.clearWords();
          const selected = new Set(event.lines || []);
          const text = (this.activePage()?.map.lines || []).filter(line => selected.has(line.id)).map(line => line.text).join("\n");
          if (text) this.reader.onSelectRegion(text, [...selected]);
        },
        onHandUpdate: event => {
          if (this.gesture !== gesture || token !== this.gestureToken) return;
          this.gestureHands = Array.isArray(event.hands) ? event.hands.length : 0;
          this.gestureFPS = Number.isFinite(event.fps) ? Math.max(0, event.fps) : 0;
          this.bookReader?.setHandOccluded?.(this.gestureHands > 0);
          if (this.now() - (this.lastHandEmit ?? -Infinity) >= 100) { this.lastHandEmit = this.now(); this.emit(); }
        },
        onError: error => {
          if (this.gesture !== gesture || token !== this.gestureToken) return;
          this.setGesturesEnabled(false);
          this.gestureError = error?.message || String(error);
          this.gestureStatus = `手势识别失败：${this.gestureError}。请重新开启重试。`;
          this.emit();
        }
      });
      this.gesture = gesture;
      try {
        await gesture.init();
        if (token !== this.gestureToken || this.destroyed) { gesture.destroy(); return; }
        this.gesturesEnabled = true; this.gestureModelReady = true; this.syncGestureMap(); this.emit();
      } catch (error) {
        gesture.destroy();
        if (this.gesture === gesture) this.gesture = null;
        if (token !== this.gestureToken || this.destroyed) return;
        this.gesturesEnabled = false; this.gestureModelReady = false;
        this.gestureError = error?.message || String(error);
        this.gestureStatus = `手势启动失败：${this.gestureError}`; this.emit(); throw error;
      }
    }

    focusWord(event) {
      if (!this.activeTracking() || !this.gestureSpeechAllowed || !event?.word) return;
      if (!this.wordBuffer.some(word => word.lineId === event.lineId && word.word === event.word)) this.wordBuffer.push(event);
      if (this.wordTimer) return;
      const key = this.activePageKey;
      this.wordTimer = global.setTimeout(() => {
        this.wordTimer = null;
        const words = this.wordBuffer.splice(0);
        if (!this.activeTracking() || this.activePageKey !== key || !this.gestureSpeechAllowed || !words.length) return;
        if (words.length === 1) this.reader.onTapWord(words[0].word, words[0].lineId);
        else this.reader.onSlideWords(words.map(word => word.word).join(""), 220);
      }, 110);
    }
    clearWords() { global.clearTimeout(this.wordTimer); this.wordTimer = null; this.wordBuffer = []; }
    play() { this.gestureSpeechAllowed = true; this.syncGestureMap(); const s = this.reader.getState(); s.status === "paused" ? this.reader.resume() : this.reader.play(); this.emit(); }
    pause() { this.gestureSpeechAllowed = false; this.clearWords(); this.reader.pause(true); this.syncGestureMap(); this.emit(); }
    prev() { this.gestureSpeechAllowed = false; this.clearWords(); this.reader.prevLine(); }
    next() { this.gestureSpeechAllowed = false; this.clearWords(); this.reader.nextLine(); }
    setSpeed(rate) { this.reader.setSpeed(Number(rate)); }
    readLine(id) { const index = this.reader.lines.findIndex(line => line.id === id); if (index >= 0) { this.gestureSpeechAllowed = false; this.clearWords(); this.reader.play(index); } }
    saveHighlight() { this.reader.saveHighlight(); }
    destroy() {
      if (this.destroyed) return;
      this.reset(); this.setGesturesEnabled(false); this.destroyed = true;
      global.clearInterval(this.trackingTimer);
      this.events.removeEventListener("bookreader:captured", this.onCaptured);
      this.events.removeEventListener("keydown", this.onKeys);
      global.document?.removeEventListener("visibilitychange", this.onBackground);
      this.removeTracking?.(); this.removeFrames?.(); this.removeReadingListener?.(); this.reader.destroy?.(); this.listeners.clear();
    }
  }
  FeelyReaderController.project = project;
  FeelyReaderController.normalizeMap = normalizeMap;
  global.FeelyReaderController = FeelyReaderController;
})(typeof window !== "undefined" ? window : globalThis);
