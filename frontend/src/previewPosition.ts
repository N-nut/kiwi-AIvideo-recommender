export interface PreviewAnchor {left:number;right:number;top:number;bottom:number}
export interface PreviewLayout {side:'left'|'right'|'inline';left:number;top:number;width:number}

// Never clamp a floating preview back onto its own source card.
export function sidePreviewPosition(anchor:PreviewAnchor, viewport:{width:number;height:number}, preferredWidth=360, aspectRatio=16/9):PreviewLayout {
  const margin=12,gap=12,minWidth=240;
  const rightSpace=viewport.width-margin-anchor.right-gap,leftSpace=anchor.left-margin-gap;
  const side=rightSpace>=preferredWidth?'right':leftSpace>=preferredWidth?'left':rightSpace>=leftSpace?'right':'left';
  const available=side==='right'?rightSpace:leftSpace;
  if(available<minWidth) return {side:'inline',left:0,top:0,width:Math.max(0,viewport.width-margin*2)};
  const ratio=Number.isFinite(aspectRatio)&&aspectRatio>0?aspectRatio:16/9;
  const width=Math.min(preferredWidth,available,Math.max(0,viewport.height-margin*2)*ratio);
  const height=width/ratio;
  return {side,left:side==='right'?anchor.right+gap:anchor.left-gap-width,
    top:Math.max(margin,Math.min(anchor.top,viewport.height-margin-height)),width};
}
