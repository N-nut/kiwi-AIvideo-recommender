<script setup lang="ts">
import { computed,onMounted } from 'vue';
import type { useAuth } from '../useAuth';
import { useCorrections } from '../useCorrections';
import { categoryLabels,correctionLabels,correctionStatuses,formatValue } from '../corrections';
import CatalogPagination from './CatalogPagination.vue';
const props=defineProps<{auth:ReturnType<typeof useAuth>}>();
const emit=defineEmits<{back:[];detail:[id:string,relatedId:string]}>();
const state=useCorrections(props.auth),pages=computed(()=>Math.max(1,Math.ceil(state.total.value/12)));
function filter(){state.page.value=1;void state.load();}function turn(value:number){state.page.value=value;void state.load();}
onMounted(state.load);
</script>
<template>
<section class="corrections-page" aria-labelledby="my-corrections-title"><header class="space-heading"><h1 id="my-corrections-title">我的纠错</h1><button class="text-button" @click="emit('back')">返回个人空间</button></header>
  <div class="review-filters"><label>处理状态<select v-model="state.status.value" @change="filter"><option value="">全部状态</option><option v-for="(label,key) in correctionStatuses" :value="key">{{label}}</option></select></label><button class="secondary-button" :disabled="state.loading.value" @click="state.load">刷新记录</button></div>
  <p v-if="state.error.value" class="field-error" role="alert">{{state.error.value}} <button @click="state.load">重试</button></p><p v-else-if="state.loading.value" role="status">正在读取纠错记录…</p><p v-else-if="!state.items.value.length">暂无纠错记录。发现资料问题时，可在作品详情提交。</p>
  <article v-for="item in state.items.value" :key="item.id" class="review-card"><header><h2>{{item.work_title}}</h2><span>{{correctionStatuses[item.status]}}</span></header><p>{{categoryLabels[item.category]}} · {{correctionLabels[item.field]}} · {{new Date(item.created_at).toLocaleString('zh-CN')}}</p><dl><dt>提交时原值</dt><dd>{{formatValue(item.current_value)}}</dd><dt>本人建议</dt><dd>{{item.suggestion.kind==='unknown'?'恢复未知':item.suggestion.kind==='issue'?'核对对应问题':formatValue(item.suggestion.value)}}</dd><dt>问题说明</dt><dd>{{item.description}}</dd><template v-if="item.source_hint"><dt>来源线索</dt><dd><a v-if="item.source_hint.url" :href="item.source_hint.url" target="_blank" rel="noopener noreferrer">查看线索来源</a><p>{{item.source_hint.quote}}</p></dd></template><dt>处理说明</dt><dd>{{item.decision||'等待审核者核对，当前资料暂不改变。'}}</dd></dl><button class="text-button" @click="emit('detail',item.work_id,item.id)">查看最新资料／补充关联纠错</button></article>
  <CatalogPagination :page="state.page.value" :pages="pages" :busy="state.loading.value" @change="turn"/>
</section>
</template>
