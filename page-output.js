async function exportBookPages(photo,pages,cv) {
  const image=document.createElement('img');const url=URL.createObjectURL(photo.blob);
  try {
    await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('原图解码失败'));image.src=url;});
    const src=cv.imread(image);
    try {
      const results=[];
      for(const page of pages) {
        const points=page.points.map(p=>({x:p.x*(photo.width-1),y:p.y*(photo.height-1)}));
        const width=Math.round(Math.max(pageDistance(points[0],points[1]),pageDistance(points[3],points[2])));
        const height=Math.round(Math.max(pageDistance(points[0],points[3]),pageDistance(points[1],points[2])));
        const warped=pageWarp(cv,src,points,width,height);
        try {
          const canvas=document.createElement('canvas');cv.imshow(canvas,warped.image);
          const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.95));
          if(!blob)throw new Error('页面图片生成失败');
          results.push({label:page.label,points,matrix:warped.matrix,width,height,blob,evidence:page.evidence});
          canvas.width=canvas.height=1;
        } finally {warped.image.delete();}
      }
      return results;
    } finally {src.delete();}
  } finally {URL.revokeObjectURL(url);image.src='';}
}
window.exportBookPages=exportBookPages;
