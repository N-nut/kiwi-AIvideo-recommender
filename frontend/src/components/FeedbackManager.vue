<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { latestRequest } from '../api';
import { feedbackLabels, type FeedbackItem, type FeedbackStatus } from '../types';
import type { useAuth } from '../useAuth';
import type { useFeedback } from '../useFeedback';
import CatalogPagination from './CatalogPagination.vue';
const props=defineProps<{auth:ReturnType<typeof useAuth>;feedback:ReturnType<typeof useFeedback>}>();
const emit=defineEmits<{back:[];remove:[item:FeedbackItem]}>();
const status=ref<FeedbackStatus|''>(''),page=ref(1),items=ref<FeedbackItem[]>([]),total=ref(0),loading=ref(false),error=ref('');
const pages=computed(()=>Math.max(1,Math.ceil(total.value/12))),lane=latestRequest();
async function load(){
  const request=lane.begin(),account=props.auth.scope();loading.value=true;error.value='';
  try{const params=new URLSearchParams({page:String(page.value),page_size:'12'});if(status.value)params.set('status',status.value);
    const data=await account.request<{items:FeedbackItem[];total:number}>(`/api/v1/me/feedback?${params}`,undefined,undefined,request.signal);
    if(request.current()&&account.current()){items.value=data.items;total.value=data.total;if(page.value>pages.value)page.value=pages.value;}
  }catch(exc){if(request.current()&&account.current())error.value=exc instanceof Error?exc.message:'反馈加载失败，请重试';}
  finally{if(request.current()&&account.current())loading.value=false;}
}
watch(status,()=>{page.value=1;});
watch([status,page,props.feedback.revision],()=>void load(),{immediate:true});
onScopeDispose(()=>lane.cancel());
</script>
<template>
  <section class="feedback-management" aria-labelledby="feedback-title">
    <header class="space-heading"><div><h1 id="feedback-title">推荐反馈管理</h1><p>仅影响这些作品的推荐，收藏和兴趣画像继续保留。</p></div><button class="text-button" @click="emit('back')">返回个人空间</button></header>
    <div class="catalog-filters" aria-label="反馈筛选"><button v-for="option in [{value:'',label:'全部'},{value:'not_interested',label:'不感兴趣'},{value:'watched',label:'已看过'}] as const" :key="option.value" class="filter-button" :class="{active:status===option.value}" :aria-pressed="status===option.value" @click="status=option.value">{{option.label}}</button></div>
    <p class="source-note">共 {{total}} 条反馈；撤销后恢复后续推荐资格。</p>
    <p v-if="error" class="field-error" role="alert">{{error}} <button class="text-button" @click="load">重试反馈列表</button></p>
    <p v-if="loading" role="status">正在读取反馈…</p>
    <ul class="feedback-list"><li v-for="item in items" :key="item.work_id"><div><strong>{{item.available?item.work?.title:'作品资料暂不可用'}}</strong><p>{{feedbackLabels[item.status]}} · {{new Date(item.updated_at).toLocaleDateString('zh-CN')}}</p></div><button class="secondary-button" :disabled="feedback.pending.value.has(item.work_id)||feedback.unknown.value.has(item.work_id)" @click="emit('remove',item)">{{feedback.pending.value.has(item.work_id)?'正在撤销…':'撤销反馈'}}</button></li></ul>
    <p v-if="!items.length&&!loading&&!error" class="empty-state">这个分类还没有反馈。</p>
    <CatalogPagination :page="page" :pages="pages" :busy="loading" @change="page=$event"/>
  </section>
</template>
