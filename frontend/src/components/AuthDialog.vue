<script setup lang="ts">
import { ref } from 'vue';
import { APIError } from '../api';
import type { useAuth } from '../useAuth';
const props=defineProps<{auth:ReturnType<typeof useAuth>}>();
const emit=defineEmits<{success:[];dismiss:[]}>();
const dialog=ref<HTMLDialogElement>(), mode=ref<'login'|'register'>('login');
const username=ref(''),password=ref(''),confirmation=ref(''),error=ref(''),fields=ref<Record<string,string>>({});
let revision=0, succeeded=false;
function clearPasswords() {password.value='';confirmation.value='';}
function open() {revision++;succeeded=false;mode.value='login';error.value='';fields.value={};clearPasswords();dialog.value?.showModal();}
function close() {dialog.value?.close();closed();}
function closed() {revision++;clearPasswords();if(!succeeded){props.auth.cancelLogin();emit('dismiss');}}
function changeMode() {mode.value=mode.value==='login'?'register':'login';error.value='';fields.value={};clearPasswords();}
async function submit() {
  if(props.auth.busy.value) return;
  fields.value={};error.value='';
  if(!/^[A-Za-z0-9_]{3,20}$/.test(username.value.trim())) fields.value.username='用户名须为 3～20 位英文字母、数字或下划线';
  if([...password.value].length<8||[...password.value].length>64) fields.value.password='密码须为 8～64 个字符';
  if(mode.value==='register'&&password.value!==confirmation.value) fields.value.confirm_password='两次密码不一致';
  if(Object.keys(fields.value).length) return;
  const current=++revision;
  try {
    const form=mode.value==='register'?{username:username.value,password:password.value,confirm_password:confirmation.value}:{username:username.value,password:password.value};
    const ok=await props.auth.submit(mode.value,form);
    if(!ok||current!==revision) return;
    succeeded=true;clearPasswords();dialog.value?.close();emit('success');
  } catch(exc) {if(current===revision){error.value=exc instanceof Error?exc.message:'服务暂时不可用，请重试';fields.value=exc instanceof APIError?exc.fields:{};clearPasswords();}}
}
defineExpose({open,close});
</script>
<template>
  <dialog ref="dialog" class="auth-dialog" aria-labelledby="login-title" @close="closed" @cancel.prevent="close">
    <form @submit.prevent="submit" novalidate>
      <div class="dialog-heading"><h2 id="login-title">{{mode==='login'?'登录奇维':'创建账号'}}</h2><button type="button" class="icon-button" @click="close" aria-label="关闭登录">×</button></div>
      <p class="dialog-intro">{{mode==='login'?'登录后保存和查看你的收藏。':'注册成功后即可收藏作品。'}}</p>
      <label class="login-label" for="auth-username">用户名<input id="auth-username" v-model="username" name="username" maxlength="20" autocomplete="username" :disabled="auth.busy.value" :aria-invalid="!!fields.username" aria-describedby="username-error" placeholder="3～20 位字母、数字或下划线"></label>
      <p id="username-error" v-if="fields.username" class="field-error">{{fields.username}}</p>
      <label class="login-label" for="auth-password">密码<input id="auth-password" v-model="password" name="password" type="password" :autocomplete="mode==='login'?'current-password':'new-password'" :disabled="auth.busy.value" :aria-invalid="!!fields.password" aria-describedby="password-error" placeholder="8～64 个字符"></label>
      <p id="password-error" v-if="fields.password" class="field-error">{{fields.password}}</p>
      <label v-if="mode==='register'" class="login-label" for="auth-confirmation">确认密码<input id="auth-confirmation" v-model="confirmation" name="confirm_password" type="password" autocomplete="new-password" :disabled="auth.busy.value" :aria-invalid="!!fields.confirm_password" aria-describedby="confirmation-error" placeholder="再次输入密码"></label>
      <p id="confirmation-error" v-if="fields.confirm_password" class="field-error">{{fields.confirm_password}}</p>
      <p v-if="error" class="field-error" role="alert">{{error}}</p>
      <div class="dialog-actions"><button class="text-button auth-switch" type="button" :disabled="auth.busy.value" @click="changeMode">{{mode==='login'?'还没有账号？注册':'已有账号？登录'}}</button><button class="primary-button" type="submit" :disabled="auth.busy.value">{{auth.busy.value?'正在提交…':mode==='login'?'登录':'注册并登录'}}</button></div>
    </form>
  </dialog>
</template>
