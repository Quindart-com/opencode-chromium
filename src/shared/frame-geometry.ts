/** Serialized in the parent document by both owned frame backends. */
export function frameGeometryFunction() {
  return `function(x,y) {
    for(let element=this;element;element=element.parentElement||element.getRootNode()?.host) {
      const style=getComputedStyle(element),transform=style.transform;
      if(style.perspective!=='none'||(style.rotate&&style.rotate!=='none'&&style.rotate!=='0deg'))return {unsupported:true};
      if(style.scale&&style.scale!=='none'&&style.scale.split(/\\s+/).some(n=>!(Number(n)>0)))return {unsupported:true};
      if(transform&&transform!=='none') {
        const matrix=new DOMMatrixReadOnly(transform);
        if(!matrix.is2D||Math.abs(matrix.b)>0.000001||Math.abs(matrix.c)>0.000001||matrix.a<=0||matrix.d<=0)return {unsupported:true};
      }
    }
    this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
    const r=this.getBoundingClientRect(),sx=r.width/this.offsetWidth,sy=r.height/this.offsetHeight;
    if(!Number.isFinite(sx)||!Number.isFinite(sy)||x<0||y<0||x>=this.clientWidth||y>=this.clientHeight)return {clear:false};
    const px=r.left+(this.clientLeft+x)*sx,py=r.top+(this.clientTop+y)*sy;
    let hit=this.ownerDocument.elementFromPoint(px,py);
    while(hit?.shadowRoot?.elementFromPoint){const next=hit.shadowRoot.elementFromPoint(px,py);if(!next||next===hit)break;hit=next;}
    return {x:px,y:py,clear:hit===this};
  }`;
}
