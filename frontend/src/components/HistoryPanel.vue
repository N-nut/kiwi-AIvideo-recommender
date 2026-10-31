<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useHistory } from '../useHistory';
import type { useAuth } from '../useAuth';
import type { HistoryDetail, Work } from '../types';
import { fieldNames } from '../types';
import CatalogPagination from './CatalogPagination.vue';
import PreferenceSummary from './PreferenceSummary.vue';
const props=defineProps<{auth:ReturnType<typeof useAuth>;initialId?:string}>();
const emit=defineEmits<{back:[];discover:[];reuse:[history:HistoryDetail];detail:[work:Work]}>();
const history=useHistory(props.auth);
const {items,total,page,pages,loading,error,selected,selectedId,detailLoading,detailError,deleting,deleteError}=history;
const confirmId=ref(''),heading=ref<HTMLElement>();
const date=(value:string)=>new Date(value).toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'});
const groups=computed(()=>{
  const p=selected.value?.preferences;if(!p)return [];
  return [{label:'偏爱风格',kind:'soft',values:[...p.soft_preferences.genres,...p.soft_preferences.themes,...(p.soft_preferences.pace?[`节奏${p.soft_preferences.pace}`]:[])]},
    {label:'必须满足',kind:'required',values:p.required.map(r=>`${fieldNames[r.field]}：${typeof r.value==='boolean'?(r.value?'有':'无'):r.value}`)},
    {label:'明确排除',kind:'exclude',values:[...p.excluded_features.map(f=>`不要${fieldNames[f]}`),...p.excluded_genres.map(g=>`不要${g}`)]}];
});
async function open(id:string){confirmId.value='';await history.open(id);await nextTick();heading.value?.focus();}
async function remove(id:string){if(await history.remove(id))confirmId.value='';}
function back(){confirmId.value='';history.back();void nextTick(()=>heading.value?.focus());}
watch(()=>props.initialId,id=>{if(id)void open(id);},{immediate:true});
watch(props.auth.generation,()=>{confirmId.value='';});
</script>
<template>
  <section class="history-panel" aria-labelledby="history-title">
    <header class="space-heading"><div><h1 id="history-title" ref="heading" tabindex="-1">历史片单</h1><p>留下每一次心动，随时找回当时的推荐。</p></div><button class="text-button" @click="emit('back')">返回个人空间</button></header>
    <div class="history-toolbar"><p>最近 100 份片单</p><button v-if="!selectedId" class="text-button" :disabled="loading||!!deleting" @click="history.load">刷新片单</button><button v-else class="text-button" :disabled="!!deleting" @click="back">全部片单</button></div>
    <p v-if="deleteError" class="field-error" role="alert">{{deleteError}}；页面保留当前记录，可重试删除或刷新核对。</p>
    <template v-if="selectedId">
      <p v-if="detailLoading" role="status">正在找回当时的片单…</p>
      <p v-if="detailError" class="field-error" role="alert">{{detailError}} <button class="text-button" @click="open(selectedId)">重试片单详情</button></p>
      <article v-if="selected" class="history-detail">
        <div class="history-detail-heading"><div><p class="history-date">{{date(selected.created_at)}} · {{selected.count}} 部作品 · {{selected.mode==='baseline'?'标签基线':'AI 推荐'}}</p><h2>{{selected.query||'按确认偏好生成的片单'}}</h2></div><button class="primary-button" @click="emit('reuse',selected)">沿用偏好，再次推荐</button></div>
        <p class="source-note">以下为生成时的偏好和推荐理由。沿用偏好后需再次确认，才会生成新片单。</p>
        <PreferenceSummary class="history-preferences" :groups="groups"/>
        <p v-if="selected.warnings.length" class="source-note">{{selected.warnings.join('；')}}</p>
        <ol class="history-works"><li v-for="(item,index) in selected.items" :key="item.id">
          <span class="history-work-number">{{String(index+1).padStart(2,'0')}}</span>
          <div class="history-work-copy"><h3>{{item.title}}</h3><template v-if="item.work"><p v-if="item.changed" class="history-changed">作品资料已更新，以下为当时的推荐理由；详情显示最新资料。</p><p>{{item.work.reason||item.work.summary}}</p><p v-if="item.work.caveats?.length" class="source-note">当时的提醒：{{item.work.caveats.join('；')}}</p><button class="text-button" @click="emit('detail',item.work)">查看最新作品资料</button></template><p v-else class="source-note">作品资料暂不可用，保留当时的片单位置。</p></div>
        </li></ol>
        <div class="history-delete"><template v-if="confirmId===selected.id"><span>删除这份历史片单？</span><button class="secondary-button" :disabled="!!deleting" @click="remove(selected.id)">{{deleting?'正在删除…':'确认删除'}}</button><button class="text-button" :disabled="!!deleting" @click="confirmId=''">取消</button></template><button v-else class="text-button" :disabled="!!deleting" @click="confirmId=selected.id">删除这份片单</button><small>收藏和推荐反馈会继续保留。</small></div>
      </article>
    </template>
    <template v-else>
      <p v-if="error" class="field-error" role="alert">{{error}} <template v-if="items.length">以下为最近读取的片单。</template><button class="text-button" @click="history.load">重试历史片单</button></p>
      <p v-if="loading" role="status">正在读取历史片单…</p>
      <p class="source-note">共 {{total}} 份片单 · 按生成时间排列</p>
      <div class="history-grid"><article v-for="item in items" :key="item.id" class="history-card">
        <p class="history-date">{{date(item.created_at)}}<span>{{item.count}} 部</span></p><h2>{{item.query||'按确认偏好生成的片单'}}</h2>
        <ul class="history-titles"><li v-for="(title,index) in item.titles" :key="index"><span>{{String(index+1).padStart(2,'0')}}</span>{{title}}</li></ul>
        <div class="history-card-actions"><button class="secondary-button" @click="open(item.id)">查看片单</button><button v-if="confirmId!==item.id" class="text-button" :disabled="!!deleting" @click="confirmId=item.id">删除</button><template v-else><span class="sr-only">删除这份历史片单？</span><button class="text-button history-confirm" :disabled="!!deleting" @click="remove(item.id)">{{deleting===item.id?'正在删除…':'确认删除'}}</button><button class="text-button" :disabled="!!deleting" @click="confirmId=''">取消</button></template></div>
      </article></div>
      <div v-if="!items.length&&!loading&&!error" class="empty-state"><h2>还没有历史片单</h2><p>登录后生成的非空片单会自动保存在这里。</p><button class="primary-button" @click="emit('discover')">去发现好剧</button></div>
      <CatalogPagination :page="page" :pages="pages" :busy="loading||!!deleting" @change="confirmId='';page=$event"/>
    </template>
  </section>
</template>
