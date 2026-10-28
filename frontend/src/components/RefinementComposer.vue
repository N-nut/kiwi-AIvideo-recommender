<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { Preferences } from '../types';
import type { useRefinement } from '../useRefinement';
import { preferenceGroups, targetLabel, valueLabel } from '../refinement';
import PreferenceSummary from './PreferenceSummary.vue';
import PreferenceEditor from './PreferenceEditor.vue';
const props=defineProps<{refinement:ReturnType<typeof useRefinement>;disabled:boolean}>();
const review=ref<HTMLDialogElement>(),editing=ref(false),draft=ref<Preferences>();
watch(()=>props.refinement.reviewOpen.value,async open=>{
  if(!open){review.value?.close();editing.value=false;return;}
  await nextTick();if(props.refinement.reviewOpen.value&&!review.value?.open)review.value?.showModal();
});
function close(){editing.value=false;props.refinement.discard();}
function edit(){draft.value=props.refinement.editCandidate();editing.value=true;}
function save(value:Preferences){props.refinement.saveCandidate(value);editing.value=false;}
onBeforeUnmount(()=>review.value?.close());
</script>
<template>
  <section class="refinement-composer" aria-labelledby="refinement-title">
    <div class="refinement-heading"><h3 id="refinement-title">继续调整</h3><span>基于当前已确认偏好</span></div>
    <label class="sr-only" for="refinement-text">本次调整描述</label>
    <textarea id="refinement-text" v-model="refinement.text.value" rows="2" aria-describedby="refinement-help refinement-count" placeholder="比如：加点重生，或取消不要后宫" :disabled="refinement.status.value==='applying'" @keydown.ctrl.enter.prevent="refinement.understand"/>
    <div class="refinement-controls"><p id="refinement-help">只改你明确提到的条件，核对后再生成。</p><span id="refinement-count" :class="{'field-error':refinement.count.value>300}">{{refinement.count.value}} / 300</span></div>
    <div class="refinement-examples"><button v-for="text in ['加点重生','一定要节奏快','偏好题材改成都市，其他不变','取消不要后宫']" :key="text" type="button" class="example-button" :disabled="disabled" @click="refinement.text.value=text">{{text}}</button></div>
    <div class="refinement-actions"><button type="button" class="secondary-button" :disabled="disabled||!refinement.canUnderstand.value" @click="refinement.understand">{{refinement.status.value==='understanding'?'正在理解调整…':refinement.retrySeconds.value?`请等待 ${refinement.retrySeconds.value} 秒`:'理解本次调整'}}</button><button v-if="refinement.status.value==='understanding'" class="text-button" @click="close">放弃本次调整</button><span v-if="refinement.status.value==='applying'" role="status">正在应用新条件，旧片单暂时保留。</span></div>
    <p v-if="refinement.error.value&&!refinement.reviewOpen.value" class="field-error" role="alert">{{refinement.error.value}}</p>
    <p v-if="refinement.notice.value" class="source-note" role="status">{{refinement.notice.value}}</p>
  </section>
  <dialog ref="review" class="refinement-dialog" aria-labelledby="refinement-review-title" @cancel.prevent="close" @close="refinement.reviewOpen.value&&close()">
    <div class="dialog-heading"><h2 id="refinement-review-title">核对本次调整</h2><button class="dialog-close" aria-label="关闭调整核对" @click="close">×</button></div>
    <p class="dialog-intro">以下为待应用条件，确认推荐成功后才会生效。</p>
    <template v-if="!editing">
      <section v-if="refinement.preserved.value.length" class="refinement-preserved"><h3>保持不变</h3><p v-for="row in refinement.preserved.value" :key="row.target"><strong>{{targetLabel(row.target)}}</strong>：{{valueLabel(row.values)}}</p></section>
      <section v-for="kind in (['added','replaced','removed'] as const)" :key="kind" class="refinement-changes"><template v-if="refinement.changes.value.some(row=>row.kind===kind)"><h3>{{{added:'新增',replaced:'替换',removed:'取消'}[kind]}}</h3><p v-for="row in refinement.changes.value.filter(row=>row.kind===kind)" :key="row.target"><strong>{{targetLabel(row.target)}}</strong>：{{valueLabel(row.before)}} → {{valueLabel(row.after)}}</p></template></section>
      <p v-for="issue in refinement.issues.value" :key="issue" class="constraint-warning" role="alert">{{issue}}</p>
      <template v-if="refinement.pendingPreferences.value"><h3>调整后的完整偏好</h3><PreferenceSummary :groups="preferenceGroups(refinement.pendingPreferences.value)"/></template>
      <p v-if="refinement.error.value" class="field-error" role="alert">{{refinement.error.value}}</p>
      <p v-if="refinement.status.value==='applying'" role="status">正在应用新条件，旧片单暂时保留。</p>
      <div class="dialog-actions"><button class="primary-button" :disabled="!refinement.canApply.value" @click="refinement.apply">{{refinement.status.value==='applying'?'正在生成…':'确认调整并推荐'}}</button><button class="secondary-button" :disabled="refinement.busy.value" @click="edit">手动调整</button><button class="text-button" @click="close">放弃本次调整</button></div>
    </template>
    <template v-else><PreferenceEditor v-if="draft" :preferences="draft" @update="save"/><button class="text-button" @click="editing=false">返回核对</button></template>
  </dialog>
</template>
