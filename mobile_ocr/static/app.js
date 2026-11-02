"use strict";

(() => {
  const el = Object.fromEntries([
    "health", "file", "file-info", "recognize", "rotate-left", "rotate-right", "rotation-value",
    "split", "mode", "max-side", "confidence", "split-control", "split-position", "split-value",
    "status", "preview", "preview-empty", "result-view", "map", "map-empty", "warnings",
    "line-count", "metrics", "line-list", "selection", "selected-text", "selected-info",
    "export-txt", "export-json"
  ].map(id => [id, document.getElementById(id)]));
  const previewContext = el.preview.getContext("2d");
  const mapContext = el.map.getContext("2d");
  const MAX_BYTES = 8 * 1024 * 1024;
  const MAX_PIXELS = 20_000_000;
  let revision = 0;
  let fileRevision = 0;
  let loading = false;
  let inflight = null;
  let sourceFile = null;
  let sourceImage = null;
  let contentType = null;
  let rotation = 0;
  let result = null;
  let regions = [];
  let regionImages = [];
  let selectedId = null;

  function status(message, error = false) {
    el.status.textContent = message;
    el.status.classList.toggle("error", error);
  }

  function controls() {
    el.recognize.disabled = !sourceImage || loading || !!inflight;
    el.recognize.textContent = inflight ? "正在识别…" : "识别文字";
    el["rotate-left"].disabled = !sourceImage || loading;
    el["rotate-right"].disabled = !sourceImage || loading;
    el["rotation-value"].textContent = `${rotation}°`;
    el["split-control"].hidden = el.split.value === "none";
    el["split-value"].textContent = `${el["split-position"].value}%`;
  }

  function clearResult() {
    result = null;
    regions = [];
    regionImages = [];
    selectedId = null;
    el.map.hidden = true;
    el["map-empty"].hidden = false;
    el["line-count"].textContent = "0";
    el.metrics.textContent = "结果按阅读顺序排列";
    el["line-list"].replaceChildren();
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "尚无识别结果";
    el["line-list"].append(empty);
    el.warnings.replaceChildren();
    el.selection.hidden = true;
    el["export-txt"].disabled = true;
    el["export-json"].disabled = true;
    const option = document.createElement("option");
    option.value = "source";
    option.textContent = "原始照片";
    el["result-view"].replaceChildren(option);
    el["result-view"].value = "source";
    el["result-view"].disabled = true;
  }

  function invalidate() {
    revision += 1;
    if (inflight) inflight.controller.abort();
    clearResult();
    controls();
    return revision;
  }

  function drawPreview() {
    if (!sourceImage) return;
    const width = sourceImage.naturalWidth, height = sourceImage.naturalHeight;
    const sideways = rotation === 90 || rotation === 270;
    el.preview.width = sideways ? height : width;
    el.preview.height = sideways ? width : height;
    previewContext.save();
    previewContext.translate(el.preview.width / 2, el.preview.height / 2);
    previewContext.rotate(rotation * Math.PI / 180);
    previewContext.drawImage(sourceImage, -width / 2, -height / 2);
    previewContext.restore();
    if (el.split.value !== "none") {
      const x = el.preview.width * Number(el["split-position"].value) / 100;
      previewContext.beginPath();
      previewContext.moveTo(x, 0);
      previewContext.lineTo(x, el.preview.height);
      previewContext.strokeStyle = "#ef9a14";
      previewContext.lineWidth = Math.max(2, el.preview.width / 350);
      previewContext.setLineDash([el.preview.width / 90, el.preview.width / 140]);
      previewContext.stroke();
      previewContext.setLineDash([]);
    }
    el.preview.hidden = false;
    el["preview-empty"].hidden = true;
  }

  function imageFrom(input) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const temporary = input instanceof Blob;
      const url = temporary ? URL.createObjectURL(input) : input;
      const release = () => { if (temporary) URL.revokeObjectURL(url); };
      image.onload = () => { release(); resolve(image); };
      image.onerror = () => { release(); reject(new Error("无法读取图片，请使用有效的 JPEG、PNG 或 WebP 文件。")); };
      // HTMLImageElement applies the image's EXIF orientation in current browsers.
      image.src = url;
    });
  }

  async function detectType(file) {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
    if ([82, 73, 70, 70].every((value, index) => bytes[index] === value) &&
        [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value)) return "image/webp";
    throw new Error("只支持 JPEG、PNG 和 WebP 格式，请先转换照片格式。");
  }

  async function chooseFile() {
    const file = el.file.files?.[0];
    el.file.value = "";
    if (!file) return;
    const token = ++fileRevision;
    invalidate();
    loading = true;
    sourceFile = null;
    sourceImage = null;
    contentType = null;
    rotation = 0;
    el.preview.hidden = true;
    el["preview-empty"].hidden = false;
    el["file-info"].textContent = "正在读取照片…";
    controls();
    status("正在读取照片…");
    try {
      if (file.size > MAX_BYTES) throw new Error("照片超过 8 MiB，请先压缩后再选择。");
      const type = await detectType(file);
      if (token !== fileRevision) return;
      const image = await imageFrom(file);
      if (token !== fileRevision) return;
      if (!image.naturalWidth || !image.naturalHeight) throw new Error("图片尺寸无效。");
      if (image.naturalWidth * image.naturalHeight > MAX_PIXELS) throw new Error("照片超过 2000 万像素，请先缩小后再选择。");
      sourceFile = file;
      sourceImage = image;
      contentType = type;
      el["file-info"].textContent = `${file.name || "所选照片"} · ${image.naturalWidth} × ${image.naturalHeight} 像素 · ${(file.size / 1024 / 1024).toFixed(2)} MiB`;
      drawPreview();
      status("照片已载入。调整方向与分割位置后，点击「识别文字」。");
    } catch (error) {
      if (token !== fileRevision) return;
      el["file-info"].textContent = "未载入照片";
      status(error.message, true);
    } finally {
      if (token === fileRevision) { loading = false; controls(); }
    }
  }

  function settingsChanged() {
    invalidate();
    drawPreview();
    status(sourceImage ? "设置已修改，请重新点击「识别文字」。" : "请选择一张照片。");
  }

  function regionIndex() {
    const value = el["result-view"].value;
    return value === "source" ? -1 : Number(value);
  }

  function belongsTo(line, region) {
    return line.region_id == null ? regions.length === 1 : line.region_id === region.id;
  }

  function visibleLines() {
    if (!result) return [];
    const index = regionIndex();
    const lines = index < 0 ? result.lines : result.lines.filter(line => belongsTo(line, regions[index]));
    return lines.slice().sort((a, b) => a.reading_order - b.reading_order);
  }

  function polygon(line) {
    return regionIndex() < 0 ? line.polygon_source : line.polygon_rectified;
  }

  function drawMap() {
    if (!result || !sourceImage) return;
    const index = regionIndex();
    const image = index < 0 ? sourceImage : regionImages[index];
    if (!image) return;
    const size = index < 0 ? result.source_size : regions[index].rectified_size;
    el.map.width = size?.[0] || image.naturalWidth;
    el.map.height = size?.[1] || image.naturalHeight;
    mapContext.drawImage(image, 0, 0, el.map.width, el.map.height);
    const stroke = Math.max(1.5, el.map.width / 550);
    for (const line of visibleLines()) {
      const points = polygon(line);
      if (!points?.length) continue;
      const selected = line.id === selectedId;
      mapContext.beginPath();
      points.forEach(([x, y], pointIndex) => pointIndex ? mapContext.lineTo(x, y) : mapContext.moveTo(x, y));
      mapContext.closePath();
      mapContext.fillStyle = selected ? "rgba(239,170,35,.28)" : "rgba(9,123,105,.08)";
      mapContext.strokeStyle = selected ? "#cf7210" : "#07816f";
      mapContext.lineWidth = selected ? stroke * 1.8 : stroke;
      mapContext.fill();
      mapContext.stroke();
    }
    el.map.hidden = false;
    el["map-empty"].hidden = true;
  }

  function regionLabel(region, index) {
    return region?.label || (regions.length === 1 ? "整页" : `区域 ${index + 1}`);
  }

  function renderLines() {
    const lines = visibleLines();
    el["line-count"].textContent = lines.length === result.lines.length ? String(lines.length) : `${lines.length} / ${result.lines.length}`;
    const total = result.timing_ms?.total;
    const size = result.source_size;
    el.metrics.textContent = `${size[0]} × ${size[1]} 像素 · ${regions.length} 个区域${Number.isFinite(total) ? ` · 处理 ${(total / 1000).toFixed(2)} 秒` : ""}`;
    el["line-list"].replaceChildren();
    if (!lines.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "未识别到文字。请检查照片清晰度、分割位置和置信度设置。";
      el["line-list"].append(empty);
    }
    const blocks = new Map((result.blocks || []).map(block => [block.id, block]));
    let lastBlock = null;
    let lastRegion = null;
    let blockNumber = 0;
    for (const [index, line] of lines.entries()) {
      if (line.block_id !== lastBlock || line.region_id !== lastRegion) {
        blockNumber += 1;
        const heading = document.createElement("p");
        heading.className = "block-heading";
        const rIndex = regions.findIndex(region => belongsTo(line, region));
        const label = regionLabel(regions[rIndex], rIndex);
        heading.textContent = `${label} · ${blocks.get(line.block_id)?.type === "heading" ? "标题" : "文字块"} ${blockNumber}`;
        el["line-list"].append(heading);
        lastBlock = line.block_id;
        lastRegion = line.region_id;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "line-item";
      button.dataset.lineId = String(line.id);
      button.setAttribute("aria-pressed", "false");
      for (const [className, text] of [["line-number", String(index + 1)], ["line-text", line.text], ["line-confidence", `${Math.round(line.confidence * 100)}%`]]) {
        const span = document.createElement("span");
        span.className = className;
        span.textContent = text;
        button.append(span);
      }
      button.addEventListener("click", () => select(line.id));
      el["line-list"].append(button);
    }
  }

  function showResult(warnings) {
    el["result-view"].replaceChildren();
    const original = document.createElement("option");
    original.value = "source";
    original.textContent = "原始照片";
    el["result-view"].append(original);
    regions.forEach((region, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `校正图 · ${regionLabel(region, index)}`;
      option.disabled = !regionImages[index];
      el["result-view"].append(option);
    });
    el["result-view"].value = "source";
    el["result-view"].disabled = false;
    el.warnings.replaceChildren(...warnings.map(message => {
      const item = document.createElement("li"); item.textContent = message; return item;
    }));
    drawMap();
    renderLines();
    el["export-txt"].disabled = false;
    el["export-json"].disabled = false;
  }

  async function recognize() {
    if (!sourceFile || !sourceImage || loading || inflight) return;
    const token = revision;
    const request = { controller: new AbortController() };
    inflight = request;
    clearResult();
    controls();
    status("正在校准照片并识别文字…");
    const params = new URLSearchParams({
      mode: el.mode.value, min_confidence: el.confidence.value, max_side: el["max-side"].value,
      rotation: String(rotation), split: el.split.value,
      split_position: String(Number(el["split-position"].value) / 100)
    });
    try {
      // Upload the original bytes unchanged. The backend applies all transforms.
      const response = await fetch(`/api/ocr?${params}`, {
        method: "POST", headers: { "Content-Type": contentType }, body: sourceFile,
        signal: request.controller.signal
      });
      let payload;
      try { payload = await response.json(); } catch { throw new Error(`服务返回无效结果（HTTP ${response.status}）。`); }
      if (!response.ok) throw new Error(payload.error || payload.detail || `识别失败（HTTP ${response.status}）。`);
      if (token !== revision) return;
      const parsedRegions = payload.regions?.length ? payload.regions : [{
        id: payload.lines?.[0]?.region_id ?? null, label: "整页", rectified_size: payload.rectified_size,
        rectified_image: payload.rectified_image, transform: payload.transform
      }];
      const images = await Promise.all(parsedRegions.map(region => region.rectified_image
        ? imageFrom(region.rectified_image).catch(() => null) : Promise.resolve(null)));
      if (token !== revision) return;
      result = payload;
      result.lines = result.lines || [];
      regions = parsedRegions;
      regionImages = images;
      const warnings = [...(payload.warnings || [])];
      images.forEach((image, index) => { if (!image) warnings.push(`${regionLabel(regions[index], index)}的校正图无法显示，可查看原始照片中的定位框。`); });
      showResult(warnings);
      status("识别完成。切换原始照片或校正分区，点击文字查看坐标。");
    } catch (error) {
      if (token !== revision || request.controller.signal.aborted) return;
      status(`识别未完成：${error.message}`, true);
    } finally {
      if (inflight === request) inflight = null;
      controls();
    }
  }

  function select(id) {
    const line = result?.lines.find(item => item.id === id);
    if (!line) return;
    selectedId = id;
    drawMap();
    el["selected-text"].textContent = line.text;
    const rounded = points => JSON.stringify(points?.map(point => point.map(value => Math.round(value * 10) / 10)) || []);
    const rIndex = regions.findIndex(region => belongsTo(line, region));
    const entries = [
      ["文字行", String(line.id)], ["区域", regionLabel(regions[rIndex], rIndex)],
      ["文字块", String(line.block_id ?? "—")], ["置信度", `${(line.confidence * 100).toFixed(1)}%`],
      ["原图多边形", rounded(line.polygon_source)], ["校正多边形", rounded(line.polygon_rectified)],
      ["原图矩形", JSON.stringify(line.bbox_source)], ["校正矩形", JSON.stringify(line.bbox_rectified)]
    ];
    el["selected-info"].replaceChildren(...entries.flatMap(([label, value]) => {
      const dt = document.createElement("dt"); dt.textContent = label;
      const dd = document.createElement("dd"); dd.textContent = value; return [dt, dd];
    }));
    el.selection.hidden = false;
    el["line-list"].querySelectorAll(".line-item").forEach(button => {
      const selected = button.dataset.lineId === String(id);
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }

  function contains(points, x, y) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i], [xj, yj] = points[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  el.file.addEventListener("change", chooseFile);
  el.recognize.addEventListener("click", recognize);
  el["rotate-left"].addEventListener("click", () => { if (!sourceImage) return; rotation = (rotation + 270) % 360; settingsChanged(); });
  el["rotate-right"].addEventListener("click", () => { if (!sourceImage) return; rotation = (rotation + 90) % 360; settingsChanged(); });
  for (const id of ["split", "mode", "max-side", "confidence"]) el[id].addEventListener("change", settingsChanged);
  el["split-position"].addEventListener("input", settingsChanged);
  el["result-view"].addEventListener("change", () => {
    if (!result) return;
    selectedId = null;
    el.selection.hidden = true;
    drawMap();
    renderLines();
  });
  el.map.addEventListener("click", event => {
    if (!result) return;
    const bounds = el.map.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * el.map.width / bounds.width;
    const y = (event.clientY - bounds.top) * el.map.height / bounds.height;
    const line = visibleLines().find(item => polygon(item)?.length && contains(polygon(item), x, y));
    if (line) select(line.id);
  });

  function download(text, extension, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `文字地图-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  el["export-txt"].addEventListener("click", () => { if (result) download("\uFEFF" + result.text, "txt", "text/plain;charset=utf-8"); });
  el["export-json"].addEventListener("click", () => { if (result) download(JSON.stringify(result, null, 2), "json", "application/json;charset=utf-8"); });
  window.addEventListener("pagehide", () => { revision += 1; if (inflight) inflight.controller.abort(); });
  controls();

  async function checkHealth() {
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      if (!response.ok) throw new Error("服务不可用");
      const health = await response.json();
      el.health.textContent = health.ready ? "识别服务就绪" : "服务已连接";
      el.health.className = "badge ready";
    } catch {
      el.health.textContent = "识别服务未连接";
      el.health.className = "badge failed";
    }
  }
  checkHealth();
})();
