/* Coordinate integration checks use browser-shaped mocks, not a real camera. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'gesture-engine.js'), 'utf8');

function fixture(options = {}) {
  const calls = [];
  const ctx = {};
  for (const name of ['setTransform', 'save', 'restore', 'beginPath', 'closePath',
    'moveTo', 'lineTo', 'stroke', 'arc', 'fill', 'setLineDash', 'strokeRect', 'fillRect', 'clearRect']) {
    ctx[name] = (...args) => calls.push([name, ...args]);
  }
  const bounds = options.canvasRect || { left: 100, top: 200, width: 400, height: 300 };
  const videoBounds = options.videoRect || bounds;
  const video = { tagName: 'VIDEO', videoWidth: 400, videoHeight: 200, readyState: 2,
    getBoundingClientRect: () => videoBounds };
  const canvas = { tagName: 'CANVAS', width: 400, height: 300,
    getContext: () => ctx, getBoundingClientRect: () => bounds };
  const events = { focus: [], selection: [], active: [], hover: [] };
  const sandbox = { console, Intl, Date, Math, performance: { now: () => 2000 },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setTimeout: () => 1, clearTimeout() {},
    addEventListener() {}, removeEventListener() {}, devicePixelRatio: 2 };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'gesture-engine.js' });
  const engine = new sandbox.GestureEngine(video, {
    canvas, mapViewport: { getBoundingClientRect: () => bounds },
    requestCamera: false, mirrored: false, soundEnabled: false,
    onWordFocus: event => events.focus.push(event),
    onVoiceAnnotation() {},
    onSelection: event => events.selection.push(event),
    onActiveWord: word => events.active.push(word),
    onHoverWord: word => events.hover.push(word),
    ...options.engineOptions
  });
  engine.initialized = true;
  engine.setTextMap({ rectified_size: [200, 300], lines: [
    { id: 'line-1', text: '甲乙丙', reading_order: 1, bbox_rectified: [10, 20, 60, 20] },
    { id: 'line-2', text: '丁戊己', reading_order: 2, bbox_rectified: [10, 70, 60, 20] }
  ] });
  calls.length = 0;
  return { engine, calls, events, canvas, video };
}

function project(matrix, x, y) {
  const z = matrix[6] * x + matrix[7] * y + matrix[8];
  return { x: (matrix[0] * x + matrix[1] * y + matrix[2]) / z,
    y: (matrix[3] * x + matrix[4] * y + matrix[5]) / z };
}

function inverse([a, b, c, d, e, f, g, h, i]) {
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [e * i - f * h, c * h - b * i, b * f - c * e,
    f * g - d * i, a * i - c * g, c * d - a * f,
    d * h - e * g, b * g - a * h, a * e - b * d].map(value => value / determinant);
}

function homographyMapper(matrix, valid = () => true) {
  const reverse = inverse(matrix);
  return { isValid: valid, mapToScreen: (x, y) => project(matrix, x, y),
    screenToMap: (x, y) => project(reverse, x, y) };
}

function near(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}

test('90-degree mapper locates the actual line and uses map-axis movement', () => {
  const mapper = homographyMapper([0, -2, 500, 2, 0, 100, 0, 0, 1]);
  const { engine, events } = fixture({ engineOptions: { coordinateMapper: mapper } });
  const screen = mapper.mapToScreen(30, 30);
  const trace = engine.updatePointerTrace(screen.x, screen.y, 1000);
  near(trace.x, 30); near(trace.y, 30);
  assert.equal(trace.lineId, 'line-1');
  engine.handlePointerWord(trace, 1000);
  engine.handlePointerWord(engine.updatePointerTrace(screen.x, screen.y, 1300), 1300);
  assert.equal(engine.activeLineId, 'line-1');
  assert.equal(events.focus.length, 1);
  const next = mapper.mapToScreen(15, 80);
  engine.handlePointerWord(engine.updatePointerTrace(next.x, next.y, 1500), 1500);
  const movedAlongPage = mapper.mapToScreen(25, 80);
  // Screen x is unchanged here: the reference page x direction is vertical.
  near(next.x, movedAlongPage.x);
  engine.handlePointerWord(engine.updatePointerTrace(movedAlongPage.x, movedAlongPage.y, 1800), 1800);
  assert.equal(engine.activeLineId, 'line-2');
});

test('perspective mapper drives selection and projects all four word corners', () => {
  const matrix = [1.4, 0.2, 400, 0.15, 1.2, 300, 0.002, 0.001, 1];
  const mapper = homographyMapper(matrix);
  const { engine, events } = fixture({ engineOptions: { coordinateMapper: mapper } });
  engine.setTextMap({ rectified_size: [200, 300], lines: [
    { id: 'line-1', text: '测', bbox_rectified: [20, 30, 60, 15] }
  ] });
  const expected = [[20, 30], [80, 30], [80, 45], [20, 45]].map(p => project(matrix, ...p));
  const polygon = engine.projectWordPolygon(engine.wordMap[0]);
  polygon.forEach((point, index) => { near(point.x, expected[index].x); near(point.y, expected[index].y); });
  const xs = expected.map(p => p.x), ys = expected.map(p => p.y);
  engine.selection.tipA = { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1 };
  engine.selection.tipB = { x: Math.max(...xs) + 1, y: Math.max(...ys) + 1 };
  const selection = engine.finishSelection();
  assert.equal(selection.hits.length, 1);
  assert.equal(selection.hits[0].lineId, 'line-1');
  assert.equal(events.selection.length, 1);
  assert.equal(engine.state, 'idle');
});

test('selection rejects empty corners of a projected diamond envelope', () => {
  const { engine } = fixture({ engineOptions: {
    coordinateMapper: homographyMapper([1, -1, 100, 1, 1, 100, 0, 0, 1])
  } });
  engine.setTextMap({ rectified_size: [200, 300], lines: [
    { id: 'line-1', text: '字', bbox_rectified: [0, 0, 10, 10] }
  ] });
  engine.selection.tipA = { x: 90, y: 100 };
  engine.selection.tipB = { x: 92, y: 102 };
  assert.equal(engine.finishSelection().hits.length, 0);
});

test('canvas offset is removed for word polygons, hands and selection while DPR remains', () => {
  const { engine, calls, canvas } = fixture({ engineOptions: {
    coordinateMapper: homographyMapper([1, 0, 130, 0, 1, 240, 0, 0, 1])
  } });
  engine.resizeCanvas();
  assert.equal(canvas.width, 800);
  assert.equal(canvas.height, 600);
  assert.ok(calls.some(call => call[0] === 'setTransform' && call[1] === 2 && call[4] === 2));
  calls.length = 0;
  engine.drawWordBox(engine.wordMap[0], 'red');
  assert.deepEqual(calls.find(call => call[0] === 'moveTo'), ['moveTo', 40, 60]);
  calls.length = 0;
  engine.drawHand({ role: 'pointer', points: Array.from({ length: 21 }, () => ({ x: 160, y: 270 })) });
  assert.deepEqual(calls.find(call => call[0] === 'moveTo'), ['moveTo', 60, 70]);
  assert.deepEqual(calls.find(call => call[0] === 'arc').slice(0, 3), ['arc', 60, 70]);
  calls.length = 0;
  engine.drawSelection({ x: 150, y: 260, width: 40, height: 50 }, true);
  assert.deepEqual(calls.find(call => call[0] === 'fillRect'), ['fillRect', 50, 60, 40, 50]);
});

test('contain uses actual video bounds and letterboxing, with compatible cover default', () => {
  const videoRect = { left: 25, top: 40, width: 300, height: 300 };
  const contained = fixture({ videoRect, engineOptions: { objectFit: 'contain' } }).engine;
  const rect = contained.getCameraRenderRect();
  near(rect.left, 25); near(rect.top, 115); near(rect.width, 300); near(rect.height, 150);
  const center = contained.cameraPointToScreen(0.5, 0.5);
  near(center.x, 175); near(center.y, 190);
  const covered = fixture({ videoRect }).engine.getCameraRenderRect();
  near(covered.left, -125); near(covered.top, 40); near(covered.width, 600); near(covered.height, 300);
});

test('invalid tracking clears stale focus and selection and prevents events and rendering', () => {
  let valid = true;
  const { engine, events, calls } = fixture({ engineOptions: {
    coordinateMapper: homographyMapper([1, 0, 0, 0, 1, 0, 0, 0, 1], () => valid)
  } });
  const stale = engine.updatePointerTrace(30, 30, 1000);
  engine.activeWord = engine.wordMap[0];
  engine.hoverWord = engine.wordMap[0];
  engine.activeLineId = 'line-1';
  engine.selection.active = true;
  engine.selection.tipA = { x: 0, y: 0 };
  engine.selection.tipB = { x: 100, y: 100 };
  engine.lastSelection = { rect: { x: 0, y: 0, width: 100, height: 100 }, expiresAt: 3000 };
  valid = false;
  assert.equal(engine.screenToMap(30, 30), null);
  assert.equal(engine.mapToScreen(30, 30), null);
  assert.equal(engine.updatePointerTrace(30, 30, 1500), null);
  assert.equal(engine.findLineAtY(30), null);
  assert.equal(engine.findWordByX(stale.line, 30), null);
  engine.handlePointerWord(stale, 1600);
  assert.equal(engine.activeWord, null);
  assert.equal(engine.hoverWord, null);
  assert.equal(engine.activeLineId, null);
  assert.equal(engine.selection.active, false);
  assert.equal(engine.lastSelection, null);
  assert.equal(engine.finishSelection(), null);
  assert.equal(events.focus.length, 0);
  assert.equal(events.selection.length, 0);
  calls.length = 0;
  engine.drawWordBox(stale.word, 'red');
  engine.drawSelection({ x: 0, y: 0, width: 100, height: 100 }, true);
  engine.renderOverlay(1700);
  assert.ok(calls.every(call => call[0] === 'clearRect'));
});

test('null projections are safe and clearing a map removes all interaction state', () => {
  const { engine, events } = fixture();
  engine.setCoordinateMapper({ isValid: () => true, screenToMap: () => null, mapToScreen: () => null });
  assert.equal(engine.updatePointerTrace(10, 10, 1000), null);
  assert.equal(engine.projectWordPolygon(engine.wordMap[0]), null);
  assert.equal(events.focus.length, 0);
  engine.clearTextMap();
  assert.equal(engine.getTextMap(), null);
  assert.equal(engine.lineMap.length, 0);
  assert.equal(engine.wordMap.length, 0);
  assert.equal(engine.updatePointerTrace(30, 30, 1500), null);
  assert.equal(engine.selection.active, false);
  assert.throws(() => engine.setCoordinateMapper({ isValid: () => true }), /coordinateMapper/);
});

test('legacy affine viewport and standalone map parsing remain available without a mapper', () => {
  const { engine } = fixture();
  const point = engine.mapToScreen(10, 20);
  near(point.x, 210); near(point.y, 220);
  const restored = engine.screenToMap(point.x, point.y);
  near(restored.x, 10); near(restored.y, 20);
  const parsed = engine.constructor.parseTextMap({ rectified_size: [200, 300], lines: [
    { id: 'legacy', text: '文字', bbox_rectified: [10, 20, 60, 20] }
  ] });
  assert.equal(parsed.lineCount, 1);
  assert.equal(parsed.sourceWidth, 200);
  assert.equal(parsed.sourceHeight, 300);
});
