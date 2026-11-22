/* C's standalone camera/JSON workspace shares the production gesture engine. */
(() => {
  "use strict";
  const ids = ["camera", "viewer", "overlay", "map", "placeholder", "start", "stop", "demo",
    "status", "hand-status", "file", "region", "map-status", "focus", "events"];
  const elements = Object.fromEntries(ids.map(id => [id, document.getElementById(`c-${id}`)]));
  const video = elements.camera;
  let engine = null, mode = "inactive", session = 0, importRevision = 0;
  let maps = [], selected = 0, parsedMap = null, lastDemoAt = 0;
  const history = [];

  function status(text, error = false) {
    elements.status.textContent = text;
    elements.status.classList.toggle("error", error);
  }
  function controls() {
    elements.start.disabled = mode === "starting" || mode === "camera";
    elements.stop.disabled = mode === "inactive";
    elements.demo.disabled = mode === "starting" || mode === "demo";
    elements.placeholder.hidden = mode === "camera";
  }
  function log(title, text) {
    history.unshift({ title, text }); history.splice(12);
    elements.events.replaceChildren();
    for (const item of history) {
      const row = document.createElement("li"); row.textContent = `${item.title}：${item.text}`;
      elements.events.append(row);
    }
  }
  function focus(event) {
    elements.focus.textContent = `${event.word || ""}\n${event.fullLine || event.line || ""}`.trim();
    log(event.event || "字词焦点", event.word || "");
    window.dispatchEvent(new CustomEvent("feelyreader:c-word-focus", { detail: event }));
  }
  function stop(message = "摄像头与手势已停止。") {
    session += 1;
    const previous = engine; engine = null; mode = "inactive";
    previous?.destroy();
    if (video.srcObject) {
      video.srcObject.getTracks().forEach(track => track.stop()); video.srcObject = null;
    }
    video.pause(); video.classList.remove("mirrored");
    elements["hand-status"].textContent = "手部检测未启动";
    status(message); controls();
  }
  function renderMap() {
    elements.map.replaceChildren();
    if (!parsedMap) return;
    const rect = elements.viewer.getBoundingClientRect();
    const scale = Math.min(rect.width / parsedMap.sourceWidth, rect.height / parsedMap.sourceHeight);
    const offsetX = (rect.width - parsedMap.sourceWidth * scale) / 2;
    const offsetY = (rect.height - parsedMap.sourceHeight * scale) / 2;
    for (const line of parsedMap.lines) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "c-line"; button.textContent = line.text;
      button.setAttribute("aria-label", `测试字词焦点：${line.text}`);
      Object.assign(button.style, { left: `${offsetX + line.x * scale}px`, top: `${offsetY + line.y * scale}px`,
        width: `${line.width * scale}px`, height: `${line.height * scale}px`,
        fontSize: `${Math.max(8, Math.min(36, line.height * scale * .78))}px` });
      button.addEventListener("click", () => {
        if (!engine || mode === "starting") { status("请先启动摄像头或鼠标测试。"); return; }
        const word = engine.lineById.get(line.id)?.words[0];
        if (word) engine.emitWordFocus("point_read", word);
      });
      elements.map.append(button);
    }
  }
  function parseMap(data) {
    const parsed = window.GestureEngine.parseTextMap(data);
    if (!Number.isFinite(parsed.sourceWidth) || !Number.isFinite(parsed.sourceHeight)
        || parsed.sourceWidth <= 0 || parsed.sourceHeight <= 0
        || parsed.sourceWidth * parsed.sourceHeight > 20_000_000) throw new Error("地图尺寸无效或超过 2000 万像素。");
    return parsed;
  }
  function useMap(index) {
    const candidate = maps[index];
    if (!candidate) return;
    const parsed = parseMap(candidate.data);
    engine?.setTextMap(candidate.data, candidate.label);
    selected = index; parsedMap = parsed; elements.region.value = String(index);
    elements["map-status"].textContent = `${candidate.label} · ${parsed.lineCount} 行 · ${parsed.sourceWidth} × ${parsed.sourceHeight} 像素。固定版式，不跟踪纸页。`;
    elements.focus.textContent = "等待字词焦点"; renderMap();
  }
  function importMap(raw, label = "导入地图") {
    if (!raw || !Array.isArray(raw.lines) || !raw.lines.length || raw.lines.length > 10000) {
      throw new Error("JSON 必须包含非空 lines 数组，且最多 10000 行。");
    }
    if (raw.lines.some(line => typeof line?.text !== "string" || line.text.length > 50000)) throw new Error("文字行内容无效或过长。");
    const regions = Array.isArray(raw.regions) && raw.regions.length ? raw.regions : [null];
    if (regions.length > 100) throw new Error("页或栏数量过多。");
    const candidates = regions.flatMap((region, index) => {
      const data = region ? { ...raw, lines: raw.lines.filter(line => line.region_id === region.id),
        rectified_size: region.rectified_size || (regions.length === 1 ? raw.rectified_size : null) } : raw;
      if (!data.lines.length) return [];
      if (region && regions.length > 1 && !data.rectified_size) throw new Error("多页 JSON 的每区必须有自己的 rectified_size。");
      const size = data.rectified_size;
      if (size && (!Array.isArray(size) || size.length !== 2 || !size.every(v => Number.isFinite(v) && v > 0)
          || size[0] * size[1] > 20_000_000)) throw new Error("地图尺寸无效或超过 2000 万像素。");
      parseMap(data);
      return [{ data, label: region ? `${label} · ${region.label || `区域 ${index + 1}`}` : label }];
    });
    if (!candidates.length) throw new Error("地图中没有可测试的非空文字页。");
    maps = candidates; elements.region.replaceChildren();
    maps.forEach((map, index) => {
      const option = document.createElement("option"); option.value = String(index); option.textContent = map.label;
      elements.region.append(option);
    });
    elements.region.disabled = false; useMap(0);
    status(mode === "camera" ? "地图已加载，请按显示的固定版式移动手指。" : "地图已加载，可启动摄像头或鼠标测试。");
  }
  function makeEngine(token) {
    const current = () => token === session;
    return new window.GestureEngine(video, {
      canvas: elements.overlay, mapViewport: elements.viewer,
      requestCamera: true, mirrored: false, objectFit: "contain",
      locateFile: file => new URL(`vendor/mediapipe/${file}`, document.baseURI).href,
      onCameraState: event => { if (current()) video.classList.toggle("mirrored", !!event.mirrored); },
      onWordFocus: event => { if (current()) focus(event); },
      onSelection: event => {
        if (!current()) return;
        const text = (event.hits || []).map(word => word.text || word.word || "").join("");
        elements.focus.textContent = text || `已选 ${event.lines?.length || 0} 行`;
        log("双指选区", elements.focus.textContent);
      },
      onHandUpdate: event => {
        if (!current()) return;
        const count = Number.isFinite(event.count) ? event.count : event.hands?.length || 0;
        const fps = Number.isFinite(event.fps) ? Math.round(event.fps) : 0;
        elements["hand-status"].textContent = `已检测 ${count} 只手 · ${fps} FPS`;
      },
      onError: error => {
        if (!current()) return;
        stop("手势识别已停止。");
        status(`手势识别失败：${error.message || error}。检查相机权限与模型资源后重试。`, true);
      }
    });
  }
  async function startCamera() {
    if (mode === "starting" || mode === "camera") return;
    stop();
    const token = ++session; mode = "starting"; controls();
    status("正在请求相机权限并加载手势模型…");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      mode = "inactive"; controls();
      status("相机需要 HTTPS（电脑本机也可用 localhost）及浏览器相机权限。", true); return;
    }
    let candidate;
    try {
      candidate = makeEngine(token); engine = candidate;
      if (maps[selected]) candidate.setTextMap(maps[selected].data, maps[selected].label);
      await candidate.init();
      if (token !== session) { candidate.destroy(); return; }
      mode = "camera"; controls(); candidate.resizeCanvas(); candidate.refreshLayout(); renderMap();
      status(parsedMap ? "实时相机与手势已启动；按显示的文字框测试点读和选区。" : "实时相机与手势已启动；可以先查看手部骨架，再导入文字地图测试点读。");
    } catch (error) {
      candidate?.destroy();
      if (token !== session) return;
      stop(); status(`启动失败：${error.message || error}。请检查相机权限后重试。`, true);
    }
  }
  async function startDemo() {
    if (!parsedMap) { status("鼠标测试需要先导入文字地图。", true); return; }
    stop();
    const token = ++session;
    let candidate;
    try {
      candidate = makeEngine(token); engine = candidate;
      candidate.setTextMap(maps[selected].data, maps[selected].label);
      await candidate.init({ mediaPipe: false });
      if (token !== session) { candidate.destroy(); return; }
      mode = "demo"; controls(); renderMap();
      elements["hand-status"].textContent = "鼠标测试 · 未使用摄像头";
      status("移动鼠标模拟食指；也可点击文字行测试字词焦点。此模式不调用手部模型。");
    } catch (error) {
      candidate?.destroy();
      if (token === session) { stop(); status(error.message || "鼠标测试启动失败。", true); }
    }
  }

  if (typeof window.GestureEngine !== "function") {
    status("共享手势引擎未加载，请刷新或检查网络后重试。", true);
    elements.start.disabled = elements.demo.disabled = true; return;
  }
  elements.start.addEventListener("click", startCamera);
  elements.stop.addEventListener("click", () => stop());
  elements.demo.addEventListener("click", startDemo);
  elements.region.addEventListener("change", () => {
    try { useMap(Number(elements.region.value)); } catch (error) { status(error.message, true); }
  });
  elements.file.addEventListener("change", async () => {
    const file = elements.file.files?.[0]; elements.file.value = "";
    if (!file) return;
    const revision = ++importRevision;
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error("JSON 文件超过 16 MiB。");
      const text = await file.text();
      if (revision !== importRevision) return;
      importMap(JSON.parse(text), file.name || "导入地图");
    } catch (error) { if (revision === importRevision) status(`地图导入失败：${error.message || error}`, true); }
  });
  elements.viewer.addEventListener("pointermove", event => {
    if (mode !== "demo" || !engine) return;
    const now = performance.now();
    if (now - lastDemoAt < 30) return;
    lastDemoAt = now; engine.handlePointerWord(engine.updatePointerTrace(event.clientX, event.clientY, now), now);
  });
  const resize = () => { engine?.resizeCanvas(); engine?.refreshLayout(); renderMap(); };
  window.addEventListener("resize", resize);
  if (typeof ResizeObserver === "function") new ResizeObserver(resize).observe(elements.viewer);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop("页面已进入后台，相机已释放。返回后请重新启动。"); });
  window.addEventListener("pagehide", () => stop());
  window.FeelyGestureWorkspace = {
    importMap, startCamera, startDemo, stop,
    getState: () => ({ mode, mapCount: maps.length, selected, lineCount: parsedMap?.lineCount || 0 }),
    get engine() { return engine; }
  };
  controls();
})();
