<script setup lang="ts">
import type { Preferences } from '../types';
import { genres, themes, featureNames } from '../types';
const props = defineProps<{ preferences: Preferences }>();
defineEmits<{ update: [preferences: Preferences] }>();
function removeRequired(index: number) { props.preferences.required.splice(index,1); props.preferences.conflicts = []; }
</script>
<template>
  <div class="preference-editor">
    <fieldset><legend>偏好题材 <small>可多选，作为软偏好</small></legend><div class="option-grid"><label v-for="g in genres" :key="g" class="option-label"><input type="checkbox" :value="g" v-model="preferences.soft_preferences.genres"><span>{{g}}</span></label></div></fieldset>
    <fieldset><legend>剧情特色</legend><div class="option-grid"><label v-for="t in themes" :key="t" class="option-label"><input type="checkbox" :value="t" v-model="preferences.soft_preferences.themes"><span>{{t}}</span></label></div></fieldset>
    <label class="pace-control">偏好节奏<select v-model="preferences.soft_preferences.pace"><option :value="null">不限 / 资料未知也可参与</option><option value="快">快节奏</option><option value="舒缓">舒缓</option></select></label>
    <fieldset><legend>明确排除 <small>资料未知的作品也会被排除</small></legend><div class="option-grid"><label v-for="(name,key) in featureNames" :key="key" class="option-label"><input type="checkbox" :value="key" v-model="preferences.excluded_features"><span>不要{{name}}</span></label></div></fieldset>
    <fieldset><legend>不想看的题材</legend><div class="option-grid"><label v-for="g in genres" :key="g" class="option-label"><input type="checkbox" :value="g" v-model="preferences.excluded_genres"><span>{{g}}</span></label></div></fieldset>
    <fieldset><legend>必须条件</legend><p v-if="!preferences.required.length" class="dialog-intro">当前没有必须条件。可在描述中写“只看修仙”“必须有系统”等后重新解析。</p><div class="required-row" v-for="(r,i) in preferences.required" :key="i"><select v-if="r.field==='genres'" v-model="r.value"><option v-for="g in genres" :key="g">{{g}}</option></select><select v-else-if="r.field==='themes'" v-model="r.value"><option v-for="t in themes" :key="t">{{t}}</option></select><select v-else-if="r.field==='pace'" v-model="r.value"><option>快</option><option>舒缓</option></select><span v-else>{{featureNames[r.field]}}：{{r.value?'有':'无'}}</span><button type="button" class="text-button" @click="removeRequired(i)">移除必须条件 ×</button></div></fieldset>
    <div v-if="preferences.unresolved_constraints.length" class="editor-warning"><strong>以下条件暂不支持，请修改描述或主动移除</strong><div v-for="(c,i) in preferences.unresolved_constraints" :key="c">{{c}} <button class="text-button" type="button" @click="preferences.unresolved_constraints.splice(i,1)">移除 ×</button></div></div>
    <div class="dialog-actions"><button type="button" class="primary-button" @click="$emit('update', preferences)">确认修改 <span>✓</span></button></div>
  </div>
</template>
