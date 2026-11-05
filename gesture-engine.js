(function attachGestureEngine(global) {
  "use strict";

  /**
   * Browser-only gesture engine for MediaPipe Hands and OCR rectified maps.
   *
   * Usage:
   *   const engine = new GestureEngine(video, { canvas, mapViewport });
   *   engine.onWordFocus = (event) => DModule.handle(event);
   *   engine.onVoiceAnnotation = (event) => speech.queue(event.text);
   *   engine.setTextMap(json);
   *   await engine.init();
   *   engine.destroy();
   *
   * The constructor accepts either a video element or an overlay canvas.
   * When a canvas is passed as the first argument, options.video is required.
   * The engine never creates or queries UI DOM nodes.
   */
  const LINE_SWITCH_DEBOUNCE_MS = 250;
  const LINE_SWITCH_X_EPSILON = 2;
  const TWO_HAND_HOLD_MS = 420;
  const POSTURE_FILTER_TTL = 650;
  const FINGER_KEYS = ["thumb", "index", "middle", "ring", "pinky"];
  const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17]
  ];

  const STATE_LABELS = {
    idle: { label: "待机", code: "IDLE" },
    pointing: { label: "词级点读", code: "WORD_TRACK" },
    switching_line: { label: "换行中", code: "LINE_SWITCH" },
    takeover: { label: "漏读接管", code: "LINE_TAKEOVER" },
    selecting: { label: "框选中", code: "SELECTION" },
    paused: { label: "已暂停", code: "PAUSED" }
  };

  const PAUSE_REASONS = {
    five: "五指张开已保持 500ms",
    noHand: "连续 1 秒未检测到手",
    occlusion: "中心画面亮度骤降或被遮挡",
    manual: "手动暂停"
  };

  function noop() {}

  function toPositiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function readSizePair(value) {
    if (Array.isArray(value) && value.length >= 2) {
      return [Number(value[0]), Number(value[1])];
    }
    if (value && typeof value === "object") {
      return [
        Number(value.width ?? value.w),
        Number(value.height ?? value.h)
      ];
    }
    return [NaN, NaN];
  }

  function segmentLine(text) {
    if (typeof Intl?.Segmenter === "function") {
      const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
      return Array.from(segmenter.segment(text), (part) => ({
        text: part.segment,
        characterCount: Array.from(part.segment).length
      }));
    }
    return Array.from(text).map((character) => ({
      text: character,
      characterCount: 1
    }));
  }

  function angleAt(a, b, c) {
    const ab = { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
    const cb = { x: c.x - b.x, y: c.y - b.y, z: (c.z || 0) - (b.z || 0) };
    const abLength = Math.hypot(ab.x, ab.y, ab.z);
    const cbLength = Math.hypot(cb.x, cb.y, cb.z);
    if (!abLength || !cbLength) return 0;
    const cosine = (ab.x * cb.x + ab.y * cb.y + ab.z * cb.z) / (abLength * cbLength);
    return Math.acos(Math.min(1, Math.max(-1, cosine))) * 180 / Math.PI;
  }

  function analyzeFingers(landmarks) {
    const fingers = {
      thumb: angleAt(landmarks[2], landmarks[3], landmarks[4]) > 142,
      index: angleAt(landmarks[5], landmarks[6], landmarks[8]) > 150,
      middle: angleAt(landmarks[9], landmarks[10], landmarks[12]) > 150,
      ring: angleAt(landmarks[13], landmarks[14], landmarks[16]) > 150,
      pinky: angleAt(landmarks[17], landmarks[18], landmarks[20]) > 150
    };
    fingers.count = Object.values(fingers).filter(Boolean).length;
    return fingers;
  }

  function isPointingIndex(hand) {
    return Boolean(
      hand &&
      hand.fingers.index &&
      !hand.fingers.middle &&
      !hand.fingers.ring &&
      !hand.fingers.pinky
    );
  }

  function landmarkCenter(landmarks) {
    const ids = [0, 5, 9, 13, 17];
    return ids.reduce((center, id) => ({
      x: center.x + landmarks[id].x / ids.length,
      y: center.y + landmarks[id].y / ids.length,
      z: center.z + (landmarks[id].z || 0) / ids.length
    }), { x: 0, y: 0, z: 0 });
  }

  function handCenterDistance(a, b) {
    const centerA = landmarkCenter(a.landmarks);
    const centerB = landmarkCenter(b.landmarks);
    return Math.hypot(
      centerA.x - centerB.x,
      centerA.y - centerB.y,
      (centerA.z - centerB.z) * 0.45
    );
  }

  function normalizeSelectionRect(a, b) {
    if (!a || !b) return null;
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y)
    };
  }

  class GestureEngine {
    constructor(videoOrCanvas, options = {}) {
      const tagName = videoOrCanvas?.tagName?.toLowerCase?.();
      if (tagName === "video") {
        this.video = videoOrCanvas;
        this.canvas = options.canvas || null;
      } else if (tagName === "canvas") {
        this.canvas = videoOrCanvas;
        this.video = options.video || null;
      } else {
        throw new TypeError("GestureEngine 需要一个 HTMLVideoElement 或 HTMLCanvasElement");
      }

      if (!this.video) {
        throw new TypeError("只传入 canvas 时必须通过 options.video 提供视频元素");
      }

      this.ctx = this.canvas?.getContext?.("2d") || null;
      this.mapViewport = options.mapViewport || null;
      this.requestCamera = options.requestCamera !== false;
      this.ownsCameraStream = false;
      this.stream = null;
      this.handsModel = null;
      this.initialized = false;
      this.destroyed = false;
      this.detectBusy = false;
      this.detectionFrame = 0;
      this.renderFrame = 0;
      this.resizeHandler = null;
      this.fps = 0;
      this.isMirrored = options.mirrored ?? true;
      this.audioContext = null;
      this.soundEnabled = options.soundEnabled !== false;

      this.textMap = null;
      this.lineMap = [];
      this.lineById = new Map();
      this.wordMap = [];
      this.displayScale = 1;
      this.displayOffsetX = 0;
      this.displayOffsetY = 0;
      this.viewportRect = null;

      this.activeLineId = null;
      this.activeWord = null;
      this.hoverWord = null;
      this.lineCandidate = null;
      this.forcedLineId = null;
      this.takeoverOriginY = null;
      this.takeoverRearmRequired = false;
      this.lineEndSignaledLineId = null;
      this.state = "idle";
      this.pauseReason = "";
      this.lastPointerSeenAt = 0;
      this.pointerTrace = {
        x: 0,
        y: 0,
        at: 0,
        velocityX: 0,
        velocityY: 0,
        speed: 0,
        lineId: null,
        wordIndex: null
      };

      this.hands = [];
      this.motionHistories = new Map();
      this.postureFilters = new Map();
      this.pointerKey = null;
      this.bookHand = null;
      this.noHandSince = null;
      this.fiveOpenSince = null;
      this.lastTwoHandSeenAt = 0;
      this.pausedLastPointer = null;
      this.pausedMotion = 0;
      this.pausedMotionStartedAt = 0;
      this.pausedLastMoveAt = 0;
      this.selection = {
        active: false,
        tipA: null,
        tipB: null,
        startedAt: 0,
        lastSeenAt: 0,
        cooldownUntil: 0
      };
      this.twoHandCandidate = { since: 0, lastSeenAt: 0, tips: null };
      this.lastSelection = null;

      this.wordFocusBridge = (data) => {
        if (typeof this.onWordFocus === "function") this.onWordFocus(data);
      };
      this.voiceAnnotationBridge = (data) => {
        if (typeof this.onVoiceAnnotation === "function") this.onVoiceAnnotation(data);
      };
      if (typeof global.onWordFocus !== "function") {
        global.onWordFocus = this.wordFocusBridge;
      }
      if (typeof global.onVoiceAnnotation !== "function") {
        global.onVoiceAnnotation = this.voiceAnnotationBridge;
      }

      this.onWordFocus = options.onWordFocus || ((data) => {
        console.info("[GestureEngine:onWordFocus]", JSON.stringify(data));
      });
      this.onVoiceAnnotation = options.onVoiceAnnotation || ((data) => {
        console.info("[GestureEngine:onVoiceAnnotation]", JSON.stringify(data));
      });
      this.onStateChange = options.onStateChange || noop;
      this.onActiveWord = options.onActiveWord || noop;
      this.onHoverWord = options.onHoverWord || noop;
      this.onHandUpdate = options.onHandUpdate || noop;
      this.onCameraState = options.onCameraState || noop;
      this.onSelection = options.onSelection || noop;
      this.onHistory = options.onHistory || noop;
      this.onError = options.onError || ((error) => console.error("[GestureEngine]", error));
      this.onLayout = options.onLayout || noop;
      this.onMapLoaded = options.onMapLoaded || noop;

      this.locateFile = options.locateFile || ((file) => file);
      this.resizeHandler = () => {
        this.resizeCanvas();
        this.refreshLayout();
      };
      global.addEventListener?.("resize", this.resizeHandler);
      this.resizeCanvas();
    }

    async init(options = {}) {
      const withMediaPipe = options.mediaPipe !== false;
      if (this.initialized) {
        if (withMediaPipe && !this.handsModel) {
          await this.initializeHands();
        }
        return this;
      }
      if (this.destroyed) throw new Error("GestureEngine 已销毁");
      try {
        this.initAudio();
        if (withMediaPipe) {
          if (this.requestCamera && !this.video.srcObject) {
            await this.startCamera();
          } else {
            const settings = this.video.srcObject?.getVideoTracks?.()[0]?.getSettings?.() || {};
            if (typeof settings.facingMode === "string") {
              this.isMirrored = settings.facingMode === "user";
            }
          }
          await this.initializeHands();
        }
        this.initialized = true;
        this.destroyed = false;
        this.detectionFrame = requestAnimationFrame(() => this.detectLoop());
        this.renderFrame = requestAnimationFrame((time) => this.renderLoop(time));
        this.setState("idle", "手势引擎已启动。");
        return this;
      } catch (error) {
        this.handleError(error);
        throw error;
      }
    }

    initAudio() {
      if (!this.audioContext) {
        const AudioContextClass = global.AudioContext || global.webkitAudioContext;
        if (AudioContextClass) this.audioContext = new AudioContextClass();
      }
      if (this.audioContext?.state === "suspended") {
        this.audioContext.resume().catch(() => {});
      }
    }

    setSoundEnabled(enabled) {
      this.soundEnabled = Boolean(enabled);
      if (this.soundEnabled) this.initAudio();
    }

    playTone(frequency, duration, type = "sine", endFrequency = null) {
      if (!this.audioContext || !this.soundEnabled) return;
      const now = this.audioContext.currentTime;
      const oscillator = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, now);
      if (endFrequency) {
        oscillator.frequency.exponentialRampToValueAtTime(
          endFrequency,
          now + duration
        );
      }
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.1, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.00001, now + duration);
      oscillator.connect(gain);
      gain.connect(this.audioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + duration + 0.02);
    }

    playSoundStart() {
      this.playTone(800, 0.1, "sine");
    }

    playSoundErrorDown() {
      this.playTone(300, 0.2, "triangle");
    }

    playSoundErrorUp() {
      this.playTone(400, 0.2, "triangle");
    }

    playSoundSkip() {
      this.playTone(600, 0.15, "sine", 900);
    }

    playSoundSelect() {
      this.playTone(500, 0.08, "sine");
      setTimeout(() => this.playTone(500, 0.08, "sine"), 100);
    }

    playSoundPause() {
      this.playTone(200, 0.3, "sine");
    }

    playSoundLineEnd() {
      this.playTone(1120, 0.075, "sine");
    }

    async startCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("当前环境不支持 getUserMedia");
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 }
        }
      });
      this.ownsCameraStream = true;
      this.video.srcObject = this.stream;
      this.video.muted = true;
      this.video.playsInline = true;
      await this.video.play();
      const settings = this.stream.getVideoTracks()[0]?.getSettings?.() || {};
      this.isMirrored = typeof settings.facingMode === "string"
        ? settings.facingMode === "user"
        : this.isMirrored;
      this.onCameraState({
        active: true,
        mirrored: this.isMirrored,
        stream: this.stream
      });
      return this.stream;
    }

    async initializeHands() {
      if (typeof global.Hands !== "function") {
        throw new Error("MediaPipe Hands 未加载");
      }
      this.handsModel = new global.Hands({ locateFile: this.locateFile });
      this.handsModel.setOptions({
        maxNumHands: 2,
        modelComplexity: 0,
        minDetectionConfidence: 0.42,
        minTrackingConfidence: 0.35
      });
      this.handsModel.onResults((results) => this.handleHandResults(results));
    }

    setCallbacks(callbacks = {}) {
      const keys = [
        "onWordFocus", "onVoiceAnnotation", "onStateChange", "onActiveWord",
        "onHoverWord", "onHandUpdate", "onCameraState", "onSelection",
        "onHistory", "onError", "onLayout", "onMapLoaded"
      ];
      keys.forEach((key) => {
        if (typeof callbacks[key] === "function") this[key] = callbacks[key];
      });
      return this;
    }

    setViewportElement(element) {
      this.mapViewport = element || null;
      this.refreshLayout();
      return this;
    }

    setViewportRect(rect) {
      this.viewportRect = rect
        ? {
            left: Number(rect.left),
            top: Number(rect.top),
            width: Number(rect.width),
            height: Number(rect.height)
          }
        : null;
      this.mapViewport = null;
      this.refreshLayout();
      return this;
    }

    refreshLayout() {
      if (!this.textMap) return null;
      const rect = this.viewportRect || this.mapViewport?.getBoundingClientRect?.();
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
      this.displayScale = Math.min(
        rect.width / this.textMap.sourceWidth,
        rect.height / this.textMap.sourceHeight
      );
      this.displayOffsetX = (rect.width - this.textMap.sourceWidth * this.displayScale) / 2;
      this.displayOffsetY = (rect.height - this.textMap.sourceHeight * this.displayScale) / 2;
      const layout = this.getLayout();
      this.onLayout(layout);
      return layout;
    }

    setTextMap(rawData, fileName = "") {
      const parsed = rawData && typeof rawData === "string"
        ? JSON.parse(rawData)
        : rawData;
      if (!parsed || !Array.isArray(parsed.lines) || !parsed.lines.length) {
        throw new Error("JSON 必须包含非空的 lines 数组");
      }

      const usedIds = new Set();
      const lines = parsed.lines.map((rawLine, order) => {
        if (!rawLine || typeof rawLine !== "object") {
          throw new Error(`lines[${order}] 必须是对象`);
        }
        if (typeof rawLine.text !== "string" || !rawLine.text.length) {
          throw new Error(`lines[${order}].text 为空`);
        }
        if (!Array.isArray(rawLine.bbox_rectified) || rawLine.bbox_rectified.length !== 4) {
          throw new Error(`lines[${order}].bbox_rectified 必须是 [x,y,w,h]`);
        }
        const bbox = rawLine.bbox_rectified.map(Number);
        if (!bbox.every(Number.isFinite) || bbox[2] <= 0 || bbox[3] <= 0) {
          throw new Error(`lines[${order}].bbox_rectified 数值无效`);
        }
        let id = rawLine.id == null ? "" : String(rawLine.id);
        if (!id) throw new Error(`lines[${order}].id 为空`);
        if (usedIds.has(id)) {
          let suffix = 2;
          while (usedIds.has(`${id}#${suffix}`)) suffix += 1;
          id = `${id}#${suffix}`;
        }
        usedIds.add(id);
        return {
          id,
          text: rawLine.text,
          x: bbox[0],
          y: bbox[1],
          width: bbox[2],
          height: bbox[3],
          sourceOrder: order,
          readingOrder: Number.isFinite(Number(rawLine.reading_order))
            ? Number(rawLine.reading_order)
            : order + 1,
          words: []
        };
      });

      lines.sort((a, b) =>
        a.readingOrder - b.readingOrder ||
        a.y - b.y ||
        a.x - b.x ||
        a.sourceOrder - b.sourceOrder
      );

      lines.forEach((line, index) => {
        line.order = index + 1;
        line.centerY = line.y + line.height / 2;
        line.centerX = line.x + line.width / 2;
        line.characterCount = Math.max(1, Array.from(line.text).length);
        line.characterWidth = line.width / line.characterCount;
        line.touchTop = line.centerY - line.height / 2;
        line.touchBottom = line.centerY + line.height / 2;
      });

      const [rectifiedWidth, rectifiedHeight] = readSizePair(parsed.rectified_size);
      const [sourceWidth, sourceHeight] = readSizePair(parsed.source_size);
      const mapWidth = [
        rectifiedWidth,
        parsed.image_width,
        parsed.imageWidth,
        parsed.canvas_width,
        parsed.canvasWidth,
        parsed.width,
        sourceWidth
      ].map(toPositiveNumber).find((value) => value !== null) ||
        Math.max(...lines.map((line) => line.x + line.width));
      const mapHeight = [
        rectifiedHeight,
        parsed.image_height,
        parsed.imageHeight,
        parsed.canvas_height,
        parsed.canvasHeight,
        parsed.height,
        sourceHeight
      ].map(toPositiveNumber).find((value) => value !== null) ||
        Math.max(...lines.map((line) => line.y + line.height));

      const words = [];
      lines.forEach((line) => {
        let characterCursor = 0;
        let localIndex = 0;
        segmentLine(line.text).forEach((segment) => {
          if (segment.text.trim()) {
            const word = {
              id: `${line.id}:${localIndex}`,
              text: segment.text,
              fullLine: line.text,
              lineId: line.id,
              lineOrder: line.order,
              localIndex,
              globalIndex: words.length,
              x: line.x + characterCursor * line.characterWidth,
              y: line.y,
              width: segment.characterCount * line.characterWidth,
              height: line.height,
              line
            };
            line.words.push(word);
            words.push(word);
            localIndex += 1;
          }
          characterCursor += segment.characterCount;
        });

        if (!line.words.length) {
          Array.from(line.text).forEach((character) => {
            const word = {
              id: `${line.id}:${localIndex}`,
              text: character,
              fullLine: line.text,
              lineId: line.id,
              lineOrder: line.order,
              localIndex,
              globalIndex: words.length,
              x: line.x + characterCursor * line.characterWidth,
              y: line.y,
              width: line.characterWidth,
              height: line.height,
              line
            };
            line.words.push(word);
            words.push(word);
            localIndex += 1;
            characterCursor += 1;
          });
        }
      });

      this.textMap = {
        fileName: fileName || parsed.frame_id || "",
        sourceWidth: mapWidth,
        sourceHeight: mapHeight,
        lines,
        words
      };
      this.lineMap = lines;
      this.lineById = new Map(lines.map((line) => [line.id, line]));
      this.wordMap = words;
      this.resetTrackingState();
      this.refreshLayout();
      this.onMapLoaded(this.getTextMap());
      this.setState("idle", "文字地图已加载。");
      return this.getTextMap();
    }

    getTextMap() {
      if (!this.textMap) return null;
      return {
        fileName: this.textMap.fileName,
        sourceWidth: this.textMap.sourceWidth,
        sourceHeight: this.textMap.sourceHeight,
        lineCount: this.textMap.lines.length,
        wordCount: this.textMap.words.length,
        lines: this.textMap.lines,
        words: this.textMap.words
      };
    }

    getLayout() {
      const rect = this.viewportRect || this.mapViewport?.getBoundingClientRect?.();
      return {
        left: rect?.left ?? 0,
        top: rect?.top ?? 0,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        scale: this.displayScale,
        offsetX: this.displayOffsetX,
        offsetY: this.displayOffsetY
      };
    }

    resetTrackingState() {
      this.activeLineId = null;
      this.activeWord = null;
      this.hoverWord = null;
      this.lineCandidate = null;
      this.forcedLineId = null;
      this.takeoverOriginY = null;
      this.takeoverRearmRequired = false;
      this.lineEndSignaledLineId = null;
      this.lastPointerSeenAt = 0;
      this.pointerTrace = {
        x: 0,
        y: 0,
        at: 0,
        velocityX: 0,
        velocityY: 0,
        speed: 0,
        lineId: null,
        wordIndex: null
      };
      this.onActiveWord(null);
      this.onHoverWord(null);
    }

    setState(nextState, hint = "") {
      this.state = nextState;
      const meta = STATE_LABELS[nextState] || STATE_LABELS.idle;
      this.onStateChange({
        state: nextState,
        label: meta.label,
        code: meta.code,
        hint
      });
    }

    screenToMap(x, y) {
      const rect = this.viewportRect || this.mapViewport?.getBoundingClientRect?.();
      if (!rect || !this.displayScale) return { x: NaN, y: NaN };
      return {
        x: (x - rect.left - this.displayOffsetX) / this.displayScale,
        y: (y - rect.top - this.displayOffsetY) / this.displayScale
      };
    }

    mapToScreen(x, y) {
      const rect = this.viewportRect || this.mapViewport?.getBoundingClientRect?.();
      if (!rect) return { x: NaN, y: NaN };
      return {
        x: rect.left + this.displayOffsetX + x * this.displayScale,
        y: rect.top + this.displayOffsetY + y * this.displayScale
      };
    }

    findLineAtY(y) {
      let bestLine = null;
      let bestDistance = Infinity;
      for (const line of this.lineMap) {
        if (y < line.touchTop || y > line.touchBottom) continue;
        const distance = Math.abs(y - line.centerY);
        if (distance < bestDistance) {
          bestLine = line;
          bestDistance = distance;
        }
      }
      return bestLine;
    }

    findWordByX(line, x) {
      if (!line?.words.length) return null;
      if (x <= line.x) return line.words[0];
      if (x >= line.x + line.width) return line.words[line.words.length - 1];
      return line.words.reduce((best, word) => {
        const distance = Math.abs(x - (word.x + word.width / 2));
        const bestDistance = Math.abs(x - (best.x + best.width / 2));
        return distance < bestDistance ? word : best;
      }, line.words[0]);
    }

    pathWithinLine(line, startIndex, endIndex) {
      if (!line || startIndex == null || endIndex == null || startIndex === endIndex) return [];
      if (endIndex > startIndex) return line.words.slice(startIndex + 1, endIndex + 1);
      return line.words.slice(endIndex, startIndex).reverse();
    }

    emitWordFocus(event, word) {
      if (!word?.line) return;
      const data = {
        event,
        lineId: String(word.lineId),
        word: word.text,
        fullLine: word.line.text,
        timestamp: Math.floor(Date.now() / 1000)
      };
      try {
        if (typeof this.onWordFocus === "function") this.onWordFocus(data);
        if (
          typeof global.onWordFocus === "function" &&
          global.onWordFocus !== this.wordFocusBridge
        ) {
          global.onWordFocus(data);
        }
      } catch (error) {
        this.handleError(error);
      }
      const voiceData = {
        ...data,
        text: data.word,
        utterance: data.word
      };
      try {
        if (typeof this.onVoiceAnnotation === "function") this.onVoiceAnnotation(voiceData);
        if (
          typeof global.onVoiceAnnotation === "function" &&
          global.onVoiceAnnotation !== this.voiceAnnotationBridge
        ) {
          global.onVoiceAnnotation(voiceData);
        }
      } catch (error) {
        this.handleError(error);
      }
    }

    emitVoice(event, payload = {}) {
      const data = {
        event,
        lineId: payload.lineId == null ? "" : String(payload.lineId),
        text: payload.text || "",
        fullLine: payload.fullLine || "",
        timestamp: Math.floor(Date.now() / 1000)
      };
      try {
        if (typeof this.onVoiceAnnotation === "function") this.onVoiceAnnotation(data);
        if (
          typeof global.onVoiceAnnotation === "function" &&
          global.onVoiceAnnotation !== this.voiceAnnotationBridge
        ) {
          global.onVoiceAnnotation(data);
        }
      } catch (error) {
        this.handleError(error);
      }
    }

    publishTrajectory(words, event = "focus") {
      if (!words.length) return false;
      const finalWord = words[words.length - 1];
      words.forEach((word) => this.emitWordFocus(event, word));
      this.hoverWord = finalWord;
      this.onHoverWord(finalWord);
      this.activeWord = finalWord;
      this.onActiveWord(finalWord);
      return true;
    }

    updateLineEnd(trace, lineId, unlockTakeover = false) {
      const line = this.lineById.get(lineId);
      if (!line || !trace) return false;
      const beyondRight = trace.x > line.x + line.width;
      const movingRight = trace.dx > 0 || this.pointerTrace.velocityX > 0;
      if (beyondRight && movingRight && this.lineEndSignaledLineId !== lineId) {
        this.lineEndSignaledLineId = lineId;
        this.playSoundLineEnd();
        this.emitVoice("line_end", {
          lineId,
          text: "",
          fullLine: line.text
        });
      }
      if (
        trace.x < line.x + line.width - line.characterWidth &&
        this.lineEndSignaledLineId === lineId
      ) {
        this.lineEndSignaledLineId = null;
      }
      return unlockTakeover && beyondRight && movingRight;
    }

    updatePointerTrace(screenX, screenY, now) {
      const point = this.screenToMap(screenX, screenY);
      const previous = { ...this.pointerTrace };
      const dt = previous.at && now > previous.at ? now - previous.at : 0;
      const dx = previous.at ? point.x - previous.x : 0;
      const dy = previous.at ? point.y - previous.y : 0;
      const physicalLine = this.findLineAtY(point.y);
      const activeLine = this.activeLineId ? this.lineById.get(this.activeLineId) : null;
      let line = activeLine || physicalLine;
      let switchingIntent = false;

      if (this.forcedLineId) {
        line = this.lineById.get(this.forcedLineId) || line;
      } else if (activeLine && physicalLine && physicalLine.id !== activeLine.id) {
        line = physicalLine;
        switchingIntent = true;
      }

      if (dt) {
        this.pointerTrace.velocityX =
          this.pointerTrace.velocityX * 0.55 + (dx / dt) * 1000 * 0.45;
        this.pointerTrace.velocityY =
          this.pointerTrace.velocityY * 0.55 + (dy / dt) * 1000 * 0.45;
        this.pointerTrace.speed = Math.hypot(
          this.pointerTrace.velocityX,
          this.pointerTrace.velocityY
        );
      } else {
        this.pointerTrace.velocityX = 0;
        this.pointerTrace.velocityY = 0;
        this.pointerTrace.speed = 0;
      }

      const word = line ? this.findWordByX(line, point.x) : null;
      const previousIndex = previous.lineId === line?.id ? previous.wordIndex : null;
      const pathWords = word
        ? this.pathWithinLine(line, previousIndex, word.localIndex)
        : [];

      this.pointerTrace.x = point.x;
      this.pointerTrace.y = point.y;
      this.pointerTrace.at = now;
      this.pointerTrace.lineId = line?.id ?? null;
      this.pointerTrace.wordIndex = word?.localIndex ?? null;

      return {
        screenX,
        screenY,
        x: point.x,
        y: point.y,
        dx,
        dy,
        speed: this.pointerTrace.speed,
        physicalLine,
        line,
        lineId: line?.id ?? null,
        word,
        pathWords,
        switchingIntent,
        lineChanged: Boolean(
          previous.lineId && line && previous.lineId !== line.id
        )
      };
    }

    handlePointerWord(trace, now) {
      if (!this.initialized || !this.textMap || this.state === "paused" || this.state === "selecting") {
        return;
      }
      if (!trace?.word || !trace.line) {
        this.hoverWord = null;
        this.onHoverWord(null);
        const frameMs = this.fps > 0 ? 1000 / this.fps : LINE_SWITCH_DEBOUNCE_MS;
        const stickyMs = Math.max(LINE_SWITCH_DEBOUNCE_MS, frameMs * 3);
        if (this.lastPointerSeenAt && now - this.lastPointerSeenAt <= stickyMs) return;
        this.activeWord = null;
        this.onActiveWord(null);
        this.lineCandidate = null;
        return;
      }

      this.lastPointerSeenAt = now;
      const traceLine = trace.line;

      if (this.takeoverRearmRequired) {
        if (Math.abs(trace.dx) + Math.abs(trace.dy) === 0) return;
        this.takeoverRearmRequired = false;
      }

      if (this.forcedLineId) {
        const forcedLine = this.lineById.get(this.forcedLineId);
        if (!forcedLine) {
          this.forcedLineId = null;
          this.takeoverOriginY = null;
          return;
        }
        const maxLineHeight = Math.max(...this.lineMap.map((line) => line.height));
        if (Math.abs(trace.y - this.takeoverOriginY) > maxLineHeight * 3) {
          this.forcedLineId = null;
          this.takeoverOriginY = null;
          this.activeLineId = null;
          this.lineCandidate = null;
          this.onHistory({
            type: "takeover_abandon",
            title: "放弃接管",
            detail: "手指纵向移动超过三行高度",
            tone: "warn"
          });
          const fresh = this.updatePointerTrace(trace.screenX, trace.screenY, now);
          this.handlePointerWord(fresh, now);
          return;
        }

        const forcedWord = this.findWordByX(forcedLine, trace.x);
        if (!forcedWord) return;
        this.hoverWord = forcedWord;
        this.onHoverWord(forcedWord);
        const previousIndex = this.pointerTrace.lineId === this.forcedLineId
          ? this.pointerTrace.wordIndex
          : null;
        const path = this.pathWithinLine(forcedLine, previousIndex, forcedWord.localIndex);
        this.publishTrajectory(path);
        const reachedEnd = this.updateLineEnd(
          { ...trace, line: forcedLine, lineId: forcedLine.id },
          forcedLine.id,
          true
        );
        if (reachedEnd) {
          const completedLine = forcedLine.id;
          this.forcedLineId = null;
          this.takeoverOriginY = null;
          this.activeLineId = null;
          this.lineCandidate = null;
          this.pointerTrace.lineId = null;
          this.pointerTrace.wordIndex = null;
          this.takeoverRearmRequired = true;
          this.setState("pointing", "接管行已到末尾，继续移动以恢复正常追踪。");
          this.onHistory({
            type: "takeover_complete",
            title: "接管完成",
            detail: completedLine,
            tone: "success"
          });
        } else {
          this.setState("takeover", "仅按 X 坐标读取接管行。");
        }
        return;
      }

      if (this.activeLineId === null) {
        if (!this.lineCandidate || this.lineCandidate.lineId !== traceLine.id) {
          this.lineCandidate = {
            lineId: traceLine.id,
            since: now,
            lastSeenAt: now,
            word: trace.word,
            xMin: trace.screenX,
            xMax: trace.screenX,
            words: []
          };
        } else {
          this.lineCandidate.lastSeenAt = now;
          this.lineCandidate.word = trace.word;
          this.lineCandidate.xMin = Math.min(this.lineCandidate.xMin, trace.screenX);
          this.lineCandidate.xMax = Math.max(this.lineCandidate.xMax, trace.screenX);
        }
        this.setState("switching_line", "正在建立初始行锁定。");
        if (now - this.lineCandidate.since >= LINE_SWITCH_DEBOUNCE_MS) {
          this.activeLineId = traceLine.id;
          this.publishTrajectory([trace.word]);
          this.lineCandidate = null;
          this.playSoundStart();
          this.setState("pointing", "已锁定当前行。");
        }
        return;
      }

      if (traceLine.id === this.activeLineId) {
        this.lineCandidate = null;
        this.hoverWord = trace.word;
        this.onHoverWord(trace.word);
        this.publishTrajectory(trace.pathWords);
        this.updateLineEnd(trace, traceLine.id, false);
        this.setState("pointing", "按 X 坐标连续追踪。");
        return;
      }

      if (!this.lineCandidate || this.lineCandidate.lineId !== traceLine.id) {
        this.lineCandidate = {
          lineId: traceLine.id,
          since: now,
          lastSeenAt: now,
          word: trace.word,
          xMin: trace.screenX,
          xMax: trace.screenX,
          words: []
        };
      } else {
        this.lineCandidate.lastSeenAt = now;
        this.lineCandidate.word = trace.word;
        this.lineCandidate.xMin = Math.min(this.lineCandidate.xMin, trace.screenX);
        this.lineCandidate.xMax = Math.max(this.lineCandidate.xMax, trace.screenX);
      }
      this.lineCandidate.words = this.lineCandidate.words.concat(trace.pathWords);
      this.hoverWord = trace.word;
      this.onHoverWord(trace.word);

      const dwellElapsed = now - this.lineCandidate.since;
      const horizontalTravel = this.lineCandidate.xMax - this.lineCandidate.xMin;
      this.setState(
        "switching_line",
        `换行缓冲：${Math.round(dwellElapsed)} / ${LINE_SWITCH_DEBOUNCE_MS}ms，横向 ${Math.round(horizontalTravel)}px`
      );
      if (
        dwellElapsed < LINE_SWITCH_DEBOUNCE_MS ||
        horizontalTravel <= LINE_SWITCH_X_EPSILON
      ) {
        return;
      }
      this.commitLineTransition(
        this.lineCandidate.word || trace.word,
        this.lineCandidate.words,
        trace
      );
    }

    commitLineTransition(targetWord, trajectoryWords, trace) {
      const previousLine = this.lineById.get(this.activeLineId);
      const targetLine = this.lineById.get(targetWord.lineId);
      if (!previousLine || !targetLine) return;
      const delta = targetLine.order - previousLine.order;
      this.lineCandidate = null;
      this.lineEndSignaledLineId = null;

      if (delta === 1 || delta === -1) {
        this.activeLineId = targetLine.id;
        if (delta === -1) this.playSoundErrorUp();
        this.publishTrajectory(
          trajectoryWords.length ? trajectoryWords : [targetWord]
        );
        this.setState("pointing", delta === 1 ? "已进入下一行。" : "已向上回读一行。");
        this.onHistory({
          type: delta === 1 ? "next_line" : "read_up",
          title: delta === 1 ? "进入下一行" : "向上回读",
          detail: targetLine.id,
          tone: "success"
        });
        return;
      }

      if (delta === 2) {
        const forcedLine = this.lineMap[previousLine.order];
        const forcedWord = forcedLine ? this.findWordByX(forcedLine, trace.x) : null;
        if (!forcedLine || !forcedWord) return;
        this.forcedLineId = forcedLine.id;
        this.takeoverOriginY = trace.y;
        this.activeLineId = forcedLine.id;
        this.lineCandidate = null;
        this.lineEndSignaledLineId = null;
        this.pointerTrace.lineId = forcedLine.id;
        this.pointerTrace.wordIndex = forcedWord.localIndex;
        this.hoverWord = forcedWord;
        this.onHoverWord(forcedWord);
        this.activeWord = forcedWord;
        this.onActiveWord(forcedWord);
        this.playSoundErrorDown();
        this.emitWordFocus("missed_line", forcedWord);
        this.setState("takeover", `漏读接管：${forcedLine.id}，仅使用 X 坐标。`);
        this.onHistory({
          type: "missed_line",
          title: "漏读接管",
          detail: forcedLine.id,
          tone: "warn"
        });
        return;
      }

      if (Math.abs(delta) >= 3 || delta <= -2) {
        this.forcedLineId = null;
        this.takeoverOriginY = null;
        this.activeLineId = targetLine.id;
        this.activeWord = targetWord;
        this.onActiveWord(targetWord);
        this.playSoundSkip();
        this.emitWordFocus("skip_line", targetWord);
        this.setState("pointing", `跳读：${previousLine.id} → ${targetLine.id}`);
        this.onHistory({
          type: "skip_line",
          title: "跳读",
          detail: `${previousLine.id} → ${targetLine.id}`,
          tone: "error"
        });
      }
    }

    resizeCanvas() {
      if (!this.canvas || !this.ctx) return;
      const rect = this.canvas.getBoundingClientRect();
      const width = rect.width || this.canvas.clientWidth || this.canvas.width;
      const height = rect.height || this.canvas.clientHeight || this.canvas.height;
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      this.canvas.width = Math.max(1, Math.round(width * dpr));
      this.canvas.height = Math.max(1, Math.round(height * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.canvasCssSize = { width, height };
    }

    getCameraRenderRect() {
      const host = this.canvas || this.video;
      const rect = host.getBoundingClientRect();
      const vw = this.video.videoWidth || 1280;
      const vh = this.video.videoHeight || 720;
      const scale = Math.max(rect.width / vw, rect.height / vh);
      return {
        left: rect.left + (rect.width - vw * scale) / 2,
        top: rect.top + (rect.height - vh * scale) / 2,
        width: vw * scale,
        height: vh * scale
      };
    }

    cameraPointToScreen(x, y) {
      const rect = this.getCameraRenderRect();
      let screenX = rect.left + x * rect.width;
      if (this.isMirrored) {
        screenX = rect.left + rect.width - x * rect.width;
      }
      return {
        x: screenX,
        y: rect.top + y * rect.height
      };
    }

    makeHand(landmarks, label, sourceIndex, confidence) {
      return {
        landmarks,
        points: landmarks.map((point) => this.cameraPointToScreen(point.x, point.y)),
        tip: this.cameraPointToScreen(landmarks[8].x, landmarks[8].y),
        fingers: analyzeFingers(landmarks),
        key: label || `Hand-${sourceIndex}`,
        sourceIndex,
        confidence,
        motion: 0,
        role: "unknown"
      };
    }

    deduplicateHands(hands) {
      const sorted = [...hands].sort((a, b) => b.confidence - a.confidence);
      const unique = [];
      sorted.forEach((hand) => {
        const duplicate = unique.some((existing) =>
          handCenterDistance(hand, existing) < 0.065 &&
          Math.hypot(
            hand.landmarks[8].x - existing.landmarks[8].x,
            hand.landmarks[8].y - existing.landmarks[8].y
          ) < 0.085
        );
        if (!duplicate) unique.push(hand);
      });
      return unique.sort((a, b) => a.sourceIndex - b.sourceIndex);
    }

    smoothHandPosture(hand, now) {
      const raw = hand.fingers;
      let filter = this.postureFilters.get(hand.key);
      if (!filter || now - filter.lastSeenAt > POSTURE_FILTER_TTL) {
        filter = { scores: {}, stable: {}, lastSeenAt: now };
        FINGER_KEYS.forEach((name) => {
          filter.scores[name] = raw[name] ? 0.82 : 0.12;
          filter.stable[name] = Boolean(raw[name]);
        });
      } else {
        filter.lastSeenAt = now;
        FINGER_KEYS.forEach((name) => {
          filter.scores[name] = Math.min(
            1,
            Math.max(0, filter.scores[name] + (raw[name] ? 0.36 : -0.42))
          );
          filter.stable[name] =
            filter.scores[name] >= (filter.stable[name] ? 0.36 : 0.64);
        });
      }
      this.postureFilters.set(hand.key, filter);
      hand.fingers = {
        thumb: filter.stable.thumb,
        index: filter.stable.index,
        middle: filter.stable.middle,
        ring: filter.stable.ring,
        pinky: filter.stable.pinky
      };
      hand.fingers.count =
        FINGER_KEYS.filter((name) => hand.fingers[name]).length;
    }

    updateMotionHistory(hand, now) {
      let points = this.motionHistories.get(hand.key) || [];
      points.push({
        t: now,
        x: hand.landmarks[8].x,
        y: hand.landmarks[8].y
      });
      points = points.filter((point) => now - point.t <= 1000);
      this.motionHistories.set(hand.key, points);
      if (points.length < 2) return 0;
      const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
      const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
      return points.reduce((sum, point) =>
        sum + Math.pow(point.x - meanX, 2) +
        Math.pow(point.y - meanY, 2), 0) / points.length;
    }

    choosePointerHand(hands) {
      this.bookHand = null;
      if (!hands.length) {
        this.pointerKey = null;
        return null;
      }
      if (hands.length === 1) {
        hands[0].role = "pointer";
        this.pointerKey = hands[0].key;
        return hands[0];
      }
      const pointing = hands.filter(isPointingIndex);
      const sorted = [...hands].sort((a, b) => b.motion - a.motion);
      let pointer = pointing.length === 1
        ? pointing[0]
        : hands.find((hand) => hand.key === this.pointerKey) || sorted[0];
      pointer.role = "pointer";
      const book = hands.find((hand) => hand !== pointer);
      if (book) {
        book.role = "book";
        this.bookHand = book;
      }
      this.pointerKey = pointer.key;
      return pointer;
    }

    getSelectionTips(hands, now) {
      const pointing = hands.filter(isPointingIndex);
      let pair = null;
      for (let i = 0; i < pointing.length; i += 1) {
        for (let j = i + 1; j < pointing.length; j += 1) {
          if (handCenterDistance(pointing[i], pointing[j]) > 0.075) {
            pair = [pointing[i].tip, pointing[j].tip];
          }
        }
      }
      if (pair) {
        if (!this.twoHandCandidate.since) this.twoHandCandidate.since = now;
        this.twoHandCandidate.lastSeenAt = now;
        this.twoHandCandidate.tips = pair;
        if (
          this.selection.active ||
          now - this.twoHandCandidate.since >= LINE_SWITCH_DEBOUNCE_MS
        ) {
          return pair;
        }
        return null;
      }
      if (
        this.selection.active &&
        hands.length < 2 &&
        this.twoHandCandidate.tips &&
        now - this.twoHandCandidate.lastSeenAt <= TWO_HAND_HOLD_MS
      ) {
        return this.twoHandCandidate.tips;
      }
      if (now - this.twoHandCandidate.lastSeenAt > TWO_HAND_HOLD_MS) {
        this.twoHandCandidate.since = 0;
        this.twoHandCandidate.lastSeenAt = 0;
        this.twoHandCandidate.tips = null;
      }
      return null;
    }

    updateSelection(tips, now) {
      if (this.state === "paused") return true;
      if (now < this.selection.cooldownUntil) return false;
      if (tips) {
        if (!this.selection.active) {
          this.selection.active = true;
          this.selection.startedAt = now;
          this.forcedLineId = null;
          this.activeWord = null;
          this.onActiveWord(null);
          this.setState("selecting", "拖动双手食指调整选区。");
          this.onHistory({
            type: "selection_start",
            title: "开始框选",
            detail: "双手食指",
            tone: "neutral"
          });
        }
        this.selection.tipA = tips[0];
        this.selection.tipB = tips[1];
        this.selection.lastSeenAt = now;
        return true;
      }
      if (
        this.selection.active &&
        now - this.selection.lastSeenAt > LINE_SWITCH_DEBOUNCE_MS
      ) {
        this.finishSelection();
        return true;
      }
      return this.selection.active;
    }

    finishSelection() {
      const rect = normalizeSelectionRect(
        this.selection.tipA,
        this.selection.tipB
      );
      this.selection.active = false;
      this.selection.tipA = null;
      this.selection.tipB = null;
      this.selection.cooldownUntil = performance.now() + LINE_SWITCH_DEBOUNCE_MS * 2;
      this.lastSelection = rect
        ? { rect, expiresAt: performance.now() + 1500 }
        : null;
      if (!rect) return;
      const layout = this.getLayout();
      const hits = this.wordMap.filter((word) => {
        const left = layout.left + layout.offsetX + word.x * layout.scale;
        const top = layout.top + layout.offsetY + word.y * layout.scale;
        const right = left + word.width * layout.scale;
        const bottom = top + word.height * layout.scale;
        return right >= rect.x &&
          left <= rect.x + rect.width &&
          bottom >= rect.y &&
          top <= rect.y + rect.height;
      });
      const grouped = new Map();
      hits.forEach((word) => {
        if (!grouped.has(word.lineId)) grouped.set(word.lineId, []);
        grouped.get(word.lineId).push(word);
      });
      const text = Array.from(grouped.entries()).map(([lineId, words]) =>
        `${lineId}: ${words.map((word) => word.text).join("")}`
      ).join("；");
      this.onSelection({
        hits,
        text,
        rect,
        lines: Array.from(grouped.keys())
      });
      this.playSoundSelect();
      this.setState("selecting", hits.length ? "框选完成。" : "框选未命中文字。");
    }

    triggerPause(reason) {
      if (this.state === "paused") return;
      this.pauseReason = reason;
      this.noHandSince = null;
      this.fiveOpenSince = null;
      this.lineCandidate = null;
      this.forcedLineId = null;
      this.takeoverOriginY = null;
      this.resetPauseRecovery();
      this.activeWord = null;
      this.onActiveWord(null);
      this.playSoundPause();
      this.setState("paused", PAUSE_REASONS[reason] || "暂停条件已触发");
      this.emitVoice("pause", {
        text: PAUSE_REASONS[reason] || "暂停条件已触发"
      });
      this.onHistory({
        type: "pause",
        title: "暂停",
        detail: PAUSE_REASONS[reason] || "条件触发",
        tone: "warn"
      });
    }

    resetPauseRecovery() {
      this.pausedLastPointer = null;
      this.pausedMotion = 0;
      this.pausedMotionStartedAt = 0;
      this.pausedLastMoveAt = 0;
    }

    attemptResume(pointer, now) {
      if (!pointer || !isPointingIndex(pointer)) {
        this.resetPauseRecovery();
        return;
      }
      const point = pointer.tip;
      if (!this.pausedLastPointer) {
        this.pausedLastPointer = { x: point.x, y: point.y };
        this.pausedMotionStartedAt = now;
        this.pausedLastMoveAt = now;
        return;
      }
      const distance = Math.hypot(
        point.x - this.pausedLastPointer.x,
        point.y - this.pausedLastPointer.y
      );
      this.pausedLastPointer = { x: point.x, y: point.y };
      if (distance < 32) {
        this.pausedMotion += distance;
        this.pausedLastMoveAt = now;
      } else {
        this.pausedMotion = 0;
        this.pausedMotionStartedAt = now;
      }
      const frameMs = this.fps > 0 ? 1000 / this.fps : 50;
      if (
        this.pausedMotion >= 15 &&
        now - this.pausedMotionStartedAt >= Math.max(frameMs * 4, 120) &&
        now - this.pausedLastMoveAt < Math.max(frameMs * 6, 240)
      ) {
        this.resetPauseRecovery();
        this.setState("pointing", "检测到单指移动，已经恢复。");
        this.playSoundStart();
        this.emitVoice("resume", { text: "已恢复阅读" });
        this.onHistory({
          type: "resume",
          title: "恢复",
          detail: "单指移动",
          tone: "success"
        });
      }
    }

    monitorPauseTriggers(hands, pointer, now) {
      if (!hands.length) {
        this.fiveOpenSince = null;
        if (this.noHandSince === null) this.noHandSince = now;
        if (now - this.noHandSince >= 1000 && this.state !== "paused") {
          this.triggerPause("noHand");
        }
      } else {
        this.noHandSince = null;
      }
      const openHands = hands.filter((hand) => hand.fingers.count === 5);
      const openHand = hands.length === 1 ? openHands[0] : null;
      if (openHand) {
        if (this.fiveOpenSince === null) this.fiveOpenSince = now;
        if (now - this.fiveOpenSince >= 500 && this.state !== "paused") {
          this.triggerPause("five");
        }
      } else {
        this.fiveOpenSince = null;
      }
      if (this.state === "paused") this.attemptResume(pointer, now);
    }

    sampleBrightness(now) {
      if (typeof OffscreenCanvas === "undefined" || this.video.readyState < 2) return;
      if (!this.brightnessCanvas) {
        this.brightnessCanvas = new OffscreenCanvas(48, 48);
        this.brightnessContext = this.brightnessCanvas.getContext("2d", {
          willReadFrequently: true
        });
        this.brightnessBaseline = null;
        this.brightnessSamples = 0;
        this.brightnessDarkFrames = 0;
        this.lastBrightnessAt = 0;
      }
      if (now - this.lastBrightnessAt < LINE_SWITCH_DEBOUNCE_MS) return;
      this.lastBrightnessAt = now;
      try {
        const w = this.video.videoWidth;
        const h = this.video.videoHeight;
        this.brightnessContext.drawImage(
          this.video,
          w * 0.25,
          h * 0.22,
          w * 0.5,
          h * 0.56,
          0,
          0,
          48,
          48
        );
        const pixels = this.brightnessContext.getImageData(0, 0, 48, 48).data;
        let total = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          total += pixels[i] * 0.2126 +
            pixels[i + 1] * 0.7152 +
            pixels[i + 2] * 0.0722;
        }
        const average = total / 2304;
        if (this.brightnessBaseline === null) {
          this.brightnessBaseline = average;
          this.brightnessSamples = 1;
          return;
        }
        this.brightnessSamples += 1;
        if (this.brightnessSamples < 8) {
          this.brightnessBaseline =
            this.brightnessBaseline * 0.78 + average * 0.22;
          return;
        }
        const dropRatio =
          (this.brightnessBaseline - average) /
          Math.max(1, this.brightnessBaseline);
        if (dropRatio > 0.28) {
          this.brightnessDarkFrames += 1;
          if (
            this.brightnessDarkFrames >= 2 &&
            this.state !== "paused" &&
            !this.hands.length
          ) {
            this.triggerPause("occlusion");
          }
        } else {
          this.brightnessDarkFrames = 0;
        }
        this.brightnessBaseline =
          this.brightnessBaseline * 0.98 + average * 0.02;
      } catch (error) {
        this.lastBrightnessAt = now + 5000;
      }
    }

    handleHandResults(results) {
      if (!this.initialized || this.destroyed) return;
      const now = performance.now();
      const rawLandmarks = results.multiHandLandmarks || [];
      const handednesses = results.multiHandedness || [];
      const usedKeys = new Set();
      const detected = rawLandmarks.map((landmarks, index) => {
        const meta = handednesses[index] || {};
        let key = meta.label || `Hand${index}`;
        if (usedKeys.has(key)) key = `${key}-${index}`;
        usedKeys.add(key);
        return this.makeHand(landmarks, key, index, meta.score || 0);
      });
      this.hands = this.deduplicateHands(detected);
      this.hands.forEach((hand) => {
        this.smoothHandPosture(hand, now);
        hand.motion = this.updateMotionHistory(hand, now);
      });
      this.onHandUpdate({
        count: this.hands.length,
        fps: this.fps,
        hands: this.hands
      });

      const pointer = this.choosePointerHand(this.hands);
      this.monitorPauseTriggers(this.hands, pointer, now);
      if (this.state === "paused") return;

      const tips = this.getSelectionTips(this.hands, now);
      if (this.updateSelection(tips, now)) return;
      if (this.hands.filter(isPointingIndex).length >= 2 && this.twoHandCandidate.since) {
        return;
      }

      if (pointer && isPointingIndex(pointer)) {
        const trace = this.updatePointerTrace(pointer.tip.x, pointer.tip.y, now);
        this.handlePointerWord(trace, now);
      } else {
        this.handlePointerWord(null, now);
      }
      this.sampleBrightness(now);
    }

    async detectLoop() {
      if (this.destroyed || !this.initialized) return;
      if (this.handsModel && !this.detectBusy && this.video.readyState >= 2) {
        this.detectBusy = true;
        const startedAt = performance.now();
        try {
          await this.handsModel.send({ image: this.video });
          const fps = 1000 / Math.max(1, performance.now() - startedAt);
          this.fps = this.fps ? this.fps * 0.8 + fps * 0.2 : fps;
          this.onHandUpdate({
            count: this.hands.length,
            fps: this.fps,
            hands: this.hands
          });
        } catch (error) {
          this.handleError(error);
        } finally {
          this.detectBusy = false;
        }
      }
      if (!this.destroyed) {
        this.detectionFrame = requestAnimationFrame(() => this.detectLoop());
      }
    }

    drawHand(hand) {
      if (!this.ctx) return;
      const color = this.state === "paused"
        ? "rgba(255, 141, 123, 0.54)"
        : this.state === "selecting" || this.state === "takeover"
          ? "rgba(255, 200, 97, 0.96)"
          : hand.role === "pointer"
            ? "rgba(90, 244, 168, 0.96)"
            : "rgba(198, 218, 207, 0.38)";
      this.ctx.save();
      this.ctx.strokeStyle = color;
      this.ctx.lineCap = "round";
      this.ctx.lineJoin = "round";
      this.ctx.lineWidth = hand.role === "pointer" ? 2 : 1.1;
      HAND_CONNECTIONS.forEach(([start, end]) => {
        this.ctx.beginPath();
        this.ctx.moveTo(hand.points[start].x, hand.points[start].y);
        this.ctx.lineTo(hand.points[end].x, hand.points[end].y);
        this.ctx.stroke();
      });
      hand.points.forEach((point, index) => {
        this.ctx.beginPath();
        this.ctx.arc(point.x, point.y, index === 8 ? 4 : 2, 0, Math.PI * 2);
        this.ctx.fillStyle = color;
        this.ctx.fill();
      });
      this.ctx.restore();
    }

    drawWordBox(word, color, dashed = false) {
      if (!this.ctx || !word) return;
      const origin = this.mapToScreen(word.x, word.y);
      const width = word.width * this.displayScale;
      const height = word.height * this.displayScale;
      this.ctx.save();
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = dashed ? 1.3 : 1.8;
      this.ctx.setLineDash(dashed ? [5, 4] : []);
      this.ctx.strokeRect(origin.x, origin.y, width, height);
      this.ctx.restore();
    }

    drawSelection(rect, active) {
      if (!this.ctx || !rect) return;
      this.ctx.save();
      this.ctx.fillStyle = active
        ? "rgba(255, 200, 97, 0.11)"
        : "rgba(90, 244, 168, 0.07)";
      this.ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      this.ctx.strokeStyle = active
        ? "rgba(255, 200, 97, 0.96)"
        : "rgba(90, 244, 168, 0.9)";
      this.ctx.setLineDash(active ? [7, 5] : []);
      this.ctx.strokeRect(
        rect.x + 0.5,
        rect.y + 0.5,
        rect.width,
        rect.height
      );
      this.ctx.restore();
    }

    renderOverlay(now) {
      if (!this.ctx) return;
      const rect = this.canvas.getBoundingClientRect();
      this.ctx.clearRect(0, 0, rect.width, rect.height);
      if (this.hoverWord && this.hoverWord !== this.activeWord) {
        this.drawWordBox(this.hoverWord, "rgba(90, 244, 168, 0.86)", true);
      }
      if (this.activeWord) {
        this.drawWordBox(this.activeWord, "rgba(255, 200, 97, 0.98)", false);
      }
      this.hands.forEach((hand) => this.drawHand(hand));
      if (this.selection.active) {
        this.drawSelection(
          normalizeSelectionRect(this.selection.tipA, this.selection.tipB),
          true
        );
      } else if (this.lastSelection && now < this.lastSelection.expiresAt) {
        this.drawSelection(this.lastSelection.rect, false);
      }
    }

    renderLoop(now) {
      if (this.destroyed) return;
      this.renderOverlay(now);
      this.renderFrame = requestAnimationFrame((time) => this.renderLoop(time));
    }

    handleError(error) {
      try {
        this.onError(error);
      } catch (callbackError) {
        console.error(callbackError);
      }
    }

    destroy() {
      this.destroyed = true;
      this.initialized = false;
      cancelAnimationFrame(this.detectionFrame);
      cancelAnimationFrame(this.renderFrame);
      if (this.ownsCameraStream && this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.video.srcObject = null;
      }
      this.stream = null;
      this.hands = [];
      this.motionHistories.clear();
      this.postureFilters.clear();
      if (this.resizeHandler) {
        global.removeEventListener?.("resize", this.resizeHandler);
      }
      if (this.handsModel?.close) {
        try { this.handsModel.close(); } catch (error) {}
      }
      if (this.ctx) {
        const rect = this.canvas.getBoundingClientRect();
        this.ctx.clearRect(0, 0, rect.width, rect.height);
      }
      if (global.onWordFocus === this.wordFocusBridge) global.onWordFocus = undefined;
      if (global.onVoiceAnnotation === this.voiceAnnotationBridge) {
        global.onVoiceAnnotation = undefined;
      }
      this.onActiveWord(null);
      this.onHoverWord(null);
    }
  }

  GestureEngine.LINE_SWITCH_DEBOUNCE_MS = LINE_SWITCH_DEBOUNCE_MS;
  GestureEngine.parseTextMap = function parseTextMap(data) {
    const probe = Object.create(GestureEngine.prototype);
    probe.textMap = null;
    probe.lineMap = [];
    probe.lineById = new Map();
    probe.wordMap = [];
    probe.viewportRect = null;
    probe.mapViewport = null;
    probe.displayScale = 1;
    probe.displayOffsetX = 0;
    probe.displayOffsetY = 0;
    probe.onLayout = noop;
    probe.onMapLoaded = noop;
    probe.onActiveWord = noop;
    probe.onHoverWord = noop;
    probe.onStateChange = noop;
    return probe.setTextMap(data);
  };

  global.GestureEngine = GestureEngine;
})(window);
