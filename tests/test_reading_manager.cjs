"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../reading_manager.js"), "utf8");
const initialMap = {
  document_id: "document-1", label: "测试页",
  lines: [
    { id: "line-1", reading_order: 1, text: "第一行", region_id: "page-1" },
    { id: "line-2", reading_order: 2, text: "第二行", region_id: "page-1" }
  ]
};

function environment({ autoInstance = false, speech = true, stored = {}, document } = {}) {
  const utterances = [];
  const listeners = new Map();
  const storage = new Map(Object.entries(stored));
  const context = {
    console,
    FEELYREADER_NO_AUTO_TTS: !autoInstance,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    setTimeout() { throw new Error("A timer must not simulate successful speech."); },
    document
  };
  context.window = context;
  if (speech) {
    context.speechSynthesis = {
      cancel() {},
      speak(utterance) { utterances.push(utterance); }
    };
  }
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    context, utterances, listeners,
    manager(options = {}) { return new context.ReadingManager({ autoListenA: false, initialMap, ...options }); },
    dispatch(type, detail) { for (const listener of listeners.get(type) || []) listener({ detail }); }
  };
}

test("document_id and region ids survive loading; malformed progress cannot select a negative line", () => {
  const env = environment({ stored: { paperpal_d_progress_v1: JSON.stringify({ "document-1": { index: -1 } }) } });
  const manager = env.manager();
  assert.equal(manager.currentPageId, "document-1");
  assert.equal(manager.currentIndex, 0);
  assert.equal(manager.lines[0].region_id, "page-1");
  manager.onTapWord("点读", "line-2");
  assert.equal(manager.getLastProgress("document-1").lineId, "line-2");
});

test("silent OCR replacement invalidates an old utterance and its auto-advance callback", () => {
  const env = environment();
  const manager = env.manager();
  manager.play(0);
  const old = env.utterances.at(-1);
  manager.loadOcrMap({ document_id: "replacement", lines: [{ id: "new", text: "新页" }] }, { silent: true });
  const count = env.utterances.length;
  old.onend();
  assert.equal(env.utterances.length, count);
  assert.equal(manager.currentPageId, "replacement");
  assert.equal(manager.currentIndex, 0);
  assert.equal(manager.status, "idle");
  assert.equal(manager._autoAdvance, false);
});

test("page changes clear old lines before new OCR and cannot read the previous page", () => {
  const env = environment();
  const manager = env.manager();
  manager.setVoiceEnabled(false);
  manager.play();
  const old = env.utterances.at(-1);
  manager.onPageChanged("new-page", "下一页");
  assert.equal(manager.lines.length, 0);
  assert.equal(manager.currentIndex, 0);
  assert.equal(manager.getState().currentLine, null);
  assert.equal(manager.play(), false);
  old.onend();
  assert.equal(env.utterances.length, 1);
});

test("speed feedback resumes the interrupted line at the new rate and preserves auto-advance", () => {
  const env = environment();
  const manager = env.manager();
  manager.play();
  const original = env.utterances.at(-1);
  manager.setSpeed(1.5);
  assert.equal(manager.status, "feedback");
  const feedback = env.utterances.at(-1);
  original.onend();
  assert.equal(manager.currentIndex, 0);
  feedback.onend();
  assert.equal(manager.status, "playing");
  assert.equal(env.utterances.at(-1).text, "第一行");
  assert.equal(env.utterances.at(-1).rate, 1.5);
  env.utterances.at(-1).onend();
  assert.equal(manager.currentIndex, 1);
  assert.equal(env.utterances.at(-1).text, "第二行");
  env.utterances.at(-1).onend();
  assert.equal(env.utterances.at(-1).text, "本页已读完");
  env.utterances.at(-1).onend();
  assert.equal(manager.status, "idle");
});

test("saving highlights resumes reading and replacing feedback retains its original action", () => {
  const env = environment();
  const manager = env.manager();
  manager.play(1);
  const saved = manager.onSelectRegion("选中内容", ["line-2"]);
  assert.equal(saved.text, "选中内容");
  assert.equal(saved.pageId, "document-1");
  const firstFeedback = env.utterances.at(-1);
  manager.speakFeedback("另一个提示");
  const lastFeedback = env.utterances.at(-1);
  const count = env.utterances.length;
  firstFeedback.onend();
  assert.equal(env.utterances.length, count);
  lastFeedback.onend();
  assert.equal(manager.status, "playing");
  assert.equal(env.utterances.at(-1).text, "第二行");
});

test("pause feedback finishes paused, and late old speech callbacks cannot restart playback", () => {
  const env = environment();
  const manager = env.manager();
  manager.play();
  const original = env.utterances.at(-1);
  manager.pause();
  assert.equal(manager.status, "feedback");
  env.utterances.at(-1).onend();
  assert.equal(manager.status, "paused");
  const count = env.utterances.length;
  original.onend();
  assert.equal(env.utterances.length, count);
  manager.resume();
  assert.equal(manager.status, "playing");
  assert.equal(env.utterances.at(-1).text, "第一行");
});

test("silent pause and stop cancel feedback's pending automatic resume", () => {
  for (const action of ["pause", "stop"]) {
    const env = environment();
    const manager = env.manager();
    manager.play();
    manager.speakFeedback("提示");
    const feedback = env.utterances.at(-1);
    if (action === "pause") manager.pause(true);
    else manager.stopSpeech();
    const count = env.utterances.length;
    feedback.onend();
    assert.equal(env.utterances.length, count);
    assert.equal(manager.status, action === "pause" ? "paused" : "idle");
  }
});

test("new point reading replaces feedback; old callbacks cannot resurrect a whole-page reading", () => {
  const env = environment();
  const manager = env.manager();
  manager.play();
  manager.speakFeedback("提示");
  const feedback = env.utterances.at(-1);
  manager.onTapWord("新词", "line-2");
  feedback.onend();
  assert.equal(env.utterances.at(-1).text, "新词");
  assert.equal(manager.currentIndex, 1);
  env.utterances.at(-1).onend();
  assert.equal(manager.status, "idle");
  assert.equal(manager._autoAdvance, false);
});

test("slide reading can pause and resume the same phrase at its dynamic rate", () => {
  const env = environment();
  const manager = env.manager();
  manager.onSlideWords("几个连续词语", 500);
  assert.equal(env.utterances.at(-1).rate, 1.6);
  manager.pause(true);
  manager.resume();
  assert.equal(env.utterances.at(-1).text, "几个连续词语");
  assert.equal(env.utterances.at(-1).rate, 1.6);
  env.utterances.at(-1).onend();
  assert.equal(manager.status, "idle");
});

test("disabling feedback cancels its voice and restores the interrupted reading", () => {
  const env = environment();
  const manager = env.manager();
  manager.play();
  manager.speakFeedback("提示");
  const feedback = env.utterances.at(-1);
  manager.setVoiceEnabled(false);
  assert.equal(manager.status, "playing");
  assert.equal(env.utterances.at(-1).text, "第一行");
  const count = env.utterances.length;
  feedback.onend();
  manager.speakFeedback("不应播报");
  assert.equal(env.utterances.length, count);
});

test("speech failures expose an error and leave a resumable paused action", () => {
  const env = environment();
  const manager = env.manager();
  manager.play();
  const utterance = env.utterances.at(-1);
  utterance.onerror({ error: "not-allowed" });
  assert.equal(manager.status, "paused");
  assert.match(manager.getState().lastError, /not-allowed/);
  utterance.onend();
  assert.equal(env.utterances.length, 1);
  manager.resume();
  assert.equal(env.utterances.length, 2);
  assert.equal(manager.getState().lastError, "");
});

test("unsupported synthesis does not simulate successful playback with a timer", () => {
  const env = environment({ speech: false });
  const manager = env.manager();
  assert.equal(manager.play(), false);
  assert.equal(manager.status, "paused");
  assert.match(manager.getState().lastError, /不支持/);
  assert.equal(manager.currentIndex, 0);
});

test("destroy unregisters A events and invalidates pending speech", () => {
  const env = environment();
  const manager = env.manager({ autoListenA: true });
  assert.equal(env.listeners.get("bookreader:page-updated").size, 1);
  manager.play();
  const old = env.utterances.at(-1);
  manager.destroy();
  assert.equal(env.listeners.get("bookreader:page-updated").size, 0);
  env.dispatch("bookreader:page-updated", { pageId: "must-not-load" });
  old.onend();
  assert.equal(manager.currentPageId, "document-1");
  assert.equal(env.utterances.length, 1);
  assert.equal(manager.play(), false);
  assert.equal(manager.status, "idle");
  manager.destroy();
});

test("automatic compatibility instance is optional and its destroy removes the global handle", () => {
  assert.equal(environment().context.BookReaderTTS, undefined);
  const env = environment({ autoInstance: true });
  assert.ok(env.context.BookReaderTTS instanceof env.context.ReadingManager);
  env.context.BookReaderTTS.destroy();
  assert.equal(env.context.BookReaderTTS, undefined);
  assert.equal(env.listeners.get("bookreader:page-updated").size, 0);
});

test("malformed stored JSON shapes cannot break manager construction", () => {
  const env = environment({ stored: {
    paperpal_d_settings_v1: "null", paperpal_d_highlights_v1: "42",
    paperpal_d_history_v1: "{}", paperpal_d_progress_v1: "[]"
  } });
  const manager = env.manager();
  assert.equal(manager.highlights.length, 0);
  assert.equal(manager.history.length, 0);
  assert.equal(manager.speed, 1);
  manager.saveHighlight({ text: "可以保存" });
  assert.equal(manager.highlights.length, 1);
});

test("D demo uses the shared manager and renders imported and stored markup as text", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../paperpal_d.html"), "utf8");
  assert.match(html, /src="reading_manager\.js"/);
  assert.doesNotMatch(html, /class\s+ReadingManager|\.innerHTML\s*=/);
  class Element {
    constructor(id) { this.id = id; this.children = []; this.dataset = {}; this.classList = { toggle() {} }; }
    set innerHTML(value) { throw new Error("Unsafe HTML rendering: " + value); }
    set textContent(value) { this.text = String(value); }
    get textContent() { return this.text || ""; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    setAttribute() {}
    click() {}
  }
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], new Element(match[1])]));
  const document = { getElementById: (id) => elements.get(id), createElement: (tag) => new Element(tag), querySelectorAll: () => [] };
  const attack = "<img src=x onerror=globalThis.injected=true>";
  const env = environment({ document, stored: {
    paperpal_d_highlights_v1: JSON.stringify([{ text: attack, pageLabel: attack }]),
    paperpal_d_history_v1: JSON.stringify([{ detail: attack, action: "历史" }])
  } });
  const inline = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  for (const script of inline) if (script.trim()) vm.runInContext(script, env.context);
  const fileInput = elements.get("fileInput");
  fileInput.files = [{ text: async () => JSON.stringify({ document_id: "unsafe-text", label: attack, lines: [{ id: "line-1", text: attack }] }) }];
  await fileInput.onchange();
  assert.equal(elements.get("lineList").children[0].children[1].textContent, attack);
  assert.ok(elements.get("hlList").children[0].textContent.includes(attack));
  assert.ok(elements.get("hisList").children.some((item) => item.textContent.includes(attack)));
  assert.equal(env.context.injected, undefined);
  fileInput.files = [{ text: async () => "invalid json" }];
  await fileInput.onchange();
  assert.match(elements.get("importStatus").textContent, /导入失败/);
});
