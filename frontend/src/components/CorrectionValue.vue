<script setup lang="ts">
import { genres,themes } from '../types';
defineProps<{field:string;modelValue:string;disabled?:boolean;id:string}>();
const emit=defineEmits<{'update:modelValue':[value:string]}>();
const update=(event:Event)=>emit('update:modelValue',(event.target as HTMLInputElement).value);
</script>
<template>
  <select v-if="['preview_mapping','source_link','work_identity'].includes(field)" :id="id" :value="modelValue" :disabled="disabled" @change="update"><option value="unavailable">确认对应有误，暂停相关内容</option><option v-if="field!=='preview_mapping'" value="verified">已重新核实当前对应关系</option></select>
  <select v-else-if="['harem','romance','tragic','pace','content_type'].includes(field)" :id="id" :value="modelValue" :disabled="disabled" @change="update"><option disabled value="">请选择</option><template v-if="['harem','romance','tragic'].includes(field)"><option value="true">有</option><option value="false">无</option></template><template v-else-if="field==='pace'"><option>快</option><option>舒缓</option></template><template v-else><option>真人剧</option><option>漫剧</option><option>AI剧</option><option>漫画</option></template></select>
  <textarea v-else-if="['original_intro','summary'].includes(field)" :id="id" :value="modelValue" :disabled="disabled" :maxlength="field==='summary'?500:6000" rows="4" @input="update"/>
  <input v-else :id="id" :value="modelValue" :disabled="disabled" :type="['episode_count','chapter_count'].includes(field)?'number':'text'" :min="1" :max="10000" @input="update">
  <small v-if="field==='genres'||field==='themes'">支持：{{(field==='genres'?genres:themes).join('、')}}，用顿号分隔。</small>
</template>
