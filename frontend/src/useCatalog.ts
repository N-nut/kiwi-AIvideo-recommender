import { computed, onUnmounted, ref, watch } from 'vue';
import { api, APIError, latestRequest } from './api';
import type { Work } from './types';
import type { useLibrary } from './library';

export function useCatalog(library: ReturnType<typeof useLibrary>) {
  const view=ref('discover'), genre=ref('全部'), contentType=ref('全部'), page=ref(1);
  const works=ref<Work[]>([]), total=ref(0), overall=ref(0), loading=ref(false), error=ref('');
  const favoriteLoading=ref(false), favoriteError=ref('');
  const cache=ref(new Map<string,Work>()), missing=ref(new Set<string>());
  const lane=latestRequest(), favoriteLane=latestRequest();
  const favoriteIds=computed(()=>library.ids().filter(id=>!missing.value.has(id)));
  const favoriteCount=computed(()=>favoriteIds.value.length);
  const displayTotal=computed(()=>view.value==='favorites'?favoriteCount.value:total.value);
  const pages=computed(()=>Math.max(1,Math.ceil(displayTotal.value/12)));
  const visibleWorks=computed(()=>view.value==='favorites'
    ? favoriteIds.value.slice((page.value-1)*12,page.value*12).flatMap(id=>cache.value.get(id)?[cache.value.get(id)!]:[])
    : works.value);

  async function load() {
    const request=lane.begin();
    if(view.value==='favorites') {loading.value=false;await loadFavorites();return;}
    loading.value=true;error.value='';
    const currentView=view.value, currentPage=page.value;
    const params=new URLSearchParams({page_size:currentView==='discover'?'3':'12',page:String(currentView==='discover'?1:currentPage)});
    if(currentView==='catalog') {
      if(genre.value!=='全部') params.set('genre',genre.value);
      if(contentType.value!=='全部') params.set('content_type',contentType.value);
    }
    try {
      const data=await api<{items:Work[];total:number}>(`/api/v1/works?${params}`,undefined,request.signal);
      if(!request.current()) return;
      works.value=data.items;total.value=data.total;
      if(currentView==='discover'||genre.value==='全部'&&contentType.value==='全部') overall.value=data.total;
      for(const work of data.items) cache.value.set(work.id,work);
      if(currentView==='catalog'&&currentPage>pages.value) page.value=pages.value;
    } catch(exc) {if(request.current()) error.value=exc instanceof Error?exc.message:'片库加载失败';}
    finally {if(request.current()) loading.value=false;}
  }

  async function loadFavorites() {
    const request=favoriteLane.begin();favoriteLoading.value=true;favoriteError.value='';
    const ids=[...library.ids()];
    try {
      const needed=ids.filter(id=>!cache.value.has(id)&&!missing.value.has(id));
      for(let offset=0;offset<needed.length;offset+=4) {
        const batch=await Promise.all(needed.slice(offset,offset+4).map(async id=>{
          try {return {id,work:await api<Work>(`/api/v1/works/${encodeURIComponent(id)}`,undefined,request.signal)};}
          catch(exc) {if(exc instanceof APIError&&exc.status===404) return {id,work:null};throw exc;}
        }));
        if(!request.current()) return;
        for(const item of batch) {if(item.work) cache.value.set(item.id,item.work);else missing.value.add(item.id);}
      }
      if(view.value==='favorites'&&page.value>pages.value) page.value=pages.value;
    } catch(exc) {if(request.current()) favoriteError.value=exc instanceof Error?exc.message:'收藏加载失败，请重试';}
    finally {if(request.current()) favoriteLoading.value=false;}
  }

  async function reload() {
    cache.value.clear();missing.value.clear();
    await Promise.all([load(), view.value==='favorites'?Promise.resolve():loadFavorites()]);
  }
  function setView(value:string) {view.value=value;page.value=1;}
  function setGenre(value:string) {genre.value=value;page.value=1;}
  function setContentType(value:string) {contentType.value=value;page.value=1;}
  watch([view,genre,contentType,page],(current,previous)=>{
    const changed=current.slice(0,3).some((value,index)=>value!==previous[index]);
    if(changed) works.value=[];
    if(changed||view.value==='catalog') void load();
  });
  watch(()=>[library.user.value,...library.ids()].join('\0'),()=>{void loadFavorites();});
  onUnmounted(()=>{lane.cancel();favoriteLane.cancel();});
  return {view,genre,contentType,page,works,overall,visibleWorks,displayTotal,pages,loading,error,
    favoriteCount,favoriteLoading,favoriteError,missing,load,loadFavorites,reload,setView,setGenre,setContentType};
}
