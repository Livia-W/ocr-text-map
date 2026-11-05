const $ = id => document.getElementById(id);
const camera = new BookCamera($('video'));
let state = 'idle';
let operation = 0;
let photoURL = null;
let pageURLs = [];
let drawnPages = [];
let candidatePages = [];
const detector = new StabilityDetector($('video'), {
  onStatus: text => { $('stability-status').textContent = $('auto').checked ? text : AUTO_STATUS.off; },
  onStable: pages => $('auto').checked ? takePhoto(true, pages) : false,
  onIdentity: updateIdentity,
  onPages: (pages,diagnostics=[],debug={}) => {
    drawnPages=pages;candidatePages=diagnostics;drawOverlay();
    if(!$('detection-debug').open)return;
    const s=debug.stats;
    $('debug-summary').textContent=s?`第 ${s.frame} 帧 · ${s.time} · ${s.width} × ${s.height} · 有效 ${pages.length} 页`:'尚未分析视频帧';
    $('page-debug').textContent=s?[
      `轮廓总数 ${s.total}（边缘 ${s.edgeContours} / 亮度区域 ${s.regionContours}）`,
      `面积筛选后 ${s.areaPassed}；太小 ${s.areaSmall}；太大 ${s.areaLarge}；四角拟合与几何通过 ${s.quadPassed}`,
      ...s.textures.map(t=>`纹理 #${t.id} ${t.label}：行带 ${t.bands}/5，墨迹 ${(t.inkRatio*100).toFixed(2)}%，细节 ${(t.edgeRatio*100).toFixed(2)}%；${t.method}`),
      ...s.records.filter(r=>r.areaRatio>=PAGE_CONFIG.minArea).sort((a,b)=>b.areaRatio-a.areaRatio).slice(0,16).map(r=>`轮廓 #${r.id} [${r.path}] 面积 ${(r.areaRatio*100).toFixed(2)}%：${r.reason}`),
      ...diagnostics.map((d,i)=>`边界候选 ${i+1}：${d.reason}`)
    ].join('\n'):'尚未检测到页面候选';
    if(debug.metrics)$('page-debug').textContent+='\nBuild 20261105.3 ? '+JSON.stringify(debug.metrics);
    const thumb=$('debug-frame'),ctx=thumb.getContext('2d');
    thumb.width=debug.thumbnail?.width||1;thumb.height=debug.thumbnail?.height||1;
    if(debug.thumbnail) {
      ctx.drawImage(debug.thumbnail,0,0);ctx.lineWidth=3;
      for(const d of [...diagnostics.slice(0,24),...pages.map(p=>({...p,valid:true}))]) {
        if(!d.points.length)continue;ctx.strokeStyle=d.valid?'#70ff70':'#ffb347';ctx.beginPath();
        d.points.forEach((p,i)=>ctx[i?'lineTo':'moveTo'](p.x*thumb.width,p.y*thumb.height));ctx.closePath();ctx.stroke();
      }
    }
  },
  onError: error => { $('stability-status').textContent='书页检测不可用，自动拍摄已暂停'; $('cv-status').textContent=error.message; $('retry-cv').hidden=false; message(error.message, true); }
});
function updateIdentity(status='等待书页') {
  const tracker=detector.tracker;
  $('page-identity').textContent=`页面编号：${tracker.currentIds.map(id=>'P'+id).join(' / ')||'—'} · 采集次数：${tracker.captureCount} · ${status}`;
}
const liveBridge=new BookLiveBridge(camera,()=>detector.engine.cv);
window.BookReader=Object.freeze({
  getVideoElement:()=>camera.video,
  getVideoInfo:()=>liveBridge.info(),
  subscribeVideoFrames:(callback)=>liveBridge.subscribe(callback),
  subscribePageTracking:(callback)=>liveBridge.subscribeTracking(callback),
  setHandOccluded(value) {
    const changed=detector.tracker.setHandOccluded(value);
    if(changed)detector.gate.reset();
    $('hand-status').textContent=value?'已收到手部遮挡信号，暂停采集':'遮挡信号已解除，将重新稳定并比较参考页';
    if(changed)updateIdentity(value?'手部遮挡中，暂停采集':'等待书页');
  },
  getReferences:()=>detector.tracker.references.map(ref=>({...ref,content:{...ref.content,ink:ref.content.ink.slice()}}))
});
window.addEventListener('bookreader:hand-occlusion',event=>{
  if(typeof event.detail?.occluded==='boolean')window.BookReader.setHandOccluded(event.detail.occluded);
});
window.addEventListener('bookreader:cv-status',event=>{
  $('cv-status').textContent=event.detail;
  if(event.detail==='OpenCV 运行时已就绪')$('retry-cv').hidden=true;
});
$('retry-cv').addEventListener('click',async()=>{
  detector.stop();$('retry-cv').disabled=true;
  try {
    await detector.engine.ready();$('retry-cv').hidden=true;
    message('OpenCV 已就绪，可继续检测；相机未开启时请先开启相机。');syncDetection();
  } catch(error) {$('cv-status').textContent=error.message;message(error.message,true);}
  finally {$('retry-cv').disabled=false;}
});
function drawOverlay() {
  const canvas=$('overlay'), video=$('video'), box=canvas.getBoundingClientRect(), vb=video.getBoundingClientRect();
  canvas.width=Math.round(box.width);canvas.height=Math.round(box.height);
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
  if(video.hidden||!video.videoWidth)return;
  const scale=Math.min(vb.width/video.videoWidth,vb.height/video.videoHeight);
  const width=video.videoWidth*scale,height=video.videoHeight*scale;
  const ox=vb.left-box.left+(vb.width-width)/2,oy=vb.top-box.top+(vb.height-height)/2;
  ctx.strokeStyle='#ffc46b';ctx.lineWidth=2;ctx.setLineDash([6,4]);
  for(const [i,candidate] of candidatePages.entries()) {
    if(!candidate.points.length)continue;
    ctx.beginPath();candidate.points.forEach((p,j)=>ctx[j?'lineTo':'moveTo'](ox+p.x*width,oy+p.y*height));ctx.closePath();ctx.stroke();
    ctx.fillStyle='#ffc46b';ctx.font='14px sans-serif';ctx.fillText(`候选 ${i+1}`,ox+candidate.points[0].x*width+4,oy+candidate.points[0].y*height-4);
  }
  ctx.setLineDash([]);
  ctx.strokeStyle='#b5ff91';ctx.fillStyle='#b5ff91';ctx.lineWidth=3;ctx.font='bold 16px sans-serif';
  for(const page of drawnPages) {
    ctx.beginPath();page.points.forEach((p,i)=>ctx[i?'lineTo':'moveTo'](ox+p.x*width,oy+p.y*height));ctx.closePath();ctx.stroke();
    ctx.fillText(page.label,ox+page.points[0].x*width+6,oy+page.points[0].y*height+22);
  }
}
new ResizeObserver(drawOverlay).observe($('video'));
window.addEventListener('resize',drawOverlay);
function syncDetection() {
  detector.stop();
  if (state === 'live' && !document.hidden) detector.start();
  else updateInactiveStatus();
}
function updateInactiveStatus() {
  $('stability-status').textContent = $('auto').checked ? AUTO_STATUS.idle : AUTO_STATUS.off;
}
$('auto').addEventListener('change', syncDetection);

function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}
function render(next) {
  state = next;
  $('start').hidden = !['idle', 'starting'].includes(next);
  $('start').disabled = next === 'starting';
  $('start').textContent = next === 'starting' ? '正在开启…' : '开启相机';
  $('capture').hidden = !['live', 'capturing'].includes(next);
  $('capture').disabled = next !== 'live';
  $('stop').hidden = !['starting', 'live', 'capturing'].includes(next);
  $('retake').hidden = next !== 'result';
  $('download').hidden = !photoURL;
  $('video').hidden = !['starting', 'live', 'capturing'].includes(next);
  $('result').hidden = !photoURL;
  $('placeholder').hidden = next !== 'idle';
  $('phase').textContent = { idle: '相机未开启', starting: '等待相机', live: '实时画面', capturing: '正在生成照片', result: '拍摄完成 · 相机已释放' }[next];
  if (['idle', 'starting'].includes(next)) {$('resolution').textContent = '实际分辨率：—';updateIdentity('等待书页');}
}
function clearPhoto() {
  pageURLs.forEach(url=>URL.revokeObjectURL(url));pageURLs=[];
  $('page-results').replaceChildren();
  $('result').removeAttribute('src');
  $('download').removeAttribute('href');
  if (photoURL) URL.revokeObjectURL(photoURL);
  photoURL = null;
}
function explain(error) {
  const errors = {
    NotAllowedError: '摄像头权限被拒绝或被系统限制。请在 Safari 的网站设置中允许使用摄像头，再点击“开启相机”。',
    NotFoundError: '没有找到可用摄像头，请确认设备带有摄像头且已连接。',
    NotReadableError: '无法读取摄像头，可能正被其他应用占用。请关闭占用相机的应用后重试。',
    OverconstrainedError: '设备无法满足摄像头要求，请更换浏览器或设备后重试。',
    SecurityError: '相机被安全设置限制。请使用 Safari 直接打开 HTTPS 页面，并检查网站相机权限。',
    AbortError: '相机操作已中断，请重新开启相机。'
  };
  return errors[error.name] || error.message || '相机操作失败，请重试。';
}
async function start() {
  const token = ++operation;
  detector.stop();
  render('starting');
  updateInactiveStatus();
  message('请允许使用摄像头，优先请求后置摄像头。');
  try {
    await camera.start();
    if (token !== operation) return;
    render('live');
    updateResolution();
    syncDetection();
    camera.stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
      if (state === 'live' || state === 'capturing') stop('摄像头连接已中断，请重新开启相机。');
    }));
    message('请确认整张书页都在画面内，保持手机稳定后拍摄。');
  } catch (error) {
    if (token !== operation) return;
    render('idle');
    updateInactiveStatus();
    message(explain(error), true);
  }
}
function stop(text = '相机已停止，摄像头资源已释放。') {
  ++operation;
  detector.stop();
  camera.stop();
  render('idle');
  syncDetection();
  message(text);
}
function updateResolution() {
  if (state !== 'live') return;
  const { width, height } = camera.dimensions;
  $('resolution').textContent = `实际视频：${width} × ${height} px`;
}
$('start').addEventListener('click', start);
$('retake').addEventListener('click', start);
$('stop').addEventListener('click', () => stop());
$('video').addEventListener('resize', updateResolution);
$('capture').addEventListener('click', () => takePhoto(false));
async function takePhoto(automatic = false, detectedPages = []) {
  if (state !== 'live') return;
  const generation=detector.generation;
  let contentRevision=detector.tracker.revision;
  if(automatic) {
    if(detector.tracker.handOccluded)return false;
    // Validate the current frame again before capturing, rather than trusting an old overlay.
    const current=samplePageContents(detector.engine,detector.engine.detect($('video')));
    const delta=PageStabilityGate.delta(current,detectedPages);
    if(!current.length||delta.boundary>PAGE_CONFIG.boundaryTolerance||delta.texture>PAGE_CONFIG.textureTolerance) {
      detector.gate.reset();detector.tracker.pause();
      $('stability-status').textContent=AUTO_STATUS.invalid;return false;
    }
    if(detector.tracker.match(current).every(match=>match.same)) {
      detector.tracker.observe(current,performance.now(),true);
      updateIdentity('当前页已采集');return false;
    }
    detectedPages=current;
  } else if(detector.engine.cv) {
    try {detectedPages=samplePageContents(detector.engine,detector.engine.detect($('video')));}
    catch(error) {message('页面检测失败，将只保存手动拍摄原图：'+error.message,true);detectedPages=[];}
  }
  const token = ++operation;
  if (!automatic) detector.stop();
  contentRevision=detector.tracker.revision;
  render('capturing');
  try {
    const photo = await camera.capture();
    if (token !== operation) return;
    if(automatic && generation!==detector.generation) {render('live');syncDetection();return false;}
    if(automatic&&(detector.tracker.handOccluded||contentRevision!==detector.tracker.revision)){render('live');syncDetection();return false;}
    const pages=detectedPages.length ? await exportBookPages(photo,detectedPages,detector.engine.cv) : [];
    if(token!==operation)return false;
    if(automatic&&generation!==detector.generation){render('live');syncDetection();return false;}
    if(automatic&&(detector.tracker.handOccluded||contentRevision!==detector.tracker.revision)){render('live');syncDetection();return false;}
    const identity=pages.length?detector.tracker.commit(detectedPages,pages):null;
    pages.forEach((page,i)=>{page.pageId=identity.ids[i];});
    clearPhoto();
    photoURL = URL.createObjectURL(photo.blob);
    $('result').src = $('download').href = photoURL;
    $('download').download = `book-page-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
    const metadata={version:2,captureCount:detector.tracker.captureCount,pageIds:identity?.ids||[],coordinateSpace:'original-image-pixels',pointOrder:'TL,TR,BR,BL',matrixDirection:'original-to-page',
      original:{width:photo.width,height:photo.height},pages:pages.map(({blob,...data})=>data),curvedSurfaceCorrected:false};
    const addLink=(blob,label,name,parent)=>{
      const url=URL.createObjectURL(blob);pageURLs.push(url);
      const link=document.createElement('a');link.className='button secondary';link.href=url;link.download=name;link.textContent=label;parent.append(link);return url;
    };
    for(const [i,page] of pages.entries()) {
      const section=document.createElement('section'),title=document.createElement('h2');title.textContent=`${page.label} · P${page.pageId}`;
      const img=document.createElement('img');img.alt=page.label+'透视校正结果';section.append(title,img);
      img.src=addLink(page.blob,'下载'+page.label,`page-${i+1}.jpg`,section);$('page-results').append(section);
    }
    addLink(new Blob([JSON.stringify(metadata,null,2)],{type:'application/json'}),'下载坐标与转换矩阵','book-pages.json',$('page-results'));
    render('live');
    if (!automatic) syncDetection();
    updateIdentity(identity?.updated.length?'新页面已采集':identity?'当前页已采集':'等待书页');
    $('resolution').textContent = `照片：${photo.width} × ${photo.height} px`;
    message(pages.length?'原图及独立页面已保存，可分别下载。透视校正不包含曲面校正。':'未确认书页，仅保存手动拍摄原图。');
    // Integration point: event.detail = { blob, width, height }. No upload is performed.
    window.dispatchEvent(new CustomEvent('bookreader:captured', { detail: {...photo,pages,metadata} }));
    for(const reference of identity?.updated||[])window.dispatchEvent(new CustomEvent('bookreader:page-updated',{
      detail:{pageId:reference.id,referenceImage:reference.referenceImage,label:reference.label,points:reference.points,matrix:reference.matrix,
        width:reference.width,height:reference.height,captureCount:identity.captureCount,automatic}
    }));
    return true;
  } catch (error) {
    if (token !== operation) return;
    render('live');
    message(explain(error), true);
    if (!automatic) syncDetection();
    return false;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden && ['starting', 'live', 'capturing'].includes(state)) stop('页面已进入后台，相机已释放。返回后请重新开启相机。');
});
window.addEventListener('pagehide', () => {
  if (state !== 'result') stop();
  else camera.stop();
});
render('idle');
syncDetection();
if (!window.isSecureContext) message('当前不是安全连接，请使用 HTTPS 页面。手机无法通过电脑的 HTTP 局域网地址开启相机。', true);
