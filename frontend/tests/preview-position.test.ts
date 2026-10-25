import { describe,expect,it } from 'vitest';
import { sidePreviewPosition } from '../src/previewPosition';

describe('preview beside its source card',()=>{
  it('prefers the right, flips at the right edge and keeps the source card clear',()=>{
    for(const anchor of [{left:40,right:300,top:100,bottom:700},{left:1080,right:1340,top:100,bottom:700}]) {
      const result=sidePreviewPosition(anchor,{width:1440,height:900});
      expect(result.side).toBe(anchor.left===40?'right':'left');
      expect(result.left>=anchor.right+12||result.left+result.width<=anchor.left-12).toBe(true);
      expect(result.left).toBeGreaterThanOrEqual(12);expect(result.left+result.width).toBeLessThanOrEqual(1428);
    }
  });
  it('uses the roomier side and narrows the video when neither side fits its preferred width',()=>{
    const result=sidePreviewPosition({left:310,right:540,top:680,bottom:900},{width:820,height:740});
    expect(result.side).toBe('left');expect(result.width).toBe(286);
    expect(result.top+result.width*9/16).toBeLessThanOrEqual(728);
  });
  it.each([320,390,480])('uses an inline preview when a %i px screen has no usable side space',width=>{
    expect(sidePreviewPosition({left:16,right:width-16,top:120,bottom:900},{width,height:844}).side).toBe('inline');
  });
  it('fits a short viewport without overlapping the source card',()=>{
    const result=sidePreviewPosition({left:12,right:250,top:-100,bottom:800},{width:900,height:180});
    expect(result.top).toBe(12);expect(result.width*9/16).toBeLessThanOrEqual(156);
    expect(result.left).toBeGreaterThanOrEqual(262);
  });
  it('fits a portrait clip within the viewport while preserving its aspect ratio',()=>{
    const result=sidePreviewPosition({left:12,right:250,top:300,bottom:800},{width:1440,height:500},360,9/16);
    expect(result.top).toBe(12);expect(result.top+result.width/(9/16)).toBeLessThanOrEqual(488);
    expect(result.left).toBeGreaterThanOrEqual(262);
  });
});
