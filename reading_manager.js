/**
 * PaperPal / 纸伴 — D 模块：朗读与阅读管理 (ReadingManager)
 * 负责：TTS 朗读与打断、朗读进度、语速控制、选区保存(Highlight)、阅读历史、无障碍语音反馈
 * 兼容：
 *   - A 模块 (ayala1009/bookreader): 监听 bookreader:page-updated 事件
 *   - B 模块 (ocr-text-map): 直接载入标准文字地图 JSON (含 lines / reading_order / text)
 *   - C 模块 (blind-book-precise-reading): 提供 onTapWord / onSlideWords / onSelectRegion / onPause / onResume 接口
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
      this.synth = typeof window !== "undefined" ? window.speechSynthesis : null;
      this.lang = options.lang || "zh-CN";
      this.speed = this._loadSettings().speed || 1.0;
      this.voiceEnabled = this._loadSettings().voiceEnabled !== false;

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

      // 本地存储
      this.highlights = this._loadJson(STORAGE_KEYS.HIGHLIGHTS, []);
      this.history = this._loadJson(STORAGE_KEYS.HISTORY, []);
      this.progressMap = this._loadJson(STORAGE_KEYS.PROGRESS, {});

      // 载入默认示例数据，确保独立演示不空场
      this.loadOcrMap(options.initialMap || DEFAULT_OCR_MAP, { silent: true });

      // 自动监听 A 模块的页面更新事件
      if (typeof window !== "undefined" && options.autoListenA !== false) {
        window.addEventListener("bookreader:page-updated", (event) => {
          const detail = event?.detail || {};
          this.onPageChanged(detail.pageId || `P${Date.now()}`, detail.label || "新页面");
        });
      }
    }

    // ==================== 1. 载入 B 模块 OCR 文字地图 ====================
    loadOcrMap(ocrJson, options = {}) {
      if (!ocrJson || !Array.isArray(ocrJson.lines)) return false;

      const sorted = [...ocrJson.lines]
        .filter((item) => item && typeof item.text === "string" && item.text.trim().length > 0)
        .sort((a, b) => (a.reading_order || 0) - (b.reading_order || 0));

      this.currentPageId = ocrJson.pageId || ocrJson.frame_id || `page-${Date.now()}`;
      this.currentPageLabel = ocrJson.label || "当前书页";
      this.lines = sorted.map((line, idx) => ({
        index: idx,
        id: line.id || `line-${idx + 1}`,
        reading_order: line.reading_order || idx + 1,
        block_id: line.block_id || "block-1",
        text: line.text.trim()
      }));

      // 恢复该页上次阅读进度
      const saved = this.progressMap[this.currentPageId];
      this.currentIndex = saved && saved.index < this.lines.length ? saved.index : 0;
      this.status = "idle";
      this._emit();

      if (!options.silent) {
        this.speakFeedback(`已识别${this.currentPageLabel}，共${this.lines.length}行，可以开始点读`);
      }
      return true;
    }

    onPageChanged(pageId, label = "新页面") {
      this.stopSpeech();
      this.currentPageId = String(pageId);
      this.currentPageLabel = label;
      this.status = "idle";
      this._emit();
      this.speakFeedback(`检测到${label}，正在等待文字识别`);
    }

    // ==================== 2. 核心 TTS 朗读与打断 ====================
    play(index = this.currentIndex) {
      if (!this.lines.length) {
        this.speakFeedback("当前没有可朗读的文字，请重新扫描");
        return false;
      }
      const safeIndex = Math.max(0, Math.min(index, this.lines.length - 1));
      this.currentIndex = safeIndex;
      this._autoAdvance = true;
      this.status = "playing";
      const line = this.lines[safeIndex];

      this._recordProgress(line);
      this._addHistory("朗读", `${this.currentPageLabel} · ${line.text}`);
      this._emit();

      this._speak(line.text, {
        rate: this.speed,
        onEnd: () => {
          if (this._autoAdvance && this.status === "playing") {
            if (this.currentIndex + 1 < this.lines.length) {
              this.play(this.currentIndex + 1);
            } else {
              this.status = "idle";
              this._autoAdvance = false;
              this._emit();
              this.speakFeedback("本页已读完");
            }
          }
        }
      });
      return true;
    }

    pause(silent = false) {
      this._autoAdvance = false;
      this.stopSpeech();
      this.status = "paused";
      this._emit();
      if (!silent) {
        this.speakFeedback("已暂停");
      }
    }

    resume() {
      if (this.status === "playing") return;
      this.play(this.currentIndex);
    }

    togglePlay() {
      if (this.status === "playing") {
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
      if (!wordText) return;
      this._autoAdvance = false;
      if (lineId) {
        const idx = this.lines.findIndex((l) => l.id === lineId || String(l.reading_order) === String(lineId));
        if (idx >= 0) {
          this.currentIndex = idx;
          this._recordProgress(this.lines[idx]);
        }
      }
      this.status = "playing";
      this._emit();
      this._speak(wordText, {
        rate: this.speed,
        onEnd: () => {
          if (!this._autoAdvance && this.status === "playing") {
            this.status = "idle";
            this._emit();
          }
        }
      });
    }

    /**
     * C 模块快速滑读连读
     */
    onSlideWords(sentence, pxPerSec = 0) {
      if (!sentence) return;
      this._autoAdvance = false;
      this.status = "playing";
      const dynamicRate = this.setSlideSpeed(pxPerSec);
      this._emit();
      this._speak(sentence, {
        rate: dynamicRate,
        onEnd: () => {
          if (!this._autoAdvance && this.status === "playing") {
            this.status = "idle";
            this._emit();
          }
        }
      });
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
      if (!text || !this.voiceEnabled) return;
      this._autoAdvance = false;
      this._speak(text, { rate: Math.max(1.0, this.speed) });
    }

    setVoiceEnabled(enabled) {
      this.voiceEnabled = Boolean(enabled);
      this._saveSettings();
      this._emit();
    }

    stopSpeech() {
      this._utteranceId++;
      if (this.synth) {
        this.synth.cancel();
      }
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
        historyCount: this.history.length
      };
    }

    onStateChange(listener) {
      if (typeof listener !== "function") return () => {};
      this._listeners.add(listener);
      listener(this.getState());
      return () => this._listeners.delete(listener);
    }

    // ==================== 内部工具方法 ====================
    _speak(text, { rate = 1.0, onEnd = null } = {}) {
      if (!this.synth) {
        console.info(`[D-TTS 模拟] (${rate}x): ${text}`);
        if (onEnd) setTimeout(onEnd, 300);
        return;
      }
      const id = ++this._utteranceId;
      this.synth.cancel();

      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = this.lang;
      utter.rate = rate;
      utter.onend = () => {
        if (id === this._utteranceId && typeof onEnd === "function") {
          onEnd();
        }
      };
      utter.onerror = () => {
        if (id === this._utteranceId && this.status === "playing") {
          this.status = "idle";
          this._emit();
        }
      };
      this.synth.speak(utter);
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
      return this._loadJson(STORAGE_KEYS.SETTINGS, { speed: 1.0, voiceEnabled: true });
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
  if (!global.BookReaderTTS) {
    global.BookReaderTTS = new ReadingManager();
  }
})(typeof window !== "undefined" ? window : globalThis);