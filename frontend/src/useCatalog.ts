import { computed, onUnmounted, ref, watch } from 'vue';
import { api, latestRequest } from './api';
import type { Work } from './types';
import type { FavoritePage, useLibrary } from './library';
import type { useAuth } from './useAuth';

export function useCatalog(library: ReturnType<typeof useLibrary>, auth:ReturnType<typeof useAuth>) {
  const view=ref('discover'), genre=ref('全部'), contentType=ref('全部'), page=ref(1);
  const works=ref<Work[]>([]), total=ref(0), overall=ref(0), loading=ref(false), error=ref('');
  const favoriteLoading=ref(false), favoriteError=ref('');
  const favoriteWorks=ref<Work[]>([]);
  const unavailableIds=ref<string[]>([]);
  const lane=latestRequest(), favoriteLane=latestRequest();
  const favoriteCount=computed(()=>library.total.value);
  const displayTotal=computed(()=>view.value==='favorites'?favoriteCount.value:total.value);
  const pages=computed(()=>Math.max(1,Math.ceil(displayTotal.value/12)));
  const visibleWorks=computed(()=>view.value==='favorites'
    ? favoriteWorks.value
    : view.value==='discover'?[]:works.value);

  async function load() {
    const request=lane.begin();
    if(view.value==='favorites') {loading.value=false;await loadFavorites();return;}
    loading.value=true;error.value='';
    const currentView=view.value, currentPage=page.value;
    const params=new URLSearchParams({page_size:currentView==='discover'?'6':'12',page:String(currentView==='discover'?1:currentPage)});
    if(currentView==='catalog') {
      if(genre.value!=='全部') params.set('genre',genre.value);
      if(contentType.value!=='全部') params.set('content_type',contentType.value);
    }
    try {
      const data=await api<{items:Work[];total:number}>(`/api/v1/works?${params}`,undefined,request.signal);
      if(!request.current()) return;
      works.value=data.items;total.value=data.total;
      if(currentView==='discover'||genre.value==='全部'&&contentType.value==='全部') overall.value=data.total;
      if(currentView==='catalog'&&currentPage>pages.value) page.value=pages.value;
    } catch(exc) {if(request.current()) error.value=exc instanceof Error?exc.message:'片库加载失败';}
    finally {if(request.current()) loading.value=false;}
  }

  async function loadFavorites() {
    const request=favoriteLane.begin(), account=auth.scope();
    if(auth.state.value!=='authenticated'||view.value!=='favorites') return;
    favoriteLoading.value=true;favoriteError.value='';
    try {
      const data=await account.request<FavoritePage<Work>>(`/api/v1/me/favorites?page=${page.value}&page_size=12`,undefined,undefined,request.signal);
      if(!request.current()||!account.current()) return;
      favoriteWorks.value=data.items;library.total.value=data.total;library.unavailable.value=data.unavailable_count;
      unavailableIds.value=data.unavailable_ids||[];
      if(page.value>pages.value) page.value=pages.value;
    } catch(exc) {if(request.current()&&account.current()) favoriteError.value=exc instanceof Error?exc.message:'收藏加载失败，请重试';}
    finally {if(request.current()&&account.current()) favoriteLoading.value=false;}
  }

  async function reload() {
    await Promise.all([load(),auth.state.value==='authenticated'?library.load():Promise.resolve()]);
  }
  function setView(value:string) {view.value=value;page.value=1;}
  function setGenre(value:string) {genre.value=value;page.value=1;}
  function setContentType(value:string) {contentType.value=value;page.value=1;}
  watch([view,genre,contentType,page],(current,previous)=>{
    const changed=current.slice(0,3).some((value,index)=>value!==previous[index]);
    if(changed) works.value=[];
    if(changed||view.value!=='discover') void load();
  });
  watch(auth.generation,()=>{
    favoriteLane.cancel();favoriteWorks.value=[];unavailableIds.value=[];favoriteLoading.value=false;favoriteError.value='';
    if(view.value==='favorites'&&auth.state.value!=='authenticated') setView('discover');
  },{flush:'sync'});
  watch(library.revision,()=>{if(view.value==='favorites') void loadFavorites();});
  onUnmounted(()=>{lane.cancel();favoriteLane.cancel();});
  return {view,genre,contentType,page,works,overall,visibleWorks,displayTotal,pages,loading,error,
    favoriteCount,favoriteLoading,favoriteError,unavailableIds,load,loadFavorites,reload,setView,setGenre,setContentType};
}
