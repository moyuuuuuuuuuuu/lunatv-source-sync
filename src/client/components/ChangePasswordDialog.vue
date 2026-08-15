<script setup lang="ts">
import { reactive, ref } from 'vue';
import { api } from '../api';

const emit = defineEmits<{ close: []; changed: [] }>();
const form = reactive({ currentPassword: '', newPassword: '', confirmation: '' });
const busy = ref(false), error = ref('');

async function submit() {
  error.value = '';
  if (form.newPassword.length < 10) { error.value = '新密码至少需要 10 个字符'; return; }
  if (form.newPassword !== form.confirmation) { error.value = '两次输入的新密码不一致'; return; }
  busy.value = true;
  try {
    await api.send('/api/admin/password/change', 'POST', { currentPassword: form.currentPassword, newPassword: form.newPassword });
    emit('changed');
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '修改失败'; }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="modal" role="presentation" @click.self="!busy && emit('close')">
    <form class="panel dialog password-dialog" role="dialog" aria-modal="true" aria-labelledby="password-title" @submit.prevent="submit">
      <div class="page-head"><div><div class="eyebrow">ACCOUNT SECURITY</div><h2 id="password-title">修改登录密码</h2></div><button type="button" class="ghost" :disabled="busy" @click="emit('close')">✕</button></div>
      <label>当前密码<input v-model="form.currentPassword" type="password" autocomplete="current-password" required></label>
      <label>新密码<input v-model="form.newPassword" type="password" autocomplete="new-password" minlength="10" maxlength="128" required><small>至少 10 个字符</small></label>
      <label>确认新密码<input v-model="form.confirmation" type="password" autocomplete="new-password" required></label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <footer><button type="button" class="ghost" :disabled="busy" @click="emit('close')">取消</button><button class="primary" :disabled="busy">{{ busy ? '修改中…' : '修改密码' }}</button></footer>
    </form>
  </div>
</template>
