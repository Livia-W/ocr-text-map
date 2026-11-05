/* Conservative document heuristics, not a semantic book classifier. */
const PAGE_CONFIG = Object.freeze({ interval: 120, maxSide: 640, stableMs: 800, minFrames: 4, lossMs: 700, recheckMs: 600,
  boundaryTolerance: .012, textureTolerance: 4, minArea: .07, maxCandidates: 10 });
const pageDistance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
function orderPage(points) {
  const sorted = [...points].sort((a,b) => a.y-b.y);
  const top = sorted.slice(0,2).sort((a,b) => a.x-b.x);
  const bottom = sorted.slice(2).sort((a,b) => a.x-b.x);
  return [top[0], top[1], bottom[1], bottom[0]];
}
function pageWarp(cv, src, points, width, height) {
  const objects = [];
  try {
    const a = cv.matFromArray(4,1,cv.CV_32FC2,points.flatMap(p=>[p.x,p.y])); objects.push(a);
    const b = cv.matFromArray(4,1,cv.CV_32FC2,[0,0,width-1,0,width-1,height-1,0,height-1]); objects.push(b);
    const matrix = cv.getPerspectiveTransform(a,b); objects.push(matrix);
    const output = new cv.Mat(); objects.push(output);
    cv.warpPerspective(src,output,matrix,new cv.Size(width,height),cv.INTER_LINEAR,cv.BORDER_REPLICATE);
    return { image: output.clone(), matrix: Array.from(matrix.data64F) };
  } finally { objects.reverse().forEach(x=>x.delete()); }
}

class BookPageDetector {
  constructor() { this.canvas = document.createElement('canvas'); this.diagnostics=[]; this.frameNumber=0; this.debugCanvas=document.createElement('canvas'); }
  async ready() { this.cv = await loadBookCV(); }
  detect(source) {
    const cv = this.cv;
    if (!cv) throw new Error('OpenCV 尚未就绪');
    const w = source.videoWidth || source.width, h = source.videoHeight || source.height;
    const scale = Math.min(1,PAGE_CONFIG.maxSide / Math.max(w,h));
    this.canvas.width = Math.round(w*scale); this.canvas.height = Math.round(h*scale);
    this.canvas.getContext('2d').drawImage(source,0,0,this.canvas.width,this.canvas.height);
    this.diagnostics=[];
    this.stats={frame:++this.frameNumber,time:new Date().toLocaleTimeString(),width:this.canvas.width,height:this.canvas.height,total:0,areaPassed:0,quadPassed:0,areaSmall:0,areaLarge:0,records:[],textures:[]};
    const report=(points,reason,valid=false)=>{
      this.diagnostics.push({points:points.map(p=>({x:p.x/this.canvas.width,y:p.y/this.canvas.height})),reason,valid});
    };
    const objects=[];
    const own=x=>(objects.push(x),x);
    try {
      const src=own(cv.imread(this.canvas)), gray=own(new cv.Mat()), edges=own(new cv.Mat());
      cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray,edges,new cv.Size(5,5),0);
      cv.Canny(edges,edges,45,130);
      const kernel=own(cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(7,7)));
      cv.morphologyEx(edges,edges,cv.MORPH_CLOSE,kernel);
      // Complement broken edge contours with connected luminance regions. Neither
      // path can pass without independent page geometry and text evidence.
      const region=own(new cv.Mat());
      cv.threshold(gray,region,0,255,cv.THRESH_BINARY|cv.THRESH_OTSU);
      cv.morphologyEx(region,region,cv.MORPH_CLOSE,kernel);
      if(this.debugEnabled) { this.debugCanvas.width=edges.cols;this.debugCanvas.height=edges.rows;
      const debugContext=this.debugCanvas.getContext('2d');
      if(debugContext.createImageData) {
        const image=debugContext.createImageData(edges.cols,edges.rows);
        for(let i=0;i<edges.data.length;i++){image.data[i*4]=image.data[i*4+1]=image.data[i*4+2]=edges.data[i];image.data[i*4+3]=255;}
        debugContext.putImageData(image,0,0);
      }
      }
      const contours=own(new cv.MatVector()), hierarchy=own(new cv.Mat());
      cv.findContours(edges,contours,hierarchy,cv.RETR_LIST,cv.CHAIN_APPROX_SIMPLE);
      const regionContours=own(new cv.MatVector()),regionHierarchy=own(new cv.Mat());
      cv.findContours(region,regionContours,regionHierarchy,cv.RETR_LIST,cv.CHAIN_APPROX_SIMPLE);
      const edgeCount=contours.size();
      for(let i=0;i<regionContours.size();i++) {const c=regionContours.get(i);try{contours.push_back(c);}finally{c.delete();}}
      // Separate neutral paper from similarly bright, coloured desks before closing.
      // This proposes contours only: completeness, geometry and text still apply.
      const paper=own(cv.Mat.zeros(gray.rows,gray.cols,cv.CV_8UC1));
      const paperData=paper.data,rgba=src.data;
      for(let i=0;i<paperData.length;i++) {
        const r=rgba[i*4],g=rgba[i*4+1],b=rgba[i*4+2];
        const hi=Math.max(r,g,b),lo=Math.min(r,g,b);
        paperData[i]=hi>100&&(hi-lo)/Math.max(1,hi)<.28?255:0;
      }
      const smallKernel=own(cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(3,3)));
      cv.morphologyEx(paper,paper,cv.MORPH_CLOSE,smallKernel);
      const paperContours=own(new cv.MatVector()),paperHierarchy=own(new cv.Mat());
      cv.findContours(paper,paperContours,paperHierarchy,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE);
      const paperStart=contours.size();
      for(let i=0;i<paperContours.size();i++){const c=paperContours.get(i);try{contours.push_back(c);}finally{c.delete();}}
      this.stats.paperContours=paperContours.size();
      this.stats.total=contours.size();this.stats.edgeContours=edgeCount;this.stats.regionContours=regionContours.size();
      const quads=[];
      // Recover a complete leaf when the adjoining leaf continues outside the image.
      // Require a paper envelope and a shared crease visible at BOTH ends.
      const envelope=[];
      for(let x=4;x<gray.cols-4;x++) {
        let start=-1,best=null;
        for(let y=3;y<gray.rows-3;y++) {
          if(paper.data[y*gray.cols+x]) {if(start<0)start=y;}
          else if(start>=0) {if(!best||y-start>best.bottom-best.top)best={top:start,bottom:y-1};start=-1;}
        }
        if(best&&best.bottom-best.top>gray.rows*.28)envelope.push({x,...best});
      }
      if(envelope.length>gray.cols*.3) {
        const smooth=envelope.map((e,i)=>{
          const near=envelope.slice(Math.max(0,i-3),i+4);
          const median=k=>near.map(v=>v[k]).sort((a,b)=>a-b)[Math.floor(near.length/2)];
          return {x:e.x,top:median('top'),bottom:median('bottom')};
        });
        for(let i=24;i<smooth.length-24;i++) {
          const c=smooth[i],a=smooth[i-24],b=smooth[i+24];
          const creaseBottom=Math.min(...smooth.slice(i-12,i+13).map(p=>p.bottom));
          if(c.top-Math.max(a.top,b.top)<2||Math.min(a.bottom,b.bottom)-creaseBottom<1)continue;
          for(const side of ['left','right']) {
            const outer=side==='left'?smooth[4]:smooth[smooth.length-5];
            if(Math.abs(outer.x-c.x)<gray.cols*.27||outer.x<5||outer.x>gray.cols-6)continue;
            const l=side==='left'?outer:c,r=side==='left'?c:outer;
            const points=[{x:l.x,y:l.top},{x:r.x,y:r.top},{x:r.x,y:r.bottom},{x:l.x,y:l.bottom}];
            if(points.some(p=>p.y<5||p.y>gray.rows-6))continue;
            const area=(r.x-l.x)*((l.bottom-l.top+r.bottom-r.top)/2);
            const record={id:'crease-'+i+'-'+side,path:'纸色分离',areaRatio:area/(gray.cols*gray.rows),reason:'书脊两端与纸色边界候选'};
            this.stats.records.push(record);
            quads.push({points,area,ratio:(r.x-l.x)/((l.bottom-l.top+r.bottom-r.top)/2),record});
          }
        }
      }
      for(let i=0;i<contours.size();i++) {
        const contour=contours.get(i), approx=new cv.Mat();
        try {
          const area=Math.abs(cv.contourArea(contour));
          const areaRatio=area/(gray.cols*gray.rows);
          const record={id:i+1,path:i<edgeCount?'边缘':i<paperStart?'亮度区域':'纸色分离',areaRatio,reason:''};this.stats.records.push(record);
          if(areaRatio<PAGE_CONFIG.minArea) {this.stats.areaSmall++;record.reason='面积不足（'+(areaRatio*100).toFixed(2)+'% < 7%）';continue;}
          if(areaRatio>.93) {this.stats.areaLarge++;record.reason='面积过大，疑似背景';continue;}
          this.stats.areaPassed++;
          const bounds=cv.boundingRect(contour);
          record.bounds=bounds;
          if(bounds.x<3||bounds.y<3||bounds.x+bounds.width>gray.cols-3||bounds.y+bounds.height>gray.rows-3) {
            record.reason='候选触及画面边缘：纸页不完整或背景粘连，拒绝采集';
            report([{x:bounds.x,y:bounds.y},{x:bounds.x+bounds.width,y:bounds.y},{x:bounds.x+bounds.width,y:bounds.y+bounds.height},{x:bounds.x,y:bounds.y+bounds.height}],record.reason);continue;
          }
          record.reason='待四角与纹理验证';
          const perimeter=cv.arcLength(contour,true);
          // Mildly curved page edges need not simplify to four corners at one epsilon.
          for(const epsilon of [.015,.025,.04,.055]) {
            cv.approxPolyDP(contour,approx,epsilon*perimeter,true);
            if(approx.rows===4&&cv.isContourConvex(approx))break;
          }
          if(approx.rows!==4 || !cv.isContourConvex(approx)) {
            const r=cv.boundingRect(contour);
            report([{x:r.x,y:r.y},{x:r.x+r.width,y:r.y},{x:r.x+r.width,y:r.y+r.height},{x:r.x,y:r.y+r.height}], `无法拟合凸四角：顶点 ${approx.rows}，凸性 ${cv.isContourConvex(approx)}`);record.reason=this.diagnostics.at(-1).reason;continue;
          }
          const points=orderPage(Array.from({length:4},(_,j)=>({x:approx.data32S[j*2],y:approx.data32S[j*2+1]})));
          const fit=area/Math.abs(cv.contourArea(approx));
          if(fit<.78||fit>1.22) {record.reason='轮廓与四角拟合偏差过大';report(points,record.reason);continue;}
          if(points.some(p=>p.x<4||p.y<4||p.x>gray.cols-5||p.y>gray.rows-5)) {record.reason='页面触及画面边缘，可能不完整';report(points,record.reason);continue;}
          const pw=(pageDistance(points[0],points[1])+pageDistance(points[3],points[2]))/2;
          const ph=(pageDistance(points[0],points[3])+pageDistance(points[1],points[2]))/2;
          if(pw/ph<.4 || pw/ph>2.4) {record.reason='页面比例超出支持范围';report(points,record.reason);continue;}
          this.stats.quadPassed++;
          quads.push({points,area,ratio:pw/ph,record});
          record.reason='四角通过，等待纹理评分';
        } finally { contour.delete(); approx.delete(); }
      }
      quads.sort((a,b)=>Number(b.record.path==='纸色分离')-Number(a.record.path==='纸色分离')||b.area-a.area);
      quads.slice(PAGE_CONFIG.maxCandidates).forEach(q=>q.record.reason='超出本轮纹理处理预算，优先处理较大候选');
      const candidates=[];
      for(const quad of quads.slice(0,PAGE_CONFIG.maxCandidates)) {
        if(candidates.some(c=>pageDistance(c.points[0],quad.points[0])<12)) {quad.record.reason='与已通过候选重复';continue;}
        const warped=pageWarp(cv,gray,quad.points,320,440);
        try {
          const full=warped.image;
          let splitAccepted=false;
          if(quad.ratio>1.12) {
            const seam=this.findSeam(full);
            if(seam!==null) {
              const t=seam/full.cols, p=quad.points;
              const lerp=(a,b)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
              const top=lerp(p[0],p[1]), bottom=lerp(p[3],p[2]);
              for(const [label,points] of [['左页',[p[0],top,bottom,p[3]]],['右页',[top,p[1],p[2],bottom]]]) {
                const part=pageWarp(cv,gray,points,160,220);
                try {
                  const evidence=this.texture(part.image);
                  this.stats.textures.push({id:quad.record.id,label,...evidence.metrics});
                  report(points,label+'：'+evidence.reason,evidence.valid);
                  quad.record.reason=label+'：'+evidence.reason;
                  if(evidence.valid) {candidates.push({points,label,evidence,seam:true});splitAccepted=true;}
                }
                finally { part.image.delete(); }
              }
            }
          }
          // A wide single page is valid without a seam or a companion page.
          if(!splitAccepted) {
            const evidence=this.texture(full);
            this.stats.textures.push({id:quad.record.id,label:'单页',...evidence.metrics});quad.record.reason=evidence.reason;
            report(quad.points,'单页：'+evidence.reason,evidence.valid);
            if(evidence.valid) candidates.push({...quad,label:'单页',evidence});
          }
        } finally { warped.image.delete(); }
      }
      // Keep distinct page regions; do not return nested duplicate contours.
      const accepted=[];
      for(const c of candidates) {
        const center=c.points.reduce((s,p)=>({x:s.x+p.x/4,y:s.y+p.y/4}),{x:0,y:0});
        if(accepted.some(a=>pageDistance(a.center,center)<Math.min(gray.cols,gray.rows)*.18)) continue;
        accepted.push({...c,center});
        if(accepted.length===2) break;
      }
      accepted.sort((a,b)=>a.center.x-b.center.x);
      if(accepted.length===2) {
        const [a,b]=accepted;
        const ha=(pageDistance(a.points[0],a.points[3])+pageDistance(a.points[1],a.points[2]))/2;
        const hb=(pageDistance(b.points[0],b.points[3])+pageDistance(b.points[1],b.points[2]))/2;
        // Independent contours must plausibly share a binding, not just be two rectangles.
        const adjoining=(pageDistance(a.points[1],b.points[0])+pageDistance(a.points[2],b.points[3]))/2;
        if(Math.min(ha,hb)/Math.max(ha,hb)<.7 || adjoining>Math.min(ha,hb)*.18 || Math.abs(a.center.y-b.center.y)>Math.min(ha,hb)*.18) {
          accepted.splice(1);accepted[0].label='单页';
        }
      }
      if(accepted.length===2) { accepted[0].label='左页'; accepted[1].label='右页'; }
      else if(accepted.length===1)accepted[0].label='单页';
      if(!this.diagnostics.length)this.diagnostics.push({points:[],valid:false,reason:'未找到完整页面轮廓：请增加页面占比、调整光线并保留四周边距'});
      return accepted.map(c=>({label:c.label, points:c.points.map(p=>({x:p.x/gray.cols,y:p.y/gray.rows})),
        signature:c.evidence.signature, evidence:{contour:true,texture:true,seam:!!c.seam}, confidence:'heuristic'}));
    } finally { objects.reverse().forEach(x=>x.delete()); }
  }
  track(source,pages) {
    // Geometry must be measured; stale coordinates are never tracking evidence.
    return this.detect(source);
  }

  texture(mat) {
    const w=mat.cols,h=mat.rows,d=mat.data, rows=[]; let dark=0,total=0, transitions=0;
    let binary;
    if(this.cv) {
      binary=new this.cv.Mat();
      try {this.cv.adaptiveThreshold(mat,binary,255,this.cv.ADAPTIVE_THRESH_GAUSSIAN_C,this.cv.THRESH_BINARY_INV,31,8);}
      catch(error){binary.delete();throw error;}
    }
    // Local contrast threshold follows page illumination; fixed 155 is no longer used.
    const inkAt=(x,y)=>binary ? binary.data[y*w+x]!==0 : d[y*w+x]<128;
    const signature=[];
    // Text-like small horizontal runs on several separated lines, spread across page.
    let activeBands=0, previous=false;
    for(let y=Math.floor(h*.12);y<h*.88;y++) {
      let ink=0,runs=0,run=0;
      for(let x=Math.floor(w*.12);x<w*.88;x++) {
        const local=inkAt(x,y);
        if(local) { ink++;run++; } else if(run) { if(run>=1&&run<w*.09) runs++; run=0; }
        dark+=Number(local); total++;
        if(x>1) transitions+=Number(local!==inkAt(x-1,y));
      }
      const line=ink>w*.025&&ink<w*.48&&runs>=4;
      if(line&&!previous) activeBands++;
      previous=line; rows.push(line);
    }
    for(let gy=0;gy<16;gy++) for(let gx=0;gx<12;gx++) {
      let sum=0,count=0;
      for(let y=Math.floor((.1+gy*.8/16)*h);y<(.1+(gy+1)*.8/16)*h;y++)
        for(let x=Math.floor((.1+gx*.8/12)*w);x<(.1+(gx+1)*.8/12)*w;x++) {sum+=d[y*w+x];count++;}
      signature.push(sum/Math.max(count,1));
    }
    const reasons=[];
    if(activeBands<5)reasons.push(`文字行状纹理不足（${activeBands}/5 行）`);
    if(dark/total<=.025)reasons.push('页内纹理过少或过亮');
    if(dark/total>=.38)reasons.push('暗色占比过高，可能是阴影或遮挡');
    if(transitions/total<=.025)reasons.push('细节边缘不足，可能失焦或为纯色物体');
    binary?.delete();
    return {valid:!reasons.length,reason:reasons.join('；')||'轮廓与页内纹理通过',signature,
      metrics:{bands:activeBands,inkRatio:dark/total,edgeRatio:transitions/total,method:binary?'局部自适应阈值 31 / 8':'测试替身阈值'}};
  }
  findSeam(mat) {
    const w=mat.cols,h=mat.rows,d=mat.data; let best=null,score=0;
    for(let x=Math.floor(w*.38);x<w*.62;x++) {
      let support=0,contrast=0;
      for(let y=Math.floor(h*.08);y<h*.92;y++) {
        const v=d[y*w+x], outer=(d[y*w+x-12]+d[y*w+x+12])/2;
        if(outer-v>12) support++;
        contrast+=outer-v;
      }
      if(support/(h*.84)>.65&&contrast>score) {score=contrast;best=x;}
    }
    return best;
  }
}
window.BookPageDetector=BookPageDetector;
window.pageWarp=pageWarp;
