/* Local single-file OpenCV build. WASM is embedded in vendor/opencv/opencv.js. */
const BOOK_CV_URL = new URL('vendor/opencv/opencv.js', document.currentScript.src);
let bookCVTask = null;
let bookCVReady = null;
function cvLoadStatus(text) {
  window.dispatchEvent(new CustomEvent('bookreader:cv-status', {detail:text}));
}
function loadBookCV() {
  if (bookCVReady) return Promise.resolve(bookCVReady);
  if (bookCVTask) return bookCVTask;
  bookCVTask = initializeBookCV().catch(error => { bookCVTask=null; throw error; });
  return bookCVTask;
}
async function initializeBookCV() {
  if (!window.WebAssembly) throw new Error('OpenCV 初始化失败：此浏览器不支持 WebAssembly，请更新 Safari。');
  const controller=new AbortController();
  const downloadTimer=setTimeout(()=>controller.abort(),90000);
  let source;
  cvLoadStatus('正在下载本地 OpenCV 依赖…');
  try {
    const response=await fetch(BOOK_CV_URL,{signal:controller.signal,cache:'default'});
    if(!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}；文件：${BOOK_CV_URL.pathname}，请检查发布目录和大小写`);
    source=await response.text();
    if(source.length<100000||/^\s*</.test(source)) throw new Error('返回内容不是完整的 OpenCV JavaScript 文件，可能是 404 HTML 页面或上传不完整');
  } catch(error) {
    throw new Error(error.name==='AbortError'?'OpenCV 下载超时（90 秒），请检查网络后重试。':`OpenCV 下载失败：${error.message}`);
  } finally {clearTimeout(downloadTimer);}
  cvLoadStatus('OpenCV 已下载，正在初始化 WebAssembly…');
  return new Promise((resolve,reject)=>{
    let done=false, poll, timeout, blobURL;
    const script=document.createElement('script');
    const cleanup=()=>{clearInterval(poll);clearTimeout(timeout);script.remove();if(blobURL)URL.revokeObjectURL(blobURL);window.removeEventListener('error',onScriptError);};
    const fail=reason=>{if(done)return;done=true;cleanup();reject(new Error(`OpenCV 初始化失败：${reason}；自动拍摄已暂停，仍可手动拍摄原图。`));};
    const probe=module=>{
      if(done||!module?.Mat||module.calledRun===false)return;
      let mat;
      try {
        // Constructor + allocation tests that WASM really is running, not just downloaded.
        mat=new module.Mat(1,1,module.CV_8UC1);
        if(!mat.data||mat.data.length!==1)throw new Error('WASM 内存尚未就绪');
        for(const name of ['findContours','getPerspectiveTransform','warpPerspective'])if(typeof module[name]!=='function')throw new Error('缺少接口 '+name);
      } catch(error) {fail(error.message);return;}
      finally {mat?.delete();}
      // This pinned build has a legacy .then() resolving to itself. Native Promise
      // assimilation would recurse forever; runtime is ready so remove that hook.
      if(typeof module.then==='function')delete module.then;
      done=true;bookCVReady=module;cleanup();cvLoadStatus('OpenCV 运行时已就绪');resolve(module);
    };
    const config={locateFile:name=>new URL(name,BOOK_CV_URL).href,
      onRuntimeInitialized(){probe(window.cv || config);},
      onAbort:reason=>fail('WebAssembly 中止：'+String(reason)),
      printErr:line=>console.warn('[OpenCV]',line)};
    const onScriptError=event=>{if(event.filename===blobURL)fail(event.message||'脚本执行错误');};
    window.addEventListener('error',onScriptError);
    window.Module=config;
    window.cv=undefined;
    timeout=setTimeout(()=>fail('运行时初始化超时（60 秒），可能是设备内存不足或 WebAssembly 被限制'),60000);
    let observed;
    const inspect=()=>{
      const module=window.cv;
      if(module)module.onAbort=reason=>fail('WebAssembly 中止：'+String(reason));
      if(module?.Mat)probe(module);
      else if(module&&module!==observed&&typeof module.then==='function') {
        observed=module;
        // Do not await legacy Emscripten self-resolving thenables.
        module.then(value=>probe(value),error=>fail(String(error)));
      }
    };
    poll=setInterval(inspect,50);
    script.onerror=()=>fail('本地脚本执行被浏览器阻止（请检查内容安全策略）');
    script.onload=inspect;
    blobURL=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
    script.src=blobURL;document.head.append(script);
  });
}
window.loadBookCV=loadBookCV;
