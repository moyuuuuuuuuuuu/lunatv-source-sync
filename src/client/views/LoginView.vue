<script setup lang="ts">
import { ref } from 'vue'; import { login } from '../api';
const emit = defineEmits<{ authenticated: [] }>();
const username = ref(''), password = ref(''), error = ref(''), busy = ref(false);
async function submit() { busy.value = true; error.value = ''; try { await login(username.value, password.value); emit('authenticated'); } catch (e) { error.value = e instanceof Error ? e.message : '登录失败'; } finally { busy.value = false; } }
</script>
<template><main class="login"><form class="panel login-card" @submit.prevent="submit"><div class="login-brand"><img src="/icon.svg" alt=""><span><b>LunaTV</b><small>Source Sync</small></span></div><div class="eyebrow">LUNATV SOURCE SYNC</div><h1>管理来源，保持清爽。</h1><p class="muted">登录后导入、检测并发布你的 LunaTV 来源。</p><label>用户名<input v-model.trim="username" autocomplete="username" required autofocus></label><label>密码<input v-model="password" type="password" autocomplete="current-password" required></label><p v-if="error" class="error" role="alert">{{ error }}</p><button class="primary" :disabled="busy">{{ busy ? '正在登录…' : '登录' }}</button></form></main></template>
