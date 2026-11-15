/* E: application UI. A owns capture; the controller owns OCR, gestures and speech. */
(() => {
  "use strict";
  const ids = [
    "reader-photo", "reader-recognize", "reader-json", "reader-file-info", "reader-engine",
    "reader-endpoint", "reader-endpoint-label", "reader-engine-note", "reader-split", "reader-max-side",
    "reader-mode", "reader-confidence", "reader-rotate-left", "reader-rotate-right", "reader-rotation",
    "reader-split-control", "reader-split-position", "reader-split-value", "reader-photo-preview",
    "reader-status", "reader-cancel", "reader-progress", "reader-page", "reader-play", "reader-prev",
    "reader-next", "reader-speed", "reader-save", "reader-reading-status", "reader-gestures",
    "reader-gesture-status", "reader-map", "reader-map-empty", "reader-lines", "reader-warnings",
    "reader-highlight-count", "reader-history-count", "reader-highlights", "reader-history",
    "reader-export-json", "reader-export-txt"
  ];
  const elements = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const node = name => elements[`reader-${name}`];
  const mapContext = node("map").getContext("2d");
  let controller;
  let state = {};
  let pendingFile = null;
  let previewImage = null;
  let photoRevision = 0;
  let importRevision = 0;
  let photoLoading = false;
  let gesturesPending = false;
  let rotation = 0;
  let activeMap = null;
  let activeImageUrl = "";
  let mapImage = null;
  let mapImageRevision = 0;
  let currentLineId = null;
  let pageSignature = "";
  let savedSignature = "";

  function message(text, error = false) {
    node("status").textContent = text;
    node("status").classList.toggle("error", error);
  }

  function attempt(action) {
    try { return Promise.resolve(action()).catch(error => message(error.message || "操作未完成，请重试。", true)); }
    catch (error) { message(error.message || "操作未完成，请重试。", true); return Promise.resolve(); }
  }

  function readConfig() {
    return {
      engine: node("engine").value,
      endpoint: node("endpoint").value.trim(),
      rotation,
      split: node("split").value,
      split_position: Number(node("split-position").value) / 100,
      mode: node("mode").value,
      max_side: Number(node("max-side").value),
      min_confidence: Number(node("confidence").value)
    };
  }

  function updatePhotoControls() {
    node("rotation").textContent = `${rotation}°`;
    node("rotate-left").disabled = !previewImage || photoLoading;
    node("rotate-right").disabled = !previewImage || photoLoading;
    node("recognize").disabled = !pendingFile || photoLoading || state.status === "recognizing";
    node("split-control").hidden = node("split").value === "none";
    node("split-value").textContent = `${node("split-position").value}%`;
    node("endpoint-label").hidden = node("engine").value !== "python";
    node("engine-note").textContent = node("engine").value === "python"
      ? "照片会发送到所填 Python 接口。请使用你信任的 HTTPS 服务；服务可提供完整页面校正。"
      : "本机识别会下载中文与英文模型，首次启动需要一些时间。浏览器版支持方向与分区校准，不支持曲面展开。";
  }

  function drawPreview() {
    if (!previewImage) return;
    const canvas = node("photo-preview");
    const width = previewImage.naturalWidth, height = previewImage.naturalHeight;
    const sideways = rotation === 90 || rotation === 270;
    const rotatedWidth = sideways ? height : width, rotatedHeight = sideways ? width : height;
    // This only reduces the on-screen preview. The original File goes to OCR.
    const scale = Math.min(1, 1200 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(rotatedWidth * scale));
    canvas.height = Math.max(1, Math.round(rotatedHeight * scale));
    const context = canvas.getContext("2d");
    context.save();
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(rotation * Math.PI / 180);
    context.drawImage(previewImage, -width * scale / 2, -height * scale / 2, width * scale, height * scale);
    context.restore();
    if (node("split").value !== "none") {
      const x = canvas.width * Number(node("split-position").value) / 100;
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, canvas.height);
      context.strokeStyle = "#c1832e"; context.lineWidth = Math.max(2, canvas.width / 300);
      context.setLineDash([8, 5]); context.stroke(); context.setLineDash([]);
    }
    canvas.hidden = false;
  }

  function changeConfig() {
    updatePhotoControls();
    drawPreview();
    return attempt(() => controller.setConfig(readConfig()));
  }

  function imageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("照片无法读取，请选择 JPEG、PNG 或 WebP。")); };
      image.src = url;
    });
  }

  async function choosePhoto() {
    const file = node("photo").files?.[0];
    node("photo").value = "";
    if (!file) return;
    const revision = ++photoRevision;
    importRevision += 1;
    pendingFile = null;
    previewImage = null;
    photoLoading = true;
    rotation = 0;
    node("photo-preview").hidden = true;
    node("file-info").textContent = "正在读取照片…";
    updatePhotoControls();
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("照片超过 8 MiB，请先压缩再选择。");
      const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
      const webp = [82, 73, 70, 70].every((value, i) => bytes[i] === value) && [87, 69, 66, 80].every((value, i) => bytes[i + 8] === value);
      if (!jpeg && !png && !webp) throw new Error("请选择 JPEG、PNG 或 WebP 格式的照片。");
      if (revision !== photoRevision) return;
      const image = await imageFromFile(file);
      if (revision !== photoRevision) return;
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 20_000_000) throw new Error("照片尺寸无效或超过 2000 万像素，请缩小后重试。");
      pendingFile = file;
      previewImage = image;
      node("file-info").textContent = `${file.name || "所选照片"} · ${image.naturalWidth} × ${image.naturalHeight} · 点击「识别照片」开始`;
      drawPreview();
      await changeConfig();
    } catch (error) {
      if (revision !== photoRevision) return;
      node("file-info").textContent = "尚未选择有效照片";
      message(error.message, true);
    } finally {
      if (revision === photoRevision) { photoLoading = false; updatePhotoControls(); }
    }
  }

  function orderedLines(map = activeMap) {
    return (map?.lines || []).slice().sort((a, b) => a.reading_order - b.reading_order);
  }

  function linePolygon(line) {
    if (Array.isArray(line.polygon_source) && line.polygon_source.length >= 3) return line.polygon_source;
    const box = line.bbox_source;
    if (!Array.isArray(box) || box.length !== 4) return [];
    const [x, y, width, height] = box;
    return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  }

  function drawMap() {
    const size = activeMap?.source_size;
    const width = Number(size?.[0]), height = Number(size?.[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width * height > 20_000_000) {
      node("map").hidden = true;
      node("map-empty").hidden = false;
      return;
    }
    const canvas = node("map");
    canvas.width = width; canvas.height = height;
    mapContext.fillStyle = "#fff"; mapContext.fillRect(0, 0, width, height);
    if (mapImage) mapContext.drawImage(mapImage, 0, 0, width, height);
    const stroke = Math.max(1.5, width / 550);
    for (const line of orderedLines()) {
      const points = linePolygon(line);
      if (!points.length) continue;
      mapContext.beginPath();
      points.forEach(([x, y], i) => i ? mapContext.lineTo(x, y) : mapContext.moveTo(x, y));
      mapContext.closePath();
      const active = line.id === currentLineId;
      mapContext.strokeStyle = active ? "#b77924" : "#507943";
      mapContext.fillStyle = active ? "rgba(204,155,71,.22)" : "rgba(102,145,78,.06)";
      mapContext.lineWidth = active ? stroke * 1.8 : stroke;
      mapContext.fill(); mapContext.stroke();
    }
    canvas.hidden = false;
    node("map-empty").hidden = !!mapImage;
    node("map-empty").textContent = "未附原始照片，下面显示原图坐标中的文字框。";
  }

  function loadMapImage(url) {
    const revision = ++mapImageRevision;
    mapImage = null;
    drawMap();
    // All image URLs are local object URLs or encoded images from the controller.
    if (!url || !/^(blob:|data:image\/(?:png|jpeg|webp)[;,])/i.test(url)) return;
    const image = new Image();
    image.onload = () => { if (revision === mapImageRevision) { mapImage = image; drawMap(); } };
    image.onerror = () => { if (revision === mapImageRevision) { mapImage = null; drawMap(); } };
    image.src = url;
  }

  function renderLines() {
    const lines = orderedLines();
    node("lines").replaceChildren();
    if (!lines.length) {
      const empty = document.createElement("p"); empty.className = "empty-reading";
      empty.textContent = state.status === "recognizing" ? "正在识别，请稍候…" : "识别完成后，点击任意一行即可朗读。";
      node("lines").append(empty);
    }
    for (const [index, line] of lines.entries()) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "reader-line"; button.dataset.lineId = String(line.id);
      const number = document.createElement("span"); number.className = "reader-line-number"; number.textContent = String(index + 1);
      const text = document.createElement("span"); text.className = "reader-line-text"; text.textContent = line.text;
      button.append(number, text);
      button.addEventListener("click", () => attempt(() => controller.readLine(line.id)));
      node("lines").append(button);
    }
    node("warnings").replaceChildren(...(activeMap?.warnings || []).map(text => {
      const item = document.createElement("li"); item.textContent = text; return item;
    }));
  }

  function renderSaved() {
    const highlights = Array.isArray(state.highlights) ? state.highlights : [];
    const history = Array.isArray(state.history) ? state.history : [];
    const signature = JSON.stringify([highlights, history]);
    if (signature === savedSignature) return;
    savedSignature = signature;
    node("highlight-count").textContent = String(highlights.length);
    node("history-count").textContent = String(history.length);
    for (const [id, items] of [["highlights", highlights], ["history", history]]) {
      node(id).replaceChildren();
      if (!items.length) {
        const empty = document.createElement("li"); empty.textContent = id === "highlights" ? "尚无收藏" : "尚无历史";
        node(id).append(empty);
      }
      for (const item of items.slice(0, 100)) {
        const entry = document.createElement("li");
        entry.textContent = id === "highlights" ? String(item.text || "") : `${item.action || "阅读"} · ${item.detail || ""}`;
        const meta = document.createElement("small");
        meta.textContent = id === "highlights" ? String(item.pageLabel || "") : String(item.time || "");
        entry.append(meta); node(id).append(entry);
      }
    }
  }

  function render(next) {
    state = next || {};
    message(state.message || "拍摄或选择照片，开始阅读。", state.status === "error");
    const busy = state.status === "recognizing";
    node("cancel").hidden = !busy;
    node("progress").hidden = !busy;
    node("progress").value = Math.max(0, Math.min(1, Number(state.progress) || 0));
    const pages = state.pages || [];
    const signature = JSON.stringify(pages.map(page => [page.key, page.label]));
    if (signature !== pageSignature) {
      pageSignature = signature;
      node("page").replaceChildren();
      if (!pages.length) {
        const option = document.createElement("option"); option.value = ""; option.textContent = "等待文字识别"; node("page").append(option);
      }
      pages.forEach((page, index) => {
        const option = document.createElement("option"); option.value = String(page.key); option.textContent = page.label || `书页 ${index + 1}`; node("page").append(option);
      });
    }
    node("page").disabled = !pages.length;
    node("page").value = state.activePageKey == null ? "" : String(state.activePageKey);
    const reading = state.reading || {};
    const lines = state.activeMap?.lines || [];
    node("play").disabled = !lines.length;
    node("prev").disabled = !lines.length;
    node("next").disabled = !lines.length;
    node("save").disabled = !lines.length;
    node("export-json").disabled = !state.activeMap;
    node("export-txt").disabled = !state.activeMap;
    node("play").textContent = reading.status === "playing" ? "暂停朗读" : reading.status === "paused" ? "继续朗读" : "开始朗读";
    node("reading-status").textContent = lines.length
      ? `${reading.status === "playing" ? "正在朗读" : "当前进度"} · 第 ${Math.min(lines.length, Math.max(1, Number(reading.currentIndex) + 1 || 1))} / ${lines.length} 行`
      : "尚无可朗读文字";
    if (Number.isFinite(reading.speed)) {
      const speed = String(reading.speed);
      if (![...node("speed").options].some(option => option.value === speed)) {
        const option = document.createElement("option"); option.value = speed; option.textContent = `${speed} 倍`; node("speed").append(option);
      }
      node("speed").value = speed;
    }
    node("gestures").checked = !!state.gesturesEnabled;
    node("gesture-status").textContent = state.gestureStatus || (state.trackingReady
      ? "参考页跟踪有效，可以启用纸面手势。"
      : "照片与导入地图可点击朗读；纸面手势需要相机采集的参考页与有效跟踪。");
    const mapChanged = (state.activeMap || null) !== activeMap;
    const imageChanged = (state.activeImageUrl || "") !== activeImageUrl;
    const nextLineId = reading.currentLine?.id ?? null;
    const lineChanged = nextLineId !== currentLineId;
    currentLineId = nextLineId;
    if (mapChanged || imageChanged) {
      activeMap = state.activeMap || null;
      activeImageUrl = state.activeImageUrl || "";
      renderLines();
      loadMapImage(activeImageUrl);
    } else if (lineChanged) drawMap();
    node("lines").querySelectorAll(".reader-line").forEach(button => {
      const active = currentLineId != null && button.dataset.lineId === String(currentLineId);
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    renderSaved();
    node("gestures").disabled = gesturesPending;
    updatePhotoControls();
  }

  function contains(points, x, y) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i], [xj, yj] = points[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function exportMap(extension) {
    if (!activeMap) return;
    const text = extension === "json" ? JSON.stringify(activeMap, null, 2)
      : "\uFEFF" + (typeof activeMap.text === "string" ? activeMap.text : orderedLines().map(line => line.text).join("\n"));
    const type = extension === "json" ? "application/json;charset=utf-8" : "text/plain;charset=utf-8";
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url; link.download = `feelyreader-${Date.now()}.${extension}`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  if (typeof window.FeelyReaderController !== "function") {
    message("阅读功能尚未加载，请刷新页面后重试；相机仍可独立使用。", true);
    return;
  }
  try { controller = new window.FeelyReaderController(); }
  catch (error) { message(error.message || "阅读功能启动失败，请刷新重试。", true); return; }
  window.FeelyReaderApp = controller;
  controller.addEventListener("state", event => render(event.detail));
  render(controller.getState());
  node("photo").addEventListener("change", choosePhoto);
  node("recognize").addEventListener("click", () => attempt(() => {
    if (!pendingFile || photoLoading || state.status === "recognizing") return;
    importRevision += 1;
    controller.setConfig(readConfig());
    return controller.selectPhoto(pendingFile);
  }));
  node("json").addEventListener("change", async () => {
    const file = node("json").files?.[0]; node("json").value = "";
    if (!file) return;
    const revision = ++importRevision;
    photoRevision += 1;
    pendingFile = null;
    previewImage = null;
    photoLoading = false;
    node("photo-preview").hidden = true;
    node("file-info").textContent = "正在读取文字地图…";
    updatePhotoControls();
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error("文字地图超过 16 MiB，请使用较小的 JSON 文件。");
      const text = await file.text();
      if (revision !== importRevision) return;
      const map = JSON.parse(text);
      node("file-info").textContent = "已导入文字地图；选择照片可重新识别。";
      await controller.importMap(map);
    } catch (error) {
      if (revision === importRevision) message(error.message || "文字地图导入失败。", true);
    }
  });
  for (const id of ["engine", "endpoint", "split", "max-side", "mode", "confidence"]) node(id).addEventListener("change", changeConfig);
  node("split-position").addEventListener("input", changeConfig);
  node("rotate-left").addEventListener("click", () => { if (previewImage) { rotation = (rotation + 270) % 360; changeConfig(); } });
  node("rotate-right").addEventListener("click", () => { if (previewImage) { rotation = (rotation + 90) % 360; changeConfig(); } });
  node("page").addEventListener("change", () => {
    const page = (state.pages || []).find(item => String(item.key) === node("page").value);
    if (page) attempt(() => controller.selectPage(page.key));
  });
  node("cancel").addEventListener("click", () => attempt(() => controller.cancel()));
  node("play").addEventListener("click", () => attempt(() => state.reading?.status === "playing" ? controller.pause() : controller.play()));
  node("prev").addEventListener("click", () => attempt(() => controller.prev()));
  node("next").addEventListener("click", () => attempt(() => controller.next()));
  node("speed").addEventListener("change", () => attempt(() => controller.setSpeed(Number(node("speed").value))));
  node("save").addEventListener("click", () => attempt(() => controller.saveHighlight()));
  node("export-json").addEventListener("click", () => exportMap("json"));
  node("export-txt").addEventListener("click", () => exportMap("txt"));
  node("gestures").addEventListener("change", () => attempt(async () => {
    if (gesturesPending) return;
    const enabled = node("gestures").checked;
    gesturesPending = true;
    node("gestures").disabled = true;
    try { await controller.setGesturesEnabled(enabled); }
    finally {
      gesturesPending = false;
      node("gestures").disabled = false;
      node("gestures").checked = !!controller.getState().gesturesEnabled;
    }
  }));
  node("map").addEventListener("click", event => {
    if (!activeMap) return;
    const canvas = node("map"), bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = (event.clientX - bounds.left) * canvas.width / bounds.width;
    const y = (event.clientY - bounds.top) * canvas.height / bounds.height;
    const line = orderedLines().find(item => contains(linePolygon(item), x, y));
    if (line) attempt(() => controller.readLine(line.id));
  });
})();
