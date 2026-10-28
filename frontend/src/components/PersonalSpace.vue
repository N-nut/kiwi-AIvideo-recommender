<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import type { usePersonalSpace } from '../usePersonalSpace';
import PresetAvatar from './PresetAvatar.vue';
import presets from '../../../data/avatar-presets.json';
const props=defineProps<{space:ReturnType<typeof usePersonalSpace>;logoutBusy:boolean;canReview?:boolean}>();
const emit=defineEmits<{navigate:[view:string];logout:[]}>();
const {profile,summary,draft,dirty,profileLoading,summaryLoading,saving,profileError,summaryError,saveError,saveNotice,saveUnknown,fields,
  password,passwordOpen,passwordBusy,passwordError,passwordFields}=props.space;
const visible=reactive<Record<string,boolean>>({});
const photoInput=ref<HTMLInputElement>();
function selectedPhoto(event:Event){const input=event.target as HTMLInputElement;void props.space.choosePhoto(input.files?.[0]);input.value='';}
watch(passwordOpen,()=>{for(const key of Object.keys(visible))visible[key]=false;});
const passwordLabels={current_password:'当前密码',new_password:'新密码',confirm_password:'确认新密码'};
</script>
<template>
  <section class="personal-space" aria-labelledby="space-title">
    <header class="space-heading"><div><h1 id="space-title">个人空间</h1><p>你的资料、收藏与观剧兴趣</p></div><button class="text-button" @click="emit('navigate','discover')">返回发现好剧 ↗</button></header>
    <div class="space-grid">
      <section class="space-card profile-card" aria-labelledby="profile-title" :aria-busy="profileLoading||saving">
        <div class="space-card-heading"><h2 id="profile-title">个人资料</h2><button class="text-button" :disabled="profileLoading||saving" @click="space.loadProfile">重新读取资料</button></div>
        <p v-if="profileError" class="field-error" role="alert">{{profileError}} <button class="text-button" @click="space.loadProfile">重试资料</button></p>
        <p v-if="profileLoading&&!profile" class="space-loading" role="status">正在读取个人资料…</p>
        <form v-if="profile" @submit.prevent="space.save" novalidate>
          <div class="space-identity"><PresetAvatar :id="draft.avatar_id" :src="space.avatarPreview.value"/><div><span class="space-label">登录用户名</span><strong>{{profile.username}}</strong><small>用户名用于登录，不可修改</small></div></div>
          <div class="space-field"><label for="space-nickname">昵称</label><input id="space-nickname" v-model="draft.nickname" :placeholder="profile.username" :aria-invalid="!!fields.nickname" aria-describedby="nickname-help nickname-error" :disabled="saving" autocomplete="nickname"><small id="nickname-help">1～20 个字符，昵称不可重复；未设置时显示用户名。</small><p id="nickname-error" v-if="fields.nickname" class="field-error" role="alert">{{fields.nickname}}</p></div>
          <fieldset class="avatar-fieldset" :disabled="saving||space.avatarLoading.value"><legend>选择头像</legend>
            <div class="avatar-upload"><input ref="photoInput" id="avatar-photo-file" class="sr-only" type="file" accept="image/jpeg,image/png,image/webp" aria-label="选择头像照片" :disabled="saving||space.avatarLoading.value" @change="selectedPhoto"><button type="button" class="avatar-upload-button" :disabled="saving||space.avatarLoading.value" @click="photoInput?.click()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h-4L8 7H4v13h16V7h-4Z"/><circle cx="12" cy="13" r="3.5"/></svg>{{space.avatarLoading.value?'正在处理照片…':space.usesPhoto.value?'更换照片':'选择自己的照片'}}</button><span>{{space.photoPending.value?'已选照片，保存资料后生效':space.usesPhoto.value?'正在使用照片头像':'也可以使用下方系统头像'}}</span></div>
            <p class="avatar-help">JPG、PNG 或 WebP，最大 5 MB，居中裁为方形头像。</p><p v-if="space.avatarError.value||fields.avatar_image" class="field-error" role="alert">{{space.avatarError.value||fields.avatar_image}}</p>
            <div class="avatar-options"><button v-for="avatar in presets" :key="avatar.id" type="button" :aria-label="avatar.label+'头像'" :aria-pressed="!space.usesPhoto.value&&draft.avatar_id===avatar.id" :class="['avatar-option',{selected:!space.usesPhoto.value&&draft.avatar_id===avatar.id}]" @click="space.selectPreset(avatar.id)"><PresetAvatar :id="avatar.id"/><span>{{avatar.label}}</span><span v-if="!space.usesPhoto.value&&draft.avatar_id===avatar.id" class="avatar-check" aria-hidden="true">✓</span></button></div><p v-if="fields.avatar_id" class="field-error" role="alert">{{fields.avatar_id}}</p></fieldset>
          <p v-if="saveError" class="field-error" role="alert">{{saveError}} <button v-if="saveUnknown" type="button" class="text-button" @click="space.loadProfile">重新读取资料核对</button></p>
          <p v-if="saveNotice" class="space-success" role="status">{{saveNotice}}</p>
          <div class="space-actions"><button class="primary-button" type="submit" :disabled="!dirty||saving||profileLoading||space.avatarLoading.value">{{saving?'正在保存…':'保存资料'}}</button><button class="secondary-button" type="button" :disabled="!dirty||saving" @click="space.cancelEdit">取消修改</button></div>
        </form>
      </section>
      <div class="space-side">
      <section class="space-card"><div class="space-card-heading"><h2>资料纠错</h2><button class="text-button" @click="emit('navigate','corrections')">我的纠错 ↗</button></div><p class="source-note">查看本人提交的问题及处理结果。</p><button v-if="canReview" class="secondary-button" @click="emit('navigate','review')">资料审核工作台</button></section>
      <section class="space-card summary-card" aria-labelledby="summary-title" :aria-busy="summaryLoading">
        <div class="space-card-heading"><h2 id="summary-title">收藏概览</h2><button class="text-button" :disabled="summaryLoading" @click="space.loadSummary">刷新概览</button></div>
        <p v-if="summaryLoading&&!summary" class="space-loading" role="status">正在整理收藏…</p>
        <p v-if="summaryError" class="field-error" role="alert">{{summaryError}}<template v-if="summary">，以下保留最近确认的数据。</template> <button class="text-button" @click="space.loadSummary">重试概览与画像</button></p>
        <template v-if="summary"><div class="space-total"><strong>{{summary.favorites.total}}</strong><span>部收藏作品</span></div><p class="space-description">收藏的故事，都在这里。</p><p v-if="summary.favorites.unavailable" class="source-note">其中 {{summary.favorites.unavailable}} 部资料暂不可用，仍保留在账号中。</p><p v-if="!summary.favorites.total" class="space-empty">还没有收藏作品</p><div class="space-actions"><button class="secondary-button" @click="emit('navigate','favorites')">查看我的收藏 →</button><button v-if="!summary.favorites.total" class="text-button" @click="emit('navigate','catalog')">去片库看看</button></div></template>
      </section>
      <section class="space-card history-entry-card"><div class="space-card-heading"><h2>历史片单</h2><button class="text-button" @click="emit('navigate','history')">找回往期推荐 ↗</button></div><p class="source-note">保存确认偏好与推荐理由，喜欢的故事随时回看。</p></section>
      <section class="space-card feedback-entry-card"><div class="space-card-heading"><h2>推荐反馈</h2><button class="text-button" @click="emit('navigate','feedback')">推荐反馈管理 ↗</button></div><p class="source-note">查看或撤销不感兴趣、已看过的作品。</p></section>
      <section class="space-card interest-card" aria-labelledby="interest-title" :aria-busy="summaryLoading">
        <div class="space-card-heading"><h2 id="interest-title">兴趣画像</h2><button class="text-button" @click="emit('navigate','discover')">去发现好剧 ↗</button></div>
        <p v-if="summaryLoading&&!summary" class="space-loading" role="status">正在整理兴趣画像…</p><p v-if="summaryError" class="field-error" role="alert">画像可能尚未更新。<button class="text-button" @click="space.loadSummary">重试兴趣画像</button></p>
        <template v-if="summary"><p class="space-description">根据 {{summary.interest.analyzed_count}} 部有效剧集收藏整理</p><p v-if="summary.interest.status!=='ready'" class="space-empty">暂无足够的剧集收藏形成兴趣画像<small v-if="summary.interest.status==='no_valid_favorites'">漫画和不可用资料不参与短剧风格判断。</small><small v-else-if="summary.interest.status==='no_tags'">已收藏剧集暂缺可用的题材与剧情标签。</small></p><div class="interest-groups"><section v-for="group in [{key:'content_types',label:'内容类别'},{key:'genres',label:'偏爱题材'},{key:'themes',label:'剧情特色'}] as const" :key="group.key"><h3>{{group.label}}</h3><div class="interest-tags"><span v-for="tag in summary.interest[group.key]" :key="tag.label">{{tag.label}}<small>{{tag.count}} 部</small></span><small v-if="!summary.interest[group.key].length">暂无标签</small></div></section></div><p class="source-note">仅整理收藏中的正向兴趣，不改变你确认的观剧需求。</p></template>
      </section>
      </div>
      <section class="space-card security-card" aria-labelledby="security-title">
        <div class="space-card-heading"><h2 id="security-title">账号安全</h2><button class="text-button" :aria-expanded="passwordOpen" aria-controls="password-form" :disabled="passwordBusy" @click="passwordOpen?space.clearPassword():passwordOpen=true">{{passwordOpen?'收起修改密码':'修改密码'}}</button></div>
        <form v-if="passwordOpen" id="password-form" class="password-form" @submit.prevent="space.changePassword" novalidate>
          <div v-for="(label,key) in passwordLabels" :key="key" class="space-field"><label :for="'space-'+key">{{label}}</label><div class="password-input"><input :id="'space-'+key" v-model="password[key]" :type="visible[key]?'text':'password'" :autocomplete="key==='current_password'?'current-password':'new-password'" :disabled="passwordBusy" :aria-invalid="!!passwordFields[key]" :aria-describedby="passwordFields[key]?'error-'+key:undefined"><button type="button" class="text-button" :aria-label="(visible[key]?'隐藏':'显示')+label" :aria-pressed="!!visible[key]" @click="visible[key]=!visible[key]">{{visible[key]?'隐藏':'显示'}}</button></div><p v-if="passwordFields[key]" :id="'error-'+key" class="field-error" role="alert">{{passwordFields[key]}}</p></div>
          <p class="source-note">8～64 个字符，区分大小写。修改后需在所有设备重新登录。</p><p v-if="passwordError" class="field-error" role="alert">{{passwordError}}</p><div class="space-actions"><button type="submit" class="primary-button" :disabled="passwordBusy">{{passwordBusy?'正在修改…':'确认修改密码'}}</button><button type="button" class="secondary-button" :disabled="passwordBusy" @click="space.clearPassword">取消</button></div>
        </form>
        <div class="space-signout"><p>退出当前登录，账号资料和收藏会保留。</p><button class="secondary-button" :disabled="logoutBusy||passwordBusy" @click="emit('logout')">{{logoutBusy?'正在退出…':'退出登录'}}</button></div>
      </section>
    </div>
  </section>
</template>
