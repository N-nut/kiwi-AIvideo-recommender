export interface LegacyGroup {name:string;ids:string[];fingerprint:string}
export interface ImportStats {requested:number;unique:number;added:number;already_saved:number;skipped_unavailable:number}
export function browserStorage():Storage|undefined {try{return localStorage;}catch{return undefined;}}

export function legacyGroups(storage=browserStorage()):LegacyGroup[] {
  try {
    const raw=JSON.parse(storage?.getItem('kiwi-real-library-v1')||'{}');
    if(!raw||typeof raw!=='object'||Array.isArray(raw)) return [];
    return Object.entries(raw).flatMap(([name,value])=>{
      if(!Array.isArray(value)||!value.every(id=>typeof id==='string')) return [];
      const ids=[...new Set<string>(value.filter(id=>id.length>0&&id.length<=80))];
      // Canonical content is a collision-free UI fingerprint, never an auth credential.
      return ids.length?[{name,ids,fingerprint:JSON.stringify([name,[...ids].sort()])}]:[];
    });
  }catch{return [];}
}
export function importMarker(userId:string,group:LegacyGroup) {return JSON.stringify([userId,group.fingerprint]);}
export function importHistory(storage=browserStorage()):Set<string> {
  try {const data=JSON.parse(storage?.getItem('kiwi-account-imports-v1')||'[]');return new Set(Array.isArray(data)?data.filter(x=>typeof x==='string'):[]);}catch{return new Set();}
}
export function markImported(marker:string,history:Set<string>,storage=browserStorage()) {
  history.add(marker);try{storage?.setItem('kiwi-account-imports-v1',JSON.stringify([...history]));}catch{/* Keep in-memory completion. */}
}
export async function importGroup(group:LegacyGroup,send:(ids:string[])=>Promise<ImportStats>,progress:(done:number,remaining:number)=>void=()=>{}) {
  const total:ImportStats={requested:0,unique:0,added:0,already_saved:0,skipped_unavailable:0};
  for(let offset=0;offset<group.ids.length;offset+=100) {
    const stats=await send(group.ids.slice(offset,offset+100));
    for(const key of Object.keys(total) as (keyof ImportStats)[]) total[key]+=stats[key];
    progress(Math.floor(offset/100)+1,Math.max(0,group.ids.length-offset-100));
  }
  return total;
}
