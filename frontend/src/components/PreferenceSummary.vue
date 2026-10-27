<script setup lang="ts">
defineProps<{groups:{label:string;kind:string;values:string[]}[]}>();
</script>
<template>
  <div class="preference-summary">
    <section v-for="group in groups" :key="group.kind" class="preference-group">
      <h3>{{group.label}}</h3>
      <div class="preference-group-values"><span v-for="value in group.values" :key="value" :class="['taste-chip',group.kind]">{{value}}</span><span v-if="!group.values.length" class="preference-unspecified">未设置</span></div>
    </section>
    <p v-if="!groups.some(group=>group.values.length)" class="empty-preferences">暂未识别出具体偏好，可手动补充。</p>
  </div>
</template>
