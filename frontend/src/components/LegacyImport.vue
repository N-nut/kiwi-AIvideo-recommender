<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { importGroup, importHistory, importMarker, legacyGroups, markImported, type ImportStats, type LegacyGroup } from '../legacyImport';
import type { useAuth } from '../useAuth';
import type { useLibrary } from '../library';
const props=defineProps<{auth:ReturnType<typeof useAuth>;library:ReturnType<typeof useLibrary>}>();
const groups=ref<LegacyGroup[]>([]), index=ref(0), visible=ref(false), busy=ref(false), error=ref(''), result=ref(''), progress=ref('');
const history=importHistory();
const selected=computed(()=>groups.value[index.value]);
function open() {
  if(!props.auth.user.value) return;
  groups.value=legacyGroups();index.value=0;visible.value=groups.value.length>0;error.value='';result.value='';progress.value='';
}
watch(props.auth.generation,()=>{
  visible.value=false;busy.value=false;error.value='';result.value='';progress.value='';groups.value=[];
  if(props.auth.user.value) {
    const userId=props.auth.user.value.id;
    groups.value=legacyGroups().filter(group=>!history.has(importMarker(userId,group)));
    index.value=0;visible.value=groups.value.length>0;
  }
},{flush:'sync'});
async function run() {
  const group=selected.value,user=props.auth.user.value;
  if(!group||!user||busy.value) return;
  const account=props.auth.scope();busy.value=true;error.value='';result.value='';progress.value='';
  try {
    const stats=await importGroup(group,ids=>account.request<ImportStats>('/api/v1/me/favorites/import',{work_ids:ids}),
      (done,remaining)=>{if(account.current()) {progress.value=`已完成 ${done} 批，剩余 ${remaining} 部`;props.library.revision.value++;}});
    if(!account.current()) return;
    markImported(importMarker(user.id,group),history);
    result.value=`导入完成：新增 ${stats.added} 部，账号已有 ${stats.already_saved} 部，跳过不可用 ${stats.skipped_unavailable} 部。`;
  } catch(exc) {if(account.current()) error.value=`${exc instanceof Error?exc.message:'导入失败'}。已完成批次仍保留，可重新导入，重复作品会跳过。`;}
  finally {if(account.current()){busy.value=false;await props.library.load();}}
}
defineExpose({open});
</script>
<template>
  <section v-if="visible&&auth.user.value" class="legacy-import" aria-labelledby="legacy-title">
    <h2 id="legacy-title">导入本机旧收藏</h2>
    <p>目标账号：<strong>{{auth.user.value.username}}</strong>。请选择要导入的演示昵称，其他昵称的收藏不会合并。</p>
    <label>演示昵称 <select v-model="index" :disabled="busy" @change="result='';error='';progress=''"><option v-for="(group,i) in groups" :key="group.name" :value="i">{{group.name}}（{{group.ids.length}} 部）</option></select></label>
    <p v-if="progress" role="status">{{progress}}</p><p v-if="result" role="status">{{result}}</p><p v-if="error" class="field-error" role="alert">{{error}}</p>
    <div class="dialog-actions"><button class="text-button" :disabled="busy" @click="visible=false">{{result?'关闭':'暂不导入'}}</button><button v-if="!result" class="primary-button" :disabled="busy||!selected" @click="run">{{busy?'正在导入…':error?'重试导入':'导入收藏'}}</button></div>
  </section>
</template>
