export function pageNumbers(current:number,total:number):(number|string)[] {
  if(total<=7) return Array.from({length:total},(_,i)=>i+1);
  const selected=new Set([1,total]);
  const start=Math.max(1,Math.min(current-1,total-2));
  const end=Math.min(total,Math.max(current+1,3));
  for(let page=start;page<=end;page++) selected.add(page);
  const pages=[...selected].sort((a,b)=>a-b),result:(number|string)[]=[];
  for(const page of pages) {
    const previous=result.at(-1);
    if(typeof previous==='number') {
      if(page-previous===2) result.push(previous+1);
      else if(page-previous>2) result.push(`gap-${previous}`);
    }
    result.push(page);
  }
  return result;
}
