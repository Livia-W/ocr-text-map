/**
 * PaperPal / 纸伴 — D 模块：朗读与阅读管理 (ReadingManager)
 * 负责：TTS 朗读与打断、朗读进度、语速控制、选区保存(Highlight)、阅读历史、无障碍语音反馈
 * 兼容：
 *   - A 模块 (ayala1009/bookreader): 监听 bookreader:page-updated 事件
 *   - B 模块 (ocr-text-map): 直接载入标准文字地图 JSON (含 lines / reading_order / text)
 *   - C 模块 (blind-book-precise-reading): 提供 onTapWord / onSlideWords / onSelectRegion / pause / resume 接口
 *   - E 模块 (App & 无障碍 UI): 提供订阅状态变化 onStateChange & 完整控制方法
 */
(function (global) {
  "use strict";

  const STORAGE_KEYS = {
    HIGHLIGHTS: "paperpal_d_highlights_v1",
    HISTORY: "paperpal_d_history_v1",
    PROGRESS: "paperpal_d_progress_v1",
    SETTINGS: "paperpal_d_settings_v1"
  };

  const DEFAULT_OCR_MAP = {
    pageId: "demo-page-1",
    label: "第 12–13 页（示例）",
    lines: [
      { id: "line-1", reading_order: 1, block_id: "block-1", text: "推荐序" },
      { id: "line-2", reading_order: 2, block_id: "block-2", text: "“心”鲜的世界" },
      { id: "line-3", reading_order: 3, block_id: "block-3", text: "陶勇" },
      { id: "line-4", reading_order: 4, block_id: "block-4", text: "如果做一道填空题，花是的。你会如何回答？" },
      { id: "line-5", reading_order: 5, block_id: "block-4", text: "睁开眼睛，仿佛置身公园，眼前浮现出姹紫嫣红的" },
      { id: "line-6", reading_order: 6, block_id: "block-4", text: "鲜花，我们会说，花是美的。" },
      { id: "line-7", reading_order: 7, block_id: "block-4", text: "闭上眼睛，深吸一口，浓郁的芬芳沁人心脾，我们" },
      { id: "line-8", reading_order: 8, block_id: "block-4", text: "会说，花是香的。" }
    ]
  };

  class ReadingManager {
    constructor(options = {}) {
      this.synth = global.speechSynthesis || null;
      this.lang = options.lang || "zh-CN";
      const settings = this._loadSettings();
      this.speed = Math.max(0.5, Math.min(2.5, Number(settings.speed) || 1));
      this.voiceEnabled = settings.voiceEnabled !== false;

      // 当前页面与行数据（来自 B 的文字地图）
      this.currentPageId = DEFAULT_OCR_MAP.pageId;
      this.currentPageLabel = DEFAULT_OCR_MAP.label;
      this.lines = [];
      this.currentIndex = 0;

      // 播放状态：idle | playing | paused | feedback
      this.status = "idle";
      this._autoAdvance = false;
      this._utteranceId = 0;
      this._listeners = new Set();
      this._playback = null;
      this._feedbackReturn = null;
      this._pageListener = null;
      this._destroyed = false;
      this.lastError = "";

      // 本地存储
      const highlights = this._loadJson(STORAGE_KEYS.HIGHLIGHTS, []);
      const history = this._loadJson(STORAGE_KEYS.HISTORY, []);
      const progress = this._loadJson(STORAGE_KEYS.PROGRESS, {});
      this.highlights = Array.isArray(highlights) ? highlights.filter((item) => item && typeof item.text === "string") : [];
      this.history = Array.isArray(history) ? history.filter((item) => item && typeof item === "object") : [];
      this.progressMap = Object.assign(Object.create(null), progress && typeof progress === "object" && !Array.isArray(progress) ? progress : {});

      // 载入默认示例数据，确保独立演示不空场
      this.loadOcrMap(options.initialMap || DEFAULT_OCR_MAP, { silent: true });

      // 自动监听 A 模块的页面更新事件
      if (typeof global.addEventListener === "function" && options.autoListenA !== false) {
        this._pageListener = (event) => {
          const detail = event?.detail || {};
          this.onPageChanged(detail.pageId || `P${Date.now()}`, detail.label || "新页面");
        };
        global.addEventListener("bookreader:page-updated", this._pageListener);
      }
    }

    // ==================== 1. 载入 B 模块 OCR 文字地图 ====================
    loadOcrMap(ocrJson, options = {}) {
      if (this._destroyed || !ocrJson || !Array.isArray(ocrJson.lines)) return false;
      this.stopSpeech();

      const sorted = [...ocrJson.lines]
        .filter((item) => item && typeof item.text === "string" && item.text.trim().length > 0)
        .sort((a, b) => (a.reading_order || 0) - (b.reading_order || 0));

      this.currentPageId = String(ocrJson.document_id || ocrJson.pageId || ocrJson.frame_id || `page-${Date.now()}`);
      this.currentPageLabel = String(ocrJson.label || "当前书页");
      this.lines = sorted.map((line, idx) => ({
        index: idx,
        id: String(line.id || `line-${idx + 1}`),
        reading_order: line.reading_order || idx + 1,
        block_id: line.block_id || "block-1",
        region_id: line.region_id ?? null,
        text: line.text.trim()
      }));

      // 恢复该页上次阅读进度
      const saved = this.progressMap[this.currentPageId];
      this.currentIndex = saved && Number.isInteger(saved.index) && saved.index >= 0 && saved.index < this.lines.length ? saved.index : 0;
      this.status = "idle";
      this._emit();

      if (!options.silent) {
        this.speakFeedback(`已识别${this.currentPageLabel}，共${this.lines.length}行，可以开始点读`);
      }
      return true;
    }

    onPageChanged(pageId, label = "新页面") {
      if (this._destroyed) return;
      this.stopSpeech();
      this.currentPageId = String(pageId);
      this.currentPageLabel = String(label);
      this.lines = [];
      this.currentIndex = 0;
      this.status = "idle";
      this._emit();
      this.speakFeedback(`检测到${label}，正在等待文字识别`);
    }

    // ==================== 2. 核心 TTS 朗读与打断 ====================
    play(index = this.currentIndex) {
      if (this._destroyed) return false;
      if (!this.lines.length) {
        this.speakFeedback("当前没有可朗读的文字，请重新扫描");
        return false;
      }
      const numericIndex = Number(index);
      const safeIndex = Math.max(0, Math.min(Number.isFinite(numericIndex) ? Math.trunc(numericIndex) : 0, this.lines.length - 1));
      this.currentIndex = safeIndex;
      const line = this.lines[safeIndex];

      this._recordProgress(line);
      this._addHistory("朗读", `${this.currentPageLabel} · ${line.text}`);
      return this._startPlayback({ kind: "line", text: line.text, index: safeIndex }, true);
    }

    pause(silent = false) {
      if (this._destroyed) return;
      const playback = this._feedbackReturn?.playback || this._playback;
      this._cancelUtterance();
      this._feedbackReturn = null;
      this._playback = playback;
      this._autoAdvance = false;
      this.status = "paused";
      this._emit();
      if (!silent) {
        this.speakFeedback("已暂停");
      }
    }

    resume() {
      if (this._destroyed || this.status === "playing") return;
      const interrupted = this._feedbackReturn;
      const playback = interrupted?.playback || this._playback;
      if (playback) {
        return this._startPlayback(playback, interrupted ? interrupted.autoAdvance : playback.kind === "line");
      }
      return this.play(this.currentIndex);
    }

    togglePlay() {
      if (this.status === "playing" || (this.status === "feedback" && this._feedbackReturn?.status === "playing")) {
        this.pause();
      } else {
        this.resume();
      }
    }

    prevLine() {
      if (!this.lines.length) return;
      const target = Math.max(0, this.currentIndex - 1);
      if (target === this.currentIndex && this.currentIndex === 0) {
        this.speakFeedback("已经是第一行");
        return;
      }
      this.play(target);
    }

    nextLine() {
      if (!this.lines.length) return;
      if (this.currentIndex + 1 >= this.lines.length) {
        this.speakFeedback("已经是最后一行");
        return;
      }
      this.play(this.currentIndex + 1);
    }

    jumpToLineId(lineId) {
      const idx = this.lines.findIndex((l) => l.id === lineId);
      if (idx >= 0) {
        this.play(idx);
        return true;
      }
      return false;
    }

    // ==================== 3. 速度控制 ====================
    setSpeed(rate) {
      const clamped = Math.max(0.5, Math.min(2.5, Number(rate) || 1.0));
      this.speed = Math.round(clamped * 100) / 100;
      this._saveSettings();
      this._emit();
      this.speakFeedback(`语速${this.speed}倍`);
      return this.speed;
    }

    /**
     * 配合 C 模块滑读速度动态调整倍速（不播报提示词，避免打断连读）
     */
    setSlideSpeed(pxPerSec) {
      if (pxPerSec > 450) return Math.min(2.0, Math.max(this.speed, 1.6));
      if (pxPerSec > 250) return Math.min(1.6, Math.max(this.speed, 1.3));
      return this.speed;
    }

    // ==================== 4. 对接 C 模块手势事件 ====================
    /**
     * C 模块单指点读（支持传 lineId 或直接传词/句文本）
     */
    onTapWord(wordText, lineId = null) {
      if (this._destroyed || !wordText) return;
      if (lineId) {
        const idx = this.lines.findIndex((l) => l.id === lineId || String(l.reading_order) === String(lineId));
        if (idx >= 0) {
          this.currentIndex = idx;
          this._recordProgress(this.lines[idx]);
        }
      }
      return this._startPlayback({ kind: "tap", text: String(wordText) }, false);
    }

    /**
     * C 模块快速滑读连读
     */
    onSlideWords(sentence, pxPerSec = 0) {
      if (this._destroyed || !sentence) return;
      return this._startPlayback({ kind: "slide", text: String(sentence), pxPerSec }, false);
    }

    /**
     * C 模块双手食指框选保存 Highlight
     */
    onSelectRegion(selectedText, lineIds = []) {
      return this.saveHighlight({
        text: selectedText,
        lineIds,
        pageId: this.currentPageId,
        pageLabel: this.currentPageLabel
      });
    }

    // ==================== 5. 选区保存 (Highlight) 与阅读历史 ====================
    saveHighlight(payload = {}) {
      if (this._destroyed) return null;
      const currentLine = this.lines[this.currentIndex];
      const text = (payload.text || (currentLine ? currentLine.text : "")).trim();
      if (!text) {
        this.speakFeedback("没有可保存的选区内容");
        return null;
      }

      const item = {
        id: `hl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        pageId: payload.pageId || this.currentPageId,
        pageLabel: payload.pageLabel || this.currentPageLabel,
        lineIds: payload.lineIds && payload.lineIds.length
          ? payload.lineIds
          : (currentLine ? [currentLine.id] : []),
        text,
        createdAt: new Date().toISOString()
      };

      this.highlights.unshift(item);
      if (this.highlights.length > 200) this.highlights.length = 200;
      this._saveJson(STORAGE_KEYS.HIGHLIGHTS, this.highlights);
      this._addHistory("保存选区", text);
      this._emit();
      this.speakFeedback("已保存选区");
      return item;
    }

    getHighlights() {
      return [...this.highlights];
    }

    removeHighlight(id) {
      this.highlights = this.highlights.filter((h) => h.id !== id);
      this._saveJson(STORAGE_KEYS.HIGHLIGHTS, this.highlights);
      this._emit();
    }

    getHistory() {
      return [...this.history];
    }

    getLastProgress(pageId = this.currentPageId) {
      return this.progressMap[pageId] || null;
    }

    // ==================== 6. 无障碍语音反馈 ====================
    speakFeedback(text) {
      if (this._destroyed || !text || !this.voiceEnabled) return false;
      // Several feedback messages can replace each other, while retaining the
      // original reading action to resume after the last message completes.
      const previous = this._feedbackReturn || {
        status: this.status, playback: this._playback,
        autoAdvance: this._autoAdvance, pageId: this.currentPageId
      };
      this._feedbackReturn = previous;
      this._autoAdvance = false;
      this.status = "feedback";
      this.lastError = "";
      this._emit();
      if (this.status !== "feedback" || this._feedbackReturn !== previous) return false;
      return this._speak(String(text), {
        rate: Math.max(1.0, this.speed),
        onEnd: () => this._finishFeedback(previous),
        onError: (message) => {
          this._feedbackReturn = null;
          this._autoAdvance = false;
          this._playback = previous.playback;
          this.status = previous.playback ? "paused" : "idle";
          this.lastError = message;
          this._emit();
        }
      });
    }

    setVoiceEnabled(enabled) {
      this.voiceEnabled = Boolean(enabled);
      this._saveSettings();
      if (!this.voiceEnabled && this.status === "feedback" && this._feedbackReturn) {
        const previous = this._feedbackReturn;
        this._cancelUtterance();
        this._finishFeedback(previous);
        return;
      }
      this._emit();
    }

    stopSpeech() {
      this._cancelUtterance();
      this._autoAdvance = false;
      this._playback = null;
      this._feedbackReturn = null;
      this.status = "idle";
      this._emit();
    }

    _cancelUtterance() {
      this._utteranceId++;
      if (this.synth) {
        try { this.synth.cancel(); } catch { /* Invalidation still cancels callbacks. */ }
      }
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this.stopSpeech();
      if (this._pageListener) {
        global.removeEventListener?.("bookreader:page-updated", this._pageListener);
        this._pageListener = null;
      }
      this._listeners.clear();
      if (global.BookReaderTTS === this) delete global.BookReaderTTS;
    }

    // ==================== 7. 状态订阅 (供 E 模块 UI 更新) ====================
    getState() {
      const currentLine = this.lines[this.currentIndex] || null;
      return {
        status: this.status,
        speed: this.speed,
        voiceEnabled: this.voiceEnabled,
        pageId: this.currentPageId,
        pageLabel: this.currentPageLabel,
        currentIndex: this.currentIndex,
        totalLines: this.lines.length,
        currentLine,
        highlightsCount: this.highlights.length,
        historyCount: this.history.length,
        lastError: this.lastError
      };
    }

    onStateChange(listener) {
      if (this._destroyed || typeof listener !== "function") return () => {};
      this._listeners.add(listener);
      listener(this.getState());
      return () => this._listeners.delete(listener);
    }

    // ==================== 内部工具方法 ====================
    _startPlayback(playback, autoAdvance) {
      if (this._destroyed) return false;
      this._feedbackReturn = null;
      this._playback = playback;
      this._autoAdvance = autoAdvance;
      this.status = "playing";
      this.lastError = "";
      if (playback.kind === "line") this.currentIndex = playback.index;
      this._emit();
      if (this.status !== "playing" || this._playback !== playback) return false;
      return this._speak(playback.text, {
        rate: playback.kind === "slide" ? this.setSlideSpeed(playback.pxPerSec) : this.speed,
        onEnd: () => {
          if (this.status !== "playing" || this._playback !== playback) return;
          if (this._autoAdvance && playback.kind === "line" && this.currentIndex + 1 < this.lines.length) {
            this.play(this.currentIndex + 1);
          } else {
            const finishedPage = this._autoAdvance && playback.kind === "line";
            this._autoAdvance = false;
            this._playback = null;
            this.status = "idle";
            this._emit();
            if (finishedPage) this.speakFeedback("本页已读完");
          }
        },
        onError: (message) => {
          this._autoAdvance = false;
          this.status = "paused";
          this.lastError = message;
          this._emit();
        }
      });
    }

    _finishFeedback(previous) {
      if (this._destroyed || this._feedbackReturn !== previous || previous.pageId !== this.currentPageId) return;
      this._feedbackReturn = null;
      if (previous.status === "playing" && previous.playback) {
        // Browsers cannot reliably resume a cancelled utterance at a character;
        // restart the interrupted line or gesture phrase at the current rate.
        this._startPlayback(previous.playback, previous.autoAdvance);
      } else {
        this._playback = previous.playback;
        this._autoAdvance = false;
        this.status = previous.status === "paused" ? "paused" : "idle";
        this._emit();
      }
    }

    _speak(text, { rate = 1.0, onEnd = null, onError = null } = {}) {
      this._cancelUtterance();
      const id = this._utteranceId;
      let finished = false;
      const finish = (error) => {
        if (finished || id !== this._utteranceId || this._destroyed) return;
        finished = true;
        if (error) {
          if (typeof onError === "function") onError(`朗读不可用：${error}`);
        } else if (typeof onEnd === "function") onEnd();
      };
      if (!this.synth || typeof global.SpeechSynthesisUtterance !== "function") {
        finish("当前浏览器不支持语音合成");
        return false;
      }
      const utter = new global.SpeechSynthesisUtterance(text);
      utter.lang = this.lang;
      utter.rate = rate;
      utter.onend = () => finish();
      utter.onerror = (event) => finish(event?.error || "语音播放失败");
      try {
        this.synth.speak(utter);
      } catch (error) {
        finish(error.message || "语音播放失败");
        return false;
      }
      return true;
    }

    _recordProgress(line) {
      if (!line) return;
      this.progressMap[this.currentPageId] = {
        pageId: this.currentPageId,
        pageLabel: this.currentPageLabel,
        lineId: line.id,
        index: this.currentIndex,
        text: line.text,
        updatedAt: new Date().toISOString()
      };
      this._saveJson(STORAGE_KEYS.PROGRESS, this.progressMap);
    }

    _addHistory(action, detail) {
      this.history.unshift({
        id: `his-${Date.now()}`,
        action,
        detail,
        time: new Date().toLocaleTimeString("zh-CN", { hour12: false })
      });
      if (this.history.length > 50) this.history.length = 50;
      this._saveJson(STORAGE_KEYS.HISTORY, this.history);
    }

    _emit() {
      const snapshot = this.getState();
      this._listeners.forEach((fn) => {
        try {
          fn(snapshot);
        } catch (err) {
          console.error("[ReadingManager] listener error:", err);
        }
      });
    }

    _loadJson(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    }

    _saveJson(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // 忽略隐私模式配额限制
      }
    }

    _loadSettings() {
      const settings = this._loadJson(STORAGE_KEYS.SETTINGS, {});
      return settings && typeof settings === "object" ? settings : {};
    }

    _saveSettings() {
      this._saveJson(STORAGE_KEYS.SETTINGS, {
        speed: this.speed,
        voiceEnabled: this.voiceEnabled
      });
    }
  }

  // 挂载到全局，方便 A/C/E 直接调用
  global.ReadingManager = ReadingManager;
  if (!global.FEELYREADER_NO_AUTO_TTS && !global.BookReaderTTS) {
    global.BookReaderTTS = new ReadingManager();
  }
})(typeof window !== "undefined" ? window : globalThis);
