import { emptyPreferences, genres, themes, fieldNames, type Preferences, type RefinementChange, type RefinementPreserved, type RefinementValue } from './types';

export const clonePreferences=(value:Preferences):Preferences=>JSON.parse(JSON.stringify(value));
const unique=(values:RefinementValue[])=>[...new Set(values)].sort((a,b)=>String(a).localeCompare(String(b)));
export function preferenceSlots(p:Preferences):Record<string,RefinementValue[]> {
  const result:Record<string,RefinementValue[]>={'soft.genres':unique(p.soft_preferences.genres),'soft.themes':unique(p.soft_preferences.themes),'soft.pace':p.soft_preferences.pace?[p.soft_preferences.pace]:[]};
  for(const field of ['genres','themes','pace','harem','romance','tragic'])result[`required.${field}`]=unique(p.required.filter(r=>r.field===field).map(r=>r.value));
  result.excluded_features=unique(p.excluded_features);result.excluded_genres=unique(p.excluded_genres);return result;
}
export function reviewPreferences(value:Preferences) {
  const p=clonePreferences(value),issues=[...p.unresolved_constraints];p.conflicts=[];
  p.soft_preferences.genres=[...new Set(p.soft_preferences.genres)].sort();p.soft_preferences.themes=[...new Set(p.soft_preferences.themes)].sort();
  p.excluded_features=[...new Set(p.excluded_features)].sort();p.excluded_genres=[...new Set(p.excluded_genres)].sort();
  p.required=p.required.filter((r,i,rows)=>rows.findIndex(x=>x.field===r.field&&x.value===r.value)===i).sort((a,b)=>`${a.field}:${a.value}`.localeCompare(`${b.field}:${b.value}`));
  if(p.soft_preferences.genres.some(x=>!genres.includes(x))||p.soft_preferences.themes.some(x=>!themes.includes(x))||p.excluded_genres.some(x=>!genres.includes(x))||p.excluded_features.some(x=>!['harem','romance','tragic'].includes(x)))issues.push('条件超出支持范围');
  if(p.soft_preferences.genres.length>10||p.soft_preferences.themes.length>10||p.required.length>20||p.excluded_genres.length>10||p.excluded_features.length>3)issues.push('条件超出容量');
  if(p.soft_preferences.pace!==null&&!['快','舒缓'].includes(p.soft_preferences.pace))issues.push('节奏条件无效');
  for(const r of p.required){
    const allowed:Record<string,RefinementValue[]>={genres,themes,pace:['快','舒缓'],harem:[true,false],romance:[true,false],tragic:[true,false]};
    if(!allowed[r.field]?.includes(r.value))issues.push('必须条件无效');
    if(r.field==='genres'&&p.excluded_genres.includes(String(r.value))||p.excluded_features.includes(r.field)&&r.value===true)issues.push(`必须包含且排除了${fieldNames[r.field]}：${r.value}`);
    if(['pace','harem','romance','tragic'].includes(r.field)&&new Set(p.required.filter(x=>x.field===r.field).map(x=>x.value)).size>1)issues.push(`必须条件互相冲突：${fieldNames[r.field]}`);
  }
  if(!Object.values(preferenceSlots(p)).some(values=>values.length))issues.push('请至少保留一项有效偏好');
  p.conflicts=[...new Set(issues.filter(x=>!p.unresolved_constraints.includes(x)))];
  return {preferences:p,issues:[...new Set(issues)]};
}
export function preferenceDiff(base:Preferences,candidate:Preferences) {
  const before=preferenceSlots(base),after=preferenceSlots(candidate),changes:RefinementChange[]=[],preserved:RefinementPreserved[]=[];
  for(const target of Object.keys(before)){
    const old=before[target]!,next=after[target]!,same=old.filter(v=>next.includes(v));
    if(same.length)preserved.push({target,values:same});
    if(JSON.stringify(old)!==JSON.stringify(next)){
      const removed=old.some(v=>!next.includes(v)),added=next.some(v=>!old.includes(v));
      changes.push({kind:removed&&added?'replaced':removed?'removed':'added',target,before:old,after:next});
    }
  }
  return {changes,preserved};
}
export function preferenceGroups(p:Preferences=emptyPreferences()) {return [
  {label:'偏爱风格',kind:'soft',values:[...p.soft_preferences.genres,...p.soft_preferences.themes,...(p.soft_preferences.pace?[`节奏${p.soft_preferences.pace}`]:[])]},
  {label:'必须满足',kind:'required',values:p.required.map(r=>`${fieldNames[r.field]}：${typeof r.value==='boolean'?(r.value?'有':'无'):r.value}`)},
  {label:'明确排除',kind:'exclude',values:[...p.excluded_features.map(f=>`不要${fieldNames[f]}`),...p.excluded_genres.map(g=>`不要${g}`)]},
];}
export function targetLabel(target:string){const [kind,field]=target.split('.');return kind==='soft'?`普通偏好 · ${fieldNames[field!]}`:kind==='required'?`必须 · ${fieldNames[field!]}`:target==='excluded_features'?'明确排除 · 剧情特征':'明确排除 · 题材';}
export function valueLabel(values:RefinementValue[]){return values.map(value=>typeof value==='boolean'?value?'有':'无':fieldNames[value]||value).join('、')||'未设置';}
