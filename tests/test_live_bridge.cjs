"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../live-bridge.js"), "utf8");

function setup(cv = null, decode = async () => { throw Error("unexpected decode"); }) {
  const events = new Map();
  const window = { addEventListener: (name, cb) => events.set(name, cb) };
  const context = vm.createContext({ window, document: { addEventListener() {} },
    performance: { now: () => 1000 }, requestAnimationFrame() {}, createImageBitmap: decode,
    Promise, console });
  vm.runInContext(source, context);
  const bridge = new window.BookLiveBridge({ video: {} }, () => cv);
  const states = [];
  bridge.subscribe(message => states.push(message.state));
  return { bridge, events, states };
}

test("manual raw capture does not require OpenCV or attempt to decode a tracking reference", async () => {
  const { bridge, states } = setup();
  bridge.refs = [{ id: 9 }];
  await bridge.install({ blob: new Blob(), pages: [] });
  await Promise.resolve();
  assert.equal(bridge.refs.length, 0);
  assert.ok(states.includes("reference-changing"));
});

test("missing OpenCV clears references without breaking OCR capture delivery", async () => {
  const { bridge } = setup();
  await bridge.install({ blob: new Blob(), pages: [{ pageId: 1 }] });
  assert.equal(bridge.refs.length, 0);
});

test("an asynchronous reference decode failure is reported rather than an unhandled rejection", async () => {
  const { events, states } = setup({}, async () => { throw Error("bad capture"); });
  events.get("bookreader:captured")({ detail: { blob: new Blob(), pages: [{ pageId: 1 }] } });
  for (let i = 0; i < 8; ++i) await Promise.resolve();
  assert.ok(states.some(s => s === "reference-error: bad capture"));
});
