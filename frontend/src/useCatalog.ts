import { computed, onUnmounted, ref, watch } from 'vue';
import { api, latestRequest } from './api';
import type { Work } from './types';
import type { FavoritePage, useLibrary } from './library';
import type { useAuth } from './useAuth';

export function useCatalog(library: ReturnType<typeof useLibrary>, auth:ReturnType<typeof useAuth>) {
  const view=ref('discover'), genre=ref('全部'), contentType=ref('全部'), page=ref(1);
  const search=ref(''),searchTerm=ref('');
  let searchTimer:ReturnType<typeof setTimeout>|undefined;
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
    : view.value==='catalog'?works.value:[]);

  async function load() {
    const request=lane.begin();
    if(view.value==='favorites') {loading.value=false;await loadFavorites();return;}
    if(view.value!=='catalog') {loading.value=false;error.value='';return;}
    loading.value=true;error.value='';
    const currentView=view.value, currentPage=page.value;
    const params=new URLSearchParams({page_size:'12',page:String(currentPage)});
    if(currentView==='catalog') {
      if(genre.value!=='全部') params.set('genre',genre.value);
      if(contentType.value!=='全部') params.set('content_type',contentType.value);
      if(searchTerm.value) params.set('q',searchTerm.value);
    }
    try {
      const data=await api<{items:Work[];total:number}>(`/api/v1/works?${params}`,undefined,request.signal);
      if(!request.current()) return;
      works.value=data.items;total.value=data.total;
      if(genre.value==='全部'&&contentType.value==='全部'&&!searchTerm.value) overall.value=data.total;
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
  function flushSearch() {clearTimeout(searchTimer);searchTimer=undefined;searchTerm.value=search.value.trim();}
  function submitSearch() {
    const unchanged=searchTerm.value===search.value.trim()&&page.value===1;
    flushSearch();page.value=1;
    if(unchanged&&view.value==='catalog') void load();
  }
  function clearSearch() {search.value='';submitSearch();}
  function setView(value:string) {
    const unchanged=view.value===value&&page.value===1&&searchTerm.value===search.value.trim();
    flushSearch();view.value=value;page.value=1;if(unchanged&&loading.value) void load();
  }
  function setGenre(value:string) {
    const unchanged=genre.value===value&&page.value===1&&searchTerm.value===search.value.trim();
    flushSearch();genre.value=value;page.value=1;if(unchanged&&loading.value) void load();
  }
  function setContentType(value:string) {
    const unchanged=contentType.value===value&&page.value===1&&searchTerm.value===search.value.trim();
    flushSearch();contentType.value=value;page.value=1;if(unchanged&&loading.value) void load();
  }
  watch(search,()=>{
    clearTimeout(searchTimer);
    if(view.value!=='catalog') return;
    lane.cancel();works.value=[];loading.value=true;error.value='';
    searchTimer=setTimeout(submitSearch,300);
  },{flush:'sync'});
  watch([view,genre,contentType,page,searchTerm],(current,previous)=>{
    const changed=current.slice(0,3).some((value,index)=>value!==previous[index])||current[4]!==previous[4];
    if(changed) works.value=[];
    if(changed||view.value!=='discover') void load();
  });
  watch(auth.generation,()=>{
    favoriteLane.cancel();favoriteWorks.value=[];unavailableIds.value=[];favoriteLoading.value=false;favoriteError.value='';
    if(['favorites','personal-space'].includes(view.value)&&auth.state.value!=='authenticated') setView('discover');
  },{flush:'sync'});
  watch(library.revision,()=>{if(view.value==='favorites') void loadFavorites();});
  onUnmounted(()=>{clearTimeout(searchTimer);lane.cancel();favoriteLane.cancel();});
  return {view,genre,contentType,page,search,searchTerm,works,overall,visibleWorks,displayTotal,pages,loading,error,
    favoriteCount,favoriteLoading,favoriteError,unavailableIds,load,loadFavorites,reload,setView,setGenre,setContentType,submitSearch,clearSearch};
}
