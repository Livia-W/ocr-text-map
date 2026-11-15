// Content identity is independent of camera coordinates and detector lifetime.
const CONTENT_CONFIG=Object.freeze({width:96,height:128,same:.32,changed:.55,
  changedTiles:.35,confirmMs:0,minSamples:3,maxReferences:4});
function pageContentFeature(data,width,height) {
  const ink=new Uint8Array(width*height);
  const stride=width+1,sums=new Float64Array(stride*(height+1)),squares=new Float64Array(sums.length);
  for(let y=0;y<height;y++) {
    let row=0,square=0;
    for(let x=0;x<width;x++){const v=data[y*width+x];row+=v;square+=v*v;const k=(y+1)*stride+x+1;sums[k]=sums[k-stride]+row;squares[k]=squares[k-stride]+square;}
  }
  const {min,max,sqrt}=Math;
  // Local mean/variance removes additive illumination and tolerates contrast shifts.
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const x0=max(0,x-4),x1=min(width,x+5),y0=max(0,y-4),y1=min(height,y+5);
    const a=y0*stride+x0,b=y0*stride+x1,c=y1*stride+x0,d=y1*stride+x1,n=(x1-x0)*(y1-y0);
    const mean=(sums[d]-sums[b]-sums[c]+sums[a])/n;
    const std=sqrt(max(0,(squares[d]-squares[b]-squares[c]+squares[a])/n-mean*mean));
    ink[y*width+x]=+(mean-data[y*width+x]>max(4,std*.4));
  }
  return {width,height,ink};
}
function comparePageContent(a,b) {
  if(!a||!b||a.width!==b.width||a.height!==b.height)return {distance:1,changedTiles:1};
  const w=a.width,h=a.height;let best={distance:1,changedTiles:1};
  // Compensate small residual registration errors after four-point rectification.
  const x0=Math.ceil(w*.1),y0=Math.ceil(h*.1);
  for(const dy of [0,-1,1,-2,2])for(const dx of [0,-1,1,-2,2]) {
    let mismatch=0,union=0;const tileMismatch=new Uint32Array(16),tileUnion=new Uint32Array(16);
    for(let y=y0;y<h*.9;y++)for(let x=x0;x<w*.9;x++) {
      const av=a.ink[y*w+x],bv=b.ink[(y+dy)*w+x+dx],u=av|bv,m=av^bv;
      union+=u;mismatch+=m;const tile=((y/h*4)|0)*4+((x/w*4)|0);tileMismatch[tile]+=m;tileUnion[tile]+=u;
    }
    const distance=union?mismatch/union:0;
    let changed=0;for(let t=0;t<16;t++)if(tileUnion[t]>4&&tileMismatch[t]/tileUnion[t]>.45)changed++;
    if(distance<best.distance)best={distance,changedTiles:changed/16};
    if(distance<=.015)return best;
  }
  return best;
}
function samplePageContents(engine,pages) {
  if(!pages.length)return [];
  const cv=engine.cv,src=cv.imread(engine.canvas),gray=new cv.Mat();
  try {
    cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY);
    return pages.map(page=>{
      const points=page.points.map(p=>({x:p.x*(gray.cols-1),y:p.y*(gray.rows-1)}));
      const warped=pageWarp(cv,gray,points,CONTENT_CONFIG.width,CONTENT_CONFIG.height);
      try{return {...page,content:pageContentFeature(warped.image.data,warped.image.cols,warped.image.rows)};}
      finally{warped.image.delete();}
    });
  }finally{gray.delete();src.delete();}
}
class PageContentTracker {
  constructor(config=CONTENT_CONFIG) {
    this.config=config;this.references=[];this.nextId=1;this.captureCount=0;this.currentIds=[];
    this.revision=0;this.handOccluded=false;this.pause();
  }
  pause(){this.pending=null;this.revision++;}
  setHandOccluded(value){
    if(typeof value!=='boolean')throw new TypeError('遮挡输入必须为 boolean');
    if(this.handOccluded===value)return false;
    this.handOccluded=value;this.pause();return true;
  }
  match(pages) {
    const used=new Set();
    return pages.map(page=>{
      let best=null;
      for(const ref of this.references) {
        if(used.has(ref.id))continue;
        const metrics=comparePageContent(page.content,ref.content);
        if(!best||metrics.distance<best.distance)best={ref,...metrics};
      }
      if(best&&best.distance<=this.config.same){used.add(best.ref.id);return {id:best.ref.id,same:true,...best};}
      return {same:false,distance:1,changedTiles:1,...best};
    });
  }
  observe(pages,now,stable) {
    if(this.handOccluded){this.pending=null;return {status:'手部遮挡中，暂停采集'};}
    if(!pages.length){this.pending=null;return {status:'等待书页'};}
    if(!stable){this.pending=null;return {status:'页面移动中'};}
    const matches=this.match(pages);
    if(matches.every(m=>m.same)) {
      this.pending=null;this.currentIds=matches.map(m=>m.id);return {status:'当前页已采集',matches};
    }
    if(!stable){this.pending=null;return {status:'页面移动中'};}
    const unknown=matches.filter(m=>!m.same);
    if(this.references.length&&unknown.some(m=>m.distance<this.config.changed||m.changedTiles<this.config.changedTiles)) {
      this.pending=null;return {status:'内容变化不确定，保留原底图'};
    }
    if(!this.references.length)return {capture:true,status:'首次书页稳定，准备采集'};
    if(!this.pending||this.pending.pages.length!==pages.length||pages.some((p,i)=>comparePageContent(p.content,this.pending.pages[i].content).distance>this.config.same)) {
      this.pending={pages,since:now,samples:1};return {status:'内容变化确认中'};
    }
    this.pending.samples++;
    return {capture:now-this.pending.since>=this.config.confirmMs&&this.pending.samples>=this.config.minSamples,status:'内容变化确认中'};
  }
  commit(pages,outputs) {
    const matches=this.match(pages),updated=[];
    this.currentIds=matches.map((match,i)=>{
      if(match.same)return match.id;
      const ref={id:this.nextId++,content:pages[i].content,referenceImage:outputs[i].blob,label:outputs[i].label,
        points:outputs[i].points,matrix:outputs[i].matrix,width:outputs[i].width,height:outputs[i].height};
      this.references.push(ref);updated.push(ref);return ref.id;
    });
    while(this.references.length>this.config.maxReferences) {
      const index=this.references.findIndex(r=>!this.currentIds.includes(r.id));this.references.splice(index<0?0:index,1);
    }
    this.captureCount++;this.pause();return {updated,ids:[...this.currentIds],captureCount:this.captureCount};
  }
}
window.PageContentTracker=PageContentTracker;
window.comparePageContent=comparePageContent;
window.pageContentFeature=pageContentFeature;
window.samplePageContents=samplePageContents;
