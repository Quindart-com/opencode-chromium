// Renderer-side inspection of our own static archive artwork, never webpage pixels.
export async function inspectArchiveArtwork() {
  const art = document.querySelector('.archive-backdrop');
  const bounds = art.getBoundingClientRect();
  const width = Math.round(bounds.width), height = Math.round(bounds.height);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const color = value => {
    context.clearRect(0,0,1,1); context.fillStyle=value; context.fillRect(0,0,1,1);
    return [...context.getImageData(0,0,1,1).data].slice(0,3);
  };
  const shapes = [...art.querySelectorAll('i')].map(element => {
    const style = getComputedStyle(element), matrix = new DOMMatrixReadOnly(style.transform);
    return { box:[style.left,style.top,style.width,style.height].map(parseFloat), matrix:[matrix.a,matrix.b,matrix.c,matrix.d], color:color(style.backgroundColor), origin:style.transformOrigin, opacity:style.opacity, filter:style.filter, shadow:style.boxShadow, blend:style.mixBlendMode, radius:style.borderTopLeftRadius };
  });
  const svg = art.querySelector('svg'), clone = svg.cloneNode(true);
  const stops = [...svg.querySelectorAll('stop')].map(stop => color(getComputedStyle(stop).stopColor));
  clone.setAttribute('width',String(width)); clone.setAttribute('height',String(height));
  [...clone.querySelectorAll('stop')].forEach((stop,index)=>{
    stop.removeAttribute('style');stop.setAttribute('stop-color',`rgb(${stops[index].join(' ')})`);
  });
  const image = new Image();
  await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('Owned gradient SVG did not rasterize'));image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(clone));});
  context.clearRect(0,0,width,height); context.drawImage(image,0,0,width,height);
  const samples = [[.01,.01],[.25,.25],[.2,.8],[.8,.2],[.5,.5],[.9,.9]].map(([u,v])=>{
    const x=Math.floor(u*width),y=Math.floor(v*height);
    // The original normalized box-to-gradient matrix gives t=.8*u+.6*v.
    // Pixel centers and both aspect ratios matter; a guessed CSS angle fails this.
    const t=Math.max(0,Math.min(1,.8*(x+.5)/width+.6*(y+.5)/height));
    const expected=stops[0].map((value,index)=>value+(stops[1][index]-value)*t);
    const observed=[...context.getImageData(x,y,1,1).data].slice(0,3);
    return {point:[x,y],expected,observed,maxError:Math.max(...observed.map((value,index)=>Math.abs(value-expected[index])))};
  });
  return {canvas:[width,height],stops,shapes,samples};
}
