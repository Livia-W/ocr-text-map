/* A interface: row-major homographies; intrinsic, unmirrored pixels. */
class BookLiveBridge {
  constructor(camera,getCV){
    this.camera=camera;this.getCV=getCV;this.frames=new Set();this.listeners=new Set();this.refs=[];this.number=0;this.lastMedia=-1;this.active=false;this.busy=false;this.revision=0;
    window.addEventListener('bookreader:captured',e=>this.install(e.detail));
    document.addEventListener('visibilitychange',()=>{if(document.hidden)this.invalidate('background');});
    this.loop=this.loop.bind(this);requestAnimationFrame(this.loop);
  }
  info(){const v=this.camera.video;return {video:v,width:v.videoWidth,height:v.videoHeight,coordinateSpace:'currentVideo',units:'pixels',origin:'top-left',xDirection:'right',yDirection:'down',mirrored:false};}
  subscribe(callback){const item={callback,busy:false};this.frames.add(item);return ()=>this.frames.delete(item);}
  subscribeTracking(callback){const item={callback,busy:false};this.listeners.add(item);return ()=>this.listeners.delete(item);}
  emit(set,value){for(const item of set){if(item.busy)continue;item.busy=true;Promise.resolve().then(()=>{if(set.has(item))return item.callback(value);}).catch(console.error).finally(()=>item.busy=false);}}
  invalidate(reason){this.emit(this.frames,{type:'state',state:reason,timestamp:performance.now(),frameNumber:this.number});this.emit(this.listeners,{timestamp:performance.now(),pages:this.refs.map(r=>({pageId:r.id,valid:false,reason,referenceToCurrentVideo:null,currentVideoToReference:null}))});}
  loop(now){requestAnimationFrame(this.loop);const v=this.camera.video;const active=!document.hidden&&!!this.camera.stream&&v.readyState>=2;
    if(!active){if(this.active)this.invalidate(document.hidden?'background':'stopped');this.active=false;return;}this.active=true;
    if(v.currentTime===this.lastMedia)return;this.lastMedia=v.currentTime;
    const frame={...this.info(),type:'frame',timestamp:now,mediaTime:v.currentTime,frameNumber:++this.number};this.emit(this.frames,frame);
    if(this.listeners.size&&!this.busy&&now-(this.lastTrack||0)>120){this.lastTrack=now;this.busy=true;try{this.track(frame);}catch(error){this.invalidate('tracking-error: '+error.message);}finally{this.busy=false;}}
  }
  async install(photo){const revision=++this.revision;this.refs=[];this.invalidate('reference-changing');const bitmap=await createImageBitmap(photo.blob);try{
    const canvas=document.createElement('canvas'),scale=Math.min(1,640/Math.max(photo.width,photo.height));canvas.width=Math.round(photo.width*scale);canvas.height=Math.round(photo.height*scale);canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    if(revision!==this.revision)return;const cv=this.getCV(),src=cv.imread(canvas),gray=new cv.Mat();try{cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY);this.refs=photo.pages.map(p=>({id:p.pageId,captureCount:photo.metadata.captureCount,width:p.width,height:p.height,matrix:p.matrix,points:p.points,gray:new Uint8Array(gray.data),cols:gray.cols,rows:gray.rows,scaleX:gray.cols/photo.width,scaleY:gray.rows/photo.height}));}finally{gray.delete();src.delete();}
  }finally{bitmap.close();}}
  track(frame){const cv=this.getCV();if(!cv||!this.refs.length)return;const results=[];
    for(const r of this.refs){const owned=[],own=x=>(owned.push(x),x);let result={pageId:r.id,referenceCaptureCount:r.captureCount,timestamp:frame.timestamp,frameNumber:frame.frameNumber,referenceSize:{width:r.width,height:r.height},videoSize:{width:frame.width,height:frame.height},units:'pixels',pointOrder:'TL,TR,BR,BL',matrixDirection:'reference-to-currentVideo',valid:false,referenceToCurrentVideo:null,currentVideoToReference:null,reason:'insufficient geometric evidence'};
      try{const canvas=document.createElement('canvas');canvas.width=r.cols;canvas.height=r.rows;canvas.getContext('2d').drawImage(frame.video,0,0,r.cols,r.rows);
        const src=own(cv.imread(canvas)),current=own(new cv.Mat()),reference=own(cv.matFromArray(r.rows,r.cols,cv.CV_8UC1,r.gray));cv.cvtColor(src,current,cv.COLOR_RGBA2GRAY);
        const mask=own(cv.Mat.zeros(r.rows,r.cols,cv.CV_8UC1));const xs=r.points.map(p=>p.x*r.scaleX),ys=r.points.map(p=>p.y*r.scaleY);
        // Interior bounding rectangle excludes most background; final inliers must span the page.
        const x=Math.ceil(Math.min(...xs)),y=Math.ceil(Math.min(...ys)),w=Math.floor(Math.max(...xs))-x,h=Math.floor(Math.max(...ys))-y;
        const roi=own(mask.roi(new cv.Rect(x,y,w,h)));roi.setTo(new cv.Scalar(255));
        const a=own(new cv.Mat()),b=own(new cv.Mat()),status=own(new cv.Mat()),error=own(new cv.Mat());cv.goodFeaturesToTrack(reference,a,100,.02,8,mask);if(a.rows<12)throw Error('few reference features');
        cv.calcOpticalFlowPyrLK(reference,current,a,b,status,error,new cv.Size(31,31),4);
        const from=[],to=[];for(let i=0;i<a.rows;i++)if(status.data[i]&&error.data32F[i]<20){from.push(a.data32F[2*i],a.data32F[2*i+1]);to.push(b.data32F[2*i],b.data32F[2*i+1]);}
        if(from.length<24)throw Error('flow lost');const am=own(cv.matFromArray(from.length/2,1,cv.CV_32FC2,from)),bm=own(cv.matFromArray(to.length/2,1,cv.CV_32FC2,to)),inliers=own(new cv.Mat());const H=own(cv.findHomography(am,bm,cv.RANSAC,2,inliers));
        const count=Array.from(inliers.data).reduce((a,b)=>a+!!b,0),ratio=count/(from.length/2);if(H.empty()||count<12||ratio<.7)throw Error('geometry rejected');
        const mul=(a,b)=>Array.from({length:9},(_,i)=>{let n=0;for(let k=0;k<3;k++)n+=a[Math.floor(i/3)*3+k]*b[k*3+i%3];return n;});
        const pm=own(cv.matFromArray(3,3,cv.CV_64F,r.matrix)),inv=own(new cv.Mat());cv.invert(pm,inv);
        const M=mul([frame.width/r.cols,0,0,0,frame.height/r.rows,0,0,0,1],mul(Array.from(H.data64F),mul([r.scaleX,0,0,0,r.scaleY,0,0,0,1],Array.from(inv.data64F))));
        const mm=own(cv.matFromArray(3,3,cv.CV_64F,M)),mi=own(new cv.Mat());cv.invert(mm,mi);
        const project=(x,y)=>{const z=M[6]*x+M[7]*y+M[8];return {x:(M[0]*x+M[1]*y+M[2])/z,y:(M[3]*x+M[4]*y+M[5])/z};};const corners=[[0,0],[r.width-1,0],[r.width-1,r.height-1],[0,r.height-1]].map(p=>project(...p));if(corners.some(p=>!Number.isFinite(p.x)||p.x<0||p.y<0||p.x>frame.width||p.y>frame.height))throw Error('outside video');
        result={...result,valid:true,reason:'LK + RANSAC',corners,referenceToCurrentVideo:M,currentVideoToReference:Array.from(mi.data64F),quality:{features:a.rows,matches:from.length/2,inliers:count,inlierRatio:ratio}};
      }catch(error){result.reason=error.message;}finally{owned.reverse().forEach(x=>x.delete());}results.push(result);
    }this.emit(this.listeners,{timestamp:frame.timestamp,frameNumber:frame.frameNumber,pages:results});
  }
}
window.BookLiveBridge=BookLiveBridge;
