let stops=[],count=0,lastTracking=null,lastDraw=-Infinity;
const status=document.getElementById('status'),canvas=document.getElementById('preview');
document.getElementById('subscribe').onclick=()=>{
 stops.forEach(f=>f());stops=[];lastTracking=null;lastDraw=-Infinity;
 const api=document.getElementById('app').contentWindow.BookReader;
 if(!api?.subscribeVideoFrames){status.textContent='采集页面尚未就绪，请稍后再点。';return;}
 canvas.hidden=false;canvas.style.opacity='1';
 stops=[api.subscribePageTracking(value=>{lastTracking=value;}),api.subscribeVideoFrames(frame=>{
 count++;if(frame.type!=='frame'){status.textContent='视频状态：'+frame.type;return;}
 if(frame.timestamp-lastDraw<200)return;lastDraw=frame.timestamp;
 const scale=Math.min(1,640/Math.max(frame.width,frame.height));
 const w=Math.round(frame.width*scale),h=Math.round(frame.height*scale);
 if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
 const ctx=canvas.getContext('2d');ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(frame.video,0,0,w,h);
 const fresh=lastTracking&&frame.timestamp-lastTracking.timestamp<400;
 const pages=fresh?lastTracking.pages.filter(p=>p.valid):[];
 status.textContent='视频帧 '+frame.frameNumber+' · 有效跟踪 '+pages.length+' 页';
 ctx.setTransform(scale,0,0,scale,0,0);
 for(const p of pages){const m=p.referenceToCurrentVideo,x=(p.referenceSize.width-1)/2,y=(p.referenceSize.height-1)/2,z=m[6]*x+m[7]*y+m[8];if(Math.abs(z)<1e-8)continue;ctx.fillStyle='red';ctx.beginPath();ctx.arc((m[0]*x+m[1]*y+m[2])/z,(m[3]*x+m[4]*y+m[5])/z,12,0,Math.PI*2);ctx.fill();}
 })];
};
document.getElementById('cancel').onclick=()=>{stops.forEach(f=>f());stops=[];canvas.hidden=true;status.textContent='已取消订阅';};
