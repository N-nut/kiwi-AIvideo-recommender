<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import type { Work } from '../types';
import type { useAuth } from '../useAuth';
import type { Correction } from '../corrections';
import { useCorrections } from '../useCorrections';
import { categoryLabels,correctionFields,correctionLabels,currentValue,fieldInput,formatValue,inputValue,nullableFields } from '../corrections';
import CorrectionValue from './CorrectionValue.vue';
const props=defineProps<{auth:ReturnType<typeof useAuth>;work:Work;reviewer?:boolean;relatedId?:string}>();
const emit=defineEmits<{close:[];submitted:[report:Correction];records:[];forbidden:[]}>();
const form=useCorrections(props.auth),dialog=ref<HTMLDialogElement>(),current=ref<Work|null>(props.reviewer?props.work:null),loadError=ref('');
const category=ref('basic'),field=ref('title'),kind=ref('set'),value=ref(''),description=ref(''),url=ref(''),quote=ref(''),validation=ref('');
const locked=computed(()=>form.busy.value||form.unknown.value||!!form.saved.value);
watch(category,()=>field.value=correctionFields[category.value][0]);
watch(field,()=>{kind.value=category.value==='mapping'?'issue':'set';value.value=current.value?inputValue(currentValue(current.value,field.value)):'';validation.value='';},{immediate:true});
watch(props.auth.generation,()=>emit('close'),{flush:'sync'});
watch(form.saved,row=>{if(row)emit('submitted',row);});
watch(form.forbidden,value=>{if(value&&props.reviewer)emit('forbidden');});
async function load(){loadError.value='';const account=props.auth.scope();try{const data=props.reviewer?props.work:await account.request<Work>(`/api/v1/works/${encodeURIComponent(props.work.id)}`);if(account.current()){current.value=data;value.value=inputValue(currentValue(data,field.value));}}catch(exc){if(account.current())loadError.value=exc instanceof Error?exc.message:'资料读取失败';}}
onMounted(async()=>{await nextTick();dialog.value?.showModal();void load();});
async function submit(){if(!current.value?.review||locked.value)return;validation.value='';try{if(!description.value.trim()||Array.from(description.value.trim()).length>500)throw Error('请填写 1～500 字符的问题说明');const suggestion=kind.value==='set'?{kind:'set',value:fieldInput(field.value,value.value)}:{kind:kind.value};await form.send({work_id:current.value.id,base_revision:current.value.review.revision,category:category.value,field:field.value,suggestion,description:description.value.trim(),source_hint:url.value||quote.value?{url:url.value||null,quote:quote.value||null}:null,related_correction_id:props.relatedId||null},props.reviewer);}catch(exc){validation.value=exc instanceof Error?exc.message:'请检查表单';}}
</script>
<template>
<dialog ref="dialog" class="correction-dialog" aria-labelledby="correction-title" @close="emit('close')" @cancel="emit('close')">
  <header class="dialog-heading"><h2 id="correction-title">{{reviewer?'主动核对资料':'资料纠错'}}</h2><button class="icon-button" aria-label="关闭资料纠错" @click="dialog?.close()">×</button></header>
  <p>{{work.title}}</p><p v-if="loadError" role="alert" class="field-error">{{loadError}} <button @click="load">重试资料</button></p><p v-else-if="!current">正在读取最新资料…</p>
  <template v-if="form.saved.value"><p role="status">已提交，{{form.saved.value.status==='pending'?'等待审核':'当前状态已更新'}}。</p><button class="primary-button" @click="emit('records')">查看纠错记录</button></template>
  <form v-else-if="current" @submit.prevent="submit" class="correction-form">
    <fieldset :disabled="locked"><label for="correction-category">问题类别</label><select id="correction-category" v-model="category"><option v-for="(label,key) in categoryLabels" :value="key">{{label}}</option></select>
    <label for="correction-field">字段</label><select id="correction-field" v-model="field"><option v-for="key in correctionFields[category]" :value="key">{{correctionLabels[key]}}</option></select>
    <p class="review-current">当前值：{{formatValue(currentValue(current,field))}}</p>
    <label for="correction-kind">建议修正</label><select id="correction-kind" v-model="kind"><option v-if="category!=='mapping'" value="set">建议值</option><option v-if="nullableFields.includes(field)" value="unknown">无法确认／建议恢复未知</option><option v-if="category==='mapping'" value="issue">报告对应问题，交由审核者核对</option></select>
    <template v-if="kind==='set'"><label for="correction-value">建议值</label><CorrectionValue :field="field" v-model="value" id="correction-value"/></template>
    <label for="correction-description">问题说明（必填）</label><textarea id="correction-description" v-model="description" maxlength="1000" rows="3" required/><small>{{Array.from(description.trim()).length}} / 500 字符</small>
    <label for="correction-url">来源链接（可选）</label><input id="correction-url" v-model="url" type="url" maxlength="1000" placeholder="https://">
    <label for="correction-quote">原文摘录（可选）</label><textarea id="correction-quote" v-model="quote" maxlength="1000" rows="2"/>
    </fieldset><p class="source-note">提交后由审核者核对，当前资料暂不改变。{{form.busy.value||form.unknown.value?'请求仍可能在服务端完成，关闭不会撤销，请从本人记录核对结果。':'关闭将放弃未提交草稿。'}}</p>
    <p v-if="validation||form.submitError.value" class="field-error" role="alert">{{validation||form.submitError.value}}</p>
    <div v-if="form.unknown.value" class="review-actions"><button type="button" :disabled="form.busy.value" @click="form.resolve">核对提交回执</button><button type="button" :disabled="form.busy.value" @click="form.retry">使用原标识重试</button><button type="button" @click="emit('records')">查看本人记录</button></div>
    <div class="dialog-actions"><button type="button" class="secondary-button" @click="dialog?.close()">{{form.busy.value||form.unknown.value?'关闭并稍后核对':'取消'}}</button><button class="primary-button" :disabled="locked||!current.review">{{form.busy.value?'正在提交…':reviewer?'建立核对单':'提交纠错'}}</button></div>
  </form>
</dialog>
</template>
