const AUTO_STATUS=Object.freeze({off:'自动拍摄已关闭',idle:'请先开启相机',moving:'画面移动中',waiting:'等待画面稳定',captured:'已拍摄，请移动或翻页',invalid:'未确认书页，请调整位置'});
window.AUTO_STATUS=AUTO_STATUS;
class PageStabilityGate {
  constructor(config=PAGE_CONFIG) {this.config=config;this.reset();}
  reset() {this.previous=null;this.anchor=null;this.since=null;this.last=null;this.captured=null;this.elapsed=0;this.frames=0;this.bad=0;this.lostSince=null;}
  static delta(a,b) {
    if(!a||!b||a.length!==b.length) return {boundary:Infinity,texture:Infinity};
    b=[...b];a=a.map(p=>({...p,points:orderPage(p.points)}));
    b=b.map(p=>({...p,points:orderPage(p.points)}));
    if(a.length===2&&pageDistance(a[0].points[0],b[1].points[0])<pageDistance(a[0].points[0],b[0].points[0]))b.reverse();
    let boundary=0,sum=0,n=0;
    a.forEach((p,i)=>{p.points.forEach((v,j)=>{boundary=Math.max(boundary,pageDistance(v,b[i].points[j]));});
      if(p.content&&b[i].content){sum+=comparePageContent(p.content,b[i].content).distance*20;n++;}
      else p.signature.forEach((v,j)=>{sum+=Math.abs(v-b[i].signature[j]);n++;});});
    return {boundary,texture:sum/Math.max(1,n)};
  }
  update(pages,now) {
    const dt=this.last===null?0:now-this.last;this.last=now;
    const result=(status,reason,shoot=false)=>({status,reason,shoot,boundary:this.metrics?.boundary||0,motion:this.metrics?.texture||0,remaining:Math.max(0,this.config.stableMs-(this.elapsed||0))});
    if(!pages.length) {
      this.lostSince??=now;
      if(now-this.lostSince>this.config.lossMs){this.previous=this.anchor=null;this.elapsed=0;this.frames=0;}
      return result(AUTO_STATUS.invalid,'detection lost; timer paused');
    }
    const resumed=this.lostSince!=null;this.lostSince=null;
    const same=d=>d.boundary<=this.config.boundaryTolerance&&d.texture<=this.config.textureTolerance;
    this.metrics=PageStabilityGate.delta(pages,this.previous);
    if(this.captured&&same(PageStabilityGate.delta(pages,this.captured)))return result(AUTO_STATUS.captured,'captured content unchanged');
    if(!this.previous){this.previous=this.anchor=pages;this.elapsed=0;this.frames=1;return result(AUTO_STATUS.waiting,'observation started');}
    const stable=same(this.metrics)&&same(PageStabilityGate.delta(pages,this.anchor));
    if(!stable){
      this.bad=(this.bad||0)+1;
      if(this.bad>=2){this.anchor=this.previous=pages;this.elapsed=0;this.frames=1;return result(AUTO_STATUS.moving,'persistent boundary or content motion');}
      return result(AUTO_STATUS.waiting,'isolated anomaly; timer paused');
    }
    this.bad=0;this.previous=pages;
    // Delays do not imply motion, nor count as unobserved stable evidence.
    this.elapsed=(this.elapsed||0)+(resumed?0:Math.min(dt,this.config.interval*2));this.frames=(this.frames||0)+1;
    return result(AUTO_STATUS.waiting,'stable observation',this.elapsed>=this.config.stableMs&&this.frames>=this.config.minFrames);
  }
  commit(pages) {this.captured=pages;this.since=null;this.anchor=null;}
}
class StabilityDetector {
  constructor(video,{onStatus,onStable,onError,onPages=()=>{},onIdentity=()=>{}}) {
    Object.assign(this,{video,onStatus,onStable,onError,onPages,onIdentity});
    this.engine=new BookPageDetector();this.gate=new PageStabilityGate();this.generation=0;this.pages=[];
    this.tracker=new PageContentTracker();
  }
  start() {
    this.stop();const generation=this.generation;
    this.onStatus('正在加载书页检测…');
    const tick=async()=>{
      if(generation!==this.generation) return;
      try {
        const started=performance.now();this.engine.debugEnabled=!!document.getElementById('detection-debug')?.open;
        const full=!this.pages.length||!this.validatedAt||started-this.validatedAt>=PAGE_CONFIG.recheckMs;
        const detected=this.video.readyState>=2?(full?this.engine.detect(this.video):this.engine.track(this.video,this.pages)):[];
        if(full)this.validatedAt=started;
        let pages=samplePageContents(this.engine,detected);
        if(full&&this.pages.length&&pages.length!==this.pages.length) {
          this.layoutMisses=(this.layoutMisses||0)+1;
          if(this.layoutMisses<2){pages=[];this.validatedAt=0;}
        } else if(full)this.layoutMisses=0;
        this.pages=pages;
        const now=performance.now();
        if(this.tracker.handOccluded)this.gate.reset();
        const result=this.gate.update(pages,now);
        const identity=this.tracker.observe(pages,now,!!result.shoot);
        const status=identity.status==='页面移动中'?result.status:identity.status;
        const elapsed=performance.now()-started;
        this.onPages(pages,this.engine.debugEnabled?this.engine.diagnostics:[],{stats:this.engine.stats,thumbnail:this.engine.debugCanvas,metrics:{...result,elapsed,hz:1000/Math.max(1,now-(this.lastTick||now)),full}});this.lastTick=now;
        this.onStatus(elapsed>600?'处理较慢 · '+status:status);this.onIdentity(status);
        if(identity.capture) {
          const ok=await this.onStable(pages);
          if(generation!==this.generation)return;
          if(ok) {this.gate.commit(pages);this.onStatus('新页面已采集');this.onIdentity('新页面已采集');}
        }
      } catch(error) {this.stop();this.onError(error);return;}
      if(generation===this.generation)this.timer=setTimeout(tick,PAGE_CONFIG.interval);
    };
    this.engine.ready().then(()=>{if(generation===this.generation)tick();}).catch(error=>{if(generation===this.generation){this.stop();this.onError(error);}});
  }
  stop() {this.validatedAt=0;this.layoutMisses=0;this.generation++;clearTimeout(this.timer);this.pages=[];this.gate.reset();this.tracker.pause();this.onPages([]);}
}
window.StabilityDetector=StabilityDetector;
window.PageStabilityGate=PageStabilityGate;
